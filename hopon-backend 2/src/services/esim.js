'use strict';
/**
 * HopOn — Service de gestion du cycle de vie eSIM
 *
 * Workflow après paiement validé :
 *   1. Réserver un sim-serial disponible (avec TTL)
 *   2. Souscrire le produit OCS pour ce profil
 *   3. Attendre la confirmation (poll + webhook)
 *   4. Récupérer activation_code + qr_code_url
 *   5. Livrer par email + mettre à jour l'espace client
 */

const transatel  = require('../api/transatel');
const emailSvc   = require('./email');
const { db }     = require('../db/pool');
const logger     = require('../utils/logger');

// Délai max avant de considérer une souscription en timeout (15 min)
const SUBSCRIPTION_TIMEOUT_MS   = 15 * 60 * 1000;
// Intervalle de polling statut souscription
const POLL_INTERVAL_MS           = 5000;
// Durée de réservation d'un SIM avant libération automatique si paiement échoue
const RESERVATION_TTL_MS         = 30 * 60 * 1000; // 30 min

// ─── Statuts de commande ─────────────────────────────────────────
const STATUS = {
  ORDER_CREATED:           'order_created',
  PAYMENT_PENDING:         'payment_pending',
  PAYMENT_SUCCEEDED:       'payment_succeeded',
  ESIM_RESERVED:           'esim_reserved',
  SUBSCRIPTION_REQUESTED:  'subscription_requested',
  SUBSCRIPTION_PENDING:    'subscription_pending',
  SUBSCRIPTION_SUCCESS:    'subscription_success',
  ESIM_DETAILS_RETRIEVED:  'esim_details_retrieved',
  DELIVERY_SENT:           'delivery_sent',
  DELIVERY_FAILED:         'delivery_failed',
  SUPPORT_REQUIRED:        'support_required',
  CANCELLED:               'cancelled',
  REFUNDED:                'refunded',
};


// ═════════════════════════════════════════════════════════════════
// POINT D'ENTRÉE PRINCIPAL — appelé après paiement validé
// ═════════════════════════════════════════════════════════════════

/**
 * Déclenche le workflow complet eSIM pour une commande.
 * Idempotent : peut être relancé sans effet de bord.
 *
 * @param {string} orderId — UUID de la commande
 */
async function processEsimOrder(orderId) {
  logger.info(`[eSIM] Début traitement commande ${orderId}`);

  const order = await getOrder(orderId);
  if (!order) throw new Error(`Commande ${orderId} introuvable`);

  // Vérifier que le paiement est bien validé
  if (order.status !== STATUS.PAYMENT_SUCCEEDED && order.status !== STATUS.ESIM_RESERVED) {
    logger.warn(`[eSIM] Commande ${orderId} en statut inattendu: ${order.status}`);
  }

  try {
    // Étape 1 — Réserver un sim-serial
    const iccid = await reserveSimProfile(order);
    await updateOrderStatus(orderId, STATUS.ESIM_RESERVED, { iccid });

    // Étape 2 — Souscrire le produit OCS
    const subResult = await requestSubscription(order, iccid);
    await updateOrderStatus(orderId, STATUS.SUBSCRIPTION_REQUESTED, {
      ocs_subscription_id: subResult.subscriptionId,
      ocs_transaction_id:  subResult.transactionId,
    });

    // Étape 3 — Attendre la confirmation
    await waitForSubscriptionComplete(orderId, subResult.subscriptionId);
    await updateOrderStatus(orderId, STATUS.SUBSCRIPTION_SUCCESS);

    // Étape 4 — Récupérer les détails eSIM
    const esimDetails = await fetchEsimDetails(orderId, iccid);
    await updateOrderStatus(orderId, STATUS.ESIM_DETAILS_RETRIEVED, {
      activation_code: esimDetails.activationCode,
      qr_code_url:     esimDetails.qrCodeUrl,
    });

    // Étape 5 — Envoyer l'email de livraison
    await deliverEsim(order, esimDetails);
    await updateOrderStatus(orderId, STATUS.DELIVERY_SENT, {
      delivery_sent_at: new Date().toISOString(),
    });

    logger.info(`[eSIM] Commande ${orderId} traitée avec succès — ICCID: ${iccid}`);
    return { success: true, iccid, activationCode: esimDetails.activationCode };

  } catch (err) {
    logger.error(`[eSIM] Erreur commande ${orderId}: ${err.message}`);

    const newStatus = err.requiresSupport
      ? STATUS.SUPPORT_REQUIRED
      : STATUS.DELIVERY_FAILED;

    await updateOrderStatus(orderId, newStatus, { error_message: err.message });

    // Notifier l'admin en cas d'erreur
    await notifyAdminError(orderId, err);

    throw err;
  }
}


