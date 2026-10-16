'use strict';

const axios=require('axios');
const crypto=require('crypto');
const db=require('./db');
const countryDirectory=require('./countries');

const clean=value=>String(value??'').trim().replace(/^(['"])(.*)\1$/,'$2');
const API_BASE_URL='https://api.transatel.com';
const AUTH_URL=`${API_BASE_URL}/authentication/api/token`;
const cfg={
  username:clean(process.env.TRANSATEL_USERNAME||process.env.TRANSATEL_CLIENT_ID),
  password:clean(process.env.TRANSATEL_PASSWORD||process.env.TRANSATEL_CLIENT_SECRET),
  cosRef:clean(process.env.TRANSATEL_COS_REF),
  mvnoRef:clean(process.env.TRANSATEL_MVNO_REF),
  timeout:Number(process.env.TRANSATEL_TIMEOUT_MS||20000)
};

const http=axios.create({timeout:cfg.timeout,headers:{Accept:'application/json'}});

let tokenCache={value:null,expiresAt:0};

const pathFor=(key,vars={})=>clean(process.env[key]).replace(/\{(\w+)\}/g,(_,name)=>encodeURIComponent(vars[name]||''));
const first=(object,paths)=>{for(const path of paths){const value=path.split('.').reduce((current,key)=>current?.[key],object);if(value!==undefined&&value!==null&&value!=='')return value;}return null;};
const number=value=>{if(value===null||value===undefined||value==='')return null;const result=Number(value);return Number.isFinite(result)&&result>=0?result:null;};
const positiveNumber=value=>{const result=number(value);return result!==null&&result>0?result:null;};

function endpoint(value){
  const target=clean(value);
  try{return new URL(target,`${API_BASE_URL}/`).toString();}
  catch(_){throw new Error('Chemin API Transatel invalide');}
}

function requireConfig(){
  if(!cfg.username||!cfg.password||!cfg.cosRef)throw new Error('Identifiants ou COS Transatel non configurés');
}

async function getAccessToken(force=false){
  requireConfig();
  if(!force&&tokenCache.value&&Date.now()<tokenCache.expiresAt)return tokenCache.value;
  const body=new URLSearchParams({grant_type:'client_credentials'}).toString();
  const response=await axios.post(AUTH_URL,body,{
    timeout:cfg.timeout,
    auth:{username:cfg.username,password:cfg.password},
    headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'}
  });
  const token=response.data?.access_token;
  if(!token)throw new Error('Transatel n’a retourné aucun jeton OAuth');
  const lifetime=Math.max(60,Number(response.data?.expires_in)||3600);
  tokenCache={value:token,expiresAt:Date.now()+(lifetime-60)*1000};
  return token;
}

async function request(method,url,data){
  let token=await getAccessToken();
  try{
    return await http.request({method,url:endpoint(url),data,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}});
  }catch(error){
    if(error.response?.status!==401)throw error;
    token=await getAccessToken(true);
    return http.request({method,url:endpoint(url),data,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}});
  }
}

function productDefinition(product){return product?.productDefinition||product?.definition||product||{};}

function stringsFrom(value,result=[]){
  if(typeof value==='string')result.push(value);
  else if(Array.isArray(value))value.forEach(item=>stringsFrom(item,result));
  else if(value&&typeof value==='object')Object.values(value).forEach(item=>stringsFrom(item,result));
  return result;
}

function textValue(value){
  if(typeof value==='string'){
    const text=value.trim();
    if(!text)return null;
    if(text.startsWith('{')||text.startsWith('[')){
      try{return textValue(JSON.parse(text))||text;}catch(_){return text;}
    }
    return text;
  }
  if(Array.isArray(value)){
    for(const item of value){const text=textValue(item);if(text)return text;}
    return null;
  }
  if(value&&typeof value==='object'){
    for(const key of ['productShortText','shortText','text','value','description','label','name']){
      const text=textValue(value[key]);if(text)return text;
    }
  }
  return null;
}

function countryValue(product,definition){
  const direct=first(product,['countryCode','country_code','countryIso2','targetCountry'])||first(definition,['countryCode','country_code','countryIso2','targetCountry']);
  const tagged=stringsFrom(product.tags||definition.tags||[]).flatMap(value=>String(value).toUpperCase().match(/\b[A-Z]{2}\b/g)||[])[0];
  const entry=direct||tagged||definition.countryList?.[0]||product.countryList?.[0];
  if(typeof entry==='string')return entry;
  return first(entry||{},['iso2','countryCode','country_code','code','isoAlpha2']);
}

function allowanceValue(definition){
  const allowances=definition.allowances?.data||definition.dataAllowances||definition.allowances||[];
  const allowance=Array.isArray(allowances)?allowances[0]:allowances;
  if(!allowance||typeof allowance!=='object')return {mb:null};
  const value=number(first(allowance,['resourceValue','value','amount','volume']));
  const unit=String(first(allowance,['resourceUnit','unit'])||'MB').toUpperCase();
  if(value===null)return {mb:null};
  if(['GB','GIB'].includes(unit))return {mb:Math.round(value*1024)};
  if(['KB','KIB'].includes(unit))return {mb:Math.round(value/1024)};
  if(['B','BYTE','BYTES'].includes(unit))return {mb:Math.round(value/1024/1024)};
  return {mb:Math.round(value)};
}

function isConsumerProduct(product){
  const definition=productDefinition(product);
  const text=[product.id,definition.productId,definition.reference,definition.name,definition.label,definition.productCategory].filter(Boolean).join(' ').toLowerCase();
  return !/(business|corporate|professional|professionnel|b2b|rbup|rbrp)/i.test(text);
}

function mapProduct(product){
  const definition=productDefinition(product);
  const flatGB=number(first(product,['dataGB','data_gb','dataAllowanceGB'])||first(definition,['dataGB','data_gb','dataAllowanceGB']));
  const flatMB=number(first(product,['dataMB','data_mb','dataAllowanceMB'])||first(definition,['dataMB','data_mb','dataAllowanceMB']));
  const nestedMB=allowanceValue(definition).mb;
  const rawCountry=String(countryValue(product,definition)||'').toUpperCase();
  const countryIso2=/^[A-Z]{2}$/.test(rawCountry)?rawCountry:null;
  return {
    transatel_product_id:String(first(product,['id','productId','product_id','reference'])||first(definition,['id','productId','product_id','reference'])||''),
    transatel_option_id:first(product,['optionId','option_id'])||first(definition,['optionId','option_id']),
    country_iso2:countryIso2,
    country_name:first(product,['countryName','country.name','destination'])||first(definition,['countryName','country.name','destination']),
    name:String(first(product,['name','label','title','displayName','commercialName'])||first(definition,['name','label','title','displayName','commercialName','productId'])||'Forfait eSIM'),
    description:textValue(first(product,['description','details'])||first(definition,['description','details'])),
    data_amount_mb:flatMB??(flatGB!==null?Math.round(flatGB*1024):nestedMB),
    duration_days:number(first(product,['durationDays','duration_days','validityDays','validity'])||first(definition,['durationDays','duration_days','validityDays','validity','validityPeriod.validityDuration'])),
    currency:String(first(product,['currency','pricing.currency','price.currency'])||first(definition,['currency','pricing.currency','price.currency'])||'EUR').slice(0,3).toUpperCase(),
    purchase_price_ht:positiveNumber(first(product,['purchasePrice.amount','pricing.amount','pricing.price.amount','price.amount','unitPrice.amount','purchasePrice','unitPrice','cost','pricing.price','price'])||first(definition,['purchasePrice.amount','pricing.amount','pricing.price.amount','price.amount','unitPrice.amount','purchasePrice','unitPrice','cost','pricing.price','price'])),
    raw_data:product
  };
}

async function fetchCatalog(){
  requireConfig();
  const path=`/ocs/catalog/api/cos/${encodeURIComponent(cfg.cosRef)}/products`;
  const response=await request('get',path);
  return Array.isArray(response.data)?response.data:(response.data?.products||response.data?.items||[]);
}

const trackedFields=['purchase_price_ht','country_iso2','name','data_amount_mb','duration_days','currency'];
const numericFields=new Set(['purchase_price_ht','data_amount_mb','duration_days']);
const labelForField={purchase_price_ht:'Prix d’achat HT',country_iso2:'Pays',name:'Nom',description:'Description',data_amount_mb:'Volume de données',duration_days:'Durée',currency:'Devise'};
const normalized=(field,value)=>value===null||value===undefined?'':numericFields.has(field)?String(Number(value)):String(value);

async function recordChange({logId,productId=null,transatelId=null,countryIso2=null,type,field=null,oldValue=null,newValue=null}){
  await db.query(`INSERT INTO catalog_changes(id,sync_log_id,product_id,transatel_product_id,country_iso2,change_type,field_name,old_value,new_value) VALUES(?,?,?,?,?,?,?,?,?)`,[crypto.randomUUID(),logId,productId,transatelId,countryIso2,type,field?labelForField[field]||field:null,oldValue===null?null:String(oldValue),newValue===null?null:String(newValue)]);
}

async function syncCatalog(){
  const logId=crypto.randomUUID();
  await db.query('INSERT INTO sync_logs(id,status) VALUES(?,?)',[logId,'running']);
  let created=0,updated=0,changes=0;
  try{
    const received=await fetchCatalog();
    if(!Array.isArray(received))throw new Error('Format du catalogue Transatel non reconnu');
    const source=received.filter(isConsumerProduct);
    let recognized=0;
    for(const raw of source){
      const p=mapProduct(raw);
      if(!p.transatel_product_id)continue;
      recognized++;
      if(p.country_iso2){
        const countryNameFr=countryDirectory.nameFr(p.country_iso2,p.country_name);
        const countryNameEn=countryDirectory.nameEn(p.country_iso2,p.country_name);
        const countryFlag=countryDirectory.flag(p.country_iso2);
        const knownCountry=(await db.query('SELECT iso2 FROM countries WHERE iso2=?',[p.country_iso2])).rows[0];
        await db.query(`INSERT INTO countries(iso2,name_fr,name_en,flag_emoji) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE name_fr=VALUES(name_fr),name_en=VALUES(name_en),flag_emoji=VALUES(flag_emoji)`,[p.country_iso2,countryNameFr,countryNameEn,countryFlag]);
        if(!knownCountry){
          await recordChange({logId,transatelId:p.transatel_product_id,countryIso2:p.country_iso2,type:'new_country',newValue:countryNameFr});
          changes++;
        }
      }
      const existing=(await db.query('SELECT * FROM products WHERE transatel_product_id=?',[p.transatel_product_id])).rows[0];
      if(existing){
        const next={
          transatel_option_id:p.transatel_option_id??existing.transatel_option_id,
          country_iso2:p.country_iso2??existing.country_iso2,
          name:p.name||existing.name,
          description:p.description??existing.description,
          data_amount_mb:p.data_amount_mb??existing.data_amount_mb,
          duration_days:p.duration_days??existing.duration_days,
          currency:p.currency||existing.currency,
          purchase_price_ht:Number(existing.purchase_price_ht)>0?Number(existing.purchase_price_ht):p.purchase_price_ht
        };
        let productChanged=false;
        for(const field of trackedFields){
          if(normalized(field,existing[field])===normalized(field,next[field]))continue;
          await recordChange({logId,productId:existing.id,transatelId:p.transatel_product_id,countryIso2:next.country_iso2,type:field==='purchase_price_ht'?'price_changed':'product_changed',field,oldValue:existing[field],newValue:next[field]});
          changes++;
          productChanged=true;
        }
        await db.query(`UPDATE products SET transatel_option_id=?,country_iso2=?,name=?,description=?,data_amount_mb=?,duration_days=?,currency=?,purchase_price_ht=?,selling_price_ht=CASE WHEN markup_percent IS NULL OR ? IS NULL THEN selling_price_ht ELSE ROUND(?*(1+markup_percent/100),2) END,raw_data=?,last_synced_at=NOW() WHERE id=?`,[next.transatel_option_id,next.country_iso2,next.name,next.description,next.data_amount_mb,next.duration_days,next.currency,next.purchase_price_ht,next.purchase_price_ht,next.purchase_price_ht,p.raw_data,existing.id]);
        if(productChanged)updated++;
      }else{
        const productId=crypto.randomUUID();
        await db.query(`INSERT INTO products(id,transatel_product_id,transatel_option_id,country_iso2,name,description,data_amount_mb,duration_days,currency,purchase_price_ht,vat_rate,raw_data,last_synced_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NOW())`,[productId,p.transatel_product_id,p.transatel_option_id,p.country_iso2,p.name,p.description,p.data_amount_mb,p.duration_days,p.currency,p.purchase_price_ht,Number(process.env.VAT_RATE_DEFAULT||20),p.raw_data]);
        await recordChange({logId,productId,transatelId:p.transatel_product_id,countryIso2:p.country_iso2,type:'new_product',newValue:p.name});
        changes++;
        created++;
      }
    }
    if(received.length&&!recognized)throw new Error('Catalogue reçu, mais aucun produit Transatel reconnu');
    await db.query('UPDATE sync_logs SET status=?,products_received=?,products_created=?,products_updated=?,finished_at=NOW() WHERE id=?',['success',received.length,created,updated,logId]);
    return {received:received.length,created,updated,changes};
  }catch(error){
    const message=error.response?.data?.message||error.response?.data?.error_description||error.response?.data?.error||error.message;
    await db.query('UPDATE sync_logs SET status=?,error_message=?,finished_at=NOW() WHERE id=?',['failed',String(message),logId]);
    throw new Error(`Transatel : ${message}`);
  }
}

function apiError(error){
  return error.response?.data?.message||error.response?.data?.error_description||error.response?.data?.error||error.message;
}

async function subscribeProduct(order,product,profile,orderType){
  requireConfig();
  const mvnoRef=clean(cfg.mvnoRef||profile?.mvno_ref);
  if(!mvnoRef)throw new Error('Référence de compte Transatel (mvnoRef) absente');
  if(!profile?.msisdn)throw new Error('Le profil eSIM ne contient aucun MSISDN');
  if(!['preload','subscribe'].includes(orderType))throw new Error('Type de commande Transatel invalide');
  try{
    const response=await request('post','/ocs/subscriptions/api/orders/products',{
      bind:{msisdn:String(profile.msisdn).replace(/\D/g,'')},
      product:{productId:product.transatel_product_id},
      payment:{provider:'customer'},source:'api',orderType,mvnoRef
    });
    const data=response.data||{};
    const subscriptionId=first(data,['subscriptionId','id','transactionId']);
    if(!subscriptionId)throw new Error('Transatel n’a retourné aucun identifiant de souscription');
    return {subscriptionId,raw:data};
  }catch(error){throw new Error(`Souscription Transatel : ${apiError(error)}`);}
}

async function getEsimDetails(profile){
  requireConfig();
  if(!profile?.serial_number)throw new Error('Numéro de série eSIM absent');
  const template=clean(process.env.TRANSATEL_ESIM_DETAILS_PATH)||'/sim-management/api/esims/sim-serial/{simSerial}';
  const path=template.replace('{simSerial}',encodeURIComponent(profile.serial_number)).replace('{sim-serial}',encodeURIComponent(profile.serial_number));
  try{
    const details=(await request('get',path)).data||{};
    const smdp=first(details,['smdpAddress','smdp_address','smdpPlusAddress','esim.smdpAddress','profile.smdpAddress']);
    const matchingId=first(details,['matchingId','matching_id','esim.matchingId','profile.matchingId']);
    const qrValue=first(details,['qrCode.value','qr_code.value','lpaString','lpa_string','esim.lpaString']);
    const rawCode=qrValue||first(details,['activationCode','activation_code','esim.activationCode','profile.activationCode']);
    const activationCode=rawCode?(String(rawCode).startsWith('LPA:')?String(rawCode):`LPA:${rawCode}`):(smdp&&matchingId?`LPA:1$${smdp}$${matchingId}`:null);
    const qrCodeUrl=first(details,['qrCode.dataUrl','qr_code.dataUrl','qrCodeUrl','qr_code_url','esim.qrCodeUrl','qrCode.url','profile.qrCodeUrl']);
    if(!activationCode&&!qrCodeUrl)throw new Error('Transatel n’a retourné ni QR code ni code d’activation');
    return {activationCode,qrCodeUrl,status:first(details,['status','esimStatus']),raw:details};
  }catch(error){throw new Error(`Détails eSIM Transatel : ${apiError(error)}`);}
}

async function activate(order,product,profile){
  const subscription=await subscribeProduct(order,product,profile,'preload');
  const details=await getEsimDetails(profile);
  return {...subscription,...details};
}

module.exports={syncCatalog,activate,subscribeProduct,getEsimDetails,mapProduct};
