'use strict';
require('dotenv').config();

const express     = require('express');
const helmet      = require('helmet');
const compression = require('compression');
const morgan      = require('morgan');
const cors        = require('cors');
const rateLimit   = require('express-rate-limit');
const axios       = require('axios');
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

// Health
app.get('/health', async (req, res) => {
  let dbOk = false;
  try { await db.query('SELECT 1'); dbOk = true; } catch(e) {}
  res.status(200).json({ status: dbOk ? 'ok' : 'degraded', db: dbOk ? 'connected' : 'unavailable', ts: new Date().toISOString() });
});

// Admin status
app.get('/api/v1/admin/status', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// Sync catalogue Transatel — appel direct OAuth2
app.post('/api/v1/admin/sync/catalog', async (req, res) => {
  logger.info('[Sync] Demarrage sync catalogue Transatel');

  const user = process.env.OCS_USERNAME;
  const pass = process.env.OCS_PASSWORD;
  const cos  = process.env.OCS_COS_REF || 'WW_M2MA_COS_SPC';

  if (!user || !pass) {
    return res.status(503).json({ error: 'OCS_USERNAME et OCS_PASSWORD manquants dans Railway Variables' });
  }

  try {
    // Etape 1 : token OAuth2
    const cred = Buffer.from(user + ':' + pass).toString('base64');
    logger.info('[Sync] Obtention token Transatel...');
    const tokRes = await axios.post(
      'https://api.transatel.com/authentication/api/token',
      'grant_type=client_credentials',
      { headers: { 'Authorization': 'Basic ' + cred, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
    );
    const token = tokRes.data.access_token;
    logger.info('[Sync] Token OK, expires_in=' + tokRes.data.expires_in);

    // Etape 2 : catalogue
    logger.info('[Sync] GET catalogue cos=' + cos);
    const catRes = await axios.get(
      'https://api.transatel.com/ocs/catalog/api/cos/' + cos + '/products',
      { headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' }, timeout: 30000 }
    );

    const products = catRes.data && catRes.data.products ? catRes.data.products
      : Array.isArray(catRes.data) ? catRes.data : [];
    logger.info('[Sync] ' + products.length + ' produits recus');

    // Etape 3 : upsert en base
    await db.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY, ocs_ref VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(500) NOT NULL, data_kb BIGINT DEFAULT 0,
        duration_days INTEGER DEFAULT 30, duration_unit VARCHAR(50) DEFAULT 'months',
        countries TEXT[], supplier_price DECIMAL(10,2) DEFAULT 0,
        public_price DECIMAL(10,2) DEFAULT 0, currency VARCHAR(10) DEFAULT 'EUR',
        price_status VARCHAR(50) DEFAULT 'pending', is_published BOOLEAN DEFAULT false,
        raw_data JSONB, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
      )
    `).catch(e => logger.warn('[Sync] Table: ' + e.message));

    let count = 0;
    for (const p of products) {
      try {
        const def     = p.productDefinition || p;
        const ocsRef  = def.productId || String(count + 1);
        const da      = def.allowances && def.allowances.data && def.allowances.data[0];
        const dataKb  = da ? parseInt(da.resourceValue || 0) : 0;
        const vp      = def.validityPeriod || {};
        const days    = parseInt(vp.validityDuration || 30);
        const unit    = vp.validityDurationUnit || 'months';
        const countries = def.countryList || [];

        await db.query(
          `INSERT INTO products (ocs_ref, name, data_kb, duration_days, duration_unit, countries, raw_data, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
           ON CONFLICT (ocs_ref) DO UPDATE
           SET name=$2, data_kb=$3, duration_days=$4, duration_unit=$5, countries=$6, raw_data=$7, updated_at=NOW()`,
          [ocsRef, ocsRef, dataKb, days, unit, countries, JSON.stringify(p)]
        );
        count++;
      } catch(e) { logger.error('[Sync] Upsert: ' + e.message); }
    }

    logger.info('[Sync] Terminee: ' + count + ' produits');
    return res.json({ success: true, count, total: products.length, ts: new Date().toISOString() });

  } catch(e) {
    const status  = e.response ? e.response.status : 'NETWORK';
    const detail  = e.response ? JSON.stringify(e.response.data).slice(0, 300) : e.message;
    logger.error('[Sync] Erreur ' + status + ': ' + detail);
    return res.status(500).json({ error: 'Erreur Transatel (' + status + '): ' + detail });
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
} catch(e) { logger.error('Routes: ' + e.message); }

// Worker optionnel
if (process.env.REDIS_URL) {
  try {
    const { worker } = require('./jobs/queue');
    worker.process('process-esim', 5, async (job) => {
      await require('./services/esim').processEsimOrder(job.data.orderId);
    });
    logger.info('Worker demarre');
  } catch(e) { logger.warn('Worker: ' + e.message); }
}

// Cron optionnel
try {
  const { CronJob } = require('cron');
  new CronJob('0 */4 * * *', async () => {
    // sync auto via cette meme route
    const axios2 = require('axios');
    axios2.post('http://localhost:' + (process.env.PORT || 3001) + '/api/v1/admin/sync/catalog')
      .catch(e => logger.error('Cron sync: ' + e.message));
  }, null, true, 'Europe/Paris');
  logger.info('Cron demarre');
} catch(e) { logger.warn('Cron: ' + e.message); }

const PORT = parseInt(process.env.PORT) || 3001;
app.listen(PORT, async () => {
  logger.info('hopOn Backend v1.3 port ' + PORT);
  try { await db.query('SELECT 1'); logger.info('PostgreSQL OK'); }
  catch(e) { logger.warn('PostgreSQL: ' + e.message); }
});

module.exports = app;
