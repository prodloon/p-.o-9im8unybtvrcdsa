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
const { Governor } = require('../governor/governor');

// ---- Task enqueue (dashboard submit path) ----------------------------------
// Lazily-constructed Governor sharing the orchestrator's task_queue DB.
// Access is INSERT-only (enqueueTask), so WAL concurrency with the
// orchestrator is safe.
const TASK_KINDS = new Set(['file-io', 'scaffold', 'generic', 'agent']);
const governor = new Governor({ silent: true });

// --- Chat store (freeform agent conversation) -------------------------------
// The conversation is one thread, persisted to database/chat.json. The user's
// message is appended at enqueue time; the model's reply is appended by the
// refresh loop below when telemetry.agentReply shows the turn landed.
const CHAT_FILE = path.join(
  process.env.DAISY_DATA_DIR || path.join(__dirname, '..', 'database'),
  'chat.json',
);
const CHAT_MAX = 200; // bounded transcript

function readChat() {
  try {
    const raw = JSON.parse(fs.readFileSync(CHAT_FILE, 'utf8'));
    return Array.isArray(raw.messages) ? raw : { messages: [] };
  } catch {
    return { messages: [] };
  }
}

function writeChat(chat) {
  chat.messages = chat.messages.slice(-CHAT_MAX);
  fs.writeFileSync(CHAT_FILE, JSON.stringify(chat, null, 2));
}

function appendChat(role, text, meta = {}) {
  const chat = readChat();
  chat.messages.push({ role, text: String(text).slice(0, 4000), at: Date.now(), ...meta });
  writeChat(chat);
  return chat;
}

// Reply watcher: poll telemetry.json for agentReply newness (the orchestrator
// writes it on AGENT completion). Cheap — one small JSON read per 2s.
let _lastReplyTaskId = null;
try { _lastReplyTaskId = readChat().messages.filter((m) => m.role === 'agent').slice(-1)[0]?.taskId ?? null; } catch {}
setInterval(() => {
  try {
    const t = JSON.parse(fs.readFileSync(TELEMETRY_FILE, 'utf8'));
    const r = t.agentReply;
    if (r && r.taskId && r.taskId !== _lastReplyTaskId) {
      _lastReplyTaskId = r.taskId;
      appendChat('agent', r.reply || '(no reply text)', { taskId: r.taskId, ops: r.ops || [] });
      console.log(`[telemetry] agent reply for task ${r.taskId} appended to chat`);
    }
  } catch { /* telemetry not written yet */ }
}, 2000).unref();

function readJsonBody(req, cb) {
  let body = '';
  req.on('data', (c) => {
    body += c;
    if (body.length > 64 * 1024) req.destroy(); // size cap
  });
  req.on('end', () => {
    try {
      cb(null, JSON.parse(body || '{}'));
    } catch (e) {
      cb(e);
    }
  });
  req.on('error', (e) => cb(e));
}

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
  // CORS preflight for the POST endpoint (Vite dev origin)
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/api/enqueue') {
    readJsonBody(req, (err, body) => {
      if (err) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'invalid JSON body' }));
        return;
      }
      const kind = typeof body.kind === 'string' ? body.kind : 'generic';
      if (!TASK_KINDS.has(kind)) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: `kind must be one of: ${[...TASK_KINDS].join(', ')}` }));
        return;
      }
      const payload = body.payload && typeof body.payload === 'object' ? body.payload : {};
      // Guardrail: a summary is required for AI work — an empty SNIPE task
      // would just burn a tier-2 inference for nothing.
      if (payload.needsSkill && !String(payload.summary || '').trim()) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'payload.summary is required when needsSkill is true' }));
        return;
      }
      const id = governor.enqueueTask(kind, payload);
      console.log(`[telemetry] enqueued task ${id} (kind=${kind}) via dashboard`);
      res.end(JSON.stringify({ ok: true, id, kind }));
    });
    return;
  }

  // --- Freeform agent chat -------------------------------------------------
  // POST /api/chat {message} → enqueues an AGENT task (no trigger words, no
  // skill needed). GET /api/chat → the persisted transcript + pending flag.
  if (req.method === 'POST' && req.url === '/api/chat') {
    readJsonBody(req, (err, body) => {
      if (err) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'invalid JSON body' }));
        return;
      }
      const message = String((body && body.message) || '').trim().slice(0, 4000);
      if (!message) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'message is required' }));
        return;
      }
      const id = governor.enqueueTask('agent', { action: 'AGENT', summary: message });
      appendChat('user', message, { taskId: id });
      console.log(`[telemetry] agent turn enqueued as task ${id} via chat`);
      res.end(JSON.stringify({ ok: true, id }));
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/chat') {
    const chat = readChat();
    res.end(JSON.stringify({ messages: chat.messages }));
    return;
  }

  if (req.method !== 'GET' || !req.url.startsWith('/api/telemetry')) {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'GET /api/telemetry, GET/POST /api/chat, or POST /api/enqueue only' }));
    return;
  }
  res.end(JSON.stringify(readTelemetry()));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[telemetry] http://127.0.0.1:${PORT}/api/telemetry + POST /api/enqueue (loopback only)`);
});

