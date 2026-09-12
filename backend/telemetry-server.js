#!/usr/bin/env node
'use strict';
/**
 * Daisy Chain — Telemetry HTTP Server (Phase 5 fallback transport)
 * =================================================================
 * Serves database/telemetry.json on a loopback port for the React UI
 * when it runs under plain Vite instead of the Tauri shell (which uses
 * the file watch instead). Same shape, same cadence — the UI code is
 * identical under both transports.
 *
 *   node backend/telemetry-server.js [--port 6292]
 *
 * Loopback-only (127.0.0.1), mirrors the daisy_ui.py binding policy.
 * CORS: '*' so the Vite dev server origin can read it — harmless since
 * the payload contains no secrets and the port is not reachable off-host.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// Same override as the orchestrator — installed-app mode redirects data dir.
const TELEMETRY_FILE = path.join(
  process.env.DAISY_DATA_DIR || path.join(__dirname, '..', 'database'),
  'telemetry.json'
);
const PORT = (() => {
  const i = process.argv.indexOf('--port');
  return i > -1 ? Number(process.argv[i + 1]) || 6292 : 6292;
})();

function readTelemetry() {
  try {
    return JSON.parse(fs.readFileSync(TELEMETRY_FILE, 'utf8'));
  } catch {
    return { ts: null, error: 'telemetry file not ready — is the orchestrator running (--serve)?' };
  }
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  // The payload is a live gauge — browsers must never heuristic-cache it.
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' || !req.url.startsWith('/api/telemetry')) {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'GET /api/telemetry only' }));
    return;
  }
  res.end(JSON.stringify(readTelemetry()));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[telemetry] http://127.0.0.1:${PORT}/api/telemetry (loopback only)`);
});
