'use strict';
const express = require('express');
const emailSvc = require('../services/email');

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const { first_name, last_name, email, subject, message } = req.body || {};
    if (!first_name || !email || !message) {
      return res.status(400).json({ error: 'Prénom, email et message sont requis' });
    }
    if (!/.+@.+\..+/.test(email)) {
      return res.status(400).json({ error: 'Email invalide' });
    }

    await emailSvc.sendContactMessage({
      firstName: String(first_name).trim(),
      lastName: String(last_name || '').trim(),
      fromEmail: String(email).trim(),
      subject: String(subject || 'Demande générale').trim(),
      message: String(message).trim(),
    });

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
