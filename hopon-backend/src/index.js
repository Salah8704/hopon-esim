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

// CORS ouvert — accepte tous les appels (admin local, Hostinger, hopon.fr)
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

// Routes
try {
  app.use('/api/v1/catalog',  require('./routes/catalog'));
  app.use('/api/v1/orders',   require('./routes/orders'));
  app.use('/api/v1/admin',    require('./routes/admin'));
  app.use('/api/v1/partners', require('./routes/partners'));
  app.use('/api/v1/stripe',   require('./routes/stripe'));
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
  } catch(e) { logger.warn('Worker non dispo: ' + e.message); }
}

// Cron optionnel
try {
  const { CronJob } = require('cron');
  const catalogSvc  = require('./services/catalog');
  new CronJob(process.env.CATALOG_SYNC_CRON || '0 */4 * * *', async () => {
    await catalogSvc.syncCatalog({ mode: 'incremental' }).catch(e => logger.error('Sync: ' + e.message));
  }, null, true, 'Europe/Paris');
} catch(e) { logger.warn('Cron non dispo: ' + e.message); }

const PORT = parseInt(process.env.PORT) || 3001;
app.listen(PORT, async () => {
  logger.info('hopOn Backend port ' + PORT);
  try { await db.query('SELECT 1'); logger.info('PostgreSQL OK'); }
  catch(e) { logger.warn('PostgreSQL indispo: ' + e.message); }
});

module.exports = app;
