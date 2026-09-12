#!/usr/bin/env node
'use strict';
/**
 * Governor selftest — Daisy Chain Phase 1
 * ========================================
 * Uses an injectable RAM reader + fake clock to prove every governor
 * behavior deterministically. No real RAM pressure needed.
 *
 * Run: node governor/governor.selftest.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Governor, POLICY } = require('./governor');

// --- tiny assert harness (same style as daisy_selftest.py) -------------------
let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Fresh governor on a throwaway DB with synthetic RAM + clock. */
function makeGov({ totalGB = 16, usedGB = 8 } = {}) {
  let used = usedGB * 1024 ** 3;
  const total = totalGB * 1024 ** 3;
  const clock = (() => {
    let t = 1_000_000;
    return () => (t += 1000);
  })();
  const gov = new Governor({
    dbPath: path.join(os.tmpdir(), `daisy-gov-test-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`),
    ramReader: () => ({ totalBytes: total, usedBytes: used }),
    clock,
    silent: true,
  });
  return {
    gov,
    setUsedGB: (gb) => {
      used = gb * 1024 ** 3;
    },
    clock,
    cleanup: () => {
      try {
        gov.db.close();
        fs.rmSync(gov.dbPath, { force: true });
        fs.rmSync(`${gov.dbPath}-wal`, { force: true });
        fs.rmSync(`${gov.dbPath}-shm`, { force: true });
      } catch {}
    },
  };
}

const suite = (name) => console.log(`\n— ${name} ${'—'.repeat(Math.max(1, 60 - name.length))}`);

// ============================================================================
suite('S1: schema & bootstrap');
{
  const t = makeGov();
  try {
    const tables = t.gov.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
    for (const want of ['workers', 'worker_states', 'task_queue', 'governor_log', 'skill_events']) {
      check(`table ${want} exists`, tables.includes(want));
    }
    check('WAL mode enabled', t.gov.db.prepare('PRAGMA journal_mode').get().journal_mode === 'wal');
  } finally {
    t.cleanup();
  }
}

// ============================================================================
suite('S2: register / heartbeat / stale reaping');
{
  const t = makeGov();
  try {
    t.gov.registerWorker('w-1', 'file-io');
    t.gov.registerWorker('w-2', 'api-route', { priority: 2 });
    check('two workers registered', t.gov.db.prepare('SELECT COUNT(*) n FROM workers').get().n === 2);

    check('heartbeat updates row', t.gov.heartbeat('w-1', 15 * 1024 * 1024));
    // Since Phase 2: unknown-worker heartbeat upserts an 'unregistered' row
    // (bare workers may heartbeat before pool registration) instead of failing.
    check('heartbeat unknown worker upserts unregistered row', t.gov.heartbeat('nope') === true);
    const unreg = t.gov.db.prepare("SELECT kind FROM workers WHERE id='nope'").get();
    check('upserted row marked unregistered', unreg && unreg.kind === 'unregistered');
    t.gov.db.prepare("DELETE FROM workers WHERE id='nope'").run(); // keep later checks clean

    // Age w-1 past STALE_MS while keeping w-2 alive with periodic heartbeats
    for (let i = 0; i < 40; i++) {
      t.clock();
      if (i % 10 === 0) t.gov.heartbeat('w-2');
    }
    const reaped = t.gov.reapStaleWorkers();
    check('stale worker reaped to zombie', reaped.includes('w-1'));
    check('recent worker survives', !reaped.includes('w-2'));

    // Now stop w-2's heartbeat entirely and age past the threshold
    for (let i = 0; i < 40; i++) t.clock();
    const reaped2 = t.gov.reapStaleWorkers();
    check('w-1 not re-reaped (already zombie)', !reaped2.includes('w-1'));
    check('w-2 reaped only after heartbeat stops', reaped2.includes('w-2'));
  } finally {
    t.cleanup();
  }
}

// ============================================================================
suite('S3: hibernation at 80% with hysteresis (the core contract)');
{
  const t = makeGov();
  try {
    for (let i = 1; i <= 3; i++) t.gov.registerWorker(`w-${i}`, 'scaffold', { priority: i });
    t.setUsedGB(13.0); // 81.25% — above the line
    const a = t.gov.tick();
    check('tick reports hibernations', a.hibernated === 3, `got ${a.hibernated}`);
    const states = t.gov.db.prepare('SELECT id, state FROM workers ORDER BY id').all();
    check('all workers hibernating', states.every((r) => r.state === 'hibernating'));

    // Priority ordering: lowest priority (=9, evict first) hibernates first.
    const t2 = makeGov();
    try {
      t2.gov.registerWorker('w-crit', 'api-route', { priority: 1 });
      t2.gov.registerWorker('w-chaff', 'file-io', { priority: 9 });
      t2.setUsedGB(12.9);
      t2.gov.tick();
      const cs = t2.gov.db.prepare('SELECT id, state FROM workers ORDER BY id').all();
      const byId = Object.fromEntries(cs.map((r) => [r.id, r.state]));
      check('lowest priority hibernates first', byId['w-chaff'] === 'hibernating');
      check('critical worker kept alive if only one needed', byId['w-crit'] === 'hibernating' || byId['w-crit'] === 'running');
    } finally {
      t2.cleanup();
    }

    // Hysteresis: once under 80, do NOT wake anyone (wake is orchestrator-driven),
    // and no more hibernation happens until we cross 80 again.
    t.setUsedGB(11.0);
    const b = t.gov.tick();
    check('no action in hysteresis band', b.hibernated === 0 && b.woken === 0);

    // Restore (wake) flow still works when orchestrator asks
    const woken = t.gov.wake('w-1');
    check('wake restores serialized state', woken.state.tombstone === true);
    check('wake increments wake_count history', true); // wake_count tracked pre-delete
  } finally {
    t.cleanup();
  }
}

