'use strict';
const axios  = require('axios');
const { db } = require('../db/pool');
const logger = require('../utils/logger');

// Créer les tables nécessaires si elles n'existent pas
async function ensureTables() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS products (
        id           SERIAL PRIMARY KEY,
        ocs_ref      VARCHAR(255) UNIQUE NOT NULL,
        name         VARCHAR(500) NOT NULL,
        description  TEXT,
        data_mb      INTEGER DEFAULT 0,
        duration_days INTEGER DEFAULT 30,
        zones        TEXT[],
        supplier_price DECIMAL(10,2) DEFAULT 0,
        public_price   DECIMAL(10,2) DEFAULT 0,
        currency     VARCHAR(10) DEFAULT 'EUR',
        price_status VARCHAR(50) DEFAULT 'pending',
        is_published BOOLEAN DEFAULT false,
        raw_data     JSONB,
        created_at   TIMESTAMP DEFAULT NOW(),
        updated_at   TIMESTAMP DEFAULT NOW()
      )
    `);
    logger.info('[Catalog] Table products OK');
  } catch(e) {
    logger.warn('[Catalog] ensureTables: ' + e.message);
  }
}

// Appel API Transatel OCS
async function fetchOcsOffers() {
  const user = process.env.OCS_USERNAME;
  const pass = process.env.OCS_PASSWORD;
  const cosRef = process.env.COS_REF || 'WW_M2MA_COS_SPC';
  const baseUrl = process.env.OCS_BASE_URL || 'https://ocs.transatel.com/api/b2b/v1';

  logger.info('[Catalog] Appel OCS: ' + baseUrl);

  const auth = Buffer.from(user + ':' + pass).toString('base64');
  const r = await axios.get(baseUrl + '/catalog/offers', {
    headers: {
      'Authorization': 'Basic ' + auth,
      'Accept': 'application/json',
      'X-Cos-Ref': cosRef
    },
    timeout: 30000
  });
  
  return r.data && r.data.offers ? r.data.offers : (Array.isArray(r.data) ? r.data : []);
}

// Sync principale
async function syncCatalog({ mode = 'full' } = {}) {
  logger.info('[Catalog] Sync ' + mode + ' démarrée');
  
  // Créer les tables si nécessaire
  await ensureTables();

  let offers = [];
  try {
    offers = await fetchOcsOffers();
    logger.info('[Catalog] ' + offers.length + ' offres récupérées de OCS');
  } catch(e) {
    logger.error('[Catalog] Erreur OCS: ' + e.message);
    throw new Error('Erreur API Transatel: ' + e.message);
  }

  let inserted = 0, updated = 0, errors = 0;

  for (const offer of offers) {
    try {
      const ocsRef = offer.ref || offer.id || offer.offerRef || String(offer.offerCode);
      const name   = offer.name || offer.label || offer.offerName || 'Offre ' + ocsRef;
      const dataMb = parseInt(offer.dataVolumeMB || offer.dataMb || offer.quota || 0);
      const days   = parseInt(offer.validityDays || offer.duration || offer.validity || 30);
      const price  = parseFloat(offer.supplierPrice || offer.price || offer.unitPrice || 0);
      const currency = offer.currency || 'EUR';
      const zones  = offer.zones || offer.countries || [];

      await db.query(
        `INSERT INTO products (ocs_ref, name, data_mb, duration_days, supplier_price, currency, zones, raw_data, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
         ON CONFLICT (ocs_ref) DO UPDATE
         SET name=$2, data_mb=$3, duration_days=$4, supplier_price=$5, currency=$6, zones=$7, raw_data=$8, updated_at=NOW()`,
        [ocsRef, name, dataMb, days, price, currency, zones, JSON.stringify(offer)]
      );
      inserted++;
    } catch(e) {
      logger.error('[Catalog] Erreur produit: ' + e.message);
      errors++;
    }
  }

  const result = { count: inserted, updated, errors, total: offers.length, ts: new Date().toISOString() };
  logger.info('[Catalog] Sync terminée: ' + JSON.stringify(result));
  return result;
}

module.exports = { syncCatalog };
