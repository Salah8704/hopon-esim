'use strict';
require('dotenv').config();
const crypto=require('crypto');
const express=require('express');
const cors=require('cors');
const helmet=require('helmet');
const compression=require('compression');
const rateLimit=require('express-rate-limit');
const jwt=require('jsonwebtoken');
const bcrypt=require('bcryptjs');
const Stripe=require('stripe');
const {CronJob}=require('cron');
const db=require('./db');
const transatel=require('./transatel');
const priceImport=require('./price-import');
const simImport=require('./sim-import');
const mailer=require('./mailer');
const countryDirectory=require('./countries');

const app=express();
// Hostinger place l'application derrière son proxy inverse. Cette option
// permet à Express et express-rate-limit d'utiliser correctement l'adresse IP
// transmise par X-Forwarded-For sans déclencher ERR_ERL_UNEXPECTED_X_FORWARDED_FOR.
app.set('trust proxy',1);
const stripe=new Stripe(process.env.STRIPE_SECRET_KEY||'sk_test_placeholder');
const origins=String(process.env.CORS_ORIGINS||process.env.FRONTEND_URL||'https://hopon.fr').split(',').map(v=>v.trim()).filter(Boolean);
const frontend=String(process.env.FRONTEND_URL||'https://hopon.fr').replace(/\/$/,'');
const rechargeLimiter=rateLimit({windowMs:15*60*1000,max:Number(process.env.RECHARGE_RATE_LIMIT_MAX||5),standardHeaders:true,legacyHeaders:false});
let runtimeReady;
let workersStarted=false;

// Une promesse partagée évite de lancer plusieurs migrations en parallèle et
// fait attendre les requêtes jusqu'à ce que le schéma MySQL soit prêt.
function ensureRuntime(){
  if(!runtimeReady)runtimeReady=initializeRuntime();
  return runtimeReady;
}

app.use(helmet({contentSecurityPolicy:false}));app.use(compression());app.use(cors({origin:(origin,cb)=>!origin||origins.includes(origin)?cb(null,true):cb(new Error('Origine non autorisée'))}));app.use(rateLimit({windowMs:60000,max:Number(process.env.RATE_LIMIT_MAX||120)}));
app.use((req,_res,next)=>ensureRuntime().then(()=>next()).catch(next));

// Stripe exige le corps brut pour vérifier que le paiement vient réellement de Stripe.
app.post('/api/stripe/webhook',express.raw({type:'application/json'}),stripeWebhook);
app.use(express.json({limit:'1mb'}));

const asyncRoute=handler=>(req,res,next)=>Promise.resolve(handler(req,res,next)).catch(next);
const adminOnly=(req,res,next)=>{try{const token=String(req.headers.authorization||'').replace(/^Bearer\s+/,'');const payload=jwt.verify(token,process.env.JWT_SECRET);if(payload.role!=='admin')throw new Error();req.admin=payload;next();}catch(_){res.status(401).json({error:'Session administrateur invalide'});}};
const partners=require('./partners')({db,adminOnly,frontend});
app.use('/api/partners',partners);

