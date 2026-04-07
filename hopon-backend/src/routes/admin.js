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

router.get('/logs', optionalAuth, async (req, res) => {
  const { rows } = await db.query('SELECT * FROM api_logs ORDER BY created_at DESC LIMIT 50').catch(() => ({ rows: [] }));
  res.json(rows);
});

module.exports = router;
