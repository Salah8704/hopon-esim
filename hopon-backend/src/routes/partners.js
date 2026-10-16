'use strict';
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');
const { z } = require('zod');
const { db } = require('../db/pool');
const logger = require('../utils/logger');
const router = express.Router();

const JWT_SECRET = process.env.PARTNER_JWT_SECRET || process.env.ADMIN_JWT_SECRET || 'hopon-dev-partner-secret-change-me';
const SITE_URL = (process.env.SITE_URL || 'https://hopon.fr').replace(/\/$/, '');
const registerSchema = z.object({
  first_name: z.string().trim().min(2).max(100), last_name: z.string().trim().min(2).max(100),
  email: z.string().email().max(200).transform(v => v.toLowerCase()),
  phone: z.string().trim().max(30).optional().default(''), business_name: z.string().trim().max(200).optional().default(''),
  type: z.enum(['driver', 'host']), password: z.string().min(10).max(128), accept_terms: z.literal(true),
});

function signPartner(p) { return jwt.sign({ sub:p.id, code:p.partner_code, role:'partner' }, JWT_SECRET, { expiresIn:'7d' }); }
function requirePartner(req,res,next) {
  const h=req.headers.authorization||''; const token=h.startsWith('Bearer ')?h.slice(7):null;
  if(!token) return res.status(401).json({error:'Connexion requise'});
  try { const p=jwt.verify(token,JWT_SECRET); if(p.role!=='partner') throw new Error('role'); req.partnerAuth=p; next(); }
  catch(_) { res.status(401).json({error:'Session expirée'}); }
}
async function uniqueCode(type,first,last) {
  const prefix=type==='driver'?'VTC':'HOTE';
  const stem=`${first}-${last}`.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/gi,'').toUpperCase().slice(0,8)||'PARTNER';
  for(let i=0;i<10;i++){const code=`${prefix}-${stem}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;const r=await db.query('SELECT 1 FROM partners WHERE partner_code=$1',[code]);if(!r.rowCount)return code;}
  return `${prefix}-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
}

router.post('/register',async(req,res)=>{
  const parsed=registerSchema.safeParse(req.body||{}); if(!parsed.success)return res.status(400).json({error:'Informations incomplètes ou invalides'});
  const d=parsed.data;
  try{
    if((await db.query('SELECT 1 FROM partners WHERE LOWER(email)=LOWER($1)',[d.email])).rowCount)return res.status(409).json({error:'Un compte existe déjà avec cet e-mail'});
    const code=await uniqueCode(d.type,d.first_name,d.last_name); const hash=await bcrypt.hash(d.password,12);
    const {rows:[p]}=await db.query(`INSERT INTO partners (partner_code,name,business_name,type,email,phone,password_hash,status,commission_pct)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',0) RETURNING id,partner_code,name,business_name,type,email,phone,status,created_at`,
      [code,`${d.first_name} ${d.last_name}`,d.business_name||null,d.type,d.email,d.phone||null,hash]);
    res.status(201).json({message:'Demande reçue. Votre compte sera activé après validation HopOn.',token:signPartner(p),partner:p});
  }catch(e){logger.error(`[Partners] register: ${e.message}`);res.status(500).json({error:'Impossible de créer le compte pour le moment'});}
});

router.post('/login',async(req,res)=>{
  const email=String(req.body?.email||'').trim().toLowerCase(), password=String(req.body?.password||'');
  if(!email||!password)return res.status(400).json({error:'E-mail et mot de passe requis'});
  try{const {rows:[p]}=await db.query('SELECT * FROM partners WHERE LOWER(email)=LOWER($1)',[email]);
    if(!p?.password_hash||!(await bcrypt.compare(password,p.password_hash)))return res.status(401).json({error:'Identifiants incorrects'});
    if(['suspended','terminated'].includes(p.status))return res.status(403).json({error:'Compte indisponible. Contactez HopOn.'});
    res.json({token:signPartner(p),partner:sanitize(p)});
  }catch(e){logger.error(`[Partners] login: ${e.message}`);res.status(500).json({error:'Connexion momentanément indisponible'});}
});

router.get('/me',requirePartner,async(req,res)=>{
  try{const p=await getPartner(req.partnerAuth.sub);if(!p)return res.status(404).json({error:'Compte introuvable'});
    res.json({partner:sanitize(p),stats:await getStats(p.id),referral_url:trackedUrl(p.partner_code,p.type==='driver'?'link_vehicle':'link_accommodation'),poster_available:p.status==='active'});
  }catch(_){res.status(500).json({error:'Impossible de charger le tableau de bord'});}
});

router.get('/sales',requirePartner,async(req,res)=>{const {rows}=await db.query(`SELECT id,country_iso2,sale_amount,commission_amount,currency,status,source,created_at
  FROM partner_referrals WHERE partner_id=$1 ORDER BY created_at DESC LIMIT 100`,[req.partnerAuth.sub]);res.json({sales:rows});});