async function recordPartnerReferral(partnerCode,orderId,amount,currency,country,partnerSource,stripeSessionId){
  const partner=await partners.resolve(partnerCode);if(!partner)return;
  const commissionAmount=partners.commission(partner,amount);
  await db.query(`INSERT IGNORE INTO partner_referrals(id,partner_id,order_id,country_iso2,sale_amount,commission_pct,commission_amount,currency,status,source,stripe_session_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,[crypto.randomUUID(),partner.id,orderId,country,Number(amount),Number(partner.commission_pct||0),commissionAmount,String(currency||'EUR').toUpperCase(),'pending',partners.source(partnerSource),stripeSessionId]);
  await db.query('UPDATE orders SET partner_id=?,partner_source=? WHERE id=?',[partner.id,partners.source(partnerSource),orderId]);
}

const supportedLanguages=new Set(['fr','en','de','it','es']);
const stripeLocales={fr:'fr',en:'en',de:'de',it:'it',es:'es'};
const languageLocale={fr:'fr-FR',en:'en-GB',de:'de-DE',it:'it-IT',es:'es-ES'};
const languageOf=value=>{const language=String(value||'').trim().toLowerCase().split(/[-_]/)[0];return supportedLanguages.has(language)?language:'fr';};
const requestLanguage=req=>languageOf(req.body?.language||req.headers['x-hopon-language']||req.query?.lang);
const messages={
  fr:{unlimited:'Données illimitées',duration:'Durée selon activation',days:'jours',prepaid:'Prépayée',noRenewal:'Sans renouvellement',buyInvoice:'Achat d’une eSIM prépayée HopOn',rechargeInvoice:'Recharge d’une eSIM HopOn',rechargePrefix:'Recharge',rechargeDescription:'Ajouté à votre eSIM existante · aucun nouveau QR code',invalidCheckout:'Nom, forfait et adresse email valides requis',compatibility:'Confirmez que votre téléphone est compatible eSIM et déverrouillé',consent:'Acceptez les conditions et la fourniture immédiate avant le paiement',unavailable:'Ce forfait n’est plus disponible',invalidPrice:'Le prix TTC du forfait est invalide',invalidPayment:'Référence de paiement invalide',invalidEmail:'Adresse email invalide',codeSent:'Si cette adresse correspond à une eSIM HopOn, un code vient d’être envoyé.',invalidCode:'Code invalide ou expiré',expired:'Vérification expirée. Recommencez avec votre adresse email.',esimUnavailable:'Cette eSIM n’est plus disponible pour une recharge',travel:'voyage'},
  en:{unlimited:'Unlimited data',duration:'Duration starts on activation',days:'days',prepaid:'Prepaid',noRenewal:'No automatic renewal',buyInvoice:'Purchase of a prepaid HopOn eSIM',rechargeInvoice:'HopOn eSIM top-up',rechargePrefix:'Top-up',rechargeDescription:'Added to your existing eSIM · no new QR code',invalidCheckout:'A valid name, plan and email address are required',compatibility:'Confirm that your phone supports eSIM and is unlocked',consent:'Accept the terms and immediate supply before payment',unavailable:'This plan is no longer available',invalidPrice:'The plan price is invalid',invalidPayment:'Invalid payment reference',invalidEmail:'Invalid email address',codeSent:'If this address matches a HopOn eSIM, a code has just been sent.',invalidCode:'Invalid or expired code',expired:'Verification expired. Start again with your email address.',esimUnavailable:'This eSIM is no longer available for a top-up',travel:'travel'},
  de:{unlimited:'Unbegrenztes Datenvolumen',duration:'Laufzeit ab Aktivierung',days:'Tage',prepaid:'Prepaid',noRenewal:'Keine automatische Verlängerung',buyInvoice:'Kauf einer Prepaid-eSIM von HopOn',rechargeInvoice:'Aufladung einer HopOn eSIM',rechargePrefix:'Aufladung',rechargeDescription:'Wird Ihrer bestehenden eSIM hinzugefügt · kein neuer QR-Code',invalidCheckout:'Gültiger Name, Tarif und gültige E-Mail-Adresse erforderlich',compatibility:'Bestätigen Sie, dass Ihr Telefon eSIM-fähig und entsperrt ist',consent:'Akzeptieren Sie vor der Zahlung die Bedingungen und die sofortige Bereitstellung',unavailable:'Dieser Tarif ist nicht mehr verfügbar',invalidPrice:'Der Preis des Tarifs ist ungültig',invalidPayment:'Ungültige Zahlungsreferenz',invalidEmail:'Ungültige E-Mail-Adresse',codeSent:'Wenn diese Adresse zu einer HopOn eSIM gehört, wurde soeben ein Code gesendet.',invalidCode:'Ungültiger oder abgelaufener Code',expired:'Die Überprüfung ist abgelaufen. Beginnen Sie erneut mit Ihrer E-Mail-Adresse.',esimUnavailable:'Diese eSIM kann nicht mehr aufgeladen werden',travel:'Reise'},
  it:{unlimited:'Dati illimitati',duration:'Durata dall’attivazione',days:'giorni',prepaid:'Prepagata',noRenewal:'Nessun rinnovo automatico',buyInvoice:'Acquisto di una eSIM prepagata HopOn',rechargeInvoice:'Ricarica di una eSIM HopOn',rechargePrefix:'Ricarica',rechargeDescription:'Aggiunta alla tua eSIM esistente · nessun nuovo codice QR',invalidCheckout:'Sono necessari nome, piano e indirizzo email validi',compatibility:'Conferma che il telefono supporti eSIM e sia sbloccato',consent:'Accetta le condizioni e la fornitura immediata prima del pagamento',unavailable:'Questo piano non è più disponibile',invalidPrice:'Il prezzo del piano non è valido',invalidPayment:'Riferimento di pagamento non valido',invalidEmail:'Indirizzo email non valido',codeSent:'Se questo indirizzo corrisponde a una eSIM HopOn, è stato appena inviato un codice.',invalidCode:'Codice non valido o scaduto',expired:'La verifica è scaduta. Ricomincia con il tuo indirizzo email.',esimUnavailable:'Questa eSIM non è più disponibile per una ricarica',travel:'viaggio'},
  es:{unlimited:'Datos ilimitados',duration:'Duración desde la activación',days:'días',prepaid:'Prepago',noRenewal:'Sin renovación automática',buyInvoice:'Compra de una eSIM prepago HopOn',rechargeInvoice:'Recarga de una eSIM HopOn',rechargePrefix:'Recarga',rechargeDescription:'Se añade a tu eSIM actual · sin nuevo código QR',invalidCheckout:'Se requiere un nombre, un plan y un correo electrónico válidos',compatibility:'Confirma que tu teléfono sea compatible con eSIM y esté desbloqueado',consent:'Acepta las condiciones y el suministro inmediato antes del pago',unavailable:'Este plan ya no está disponible',invalidPrice:'El precio del plan no es válido',invalidPayment:'Referencia de pago no válida',invalidEmail:'Dirección de correo electrónico no válida',codeSent:'Si esta dirección corresponde a una eSIM HopOn, se acaba de enviar un código.',invalidCode:'Código no válido o caducado',expired:'La verificación ha caducado. Empieza de nuevo con tu correo electrónico.',esimUnavailable:'Esta eSIM ya no está disponible para recargar',travel:'viaje'}
};
Object.assign(messages.fr,{invalidCart:'Ajoutez entre 1 et 10 eSIM avec un nom et une adresse email valides pour chaque voyageur.',mixedCurrency:'Tous les forfaits du panier doivent utiliser la même devise.'});
Object.assign(messages.en,{invalidCart:'Add between 1 and 10 eSIMs with a valid name and email address for each traveller.',mixedCurrency:'All plans in the cart must use the same currency.'});
Object.assign(messages.de,{invalidCart:'Fügen Sie 1 bis 10 eSIMs mit gültigem Namen und gültiger E-Mail-Adresse für jeden Reisenden hinzu.',mixedCurrency:'Alle Tarife im Warenkorb müssen dieselbe Währung verwenden.'});
Object.assign(messages.it,{invalidCart:'Aggiungi da 1 a 10 eSIM con nome e indirizzo email validi per ogni viaggiatore.',mixedCurrency:'Tutti i piani nel carrello devono utilizzare la stessa valuta.'});
Object.assign(messages.es,{invalidCart:'Añade entre 1 y 10 eSIM con un nombre y un correo válidos para cada viajero.',mixedCurrency:'Todos los planes del carrito deben utilizar la misma moneda.'});
const msg=(language,key)=>messages[languageOf(language)][key]||messages.fr[key];
function countryName(iso2,fallback,language='fr'){
  const lang=languageOf(language);
  if(lang==='fr')return countryDirectory.nameFr(iso2,fallback);
  try{return new Intl.DisplayNames([languageLocale[lang]],{type:'region'}).of(String(iso2||'').toUpperCase())||fallback||iso2;}catch(_){return countryDirectory.nameEn(iso2,fallback)||fallback||iso2;}
}

function formatData(mb,language='fr'){
  const lang=languageOf(language);
  const value=Number(mb);
  if(!Number.isFinite(value)||value<=0)return msg(lang,'unlimited');
  const unit=value>=1024?(lang==='fr'?'Go':'GB'):(lang==='fr'?'Mo':'MB');
  const amount=value>=1024?Number((value/1024).toFixed(1)):value;
  return `${amount.toLocaleString(languageLocale[lang])} ${unit}`;
}
function publicProduct(product,language='fr'){
  const lang=languageOf(language);
  const country=countryName(product.country_iso2,product.country_name||product.name_fr,lang);
  const duration=Number(product.duration_days)>0?`${Number(product.duration_days)} ${msg(lang,'days')}`:msg(lang,'duration');
  const data=formatData(product.data_amount_mb,lang);
  return {...product,country_name:country,display_name:`eSIM ${country} - ${data}`,display_details:`${duration} · ${msg(lang,'prepaid')} · ${msg(lang,'noRenewal')}`};
}
const validEmail=email=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const parseJson=value=>{if(value&&typeof value==='object')return value;try{return JSON.parse(String(value||''));}catch(_){return null;}};
const termsVersion='2026-09-13';
const acceptedFlag=value=>value===true||value==='true'||value==='on';
const consentMetadata=()=>({terms_version:termsVersion,terms_accepted:'yes',immediate_delivery_consent:'yes',consent_timestamp:new Date().toISOString()});
const rechargeSecret=()=>String(process.env.JWT_SECRET||'');
const rechargeCodeHash=(id,email,code)=>crypto.createHmac('sha256',rechargeSecret()).update(`${id}|${email}|${code}`).digest('hex');
const safeEqual=(left,right)=>{const a=Buffer.from(String(left)),b=Buffer.from(String(right));return a.length===b.length&&crypto.timingSafeEqual(a,b);};
function rechargeIdentity(req){
  const token=String(req.headers.authorization||'').replace(/^Bearer\s+/, '')||String(req.body?.recharge_token||'');
  const payload=jwt.verify(token,rechargeSecret());
  if(payload.scope!=='recharge'||!validEmail(payload.email))throw new Error('invalid');
  return payload;
}

app.get('/health',asyncRoute(async(_req,res)=>{await db.query('SELECT 1');res.json({status:'ok',service:'hopon-api'});}));

app.get('/api/catalog/countries',asyncRoute(async(req,res)=>{const lang=requestLanguage(req);const result=await db.query(`SELECT c.iso2,c.name_fr,c.flag_emoji,COUNT(p.id) product_count,MIN(p.selling_price_ttc) price_from FROM countries c JOIN products p ON p.country_iso2=c.iso2 AND p.is_published=TRUE AND p.selling_price_ht IS NOT NULL WHERE c.is_active=TRUE GROUP BY c.iso2,c.name_fr,c.flag_emoji ORDER BY c.sort_order,c.name_fr`);res.json(result.rows.map(country=>({...country,name_fr:countryDirectory.nameFr(country.iso2,country.name_fr),name:countryName(country.iso2,country.name_fr,lang),flag_emoji:countryDirectory.flag(country.iso2,country.flag_emoji)})).sort((a,b)=>a.name.localeCompare(b.name,languageLocale[lang])));}));
app.get('/api/catalog/products',asyncRoute(async(req,res)=>{const lang=requestLanguage(req);const country=String(req.query.country||'').trim().toUpperCase();let sql=`SELECT p.id,p.country_iso2,p.name,p.description,p.data_amount_mb,p.duration_days,p.currency,p.selling_price_ttc,c.name_fr country_name FROM products p LEFT JOIN countries c ON c.iso2=p.country_iso2 WHERE p.is_published=TRUE AND p.selling_price_ht IS NOT NULL`;const params=[];if(country){sql+=` AND p.country_iso2=?`;params.push(country);}sql+=` ORDER BY p.selling_price_ttc`;const result=await db.query(sql,params);res.json(result.rows.map(product=>publicProduct(product,lang)));}));

app.post('/api/checkout/session',asyncRoute(async(req,res)=>{
  const lang=requestLanguage(req);const payerEmail=String(req.body.payer_email||req.body.email||'').trim().toLowerCase();const payerName=String(req.body.payer_name||req.body.name||'').trim().slice(0,180);const compatible=acceptedFlag(req.body.esim_compatible);const termsAccepted=acceptedFlag(req.body.terms_accepted);const immediateConsent=acceptedFlag(req.body.immediate_delivery_consent);
  const sourceItems=Array.isArray(req.body.items)?req.body.items:[{product_id:req.body.product_id,recipient_name:req.body.name,recipient_email:req.body.email}];
  const items=sourceItems.map(item=>({product_id:String(item?.product_id||'').trim(),recipient_name:String(item?.recipient_name||'').trim().slice(0,180),recipient_email:String(item?.recipient_email||'').trim().toLowerCase()}));
  if(!validEmail(payerEmail)||payerName.length<2||items.length<1||items.length>10||items.some(item=>!item.product_id||item.recipient_name.length<2||!validEmail(item.recipient_email)))return res.status(400).json({error:msg(lang,'invalidCart')});
  if(!compatible)return res.status(400).json({error:msg(lang,'compatibility')});
  if(!termsAccepted||!immediateConsent)return res.status(400).json({error:msg(lang,'consent')});
  const productIds=[...new Set(items.map(item=>item.product_id))],placeholders=productIds.map(()=>'?').join(',');
  const products=(await db.query(`SELECT p.*,c.name_fr country_name FROM products p LEFT JOIN countries c ON c.iso2=p.country_iso2 WHERE p.id IN (${placeholders}) AND p.is_published=TRUE AND p.selling_price_ht IS NOT NULL`,productIds)).rows;
  if(products.length!==productIds.length)return res.status(404).json({error:msg(lang,'unavailable')});
  const productMap=new Map(products.map(product=>[String(product.id),product]));
  const snapshots=items.map((item,index)=>{const product=productMap.get(item.product_id),display=publicProduct(product,lang),unitAmount=Math.round(Number(product.selling_price_ttc)*100);return {...item,item_index:index,unit_amount:unitAmount,currency:String(product.currency||'EUR').toUpperCase(),display_name:display.display_name,display_details:display.display_details,country_iso2:product.country_iso2,purchase_price_ht:product.purchase_price_ht,selling_price_ht:product.selling_price_ht,vat_rate:product.vat_rate,vat_amount:product.vat_amount,total_ttc:product.selling_price_ttc};});
  if(snapshots.some(item=>item.unit_amount<50))return res.status(400).json({error:msg(lang,'invalidPrice')});
  const currencies=[...new Set(snapshots.map(item=>item.currency))];if(currencies.length!==1)return res.status(400).json({error:msg(lang,'mixedCurrency')});
  const partner=await partners.resolve(req.body.partner_code),partnerCode=partner?partner.partner_code:null,partnerSource=partners.source(req.body.partner_source);
  const batchId=crypto.randomUUID(),totalCents=snapshots.reduce((sum,item)=>sum+item.unit_amount,0),acceptedAt=new Date(),returnRoot=lang==='fr'?`${frontend}/`:`${frontend}/${lang}/`;
  await db.query(`INSERT INTO checkout_batches(id,payer_email,payer_name,language,partner_code,partner_source,items_json,item_count,total_ttc,currency,terms_version,accepted_at,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,[batchId,payerEmail,payerName,lang,partnerCode,partnerSource,snapshots,snapshots.length,totalCents/100,currencies[0],termsVersion,acceptedAt,'pending']);
  try{
    const session=await stripe.checkout.sessions.create({mode:'payment',managed_payments:{enabled:false},locale:stripeLocales[lang],customer_email:payerEmail,customer_creation:'always',billing_address_collection:'required',invoice_creation:{enabled:true,invoice_data:{description:msg(lang,'buyInvoice'),metadata:{checkout_batch_id:batchId,language:lang}}},success_url:`${returnRoot}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,cancel_url:`${returnRoot}?checkout=cancelled`,line_items:snapshots.map(item=>({quantity:1,price_data:{currency:item.currency.toLowerCase(),unit_amount:item.unit_amount,product_data:{name:item.display_name,description:`${item.display_details} · ${item.recipient_name}`}}})),metadata:{order_type:'multi_esim',checkout_batch_id:batchId,item_count:String(snapshots.length),payer_name:payerName,language:lang,partner_code:partnerCode||'',partner_source:partnerSource,...consentMetadata()}});
    await db.query(`UPDATE checkout_batches SET stripe_session_id=?,status='checkout_created' WHERE id=?`,[session.id,batchId]);
    res.json({url:session.url,batch_id:batchId,item_count:snapshots.length});
  }catch(error){await db.query(`UPDATE checkout_batches SET status='failed' WHERE id=?`,[batchId]);throw error;}
}));
app.get('/api/checkout/status',asyncRoute(async(req,res)=>{const lang=requestLanguage(req);const sessionId=String(req.query.session_id||'').trim();if(!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId))return res.status(400).json({error:msg(lang,'invalidPayment')});const orders=(await db.query('SELECT status,failure_reason,order_type,checkout_batch_id,order_number,total_ttc,currency FROM orders WHERE stripe_session_id=? ORDER BY batch_item_index',[sessionId])).rows;if(!orders.length)return res.json({status:'confirming'});const deliveredCount=orders.filter(order=>order.status==='delivered').length,failedCount=orders.filter(order=>order.status==='failed').length,isBatch=orders.length>1||Boolean(orders[0].checkout_batch_id),status=failedCount?'support_required':deliveredCount===orders.length?'delivered':'processing';res.json({status,order_type:isBatch?'multi_esim':orders[0].order_type,item_count:orders.length,delivered_count:deliveredCount,failed_count:failedCount,total_ttc:orders.reduce((sum,order)=>sum+Number(order.total_ttc||0),0),currency:orders[0].currency||'EUR',analytics_reference:orders[0].checkout_batch_id||orders[0].order_number});}));

app.post('/api/recharge/request-code',rechargeLimiter,asyncRoute(async(req,res)=>{
  const lang=requestLanguage(req);const email=String(req.body.email||'').trim().toLowerCase();
  if(!validEmail(email))return res.status(400).json({error:msg(lang,'invalidEmail')});
  const eligible=Number((await db.query(`SELECT COUNT(*) total FROM orders WHERE customer_email=? AND order_type='new_esim' AND status='delivered' AND (esim_profile_id IS NOT NULL OR stripe_livemode=FALSE)`,[email])).rows[0]?.total||0);
  if(eligible&&rechargeSecret()){
    const id=crypto.randomUUID();const code=String(crypto.randomInt(0,1000000)).padStart(6,'0');
    await db.query(`UPDATE recharge_codes SET used_at=NOW() WHERE customer_email=? AND used_at IS NULL`,[email]);
    await db.query(`INSERT INTO recharge_codes(id,customer_email,code_hash,expires_at) VALUES(?,?,?,DATE_ADD(NOW(),INTERVAL 10 MINUTE))`,[id,email,rechargeCodeHash(id,email,code)]);
    try{await mailer.sendRechargeCode(email,code,lang);}catch(error){console.error('[Recharge] échec envoi du code',error.message);}
  }
  res.json({message:msg(lang,'codeSent')});
}));

app.post('/api/recharge/verify-code',rechargeLimiter,asyncRoute(async(req,res)=>{
  const lang=requestLanguage(req);const email=String(req.body.email||'').trim().toLowerCase();const code=String(req.body.code||'').trim();
  if(!validEmail(email)||!/^\d{6}$/.test(code))return res.status(400).json({error:msg(lang,'invalidCode')});
  const record=(await db.query(`SELECT * FROM recharge_codes WHERE customer_email=? AND used_at IS NULL AND expires_at>NOW() AND attempts<5 ORDER BY created_at DESC LIMIT 1`,[email])).rows[0];
  if(!record||!safeEqual(record.code_hash,rechargeCodeHash(record.id,email,code))){if(record)await db.query('UPDATE recharge_codes SET attempts=attempts+1 WHERE id=?',[record.id]);return res.status(400).json({error:msg(lang,'invalidCode')});}
  await db.query('UPDATE recharge_codes SET used_at=NOW() WHERE id=?',[record.id]);
  const rows=(await db.query(`SELECT o.id order_id,o.stripe_livemode,o.customer_name,o.country_iso2,o.created_at,e.id profile_id,e.iccid,c.name_fr country_name FROM orders o LEFT JOIN esim_profiles e ON e.id=o.esim_profile_id LEFT JOIN countries c ON c.iso2=o.country_iso2 WHERE o.customer_email=? AND o.order_type='new_esim' AND o.status='delivered' AND (o.esim_profile_id IS NOT NULL OR o.stripe_livemode=FALSE) ORDER BY o.created_at DESC`,[email])).rows;
  const seen=new Set();const esims=[];
  for(const row of rows){const id=row.profile_id||`test:${row.order_id}`;if(seen.has(id))continue;seen.add(id);const suffix=row.iccid?String(row.iccid).slice(-4):'TEST';esims.push({id,label:`eSIM ${countryName(row.country_iso2,row.country_name||msg(lang,'travel'),lang)} · •••• ${suffix}`,test_mode:!row.profile_id});}
  if(!esims.length)return res.status(400).json({error:msg(lang,'invalidCode')});
  const token=jwt.sign({email,scope:'recharge',language:lang},rechargeSecret(),{expiresIn:'20m'});
  res.json({token,esims});
}));

app.post('/api/recharge/checkout/session',rechargeLimiter,asyncRoute(async(req,res)=>{
  const requestedLanguage=requestLanguage(req);let identity;try{identity=rechargeIdentity(req);}catch(_){return res.status(401).json({error:msg(requestedLanguage,'expired')});}
  const lang=languageOf(requestedLanguage||identity.language);
  const esimId=String(req.body.esim_id||'');const productId=String(req.body.product_id||'');
  if(!acceptedFlag(req.body.terms_accepted)||!acceptedFlag(req.body.immediate_delivery_consent))return res.status(400).json({error:msg(lang,'consent')});
  let baseOrder,profileId=null,parentOrderId=null;
  if(esimId.startsWith('test:')){parentOrderId=esimId.slice(5);baseOrder=(await db.query(`SELECT * FROM orders WHERE id=? AND customer_email=? AND order_type='new_esim' AND status='delivered' AND stripe_livemode=FALSE`,[parentOrderId,identity.email])).rows[0];}
  else{const profile=(await db.query(`SELECT e.*,o.id parent_order_id,o.customer_name FROM esim_profiles e JOIN orders o ON o.id=e.assigned_order_id WHERE e.id=? AND e.assigned_email=? AND e.assignment_status='assigned'`,[esimId,identity.email])).rows[0];if(profile){profileId=profile.id;parentOrderId=profile.parent_order_id;baseOrder=profile;}}
  if(!baseOrder)return res.status(404).json({error:msg(lang,'esimUnavailable')});
  const product=(await db.query(`SELECT p.*,c.name_fr country_name FROM products p LEFT JOIN countries c ON c.iso2=p.country_iso2 WHERE p.id=? AND p.is_published=TRUE AND p.selling_price_ht IS NOT NULL`,[productId])).rows[0];
  if(!product)return res.status(404).json({error:msg(lang,'unavailable')});
  const cents=Math.round(Number(product.selling_price_ttc)*100);if(cents<50)return res.status(400).json({error:msg(lang,'invalidPrice')});
  const display=publicProduct(product,lang);const rechargeName=`${msg(lang,'rechargePrefix')} ${display.display_name}`;const returnRoot=lang==='fr'?`${frontend}/`:`${frontend}/${lang}/`;
  const session=await stripe.checkout.sessions.create({mode:'payment',managed_payments:{enabled:false},locale:stripeLocales[lang],customer_email:identity.email,customer_creation:'always',billing_address_collection:'required',invoice_creation:{enabled:true,invoice_data:{description:msg(lang,'rechargeInvoice'),metadata:{product_id:product.id,language:lang}}},success_url:`${returnRoot}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,cancel_url:`${returnRoot}?checkout=cancelled`,line_items:[{quantity:1,price_data:{currency:String(product.currency||'EUR').toLowerCase(),unit_amount:cents,product_data:{name:rechargeName,description:msg(lang,'rechargeDescription')}}}],metadata:{order_type:'recharge',product_id:product.id,customer_name:String(baseOrder.customer_name||'').slice(0,180),display_name:rechargeName,esim_profile_id:profileId||'',parent_order_id:parentOrderId||'',language:lang,...consentMetadata()}});
  res.json({url:session.url});
}));

