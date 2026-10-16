'use strict';
const express = require('express');
const { db }  = require('../db/pool');
const logger  = require('../utils/logger');
const router  = express.Router();
const { requireAdmin } = require('./admin-auth');

function optionalAuth(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  const provided = req.headers['x-admin-secret'] || req.query.secret;
  if (secret && provided === secret) return next();
  return requireAdmin(req, res, next);
}

router.get('/status', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

router.get('/dashboard', optionalAuth, async (req, res) => {
  res.json({ ts: new Date().toISOString() });
});

router.get('/orders', optionalAuth, async (req, res) => {
  const page = Math.max(parseInt(req.query.page || '1', 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(req.query.page_size || req.query.limit || '30', 10) || 30, 1), 200);
  const status = (req.query.status || '').trim();
  const email = (req.query.email || '').trim().toLowerCase();
  try {
    const where = [];
    const params = [];
    if (status) {
      params.push(status);
      where.push(`o.status = $${params.length}`);
    }
    if (email) {
      params.push(`%${email}%`);
      where.push(`LOWER(o.customer_email) LIKE $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const countSql = `SELECT COUNT(*)::int AS total FROM orders o ${whereSql}`;
    const { rows: countRows } = await db.query(countSql, params);
    const total = (countRows[0] && countRows[0].total) || 0;

    const offset = (page - 1) * pageSize;
    params.push(pageSize);
    params.push(offset);

    const { rows } = await db.query(
      `SELECT o.id, o.order_number, o.customer_email, o.status, o.total_price, o.currency,
              o.sim_iccid, o.ocs_subscription_id, o.created_at,
              p.name AS product_name,
              c.name_fr AS country_name, c.flag_emoji
       FROM orders o
       LEFT JOIN products p ON p.id = o.product_id
       LEFT JOIN countries c ON c.iso2 = o.country_iso2
       ${whereSql}
       ORDER BY o.created_at DESC
       LIMIT $${params.length - 1}
       OFFSET $${params.length}`,
      params
    );
    res.json({
      data: rows,
      page,
      page_size: pageSize,
      total,
      total_pages: Math.max(Math.ceil(total / pageSize), 1)
    });
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

router.get('/partners', optionalAuth, async (req, res) => {
  try {
    const { rows } = await db.query(`SELECT p.id,p.partner_code,p.name,p.business_name,p.type,p.email,p.phone,p.status,
      p.commission_type,p.commission_pct,p.commission_fixed,p.created_at,
      COUNT(r.id)::int sales,COALESCE(SUM(r.commission_amount),0) commission
      FROM partners p LEFT JOIN partner_referrals r ON r.partner_id=p.id
      GROUP BY p.id ORDER BY p.created_at DESC`);
    res.json({ partners: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/partners/:id', optionalAuth, async (req, res) => {
  const status = String(req.body?.status || '');
  const type = String(req.body?.commission_type || 'percentage');
  const pct = Number(req.body?.commission_pct || 0);
  const fixed = Number(req.body?.commission_fixed || 0);
  if (!['pending','active','suspended','terminated'].includes(status)) return res.status(400).json({ error: 'Statut invalide' });
  if (!['percentage','fixed'].includes(type) || pct < 0 || pct > 100 || fixed < 0) return res.status(400).json({ error: 'Commission invalide' });
  const { rows } = await db.query(`UPDATE partners SET status=$1,commission_type=$2,commission_pct=$3,commission_fixed=$4,updated_at=NOW()
    WHERE id=$5 RETURNING id,partner_code,name,status,commission_type,commission_pct,commission_fixed`,[status,type,pct,fixed,req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Partenaire introuvable' });
  res.json({ partner: rows[0] });
});

router.get('/partner-referrals', optionalAuth, async (req, res) => {
  const { rows } = await db.query(`SELECT r.*,p.partner_code,p.name partner_name FROM partner_referrals r
    JOIN partners p ON p.id=r.partner_id ORDER BY r.created_at DESC LIMIT 500`);
  res.json({ referrals: rows });
});

router.patch('/partner-referrals/:id', optionalAuth, async (req, res) => {
  const status = String(req.body?.status || '');
  if (!['pending','validated','paid','cancelled'].includes(status)) return res.status(400).json({ error: 'Statut invalide' });
  const { rows } = await db.query(`UPDATE partner_referrals SET status=$1,paid_at=CASE WHEN $1='paid' THEN NOW() ELSE paid_at END
    WHERE id=$2 RETURNING *`,[status,req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Vente introuvable' });
  res.json({ referral: rows[0] });
});

module.exports = router;