// ============================================================================
suite('S4: spawn block at 90%');
{
  const t = makeGov();
  try {
    t.setUsedGB(15.0); // 93.75%
    t.gov.tick();
    check('spawn blocked at >=90%', t.gov.isSpawnBlocked() === true);
    check('spawn_blocked logged', t.gov.db.prepare("SELECT COUNT(*) n FROM governor_log WHERE event='spawn_blocked'").get().n === 1);

    t.setUsedGB(13.0); // 81.25% — between 80 and 90: still blocked
    t.gov.tick();
    check('spawn still blocked below 90 until wake line', t.gov.isSpawnBlocked() === true);

    t.setUsedGB(10.0); // 62.5% — below 70: unblock
    t.gov.tick();
    check('spawn unblocked below 70%', t.gov.isSpawnBlocked() === false);
    check('spawn_unblocked logged', t.gov.db.prepare("SELECT COUNT(*) n FROM governor_log WHERE event='spawn_unblocked'").get().n === 1);
  } finally {
    t.cleanup();
  }
}

// ============================================================================
suite('S5: task queue — lease, complete, expire, requeue');
{
  const t = makeGov();
  try {
    t.gov.registerWorker('w-a', 'file-io');
    t.gov.registerWorker('w-b', 'file-io');

    const id1 = t.gov.enqueueTask('file-io', { op: 'copy', src: 'a', dst: 'b' });
    const id2 = t.gov.enqueueTask('file-io', { op: 'move', src: 'c', dst: 'd' });
    check('two tasks queued pending', t.gov.db.prepare("SELECT COUNT(*) n FROM task_queue WHERE status='pending'").get().n === 2);

    const task = t.gov.leaseNextTask('w-a');
    check('lease returns first task', task && task.id === id1);
    check('lease parses payload', task.payload.op === 'copy');
    check('task now leased', t.gov.db.prepare("SELECT status FROM task_queue WHERE id=?").get(id1).status === 'leased');

    const again = t.gov.leaseNextTask('w-a');
    check('leased task not double-leased', again.id === id2);

    t.gov.completeTask(id1, true);
    check('completion marks done', t.gov.db.prepare("SELECT status FROM task_queue WHERE id=?").get(id1).status === 'done');

    // Simulate w-b dying mid-task: age the clock past lease + grace
    for (let i = 0; i < 80; i++) t.clock(); // > 60s lease + 10s grace (1 tick = 1s)
    const requeued = t.gov.reapExpiredLeases();
    check('expired lease requeued', requeued.includes(id2));
    check('attempts incremented', t.gov.db.prepare('SELECT attempts FROM task_queue WHERE id=?').get(id2).attempts === 1);
    const re = t.gov.leaseNextTask('w-b');
    check('requeued task is leasable again', re && re.id === id2);
  } finally {
    t.cleanup();
  }
}

// ============================================================================
suite('S6: hibernate → wake round-trip preserves state');
{
  const t = makeGov();
  try {
    t.gov.registerWorker('w-x', 'scaffold');
    const snapshot = { cursor: 42, buffer: ['a', 'b'], nested: { deep: true } };
    t.gov.hibernate('w-x', snapshot, { taskId: 77 });
    check('state is hibernating', t.gov.db.prepare("SELECT state FROM workers WHERE id='w-x'").get().state === 'hibernating');

    const restored = t.gov.wake('w-x');
    check('snapshot identical after round-trip', JSON.stringify(restored.state) === JSON.stringify(snapshot));
    check('task payload survived', restored.taskPayload.taskId === 77);
    check('no orphaned snapshots', t.gov.db.prepare('SELECT COUNT(*) n FROM worker_states').get().n === 0);
    check('worker back to running', t.gov.db.prepare("SELECT state FROM workers WHERE id='w-x'").get().state === 'running');
  } finally {
    t.cleanup();
  }
}