async function stripeWebhook(req,res){
  let event;
  try{
    event=stripe.webhooks.constructEvent(req.body,req.headers['stripe-signature'],process.env.STRIPE_WEBHOOK_SECRET);
  }catch(error){
    return res.status(400).json({error:'Signature Stripe invalide'});
  }
  if(event.type!=='checkout.session.completed'||event.data.object.payment_status!=='paid')return res.json({received:true});
  const session=event.data.object;
  const isLive=session.livemode===true;
  const orderType=session.metadata?.order_type==='recharge'?'recharge':'new_esim';
  try{
    const existing=await db.query('SELECT id,status FROM orders WHERE stripe_session_id=? ORDER BY batch_item_index',[session.id]);
    if(existing.rows.length){
      await db.query('UPDATE orders SET stripe_livemode=? WHERE stripe_session_id=?',[isLive?1:0,session.id]);
      for(const order of existing.rows)if(order.status!=='delivered')await enqueue('deliver-esim',{orderId:order.id},`delivery-${session.id}-${order.id}`);
      return res.json({received:true,order_ids:existing.rows.map(order=>order.id),test_mode:!isLive});
    }
    const checkoutBatchId=String(session.metadata?.checkout_batch_id||'');
    if(checkoutBatchId){
      const batch=(await db.query(`SELECT * FROM checkout_batches WHERE id=?`,[checkoutBatchId])).rows[0];
      if(!batch||batch.stripe_session_id!==session.id)throw new Error('Panier de paiement introuvable');
      const items=parseJson(batch.items_json);
      if(!Array.isArray(items)||items.length<1||items.length>10||items.length!==Number(batch.item_count))throw new Error('Panier de paiement invalide');
      const expectedTotal=items.reduce((sum,item)=>sum+Number(item.unit_amount||0),0);
      if(Number(session.amount_total)!==expectedTotal)throw new Error('Montant Stripe incohérent');
      const payerEmail=session.customer_details?.email||session.customer_email||batch.payer_email;
      const payerName=session.customer_details?.name||batch.payer_name||'';
      const customerPhone=null;
      const customerAddress=session.customer_details?.address||null;
      const acceptedAt=session.metadata?.consent_timestamp?new Date(session.metadata.consent_timestamp):batch.accepted_at||new Date();
      const language=languageOf(session.metadata?.language||batch.language);
      const orderIds=[];
      await db.transaction(async query=>{
        for(let index=0;index<items.length;index++){
          const item=items[index],id=crypto.randomUUID(),number=`HOP-${new Date().getFullYear()}-${session.id.slice(-8).toUpperCase()}-${String(index+1).padStart(2,'0')}`;
          await query(`INSERT INTO orders(id,order_number,stripe_session_id,stripe_payment_intent,stripe_invoice_id,stripe_livemode,customer_email,customer_name,payer_email,payer_name,customer_phone,customer_address,language,order_type,checkout_batch_id,batch_item_index,product_id,product_name,country_iso2,purchase_price_ht,selling_price_ht,vat_rate,vat_amount,total_ttc,currency,terms_version,terms_accepted_at,withdrawal_waiver_at,status,paid_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())`,[id,number,session.id,session.payment_intent,session.invoice||null,isLive?1:0,item.recipient_email,item.recipient_name,payerEmail,payerName,customerPhone,customerAddress,language,'new_esim',checkoutBatchId,index,item.product_id,item.display_name,item.country_iso2,item.purchase_price_ht,item.selling_price_ht,item.vat_rate,item.vat_amount,item.total_ttc,item.currency,batch.terms_version||termsVersion,acceptedAt,acceptedAt,'paid']);
          orderIds.push(id);
        }
        await query(`UPDATE checkout_batches SET status='processed',processed_at=NOW() WHERE id=?`,[checkoutBatchId]);
      });
      for(let index=0;index<orderIds.length;index++){const id=orderIds[index],item=items[index];await recordPartnerReferral(batch.partner_code,id,item.total_ttc,item.currency,item.country_iso2,batch.partner_source,`${session.id}:${index}`);await enqueue('deliver-esim',{orderId:id},`delivery-${session.id}-${id}`);}
      return res.json({received:true,order_ids:orderIds,test_mode:!isLive});
    }
    const productResult=await db.query(`SELECT p.*,c.name_fr country_name FROM products p LEFT JOIN countries c ON c.iso2=p.country_iso2 WHERE p.id=?`,[session.metadata.product_id]);
    const product=productResult.rows[0];
    if(!product)throw new Error('Produit absent');
    if(Number(session.amount_total)!==Math.round(Number(product.selling_price_ttc)*100))throw new Error('Montant Stripe incohérent');
    const id=crypto.randomUUID();
    const number=`HOP-${new Date().getFullYear()}-${session.id.slice(-8).toUpperCase()}`;
    const customerEmail=session.customer_details?.email||session.customer_email;
    const customerName=session.customer_details?.name||session.metadata.customer_name||'';
    const customerPhone=null;
    const customerAddress=session.customer_details?.address||null;
    const displayName=session.metadata.display_name||publicProduct(product).display_name;
    const profileId=session.metadata?.esim_profile_id||null;
    const parentOrderId=session.metadata?.parent_order_id||null;
    if(orderType==='recharge'&&isLive&&!profileId)throw new Error('Profil eSIM absent de la recharge');
    const acceptedAt=session.metadata?.consent_timestamp?new Date(session.metadata.consent_timestamp):new Date();
    const language=languageOf(session.metadata?.language);
    await db.query(`INSERT INTO orders(id,order_number,stripe_session_id,stripe_payment_intent,stripe_invoice_id,stripe_livemode,customer_email,customer_name,customer_phone,customer_address,language,order_type,esim_profile_id,parent_order_id,product_id,product_name,country_iso2,purchase_price_ht,selling_price_ht,vat_rate,vat_amount,total_ttc,currency,terms_version,terms_accepted_at,withdrawal_waiver_at,status,paid_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())`,[id,number,session.id,session.payment_intent,session.invoice||null,isLive?1:0,customerEmail,customerName,customerPhone,customerAddress,language,orderType,profileId,parentOrderId,product.id,displayName,product.country_iso2,product.purchase_price_ht,product.selling_price_ht,product.vat_rate,product.vat_amount,product.selling_price_ttc,product.currency,session.metadata?.terms_version||termsVersion,acceptedAt,acceptedAt,'paid']);
    await enqueue('deliver-esim',{orderId:id},`delivery-${session.id}-${id}`);
    res.json({received:true,order_id:id,test_mode:!isLive});
  }catch(error){
    console.error('[Stripe]',error);
    res.status(500).json({error:'Commande non créée'});
  }
}

