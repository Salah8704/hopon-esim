'use strict';
const express = require('express');
const router  = express.Router();
const logger  = require('../utils/logger');

// Helper pour charger Stripe
function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || key.includes('REMPLACER')) {
    throw new Error('STRIPE_SECRET_KEY non configurée dans Railway Variables');
  }
  return require('stripe')(key);
}

// POST /api/v1/stripe/create-session
router.post('/create-session', async (req, res) => {
  try {
    const { email, name, product, amount, currency, success_url, cancel_url } = req.body;

    if (!email) return res.status(400).json({ error: 'Email requis' });
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Montant invalide' });

    const stripe = getStripe();
    const siteUrl = process.env.SITE_URL || 'https://hopon.fr';

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: email,
      line_items: [{
        price_data: {
          currency: currency || 'eur',
          product_data: {
            name: product || 'eSIM hopOn',
            description: 'Forfait eSIM international — Activation instantanée',
            images: ['https://hopon.fr/og-image.jpg'],
          },
          unit_amount: Math.round(amount), // en centimes
        },
        quantity: 1,
      }],
      success_url: success_url || (siteUrl + '/?payment=success&session={CHECKOUT_SESSION_ID}'),
      cancel_url:  cancel_url  || (siteUrl + '/?payment=cancel'),
      metadata: {
        customer_name: name || '',
        product_ref: product || '',
      },
      payment_intent_data: {
        description: 'hopOn eSIM — ' + (product || 'Forfait international'),
      },
    });

    logger.info('[Stripe] Session créée: ' + session.id + ' email=' + email + ' amount=' + amount);
    res.json({ url: session.url, session_id: session.id });

  } catch(e) {
    logger.error('[Stripe] Erreur: ' + e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/v1/stripe/session/:id — vérifier statut
router.get('/session/:id', async (req, res) => {
  try {
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.retrieve(req.params.id);
    res.json({
      status: session.payment_status,
      customer_email: session.customer_email,
      amount_total: session.amount_total,
      currency: session.currency,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/v1/stripe/webhook
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig     = req.headers['stripe-signature'];
  const secret  = process.env.STRIPE_WEBHOOK_SECRET;

  try {
    const stripe = getStripe();
    let event;
    if (secret && sig) {
      event = stripe.webhooks.constructEvent(req.rawBody || req.body, sig, secret);
    } else {
      event = JSON.parse(req.body);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      logger.info('[Stripe] Paiement confirmé: ' + session.id + ' ' + session.customer_email);
      // Ici: activer l'eSIM via Transatel
    }

    res.json({ received: true });
  } catch(e) {
    logger.error('[Stripe] Webhook: ' + e.message);
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
