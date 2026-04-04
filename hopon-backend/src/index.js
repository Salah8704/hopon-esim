'use strict';
require('dotenv').config();

const express     = require('express');
const helmet      = require('helmet');
const compression = require('compression');
const morgan      = require('morgan');
const cors        = require('cors');
const rateLimit   = require('express-rate-limit');
const { CronJob } = require('cron');

const logger      = require('./utils/logger');
const { db }      = require('./db/pool');
const esimSvc     = require('./services/esim');
const catalogSvc  = require('./services/catalog');
const { worker }  = require('./jobs/queue');

// Routes
const catalogRoutes    = require('./routes/catalog');
const ordersRoutes     = require('./routes/orders');
const adminRoutes      = require('./routes/admin');
const wcWebhook        = require('./webhooks/woocommerce');
const partnersRoutes   = require('./routes/partners');

const app = express();

// ─── Middleware sécurité ──────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());

// CORS
const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: ${origin} non autorisé`));
  },
  credentials: true,
}));

// Rate limiting
app.use(rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000,
  max:      parseInt(process.env.RATE_LIMIT_MAX) || 100,
  message:  { error: 'Trop de requêtes. Veuillez réessayer.' },
}));

// Body parser — conserver le rawBody pour la vérification HMAC webhook
app.use((req, res, next) => {
  express.json({
    verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); }
  })(req, res, next);
});

app.use(morgan('combined', { stream: { write: msg => logger.info(msg.trim()) } }));

// ─── Routes publiques ─────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok', ts: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ status: 'error', message: e.message });
  }
});

// Catalogue public (utilisé par le site frontend)
app.use('/api/v1/catalog', catalogRoutes);

// Commandes (espace client)
app.use('/api/v1/orders', ordersRoutes);

// Admin (protégé par JWT admin)
app.use('/api/v1/admin', adminRoutes);

// Partenaires / affiliation
app.use('/api/v1/partners', partnersRoutes);

// Webhooks (signature vérifiée en interne)
app.use('/webhooks', wcWebhook);

// ─── Bull Worker — traitement des jobs eSIM ──────────────────────
worker.process('process-esim', 5, async (job) => {
  const { orderId } = job.data;
  logger.info(`[Worker] Traitement job eSIM — orderId: ${orderId}`);
  await esimSvc.processEsimOrder(orderId);
});

worker.on('failed', (job, err) => {
  logger.error(`[Worker] Job ${job.id} échoué (tentative ${job.attemptsMade}): ${err.message}`);
});

worker.on('completed', (job) => {
  logger.info(`[Worker] Job ${job.id} terminé avec succès`);
});

// ─── Cron jobs ───────────────────────────────────────────────────

// Sync catalogue tous les 4h
const catalogSync = new CronJob(
  process.env.CATALOG_SYNC_CRON || '0 */4 * * *',
  async () => {
    if (process.env.ENABLE_WOOCOMMERCE_SYNC !== 'false') {
      logger.info('[Cron] Démarrage sync catalogue automatique');
      try {
        await catalogSvc.syncCatalog({ mode: 'incremental' });
      } catch (e) {
        logger.error(`[Cron] Erreur sync catalogue: ${e.message}`);
      }
    }
  },
  null, true, 'Europe/Paris'
);

// Libération réservations expirées toutes les 5 min
const reservationCleanup = new CronJob('*/5 * * * *', async () => {
  await esimSvc.releaseExpiredReservations().catch(e => {
    logger.warn(`[Cron] Erreur cleanup réservations: ${e.message}`);
  });
}, null, true, 'Europe/Paris');

// ─── Démarrage ───────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT) || 3001;
app.listen(PORT, async () => {
  logger.info(`✅ hopOn Backend démarré sur port ${PORT} [${process.env.NODE_ENV}]`);

  // Vérification connexion DB au démarrage
  try {
    await db.query('SELECT 1');
    logger.info('✅ PostgreSQL connecté');
  } catch (e) {
    logger.error(`❌ PostgreSQL: ${e.message}`);
    process.exit(1);
  }

  // Sync catalogue au démarrage (première fois)
  if (process.env.NODE_ENV !== 'test') {
    setTimeout(async () => {
      logger.info('[Startup] Sync catalogue initiale');
      await catalogSvc.syncCatalog({ mode: 'full' }).catch(e => {
        logger.warn(`[Startup] Sync catalogue: ${e.message}`);
      });
    }, 5000);
  }
});

module.exports = app;