app.post('/api/admin/login',asyncRoute(async(req,res)=>{const email=String(req.body.email||'').trim().toLowerCase();const password=String(req.body.password||'');const configured=String(process.env.ADMIN_EMAIL||'').trim().toLowerCase();const hash=String(process.env.ADMIN_PASSWORD_HASH||'');const plain=String(process.env.ADMIN_PASSWORD||'');if(!configured||(!hash&&!plain)||!process.env.JWT_SECRET)return res.status(503).json({error:'Accès administrateur non configuré'});let valid=hash?await bcrypt.compare(password,hash):false;if(!hash){const supplied=Buffer.from(password),expected=Buffer.from(plain);valid=supplied.length===expected.length&&crypto.timingSafeEqual(supplied,expected);}if(email!==configured||!valid)return res.status(401).json({error:'Email ou mot de passe incorrect'});res.json({token:jwt.sign({email,role:'admin'},process.env.JWT_SECRET,{expiresIn:'8h'})});}));

app.get('/api/admin/dashboard',adminOnly,asyncRoute(async(_req,res)=>{const summary=(await db.query(`SELECT SUM(CASE WHEN created_at>=DATE_SUB(NOW(),INTERVAL 30 DAY) THEN 1 ELSE 0 END) orders_30d,COALESCE(SUM(CASE WHEN created_at>=DATE_SUB(NOW(),INTERVAL 30 DAY) AND status<>'refunded' THEN total_ttc ELSE 0 END),0) revenue_ttc_30d,SUM(status='delivered') delivered,SUM(status='failed') failed_orders FROM orders`)).rows[0];const changes=(await db.query(`SELECT COUNT(*) total FROM catalog_changes WHERE is_reviewed=FALSE AND change_type IN ('new_country','new_destination','new_product','price_changed','recommended_price_changed','supplier_retail_price_changed','product_changed','product_removed')`)).rows[0];const recent=(await orderQuery('LIMIT 6')).rows;res.json({...summary,attention:Number(summary.failed_orders||0)+Number(changes?.total||0),recent_orders:recent});}));
app.get('/api/admin/orders',adminOnly,asyncRoute(async(_req,res)=>res.json((await orderQuery('LIMIT 500')).rows)));
app.post('/api/admin/orders/:id/retry-delivery',adminOnly,asyncRoute(async(req,res)=>{
  const order=(await db.query('SELECT id,order_number,stripe_session_id,status,paid_at FROM orders WHERE id=?',[req.params.id])).rows[0];
  if(!order)return res.status(404).json({error:'Commande introuvable'});
  if(order.status==='delivered')return res.json({message:'Cette eSIM est déjà livrée',status:'delivered'});
  if(!order.stripe_session_id||!order.paid_at)return res.status(409).json({error:'Le paiement de cette commande n’est pas confirmé'});
  const jobKey=`delivery-${order.stripe_session_id}-${order.id}`;
  await enqueue('deliver-esim',{orderId:order.id},jobKey);
  await db.query(`UPDATE jobs SET status='pending',attempts=0,last_error=NULL,run_at=NOW(),locked_at=NULL WHERE job_key=? AND status<>'running'`,[jobKey]);
  setImmediate(()=>runJobs().catch(error=>console.error(`[Livraison ${order.order_number}]`,error.message)));
  res.json({message:'Livraison relancée sans nouveau paiement',status:'pending'});
}));
function orderQuery(limit){return db.query(`SELECT o.*,c.name_fr country_name FROM orders o LEFT JOIN countries c ON c.iso2=o.country_iso2 ORDER BY o.created_at DESC ${limit}`);}

