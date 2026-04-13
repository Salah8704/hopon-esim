'use strict';
const express = require('express');
const { db }  = require('../db/pool');
const logger  = require('../utils/logger');
const router  = express.Router();

function optionalAuth(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return next();
  const provided = req.headers['x-admin-secret'] || req.query.secret;
  return provided === secret ? next() : res.status(401).json({ error: 'Non autorise' });
}

router.get('/status', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

router.get('/dashboard', optionalAuth, async (req, res) => {
  res.json({ ts: new Date().toISOString() });
});

router.get('/orders', optionalAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 200);
  try {
    const { rows } = await db.query(
      `SELECT o.id, o.order_number, o.customer_email, o.status, o.total_price, o.currency,
              o.sim_iccid, o.ocs_subscription_id, o.created_at,
              p.name AS product_name,
              c.name_fr AS country_name, c.flag_emoji
       FROM orders o
       LEFT JOIN products p ON p.id = o.product_id
       LEFT JOIN countries c ON c.iso2 = o.country_iso2
       ORDER BY o.created_at DESC
       LIMIT $1`,
      [limit]
    );
    res.json(rows);
  } catch (e) {
    logger.error('[Admin] Orders: ' + e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/stripe/status', optionalAuth, async (req, res) => {
  const key = process.env.STRIPE_SECRET_KEY || '';
  const webhook = process.env.STRIPE_WEBHOOK_SECRET || '';
  res.json({
    configured: Boolean(key && !key.includes('REMPLACER')),
    webhook_configured: Boolean(webhook && !webhook.includes('REMPLACER')),
    ts: new Date().toISOString()
  });
});

router.post('/sync/catalog', optionalAuth, async (req, res) => {
  logger.info('[Admin] Sync catalogue');
  if (!process.env.OCS_USERNAME || !process.env.OCS_PASSWORD) {
    return res.status(503).json({
      error: 'OCS_USERNAME et OCS_PASSWORD manquants dans Railway Variables'
    });
  }
  try {
    const catalogSvc = require('../services/catalog');
    const result = await catalogSvc.syncCatalog({ mode: 'full' });
    return res.json({ success: true, count: (result && result.count) || 0, ts: new Date().toISOString() });
  } catch (e) {
    logger.error('[Admin] Sync: ' + e.message);
    return res.status(500).json({ error: e.message });
  }
});

router.get('/products', optionalAuth, async (req, res) => {
  const { rows } = await db.query('SELECT * FROM products LIMIT 100').catch(() => ({ rows: [] }));
  res.json(rows);
});

router.post('/products/:id/validate', optionalAuth, async (req, res) => {
  const { public_price } = req.body;
  if (!public_price) return res.status(400).json({ error: 'public_price requis' });
  try {
    await db.query(
      'UPDATE products SET public_price=$1, price_status=$2, is_published=true WHERE id=$3',
      [parseFloat(public_price), 'validated', req.params.id]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/products/:id/publish', optionalAuth, async (req, res) => {
  const isPublished = Boolean(req.body && req.body.is_published);
  try {
    await db.query(
      'UPDATE products SET is_published=$1, updated_at=NOW() WHERE id=$2',
      [isPublished, req.params.id]
    );
    res.json({ success: true, is_published: isPublished });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/logs', optionalAuth, async (req, res) => {
  const { rows } = await db.query('SELECT * FROM api_logs ORDER BY created_at DESC LIMIT 50').catch(() => ({ rows: [] }));
  res.json(rows);
});

module.exports = router;
