'use strict';
require('dotenv').config();
const fs=require('fs');
const path=require('path');
const mysql=require('mysql2/promise');

const config={host:process.env.DB_HOST,port:Number(process.env.DB_PORT||3306),database:process.env.DB_NAME,user:process.env.DB_USER,password:process.env.DB_PASSWORD,charset:'utf8mb4'};
const pool=mysql.createPool({...config,waitForConnections:true,connectionLimit:Number(process.env.DB_POOL_MAX||10),queueLimit:0});

async function ensureColumn(connection,table,column,definition){
  const [columns]=await connection.execute(`SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND COLUMN_NAME=?`,[config.database,table,column]);
  if(!columns.length)await connection.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
}

async function indexExists(connection,table,index){
  const [indexes]=await connection.execute(`SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND INDEX_NAME=? LIMIT 1`,[config.database,table,index]);
  return indexes.length>0;
}

async function dropIndex(connection,table,index){
  if(await indexExists(connection,table,index))await connection.query(`ALTER TABLE \`${table}\` DROP INDEX \`${index}\``);
}

async function dropSingleColumnUniqueIndexes(connection,table,column){
  const [indexes]=await connection.execute(`SELECT INDEX_NAME,COUNT(*) column_count,MAX(COLUMN_NAME=?) matches_column FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND NON_UNIQUE=0 AND INDEX_NAME<>'PRIMARY' GROUP BY INDEX_NAME`,[column,config.database,table]);
  for(const index of indexes)if(Number(index.column_count)===1&&Number(index.matches_column)===1)await connection.query(`ALTER TABLE \`${table}\` DROP INDEX \`${index.INDEX_NAME}\``);
}

async function ensureUniqueIndex(connection,table,index,columns){
  if(!await indexExists(connection,table,index))await connection.query(`ALTER TABLE \`${table}\` ADD UNIQUE KEY \`${index}\` (${columns.map(column=>`\`${column}\``).join(',')})`);
}

async function migrate(){
  const connection=await mysql.createConnection({...config,multipleStatements:true});
  try{
    await connection.query(fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8'));
    await ensureColumn(connection,'products','recommended_price_ht','DECIMAL(10,2) NULL AFTER purchase_price_ht');
    await ensureColumn(connection,'products','supplier_retail_price_ttc','DECIMAL(10,2) NULL AFTER recommended_price_ht');
    await ensureColumn(connection,'products','markup_percent','DECIMAL(7,2) NULL AFTER supplier_retail_price_ttc');
    await ensureColumn(connection,'products','needs_review','BOOLEAN NOT NULL DEFAULT FALSE AFTER is_published');
    await ensureColumn(connection,'products','supplier_change_label','VARCHAR(80) NULL AFTER needs_review');
    await ensureColumn(connection,'products','last_price_import_at','DATETIME NULL AFTER last_synced_at');
    await ensureColumn(connection,'orders','stripe_invoice_id','VARCHAR(255) NULL AFTER stripe_payment_intent');
    await ensureColumn(connection,'orders','stripe_livemode','BOOLEAN NOT NULL DEFAULT FALSE AFTER stripe_invoice_id');
    await ensureColumn(connection,'orders','customer_phone','VARCHAR(60) NULL AFTER customer_name');
    await ensureColumn(connection,'orders','customer_address','JSON NULL AFTER customer_phone');
    await ensureColumn(connection,'orders','payer_email','VARCHAR(220) NULL AFTER customer_name');
    await ensureColumn(connection,'orders','payer_name','VARCHAR(180) NULL AFTER payer_email');
    await ensureColumn(connection,'orders','language',"VARCHAR(5) NOT NULL DEFAULT 'fr' AFTER customer_address");
    await ensureColumn(connection,'orders','order_type',"VARCHAR(20) NOT NULL DEFAULT 'new_esim' AFTER customer_address");
    await ensureColumn(connection,'orders','checkout_batch_id','CHAR(36) NULL AFTER order_type');
    await ensureColumn(connection,'orders','batch_item_index','INT NOT NULL DEFAULT 0 AFTER checkout_batch_id');
    await ensureColumn(connection,'orders','esim_profile_id','CHAR(36) NULL AFTER order_type');
    await ensureColumn(connection,'orders','parent_order_id','CHAR(36) NULL AFTER esim_profile_id');
    await ensureColumn(connection,'orders','invoice_sent_at','DATETIME NULL AFTER delivered_at');
    await ensureColumn(connection,'orders','invoice_number','VARCHAR(32) NULL AFTER invoice_sent_at');
    await ensureColumn(connection,'orders','invoice_issued_at','DATETIME NULL AFTER invoice_number');
    await ensureColumn(connection,'orders','recipient_sent_at','DATETIME NULL AFTER invoice_issued_at');
    await ensureColumn(connection,'orders','payer_confirmation_sent_at','DATETIME NULL AFTER recipient_sent_at');
    await ensureColumn(connection,'orders','terms_version','VARCHAR(20) NULL AFTER currency');
    await ensureColumn(connection,'orders','terms_accepted_at','DATETIME NULL AFTER terms_version');
    await ensureColumn(connection,'orders','withdrawal_waiver_at','DATETIME NULL AFTER terms_accepted_at');
    await ensureColumn(connection,'checkout_batches','partner_code','VARCHAR(50) NULL AFTER language');
    await ensureColumn(connection,'checkout_batches','partner_source','VARCHAR(50) NULL AFTER partner_code');
    await ensureColumn(connection,'orders','partner_id','CHAR(36) NULL AFTER parent_order_id');
    await ensureColumn(connection,'orders','partner_source','VARCHAR(50) NULL AFTER partner_id');
    await dropSingleColumnUniqueIndexes(connection,'orders','stripe_session_id');
    await ensureUniqueIndex(connection,'orders','uq_orders_session_item',['stripe_session_id','batch_item_index']);
    await ensureUniqueIndex(connection,'orders','uq_orders_invoice_number',['invoice_number']);
  }finally{await connection.end();}
}
async function query(sql,params=[]){const values=params.map(value=>value&&typeof value==='object'&&!(value instanceof Date)?JSON.stringify(value):value);const [rows]=await pool.execute(sql,values);return {rows:Array.isArray(rows)?rows:[],affectedRows:rows.affectedRows||0};}

async function transaction(work){
  const connection=await pool.getConnection();
  const txQuery=async(sql,params=[])=>{const values=params.map(value=>value&&typeof value==='object'&&!(value instanceof Date)?JSON.stringify(value):value);const [rows]=await connection.execute(sql,values);return {rows:Array.isArray(rows)?rows:[],affectedRows:rows.affectedRows||0};};
  try{await connection.beginTransaction();const result=await work(txQuery);await connection.commit();return result;}
  catch(error){await connection.rollback();throw error;}
  finally{connection.release();}
}

if(process.argv.includes('--migrate'))migrate().then(()=>{console.log('Schéma MySQL prêt');process.exit(0);}).catch(error=>{console.error(error.message);process.exit(1);});
module.exports={query,migrate,pool,transaction};
