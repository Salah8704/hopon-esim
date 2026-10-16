'use strict';

const crypto=require('crypto');

function parseCsv(text,delimiter=';'){
  const rows=[];let row=[],cell='',quoted=false;
  for(let index=0;index<text.length;index++){
    const character=text[index];
    if(quoted){
      if(character==='"'&&text[index+1]==='"'){cell+='"';index++;}
      else if(character==='"')quoted=false;
      else cell+=character;
    }else if(character==='"')quoted=true;
    else if(character===delimiter){row.push(cell);cell='';}
    else if(character==='\n'){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell='';}
    else cell+=character;
  }
  if(cell||row.length){row.push(cell.replace(/\r$/,''));rows.push(row);}
  return rows.filter(values=>values.some(value=>String(value).trim()!==''));
}

const clean=value=>String(value??'').trim();
const fold=value=>clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const digits=value=>clean(value).replace(/\D/g,'');

function parseParkCsv(buffer){
  const text=Buffer.isBuffer(buffer)?buffer.toString('utf8'):String(buffer||'');
  const matrix=parseCsv(text.replace(/^\uFEFF/,''));
  if(matrix.length<2)throw new Error('Le fichier parc Transatel est vide');
  const headers=matrix[0].map(clean);
  const required=['Numéro de série','ICCID','IMSI','MSISDN','Statut de provisioning','Statut prépayé','Compte client'];
  const missing=required.filter(header=>!headers.includes(header));
  if(missing.length)throw new Error(`Colonnes Transatel manquantes : ${missing.join(', ')}`);
  const position=Object.fromEntries(headers.map((header,index)=>[header,index]));
  const get=(values,header)=>clean(values[position[header]]);
  const profiles=[];let skipped=0;
  for(const values of matrix.slice(1)){
    const serialNumber=digits(get(values,'Numéro de série'));
    const iccid=digits(get(values,'ICCID'));
    const imsi=digits(get(values,'IMSI'));
    const msisdn=digits(get(values,'MSISDN'));
    if(!/^\d{13,20}$/.test(serialNumber)||!/^\d{13,22}$/.test(iccid)||!/^\d{10,18}$/.test(imsi)||!/^\d{8,20}$/.test(msisdn)){skipped++;continue;}
    const provisioningStatus=get(values,'Statut de provisioning');
    const prepaidStatus=get(values,'Statut prépayé');
    const available=fold(provisioningStatus).startsWith('pre-active')&&fold(prepaidStatus)==='attente 1er appel';
    profiles.push({
      id:crypto.randomUUID(),serialNumber,iccid,imsi,msisdn,
      simType:get(values,'Type de SIM'),simReference:get(values,'Référence de SIM'),
      provisioningStatus,prepaidStatus,
      esimStatus:get(values,'Dernier statut EID'),
      servicePack:get(values,'Pack de services'),ratePlan:get(values,'Plan tarifaire'),
      mvnoRef:get(values,'Compte client'),
      assignmentStatus:available?'available':'unavailable'
    });
  }
  if(!profiles.length)throw new Error('Aucun profil eSIM valide trouvé dans le fichier');
  return {profiles,received:matrix.length-1,skipped};
}

async function importPark(buffer,filename){
  const db=require('./db');
  const parsed=parseParkCsv(buffer);
  const importId=crypto.randomUUID();
  await db.query('INSERT INTO esim_stock_imports(id,filename,status,profiles_received,profiles_skipped) VALUES(?,?,?,?,?)',[importId,filename,'running',parsed.received,parsed.skipped]);
  let inserted=0,updated=0;
  try{
    for(const profile of parsed.profiles){
      const existing=(await db.query('SELECT id FROM esim_profiles WHERE serial_number=? OR iccid=? LIMIT 1',[profile.serialNumber,profile.iccid])).rows[0];
      if(existing){
        await db.query(`UPDATE esim_profiles SET iccid=?,imsi=?,msisdn=?,sim_type=?,sim_reference=?,provisioning_status=?,prepaid_status=?,esim_status=?,service_pack=?,rate_plan=?,mvno_ref=?,assignment_status=CASE WHEN assignment_status IN ('reserved','assigned') THEN assignment_status ELSE ? END,source_filename=?,last_imported_at=NOW() WHERE id=?`,[profile.iccid,profile.imsi,profile.msisdn,profile.simType,profile.simReference,profile.provisioningStatus,profile.prepaidStatus,profile.esimStatus,profile.servicePack,profile.ratePlan,profile.mvnoRef,profile.assignmentStatus,filename,existing.id]);
        updated++;
      }else{
        await db.query(`INSERT INTO esim_profiles(id,serial_number,iccid,imsi,msisdn,sim_type,sim_reference,provisioning_status,prepaid_status,esim_status,service_pack,rate_plan,mvno_ref,assignment_status,source_filename,last_imported_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())`,[profile.id,profile.serialNumber,profile.iccid,profile.imsi,profile.msisdn,profile.simType,profile.simReference,profile.provisioningStatus,profile.prepaidStatus,profile.esimStatus,profile.servicePack,profile.ratePlan,profile.mvnoRef,profile.assignmentStatus,filename]);
        inserted++;
      }
    }
    const available=Number((await db.query(`SELECT COUNT(*) total FROM esim_profiles WHERE assignment_status='available'`)).rows[0]?.total||0);
    await db.query('UPDATE esim_stock_imports SET status=?,profiles_inserted=?,profiles_updated=?,available_after_import=?,finished_at=NOW() WHERE id=?',['success',inserted,updated,available,importId]);
    return {profiles_received:parsed.received,profiles_inserted:inserted,profiles_updated:updated,profiles_skipped:parsed.skipped,available};
  }catch(error){
    await db.query('UPDATE esim_stock_imports SET status=?,error_message=?,finished_at=NOW() WHERE id=?',['failed',String(error.message||error),importId]);
    throw error;
  }
}

module.exports={parseCsv,parseParkCsv,importPark};
