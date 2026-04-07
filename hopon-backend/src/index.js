'use strict';
require('dotenv').config();

const express     = require('express');
const helmet      = require('helmet');
const compression = require('compression');
const morgan      = require('morgan');
const cors        = require('cors');
const rateLimit   = require('express-rate-limit');
const logger      = require('./utils/logger');
const { db }      = require('./db/pool');

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors({ origin: '*', credentials: false }));
app.options('*', cors({ origin: '*' }));
app.use(rateLimit({ windowMs: 60000, max: 200, message: { error: 'Trop de requetes.' } }));
app.use((req, res, next) => {
  express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } })(req, res, next);
});
app.use(morgan('combined', { stream: { write: msg => logger.info(msg.trim()) } }));

// Health check
app.get('/health', async (req, res) => {
  let dbOk = false;
  try { await db.query('SELECT 1'); dbOk = true; } catch(e) {}
  res.status(200).json({ status: dbOk ? 'ok' : 'degraded', db: dbOk ? 'connected' : 'unavailable', ts: new Date().toISOString() });
});

// Admin status
app.get('/api/v1/admin/status', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// Sync catalogue — appel direct API Transatel OCS, sans passer par le service
app.post('/api/v1/admin/sync/catalog', async (req, res) => {
  logger.info('[Admin] Sync catalogue demandee');

  const ocsUser = process.env.OCS_USERNAME;
  const ocsPass = process.env.OCS_PASSWORD;
  const cosRef  = process.env.COS_REF || 'WW_M2MA_COS_SPC';

  if (!ocsUser || !ocsPass) {
    return res.status(503).json({
      error: 'OCS_USERNAME et OCS_PASSWORD manquants dans Railway Variables'
    });
  }

  try {
    const axios = require('axios');
    const auth  = Buffer.from(ocsUser + ':' + ocsPass).toString('base64');

    // Appel API Transatel OCS
    const r = await axios.get('https://ocs.transatel.com/ocs/api/v1/products', {
      headers: {
        'Authorization': 'Basic ' + auth,
        'Accept': 'application/json',
        'X-Cos-Ref': cosRef,
      },
      timeout: 20000,
    });

    const products = r.data && (r.data.products || r.data.data || r.data);
    const count = Array.isArray(products) ? products.length : 0;

    logger.info('[Admin] Sync OK: ' + count + ' produits');
    return res.json({
      success: true,
      count: count,
      message: count + ' forfaits recuperes depuis Transatel OCS',
      ts: new Date().toISOString()
    });

  } catch (e) {
    logger.error('[Admin] Sync erreur: ' + e.message);
    const status = e.response ? e.response.status : 500;
    return res.status(status < 500 ? status : 500).json({
      error: e.response
        ? 'Transatel OCS: ' + e.response.status + ' - verifiez OCS_USERNAME et OCS_PASSWORD'
        : e.message,
    });
  }
});

// Stripe
try { app.use('/api/v1/stripe', require('./routes/stripe')); } catch(e) { logger.warn('Stripe: ' + e.message); }

// Autres routes
try {
  app.use('/api/v1/catalog',  require('./routes/catalog'));
  app.use('/api/v1/orders',   require('./routes/orders'));
  app.use('/api/v1/partners', require('./routes/partners'));
  app.use('/webhooks',        require('./webhooks/woocommerce'));
  logger.info('Routes chargees');
} catch(e) {
  logger.error('Erreur routes: ' + e.message);
}

// Worker optionnel
if (process.env.REDIS_URL) {
  try {
    const { worker } = require('./jobs/queue');
    const esimSvc    = require('./services/esim');
    worker.process('process-esim', 5, async (job) => { await esimSvc.processEsimOrder(job.data.orderId); });
    logger.info('Worker demarre');
  } catch(e) { logger.warn('Worker: ' + e.message); }
}

const PORT = parseInt(process.env.PORT) || 3001;
app.listen(PORT, async () => {
  logger.info('hopOn Backend port ' + PORT);
  try { await db.query('SELECT 1'); logger.info('PostgreSQL OK'); }
  catch(e) { logger.warn('PostgreSQL: ' + e.message); }
});

module.exports = app;
