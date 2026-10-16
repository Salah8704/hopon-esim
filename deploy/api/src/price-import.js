'use strict';

const crypto=require('crypto');
const db=require('./db');

const cleanText=value=>String(value??'').trim();
const normalize=value=>cleanText(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/_x000d_/gi,' ').replace(/\s+/g,' ').toLowerCase();
const numeric=value=>{
  if(value===null||value===undefined||value==='')return null;
  const number=Number(String(value).replace(/\s/g,'').replace(',','.'));
  return Number.isFinite(number)&&number>=0?number:null;
};
const rounded=(value,decimals=2)=>Number(Number(value).toFixed(decimals));
const changedNumber=(before,after)=>{
  if(before===null||before===undefined||before==='')return after!==null;
  if(after===null)return true;
  return Math.abs(Number(before)-Number(after))>0.0049;
};

function cellValue(cell){
  const value=cell?.value;
  if(value===null||value===undefined)return '';
  if(value instanceof Date)return value;
  if(typeof value!=='object')return value;
  if(value.result!==undefined)return value.result;
  if(Array.isArray(value.richText))return value.richText.map(part=>part.text||'').join('');
  if(value.text!==undefined)return value.text;
  return String(value);
}

function countryTools(){
  const countries=require('i18n-iso-countries');
  countries.registerLocale(require('i18n-iso-countries/langs/en.json'));
  countries.registerLocale(require('i18n-iso-countries/langs/fr.json'));
  return countries;
}

function countryIso2For(area,countries){
  const name=cleanText(area);
  const special={
    'UNITED STATES OF AMERICA':'US','UNITED STATES':'US','USA':'US',
    'UK':'GB','UNITED KINGDOM':'GB','SOUTH KOREA':'KR','KOREA SOUTH':'KR',
    'RUSSIA':'RU','CZECH REPUBLIC':'CZ','VIETNAM':'VN','TAIWAN':'TW',
    'BOLIVIA':'BO','VENEZUELA':'VE','TANZANIA':'TZ','MOLDOVA':'MD',
    'IVORY COAST':'CI','PALESTINE':'PS','LAOS':'LA','BRUNEI':'BN',
    'MACAO':'MO','CAPE VERDE':'CV','CABO VERDE':'CV','REUNION':'RE',
    'KOSOVO':'XK'
  };
  if(special[name.toUpperCase()])return special[name.toUpperCase()];
  return countries.getAlpha2Code(name,'en')||countries.getAlpha2Code(name,'fr')||null;
}

function flagFor(code){return /^[A-Z]{2}$/.test(code)?[...code].map(letter=>String.fromCodePoint(127397+letter.charCodeAt(0))).join(''):'';}

function allowanceMb(value){
  const text=cleanText(value).toUpperCase();
  if(!text||text.includes('UNLIMITED'))return null;
  const match=text.match(/([\d.,]+)\s*(TB|GB|MB)/);
  if(!match)return null;
  const amount=numeric(match[1]);
  if(amount===null)return null;
  if(match[2]==='TB')return Math.round(amount*1024*1024);
  if(match[2]==='GB')return Math.round(amount*1024);
  return Math.round(amount);
}

function durationDays(value){
  const text=cleanText(value).toLowerCase();
  const amount=numeric(text.match(/[\d.,]+/)?.[0]);
  if(amount===null)return null;
  if(/month|mois/.test(text))return Math.round(amount*30);
  if(/year|an(?:nee)?/.test(text))return Math.round(amount*365);
  return Math.round(amount);
}