// ─── Étape 1 : Réservation SIM ────────────────────────────────────

async function reserveSimProfile(order) {
  // Chercher un profil disponible pour le pays/région du forfait
  const { rows } = await db.query(
    `SELECT iccid FROM sim_stock
     WHERE status = 'available'
       AND (country_scope = $1 OR country_scope IS NULL)
     ORDER BY created_at ASC
     LIMIT 1
     FOR UPDATE SKIP LOCKED`,  -- lock optimiste pour éviter les doubles réservations
    [order.country_iso2]
  );

  if (!rows.length) {
    const err = new Error(`[eSIM] Stock épuisé pour ${order.country_iso2}`);
    err.requiresSupport = true;
    throw err;
  }

  const iccid = rows[0].iccid;
  const expiresAt = new Date(Date.now() + RESERVATION_TTL_MS);

  await db.query(
    `UPDATE sim_stock SET
       status = 'reserved',
       order_id = $2,
       reserved_at = NOW(),
       reservation_expires_at = $3
     WHERE iccid = $1`,
    [iccid, order.id, expiresAt]
  );

  logger.info(`[eSIM] SIM ${iccid} réservée pour commande ${order.id}`);
  return iccid;
}


// ─── Étape 2 : Souscription OCS ──────────────────────────────────

async function requestSubscription(order, iccid) {
  const product = await getProduct(order.product_id);
  if (!product) throw new Error(`Produit ${order.product_id} introuvable`);

  const result = await transatel.subscribeProduct({
    iccid,
    productId: product.source_product_id,
    optionId:  product.source_option_id,
    orderId:   order.id,
    meta: {
      customerEmail: order.customer_email,
      countryIso2:   order.country_iso2,
    },
  });

  logger.info(`[eSIM] Souscription demandée — subscriptionId: ${result.subscriptionId}`);
  return result;
}


// ─── Étape 3 : Polling jusqu'à confirmation ───────────────────────

