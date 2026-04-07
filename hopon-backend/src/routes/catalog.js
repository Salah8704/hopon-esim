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

// POST /api/v1/catalog/products/:id/price — définir prix public
router.post('/products/:id/price', async (req, res) => {
  const { public_price } = req.body;
  if (!public_price) return res.status(400).json({ error: 'public_price requis' });
  try {
    await db.query(
      'UPDATE products SET public_price=$1, price_status=$2, is_published=true WHERE id=$3 OR ocs_ref=$3',
      [parseFloat(public_price), 'validated', req.params.id]
    );
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