// --- outage watcher: ping when the orchestrator snapshot freezes ------------
// The server keeps answering with the LAST snapshot during an orchestrator
// outage — dashboards can silently go stale on 200 responses (the UI badge
// shows it, but only while open). Nobody watches a dashboard at 3am, so the
// server itself watches telemetry.json's mtime and fires a macOS
// notification on the healthy→stale edge, and once on recovery (with the
// outage duration). Edge-triggered only: a sustained outage notifies ONCE —
// crash-loop escalation is the supervisor guard's job, not spam here.
//   DAISY_ALERT=0             silence notifications (tests) — log lines always fire
//   DAISY_STALE_NOTIFY_MS     staleness threshold override (tests)
const STALE_MS = Number(process.env.DAISY_STALE_NOTIFY_MS) || 10_000; // writes land every ~2–3s
const ALERT_SILENCED = process.env.DAISY_ALERT === '0';

function notifyOutage(msg, sound) {
  console.log(`[telemetry] ALERT: ${msg}`);
  if (ALERT_SILENCED || process.platform !== 'darwin') return;
  require('child_process').execFile('osascript', ['-e',
    `display notification "${msg.replace(/"/g, '\\"')}" with title "Daisy telemetry"${sound ? ` sound name "${sound}"` : ''}`,
  ], () => {}); // best-effort — a failed notification must never touch the server
}

let feedState = 'unknown'; // unknown → healthy ⇄ stale
let staleSince = null;
const watcher = setInterval(() => {
  let mtimeMs = null;
  try {
    mtimeMs = fs.statSync(TELEMETRY_FILE).mtimeMs;
  } catch {}
  const age = mtimeMs == null ? Infinity : Date.now() - mtimeMs;
  const next = age < STALE_MS ? 'healthy' : 'stale';
  if (next === feedState) return;
  const prev = feedState;
  feedState = next;
  if (next === 'stale') {
    // fires for stale AND for boot-time unknown→stale (a server coming up
    // during an outage is a real, current condition worth pinging).
    staleSince = Date.now() - (age === Infinity ? STALE_MS : age);
    const why = mtimeMs == null
      ? `telemetry file missing (${TELEMETRY_FILE})`
      : `orchestrator snapshot frozen ${Math.round(age / 1000)}s`;
    notifyOutage(`${why} — orchestrator down? supervisor should heal within a tick`, 'Basso');
  } else if (prev === 'stale') {
    // recovery only from an actual outage — unknown→healthy at boot is NOT
    // a recovery and must stay silent.
    const dur = staleSince ? Math.round((Date.now() - staleSince) / 1000) : null;
    notifyOutage(`orchestrator back — outage lasted ~${dur ?? '?'}s`);
    staleSince = null;
  }
}, 2000);
watcher.unref?.(); // never keep the process alive just for the watcher