async function readMonthlyCatalog(buffer){
  if(!Buffer.isBuffer(buffer)||!buffer.length)throw new Error('Sélectionnez le catalogue mensuel Excel');
  const ExcelJS=require('exceljs');
  const workbook=new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet=workbook.getWorksheet('Bundles prices')||workbook.worksheets.find(sheet=>normalize(sheet.name).includes('bundle')&&normalize(sheet.name).includes('price'));
  if(!worksheet)throw new Error('Feuille « Bundles prices » introuvable');

  let columns=null;
  for(let rowNumber=1;rowNumber<=Math.min(30,worksheet.rowCount);rowNumber++){
    const headers={};
    worksheet.getRow(rowNumber).eachCell({includeEmpty:true},(cell,column)=>{headers[normalize(cellValue(cell))]=column;});
    const find=predicate=>Object.entries(headers).find(([name])=>predicate(name))?.[1];
    const reference=find(name=>name==='technical reference');
    const purchase=find(name=>name.includes('service provider connect price')&&name.includes('ex vat'));
    const recommended=find(name=>name.includes('recommended retail price')&&name.includes('excl. vat'));
    const supplierTtc=find(name=>name.includes('ubg')&&name.includes('retail price')&&name.includes('incl. vat'));
    if(reference&&purchase&&recommended&&supplierTtc){
      columns={
        headerRow:rowNumber,reference,purchase,recommended,supplierTtc,
        description:find(name=>name.includes('literal description')||name.includes('litteral description')),
        bundleType:find(name=>name==='bundle type'),area:find(name=>name==='area'||name.includes('destination')),
        allowance:find(name=>name.startsWith('allowance')),duration:find(name=>name.startsWith('duration')),
        discount:find(name=>name==='discount'),changes:find(name=>name==='changes')
      };
      break;
    }
  }
  if(!columns)throw new Error('Ce fichier n’est pas le catalogue mensuel « Service Provider Connect Start »');

  const countries=countryTools();
  const products=[];
  const duplicates=[];
  const seen=new Set();
  for(let rowNumber=columns.headerRow+1;rowNumber<=worksheet.rowCount;rowNumber++){
    const row=worksheet.getRow(rowNumber);
    const read=column=>column?cellValue(row.getCell(column)):'';
    const technicalReference=cleanText(read(columns.reference));
    if(!technicalReference||!technicalReference.startsWith('WW_'))continue;
    if(seen.has(technicalReference)){duplicates.push(technicalReference);continue;}
    const purchasePrice=numeric(read(columns.purchase));
    const recommendedPrice=numeric(read(columns.recommended));
    const supplierTtc=numeric(read(columns.supplierTtc));
    if(purchasePrice===null||recommendedPrice===null||supplierTtc===null)continue;
    seen.add(technicalReference);
    const area=cleanText(read(columns.area));
    const sourceChange=cleanText(read(columns.changes));
    const strike=Boolean(row.getCell(columns.reference).font?.strike);
    products.push({
      technicalReference,
      description:cleanText(read(columns.description)),
      bundleType:cleanText(read(columns.bundleType)),
      area,
      countryIso2:countryIso2For(area,countries),
      allowance:cleanText(read(columns.allowance)),
      dataAmountMb:allowanceMb(read(columns.allowance)),
      duration:cleanText(read(columns.duration)),
      durationDays:durationDays(read(columns.duration)),
      supplierRetailPriceTtc:rounded(supplierTtc),
      recommendedPriceHt:rounded(recommendedPrice),
      discount:numeric(read(columns.discount)),
      purchasePriceHt:rounded(purchasePrice,4),
      sourceChange,
      removed:strike||/removal|removed|supprime/i.test(sourceChange)
    });
  }
  if(!products.length)throw new Error('Aucun forfait tarifé trouvé dans le catalogue mensuel');
  return {products,duplicates};
}

async function insertChange(connection,{productId=null,transatelId,countryIso2=null,type,field=null,oldValue=null,newValue=null}){
  await connection.execute(
    `INSERT INTO catalog_changes(id,product_id,transatel_product_id,country_iso2,change_type,field_name,old_value,new_value) VALUES(?,?,?,?,?,?,?,?)`,
    [crypto.randomUUID(),productId,transatelId,countryIso2,type,field,oldValue===null?null:String(oldValue),newValue===null?null:String(newValue)]
  );
}

