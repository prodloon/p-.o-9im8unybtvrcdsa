#!/usr/bin/env node
'use strict';
/** One-time bootstrap: create database/agent-states.sqlite with the full schema. */
const { Governor } = require('./governor');

const gov = new Governor({ silent: true });
const workers = gov.db.prepare('SELECT COUNT(*) AS n FROM workers').get();
const tables = gov.db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all()
  .map((r) => r.name);

console.log(`✓ database ready: ${gov.dbPath}`);
console.log(`  tables: ${tables.join(', ')}`);
console.log(`  existing workers: ${workers.n}`);
gov.close();
