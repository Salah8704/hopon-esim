'use strict';
const express    = require('express');
const jwt        = require('jsonwebtoken');
const { db }     = require('../db/pool');
const catalogSvc = require('../services/catalog');
const transatel  = require('../api/transatel');
const logger     = require('../utils/logger');

const router = express.Router();

// ─── Auth middleware admin ────────────────────────────────────────
function requireAdmin(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Token requis' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.role !== 'admin') throw new Error('Rôle admin requis');
    req.admin = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Token invalide ou expiré' });
  }
}
router.use(requireAdmin);

// ─── Dashboard overview ──────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
  try {
    const [orders, stock, prices, lastSync] = await Promise.all([
      db.query(`SELECT status, COUNT(*) FROM orders GROUP BY status`),
      db.query(`SELECT status, COUNT(*) FROM sim_stock GROUP BY status`),
      db.query(`SELECT price_status, COUNT(*) FROM products GROUP BY price_status`),
      db.query(`SELECT * FROM catalog_sync_logs ORDER BY started_at DESC LIMIT 1`),
    ]);
    res.json({
      orders:   orders.rows,
      stock:    stock.rows,
      prices:   prices.rows,
      lastSync: lastSync.rows[0] || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Catalogue & prix ────────────────────────────────────────────

// GET tous les produits avec statut de prix
router.get('/products', async (req, res) => {
  const { price_status, country, limit = 50, offset = 0 } = req.query;
  try {
    let q = `SELECT p.*, c.name_fr, c.flag_emoji
             FROM products p LEFT JOIN countries c ON c.iso2 = p.country_iso2
             WHERE 1=1`;
    const params = [];
    let i = 1;
    if (price_status) { q += ` AND p.price_status = $${i++}`; params.push(price_status); }
    if (country)      { q += ` AND p.country_iso2 = $${i++}`; params.push(country.toUpperCase()); }
    q += ` ORDER BY p.last_synced_at DESC NULLS LAST LIMIT $${i++} OFFSET $${i}`;
    params.push(parseInt(limit), parseInt(offset));
    const { rows } = await db.query(q, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST valider un prix et publier un produit
router.post('/products/:id/validate', async (req, res) => {
  const { public_price } = req.body;
  if (!public_price || isNaN(parseFloat(public_price))) {
    return res.status(400).json({ error: 'public_price invalide' });
  }
  try {
    const result = await catalogSvc.validateAndPublishProduct(
      req.params.id,
      parseFloat(public_price),
      req.admin.id
    );
    logger.info(`[Admin] Produit ${req.params.id} validé par ${req.admin.email} — prix: ${public_price}€`);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST dépublier un produit
router.post('/products/:id/unpublish', async (req, res) => {
  try {
    await db.query(
      `UPDATE products SET is_published = false, price_status = 'pending_review' WHERE id = $1`,
      [req.params.id]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Synchronisation catalogue ───────────────────────────────────

// POST déclencher une sync manuelle
router.post('/sync/catalog', async (req, res) => {
  logger.info(`[Admin] Sync catalogue manuelle déclenchée par ${req.admin.email}`);
  // Répondre immédiatement, sync en arrière-plan
  res.json({ message: 'Sync démarrée', started: true });
  catalogSvc.syncCatalog({ mode: req.body?.mode || 'full' }).catch(e => {
    logger.error(`[Admin] Sync catalogue: ${e.message}`);
  });
});

// GET logs de sync
router.get('/sync/logs', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM catalog_sync_logs ORDER BY started_at DESC LIMIT 20`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Stock eSIM ──────────────────────────────────────────────────

// GET stock par statut
router.get('/stock', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT status, COUNT(*) as count FROM sim_stock GROUP BY status`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST ajouter des SIM au stock
router.post('/stock/import', async (req, res) => {
  const { iccids } = req.body;
  if (!Array.isArray(iccids) || !iccids.length) {
    return res.status(400).json({ error: 'iccids[] requis' });
  }
  try {
    let created = 0;
    for (const iccid of iccids) {
      await db.query(
        `INSERT INTO sim_stock (iccid) VALUES ($1) ON CONFLICT (iccid) DO NOTHING`,
        [iccid.trim()]
      );
      created++;
    }
    logger.info(`[Admin] ${created} SIM importées par ${req.admin.email}`);
    res.json({ created });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Commandes ───────────────────────────────────────────────────

router.get('/orders', async (req, res) => {
  const { status, limit = 50, offset = 0 } = req.query;
  try {
    let q = `SELECT o.*, p.name as product_name, c.name_fr as country_name, c.flag_emoji
             FROM orders o
             LEFT JOIN products p ON p.id = o.product_id
             LEFT JOIN countries c ON c.iso2 = o.country_iso2
             WHERE 1=1`;
    const params = [];
    let i = 1;
    if (status) { q += ` AND o.status = $${i++}`; params.push(status); }
    q += ` ORDER BY o.created_at DESC LIMIT $${i++} OFFSET $${i}`;
    params.push(parseInt(limit), parseInt(offset));
    const { rows } = await db.query(q, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET logs API Transatel pour une commande
router.get('/orders/:id/api-logs', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM api_logs WHERE order_id = $1 ORDER BY created_at ASC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