app.get('/api/admin/products',adminOnly,asyncRoute(async(_req,res)=>{const result=await db.query(`SELECT p.*,c.name_fr country_name FROM products p LEFT JOIN countries c ON c.iso2=p.country_iso2 ORDER BY (p.last_synced_at IS NULL),p.last_synced_at DESC,p.name`);res.json(result.rows);}));
app.put('/api/admin/products/:id/pricing',adminOnly,asyncRoute(async(req,res)=>{const rawPurchase=req.body.purchase_price_ht;const purchase=rawPurchase===''||rawPurchase===null||rawPurchase===undefined?null:Number(rawPurchase);const rawMarkup=req.body.markup_percent;const markup=rawMarkup===''||rawMarkup===null||rawMarkup===undefined?null:Number(rawMarkup);let ht=Number(req.body.selling_price_ht);const vat=Number(req.body.vat_rate),published=Boolean(req.body.is_published);const current=(await db.query('SELECT * FROM products WHERE id=?',[req.params.id])).rows[0];if(!current)return res.status(404).json({error:'Forfait introuvable'});const recommended=Number(current.recommended_price_ht)>0?Number(current.recommended_price_ht):null;const pricingBase=recommended??purchase;if(markup!==null&&pricingBase!==null)ht=Math.round(pricingBase*(1+markup/100)*100)/100;if((purchase!==null&&(!Number.isFinite(purchase)||purchase<=0))||(markup!==null&&(!Number.isFinite(markup)||markup<0||markup>10000))||!Number.isFinite(ht)||ht<=0||!Number.isFinite(vat)||vat<0||vat>100)return res.status(400).json({error:'Prix d’achat, majoration, prix de vente ou TVA invalide'});if(markup!==null&&pricingBase===null)return res.status(400).json({error:'Importez le catalogue mensuel avant d’appliquer une majoration'});if(published&&(purchase===null||!Number.isFinite(ht)||ht<=0))return res.status(400).json({error:'Publication impossible : tarif incomplet'});await db.query('UPDATE products SET purchase_price_ht=?,markup_percent=?,selling_price_ht=?,vat_rate=?,is_published=?,needs_review=FALSE WHERE id=?',[purchase,markup,ht,vat,published,req.params.id]);const result=await db.query('SELECT * FROM products WHERE id=?',[req.params.id]);res.json(result.rows[0]);}));
app.post('/api/admin/products/bulk-publish',adminOnly,asyncRoute(async(req,res)=>{const ids=[...new Set((Array.isArray(req.body.ids)?req.body.ids:[]).map(id=>String(id||'').trim()).filter(Boolean))];const published=Boolean(req.body.is_published);if(!ids.length||ids.length>2000)return res.status(400).json({error:'Sélection de forfaits invalide'});const placeholders=ids.map(()=>'?').join(',');const condition=published?' AND purchase_price_ht>0 AND selling_price_ht>0':'';const eligible=Number((await db.query(`SELECT COUNT(*) total FROM products WHERE id IN (${placeholders})${condition}`,ids)).rows[0]?.total||0);await db.query(`UPDATE products SET is_published=?,needs_review=CASE WHEN ? THEN FALSE ELSE needs_review END WHERE id IN (${placeholders})${condition}`,[published,published,...ids]);res.json({selected:ids.length,updated:eligible,skipped:ids.length-eligible});}));
app.post('/api/admin/products/bulk-markup',adminOnly,asyncRoute(async(req,res)=>{const allProducts=Boolean(req.body.all_products);const ids=[...new Set((Array.isArray(req.body.ids)?req.body.ids:[]).map(id=>String(id||'').trim()).filter(Boolean))];const markup=Number(req.body.markup_percent),publish=Boolean(req.body.publish);if((!allProducts&&!ids.length)||ids.length>2000)return res.status(400).json({error:'Sélection de forfaits invalide'});if(!Number.isFinite(markup)||markup<0||markup>10000)return res.status(400).json({error:'Pourcentage de majoration invalide'});const scope=allProducts?'':` AND id IN (${ids.map(()=>'?').join(',')})`;const params=allProducts?[]:ids;const eligible=Number((await db.query(`SELECT COUNT(*) total FROM products WHERE purchase_price_ht>0 AND COALESCE(recommended_price_ht,purchase_price_ht)>0${scope}`,params)).rows[0]?.total||0);await db.query(`UPDATE products SET markup_percent=?,selling_price_ht=ROUND(COALESCE(recommended_price_ht,purchase_price_ht)*(1+?/100),2),is_published=CASE WHEN ? THEN TRUE ELSE is_published END,needs_review=CASE WHEN ? THEN FALSE ELSE needs_review END WHERE purchase_price_ht>0 AND COALESCE(recommended_price_ht,purchase_price_ht)>0${scope}`,[markup,markup,publish,publish,...params]);if(allProducts)await db.query(`INSERT INTO app_settings(setting_key,setting_value) VALUES('default_markup_percent',?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)`,[String(markup)]);res.json({selected:allProducts?eligible:ids.length,updated:eligible,published:publish?eligible:0,skipped:allProducts?0:ids.length-eligible,default_saved:allProducts});}));
app.post('/api/admin/catalog/sync',adminOnly,asyncRoute(async(_req,res)=>{res.json(await transatel.syncCatalog());}));
app.post('/api/admin/catalog/import-prices',adminOnly,express.raw({type:['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/octet-stream'],limit:'20mb'}),asyncRoute(async(req,res)=>{let filename='catalogue-mensuel-transatel.xlsx';try{filename=decodeURIComponent(String(req.headers['x-file-name']||filename));}catch(_){}if(!Buffer.isBuffer(req.body)||!req.body.length)return res.status(400).json({error:'Sélectionnez le catalogue mensuel Excel'});if(!/\.xlsx$/i.test(filename))return res.status(400).json({error:'Le fichier doit être au format .xlsx'});try{res.json(await priceImport.importMonthlyCatalog(req.body,filename));}catch(error){console.error('[Import catalogue mensuel Transatel]',error);res.status(400).json({error:error.message||'Catalogue mensuel invalide'});}}));
app.post('/api/admin/esim-stock/import',adminOnly,express.raw({type:['text/csv','application/csv','application/vnd.ms-excel','application/octet-stream'],limit:'10mb'}),asyncRoute(async(req,res)=>{let filename='parc-esim-transatel.csv';try{filename=decodeURIComponent(String(req.headers['x-file-name']||filename));}catch(_){}if(!Buffer.isBuffer(req.body)||!req.body.length)return res.status(400).json({error:'Sélectionnez le fichier parc Transatel'});if(!/\.csv$/i.test(filename))return res.status(400).json({error:'Le fichier doit être au format .csv'});try{res.json(await simImport.importPark(req.body,filename));}catch(error){console.error('[Import parc eSIM Transatel]',error.message);res.status(400).json({error:error.message||'Fichier parc Transatel invalide'});}}));
app.get('/api/admin/esim-stock',adminOnly,asyncRoute(async(_req,res)=>{const counts=(await db.query(`SELECT COUNT(*) total,SUM(assignment_status='available') available,SUM(assignment_status='reserved') reserved,SUM(assignment_status='assigned') assigned,SUM(assignment_status='unavailable') unavailable FROM esim_profiles`)).rows[0]||{};const lastImport=(await db.query(`SELECT filename,status,profiles_received,profiles_inserted,profiles_updated,profiles_skipped,available_after_import,started_at,finished_at FROM esim_stock_imports ORDER BY started_at DESC LIMIT 1`)).rows[0]||null;res.json({...counts,last_import:lastImport});}));
app.get('/api/admin/catalog/settings',adminOnly,asyncRoute(async(_req,res)=>{const setting=(await db.query(`SELECT setting_value FROM app_settings WHERE setting_key='default_markup_percent'`)).rows[0];const lastImport=(await db.query(`SELECT filename,status,products_received,products_created,products_updated,prices_changed,products_removed,started_at,finished_at FROM catalog_imports ORDER BY started_at DESC LIMIT 1`)).rows[0]||null;res.json({default_markup_percent:setting?Number(setting.setting_value):Number(process.env.DEFAULT_MARKUP_PERCENT||0),last_import:lastImport});}));
app.get('/api/admin/catalog/changes',adminOnly,asyncRoute(async(_req,res)=>{const result=await db.query(`SELECT cc.*,p.name product_name,c.name_fr country_name FROM catalog_changes cc LEFT JOIN products p ON p.id=cc.product_id LEFT JOIN countries c ON c.iso2=cc.country_iso2 WHERE cc.is_reviewed=FALSE AND cc.change_type IN ('new_country','new_destination','new_product','price_changed','recommended_price_changed','supplier_retail_price_changed','product_changed','product_removed') ORDER BY cc.created_at DESC LIMIT 200`);res.json(result.rows);}));
app.post('/api/admin/catalog/changes/reviewed',adminOnly,asyncRoute(async(_req,res)=>{const result=await db.query(`UPDATE catalog_changes SET is_reviewed=TRUE WHERE is_reviewed=FALSE AND change_type IN ('new_country','new_destination','new_product','price_changed','recommended_price_changed','supplier_retail_price_changed','product_changed','product_removed')`);await db.query('UPDATE products SET needs_review=FALSE WHERE needs_review=TRUE');res.json({updated:result.affectedRows});}));

