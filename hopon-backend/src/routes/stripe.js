'use strict';
const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY non configuree dans Railway Variables');
  return require('stripe')(key);
}

router.post('/create-session', async (req, res) => {
  try {
    const stripe = getStripe();
    const { email, name, phone, product, amount, currency, success_url, cancel_url } = req.body;
    if (!email || !amount) return res.status(400).json({ error: 'email et amount requis' });
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: email,
      metadata: { name: name || '', phone: phone || '', product: product || 'eSIM hopOn' },
      line_items: [{ price_data: {
        currency: currency || 'eur',
        unit_amount: amount,
        product_data: { name: product || 'eSIM hopOn', description: 'Activation instantanee - QR code par email' }
      }, quantity: 1 }],
      success_url: success_url || (process.env.SITE_URL || 'https://hopon.fr') + '/merci.html?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: cancel_url || (process.env.SITE_URL || 'https://hopon.fr'),
    });
    logger.info('[Stripe] Session: ' + session.id + ' ' + (amount/100) + 'EUR ' + email);
    res.json({ sessionId: session.id, url: session.url });
  } catch (e) {
    logger.error('[Stripe] ' + e.message);
    if (e.message.includes('STRIPE_SECRET_KEY')) return res.status(503).json({ error: 'Stripe non configure. Ajoutez STRIPE_SECRET_KEY dans Railway.' });
    res.status(500).json({ error: e.message });
  }
});

router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    const stripe = getStripe();
    event = secret ? stripe.webhooks.constructEvent(req.rawBody || req.body, sig, secret) : JSON.parse(req.body.toString());
  } catch (e) { return res.status(400).json({ error: e.message }); }
  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    logger.info('[Stripe] Paye: ' + s.id + ' ' + s.customer_email);
  }
  res.json({ received: true });
});

module.exports = router;
