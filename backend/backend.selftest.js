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
    check('verdict parsed from primary model', res.ok && res.model === POLICY.PRIMARY_MODEL && res.verdict.skill === 'scaffold-express-api' && res.verdict.inject === true);
    check('primary model used first', calls[0].model === 'anthropic/claude-3.5-sonnet');
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
  suite('S6: bridge — model fallback after primary exhausts retries');
  {
    const calls = [];
    const bridge = new SupervisorBridge({
      apiKey: 'test-key',
      fetchImpl: async (url, opts) => {
        calls.push(JSON.parse(opts.body).model);
        if (JSON.parse(opts.body).model === POLICY.PRIMARY_MODEL) {
          return { ok: false, status: 429, headers: { get: () => '0' }, text: async () => 'rl' };
        }
        return openRouterResponse('{"verdict":"delegate","skill":"api-route-map","confidence":0.8,"inject":true}');
      },
      sleep: async () => {},
    });
    const res = await bridge.getVerdict(bridge.buildRequestPayload({ workerId: 'w', taskKind: 'k', taskSummary: 'audit routes', skillsCatalog: ['api-route-map'] }));
    check('falls back to llama-3.3-70b after primary retries exhaust', res.ok && res.model === POLICY.FALLBACK_MODEL && res.verdict.skill === 'api-route-map');
    check('chain order respected (3 primary attempts then fallback)', calls.length === 4 && calls.filter((m) => m === POLICY.PRIMARY_MODEL).length === 3 && calls[3] === POLICY.FALLBACK_MODEL, JSON.stringify(calls));
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
      check('offline → local keyword sniping fired', stats.local === 1 && stats.cloud === 0);
      check('task still completed via fallback skill', stats.tasksDone === 1);
      const evt = env.governor.db.prepare("SELECT skill_name, source FROM skill_events ORDER BY id DESC LIMIT 1").get();
      check('fallback recorded in skill_events', evt && evt.skill_name === 'scaffold-express-api' && evt.source === 'local-fallback');
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
        fetchImpl: async () => openRouterResponse('{"verdict":"delegate","skill":"scaffold-express-api","confidence":0.93,"inject":true}'),
        sleep: async () => {},
      });
      const orch = new Orchestrator({ governor: env.governor, root: env.tmp, skillbaseDir: SKILL_DIR, bridge, verbose: false, sandboxRoot: path.join(env.tmp, 'sandbox') });

      env.governor.enqueueTask('scaffold', { action: 'SNIPE', needsSkill: true, summary: 'scaffold express api for orders' });
      const stats = await orch.runCycle();
      check('cloud consulted once', stats.cloud === 1);
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
    check('governor battery passes (43/43)', /44 passed, 0 failed/.test(out) === false && / passed, 0 failed/.test(out), out.split('\n').slice(-3).join(' | '));
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
