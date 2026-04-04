// src/jobs/syncCatalog.js — run: node src/jobs/syncCatalog.js
'use strict';
require('dotenv').config();
const catalogSvc = require('../services/catalog');
const logger     = require('../utils/logger');

(async () => {
  logger.info('[Sync] Démarrage sync catalogue manuelle');
  try {
    const result = await catalogSvc.syncCatalog({ mode: 'full', throttleMs: 300 });
    logger.info(`[Sync] Terminée: ${JSON.stringify(result.stats)}`);
    process.exit(0);
  } catch (e) {
    logger.error(`[Sync] Erreur: ${e.message}`);
    process.exit(1);
  }
})();
