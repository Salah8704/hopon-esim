'use strict';
/**
 * HopOn — WooCommerce Webhook Handler
 *
 * Reçoit et traite les événements WooCommerce après paiement.
 * Signature HMAC-SHA256 vérifiée à chaque requête.
 */

const crypto    = require('crypto');
const express   = require('express');
const { db }    = require('../db/pool');
const esimSvc   = require('../services/esim');
const logger    = require('../utils/logger');
const { queue } = require('../jobs/queue');

const router = express.Router();

// ─── Vérification signature Webhook WooCommerce ────────────────────
function verifyWcSignature(req, res, next) {
  const signature = req.headers['x-wc-webhook-signature'];
  if (!signature) {
    logger.warn('[WC Webhook] Signature manquante');
    return res.status(401).json({ error: 'Signature requise' });
  }

  const secret = process.env.WC_WEBHOOK_SECRET;
  if (!secret) {
    logger.error('[WC Webhook] WC_WEBHOOK_SECRET non configuré');
    return res.status(500).json({ error: 'Configuration webhook manquante' });
  }

  // WooCommerce signe le body brut en HMAC-SHA256 Base64
  const rawBody   = req.rawBody || JSON.stringify(req.body);
  const computed  = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('base64');

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(computed))) {
    logger.warn('[WC Webhook] Signature invalide');
    return res.status(401).json({ error: 'Signature invalide' });
  }

  next();
}

// ─── Route principale webhook ──────────────────────────────────────
router.post('/woocommerce',
  verifyWcSignature,
  async (req, res) => {
    const event = req.headers['x-wc-webhook-event'];
    const topic = req.headers['x-wc-webhook-topic'];
    const wcOrder = req.body;

    logger.info(`[WC Webhook] Event: ${event || topic} — WC Order ID: ${wcOrder?.id}`);

    // Répondre immédiatement à WooCommerce (éviter retries)
    res.status(200).json({ received: true });

    try {
      if (event === 'order.updated' || topic === 'order.updated' ||
          event === 'order.created' || topic === 'order.created') {
        await handleOrderEvent(wcOrder);
      }
    } catch (err) {
      logger.error(`[WC Webhook] Erreur traitement: ${err.message}`);
    }
  }
);

// ─── Handler commande ──────────────────────────────────────────────
async function handleOrderEvent(wcOrder) {
  const wcStatus  = wcOrder.status;
  const wcOrderId = wcOrder.id;

  logger.info(`[WC Webhook] Commande WC#${wcOrderId} — statut: ${wcStatus}`);

  if (!['processing', 'completed'].includes(wcStatus)) {
    logger.info(`[WC Webhook] Statut ${wcStatus} ignoré`);
    return;
  }

  // Vérifier si déjà traitée (idempotence)
  const { rows: [existing] } = await db.query(
    'SELECT id, status FROM orders WHERE wc_order_id = $1',
    [wcOrderId]
  );

  if (existing && existing.status !== esimSvc.STATUS.ORDER_CREATED && existing.status !== esimSvc.STATUS.PAYMENT_PENDING) {
    logger.info(`[WC Webhook] Commande WC#${wcOrderId} déjà traitée (${existing.status}) — ignorée`);
    return;
  }

  // Mapper la commande WooCommerce vers notre schéma
  const orderData = await mapWcOrder(wcOrder);

  let orderId;

  if (existing) {
    // Mettre à jour la commande existante
    await db.query(
      `UPDATE orders SET status = $2, paid_at = NOW(), updated_at = NOW()
       WHERE wc_order_id = $1`,
      [wcOrderId, esimSvc.STATUS.PAYMENT_SUCCEEDED]
    );
    orderId = existing.id;
  } else {
    // Créer la commande
    const { rows: [created] } = await db.query(
      `INSERT INTO orders (
        order_number, wc_order_id, customer_email, customer_name,
        product_id, country_iso2, duration_days,
        unit_price, total_price, currency,
        status, paid_at, payment_method
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),$12)
      RETURNING id`,
      [
        orderData.orderNumber,    wcOrderId,
        orderData.customerEmail,  orderData.customerName,
        orderData.productId,      orderData.countryIso2,
        orderData.durationDays,   orderData.unitPrice,
        orderData.totalPrice,     orderData.currency,
        esimSvc.STATUS.PAYMENT_SUCCEEDED,
        orderData.paymentMethod,
      ]
    );
    orderId = created.id;
  }

  // Enqueuer le traitement eSIM (async via Bull queue)
  await queue.add('process-esim', { orderId }, {
    attempts:  5,
    backoff:   { type: 'exponential', delay: 10000 },
    removeOnComplete: false,
  });

  logger.info(`[WC Webhook] Job eSIM enqueué pour commande ${orderId} (WC#${wcOrderId})`);
}

// ─── Mapper commande WooCommerce → HopOn ───────────────────────────
async function mapWcOrder(wcOrder) {
  const lineItem = wcOrder.line_items?.[0]; // une eSIM = un line item
  const wc_product_id = lineItem?.product_id;

  // Trouver le produit HopOn correspondant au produit WC
  let product = null;
  if (wc_product_id) {
    const { rows } = await db.query(
      'SELECT * FROM products WHERE wc_product_id = $1',
      [wc_product_id]
    );
    product = rows[0] || null;
  }

  // Numéro de commande unique
  const orderNumber = `HOP-${new Date().getFullYear()}-${String(wcOrder.id).padStart(6, '0')}`;

  return {
    orderNumber,
    customerEmail:  wcOrder.billing?.email,
    customerName:   [wcOrder.billing?.first_name, wcOrder.billing?.last_name].filter(Boolean).join(' '),
    productId:      product?.id || null,
    countryIso2:    product?.country_iso2 || extractCountryFromMeta(wcOrder) || null,
    durationDays:   product?.duration_days || null,
    unitPrice:      parseFloat(lineItem?.price || wcOrder.total || 0),
    totalPrice:     parseFloat(wcOrder.total || 0),
    currency:       wcOrder.currency || 'EUR',
    paymentMethod:  wcOrder.payment_method_title || wcOrder.payment_method || null,
  };
}

function extractCountryFromMeta(wcOrder) {
  // Chercher dans les meta_data WooCommerce si le pays est stocké
  const meta = wcOrder.meta_data || [];
  const countryMeta = meta.find(m => ['country_iso2', 'destination_country', 'hopon_country'].includes(m.key));
  return countryMeta?.value?.toUpperCase().substring(0, 2) || null;
}

module.exports = router;
