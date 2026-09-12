#!/usr/bin/env node
'use strict';
/**
 * Daisy Chain — Backend Selftest (Phases 2+3)
 * ============================================
 * Deterministic: cloud is a mocked fetchImpl, RAM is synthetic, clock is fake.
 * Run: node backend/backend.selftest.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Governor } = require('../governor/governor');
const { Worker } = require('./worker');
const { WorkerPool } = require('./worker-pool');
const { SupervisorBridge, POLICY } = require('./supervisor-bridge');
const { SkillInjector } = require('./skill-injector');
const { Orchestrator } = require('./index');

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
const suite = (name) => console.log(`\n— ${name} ${'—'.repeat(Math.max(1, 60 - name.length))}`);

/** Throwaway workspace: temp sandbox + temp sqlite + fake clock + synthetic RAM. */
function makeEnv({ usedGB = 8, totalGB = 16 } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daisy-backend-'));
  let used = usedGB * 1024 ** 3;
  let t = 1_000_000;
  const clock = () => (t += 1000);
  const governor = new Governor({
    dbPath: path.join(tmp, 'test.sqlite'),
    ramReader: () => ({ totalBytes: totalGB * 1024 ** 3, usedBytes: used }),
    clock,
    silent: true,
  });
  const cleanup = () => {
    try {
      governor.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  };
  return { tmp, governor, clock, cleanup, setUsedGB: (g) => (used = g * 1024 ** 3) };
}

/** OpenRouter-shaped 200 response for a given content string. */
function openRouterResponse(content) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

const SKILL_DIR = path.join(__dirname, '..', 'skillbase');

async function main() {
  // ============================================================================
  suite('S1: worker — deterministic actions + sandbox jail');
  {
    const env = makeEnv();
    try {
      const w = new Worker({ id: 'w-t1', kind: 'file-io', governor: env.governor, root: env.tmp });
      const r1 = await w.step({ id: 1, kind: 'file-io', payload: { action: 'write_file', params: { path: 'a/b.txt', content: 'hello' } } });
      check('write_file succeeds', r1.ok === true && r1.result.bytes === 5);
      check('file actually written in sandbox', fs.readFileSync(path.join(env.tmp, 'a/b.txt'), 'utf8') === 'hello');

      const r2 = await w.step({ id: 2, kind: 'file-io', payload: { action: 'read_file', params: { path: 'a/b.txt' } } });
      check('read_file round-trips', r2.ok && r2.result.content === 'hello');

      const r3 = await w.step({ id: 3, kind: 'file-io', payload: { action: 'read_file', params: { path: '../../../etc/passwd' } } });
      check('path traversal refused', r3.ok === false && /escapes sandbox/.test(r3.error));

      const r4 = await w.step({ id: 4, kind: 'file-io', payload: { action: 'read_file', params: { path: '/etc/passwd' } } });
      check('absolute path refused', r4.ok === false && /escapes sandbox/.test(r4.error));

      const r5 = await w.step({ id: 5, kind: 'file-io', payload: { action: 'no_such_action' } });
      check('unknown action rejected', r5.ok === false && /unknown action/.test(r5.error));

      check('worker heartbeats governor', env.governor.heartbeat('w-t1') === true);
    } finally {
      env.cleanup();
    }
  }

  // ============================================================================
  suite('S2: worker — SNIPE gate enforces supervisor-first');
  {
    const env = makeEnv();
    try {
      const w = new Worker({ id: 'w-t2', kind: 'scaffold', governor: env.governor, root: env.tmp });
      const blocked = await w.step({ id: 10, kind: 'scaffold', payload: { action: 'SNIPE', needsSkill: true } });
      check('SNIPE blocked before injection', blocked.needSkill === true && blocked.phase === 'waiting_skill');

      w.state.injectedSkill = 'scaffold-express-api';
      w.state.skillSource = 'supervisor';
      const fed = await w.step({ id: 11, kind: 'scaffold', payload: { action: 'SNIPE', needsSkill: true } });
      check('SNIPE proceeds after injection', fed.ok === true && fed.result.appliedSkill === 'scaffold-express-api');
      check('gate marks phase done', fed.phase === 'done');

      const w2 = new Worker({ id: 'w-t2b', kind: 'scaffold', governor: env.governor, root: env.tmp });
      const refused = await w2.step({ id: 12, kind: 'scaffold', payload: { action: 'SNIPE', needsSkill: true, __force: true } });
      check('gate cannot be bypassed without injection', refused.needSkill === true);
    } finally {
      env.cleanup();
    }
  }

  // ============================================================================
  suite('S3: pool — acquire, reuse, spawn block, hibernate/restore');
  {
    const env = makeEnv();
    try {
      const pool = new WorkerPool({ governor: env.governor, root: env.tmp, targetSize: 2, maxSize: 3 });
      const a = pool.acquire('file-io');
      const b = pool.acquire('file-io');
      check('spawns up to target', pool.size() === 2 && a.id !== b.id);
      check('handed-out workers are claimed', a.state.phase === 'claimed' && b.state.phase === 'claimed');

      // Orchestrator releases workers after task completion:
      a.state.phase = 'done';
      b.state.phase = 'idle';
      const reused = pool.acquire('file-io');
      check('released worker reused, not spawned', reused && (reused.id === a.id || reused.id === b.id) && pool.size() === 2);
      check('reuse re-marks worker claimed', reused && reused.state.phase === 'claimed');

      a.state.phase = 'claimed';
      b.state.phase = 'done';
      const c = pool.acquire('file-io');
      check('busy workers not reused', !!c && c.id !== a.id);

      // hibernate/restore round-trip
      c.state.phase = 'done';
      c.state.history.push({ action: 'write_file', ok: true });
      check('hibernate removes from map', pool.hibernate(c.id) === true && pool.get(c.id) === null);
      const restored = pool.restore(c.id);
      check('restore rehydrates state', restored.state.history.length === 1 && restored.state.phase === 'done');

      // spawn block (90%)
      env.setUsedGB(15.5);
      env.governor.tick();
      let threw = false;
      try {
        pool.spawn('file-io');
      } catch (e) {
        threw = /spawn blocked/.test(e.message);
      }
      check('spawn refused while governor blocks', threw);
    } finally {
      env.cleanup();
    }
  }

  // ============================================================================
  suite('S4: bridge — verdict parsing + model chain');
  {
    const calls = [];
    const bridge = new SupervisorBridge({
      apiKey: 'test-key',
      fetchImpl: async (url, opts) => {
        calls.push({ url, model: JSON.parse(opts.body).model });
        return openRouterResponse('{"verdict":"delegate","skill":"scaffold-express-api","confidence":0.9,"inject":true}');
      },
      sleep: async () => {},
    });
    const payload = bridge.buildRequestPayload({
      workerId: 'w-0001',
      taskKind: 'scaffold',
      taskSummary: 'scaffold an express api',
      skillsCatalog: ['scaffold-express-api'],
    });
    check('payload matches knowledge.md §5 shape', payload.worker_id === 'w-0001' && payload.skills_catalog.length === 1 && typeof payload.task_summary === 'string');

    const res = await bridge.getVerdict(payload);
    check('verdict parsed from tier-3 primary', res.ok && res.model === POLICY.TIER3_MODEL && res.verdict.skill === 'scaffold-express-api' && res.verdict.inject === true);
    check('tier-3 primary used first', calls[0].model === POLICY.TIER3_MODEL);
    check('exactly one HTTP call', calls.length === 1);
  }

  // ============================================================================
  suite('S5: bridge — 429 backoff then success on same model');
  {
    let calls = 0;
    const bridge = new SupervisorBridge({
      apiKey: 'test-key',
      fetchImpl: async () => {
        calls += 1;
        if (calls <= 2) {
          return { ok: false, status: 429, headers: { get: () => '0' }, text: async () => 'rate limited' };
        }
        return openRouterResponse('{"verdict":"delegate","skill":null,"inject":false,"confidence":0.4}');
      },
      sleep: async () => {},
    });
    const res = await bridge.getVerdict(bridge.buildRequestPayload({ workerId: 'w', taskKind: 'k', taskSummary: 's', skillsCatalog: [] }));
    check('retries 429 and succeeds on attempt 3', res.ok === true && calls === 3 && res.attempts === 3);
  }

  // ============================================================================
  suite('S6: bridge — permanent mappings enforced; exclusive T3 retries then clean failure');
  {
    // Mapping permanence: overrides are rejected, not silently honored.
    let threw3 = null;
    try { new SupervisorBridge({ apiKey: 'k', tier3Model: 'anthropic/claude-3.5-sonnet' }); } catch (e) { threw3 = e.message; }
    check('tier3Model override rejected (permanent pin)', threw3 !== null && /permanently pinned/.test(threw3), String(threw3));
    let threw2 = null;
    try { new SupervisorBridge({ apiKey: 'k', tier2: { model: 'llama3:8b', url: 'http://localhost:11434/api/chat', timeoutMs: 1000, maxTokens: 100 } }); } catch (e) { threw2 = e.message; }
    check('tier2 model override rejected (permanent pin)', threw2 !== null && /permanently pinned/.test(threw2), String(threw2));
    let threwHost = null;
    try { new SupervisorBridge({ apiKey: 'k', tier2: { model: 'qwen2.5:7b', url: 'http://10.0.0.5:11434/api/chat', timeoutMs: 1000, maxTokens: 100 } }); } catch (e) { threwHost = e.message; }
    check('tier2 host override rejected (localhost:11434 pinned)', threwHost !== null, String(threwHost));
    const pinned = new SupervisorBridge({ apiKey: 'k', tier2: null });
    check('chain is exactly [TIER3] — no cloud fallback model', pinned.modelChain.length === 1 && pinned.modelChain[0] === POLICY.TIER3_MODEL);
    check('tier2 mapping is the pinned ollama constant', pinned.tier2 === null || (pinned.tier2.model === 'qwen2.5:7b' && pinned.tier2.url === 'http://localhost:11434/api/chat'));

    // Tier-2 request shape: the residency policy rides on EVERY consult.
    let t2body = null;
    const t2bridge = new SupervisorBridge({
      apiKey: 'test-key',
      fetchImpl: async (url, opts) => {
        if (String(url).includes('11434')) {
          t2body = JSON.parse(opts.body);
          return { ok: true, status: 200, json: async () => ({ message: { content: '{"verdict":"delegate","skill":"api-route-map","confidence":0.8,"inject":true}' } }) };
        }
        return openRouterResponse('{"verdict":"reject"}');
      },
      sleep: async () => {},
    });
    check('tier2 residency defaults to keep_alive=-1, numeric (weights resident)', t2bridge.tier2.keepAlive === POLICY.OLLAMA_KEEP_ALIVE && POLICY.OLLAMA_KEEP_ALIVE === -1);
    const t2res = await t2bridge.routeTask(t2bridge.buildRequestPayload({ workerId: 'w', taskKind: 'k', taskSummary: 'no template ever hits this triage request', skillsCatalog: ['api-route-map'] }), []);
    check('tier-2 consult pins model resident (numeric keep_alive in body)', t2res.source === 'tier2-local' && !!t2body && t2body.model === POLICY.TIER2_OLLAMA_MODEL && t2body.keep_alive === -1, JSON.stringify(t2body));

    // Exclusive T3: 429s exhaust → clean failure (no llama fallback to save it).
    const calls = [];
    const bridge = new SupervisorBridge({
      apiKey: 'test-key',
      tier2: null,
      fetchImpl: async (url, opts) => {
        calls.push(JSON.parse(opts.body).model);
        return { ok: false, status: 429, headers: { get: () => '0' }, text: async () => 'rl' };
      },
      sleep: async () => {},
    });
    const res = await bridge.getVerdict(bridge.buildRequestPayload({ workerId: 'w', taskKind: 'k', taskSummary: 'audit routes', skillsCatalog: ['api-route-map'] }));
    check('exclusive T3 fails clean after retries (no fallback model)', res.ok === false && /all models failed/.test(res.error));
    check('chain order respected (exactly 3 attempts, all TIER3)', calls.length === 3 && calls.every((m) => m === POLICY.TIER3_MODEL), JSON.stringify(calls));
  }

  // ============================================================================
  suite('S7: bridge — no key / offline ⇒ clean failure, orchestrator falls back locally');
  {
    const bridge = new SupervisorBridge({ apiKey: null, fetchImpl: async () => { throw new Error('network down'); } });
    const res = await bridge.getVerdict(bridge.buildRequestPayload({ workerId: 'w', taskKind: 'k', taskSummary: 's', skillsCatalog: [] }));
    check('no key → immediate clean failure', res.ok === false && /no api key/.test(res.error));

    const env = makeEnv();
    try {
      const orch = new Orchestrator({ governor: env.governor, root: env.tmp, skillbaseDir: SKILL_DIR, bridge, verbose: false, sandboxRoot: path.join(env.tmp, 'sandbox') });
      env.governor.enqueueTask('scaffold', { action: 'SNIPE', needsSkill: true, summary: 'scaffold a new express api for users' });
      const stats = await orch.runCycle();
      check('offline → handled at $0 without any cloud call', stats.local === 1 && stats.cloud === 0);
      check('task still completed via injected skill', stats.tasksDone === 1);
      const evt = env.governor.db.prepare("SELECT skill_name, source FROM skill_events ORDER BY id DESC LIMIT 1").get();
      check('tier-1 template handled the obvious match offline', evt && evt.skill_name === 'scaffold-express-api' && evt.source === 'tier1-template', JSON.stringify(evt));
      check('cascade tier counters populated', stats.tiers['tier1-template'] === 1, JSON.stringify(stats.tiers));
      // A summary with NO template match escalates T1→T2→T3 (tier2 mock
      // fails, tier3 keyless) → nothing injects → the task burns its
      // attempts in-cycle (same semantics as S10's poison task: per-attempt
      // failure count, DB row ends failed with the pre-permanent attempts).
      const injBefore = env.governor.db.prepare('SELECT COUNT(*) AS n FROM skill_events').get().n;
      const t2 = env.governor.enqueueTask('file-io', { action: 'SNIPE', needsSkill: true, summary: 'design a sharding and replication strategy for the orders store' });
      const stats2 = await orch.runCycle();
      const t2row = env.governor.db.prepare('SELECT status, attempts FROM task_queue WHERE id=?').get(t2);
      check('unmatched cognitive task escalates but is not force-injected', stats2.tasksDone === 0 && stats2.tasksFailed === 3 && t2row.status === 'failed' && t2row.attempts === 2, JSON.stringify({ stats2, t2row }));
      const injDelta = env.governor.db.prepare('SELECT COUNT(*) AS n FROM skill_events').get().n - injBefore;
      check('escalated task produced zero skill injections', injDelta === 0, `delta=${injDelta}`);
      orch.close();
    } finally {
      env.cleanup();
    }
  }

  // ============================================================================
  suite('S8: injector — catalog validation, unknown skills, corrupt catalog');
  {
    const env = makeEnv();
    try {
      const inj = new SkillInjector({ skillbaseDir: SKILL_DIR, governor: env.governor });
      const names = inj.listSkillNames();
      check('catalog loads with 3 seed skills', names.length === 3 && names.includes('scaffold-express-api'));

      const skill = inj.readSkill('file-bulk-rename');
      check('skill content readable', skill && /Bulk Rename/.test(skill.content));

      const bad = inj.applyVerdict({ verdict: 'delegate', skill: 'nonexistent-skill', inject: true }, 'w-x', 1);
      check('unknown skill rejected + logged', bad.injected === false && bad.reason.includes('unknown skill'));
      const evt = env.governor.db.prepare("SELECT outcome FROM skill_events WHERE skill_name='nonexistent-skill'").get();
      check('rejection recorded as failed', evt && evt.outcome === 'failed');

      const declined = inj.applyVerdict({ verdict: 'delegate', skill: null, inject: false }, 'w-x', 2);
      check('declined injection handled', declined.injected === false);

      // Corrupted catalog → graceful refusal, not crash
      const tmpSkill = path.join(env.tmp, 'skillbase');
      fs.mkdirSync(tmpSkill, { recursive: true });
      fs.writeFileSync(path.join(tmpSkill, 'index.json'), '{not json');
      const broken = new SkillInjector({ skillbaseDir: tmpSkill, governor: env.governor });
      let survived = false;
      try {
        const out = broken.snipeLocally('scaffold express', 'w-x', 3);
        survived = out.injected === false;
      } catch {
        survived = false;
      }
      check('corrupt catalog degrades gracefully', survived);
    } finally {
      env.cleanup();
    }
  }

  // ============================================================================
  suite('S9: orchestrator — end-to-end cloud pipeline (mocked supervisor)');
  {
    const env = makeEnv();
    try {
      const bridge = new SupervisorBridge({
        apiKey: 'test-key',
        // Tier-2 calls (Ollama shape) return an unparseable verdict → the
        // cascade MUST escalate; the OpenRouter call returns the real verdict.
        fetchImpl: async (url) => (String(url).includes('11434')
          ? { ok: true, status: 200, json: async () => ({ message: { content: '{}' } }) }
          : openRouterResponse('{"verdict":"delegate","skill":"scaffold-express-api","confidence":0.93,"inject":true}')),
        sleep: async () => {},
      });
      const orch = new Orchestrator({ governor: env.governor, root: env.tmp, skillbaseDir: SKILL_DIR, bridge, verbose: false, sandboxRoot: path.join(env.tmp, 'sandbox') });

      // No catalog triggers in this summary → escalates past tier 1 and 2.
      env.governor.enqueueTask('scaffold', { action: 'SNIPE', needsSkill: true, summary: 'architect a sharding and replication strategy for the orders store' });
      const stats = await orch.runCycle();
      check('cascade escalated T1→T2→T3 cloud', stats.cloud === 1 && stats.tiers.supervisor === 1, JSON.stringify(stats.tiers));
      check('task done via injected skill', stats.tasksDone === 1);
      const evt = env.governor.db.prepare("SELECT skill_name, source FROM skill_events WHERE source='supervisor'").get();
      check('supervisor injection logged', evt && evt.skill_name === 'scaffold-express-api');
      orch.close();
    } finally {
      env.cleanup();
    }
  }

  // ============================================================================
  suite('S10: orchestrator — mixed queue, poison task, telemetry');
  {
    const env = makeEnv();
    try {
      const bridge = new SupervisorBridge({ apiKey: null });
      const orch = new Orchestrator({ governor: env.governor, root: env.tmp, skillbaseDir: SKILL_DIR, bridge, verbose: false, sandboxRoot: path.join(env.tmp, 'sandbox') });

      env.governor.enqueueTask('file-io', { action: 'write_file', params: { path: 'out.txt', content: 'x' } });
      env.governor.enqueueTask('scaffold', { action: 'SNIPE', needsSkill: true, summary: 'bulk rename files in dir' });
      const t3 = env.governor.enqueueTask('file-io', { action: 'explode', params: {} }); // poison: unknown action
      env.governor.enqueueTask('file-io', { action: 'list_files', params: {} });

      const stats = await orch.runCycle();
      check('deterministic tasks complete without cloud', stats.tasksDone >= 2);
      check('SNIPE task handled via local fallback', stats.local >= 1);
      check('failed task not counted as done', stats.tasksDone >= 2 && stats.tasksFailed >= 1);

      // Poison task retries then fails permanently (MAX_TASK_ATTEMPTS=3)
      for (let i = 0; i < 2; i++) await orch.runCycle();
      const t3row = env.governor.db.prepare('SELECT status, attempts FROM task_queue WHERE id=?').get(t3);
      check('poison task failed permanently after 3 attempts', t3row && t3row.status === 'failed' && t3row.attempts === 2, JSON.stringify(t3row));

      const tel = orch.telemetry();
      check('telemetry exposes queue + ram + pool', typeof tel.ramPct === 'number' && !!tel.queue && !!tel.pool && typeof tel.workersHibernating === 'number');
      check('no tasks stuck in leased after cycles', tel.queue.leased === 0);
      orch.close();
    } finally {
      env.cleanup();
    }
  }

  // ============================================================================
  suite('S12: per-agent usage — busy-time attribution + dashboard rows');
  {
    // 12a. Worker busy-time accounting
    {
      const env = makeEnv();
      try {
        const w = new Worker({ id: 'w-busy', kind: 'file-io', governor: env.governor, root: env.tmp });
        await w.step({ id: 1, kind: 'file-io', payload: { action: 'write_file', params: { path: 'u.txt', content: 'usage' } } });
        const u = w.getUsage();
        check('step() accrues busy time', typeof u.busyMs === 'number' && u.busyMs >= 0);
        check('stateBytes is the exact serialized size', u.stateBytes === Buffer.byteLength(JSON.stringify(w.state), 'utf8') && u.stateBytes > 0);
        check('usage reports phase + attempts', u.phase === 'working' && u.attempts === 1, JSON.stringify(u));
      } finally {
        env.cleanup();
      }
    }

    // 12b. Pool attribution with injectable clock + host-stats reader
    {
      const env = makeEnv();
      try {
        let t = 10_000;
        const clock = () => (t += 2000); // 2s cadence, like production cycles
        const HOST_RSS = 300 * 1024 * 1024;
        const pool = new WorkerPool({
          governor: env.governor,
          root: env.tmp,
          targetSize: 2,
          maxSize: 4,
          clock,
          hostStatsReader: () => ({ cpuPct: 61.5, rssBytes: HOST_RSS }),
        });
        const a = pool.acquire('file-io');
        a.state.phase = 'done';

        const first = pool.heartbeatAll();
        check('first pass primes interval (cpu null, rss measured)', first.count === 1 && a.lastCpuPct === null && first.hostStats.rssBytes === HOST_RSS);
        check('per-agent rss split from host process', first.hostStats.perWorkerRss === HOST_RSS);

        // Busy 1s of a 2s interval → 50% attributed CPU
        a.busyMs += 1000;
        pool.heartbeatAll();
        check('cpu attributed as busy share of interval', a.lastCpuPct === 50, String(a.lastCpuPct));

        const row = env.governor.workerStatsSnapshot()[0];
        check('usage persisted to workers table', !!row && row.cpuPct === 50 && row.busyMs === a.busyMs && row.stateBytes > 0, JSON.stringify(row));

        const snap = pool.snapshot();
        check('snapshot.workers carries fleet rows for the UI table', snap.workers.length === 1 && snap.workers[0].id === a.id && snap.workers[0].cpuPct === 50);
        check('snapshot carries hostStats', snap.hostStats.rssBytes === HOST_RSS);

        // Fleet grows: per-agent rss re-splits across 2 agents
        a.state.phase = 'working'; // keep a busy so acquire spawns fresh
        const b = pool.acquire('file-io');
        b.state.phase = 'done';
        const third = pool.heartbeatAll();
        check('per-agent rss re-splits as fleet grows', third.hostStats.perWorkerRss === Math.round(HOST_RSS / 2));
      } finally {
        env.cleanup();
      }
    }

    // 12c. Orchestrator end-to-end: telemetry() exposes the per-agent table
    {
      const env = makeEnv();
      try {
        const bridge = new SupervisorBridge({ apiKey: null });
        const orch = new Orchestrator({ governor: env.governor, root: env.tmp, skillbaseDir: SKILL_DIR, bridge, verbose: false, sandboxRoot: path.join(env.tmp, 'sandbox') });
        env.governor.enqueueTask('file-io', { action: 'write_file', params: { path: 'x.txt', content: 'y' } });
        await orch.runCycle();
        const tel = orch.telemetry();
        check('telemetry exposes per-agent workers array', Array.isArray(tel.pool.workers) && tel.pool.workers.length >= 1);
        const agent = tel.pool.workers[0];
        check('agent rows carry cpu/state/busy/phase', typeof agent.cpuPct === 'number' && agent.stateBytes > 0 && typeof agent.busyMs === 'number' && typeof agent.phase === 'string', JSON.stringify(agent));
        check('telemetry exposes hostStats', !!tel.hostStats && 'rssBytes' in tel.hostStats);
        check('usage persisted in DB after a real cycle', env.governor.workerStatsSnapshot().length >= 1);
        orch.close();
      } finally {
        env.cleanup();
      }
    }
  }

  // ============================================================================
  suite('S14: SNIPE-gate integrity — no stale-skill carryover across tasks');
  {
    const env = makeEnv();
    try {
      const bridge = new SupervisorBridge({ apiKey: null }); // keyless: escalate → decline
      const orch = new Orchestrator({ governor: env.governor, root: env.tmp, skillbaseDir: SKILL_DIR, bridge, verbose: false, sandboxRoot: path.join(env.tmp, 'sandbox') });

      // Task A: matched scaffold → tier-1 injects into w-0001-scaffold.
      env.governor.enqueueTask('scaffold', { action: 'SNIPE', needsSkill: true, summary: 'scaffold a new express api now' });
      await orch.runCycle();
      const wA = orch.pool.get('w-0001-scaffold');
      check('task A got its skill injected', wA.state.injectedSkill === 'scaffold-express-api', JSON.stringify(wA.state.injectedSkill));
      wA.state.phase = 'done'; // release exactly as the orchestrator does

      // Task B: reuse the SAME worker; summary matches NOTHING → every tier declines.
      env.governor.enqueueTask('scaffold', { action: 'SNIPE', needsSkill: true, summary: 'architect a sharding and replication strategy for the orders store' });
      const stats = await orch.runCycle();
      check('reused worker does NOT inherit task A skill (gate consulted cascade)', stats.tasksDone === 0, JSON.stringify(stats));
      const injBefore = wA.state.injectedSkill;
      check('stale injectedSkill was cleared on acquire', injBefore === null, JSON.stringify(injBefore));
      check('skill grant is per-task scope (state reset)', wA.state.skillSource === null && wA.state.skillContent === null);
      const evts = env.governor.db.prepare("SELECT COUNT(*) n FROM skill_events WHERE worker_id='w-0001-scaffold' AND skill_name='file-bulk-rename'").get().n;
      check('no wrong-skill injection logged for task B', evts === 0);

      // Unit-level: beginTask() resets; acquire() always calls it (incl. steal path).
      const w2 = orch.pool.spawn('file-io');
      w2.state.injectedSkill = 'file-bulk-rename';
      w2.beginTask();
      check('beginTask() clears skill state', w2.state.injectedSkill === null && w2.state.skillSource === null);
      w2.state.phase = 'done';
      const w3 = orch.pool.acquire('file-io');
      check('acquire() resets handed-out workers (reuse path)', w3 === w2 && w3.state.injectedSkill === null);
      orch.close();
    } finally {
      env.cleanup();
    }
  }

  // ============================================================================
  suite('S15: cost rollup — $ avoided computed from skill_events');
  {
    // Unit price: exactly the measured rate card (286 prompt + 40 completion).
    const { SupervisorBridge: SB } = require('./supervisor-bridge.js');
    const unit = (POLICY.TIER3_EST_PROMPT_TOKENS / 1e6) * POLICY.TIER3_PROMPT_USD_PER_MTOK + (POLICY.TIER3_EST_COMPLETION_TOKENS / 1e6) * POLICY.TIER3_COMPLETION_USD_PER_MTOK;
    check('unit consult price matches rate card ($0.000972 measured)', Math.abs(unit - 0.000972) < 1e-9, String(unit));

    const env = makeEnv();
    try {
      const bridge = new SupervisorBridge({ apiKey: null });
      const orch = new Orchestrator({ governor: env.governor, root: env.tmp, skillbaseDir: SKILL_DIR, bridge, verbose: false, sandboxRoot: path.join(env.tmp, 'sandbox') });
      check('bridge tier3ConsultCostUsd() agrees with POLICY math', Math.abs(bridge.tier3ConsultCostUsd() - unit) < 1e-9);

      // One real (offline) cycle: obvious match → tier-1 consult + injection.
      env.governor.enqueueTask('scaffold', { action: 'SNIPE', needsSkill: true, summary: 'scaffold a new express api for users' });
      await orch.runCycle();
      const roll = orch.costRollup();
      const r4 = Math.round(unit * 10000) / 10000;
      check('tier-1 consult counted and avoided at unit price', roll.perTier['tier1-template'].consults === 1 && roll.perTier['tier1-template'].costUsd === 0 && Math.abs(roll.perTier['tier1-template'].avoidedUsd - r4) < 1e-9, JSON.stringify(roll.perTier));
      check('keyless run spends nothing at T3', roll.totals.spentUsd === 0 && roll.perTier.supervisor.consults === 0);
      check('totals: avoided == avoidedUnits × unit, savings % sane', Math.abs(roll.totals.avoidedUsd - r4) < 1e-9 && roll.totals.consults === 1 && roll.totals.savingsPct === 100, JSON.stringify(roll.totals));

      const tel = orch.telemetry();
      check('telemetry carries the costs block for the dashboard', tel.costs && typeof tel.costs.unitT3Usd === 'number' && !!tel.costs.method && tel.costs.totals.consults >= 1);
      orch.close();
    } finally {
      env.cleanup();
    }
  }

  // ============================================================================
  suite('S16: serve-mode survival + bundle orphan guard');
  {
    // Regression: the orphan guard once called process.ppid() — but ppid is a
    // number property, so every --serve backend crashed 5s after spawn
    // (TypeError inside the guard's own interval), feeding the launchd
    // supervisor an endless heal loop. This suite spawns the REAL entrypoint
    // in --serve mode against a temp DB and proves it (a) stays up well past
    // the first guard tick and (b) exits cleanly on SIGTERM.
    const { spawn } = require('child_process');
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'daisy-serve-'));
    const child = spawn(process.execPath, [path.join(__dirname, 'index.js'), '--serve'], {
      env: {
        ...process.env,
        DAISY_DATA_DIR: path.join(tmpHome, 'database'),
        DAISY_SANDBOX_DIR: path.join(tmpHome, 'sandbox'),
        OPENROUTER_API_KEY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    // 7s > the guard's 5s tick: the regression died inside this window.
    await new Promise((r) => setTimeout(r, 7_000));
    check('serve-mode orchestrator survives its first orphan-guard tick', child.exitCode === null && !/ppid is not a function/.test(stderr), stderr.split('\n').slice(-2).join(' | ').slice(0, 200));
    check('guard is bundle-scoped in source (repo serve runs must not self-exit)', fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8').includes('IN_APP_BUNDLE && process.platform'));

    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 3_000));
    const gone = child.exitCode !== null || child.signalCode === 'SIGTERM';
    check('SIGTERM exits the serve orchestrator cleanly', gone, `exitCode=${child.exitCode} signal=${child.signalCode}`);
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  }

  // ============================================================================
  suite('S11: governor regression — Phase 1 battery still green');
  {
    const { execFileSync } = require('child_process');
    let out = '';
    let nestedFail = false;
    try {
      out = execFileSync('node', ['governor/governor.selftest.js'], { encoding: 'utf8', cwd: path.join(__dirname, '..') });
    } catch (err) {
      out = String(err.stdout || '');
      nestedFail = true;
    }
    check('governor battery passes (56/56)', /44 passed, 0 failed/.test(out) === false && / passed, 0 failed/.test(out), out.split('\n').slice(-3).join(' | '));
    check('governor battery did not fail', nestedFail === false);
  }

  console.log(`\n${'='.repeat(64)}`);
  console.log(`BACKEND SELFTEST: ${pass} passed, ${fail} failed (${pass + fail} checks)`);
  if (fail > 0) {
    console.log(`FAILED: ${failures.join(' | ')}`);
    process.exit(1);
  }
  console.log('ALL GREEN — Phases 2+3 verified (orchestrator ⇄ cloud bridge ⇄ skillbase).');
  process.exit(0);
}

main().catch((err) => {
  console.error('BATTERY CRASH:', err);
  process.exit(1);
});
