'use strict';
const { db } = require('../db/pool');
const logger = require('../utils/logger');
const router = require('express').Router();

// GET /api/v1/catalog/products — public
router.get('/products', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 200;
    const { rows } = await db.query(
      'SELECT id, ocs_ref, name, data_kb, duration_days, duration_unit, ' +
      'countries, supplier_price, public_price, currency, price_status, is_published, raw_data ' +
      'FROM products ORDER BY duration_days ASC, data_kb ASC LIMIT $1',
      [limit]
    ).catch(() => ({ rows: [] }));
    res.json(rows);
  } catch(e) {
    logger.error('[Catalog] ' + e.message);
    res.json([]);
  }
});

// GET /api/v1/catalog/products/:id
router.get('/products/:id', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM products WHERE id=$1 OR ocs_ref=$1 LIMIT 1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Produit non trouvé' });
    res.json(rows[0]);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/v1/catalog/products/:id/price — définir prix public (admin)
router.put('/products/:id/price', async (req, res) => {
  const { public_price } = req.body;
  if (public_price === undefined || public_price === null) {
    return res.status(400).json({ error: 'public_price requis' });
  }
  const price = parseFloat(public_price);
  if (isNaN(price) || price < 0) {
    return res.status(400).json({ error: 'Prix invalide' });
  }
  try {
    const result = await db.query(
      'UPDATE products SET public_price=$1, price_status=$2, is_published=$3, updated_at=NOW() WHERE id=$4 OR ocs_ref=$4 RETURNING id, ocs_ref, public_price',
      [price, 'validated', price > 0, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Produit non trouvé' });
    logger.info('[Catalog] Prix mis à jour: ' + req.params.id + ' -> ' + price + ' EUR');
    res.json({ success: true, product: result.rows[0] });
  } catch(e) {
    logger.error('[Catalog] PUT price: ' + e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/v1/catalog/products/:id/price — compat ancien admin
router.post('/products/:id/price', async (req, res) => {
  const { public_price } = req.body;
  if (!public_price) return res.status(400).json({ error: 'public_price requis' });
  try {
    await db.query(
      'UPDATE products SET public_price=$1, price_status=$2, is_published=true, updated_at=NOW() WHERE id=$3 OR ocs_ref=$3',
      [parseFloat(public_price), 'validated', req.params.id]
    );
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