async function importMonthlyCatalog(buffer,filename){
  const parsed=await readMonthlyCatalog(buffer);
  const importId=crypto.randomUUID();
  const safeFilename=cleanText(filename).slice(0,255);
  await db.query('INSERT INTO catalog_imports(id,filename,status,products_received) VALUES(?,?,?,?)',[importId,safeFilename,'running',parsed.products.length]);
  const connection=await db.pool.getConnection();
  let created=0,updated=0,recalculated=0,priceChanges=0,newDestinations=0,removed=0,unchanged=0;
  try{
    await connection.beginTransaction();
    const [settingRows]=await connection.execute(`SELECT setting_value FROM app_settings WHERE setting_key='default_markup_percent'`);
    const configuredDefault=numeric(settingRows[0]?.setting_value);
    const defaultMarkup=configuredDefault??numeric(process.env.DEFAULT_MARKUP_PERCENT)??0;
    const [existingRows]=await connection.execute('SELECT * FROM products');
    const existingByReference=new Map(existingRows.map(product=>[product.transatel_product_id,product]));
    const [countryRows]=await connection.execute('SELECT iso2 FROM countries');
    const knownCountries=new Set(countryRows.map(country=>country.iso2));
    const importedReferences=new Set();
    const countries=countryTools();

    for(const item of parsed.products){
      importedReferences.add(item.technicalReference);
      const existing=existingByReference.get(item.technicalReference);
      const countryIso2=item.countryIso2||existing?.country_iso2||null;
      if(countryIso2&&!knownCountries.has(countryIso2)){
        const frenchName=countries.getName(countryIso2,'fr')||item.area||countryIso2;
        const englishName=countries.getName(countryIso2,'en')||item.area||countryIso2;
        await connection.execute('INSERT INTO countries(iso2,name_fr,name_en,flag_emoji) VALUES(?,?,?,?)',[countryIso2,frenchName,englishName,flagFor(countryIso2)]);
        knownCountries.add(countryIso2);
        await insertChange(connection,{transatelId:item.technicalReference,countryIso2,type:'new_destination',field:'Destination',newValue:frenchName});
        newDestinations++;
      }

      if(item.removed){
        if(existing){
          await connection.execute(`UPDATE products SET is_published=FALSE,needs_review=TRUE,supplier_change_label=?,last_price_import_at=NOW() WHERE id=?`,[item.sourceChange||'Data plan removal',existing.id]);
          await insertChange(connection,{productId:existing.id,transatelId:item.technicalReference,countryIso2,type:'product_removed',field:'Statut fournisseur',oldValue:'Disponible',newValue:'Supprimé du catalogue'});
          removed++;
        }
        continue;
      }

      if(!existing){
        const selling=rounded(item.recommendedPriceHt*(1+defaultMarkup/100));
        const productId=crypto.randomUUID();
        await connection.execute(
          `INSERT INTO products(id,transatel_product_id,country_iso2,name,description,data_amount_mb,duration_days,currency,purchase_price_ht,recommended_price_ht,supplier_retail_price_ttc,markup_percent,selling_price_ht,vat_rate,is_published,needs_review,supplier_change_label,raw_data,last_price_import_at,last_synced_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
          [productId,item.technicalReference,countryIso2,item.technicalReference,item.description,item.dataAmountMb,item.durationDays,'EUR',item.purchasePriceHt,item.recommendedPriceHt,item.supplierRetailPriceTtc,defaultMarkup,selling,Number(process.env.VAT_RATE_DEFAULT||20),false,true,item.sourceChange,JSON.stringify(item)]
        );
        await insertChange(connection,{productId,transatelId:item.technicalReference,countryIso2,type:'new_product',field:'Forfait',newValue:item.description||item.technicalReference});
        created++;
        recalculated++;
        continue;
      }

      const markup=numeric(existing.markup_percent)??defaultMarkup;
      const selling=rounded(item.recommendedPriceHt*(1+markup/100));
      const differences=[];
      if(changedNumber(existing.purchase_price_ht,item.purchasePriceHt))differences.push(['price_changed','Prix d’achat HT',existing.purchase_price_ht,item.purchasePriceHt]);
      if(changedNumber(existing.recommended_price_ht,item.recommendedPriceHt))differences.push(['recommended_price_changed','Prix conseillé HT',existing.recommended_price_ht,item.recommendedPriceHt]);
      if(changedNumber(existing.supplier_retail_price_ttc,item.supplierRetailPriceTtc))differences.push(['supplier_retail_price_changed','Prix public fournisseur TTC',existing.supplier_retail_price_ttc,item.supplierRetailPriceTtc]);
      if(item.dataAmountMb!==null&&Number(existing.data_amount_mb||0)!==item.dataAmountMb)differences.push(['product_changed','Volume de données',existing.data_amount_mb,item.dataAmountMb]);
      if(item.durationDays!==null&&Number(existing.duration_days||0)!==item.durationDays)differences.push(['product_changed','Durée',existing.duration_days,item.durationDays]);
      for(const [type,field,oldValue,newValue] of differences){
        await insertChange(connection,{productId:existing.id,transatelId:item.technicalReference,countryIso2,type,field,oldValue,newValue});
      }
      const needsReview=differences.length>0;
      await connection.execute(
        `UPDATE products SET country_iso2=?,name=?,description=?,data_amount_mb=COALESCE(?,data_amount_mb),duration_days=COALESCE(?,duration_days),currency='EUR',purchase_price_ht=?,recommended_price_ht=?,supplier_retail_price_ttc=?,markup_percent=?,selling_price_ht=?,needs_review=CASE WHEN ? THEN TRUE ELSE needs_review END,supplier_change_label=?,raw_data=?,last_price_import_at=NOW() WHERE id=?`,
        [countryIso2,item.technicalReference,item.description,item.dataAmountMb,item.durationDays,item.purchasePriceHt,item.recommendedPriceHt,item.supplierRetailPriceTtc,markup,selling,needsReview,item.sourceChange,JSON.stringify(item),existing.id]
      );
      recalculated++;
      if(needsReview){updated++;priceChanges+=differences.some(change=>change[0].includes('price'))?1:0;}else unchanged++;
    }

    for(const existing of existingRows){
      if(!existing.last_price_import_at||importedReferences.has(existing.transatel_product_id))continue;
      await connection.execute(`UPDATE products SET is_published=FALSE,needs_review=TRUE,supplier_change_label='Absent du nouveau catalogue' WHERE id=?`,[existing.id]);
      await insertChange(connection,{productId:existing.id,transatelId:existing.transatel_product_id,countryIso2:existing.country_iso2,type:'product_removed',field:'Statut fournisseur',oldValue:'Présent le mois précédent',newValue:'Absent du nouveau fichier'});
      removed++;
    }

    await connection.commit();
    await db.query(`UPDATE catalog_imports SET status='success',products_created=?,products_updated=?,prices_changed=?,products_removed=?,finished_at=NOW() WHERE id=?`,[created,updated,priceChanges,removed,importId]);
    return {
      products_received:parsed.products.length,products_created:created,products_updated:updated,
      products_recalculated:recalculated,prices_changed:priceChanges,new_destinations:newDestinations,
      products_removed:removed,unchanged,duplicates:parsed.duplicates.length,default_markup_percent:defaultMarkup
    };
  }catch(error){
    await connection.rollback();
    await db.query(`UPDATE catalog_imports SET status='failed',error_message=?,finished_at=NOW() WHERE id=?`,[String(error.message||error),importId]).catch(()=>{});
    throw error;
  }finally{connection.release();}
}

module.exports={importMonthlyCatalog,readMonthlyCatalog,countryIso2For,allowanceMb,durationDays};
