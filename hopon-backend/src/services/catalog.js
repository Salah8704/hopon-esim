'use strict';
/**
 * Transatel OCS Catalog Service
 * Auth: OAuth2 client_credentials
 * Ref: https://developers.transatel.com/docs/getting-started/
 */
const axios  = require('axios');
const { db } = require('../db/pool');
const logger = require('../utils/logger');

const TRANSATEL_BASE = 'https://api.transatel.com';

// Cache token en memoire
let _tokenCache = null;
let _tokenExpiry = 0;

// Etape 1 : obtenir un Bearer token via OAuth2 client_credentials
async function getAccessToken() {
  if (_tokenCache && Date.now() < _tokenExpiry - 60000) {
    return _tokenCache;
  }
  const clientId     = process.env.OCS_USERNAME;
  const clientSecret = process.env.OCS_PASSWORD;
  const credentials  = Buffer.from(clientId + ':' + clientSecret).toString('base64');

  logger.info('[Catalog] Obtention token Transatel...');
  const r = await axios.post(
    TRANSATEL_BASE + '/authentication/api/token',
    'grant_type=client_credentials',
    {
      headers: {
        'Authorization': 'Basic ' + credentials,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 15000
    }
  );
  _tokenCache = r.data.access_token;
  _tokenExpiry = Date.now() + (r.data.expires_in || 3600) * 1000;
  logger.info('[Catalog] Token obtenu, expire dans ' + r.data.expires_in + 's');
  return _tokenCache;
}

// Creer la table products si elle n'existe pas
async function ensureTables() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS products (
        id             SERIAL PRIMARY KEY,
        ocs_ref        VARCHAR(255) UNIQUE NOT NULL,
        name           VARCHAR(500) NOT NULL,
        description    TEXT,
        data_kb        BIGINT DEFAULT 0,
        duration_days  INTEGER DEFAULT 30,
        duration_unit  VARCHAR(50) DEFAULT 'days',
        countries      TEXT[],
        supplier_price DECIMAL(10,2) DEFAULT 0,
        public_price   DECIMAL(10,2) DEFAULT 0,
        currency       VARCHAR(10) DEFAULT 'EUR',
        price_status   VARCHAR(50) DEFAULT 'pending',
        is_published   BOOLEAN DEFAULT false,
        raw_data       JSONB,
        created_at     TIMESTAMP DEFAULT NOW(),
        updated_at     TIMESTAMP DEFAULT NOW()
      )
    `);
    logger.info('[Catalog] Table products OK');
  } catch(e) {
    logger.warn('[Catalog] ensureTables: ' + e.message);
  }
}

// Etape 2 : recuperer les produits du catalogue
async function fetchCatalogProducts(token) {
  const cos = process.env.OCS_COS_REF || process.env.COS_REF || 'WW_M2MA_COS_SPC';
  const url = TRANSATEL_BASE + '/ocs/catalog/api/cos/' + cos + '/products';
  logger.info('[Catalog] GET ' + url);

  const r = await axios.get(url, {
    headers: {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/json'
    },
    timeout: 30000
  });

  // La reponse contient products[]
  const products = r.data && r.data.products ? r.data.products : (Array.isArray(r.data) ? r.data : []);
  logger.info('[Catalog] ' + products.length + ' produits trouves');
  return products;
}

// Sync catalogue complete
async function syncCatalog({ mode = 'full' } = {}) {
  logger.info('[Catalog] Sync ' + mode + ' démarrée');
  await ensureTables();

  // Authentification
  let token;
  try {
    token = await getAccessToken();
  } catch(e) {
    const msg = e.response
      ? 'Auth echouee (' + e.response.status + '): ' + JSON.stringify(e.response.data).slice(0, 200)
      : 'Auth echouee: ' + e.message;
    logger.error('[Catalog] ' + msg);
    throw new Error(msg + ' — Verifiez OCS_USERNAME et OCS_PASSWORD dans Railway Variables');
  }

  // Recuperation produits
  let products;
  try {
    products = await fetchCatalogProducts(token);
  } catch(e) {
    const msg = e.response
      ? 'Catalogue erreur (' + e.response.status + '): ' + JSON.stringify(e.response.data).slice(0, 200)
      : 'Catalogue erreur: ' + e.message;
    logger.error('[Catalog] ' + msg);
    throw new Error(msg + ' — Verifiez OCS_COS_REF dans Railway Variables');
  }

  // Upsert en base
  let inserted = 0, errors = 0;
  for (const p of products) {
    try {
      const def    = p.productDefinition || p;
      const ocsRef = def.productId || def.id || String(Math.random());
      const name   = def.productId || ocsRef;

      // Extraire data allowance
      const dataAllowance = def.allowances && def.allowances.data && def.allowances.data[0];
      const dataKb  = dataAllowance ? parseInt(dataAllowance.resourceValue || 0) : 0;

      // Duree
      const vp   = def.validityPeriod || {};
      const days = vp.validityDuration || 30;
      const unit = vp.validityDurationUnit || 'days';

      // Pays
      const countries = def.countryList || [];

      await db.query(
        `INSERT INTO products (ocs_ref, name, data_kb, duration_days, duration_unit, countries, raw_data, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
         ON CONFLICT (ocs_ref) DO UPDATE
         SET name=$2, data_kb=$3, duration_days=$4, duration_unit=$5, countries=$6, raw_data=$7, updated_at=NOW()`,
        [ocsRef, name, dataKb, days, unit, countries, JSON.stringify(p)]
      );
      inserted++;
    } catch(e) {
      logger.error('[Catalog] Upsert erreur: ' + e.message);
      errors++;
    }
  }

  const result = { count: inserted, errors, total: products.length, ts: new Date().toISOString() };
  logger.info('[Catalog] Sync terminee: ' + JSON.stringify(result));
  return result;
}

module.exports = { syncCatalog };
