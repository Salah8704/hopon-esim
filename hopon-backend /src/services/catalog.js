'use strict';
/**
 * HopOn — Service de synchronisation du catalogue OCS
 *
 * RÈGLE ABSOLUE : Aucun prix n'est publié sans source API validée.
 * - supplier_price doit être fourni explicitement par l'API
 * - public_price est défini manuellement par un admin
 * - Tout produit sans prix valide → price_status = 'pending_review', is_published = false
 */

const transatel = require('../api/transatel');
const { db }    = require('../db/pool');
const logger    = require('../utils/logger');

// ─── Mappers Transatel → HopOn local ─────────────────────────────

/**
 * Extrait le supplier_price depuis la réponse API Transatel.
 * Retourne null si le prix n'est pas disponible ou peu fiable.
 * Ne fait JAMAIS d'extrapolation ou d'estimation.
 *
 * @param {Object} apiProduct - produit brut Transatel
 * @returns {number|null}
 */
function extractSupplierPrice(apiProduct) {
  // Tenter plusieurs champs possibles selon la version de l'API Transatel
  const candidates = [
    apiProduct?.price,
    apiProduct?.unitPrice,
    apiProduct?.pricing?.amount,
    apiProduct?.pricing?.price,
    apiProduct?.cost,
  ];

  for (const val of candidates) {
    const n = parseFloat(val);
    if (!isNaN(n) && n > 0) return Math.round(n * 10000) / 10000; // 4 décimales
  }

  return null; // Prix non fourni — produit à valider
}

/**
 * Extrait la devise depuis la réponse API
 */
function extractCurrency(apiProduct) {
  return (
    apiProduct?.currency ||
    apiProduct?.pricing?.currency ||
    'EUR'
  ).toUpperCase().substring(0, 3);
}

/**
 * Extrait la durée en jours
 * Retourne null si non disponible — jamais extrapolé
 */
function extractDuration(apiProduct) {
  const raw =
    apiProduct?.durationDays ||
    apiProduct?.duration_days ||
    apiProduct?.validityDays ||
    apiProduct?.validity;

  const n = parseInt(raw);
  return !isNaN(n) && n > 0 ? n : null;
}

/**
 * Extrait le volume de données en MB
 * Retourne null si non disponible
 */
function extractDataAmount(apiProduct) {
  // Chercher en Mo directement
  const mb =
    apiProduct?.dataMB ||
    apiProduct?.data_mb ||
    apiProduct?.dataAllowanceMB;
  if (!isNaN(parseInt(mb))) return parseInt(mb);

  // Chercher en Go et convertir
  const gb =
    apiProduct?.dataGB ||
    apiProduct?.data_gb ||
    apiProduct?.dataAllowanceGB;
  if (!isNaN(parseFloat(gb))) return Math.round(parseFloat(gb) * 1024);

  return null;
}

/**
 * Extrait le code ISO2 du pays depuis le produit
 */
function extractCountryIso(apiProduct) {
  return (
    apiProduct?.countryCode ||
    apiProduct?.country_code ||
    apiProduct?.countryIso2 ||
    apiProduct?.targetCountry
  )?.toUpperCase().substring(0, 2) || null;
}

/**
 * Mappe un produit API Transatel vers notre schéma interne
 */
function mapProduct(apiProduct) {
  const supplierPrice = extractSupplierPrice(apiProduct);
  const currency      = extractCurrency(apiProduct);
  const durationDays  = extractDuration(apiProduct);
  const dataAmountMb  = extractDataAmount(apiProduct);
  const countryIso2   = extractCountryIso(apiProduct);

  // Déterminer le statut de prix
  let priceStatus = 'not_synced';
  if (supplierPrice !== null) {
    priceStatus = 'pending_review'; // prix disponible → admin doit valider
  } else {
    priceStatus = 'api_error';     // prix absent → bloquer publication
  }

  return {
    source_product_id: String(apiProduct.id || apiProduct.productId || apiProduct.product_id),
    source_option_id:  apiProduct.optionId || apiProduct.option_id || null,
    cos_ref:           transatel.COS_REF,
    country_iso2:      countryIso2,
    name:              apiProduct.name || apiProduct.label || `Produit ${apiProduct.id}`,
    description:       apiProduct.description || null,
    product_type:      apiProduct.type || apiProduct.productType || null,
    duration_days:     durationDays,
    data_amount_mb:    dataAmountMb,
    is_unlimited:      !!(apiProduct.unlimited || apiProduct.isUnlimited || dataAmountMb === null && apiProduct.type === 'unlimited'),
    supplier_price:    supplierPrice,
    currency,
    price_status:      priceStatus,
    is_published:      false, // jamais publié automatiquement
    raw_api_data:      apiProduct,
    last_synced_at:    new Date().toISOString(),
  };
}


