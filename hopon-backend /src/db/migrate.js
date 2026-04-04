// src/db/migrate.js
'use strict';
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function migrate() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const sql  = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  try {
    await pool.query(sql);
    console.log('✅ Migration terminée');
  } catch (e) {
    console.error('❌ Erreur migration:', e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}
migrate();
