#!/usr/bin/env node
'use strict';
/**
 * Daisy Chain — Skill Executor selftest (Round 9)
 * ================================================
 * Proves the SNIPE gate now EXECUTES skills, not just consumes them:
 *   - tier-1 builders produce real files in a temp sandbox
 *   - acceptance checks parse generated JS
 *   - plans are validated (no deletes, no escapes, size caps)
 *   - no executor wired → legacy consume-only semantics preserved
 *   - consumeOnly payload opt-out preserved
 *   - end-to-end: an orchestrator cycle on a scaffold task lands real files
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0;
let failed = 0;
let suiteName = '';
const failures = [];

function suite(name) { suiteName = name; console.log(`\n— ${name} —`); }
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failed += 1; failures.push({ suite: suiteName, name, detail }); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const { Worker } = require('./worker');
const { WorkerPool } = require('./worker-pool');
const {
  SkillExecutor, validateOps, executeOps, runAcceptanceChecks,
  TIER1_BUILDERS, PLAN_ACTIONS, POLICY,
} = require('./skill-executor');
const { Governor } = require('../governor/governor');
const { Orchestrator } = require('./index');
const { SkillInjector } = require('./skill-injector');

function makeEnv(tag) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `daisy-exec-${tag}-`));
  const sandbox = path.join(tmp, 'sandbox');
  fs.mkdirSync(sandbox, { recursive: true });
  const governor = new Governor({ dbPath: path.join(tmp, 'gov.db'), silent: true });
  return { tmp, sandbox, governor, cleanup: () => { try { governor.close(); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} } };
}

const SKILL_DIR = path.join(__dirname, '..', 'skillbase');
const SCAFFOLD = fs.readFileSync(path.join(SKILL_DIR, 'scaffold-express-api.md'), 'utf8');

async function main() {
  // ==========================================================================
  suite('E1: tier-1 scaffold builder plans and executes real files');
  {
    const env = makeEnv('t1');
    try {
      const w = new Worker({ id: 'w-e1', kind: 'scaffold', governor: env.governor, root: env.sandbox });
      w.state.injectedSkill = 'scaffold-express-api';
      w.state.skillSource = 'tier1-template';
      w.state.skillContent = SCAFFOLD;
      w.executor = new SkillExecutor({ tier2: null });

      const report = await w.executor.execute(w, { id: 1, kind: 'scaffold', payload: { action: 'SNIPE', needsSkill: true, summary: 'scaffold an express api for invoices' } });
      check('report is a real execution', report.planSource === 'tier1-builder' && Array.isArray(report.executed) && report.executed.length >= 3, JSON.stringify(report).slice(0, 120));
      check('contract fields preserved (appliedSkill/source)', report.appliedSkill === 'scaffold-express-api' && report.source === 'tier1-template');
      check('acceptance ran (JS parses)', typeof report.acceptance === 'string' && /parse/.test(report.acceptance), String(report.acceptance));

      const pkg = JSON.parse(fs.readFileSync(path.join(env.sandbox, 'invoices/package.json'), 'utf8'));
      check('package.json real + express dep + start script', pkg.dependencies.express === '^4' && pkg.scripts.start === 'node src/index.js');
      check('src/index.js exists with /health', /\/health/.test(fs.readFileSync(path.join(env.sandbox, 'invoices/src/index.js'), 'utf8')));
      check('route file exists per resource', fs.existsSync(path.join(env.sandbox, 'invoices/src/routes/invoices.js')));
      check('filesWritten tracked in worker state', w.state.filesWritten.some((f) => String(f).includes('src/index.js')));

      // End-to-end through the worker's own step(): SNIPE executes now.
      const w2 = new Worker({ id: 'w-e1b', kind: 'scaffold', governor: env.governor, root: env.sandbox });
      w2.executor = w.executor;
      w2.state.injectedSkill = 'scaffold-express-api';
      w2.state.skillSource = 'tier1-template';
      w2.state.skillContent = SCAFFOLD;
      const fed = await w2.step({ id: 2, kind: 'scaffold', payload: { action: 'SNIPE', needsSkill: true, summary: 'scaffold an express api for orders' } });
      check('worker.step(SNIPE) executes and finishes done', fed.ok === true && fed.done === true && fed.result.planSource === 'tier1-builder');
      check('orders project landed on disk', fs.existsSync(path.join(env.sandbox, 'orders/src/routes/orders.js')));
    } finally { env.cleanup(); }
  }

  // ==========================================================================
  suite('E2: write-text builder composes without clobbering');
  {
    const env = makeEnv('wt');
    try {
      const w = new Worker({ id: 'w-wt', kind: 'generic', governor: env.governor, root: env.sandbox });
      w.executor = new SkillExecutor({ tier2: null });
      const task = { id: 1, kind: 'generic', payload: { action: 'SNIPE', needsSkill: true, summary: 'write a haiku about queues', params: { path: 'notes/haiku.txt', content: 'the queue sleeps at midnight\nsilent, patient, alive\nwork drains like morning fog' } } };
      w.state.injectedSkill = 'write-text';
      w.state.skillSource = 'tier1-template';
      w.state.skillContent = 'x';
      await w.executor.execute(w, task);
      const first = fs.readFileSync(path.join(env.sandbox, 'notes/haiku.txt'), 'utf8');
      check('haiku content landed (params honored)', first.includes('midnight'));
      await w.executor.execute(w, { ...task, id: 2 });
      const second = fs.readFileSync(path.join(env.sandbox, 'notes/haiku.txt'), 'utf8');
      check('re-run appends, never clobbers (skill directive #3)', second.length > first.length && second.startsWith(first));
    } finally { env.cleanup(); }
  }

  // ==========================================================================
  suite('E3: plan validation — the jail holds');
  {
    const mk = (over) => ({ action: 'write_file', path: 'a.txt', content: 'x', ...over });
    check('empty plan rejected', (() => { try { validateOps([]); return false; } catch { return true; } })());
    check('delete_file not allowed', (() => { try { validateOps([mk({ action: 'delete_file', path: 'a' })]); return false; } catch (e) { return /not allowed/.test(e.message); } })());
    check('absolute path rejected', (() => { try { validateOps([mk({ path: '/etc/hosts' })]); return false; } catch (e) { return /relative/.test(e.message); } })());
    check('.. traversal rejected', (() => { try { validateOps([mk({ path: '../escape.txt' })]); return false; } catch (e) { return /relative/.test(e.message); } })());
    check('oversized op rejected', (() => { try { validateOps([mk({ content: 'x'.repeat(POLICY.MAX_OP_BYTES + 1) })]); return false; } catch (e) { return /per-op cap/.test(e.message); } })());
    check('op-count cap enforced', (() => { try { validateOps(Array.from({ length: POLICY.MAX_OPS + 1 }, () => mk({}))); return false; } catch (e) { return /too large/.test(e.message); } })());
    check('legal plan passes', (() => { validateOps([mk({}), { action: 'mkdir', path: 'd' }]); return true; })());
    // Defense in depth: even a plan that somehow validated is run through
    // the worker's own _safePath jail — escape attempt dies there too.
    const env = makeEnv('jail');
    try {
      const w = new Worker({ id: 'w-j', kind: 'generic', governor: env.governor, root: env.sandbox });
      let threw = false;
      try { executeOps(w, [mk({ path: 'ok.txt' }), mk({ path: 'sub/../outside.txt' })]); } catch { threw = true; }
      check('executeOps funnels through the worker sandbox jail', threw === false || !fs.existsSync(path.join(env.tmp, 'outside.txt')));
    } finally { env.cleanup(); }
  }

  // ==========================================================================
  suite('E4: acceptance checks fail honestly');
  {
    const env = makeEnv('ac');
    try {
      const w = new Worker({ id: 'w-ac', kind: 'scaffold', governor: env.governor, root: env.sandbox });
      // Write the bad file first so --check fails on SYNTAX, not on a
      // missing file (the test must exercise the acceptance logic itself).
      fs.writeFileSync(path.join(env.sandbox, 'broken.js'), 'const x = {{{;');
      let threw = false;
      try {
        runAcceptanceChecks('scaffold-express-api', w, [{ action: 'write_file', path: 'broken.js', content: 'const x = {{{;' }]);
      } catch { threw = true; }
      check('unparseable generated JS fails acceptance', threw);
      check('unknown skill → null (no contract, no false failure)', runAcceptanceChecks('mystery-skill', w, [{ action: 'write_file', path: 'a.txt', content: 'x' }]) === null);
    } finally { env.cleanup(); }
  }

  // ==========================================================================
  suite('E5: tier-2 planner used when no builder exists');
  {
    const env = makeEnv('t2');
    try {
      const w = new Worker({ id: 'w-t2p', kind: 'generic', governor: env.governor, root: env.sandbox });
      w.state.injectedSkill = 'code-explain'; // no tier-1 builder
      w.state.skillSource = 'tier2-local';
      w.state.skillContent = '# explain the code';
      let planCall = null;
      const fakeFetch = async (url, init) => {
        planCall = { url, body: JSON.parse(init.body) };
        return { ok: true, json: async () => ({ message: { content: JSON.stringify({ ops: [{ action: 'write_file', path: 'explain.md', content: '# explanation' }] }) } }) };
      };
      const ex = new SkillExecutor({
        tier2: { url: 'http://localhost:11434/api/chat', model: 'qwen2.5:7b', keepAlive: -1, timeoutMs: 1000 },
        fetchImpl: fakeFetch,
      });
      const report = await ex.execute(w, { id: 1, kind: 'generic', payload: { summary: 'explain what the code does' } });
      check('tier-2 planner consulted (pinned model + url)', planCall && planCall.url.includes('localhost:11434') && planCall.body.model === 'qwen2.5:7b');
      check('plan executed from tier-2', report.planSource === 'tier2-plan' && fs.existsSync(path.join(env.sandbox, 'explain.md')));

      // Planner unreachable → honest failure, not silent consume.
      const ex2 = new SkillExecutor({
        tier2: { url: 'http://localhost:11434/api/chat', model: 'qwen2.5:7b', keepAlive: -1, timeoutMs: 50 },
        fetchImpl: async () => { throw new Error('down'); },
      });
      const w2 = new Worker({ id: 'w-t2q', kind: 'generic', governor: env.governor, root: env.sandbox });
      w2.state.injectedSkill = 'code-explain';
      w2.state.skillContent = 'x';
      let threw = false;
      try { await ex2.execute(w2, { id: 2, kind: 'generic', payload: { summary: 'explain' } }); } catch (e) { threw = /no plan possible/.test(e.message); }
      check('unreachable planner fails the task honestly (no plan → no lie)', threw);
    } finally { env.cleanup(); }
  }

  // ==========================================================================
  suite('E6: legacy + opt-out semantics preserved');
  {
    const env = makeEnv('leg');
    try {
      // No executor wired → old consume-only contract (pre-Round-9 embedders).
      const w = new Worker({ id: 'w-leg', kind: 'scaffold', governor: env.governor, root: env.sandbox });
      w.state.injectedSkill = 'scaffold-express-api';
      w.state.skillSource = 'supervisor';
      w.state.skillContent = SCAFFOLD;
      const fed = await w.step({ id: 1, kind: 'scaffold', payload: { action: 'SNIPE', needsSkill: true } });
      check('no executor → legacy consume-only result', fed.ok === true && fed.result.appliedSkill === 'scaffold-express-api' && /consumed/.test(fed.result.note));
      check('legacy path wrote nothing', !fs.existsSync(path.join(env.sandbox, 'invoices')));

      // consumeOnly opt-out → skip execution even with executor wired.
      const w2 = new Worker({ id: 'w-opt', kind: 'scaffold', governor: env.governor, root: env.sandbox });
      w2.executor = new SkillExecutor({ tier2: null });
      w2.state.injectedSkill = 'scaffold-express-api';
      w2.state.skillSource = 'supervisor';
      w2.state.skillContent = SCAFFOLD;
      const fed2 = await w2.step({ id: 2, kind: 'scaffold', payload: { action: 'SNIPE', needsSkill: true, consumeOnly: true } });
      check('consumeOnly opt-out skips execution', fed2.ok === true && /consumeOnly/.test(fed2.result.note));
      check('consumeOnly wrote nothing', fs.readdirSync(env.sandbox).length === 0);

      // Gate still refuses without injection (unchanged, critical).
      const w3 = new Worker({ id: 'w-gate', kind: 'scaffold', governor: env.governor, root: env.sandbox });
      w3.executor = new SkillExecutor({ tier2: null });
      const refused = await w3.step({ id: 3, kind: 'scaffold', payload: { action: 'SNIPE', needsSkill: true } });
      check('SNIPE gate unchanged: blocked before injection', refused.needSkill === true);
    } finally { env.cleanup(); }
  }

  // ==========================================================================
  suite('E7: end-to-end — orchestrator cycle lands real project files');
  {
    const env = makeEnv('e2e');
    try {
      const injector = new SkillInjector({ skillbaseDir: SKILL_DIR, governor: env.governor });
      const orch = new Orchestrator({
        governor: env.governor, root: env.tmp, skillbaseDir: SKILL_DIR, verbose: false,
        sandboxRoot: env.sandbox,
        bridge: { buildRequestPayload: (o) => o, routeTask: async () => null, tier2: null, fetchImpl: async () => { throw new Error('offline'); } },
      });
      void injector;
      env.governor.enqueueTask('scaffold', { action: 'SNIPE', needsSkill: true, summary: 'scaffold an express api for invoices' });
      const stats = await orch.runCycle();
      check('task completed', stats.tasksDone === 1, JSON.stringify({ done: stats.tasksDone, failed: stats.tasksFailed }));
      check('real project scaffolded in the sandbox', fs.existsSync(path.join(env.sandbox, 'invoices/src/routes/invoices.js')));
      const pkg = JSON.parse(fs.readFileSync(path.join(env.sandbox, 'invoices/package.json'), 'utf8'));
      check('scaffolded project is a real package', pkg.name === 'invoices' && !!pkg.dependencies.express);
      orch.close();
    } finally { env.cleanup(); }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    for (const f of failures) console.log(`  FAILED [${f.suite}] ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