// ─── Sync principale ─────────────────────────────────────────────

/**
 * Synchronise le catalogue complet depuis Transatel OCS.
 * Crée ou met à jour les produits en base locale.
 * Ne modifie JAMAIS public_price (saisi par admin).
 *
 * @param {Object} options
 * @param {string} options.mode — 'full' | 'incremental'
 * @param {number} options.throttleMs — délai entre chaque appel produit
 */
async function syncCatalog({ mode = 'full', throttleMs = 500 } = {}) {
  const startTime = Date.now();
  let logId;

  // Créer l'entrée de log
  const { rows: [log] } = await db.query(
    `INSERT INTO catalog_sync_logs (sync_type, status, cos_ref)
     VALUES ($1, 'running', $2) RETURNING id`,
    [mode, transatel.COS_REF]
  );
  logId = log.id;

  const stats = { fetched: 0, created: 0, updated: 0, errors: 0, priceIssues: 0 };
  const errorDetails = [];

  try {
    logger.info(`[CatalogSync] Démarrage sync ${mode} — COS: ${transatel.COS_REF}`);

    // 1. Récupérer tous les produits depuis l'API
    const apiProducts = await transatel.getCatalogProducts();
    stats.fetched = apiProducts.length;
    logger.info(`[CatalogSync] ${stats.fetched} produits reçus de l'API`);

    // 2. Traiter chaque produit
    for (const apiProd of apiProducts) {
      try {
        await processProduct(apiProd, stats, errorDetails);
        // Throttle entre les appels de détail si nécessaire
        if (throttleMs > 0) await sleep(throttleMs / 10);
      } catch (e) {
        stats.errors++;
        const errMsg = `Produit ${apiProd?.id}: ${e.message}`;
        errorDetails.push({ product_id: apiProd?.id, error: errMsg });
        logger.error(`[CatalogSync] Erreur produit: ${errMsg}`);
      }
    }

    // 3. Finaliser le log
    await db.query(
      `UPDATE catalog_sync_logs SET
        status = 'success',
        products_fetched = $1, products_created = $2,
        products_updated = $3, products_errors = $4,
        price_issues = $5, error_details = $6,
        finished_at = NOW(),
        duration_ms = $7
       WHERE id = $8`,
      [stats.fetched, stats.created, stats.updated, stats.errors,
       stats.priceIssues, JSON.stringify(errorDetails),
       Date.now() - startTime, logId]
    );

    logger.info(`[CatalogSync] Terminée — créés: ${stats.created}, MAJ: ${stats.updated}, erreurs: ${stats.errors}, prix à valider: ${stats.priceIssues}`);
    return { success: true, stats, logId };

  } catch (err) {
    await db.query(
      `UPDATE catalog_sync_logs SET status = 'error', error_details = $1, finished_at = NOW() WHERE id = $2`,
      [JSON.stringify([{ error: err.message }]), logId]
    );
    logger.error(`[CatalogSync] Erreur critique: ${err.message}`);
    throw err;
  }
}

/**
 * Traite un produit individuel (upsert)
 */