async function waitForSubscriptionComplete(orderId, subscriptionId) {
  if (!subscriptionId) {
    logger.warn(`[eSIM] Pas de subscriptionId pour commande ${orderId}, skip polling`);
    return;
  }

  const deadline = Date.now() + SUBSCRIPTION_TIMEOUT_MS;
  await updateOrderStatus(orderId, STATUS.SUBSCRIPTION_PENDING);

  while (Date.now() < deadline) {
    const { status, provStatus } = await transatel.getSubscriptionStatus(subscriptionId);
    logger.debug(`[eSIM] Poll souscription ${subscriptionId} — status: ${status}`);

    if (['SUCCESS', 'ACTIVE', 'COMPLETED', 'PROVISIONED'].includes(status?.toUpperCase())) {
      return; // succès
    }

    if (['FAILED', 'ERROR', 'REJECTED'].includes(status?.toUpperCase())) {
      const err = new Error(`Souscription OCS échouée: ${status} — ${provStatus}`);
      err.requiresSupport = true;
      throw err;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`Timeout souscription ${subscriptionId} après ${SUBSCRIPTION_TIMEOUT_MS / 1000}s`);
}


// ─── Étape 4 : Récupération détails eSIM ─────────────────────────

async function fetchEsimDetails(orderId, iccid) {
  // Quelques secondes de délai post-souscription (recommandé)
  await sleep(3000);

  const details = await transatel.getEsimDetails(iccid);

  if (!details.activationCode && !details.qrCodeUrl) {
    // Tentative via endpoint QR Code spécifique
    const qr = await transatel.getEsimQrCode(iccid).catch(() => ({}));
    details.qrCodeUrl  = details.qrCodeUrl  || qr.qrCodeUrl;
    details.qrCodeData = details.qrCodeData || qr.qrCodeData;
  }

  // Mettre à jour sim_stock avec les détails
  await db.query(
    `UPDATE sim_stock SET
       activation_code = $2,
       qr_code_url = $3,
       qr_code_data = $4,
       activation_details = $5,
       status = 'subscribed'
     WHERE iccid = $1`,
    [iccid, details.activationCode, details.qrCodeUrl, details.qrCodeData || null, JSON.stringify(details.raw)]
  );

  return details;
}


// ─── Étape 5 : Livraison email ────────────────────────────────────

async function deliverEsim(order, esimDetails) {
  const product = await getProduct(order.product_id);
  const country = await getCountry(order.country_iso2);

  await emailSvc.sendEsimDelivery({
    to:            order.customer_email,
    customerName:  order.customer_name,
    orderId:       order.id,
    orderNumber:   order.order_number,
    country,
    product,
    activationCode: esimDetails.activationCode,
    qrCodeUrl:      esimDetails.qrCodeUrl,
    qrCodeData:     esimDetails.qrCodeData,
  });

  // Incrémenter delivery_attempts
  await db.query(
    `UPDATE orders SET delivery_attempts = delivery_attempts + 1 WHERE id = $1`,
    [order.id]
  );
}


// ─── Nettoyage des réservations expirées ─────────────────────────

/**
 * Libère les profils SIM dont la réservation a expiré sans paiement.
 * Appelé régulièrement par un job cron.
 */
async function releaseExpiredReservations() {
  const { rows } = await db.query(
    `UPDATE sim_stock SET
       status = 'available', order_id = NULL,
       reserved_at = NULL, reservation_expires_at = NULL
     WHERE status = 'reserved'
       AND reservation_expires_at < NOW()
     RETURNING iccid, order_id`
  );

  if (rows.length > 0) {
    logger.info(`[eSIM] ${rows.length} réservations expirées libérées`);
  }
  return rows;
}


// ─── Helpers DB ───────────────────────────────────────────────────

async function getOrder(orderId) {
  const { rows } = await db.query('SELECT * FROM orders WHERE id = $1', [orderId]);
  return rows[0] || null;
}

async function getProduct(productId) {
  const { rows } = await db.query('SELECT * FROM products WHERE id = $1', [productId]);
  return rows[0] || null;
}

async function getCountry(iso2) {
  const { rows } = await db.query('SELECT * FROM countries WHERE iso2 = $1', [iso2]);
  return rows[0] || null;
}

async function updateOrderStatus(orderId, status, extra = {}) {
  logger.info(`[eSIM] Commande ${orderId} → ${status}`);

  const setClauses = ['status = $2', 'updated_at = NOW()'];
  const params = [orderId, status];
  let i = 3;

  const colMap = {
    iccid:               'sim_iccid',
    activation_code:     'activation_code',
    qr_code_url:         'qr_code_url',
    ocs_subscription_id: 'ocs_subscription_id',
    ocs_transaction_id:  'ocs_transaction_id',
    error_message:       'error_message',
    delivery_sent_at:    'delivery_sent_at',
  };

  for (const [key, col] of Object.entries(colMap)) {
    if (extra[key] !== undefined) {
      setClauses.push(`${col} = $${i++}`);
      params.push(extra[key]);
    }
  }

  // Ajouter à l'historique des statuts
  await db.query(
    `UPDATE orders SET ${setClauses.join(', ')},
       status_history = status_history || $${i}::jsonb
     WHERE id = $1`,
    [...params, JSON.stringify([{ status, at: new Date().toISOString(), ...extra }])]
  );
}

async function notifyAdminError(orderId, err) {
  try {
    await emailSvc.sendAdminAlert({
      subject:  `[hopOn] Erreur eSIM — commande ${orderId}`,
      message:  err.message,
      orderId,
    });
  } catch (e) { /* ne pas faire échouer sur l'alerte */ }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = {
  processEsimOrder,
  releaseExpiredReservations,
  STATUS,
};
