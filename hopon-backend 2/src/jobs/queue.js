// src/jobs/queue.js
'use strict';
const Bull   = require('bull');
const logger = require('../utils/logger');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const queue = new Bull('hopon-esim', REDIS_URL, {
  defaultJobOptions: {
    attempts: 5,
    backoff:  { type: 'exponential', delay: 10000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: false,
  },
});

const worker = queue;

queue.on('error', err => {
  logger.error(`[Queue] Erreur Redis/Bull: ${err.message}`);
});

module.exports = { queue, worker };
