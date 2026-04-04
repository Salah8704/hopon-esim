'use strict';
const express    = require('express');
const { db }     = require('../db/pool');
const catalogSvc = require('../services/catalog');
const logger     = require('../utils/logger');

const router = express.Router();

/**
 * GET /api/v1/catalog/countries
 * Liste tous les pays actifs avec leur nombre de forfaits disponibles
 */
router.get('/countries', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT c.*,
        COUNT(p.id) FILTER (WHERE p.is_published AND p.price_status = 'validated') AS product_count,
        MIN(p.public_price) FILTER (WHERE p.is_published AND p.price_status = 'validated') AS price_from
      FROM countries c
      LEFT JOIN products p ON p.country_iso2 = c.iso2
      WHERE c.is_active = true
      GROUP BY c.id
      ORDER BY c.sort_order ASC, c.name_fr ASC
    `);
    res.json(rows);
  } catch (e) {
    logger.error(`[API] /countries: ${e.message}`);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * GET /api/v1/catalog/countries/:iso2
 * Détail d'un pays avec ses forfaits publiés
 */
router.get('/countries/:iso2', async (req, res) => {
  const iso2 = req.params.iso2.toUpperCase();
  try {
    const { rows: [country] } = await db.query(
      'SELECT * FROM countries WHERE iso2 = $1 AND is_active = true', [iso2]
    );
    if (!country) return res.status(404).json({ error: 'Pays introuvable' });

    const products = await catalogSvc.getPublishedProducts(iso2);
    res.json({ ...country, products });
  } catch (e) {
    logger.error(`[API] /countries/${iso2}: ${e.message}`);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * GET /api/v1/catalog/products
 * Forfaits disponibles avec filtres optionnels
 * Query: ?country=MA&duration=7&category=short_stay&max_price=20
 */
router.get('/products', async (req, res) => {
  try {
    const { country, duration, category, max_price, limit = 20 } = req.query;

    let query = `
      SELECT p.*, c.name_fr as country_name, c.flag_emoji, c.iso2
      FROM products p
      LEFT JOIN countries c ON c.iso2 = p.country_iso2
      WHERE p.is_published = true
        AND p.price_status = 'validated'
        AND p.public_price IS NOT NULL
    `;
    const params = [];
    let i = 1;

    if (country) {
      query += ` AND (p.country_iso2 = $${i++} OR p.is_global = true)`;
      params.push(country.toUpperCase());
    }
    if (duration) {
      query += ` AND p.duration_days = $${i++}`;
      params.push(parseInt(duration));
    }
    if (category) {
      query += ` AND p.category = $${i++}`;
      params.push(category);
    }
    if (max_price) {
      query += ` AND p.public_price <= $${i++}`;
      params.push(parseFloat(max_price));
    }

    query += ` ORDER BY p.is_recommended DESC, p.is_featured DESC, p.public_price ASC LIMIT $${i}`;
    params.push(Math.min(parseInt(limit), 50));

    const { rows } = await db.query(query, params);
    res.json(rows);
  } catch (e) {
    logger.error(`[API] /products: ${e.message}`);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
