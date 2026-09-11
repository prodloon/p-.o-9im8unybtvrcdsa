#!/usr/bin/env node
/**
 * Daisy Chain — Memory Governor (Phase 1)
 * ========================================
 * Watches system RAM. At >= RAM_HIBERNATE_PCT (80%) it hibernates the
 * lowest-priority, least-recently-active workers until RAM drops below
 * RAM_WAKE_PCT (70%) — hysteresis prevents wake/sleep thrash.
 *
 * Hard ceiling: at >= RAM_SPAWN_BLOCK_PCT (90%) the governor sets a spawn
 * block; the orchestrator must consult `isSpawnBlocked()` before forking
 * new workers.
 *
 * Storage: database/agent-states.sqlite (WAL mode, single writer = governor).
 *
 * Testability: `new Governor({ ramReader, clock, dbPath, silent })` lets the
 * selftest inject synthetic RAM readings and a fake clock. The default
 * ramReader uses OS process stats (no npm dependencies — node:sqlite is
 * built into Node 26).
 *
 * One-time bootstrap (run once, then use the class):
 *   node governor/init-database.js
 */
'use strict';

const { DatabaseSync } = require('node:sqlite');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// --- Policy constants (documented contract in ../knowledge.md §4) -----------
const RAM_HIBERNATE_PCT = 80;   // start hibernating at this usage
const RAM_WAKE_PCT = 70;        // hibernate until usage drops below this
const RAM_SPAWN_BLOCK_PCT = 90; // stop allowing new spawns
const STALE_MS = 30_000;        // heartbeat older than this => reap row
const LEASE_GRACE_MS = 10_000;  // lease expired this long ago => requeue task
const THRASH_WAKE_HOURLY = 10;  // wakes/hour before flagging thrash suspect
const POLL_INTERVAL_MS = 2_000; // production poll cadence

// --- Defaults ---------------------------------------------------------------
const DEFAULT_TOTAL_RAM = 16 * 1024 * 1024 * 1024; // 16 GiB; overridable
const DEFAULT_DB_PATH = path.join(__dirname, '..', 'database', 'agent-states.sqlite');