async function enqueue(type,payload,key){await db.query(`INSERT INTO jobs(id,job_key,type,payload) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE status=IF(status='failed','pending',status),attempts=IF(status='failed',0,attempts),last_error=IF(status='failed',NULL,last_error),run_at=IF(status='failed',NOW(),run_at),locked_at=IF(status='failed',NULL,locked_at)`,[crypto.randomUUID(),key,type,payload]);}
let workerBusy=false;async function runJobs(){if(workerBusy)return;workerBusy=true;try{const jobs=(await db.query(`SELECT * FROM jobs WHERE status='pending' AND run_at<=NOW() ORDER BY created_at LIMIT 3`)).rows;for(const job of jobs){const claim=await db.query(`UPDATE jobs SET status='running',locked_at=NOW() WHERE id=? AND status='pending'`,[job.id]);if(!claim.affectedRows)continue;try{const payload=typeof job.payload==='string'?JSON.parse(job.payload):job.payload;if(job.type==='sync-catalog')await transatel.syncCatalog();if(job.type==='deliver-esim')await fulfill(payload.orderId);await db.query(`UPDATE jobs SET status='completed',last_error=NULL WHERE id=?`,[job.id]);}catch(error){const attempts=Number(job.attempts)+1,failed=attempts>=Number(job.max_attempts);console.error(`[Tâche ${job.type}] tentative ${attempts}/${job.max_attempts} : ${error.message}`);await db.query(`UPDATE jobs SET status=?,attempts=?,last_error=?,run_at=DATE_ADD(NOW(),INTERVAL ? SECOND),locked_at=NULL WHERE id=?`,[failed?'failed':'pending',attempts,error.message,Math.min(300,10*2**attempts),job.id]);}}}finally{workerBusy=false;}}
async function reserveProfile(orderId){
  return db.transaction(async query=>{
    const order=(await query('SELECT * FROM orders WHERE id=? FOR UPDATE',[orderId])).rows[0];
    if(!order)throw new Error('Commande introuvable');
    if(order.esim_profile_id){const existing=(await query('SELECT * FROM esim_profiles WHERE id=?',[order.esim_profile_id])).rows[0];if(existing)return existing;}
    const profile=(await query(`SELECT * FROM esim_profiles WHERE assignment_status='available' ORDER BY created_at,serial_number LIMIT 1 FOR UPDATE`)).rows[0];
    if(!profile)throw new Error('Stock eSIM épuisé : importez un nouveau fichier parc Transatel');
    const reserved=await query(`UPDATE esim_profiles SET assignment_status='reserved',assigned_order_id=?,assigned_email=?,reserved_at=NOW() WHERE id=? AND assignment_status='available'`,[order.id,order.customer_email,profile.id]);
    if(!reserved.affectedRows)throw new Error('Le profil eSIM vient d’être réservé par une autre commande');
    await query('UPDATE orders SET esim_profile_id=? WHERE id=?',[profile.id,order.id]);
    return {...profile,assignment_status:'reserved',assigned_order_id:order.id,assigned_email:order.customer_email};
  });
}
const isPreactivated=status=>String(status||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().startsWith('pre-active');
async function ensureInvoiceNumber(orderId){
  return db.transaction(async query=>{
    const order=(await query('SELECT invoice_number,YEAR(COALESCE(paid_at,created_at,NOW())) invoice_year FROM orders WHERE id=? FOR UPDATE',[orderId])).rows[0];
    if(!order)throw new Error('Commande introuvable pour la facturation');
    if(order.invoice_number)return order.invoice_number;
    const year=Number(order.invoice_year)||new Date().getFullYear();
    await query('INSERT INTO invoice_sequences(invoice_year,last_number) VALUES(?,0) ON DUPLICATE KEY UPDATE invoice_year=VALUES(invoice_year)',[year]);
    const sequence=(await query('SELECT last_number FROM invoice_sequences WHERE invoice_year=? FOR UPDATE',[year])).rows[0];
    const next=Number(sequence?.last_number||0)+1;
    await query('UPDATE invoice_sequences SET last_number=? WHERE invoice_year=?',[next,year]);
    const invoiceNumber=`HOP-${year}-${String(next).padStart(6,'0')}`;
    await query('UPDATE orders SET invoice_number=?,invoice_issued_at=NOW() WHERE id=?',[invoiceNumber,orderId]);
    return invoiceNumber;
  });
}
async function fulfill(orderId){
  await db.query(`UPDATE orders SET status='processing' WHERE id=? AND status IN ('paid','failed')`,[orderId]);
  let order=(await db.query('SELECT * FROM orders WHERE id=?',[orderId])).rows[0];
  if(!order||order.status==='delivered')return;
  const product=(await db.query('SELECT * FROM products WHERE id=?',[order.product_id])).rows[0];
  try{
    const isLive=Number(order.stripe_livemode)===1;
    if(order.order_type==='recharge'){
      if(!order.transatel_subscription_id){
        if(isLive){
          const profile=(await db.query(`SELECT * FROM esim_profiles WHERE id=? AND assignment_status='assigned' AND assigned_email=?`,[order.esim_profile_id,order.customer_email])).rows[0];
          if(!profile)throw new Error('Profil eSIM de recharge introuvable');
          const result=await transatel.subscribeProduct(order,product,profile,isPreactivated(profile.provisioning_status)?'preload':'subscribe');
          await db.query(`UPDATE orders SET transatel_subscription_id=? WHERE id=?`,[result.subscriptionId,orderId]);
        }else await db.query(`UPDATE orders SET transatel_subscription_id=? WHERE id=?`,[`TEST-RECHARGE-${String(order.order_number).slice(-12)}`,orderId]);
      }
      await ensureInvoiceNumber(orderId);
      order=(await db.query('SELECT * FROM orders WHERE id=?',[orderId])).rows[0];
      if(!order.payer_confirmation_sent_at){await mailer.sendRecharge(order);await db.query(`UPDATE orders SET payer_confirmation_sent_at=NOW(),recipient_sent_at=NOW(),invoice_sent_at=NOW() WHERE id=?`,[orderId]);}
      await db.query(`UPDATE orders SET status='delivered',delivered_at=NOW(),failure_reason=NULL WHERE id=?`,[orderId]);
      return;
    }
    let esim={subscriptionId:order.transatel_subscription_id,activationCode:order.activation_code,qrCodeUrl:order.qr_code_url};
    if(!esim.activationCode&&!esim.qrCodeUrl){
      if(isLive){
        const profile=await reserveProfile(orderId);
        if(!esim.subscriptionId){const subscription=await transatel.subscribeProduct(order,product,profile,'preload');esim.subscriptionId=subscription.subscriptionId;await db.query(`UPDATE orders SET transatel_subscription_id=? WHERE id=?`,[esim.subscriptionId,orderId]);}
        const details=await transatel.getEsimDetails(profile);esim={...esim,...details};
      }else{
        const testReference=String(order.order_number||order.id).replace(/[^A-Za-z0-9-]/g,'').slice(-48);
        esim={
          subscriptionId:`TEST-${testReference}`,
          activationCode:`LPA:1$test.hopon.invalid$TEST-${testReference}`,
          qrCodeUrl:null
        };
        console.log(`[eSIM TEST] QR de démonstration créé pour ${order.order_number}; aucun appel Transatel`);
      }
    }
    if(!esim.activationCode&&!esim.qrCodeUrl)throw new Error('Transatel n’a retourné ni QR code ni code d’activation');
    await db.query(`UPDATE orders SET status='processing',transatel_subscription_id=?,activation_code=?,qr_code_url=? WHERE id=?`,[esim.subscriptionId,esim.activationCode,esim.qrCodeUrl,orderId]);
    await ensureInvoiceNumber(orderId);
    const ready=(await db.query('SELECT * FROM orders WHERE id=?',[orderId])).rows[0];
    const sameRecipient=String(ready.customer_email||'').toLowerCase()===String(ready.payer_email||ready.customer_email||'').toLowerCase();
    if(sameRecipient){
      if(!ready.recipient_sent_at||!ready.payer_confirmation_sent_at){await mailer.sendEsim(ready,{includeInvoice:true});await db.query(`UPDATE orders SET recipient_sent_at=NOW(),payer_confirmation_sent_at=NOW(),invoice_sent_at=NOW() WHERE id=?`,[orderId]);}
    }else{
      if(!ready.recipient_sent_at){await mailer.sendEsim(ready,{includeInvoice:false});await db.query(`UPDATE orders SET recipient_sent_at=NOW() WHERE id=?`,[orderId]);}
      const refreshed=(await db.query('SELECT * FROM orders WHERE id=?',[orderId])).rows[0];
      if(!refreshed.payer_confirmation_sent_at){await mailer.sendPayerConfirmation(refreshed);await db.query(`UPDATE orders SET payer_confirmation_sent_at=NOW(),invoice_sent_at=NOW() WHERE id=?`,[orderId]);}
    }
    await db.query(`UPDATE orders SET status='delivered',delivered_at=NOW(),failure_reason=NULL WHERE id=?`,[orderId]);
    if(isLive&&ready.esim_profile_id)await db.query(`UPDATE esim_profiles SET assignment_status='assigned',assigned_at=NOW() WHERE id=? AND assigned_order_id=?`,[ready.esim_profile_id,orderId]);
  }catch(error){
    await db.query(`UPDATE orders SET status='failed',failure_reason=? WHERE id=?`,[error.message,orderId]);
    throw error;
  }
}

app.use((error,req,res,_next)=>{console.error(error);const lang=requestLanguage(req);const errors={fr:'Une erreur interne est survenue',en:'An internal error occurred',de:'Ein interner Fehler ist aufgetreten',it:'Si è verificato un errore interno',es:'Se ha producido un error interno'};res.status(500).json({error:errors[lang]});});

async function cleanupExpiredData(){
  await db.query(`DELETE FROM recharge_codes WHERE created_at<DATE_SUB(NOW(),INTERVAL 30 DAY)`);
  await db.query(`DELETE FROM jobs WHERE status IN ('completed','failed') AND updated_at<DATE_SUB(NOW(),INTERVAL 90 DAY)`);
  await db.query(`UPDATE checkout_batches SET payer_email='redacted@hopon.invalid',payer_name='Données supprimées',items_json=JSON_ARRAY() WHERE processed_at IS NULL AND created_at<DATE_SUB(NOW(),INTERVAL 30 DAY)`);
}
async function initializeRuntime(){
  await db.migrate();
  const directory=(await db.query('SELECT iso2,name_fr,name_en,flag_emoji FROM countries')).rows;
  for(const country of directory){
    await db.query('UPDATE countries SET name_fr=?,name_en=?,flag_emoji=? WHERE iso2=?',[countryDirectory.nameFr(country.iso2,country.name_fr),countryDirectory.nameEn(country.iso2,country.name_en),countryDirectory.flag(country.iso2,country.flag_emoji),country.iso2]);
  }
  await db.query(`UPDATE jobs SET status='pending',locked_at=NULL WHERE status='running'`);
  if(!workersStarted){
    workersStarted=true;
    setInterval(runJobs,Number(process.env.JOB_POLL_MS||5000)).unref();
    new CronJob(process.env.CATALOG_SYNC_CRON||'0 */4 * * *',()=>enqueue('sync-catalog',{},`cron-${Date.now()}`).catch(console.error),null,true,'Europe/Paris');
    new CronJob('15 3 * * *',()=>cleanupExpiredData().catch(error=>console.error('[Nettoyage données]',error)),null,true,'Europe/Paris');
  }
  console.log('HopOn API initialisée : schéma MySQL prêt');
}

// Hostinger exige que listen() soit appelé dans les trois secondes suivant le
// chargement du fichier d'entrée. On ouvre donc le port immédiatement, avant
// toute migration ou autre opération asynchrone. Les requêtes attendent déjà
// ensureRuntime() grâce au middleware défini plus haut.
const port=process.env.PORT??3000;
const server=app.listen(port,()=>console.log(`HopOn API démarrée sur le port ${port}`));

ensureRuntime().catch(error=>{
  console.error('[Initialisation HopOn]',error);
  server.close(()=>process.exit(1));
});

module.exports={app,ensureRuntime,server};
