// src/routes/orders.js
'use strict';
const express  = require('express');
const jwt      = require('jsonwebtoken');
const { db }   = require('../db/pool');
const esimSvc  = require('../services/esim');
const logger   = require('../utils/logger');

const router = express.Router();

// Auth optionnelle (clients connectés)
function optionalAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) {
    try { req.user = jwt.verify(token, process.env.JWT_SECRET); } catch {}
  }
  next();
}

// GET /api/v1/orders/:id — détail d'une commande
// Accessible sans auth si on fournit le bon email
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const { rows: [order] } = await db.query(
      `SELECT o.*, p.name as product_name, c.name_fr as country_name, c.flag_emoji,
              c.storyline
       FROM orders o
       LEFT JOIN products p ON p.id = o.product_id
       LEFT JOIN countries c ON c.iso2 = o.country_iso2
       WHERE o.id = $1`,
      [req.params.id]
    );
    if (!order) return res.status(404).json({ error: 'Commande introuvable' });

    // Vérifier accès : soit admin, soit email correspondant
    const email = req.query.email || req.user?.email;
    if (!req.user?.role === 'admin' && order.customer_email !== email) {
      return res.status(403).json({ error: 'Accès refusé' });
    }

    // Ne pas exposer les données sensibles API
    delete order.raw_api_data;
    res.json(order);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/v1/orders/:id/retry — relancer une livraison échouée
router.post('/:id/retry', optionalAuth, async (req, res) => {
  try {
    const { rows: [order] } = await db.query(
      'SELECT * FROM orders WHERE id = $1', [req.params.id]
    );
    if (!order) return res.status(404).json({ error: 'Commande introuvable' });
    if (order.status !== esimSvc.STATUS.DELIVERY_FAILED) {
      return res.status(400).json({ error: 'Relance impossible pour ce statut' });
    }

    const { queue } = require('../jobs/queue');
    await queue.add('process-esim', { orderId: order.id }, { attempts: 3 });
    res.json({ message: 'Relance enqueued' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
