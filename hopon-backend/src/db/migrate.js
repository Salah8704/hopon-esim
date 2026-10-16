// src/db/migrate.js
'use strict';
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function migrate() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const files = ['schema.sql', 'schema_partners.sql'];
  try {
    for (const file of files) {
      const sql = fs.readFileSync(path.join(__dirname, file), 'utf8');
      await pool.query(sql);
      console.log(`✅ ${file}`);
    }
    console.log('✅ Migration terminée');
  } catch (e) {
    console.error('❌ Erreur migration:', e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}
migrate();
