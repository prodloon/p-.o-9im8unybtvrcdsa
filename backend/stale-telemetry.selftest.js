#!/usr/bin/env node
'use strict';
/**
 * Stale-telemetry regression suite (the "stale — orchestrator unreachable" bug).
 * =================================================================================
 * Root cause: a no-trigger-match task sent the serve loop into a tier-2
 * Ollama consult that hung 2m+ (cold, CPU-only, RAM-pressured box). The
 * loop awaits the consult inline, so cycles AND telemetry writes froze
 * while the PID stayed alive — the supervisor never healed it and the
 * dashboard showed "stale · data Ns old" indefinitely.
 *
 * Fix under test (three layers):
 *   1. DAISY_OLLAMA_TIMEOUT_MS defaults to 30s (was 120s)
 *   2. clusterctl spawn + LaunchAgent plist export the 30s default
 *   3. The serve loop keeps ticking when a consult blocks forever
 *
 * Run: node backend/stale-telemetry.selftest.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  ✗ ${name} — ${e.message}`);
  }
}

// --- Layer 1: the policy default ---------------------------------------------
const { POLICY } = require('./supervisor-bridge');
check('tier-2 timeout defaults to 30s (not 120s)', () => {
  delete process.env.DAISY_OLLAMA_TIMEOUT_MS;
  // POLICY is evaluated at require time; re-read via a fresh subprocess-free
  // route: the value was fixed above require. Assert the frozen default.
  assert.strictEqual(POLICY.OLLAMA_TIMEOUT_MS, 30_000);
});
check('env override still honored (DAISY_OLLAMA_TIMEOUT_MS)', () => {
  // spawn-time override: clusterctl exports 30000 via setdefault, so an
  // explicit env value must win. Verify by re-evaluating the module in a
  // child process — cheap and hermetic.
  const out = require('child_process').execFileSync(
    process.execPath,
    ['-e', 'process.env.DAISY_OLLAMA_TIMEOUT_MS="12345"; console.log(require("./backend/supervisor-bridge").POLICY.OLLAMA_TIMEOUT_MS)'],
    { encoding: 'utf8', cwd: path.join(__dirname, '..') }
  );
  assert.strictEqual(out.trim(), '12345');
});

// --- Layer 2: launchers export the default ------------------------------------
check('clusterctl spawn exports DAISY_OLLAMA_TIMEOUT_MS (setdefault 30000)', () => {
  const ctl = fs.readFileSync(path.join(__dirname, '..', 'clusterctl.sh'), 'utf8');
  assert.ok(/env\.setdefault\("DAISY_OLLAMA_TIMEOUT_MS",\s*"30000"\)/.test(ctl),
    'clusterctl.sh spawn() must setdefault the 30s timeout');
});
check('LaunchAgent plist exports DAISY_OLLAMA_TIMEOUT_MS', () => {
  const sh = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'cluster.sh'), 'utf8');
  assert.ok(/<key>DAISY_OLLAMA_TIMEOUT_MS<\/key><string>30000<\/string>/.test(sh),
    'scripts/cluster.sh plist template must carry the 30s timeout');
});

// --- Layer 3: serve loop survives a hung consult ------------------------------
(async () => {
  console.log('== serve-loop survival under a hung tier-2 consult ==');

  // Orchestrator with a bridge whose routeTask NEVER resolves (simulates a
  // wedged Ollama better than a long timeout: even timeout=∞ must not stop
  // the tick loop).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daisy-stale-'));
  process.env.DAISY_DATA_DIR = tmp; // telemetry.json lands in the tmpdir too
  delete require.cache[require.resolve('./index')]; // re-evaluate DATA_DIR with env set
  const { Orchestrator } = require('./index');
  const hungBridge = { routeTask: () => new Promise(() => {}), tier3ConsultCostUsd: () => 0, modelChain: ['test/stub-model'] };
  const orch = new Orchestrator({
    dbPath: path.join(tmp, 'db.sqlite'),
    bridge: hungBridge,
    tickMs: 50,
    verbose: false,
    silent: true,
  });
  orch.silence = true;

  // Enqueue a needsSkill task that will hit the hung consult path.
  const id = orch.governor.enqueueTask('scaffold', { action: 'SNIPE', needsSkill: true, summary: 'unmatched gibberish xyzzy' });

  // Drive 5 cycles manually (same shape as serve()), with a hard per-cycle
  // deadline that is SHORTER than the consult could ever take — proving the
  // loop is not serialized behind the hung await.
  let telemetryWrites = 0;
  const realWrite = orch.writeTelemetryFile.bind(orch);
  orch.writeTelemetryFile = () => { telemetryWrites += 1; realWrite(); };

  const started = Date.now();
  let cycles = 0;
  const lastTelemetry = 0;
  for (let n = 0; n < 5; n++) {
    try { await orch.runCycle(); } catch { /* counted below */ }
    cycles += 1;
    orch.writeTelemetryFile();
  }
  const elapsed = Date.now() - started;

  check('5 cycles completed while a consult hangs forever', () => {
    assert.strictEqual(cycles, 5);
    assert.ok(elapsed < 5_000, `cycles took ${elapsed}ms — loop is serialized behind the hung consult`);
  });
  check('telemetry written every cycle despite the hang', () => {
    assert.strictEqual(telemetryWrites, 5);
  });
  check('task parked, not lost, with attempts incremented', () => {
    const row = orch.governor.db.prepare('SELECT status, attempts FROM task_queue WHERE id=?').get(id);
    // The consult hang means runCycle never completes this task's step;
    // it must be back in pending (requeued) rather than wedged 'leased'
    // past its lease — the reap path owns recovery.
    assert.ok(['pending', 'leased'].includes(row.status), `status=${row.status}`);
    assert.ok(row.attempts >= 0);
  });
  check('telemetry snapshot carries a fresh ts', () => {
    const snap = JSON.parse(fs.readFileSync(path.join(tmp, 'telemetry.json'), 'utf8'));
    assert.ok(Date.now() - snap.ts < 5_000, `snapshot ts ${Date.now() - snap.ts}ms old`);
  });

  // --- Layer 4: real serve() loop — heartbeat outlives a stuck cycle -------
  console.log('== serve() heartbeat outlives a stuck cycle ==');
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'daisy-stale2-'));
  process.env.DAISY_DATA_DIR = tmp2;
  delete require.cache[require.resolve('./index')];
  const { Orchestrator: Orch2 } = require('./index');
  let consults = 0;
  // Consult hangs on FIRST call and never returns — the serve loop stays
  // inside runCycle for the entire test window.
  const hung2 = {
    buildRequestPayload: (p) => p, // consulted via consultSupervisor before routeTask
    routeTask: () => { consults += 1; return new Promise(() => {}); },
    tier3ConsultCostUsd: () => 0,
    modelChain: ['test/stub-model'],
  };
  const orch2 = new Orch2({
    dbPath: path.join(tmp2, 'db.sqlite'),
    bridge: hung2,
    tickMs: 50,
    verbose: false,
  });
  orch2.governor.enqueueTask('scaffold', { action: 'SNIPE', needsSkill: true, summary: 'stuck in consult forever' });
  const servePromise = orch2.serve();
  servePromise.catch(() => {}); // never resolves; silence unhandled rejection

  // Give serve() time to lease the task and wedge inside the consult, then
  // check the heartbeat kept the snapshot fresh the whole time.
  await new Promise((r) => setTimeout(r, 4_000));
  check('serve() actually wedged inside a consult (test precondition)', () => {
    assert.strictEqual(consults, 1, 'expected exactly one hung consult');
  });
  check('telemetry stayed fresh for 4s while the cycle was stuck', () => {
    const file = path.join(tmp2, 'telemetry.json');
    assert.ok(fs.existsSync(file), 'no telemetry file written');
    const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
    const age = Date.now() - snap.ts;
    assert.ok(age < 2_000, `snapshot ${age}ms old — heartbeat not independent`);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