router.get('/poster.pdf',requirePartner,async(req,res)=>{
  try{const p=await getPartner(req.partnerAuth.sub);if(!p||p.status!=='active')return res.status(403).json({error:'Affiche disponible après validation du compte'});
    const source=p.type==='driver'?'qr_vehicle':'qr_accommodation',url=trackedUrl(p.partner_code,source);
    const data=await QRCode.toDataURL(url,{width:900,margin:2,color:{dark:'#071A34',light:'#FFFFFF'}}),qr=Buffer.from(data.split(',')[1],'base64');
    res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition',`attachment; filename="HopOn-${p.type==='driver'?'vehicule':'hebergement'}-${p.partner_code}.pdf"`);
    const doc=new PDFDocument({size:'A4',margin:0,info:{Title:'Affiche partenaire HopOn'}});doc.pipe(res);
    doc.rect(0,0,595.28,841.89).fill('#071A34');doc.circle(540,70,180).fill('#0E4F8A');doc.circle(60,790,145).fill('#F28C28');
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(36).text('hop',48,42,{continued:true});doc.fillColor('#F28C28').text('On');
    doc.fillColor('#FFFFFF').fontSize(31).text(p.type==='driver'?'Internet pendant votre trajet ?':'Internet pendant votre séjour ?',48,145,{width:500,align:'center'});
    doc.fillColor('#C8D8EA').font('Helvetica').fontSize(16).text(p.type==='driver'?'Scannez et installez votre eSIM en quelques minutes. Internet dès votre arrivée.':'Plus de 190 destinations. 100 % digital. Scannez pour choisir votre eSIM.',65,235,{width:465,align:'center',lineGap:5});
    doc.roundedRect(142,335,311,311,24).fill('#FFFFFF');doc.image(qr,166,359,{width:263,height:263});
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(18).text('Scannez pour choisir votre eSIM',70,685,{width:455,align:'center'});
    doc.fillColor('#C8D8EA').font('Helvetica').fontSize(11).text(`Code partenaire : ${p.partner_code}`,70,722,{width:455,align:'center'});
    doc.fillColor('#071A34').font('Helvetica-Bold').fontSize(12).text('hopon.fr · eSIM de voyage',70,802,{width:455,align:'center'});doc.end();
  }catch(e){logger.error(`[Partners] poster: ${e.message}`);if(!res.headersSent)res.status(500).json({error:'Impossible de générer l’affiche'});}
});

router.post('/track',async(req,res)=>{
  try{const code=String(req.body?.partner_code||req.body?.partner_id||'').trim().toUpperCase();if(!code||req.body?.event!=='visit')return res.status(400).json({error:'Événement invalide'});
    const {rows:[p]}=await db.query('SELECT id,status FROM partners WHERE partner_code=$1',[code]);if(!p||p.status!=='active')return res.json({tracked:false});
    await db.query('INSERT INTO partner_clicks (partner_id,source,page,ip_hash,user_agent) VALUES ($1,$2,$3,$4,$5)',[p.id,normalizeSource(req.body?.source),String(req.body?.page||'').slice(0,200),hashIp(req.ip),String(req.headers['user-agent']||'').slice(0,200)]);res.json({tracked:true});
  }catch(e){logger.error(`[Partners] track: ${e.message}`);res.status(200).json({tracked:false});}
});

async function getPartner(id){const {rows}=await db.query('SELECT * FROM partners WHERE id=$1',[id]);return rows[0]||null;}
async function getStats(id){const {rows:[t]}=await db.query(`SELECT COUNT(*)::int sales,COALESCE(SUM(commission_amount) FILTER (WHERE status IN ('pending','validated','paid')),0) commission_total,COALESCE(SUM(commission_amount) FILTER (WHERE status='paid'),0) commission_paid,COALESCE(SUM(commission_amount) FILTER (WHERE status IN ('pending','validated')),0) commission_due FROM partner_referrals WHERE partner_id=$1`,[id]);const {rows:[c]}=await db.query('SELECT COUNT(*)::int clicks FROM partner_clicks WHERE partner_id=$1',[id]);return{...t,clicks:c.clicks};}
function trackedUrl(code,source){return `${SITE_URL}/?ref=${encodeURIComponent(code)}&utm_source=partner&utm_medium=qr&utm_campaign=${encodeURIComponent(source)}`;}
function normalizeSource(v){const s=String(v||'link').toLowerCase();return ['qr_vehicle','qr_accommodation','link_vehicle','link_accommodation'].includes(s)?s:'link';}
function sanitize(p){const {password_hash,payment_details,notes,...safe}=p;return safe;}
function hashIp(ip){return ip?crypto.createHash('sha256').update(`${process.env.IP_HASH_SALT||'hopon'}:${ip}`).digest('hex').slice(0,32):null;}
module.exports=router; module.exports.requirePartner=requirePartner;
