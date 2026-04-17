'use strict';
/**
 * HopOn — Service Email Premium
 * Templates adaptés par destination — "Bienvenue au Maroc, votre eSIM est prête"
 */

const nodemailer = require('nodemailer');
const QRCode     = require('qrcode');
const { db }     = require('../db/pool');
const logger     = require('../utils/logger');

// ─── Transport SMTP / Brevo ───────────────────────────────────────
let _transport;
function getTransport() {
  if (_transport) return _transport;
  _transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp-relay.brevo.com',
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.BREVO_API_KEY || process.env.SMTP_PASS,
    },
  });
  return _transport;
}

const FROM = `"${process.env.EMAIL_FROM_NAME || 'hopOn'}" <${process.env.EMAIL_FROM_ADDRESS || 'contact@hopon.fr'}>`;

// ─── Messages de bienvenue par pays ──────────────────────────────
const COUNTRY_MESSAGES = {
  JP: { welcome: 'Bienvenue au Japon',        emoji: '🇯🇵', phrase: 'Irasshaimase',        tagline: 'Tokyo et ses néons vous attendent.' },
  MA: { welcome: 'Bienvenue au Maroc',         emoji: '🇲🇦', phrase: 'Ahlan wa sahlan',    tagline: 'Le désert, les médinas et le thé à la menthe vous accueillent.' },
  TH: { welcome: 'Bienvenue en Thaïlande',     emoji: '🇹🇭', phrase: 'Sawasdee kha',       tagline: 'Les temples et les plages de turquoise vous attendent.' },
  US: { welcome: 'Bienvenue aux États-Unis',   emoji: '🇺🇸', phrase: 'Welcome!',            tagline: 'De Manhattan aux Grand Canyons, l\'Amérique est à vous.' },
  IT: { welcome: 'Bienvenue en Italie',        emoji: '🇮🇹', phrase: 'Benvenuto',           tagline: 'La dolce vita vous attend entre Rome, Venise et la Toscane.' },
  AU: { welcome: 'Bienvenue en Australie',     emoji: '🇦🇺', phrase: "G'day mate!",         tagline: 'Le bush, les plages et l\'outback n\'attendent que vous.' },
  AE: { welcome: 'Bienvenue aux Émirats',      emoji: '🇦🇪', phrase: 'Ahlan',               tagline: 'Dubaï et Abu Dhabi vous ouvrent leurs portes dorées.' },
  ES: { welcome: 'Bienvenue en Espagne',       emoji: '🇪🇸', phrase: 'Bienvenido',          tagline: 'Barcelona, Madrid et les Baléares, tout commence ici.' },
  BR: { welcome: 'Bienvenue au Brésil',        emoji: '🇧🇷', phrase: 'Bem-vindo',           tagline: 'La forêt amazonienne, Rio et la samba vous attendent.' },
  MX: { welcome: 'Bienvenue au Mexique',       emoji: '🇲🇽', phrase: 'Bienvenido',          tagline: 'Cancún, Mexico City et Oaxaca vous accueillent.' },
  SN: { welcome: 'Bienvenue au Sénégal',       emoji: '🇸🇳', phrase: 'Nanga def',           tagline: 'Dakar, ses plages et son hospitalité légendaire.' },
  TR: { welcome: 'Bienvenue en Turquie',       emoji: '🇹🇷', phrase: 'Hoş geldiniz',        tagline: 'Istanbul, la Cappadoce et la mer Égée vous attendent.' },
  DEFAULT: { welcome: 'Votre eSIM hopOn est prête', emoji: '✈️', phrase: 'Bon voyage', tagline: 'Restez connecté partout dans le monde.' },
};

function getCountryMsg(iso2) {
  return COUNTRY_MESSAGES[iso2?.toUpperCase()] || COUNTRY_MESSAGES.DEFAULT;
}