/** Read total+used system RAM on macOS/Linux without npm deps. */
function systemRamReader() {
  if (process.platform === 'darwin') {
    // vm_stat output: "Pages active: 1384537." (page size 4096)
    const pageSize = 4096;
    const vm = execFileSync('vm_stat', { encoding: 'utf8' });
    const grab = (label) => {
      const m = vm.match(new RegExp(`${label}:\\s+(\\d+)`));
      return m ? Number(m[1]) : 0;
    };
    const usedPages =
      grab('Pages active') + grab('Pages wired down') + grab('Pages occupied by compressor');
    const hw = execFileSync('sysctl', ['-n', 'hw.memsize'], { encoding: 'utf8' });
    const total = Number(hw.trim()) || DEFAULT_TOTAL_RAM;
    return { totalBytes: total, usedBytes: usedPages * pageSize };
  }
  // Linux fallback
  const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
  const kb = (label) => {
    const m = meminfo.match(new RegExp(`^${label}:\\s+(\\d+) kB`, 'm'));
    return m ? Number(m[1]) * 1024 : 0;
  };
  const total = kb('MemTotal') || DEFAULT_TOTAL_RAM;
  const used = total - (kb('MemAvailable') || 0);
  return { totalBytes: total, usedBytes: used };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workers (
    id             TEXT PRIMARY KEY,
    kind           TEXT NOT NULL,
    state          TEXT NOT NULL CHECK (state IN ('running','hibernating','zombie')),
    priority       INTEGER NOT NULL DEFAULT 5,
    ram_bytes      INTEGER,
    spawned_at     INTEGER NOT NULL,
    last_heartbeat INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS worker_states (
    worker_id     TEXT PRIMARY KEY REFERENCES workers(id) ON DELETE CASCADE,
    state_json    TEXT NOT NULL,
    task_payload  TEXT,
    hibernated_at INTEGER NOT NULL,
    wake_count    INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS task_queue (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    kind          TEXT NOT NULL,
    payload_json  TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','leased','done','failed')),
    leased_by     TEXT REFERENCES workers(id),
    lease_expires INTEGER,
    attempts      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    finished_at   INTEGER
);
CREATE TABLE IF NOT EXISTS governor_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,
    event       TEXT NOT NULL,
    worker_id   TEXT,
    detail_json TEXT
);
CREATE TABLE IF NOT EXISTS skill_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         INTEGER NOT NULL,
    worker_id  TEXT,
    skill_name TEXT NOT NULL,
    source     TEXT NOT NULL,
    outcome    TEXT
);
CREATE INDEX IF NOT EXISTS idx_workers_state ON workers(state, priority);
CREATE INDEX IF NOT EXISTS idx_queue_status  ON task_queue(status);
CREATE INDEX IF NOT EXISTS idx_lease_expiry  ON task_queue(lease_expires);
`;

class Governor {
  /**
   * @param {object} [opts]
   * @param {string}   [opts.dbPath]       SQLite file (default database/agent-states.sqlite)
   * @param {Function} [opts.ramReader]    () => { totalBytes, usedBytes }   (injectable)
   * @param {Function} [opts.clock]        () => ms timestamp               (injectable)
   * @param {boolean}  [opts.silent]       suppress console chatter
   */
  constructor(opts = {}) {
    this.dbPath = opts.dbPath || DEFAULT_DB_PATH;
    this.ramReader = opts.ramReader || systemRamReader;
    this.clock = opts.clock || (() => Date.now());
    this.silent = !!opts.silent;

    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);

    this.spawnBlocked = false;
    this._hibernating = false; // inside the 80→70 descent?
    this._wakeCounts = new Map(); // worker_id -> [timestamps of wakes]
  }

  log(event, workerId = null, detail = null) {
    this.db
      .prepare('INSERT INTO governor_log (ts, event, worker_id, detail_json) VALUES (?, ?, ?, ?)')
      .run(this.clock(), event, workerId, detail ? JSON.stringify(detail) : null);
    if (!this.silent) console.log(`[governor] ${event}${workerId ? ` ${workerId}` : ''}`);
  }

  // --- Worker lifecycle -----------------------------------------------------

  registerWorker(id, kind, { priority = 5, ramBytes = null } = {}) {
    const now = this.clock();
    this.db
      .prepare(
        `INSERT INTO workers (id, kind, state, priority, ram_bytes, spawned_at, last_heartbeat)
         VALUES (?, ?, 'running', ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET state='running', last_heartbeat=excluded.last_heartbeat`
      )
      .run(id, kind, priority, ramBytes, now, now);
    return id;
  }

  heartbeat(workerId, ramBytes = null) {
    const now = this.clock();
    const res = this.db
      .prepare('UPDATE workers SET last_heartbeat = ?, ram_bytes = COALESCE(?, ram_bytes) WHERE id = ?')
      .run(now, ramBytes, workerId);
    if (res.changes > 0) return true;
    // Defensive upsert: a worker heartbeating without a row (e.g. constructed
    // outside the pool) still gets one, so FKs and reapers have real data.
    this.db
      .prepare(
        "INSERT INTO workers (id, kind, state, priority, ram_bytes, spawned_at, last_heartbeat) VALUES (?, 'unregistered', 'running', 5, ?, ?, ?)"
      )
      .run(workerId, ramBytes, now, now);
    return true;
  }

  /** node:sqlite binds only primitives — serialize objects defensively. */
  _serialize(value) {
    if (value == null) return null;
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
  }

  _deserialize(value) {
    if (value == null) return null;
    try {
      return JSON.parse(value);
    } catch {
      return value; // was stored as a plain string
    }
  }

  /** Serialize + hibernate a worker. `state` must be JSON-serializable. */
  hibernate(workerId, state, taskPayload = null) {
    const now = this.clock();
    const row = this.db.prepare('SELECT state FROM workers WHERE id = ?').get(workerId);
    if (!row) throw new Error(`hibernate: unknown worker ${workerId}`);
    if (row.state === 'hibernating') return false;

    this.db
      .prepare(
        `INSERT INTO worker_states (worker_id, state_json, task_payload, hibernated_at, wake_count)
         VALUES (?, ?, ?, ?, 0)
         ON CONFLICT(worker_id) DO UPDATE SET
           state_json=excluded.state_json, task_payload=excluded.task_payload,
           hibernated_at=excluded.hibernated_at`
      )
      .run(workerId, JSON.stringify(state), this._serialize(taskPayload), now);
    this.db.prepare("UPDATE workers SET state='hibernating' WHERE id = ?").run(workerId);
    this.log('hibernate', workerId, { taskPayload: !!taskPayload });
    return true;
  }

  /** Wake a hibernated worker: restores state, bumps wake_count, thrash tracking. */
  wake(workerId) {
    const now = this.clock();
    const snap = this.db.prepare('SELECT * FROM worker_states WHERE worker_id = ?').get(workerId);
    if (!snap) throw new Error(`wake: no hibernated state for ${workerId}`);

    const wakes = (this._wakeCounts.get(workerId) || []).filter((t) => now - t < 3_600_000);
    wakes.push(now);
    this._wakeCounts.set(workerId, wakes);
    if (wakes.length > THRASH_WAKE_HOURLY) {
      this.log('thrash_suspect', workerId, { wakes_last_hour: wakes.length });
    }

    this.db.prepare('UPDATE worker_states SET wake_count = wake_count + 1 WHERE worker_id = ?').run(workerId);
    this.db.prepare("UPDATE workers SET state='running', last_heartbeat=? WHERE id = ?").run(now, workerId);
    this.db.prepare('DELETE FROM worker_states WHERE worker_id = ?').run(workerId);
    this.log('wake', workerId);
    return { state: JSON.parse(snap.state_json), taskPayload: this._deserialize(snap.task_payload) };
  }

  // --- Reapers ---------------------------------------------------------------

  reapStaleWorkers() {
    const now = this.clock();
    const stale = this.db
      .prepare("SELECT id FROM workers WHERE state != 'zombie' AND last_heartbeat < ?")
      .all(now - STALE_MS);
    for (const { id } of stale) {
      this.db.prepare("UPDATE workers SET state='zombie' WHERE id = ?").run(id);
      this.log('reap', id);
    }
    return stale.map((r) => r.id);
  }

  /** Requeue tasks whose lease expired (worker died mid-task). */
  reapExpiredLeases() {
    const now = this.clock();
    const expired = this.db
      .prepare("SELECT id, leased_by FROM task_queue WHERE status='leased' AND lease_expires < ?")
      .all(now - LEASE_GRACE_MS);
    for (const t of expired) {
      this.db
        .prepare(
          "UPDATE task_queue SET status='pending', leased_by=NULL, lease_expires=NULL, attempts=attempts+1 WHERE id = ?"
        )
        .run(t.id);
      this.log('lease_requeue', t.leased_by, { task_id: t.id });
    }
    return expired.map((t) => t.id);
  }

  // --- Task queue ------------------------------------------------------------

  enqueueTask(kind, payload) {
    const res = this.db
      .prepare('INSERT INTO task_queue (kind, payload_json, created_at) VALUES (?, ?, ?)')
      .run(kind, JSON.stringify(payload), this.clock());
    return Number(res.lastInsertRowid);
  }

  /**
   * Atomically lease one pending task to a worker.
   * BEGIN IMMEDIATE so two workers cannot lease the same task
   * (node:sqlite has no .transaction() helper — manual is correct).
   * @param {string|null} [kindFilter] only lease tasks of this kind (null = any)
   */
  leaseNextTask(workerId, { leaseMs = 60_000, kindFilter = null } = {}) {
    const now = this.clock();
    let task = null;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      task = this.db
        .prepare(
          kindFilter
            ? "SELECT id, kind, payload_json, attempts FROM task_queue WHERE status='pending' AND kind = ? ORDER BY id LIMIT 1"
            : "SELECT id, kind, payload_json, attempts FROM task_queue WHERE status='pending' ORDER BY id LIMIT 1"
        )
        .get(...(kindFilter ? [kindFilter] : []));
      if (task) {
        this.db
          .prepare("UPDATE task_queue SET status='leased', leased_by=?, lease_expires=? WHERE id=?")
          .run(workerId, now + leaseMs, task.id);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* nothing to roll back */
      }
      throw err;
    }
    if (task) {
      try {
        task.payload = JSON.parse(task.payload_json);
      } catch {
        task.payload = null;
      }
    }
    return task || null;
  }

  completeTask(taskId, ok = true) {
    this.db
      .prepare('UPDATE task_queue SET status=?, finished_at=? WHERE id=?')
      .run(ok ? 'done' : 'failed', this.clock(), taskId);
  }

  // --- The main policy loop ---------------------------------------------------

  /** One pass of the policy. Returns a summary of what it did. */
  tick() {
    const { totalBytes, usedBytes } = this.ramReader();
    const pct = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
    const actions = { pct: Math.round(pct * 10) / 10, hibernated: 0, woken: 0 };

    if (pct >= RAM_SPAWN_BLOCK_PCT) {
      if (!this.spawnBlocked) {
        this.spawnBlocked = true;
        this.log('spawn_blocked', null, { pct });
      }
    } else if (pct < RAM_WAKE_PCT && this.spawnBlocked) {
      this.spawnBlocked = false;
      this.log('spawn_unblocked', null, { pct });
    }

    if (pct >= RAM_HIBERNATE_PCT) {
      this._hibernating = true;
      const victims = this.db
        .prepare(
          `SELECT id FROM workers WHERE state='running'
           ORDER BY priority DESC, last_heartbeat ASC`
        )
        .all();
      for (const { id } of victims) {
        if (pct < RAM_HIBERNATE_PCT) break; // reached hysteresis floor
        // The orchestrator serializes real state; governor hibernates with a
        // tombstone snapshot when called directly (selftest / emergency).
        this.hibernate(id, { tombstone: true, hibernatedBy: 'governor' });
        actions.hibernated += 1;
      }
    } else if (pct < RAM_WAKE_PCT && this._hibernating) {
      this._hibernating = false; // descended through the hysteresis band
    }

    this.reapStaleWorkers();
    this.reapExpiredLeases();
    return actions;
  }

  isSpawnBlocked() {
    return this.spawnBlocked;
  }

  /** Record a skill-sniping event (used by the orchestrator's injector). */
  logSkillEvent(workerId, skillName, source, outcome) {
    this.db
      .prepare('INSERT INTO skill_events (ts, worker_id, skill_name, source, outcome) VALUES (?, ?, ?, ?, ?)')
      .run(this.clock(), workerId, skillName, source, outcome);
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

module.exports = {
  Governor,
  systemRamReader,
  SCHEMA,
  POLICY: {
    RAM_HIBERNATE_PCT,
    RAM_WAKE_PCT,
    RAM_SPAWN_BLOCK_PCT,
    STALE_MS,
    LEASE_GRACE_MS,
    THRASH_WAKE_HOURLY,
    POLL_INTERVAL_MS,
  },
};

if (require.main === module) {
  const gov = new Governor();
  const stats = gov.db.prepare('SELECT COUNT(*) AS n FROM workers').get();
  console.log(`governor ready — db=${gov.dbPath} workers=${stats.n}`);
  console.log(`policy: hibernate>=${RAM_HIBERNATE_PCT}% wake<${RAM_WAKE_PCT}% spawnBlock>=${RAM_SPAWN_BLOCK_PCT}%`);
  gov.close();
}
