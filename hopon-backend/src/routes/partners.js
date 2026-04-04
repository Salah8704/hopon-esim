'use strict';
/**
 * HopOn — Partner / Affiliate API Routes
 * Tracking des visites, conversions, gestion des partenaires
 */
const express = require('express');
const crypto  = require('crypto');
const { db }  = require('../db/pool');
const logger  = require('../utils/logger');
const router  = express.Router();

// POST /api/v1/partners/track — tracking visit ou conversion
router.post('/track', async (req, res) => {
  try {
    const { partner_id, event, amount, country, source, page } = req.body;
    if (!partner_id || !event) return res.status(400).json({ error: 'partner_id et event requis' });

    // Vérifier que le partenaire existe
    const { rows: [partner] } = await db.query(
      'SELECT id, status, commission_pct FROM partners WHERE partner_code = $1',
      [partner_id]
    );
    if (!partner || partner.status !== 'active') {
      return res.status(200).json({ tracked: false }); // silencieux
    }

    if (event === 'visit') {
      await db.query(
        `INSERT INTO partner_clicks (partner_id, source, page, ip_hash, user_agent)
         VALUES ($1, $2, $3, $4, $5)`,
        [partner.id, source || 'link', page, hashIp(req.ip), req.headers['user-agent']?.substring(0, 200)]
      );
    } else if (event === 'conversion') {
      // La conversion réelle est enregistrée via le webhook WooCommerce
      // Ceci est un pré-enregistrement pour la session
      logger.info(`[Partner] Conversion trackée: partenaire=${partner_id}, amount=${amount}, country=${country}`);
    }

    res.json({ tracked: true });
  } catch (e) {
    logger.error(`[Partners] Track error: ${e.message}`);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/v1/partners/:code/dashboard — dashboard partenaire
router.get('/:code/dashboard', async (req, res) => {
  try {
    const { rows: [partner] } = await db.query(
      `SELECT p.*,
        COUNT(DISTINCT pc.id) as total_clicks,
        COUNT(DISTINCT pr.id) as total_sales,
        COALESCE(SUM(pr.sale_amount), 0) as total_revenue,
        COALESCE(SUM(pr.commission_amount), 0) as total_commission
       FROM partners p
       LEFT JOIN partner_clicks pc ON pc.partner_id = p.id
       LEFT JOIN partner_referrals pr ON pr.partner_id = p.id
       WHERE p.partner_code = $1 AND p.status = 'active'
       GROUP BY p.id`,
      [req.params.code]
    );
    if (!partner) return res.status(404).json({ error: 'Partenaire introuvable' });

    const { rows: monthly } = await db.query(
      `SELECT DATE_TRUNC('month', created_at) as month,
              COUNT(*) as sales,
              SUM(sale_amount) as revenue,
              SUM(commission_amount) as commission
       FROM partner_referrals
       WHERE partner_id = $1 AND created_at > NOW() - INTERVAL '6 months'
       GROUP BY 1 ORDER BY 1`,
      [partner.id]
    );

    const { rows: recent } = await db.query(
      `SELECT pr.*, c.name_fr as country_name, c.flag_emoji
       FROM partner_referrals pr
       LEFT JOIN countries c ON c.iso2 = pr.country_iso2
       WHERE pr.partner_id = $1
       ORDER BY pr.created_at DESC LIMIT 10`,
      [partner.id]
    );

    const refLink = `https://hopon.fr/?ref=${partner.partner_code}`;
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(refLink)}&bgcolor=07090f&color=F5A020&margin=14`;

    res.json({ partner, stats: { monthly, recent }, refLink, qrUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function hashIp(ip) {
  return ip ? crypto.createHash('sha256').update(ip).digest('hex').substring(0, 16) : null;
}

module.exports = router;