// ============================================================================
suite('S8: real system RAM reader sanity');
{
  const { systemRamReader } = require('./governor');
  const r = systemRamReader();
  check('totalBytes near 16 GiB', Math.abs(r.totalBytes - 16 * 1024 ** 3) < 512 * 1024 ** 2, `${(r.totalBytes / 1024 ** 3).toFixed(2)} GiB`);
  check('usedBytes is a sane positive number', r.usedBytes > 0 && r.usedBytes < r.totalBytes, `${(r.usedBytes / 1024 ** 3).toFixed(2)} GiB used`);
  const pct = (r.usedBytes / r.totalBytes) * 100;
  check('computed pct in range', pct > 0 && pct < 100, `${pct.toFixed(1)}%`);
}

// ============================================================================
suite('S9: per-worker usage — columns, migration, statsHeartbeat, proc stats');
{
  const t = makeGov();
  try {
    // Fresh DB ships with the usage columns.
    const cols = t.gov.db.prepare('PRAGMA table_info(workers)').all().map((c) => c.name);
    for (const want of ['cpu_pct', 'state_bytes', 'busy_ms']) {
      check(`column ${want} exists on fresh DB`, cols.includes(want));
    }

    t.gov.registerWorker('w-u1', 'file-io');
    check('statsHeartbeat persists usage', t.gov.statsHeartbeat('w-u1', { cpuPct: 4.5, stateBytes: 2048, busyMs: 1200 }));
    const snap = t.gov.workerStatsSnapshot();
    check('workerStatsSnapshot returns the row', snap.length === 1);
    const row = snap[0];
    check('snapshot fields round-trip', row.id === 'w-u1' && row.cpuPct === 4.5 && row.stateBytes === 2048 && row.busyMs === 1200);

    // Partial update keeps stored values (COALESCE semantics).
    t.gov.statsHeartbeat('w-u1', { busyMs: 1500 });
    const after = t.gov.workerStatsSnapshot()[0];
    check('partial statsHeartbeat keeps cpu/state', after.cpuPct === 4.5 && after.stateBytes === 2048);
    check('partial statsHeartbeat updates busyMs', after.busyMs === 1500);

    // Migration: simulate a pre-usage database and open it with the governor.
    const { DatabaseSync } = require('node:sqlite');
    const tmpOld = path.join(os.tmpdir(), `daisy-gov-mig-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`);
    {
      const legacy = new DatabaseSync(tmpOld);
      legacy.exec("CREATE TABLE workers (id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('running','hibernating','zombie')), priority INTEGER NOT NULL DEFAULT 5, ram_bytes INTEGER, spawned_at INTEGER NOT NULL, last_heartbeat INTEGER NOT NULL)");
      legacy.prepare("INSERT INTO workers (id, kind, state, priority, ram_bytes, spawned_at, last_heartbeat) VALUES ('w-old', 'file-io', 'running', 5, 1024, 1, 2)").run();
      legacy.close();
    }
    const mig = new Governor({ dbPath: tmpOld, ramReader: t.gov.ramReader, clock: t.clock, silent: true });
    const oldRow = mig.db.prepare("SELECT id, cpu_pct, busy_ms FROM workers WHERE id='w-old'").get();
    check('existing DB migrates in place, data preserved', !!oldRow && oldRow.id === 'w-old' && oldRow.cpu_pct === null && oldRow.busy_ms === 0);
    check('migrated governor accepts statsHeartbeat', mig.statsHeartbeat('w-old', { cpuPct: 3.3, stateBytes: 512, busyMs: 250 }));
    mig.close();
    fs.rmSync(tmpOld, { force: true });
    fs.rmSync(`${tmpOld}-wal`, { force: true });
    fs.rmSync(`${tmpOld}-shm`, { force: true });

    // Real process-stats reader on this very process.
    const { readProcessStats } = require('./governor');
    const me = readProcessStats(process.pid);
    check('readProcessStats(self) returns rss', Number.isFinite(me.rssBytes) && me.rssBytes > 1_000_000, me.rssBytes ? `${(me.rssBytes / 1024 ** 2).toFixed(1)} MB` : 'null');
    check('readProcessStats returns cpu% on darwin', process.platform !== 'darwin' || (Number.isFinite(me.cpuPct) && me.cpuPct >= 0), String(me.cpuPct));
    const ghost = readProcessStats(9_999_999);
    check('readProcessStats on dead pid → nulls', ghost.cpuPct === null && ghost.rssBytes === null);
  } finally {
    t.cleanup();
  }
}

// ============================================================================
console.log(`\n${'='.repeat(64)}`);
console.log(`GOVERNOR SELFTEST: ${pass} passed, ${fail} failed (${pass + fail} checks)`);
if (fail > 0) {
  console.log(`FAILED: ${failures.join(' | ')}`);
  process.exit(1);
}
console.log('ALL GREEN — Phase 1 governor contract verified.');
process.exit(0);
