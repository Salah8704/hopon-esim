'use strict';
/**
 * HopOn — Transatel OCS / SIM Management API Client
 *
 * Implémente les 4 API Transatel SPC :
 *   1. OCS Catalog API       — catalogue produits
 *   2. OCS Subscription API  — souscription produit
 *   3. Connectivity Mgmt API — gestion du cycle de vie subscriber
 *   4. SIM Management API    — détails eSIM, QR code, activation code
 *
 * Auth : HTTP Basic (username:password en Base64)
 * COS  : WW_M2MA_COS_SPC
 */

const axios  = require('axios');
const logger = require('../utils/logger');
const { db } = require('../db/pool');

// ─── Configuration ────────────────────────────────────────────────
const CFG = {
  baseUrl:    process.env.OCS_BASE_URL    || 'https://ocs.transatel.com',
  username:   process.env.OCS_USERNAME,
  password:   process.env.OCS_PASSWORD,
  cosRef:     process.env.COS_REF         || 'WW_M2MA_COS_SPC',
  timeout:    parseInt(process.env.OCS_TIMEOUT_MS)    || 15000,
  retries:    parseInt(process.env.OCS_RETRY_COUNT)   || 3,
  retryDelay: parseInt(process.env.OCS_RETRY_DELAY_MS)|| 2000,
};

if (!CFG.username || !CFG.password) {
  throw new Error('[Transatel] OCS_USERNAME / OCS_PASSWORD manquants dans .env');
}

// ─── Axios instance ───────────────────────────────────────────────
const http = axios.create({
  baseURL: CFG.baseUrl,
  timeout: CFG.timeout,
  auth: { username: CFG.username, password: CFG.password },
  headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
});

// ─── Interceptor : log chaque appel dans api_logs ────────────────
http.interceptors.request.use(cfg => {
  cfg.metadata = { startTime: Date.now() };
  return cfg;
});

http.interceptors.response.use(
  async res  => { await _logCall(null, res, null); return res; },
  async err  => { await _logCall(null, err.response, err); throw err; }
);

async function _logCall(orderId, res, err) {
  try {
    const req = res?.config || err?.config;
    if (!req) return;
    await db.query(
      `INSERT INTO api_logs (order_id, service, method, endpoint, request_body, response_status, response_body, duration_ms, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        orderId || null,
        _detectService(req.url),
        req.method?.toUpperCase(),
        req.url?.replace(CFG.baseUrl, ''),
        req.data ? JSON.parse(req.data) : null,
        res?.status || null,
        res?.data || null,
        req.metadata ? Date.now() - req.metadata.startTime : null,
        err?.message || null,
      ]
    );
  } catch (e) { /* log silently */ }
}

function _detectService(url = '') {
  if (url.includes('/ocs/catalog'))      return 'ocs_catalog';
  if (url.includes('/ocs/subscription')) return 'ocs_subscription';
  if (url.includes('/sim-management'))   return 'sim_management';
  if (url.includes('/connectivity'))     return 'connectivity';
  return 'unknown';
}

// ─── Helper retry ─────────────────────────────────────────────────
async function withRetry(fn, context = '') {
  let lastErr;
  for (let i = 0; i < CFG.retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      // Ne pas retry sur les erreurs 4xx (sauf 429)
      if (status && status !== 429 && status < 500) break;
      if (i < CFG.retries - 1) {
        logger.warn(`[Transatel] Retry ${i + 1}/${CFG.retries} pour ${context} — status: ${status}`);
        await sleep(CFG.retryDelay * (i + 1));
      }
    }
  }
  throw lastErr;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));


// ═════════════════════════════════════════════════════════════════
// 1. OCS CATALOG API
// ═════════════════════════════════════════════════════════════════

/**
 * Récupère la liste complète des produits du COS
 * GET /ocs/catalog/api/cos/{cosRef}/produits
 *
 * @returns {Array} liste des produits bruts Transatel
 */
async function getCatalogProducts() {
  return withRetry(async () => {
    const res = await http.get(`/ocs/catalog/api/cos/${CFG.cosRef}/produits`);
    logger.info(`[Catalog] ${res.data?.length || 0} produits récupérés`);
    return res.data || [];
  }, 'getCatalogProducts');
}

/**
 * Récupère les détails d'un produit spécifique
 * GET /ocs/catalog/api/cos/{cosRef}/products/{productId}
 *
 * @param {string} productId
 */
async function getProductDetails(productId) {
  return withRetry(async () => {
    const res = await http.get(
      `/ocs/catalog/api/cos/${CFG.cosRef}/products/${productId}`
    );
    return res.data;
  }, `getProductDetails(${productId})`);
}

/**
 * Récupère les options du COS
 * GET /ocs/catalog/api/cos/{cosRef}/options
 */
async function getCatalogOptions() {
  return withRetry(async () => {
    const res = await http.get(`/ocs/catalog/api/cos/${CFG.cosRef}/options`);
    return res.data || [];
  }, 'getCatalogOptions');
}


// ═════════════════════════════════════════════════════════════════
// 2. OCS SUBSCRIPTION API
// ═════════════════════════════════════════════════════════════════

/**
 * Souscrit un produit OCS pour un profil eSIM (ICCID)
 * POST /ocs/subscription/api/cos/{cosRef}/subscriptions
 *
 * @param {Object} params
 * @param {string} params.iccid         — identifiant du profil SIM
 * @param {string} params.productId     — source_product_id du produit
 * @param {string} params.optionId      — source_option_id si applicable
 * @param {string} params.orderId       — ID commande interne (pour logs)
 * @param {Object} params.meta          — données additionnelles
 */
async function subscribeProduct({ iccid, productId, optionId, orderId, meta = {} }) {
  logger.info(`[Subscription] Souscription produit ${productId} pour ICCID ${iccid}`);

  return withRetry(async () => {
    const payload = {
      subscriberId: iccid,
      productId,
      ...(optionId && { optionId }),
      metadata: {
        externalOrderId: orderId,
        ...meta,
      },
    };

    const res = await http.post(
      `/ocs/subscription/api/cos/${CFG.cosRef}/subscriptions`,
      payload
    );

    logger.info(`[Subscription] Réponse: ${JSON.stringify(res.data)}`);
    return {
      subscriptionId: res.data?.subscriptionId || res.data?.id,
      transactionId:  res.data?.transactionId,
      status:         res.data?.status,
      raw:            res.data,
    };
  }, `subscribeProduct(${productId})`);
}

/**
 * Vérifie le statut d'une souscription
 * GET /ocs/subscription/api/cos/{cosRef}/subscriptions/{subscriptionId}
 */
async function getSubscriptionStatus(subscriptionId) {
  return withRetry(async () => {
    const res = await http.get(
      `/ocs/subscription/api/cos/${CFG.cosRef}/subscriptions/${subscriptionId}`
    );
    return {
      status:     res.data?.status,
      provStatus: res.data?.provisioningStatus,
      raw:        res.data,
    };
  }, `getSubscriptionStatus(${subscriptionId})`);
}


// ═════════════════════════════════════════════════════════════════
// 3. SIM MANAGEMENT API — Détails eSIM & QR Code
// ═════════════════════════════════════════════════════════════════

/**
 * Récupère les détails complets d'un profil eSIM par ICCID
 * GET /sim-management/api/esim/{iccid}
 *
 * @param {string} iccid
 * @returns {{ activationCode, qrCodeUrl, status, raw }}
 */
async function getEsimDetails(iccid) {
  logger.info(`[SIM] Récupération détails eSIM pour ICCID ${iccid}`);

  return withRetry(async () => {
    const res = await http.get(`/sim-management/api/esim/${iccid}`);
    const data = res.data;

    // Normaliser les champs selon la réponse Transatel
    // (les noms de champs exacts dépendent de la version de l'API — adapter si besoin)
    const activationCode =
      data?.activationCode ||
      data?.activation_code ||
      data?.ac ||
      null;

    const qrCodeUrl =
      data?.qrCodeUrl ||
      data?.qr_code_url ||
      data?.qrCode ||
      null;

    if (!activationCode) {
      logger.warn(`[SIM] Pas d'activationCode dans la réponse pour ${iccid}: ${JSON.stringify(data)}`);
    }

    return { activationCode, qrCodeUrl, status: data?.status, raw: data };
  }, `getEsimDetails(${iccid})`);
}

