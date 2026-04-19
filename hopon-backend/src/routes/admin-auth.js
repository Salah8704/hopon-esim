'use strict';

/**
 * Routes admin-auth — hopOn
 *
 * Nouveau router autonome qui ajoute :
 *   - POST /api/v1/admin/login   → authentification JWT
 *   - GET  /api/v1/admin/stats   → KPIs + séries + top destinations
 *   - middleware requireAdmin    → à réutiliser dans les autres routers
 *
 * À monter AVANT ./admin dans index.js pour que /login soit pris ici :
 *   const adminAuthRoutes = require('./routes/admin-auth');
 *   app.use('/api/v1/admin', adminAuthRoutes);
 *   app.use('/api/v1/admin', adminRoutes);  // l'existant
 *
 * ENV requis :
 *   ADMIN_EMAIL       (ex: contact@hopon.fr)
 *   ADMIN_PASSWORD    (mot de passe admin)
 *   ADMIN_JWT_SECRET  (clé JWT, min 32 chars)
 */

const express = require('express');
const jwt     = require('jsonwebtoken');
const router  = express.Router();

const ADMIN_EMAIL    = (process.env.ADMIN_EMAIL    || 'contact@hopon.fr').toLowerCase();
const ADMIN_PASSWORD =  process.env.ADMIN_PASSWORD || 'change-me-now';
const JWT_SECRET     =  process.env.ADMIN_JWT_SECRET || 'hopon-dev-secret-change-me-min-32-chars';
const JWT_TTL        = '7d';

// ──────────────────────────────────────────────────────────
// Middleware — vérifie le JWT et attache req.admin
// ──────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!tok) return res.status(401).json({ error: 'Token manquant' });
  try {
    const payload = jwt.verify(tok, JWT_SECRET);
    if (payload.role !== 'admin') return res.status(403).json({ error: 'Accès refusé' });
    req.admin = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expirée' });
  }
}

// ──────────────────────────────────────────────────────────
// POST /login — authentification
// ──────────────────────────────────────────────────────────
router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email et mot de passe requis' });
  }
  if (String(email).toLowerCase() !== ADMIN_EMAIL || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Identifiants incorrects' });
  }
  const token = jwt.sign(
    { role: 'admin', email: ADMIN_EMAIL },
    JWT_SECRET,
    { expiresIn: JWT_TTL }
  );
  res.json({
    token,
    user: { email: ADMIN_EMAIL, name: 'hopOn Admin' },
  });
});

// ──────────────────────────────────────────────────────────
// GET /stats?days=N — KPIs + série + top destinations
// ──────────────────────────────────────────────────────────
router.get('/stats', requireAdmin, async (req, res) => {
  const days = Math.max(1, Math.min(365, parseInt(req.query.days) || 30));
  try {
    const { db } = require('../db/pool');
    const now   = new Date();
    const since = new Date(now.getTime() - days * 86400000);
    const prev  = new Date(now.getTime() - 2 * days * 86400000);

    const result = await db.query(`
      SELECT id, created_at, email, country, flag, amount, status
      FROM orders
      WHERE created_at >= $1
      ORDER BY created_at DESC
    `, [prev]).catch(() => null);

    if (!result || !result.rows) {
      return res.json({
        revenue: 0, revenueChg: 0, orders: 0, orderChg: 0,
        avg: 0, conversion: 0, series: [], topDestinations: [],
      });
    }

    const rows = result.rows.map(r => ({
      ...r,
      amount: (r.amount || 0) / 100,
      createdAt: r.created_at,
    }));

    const curr       = rows.filter(r => new Date(r.createdAt) >= since);
    const before     = rows.filter(r => new Date(r.createdAt) < since);
    const paid       = curr.filter(r => (r.status || 'paid') === 'paid');
    const paidBefore = before.filter(r => (r.status || 'paid') === 'paid');

    const revenue    = paid.reduce((s, r) => s + r.amount, 0);
    const revPrev    = paidBefore.reduce((s, r) => s + r.amount, 0);
    const revenueChg = revPrev ? ((revenue - revPrev) / revPrev * 100) : 0;
    const orderChg   = paidBefore.length ? ((paid.length - paidBefore.length) / paidBefore.length * 100) : 0;

    // Série journalière remplie (incluant les jours à 0)
    const buckets = {};
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400000);
      buckets[d.toISOString().slice(0, 10)] = 0;
    }
    paid.forEach(r => {
      const k = new Date(r.createdAt).toISOString().slice(0, 10);
      if (buckets[k] != null) buckets[k] += r.amount;
    });
    const series = Object.entries(buckets).map(([date, value]) => ({ date, value }));

    // Top destinations
    const byDest = {};
    paid.forEach(r => {
      const k = r.country || '—';
      if (!byDest[k]) byDest[k] = { country: k, flag: r.flag || '🌍', count: 0, revenue: 0 };
      byDest[k].count++;
      byDest[k].revenue += r.amount;
    });
    const topDestinations = Object.values(byDest)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 8);

    res.json({
      revenue,
      revenueChg,
      orders: paid.length,
      orderChg,
      avg: paid.length ? revenue / paid.length : 0,
      conversion: curr.length ? (paid.length / curr.length * 100) : 0,
      series,
      topDestinations,
    });
  } catch (e) {
    console.error('[admin-auth/stats]', e.message);
    res.json({
      revenue: 0, revenueChg: 0, orders: 0, orderChg: 0,
      avg: 0, conversion: 0, series: [], topDestinations: [],
    });
  }
});

module.exports = router;
module.exports.requireAdmin = requireAdmin;