// ─── Générer QR code base64 depuis activation code ───────────────
async function generateQrCodeBase64(activationCode) {
  if (!activationCode) return null;
  try {
    return await QRCode.toDataURL(activationCode, {
      width: 256, margin: 2,
      color: { dark: '#07090f', light: '#ffffff' },
    });
  } catch (e) {
    logger.warn(`[Email] Erreur génération QR code: ${e.message}`);
    return null;
  }
}

// ─── Template email livraison eSIM ────────────────────────────────
async function buildDeliveryEmail({
  customerName, country, product, activationCode, qrCodeUrl, qrCodeData, orderNumber
}) {
  const msg       = getCountryMsg(country?.iso2);
  const name      = customerName || 'cher voyageur';
  const firstName = name.split(' ')[0];
  const qrBase64  = qrCodeData
    ? `data:image/png;base64,${qrCodeData}`
    : await generateQrCodeBase64(activationCode);

  const durationLabel = product?.duration_days ? `${product.duration_days} jours` : 'votre séjour';
  const dataLabel     = product?.is_unlimited ? 'Data illimitée' : product?.data_amount_mb ? `${Math.round(product.data_amount_mb / 1024)} GB` : '';

  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width">
<title>${msg.welcome} — hopOn eSIM</title>
<style>
  body{margin:0;padding:0;background:#f5f5f0;font-family:'Helvetica Neue',Arial,sans-serif;color:#1a1a1a}
  .wrap{max-width:600px;margin:0 auto;background:#ffffff}
  .header{background:#07090f;padding:32px 40px;text-align:center}
  .logo{height:36px}
  .hero{padding:48px 40px;background:linear-gradient(135deg,#07090f,#1a2540);text-align:center;color:#fff}
  .flag{font-size:52px;display:block;margin-bottom:16px}
  .welcome{font-size:28px;font-weight:300;margin:0 0 8px;letter-spacing:-.5px}
  .phrase{font-size:15px;color:rgba(255,255,255,.55);margin:0 0 20px;font-style:italic}
  .tagline{font-size:15px;color:rgba(255,255,255,.7);max-width:400px;margin:0 auto;line-height:1.6}
  .body{padding:40px}
  .greeting{font-size:18px;margin-bottom:24px}
  .esim-box{background:#f8f7f3;border-radius:16px;padding:32px;margin:28px 0;text-align:center}
  .esim-box h2{font-size:16px;color:#666;font-weight:400;margin:0 0 20px;text-transform:uppercase;letter-spacing:1px}
  .qr-wrap{background:#fff;border-radius:12px;padding:20px;display:inline-block;margin-bottom:20px;box-shadow:0 2px 12px rgba(0,0,0,.08)}
  .qr-wrap img{width:180px;height:180px;display:block}
  .act-code-label{font-size:13px;color:#888;margin-bottom:8px}
  .act-code{background:#07090f;color:#F5A020;font-family:monospace;font-size:14px;padding:12px 20px;border-radius:8px;letter-spacing:3px;display:inline-block;word-break:break-all}
  .steps-title{font-size:17px;font-weight:600;margin:32px 0 16px}
  .step{display:flex;align-items:flex-start;gap:14px;margin-bottom:16px}
  .step-num{background:#F5A020;color:#07090f;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;flex-shrink:0;margin-top:2px}
  .step-text{flex:1}
  .step-title{font-weight:600;margin-bottom:3px}
  .step-sub{font-size:14px;color:#666;line-height:1.5}
  .highlight{background:#fffbf0;border-left:3px solid #F5A020;padding:14px 18px;border-radius:0 8px 8px 0;margin:24px 0;font-size:14px;line-height:1.6}
  .support{background:#f8f7f3;border-radius:12px;padding:24px;margin-top:32px;text-align:center}
  .footer{background:#07090f;padding:28px 40px;text-align:center;color:rgba(255,255,255,.4);font-size:12px}
  .footer a{color:#F5A020;text-decoration:none}
  @media(max-width:480px){.body,.header,.hero{padding:24px 20px}.welcome{font-size:22px}}
</style></head>
<body>
<div class="wrap">
  <div class="header">
    <span style="font-family:Arial,sans-serif;font-size:26px;font-weight:700;color:#1E8FD6">hop<span style="color:#F5A020">On</span></span>
  </div>

  <div class="hero">
    <span class="flag">${msg.emoji}</span>
    <h1 class="welcome">${msg.welcome}</h1>
    <p class="phrase">"${msg.phrase}"</p>
    <p class="tagline">${msg.tagline}</p>
  </div>

  <div class="body">
    <p class="greeting">Bonjour ${firstName},</p>
    <p style="font-size:15px;line-height:1.7;color:#444;margin-bottom:24px">
      Votre eSIM hopOn est prête. Installez-la maintenant depuis chez vous — elle s'activera automatiquement à votre arrivée à destination.
      <strong>Aucune manipulation nécessaire à l'aéroport.</strong>
    </p>

    <div class="esim-box">
      <h2>Votre eSIM hopOn</h2>
      ${qrBase64 || qrCodeUrl ? `
      <div class="qr-wrap">
        <img src="${qrBase64 || qrCodeUrl}" alt="QR Code eSIM hopOn" width="180" height="180">
      </div><br>` : ''}
      ${activationCode ? `
      <div class="act-code-label">Code d'activation manuel</div>
      <div class="act-code">${activationCode}</div>` : ''}
      <p style="font-size:13px;color:#888;margin-top:16px">
        Commande ${orderNumber || ''} — ${durationLabel}${dataLabel ? ` · ${dataLabel}` : ''}
      </p>
    </div>

    <div class="highlight">
      ✈️ <strong>Installation avant le départ, activation à l'arrivée</strong><br>
      Vous pouvez installer l'eSIM dès maintenant. Elle sera inactive jusqu'à votre arrivée ${country?.name_fr ? 'en ' + country.name_fr : 'à destination'}. Dès atterrissage, la connexion s'active automatiquement.
    </div>

    <h3 class="steps-title">Comment installer votre eSIM</h3>

    <div class="step">
      <div class="step-num">1</div>
      <div class="step-text">
        <div class="step-title">Ouvrez les Réglages de votre téléphone</div>
        <div class="step-sub">Allez dans <em>Données cellulaires</em> (iPhone) ou <em>Réseau & Internet → SIM</em> (Android)</div>
      </div>
    </div>
    <div class="step">
      <div class="step-num">2</div>
      <div class="step-text">
        <div class="step-title">Scannez le QR code ci-dessus</div>
        <div class="step-sub">Sélectionnez "Ajouter une ligne" puis pointez votre caméra sur le QR code. Si votre caméra ne fonctionne pas, entrez le code manuellement.</div>
      </div>
    </div>
    <div class="step">
      <div class="step-num">3</div>
      <div class="step-text">
        <div class="step-title" style="color:#F5A020">Profitez — la connexion s'active à l'atterrissage</div>
        <div class="step-sub">L'eSIM s'activera automatiquement dès votre arrivée ${country?.name_fr ? 'en ' + country.name_fr : ''}. Aucune action requise.</div>
      </div>
    </div>

    <div class="support">
      <p style="margin:0 0 10px;font-weight:600">Une question ? Nous sommes là.</p>
      <p style="margin:0;font-size:14px;color:#666">
        Répondez à cet email ou contactez-nous à <a href="mailto:contact@hopon.fr" style="color:#1E8FD6">contact@hopon.fr</a><br>
        Support disponible 7j/7 — Réponse sous 2h
      </p>
    </div>
  </div>

  <div class="footer">
    <p>© ${new Date().getFullYear()} hopOn Technologies · <a href="mailto:contact@hopon.fr">contact@hopon.fr</a></p>
    <p style="margin-top:8px;font-size:11px">Vous avez reçu cet email car vous avez effectué un achat sur hopOn.fr</p>
  </div>
</div>
</body></html>`;
}


// ─── Fonctions d'envoi ────────────────────────────────────────────

async function sendEsimDelivery({
  to, customerName, orderId, orderNumber, country, product,
  activationCode, qrCodeUrl, qrCodeData
}) {
  const msg     = getCountryMsg(country?.iso2);
  const subject = `${msg.emoji} ${msg.welcome} — votre eSIM hopOn est prête`;
  const html    = await buildDeliveryEmail({
    customerName, country, product,
    activationCode, qrCodeUrl, qrCodeData, orderNumber
  });

  await _send({ to, subject, html });

  // Log en base
  await db.query(
    `INSERT INTO email_logs (order_id, template, to_email, subject, status)
     VALUES ($1, 'delivery', $2, $3, 'sent')`,
    [orderId, to, subject]
  );

  logger.info(`[Email] Livraison eSIM envoyée à ${to} — ${subject}`);
}

async function sendOrderConfirmation({ to, customerName, orderNumber, productName, amount, currency }) {
  const subject = `hopOn — Confirmation de commande ${orderNumber}`;
  const html    = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"></head><body style="font-family:Arial,sans-serif;background:#f5f5f0">
    <div style="max-width:560px;margin:0 auto;background:#fff;padding:40px">
      <p style="font-size:24px;font-weight:300">Merci pour votre commande&nbsp;!</p>
      <p>Bonjour ${customerName?.split(' ')[0] || ''},</p>
      <p>Votre commande <strong>${orderNumber}</strong> a bien été reçue.</p>
      <table style="width:100%;margin:24px 0;border-collapse:collapse">
        <tr style="background:#f8f7f3"><td style="padding:10px 14px">Forfait</td><td style="padding:10px 14px;text-align:right">${productName}</td></tr>
        <tr><td style="padding:10px 14px">Total</td><td style="padding:10px 14px;text-align:right;font-weight:600;color:#F5A020">${amount} ${currency}</td></tr>
      </table>
      <p>Votre eSIM sera livrée par email dans quelques minutes. Vérifiez vos spams si vous ne la recevez pas.</p>
      <p style="color:#888;font-size:13px">Besoin d'aide ? <a href="mailto:contact@hopon.fr">contact@hopon.fr</a></p>
    </div>
  </body></html>`;

  await _send({ to, subject, html });
  logger.info(`[Email] Confirmation commande envoyée à ${to}`);
}

async function sendAdminAlert({ subject, message, orderId }) {
  const adminEmail = process.env.ADMIN_ALERT_EMAIL || process.env.EMAIL_FROM_ADDRESS || 'contact@hopon.fr';
  const html = `<h3>${subject}</h3><p><strong>Order ID:</strong> ${orderId}</p><p>${message}</p>`;
  await _send({ to: adminEmail, subject: `[ALERT] ${subject}`, html });
}

async function sendContactMessage({ firstName, lastName, fromEmail, subject, message }) {
  const to = process.env.CONTACT_RECEIVER_EMAIL || process.env.EMAIL_FROM_ADDRESS || 'contact@hopon.fr';
  const fullName = [firstName, lastName].filter(Boolean).join(' ').trim() || 'Visiteur';
  const safeSubject = subject || 'Demande générale';
  const html = `
    <h2>Nouveau message depuis hopon.fr</h2>
    <p><strong>Nom:</strong> ${fullName}</p>
    <p><strong>Email:</strong> ${fromEmail}</p>
    <p><strong>Sujet:</strong> ${safeSubject}</p>
    <p><strong>Message:</strong></p>
    <p>${String(message || '').replace(/\n/g, '<br>')}</p>
  `;
  await _send({
    to,
    subject: `[Contact] ${safeSubject}`,
    html
  });
}

async function _send({ to, subject, html }) {
  const transport = getTransport();
  await transport.sendMail({
    from: FROM, to, subject, html,
    replyTo: process.env.EMAIL_REPLY_TO || 'contact@hopon.fr',
  });
}

module.exports = {
  sendEsimDelivery,
  sendOrderConfirmation,
  sendAdminAlert,
  sendContactMessage,
};