/**
 * Récupère uniquement le QR code (lien de téléchargement)
 * GET /sim-management/api/esim/{iccid}/qrcode
 */
async function getEsimQrCode(iccid) {
  return withRetry(async () => {
    const res = await http.get(`/sim-management/api/esim/${iccid}/qrcode`);
    return {
      qrCodeUrl:  res.data?.url || res.data?.qrCodeUrl,
      qrCodeData: res.data?.data || res.data?.qrCodeData,
      raw: res.data,
    };
  }, `getEsimQrCode(${iccid})`);
}

/**
 * Récupère le statut d'un profil eSIM
 * GET /sim-management/api/esim/{iccid}/status
 */
async function getEsimStatus(iccid) {
  return withRetry(async () => {
    const res = await http.get(`/sim-management/api/esim/${iccid}/status`);
    return {
      status:      res.data?.status,
      profileState: res.data?.profileState,
      raw: res.data,
    };
  }, `getEsimStatus(${iccid})`);
}


// ═════════════════════════════════════════════════════════════════
// 4. CONNECTIVITY MANAGEMENT API
// ═════════════════════════════════════════════════════════════════

/**
 * Récupère les informations du subscriber
 * GET /connectivity/api/subscribers/{iccid}
 */
async function getSubscriber(iccid) {
  return withRetry(async () => {
    const res = await http.get(`/connectivity/api/subscribers/${iccid}`);
    return res.data;
  }, `getSubscriber(${iccid})`);
}

/**
 * Récupère le statut d'une transaction de souscription
 * GET /connectivity/api/transactions/{transactionId}
 */
async function getTransactionStatus(transactionId) {
  return withRetry(async () => {
    const res = await http.get(`/connectivity/api/transactions/${transactionId}`);
    return {
      status: res.data?.status,
      result: res.data?.result,
      raw:    res.data,
    };
  }, `getTransactionStatus(${transactionId})`);
}


// ═════════════════════════════════════════════════════════════════
// Export
// ═════════════════════════════════════════════════════════════════

module.exports = {
  // Catalog
  getCatalogProducts,
  getProductDetails,
  getCatalogOptions,

  // Subscription
  subscribeProduct,
  getSubscriptionStatus,

  // SIM Management
  getEsimDetails,
  getEsimQrCode,
  getEsimStatus,

  // Connectivity
  getSubscriber,
  getTransactionStatus,

  // Config (lecture seule)
  COS_REF: CFG.cosRef,
};