async function processProduct(apiProd, stats, errorDetails) {
  const mapped = mapProduct(apiProd);

  if (!mapped.source_product_id || mapped.source_product_id === 'undefined') {
    logger.warn(`[CatalogSync] Produit sans ID ignoré: ${JSON.stringify(apiProd)}`);
    stats.errors++;
    return;
  }

  if (mapped.price_status === 'api_error' || mapped.price_status === 'not_synced') {
    stats.priceIssues++;
    logger.warn(`[CatalogSync] ALERTE PRIX: ${mapped.source_product_id} — supplier_price=null → non publié`);
  }

  // Upsert : créer ou mettre à jour (sans toucher public_price)
  const { rows: [existing] } = await db.query(
    'SELECT id, public_price, price_status FROM products WHERE source_product_id = $1',
    [mapped.source_product_id]
  );

  if (!existing) {
    // Nouveau produit
    await db.query(
      `INSERT INTO products (
        source_product_id, source_option_id, cos_ref, country_iso2,
        name, description, product_type, duration_days, data_amount_mb,
        is_unlimited, supplier_price, currency, price_status,
        is_published, raw_api_data, last_synced_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        mapped.source_product_id, mapped.source_option_id, mapped.cos_ref,
        mapped.country_iso2, mapped.name, mapped.description, mapped.product_type,
        mapped.duration_days, mapped.data_amount_mb, mapped.is_unlimited,
        mapped.supplier_price, mapped.currency, mapped.price_status,
        false, // jamais publié automatiquement
        JSON.stringify(mapped.raw_api_data), mapped.last_synced_at,
      ]
    );
    stats.created++;
  } else {
    // Mise à jour — NE PAS toucher public_price (saisi par admin)
    await db.query(
      `UPDATE products SET
        source_option_id = $2, name = $3, description = $4,
        product_type = $5, duration_days = $6, data_amount_mb = $7,
        is_unlimited = $8, supplier_price = $9, currency = $10,
        price_status = CASE
          WHEN $11 = 'api_error' THEN 'api_error'
          WHEN price_status = 'validated' THEN 'validated'
          ELSE $11
        END,
        raw_api_data = $12, last_synced_at = $13,
        sync_error = NULL
       WHERE source_product_id = $1`,
      [
        mapped.source_product_id, mapped.source_option_id, mapped.name,
        mapped.description, mapped.product_type, mapped.duration_days,
        mapped.data_amount_mb, mapped.is_unlimited, mapped.supplier_price,
        mapped.currency, mapped.price_status,
        JSON.stringify(mapped.raw_api_data), mapped.last_synced_at,
      ]
    );
    stats.updated++;
  }
}

/**
 * Récupère les produits publiés pour un pays donné
 * (utilisé par l'API publique du site)
 */
async function getPublishedProducts(countryIso2, durationDays = null) {
  let query = `
    SELECT p.*, c.name_fr as country_name, c.flag_emoji
    FROM products p
    LEFT JOIN countries c ON c.iso2 = p.country_iso2
    WHERE p.is_published = true
      AND p.price_status = 'validated'
      AND p.public_price IS NOT NULL
      AND (p.country_iso2 = $1 OR p.is_global = true)
  `;
  const params = [countryIso2];

  if (durationDays) {
    query += ` AND p.duration_days = $2`;
    params.push(durationDays);
  }

  query += ` ORDER BY p.is_recommended DESC, p.public_price ASC`;
  const { rows } = await db.query(query, params);
  return rows;
}


// ─── Admin : validation des prix ─────────────────────────────────

/**
 * Valide un prix admin et publie un produit
 * Cette opération doit être appelée par un admin authentifié
 *
 * @param {string} productId — UUID interne
 * @param {number} publicPrice — prix public à appliquer
 * @param {string} adminId — ID de l'admin qui valide
 */
async function validateAndPublishProduct(productId, publicPrice, adminId) {
  // Vérifier que le supplier_price existe
  const { rows: [prod] } = await db.query(
    'SELECT * FROM products WHERE id = $1',
    [productId]
  );

  if (!prod) throw new Error(`Produit ${productId} introuvable`);
  if (!prod.supplier_price) {
    throw new Error(
      `Impossible de publier ${productId} : supplier_price=null. ` +
      `Déclencher une sync API d'abord.`
    );
  }

  const markup = ((publicPrice - prod.supplier_price) / prod.supplier_price * 100).toFixed(2);

  await db.query(
    `UPDATE products SET
      public_price = $2,
      markup_pct   = $3,
      price_status = 'validated',
      is_published = true,
      updated_at   = NOW()
     WHERE id = $1`,
    [productId, publicPrice, markup]
  );

  logger.info(`[CatalogSync] Produit ${productId} validé par admin ${adminId} — prix public: ${publicPrice}€, markup: ${markup}%`);
  return { success: true, markup };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = {
  syncCatalog,
  getPublishedProducts,
  validateAndPublishProduct,
  mapProduct, // exporté pour les tests
};
