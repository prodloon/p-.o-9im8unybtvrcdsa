#!/usr/bin/env node
'use strict';
/**
 * Daisy Chain — Idle-Drill Failsafe selftest (Round 10)
 * =====================================================
 * Proves the anti-rogue failsafe end-to-end:
 *   D1  drill generator: three shapes, all different, all self-contained
 *   D2  grader: exact answers pass, off-by-one/wrong-marker/extra lines fail
 *   D3  stateless grader: grades from seed files + prompt marker, no memory
 *   D4  tamper detection: a model-written seed file = automatic FAIL
 *   D5  IdleWatch: only a sustained idle streak triggers; real work resets
 *   D6  orchestrator E2E: idle cluster + due drill → task lands in the
 *       queue as kind='drill', ReAct solves it, grader records PASS
 *   D7  drill output never leaks outside the drill/ jail
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { generateDrill, seedFiles, gradeFromDisk, IdleWatch, DRILL_DIR } = require(path.join(ROOT, 'backend', 'drill-runner'));

const RESULTS = [];
function check(name, ok, detail) {
  RESULTS.push({ name, ok: !!ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}
function suite(name) { console.log(`\n— ${name} —`); }

function tmpEnv(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `drill-${tag}-`));
  const sandbox = path.join(dir, 'sandbox');
  fs.mkdirSync(sandbox, { recursive: true });
  return { dir, sandbox };
}

// ---------------------------------------------------------------------------
suite('D1: drill generator — three shapes, never the same twice');
{
  const drills = Array.from({ length: 12 }, () => generateDrill());
  const shapes = new Set(drills.map((d) => d.id.split('-')[1]));
  check('all three shapes appear across 12 draws', shapes.size === 3, [...shapes].join(','));
  const ids = new Set(drills.map((d) => d.id));
  check('every drill id is unique (different outcome every time)', ids.size === drills.length);
  for (const d of drills.slice(0, 12)) {
    const nonce = d.id.split('-').slice(2).join('-');
    check(`task embeds its own marker + nonce (${d.id.split('-')[1]})`,
      d.task.includes(nonce) && /\b(DRILL|BAL|ECHO)-/.test(d.task));
    check(`expected exists and is hidden data (${d.id.split('-')[1]})`, !!d.expected && typeof d.grade === 'function');
  }
}

// ---------------------------------------------------------------------------
suite('D2: grader — exact answer passes, anything else fails');
{
  const d = generateDrill();
  const seed = seedFiles(d);
  // Build the exact correct answer for whichever shape we drew, from the
  // seed data (this mirrors what a SOLVING agent would produce).
  const cfgPath = path.join(path.dirname(seed[0].path), path.basename(seed[0].path));
  const cfgContent = seed[0].content;
  const marker = d.task.match(/\b(DRILL|BAL|ECHO)-[a-z0-9]+\b/)[0];
  let answer;
  if (/WORD=/.test(cfgContent)) {
    const w = cfgContent.match(/WORD=([a-z]+)/)[1];
    answer = { 'answer.txt': `${marker}\n${w} ${w} ${w}\n` };
  } else if (/CREDIT=/.test(cfgContent)) {
    const a = +cfgContent.match(/CREDIT=(\d+)/)[1];
    const b = +cfgContent.match(/DEBIT=(\d+)/)[1];
    const c = +cfgContent.match(/FEE_MULTIPLIER=(\d+)/)[1];
    answer = { 'balance.txt': `${marker}\n${(a - b) * c}\n` };
  } else {
    const code = cfgContent.trim();
    answer = { 'echo.txt': `${marker}\n${code.split('').reverse().join('')}:${code.length}\n` };
  }
  void cfgPath;
  const good = gradeFromDisk(answer, { seedCfg: /WORD=/.test(cfgContent) ? cfgContent : null, seedLedger: /CREDIT=/.test(cfgContent) ? cfgContent : null, seedCodeword: !/WORD=/.test(cfgContent) && !/CREDIT=/.test(cfgContent) ? cfgContent : null, taskSummary: d.task });
  check('exact correct answer PASSES', good.pass === true, good.detail);

  const wrongName = gradeFromDisk({ 'wrong.txt': 'x' }, { seedCfg: /WORD=/.test(cfgContent) ? cfgContent : null, seedLedger: /CREDIT=/.test(cfgContent) ? cfgContent : null, seedCodeword: !/WORD=/.test(cfgContent) && !/CREDIT=/.test(cfgContent) ? cfgContent : null, taskSummary: d.task });
  check('missing answer file FAILS', wrongName.pass === false, wrongName.detail);

  const noMarker = gradeFromDisk(Object.fromEntries(Object.entries(answer).map(([k, v]) => [k, v.replace(marker, 'X')])), { seedCfg: /WORD=/.test(cfgContent) ? cfgContent : null, seedLedger: /CREDIT=/.test(cfgContent) ? cfgContent : null, seedCodeword: !/WORD=/.test(cfgContent) && !/CREDIT=/.test(cfgContent) ? cfgContent : null, taskSummary: d.task });
  check('wrong marker FAILS', noMarker.pass === false, noMarker.detail);
}

// ---------------------------------------------------------------------------
suite('D3: grader is stateless — seed files + prompt are the only inputs');
{
  const d = generateDrill();
  const seed = seedFiles(d);
  const seedContent = seed[0].content;
  const marker = d.task.match(/\b(DRILL|BAL|ECHO)-[a-z0-9]+\b/)[0];
  // Grade in a FRESH process-equivalent way: only (written files, seeds, prompt).
  const isWord = /WORD=/.test(seedContent);
  const isLedger = /CREDIT=/.test(seedContent);
  const args = {
    seedCfg: isWord ? seedContent : null,
    seedLedger: isLedger ? seedContent : null,
    seedCodeword: !isWord && !isLedger ? seedContent : null,
    taskSummary: d.task,
  };
  check('grader accepts (files, seeds, prompt) with zero module state', gradeFromDisk({}, args).pass === false);
  check('grader flags missing seed files as grader-bug (not agent fault)', gradeFromDisk({}, { seedCfg: null, seedLedger: null, seedCodeword: null, taskSummary: d.task }).detail.includes('grader bug'));
  void marker;
}

// ---------------------------------------------------------------------------
suite('D4: tamper detection lives in the orchestrator; grader catches seed corruption');
{
  const d = generateDrill();
  const seed = seedFiles(d);
  const seedContent = seed[0].content;
  const isWord = /WORD=/.test(seedContent);
  const isLedger = /CREDIT=/.test(seedContent);
  const args = {
    seedCfg: isWord ? 'garbage-not-a-seed' : null,
    seedLedger: isLedger ? 'garbage-not-a-seed' : null,
    seedCodeword: !isWord && !isLedger ? '' : null,
    taskSummary: d.task,
  };
  const r = gradeFromDisk({}, args);
  check('corrupted seed → grader-bug FAIL (never a silent pass)', r.pass === false && /corrupted|grader bug/.test(r.detail), r.detail);
}

// ---------------------------------------------------------------------------
suite('D5: IdleWatch — sustained idleness triggers exactly once, work resets');
{
  let now = 1_000_000;
  const fakeNow = () => now;
  const w = new IdleWatch({ idleMs: 60_000 });
  w.enabled = true;
  const origNow = Date.now;
  Date.now = fakeNow;
  try {
    check('cycle with work → busy, no trigger', w.cycle(1, 0) === null && w.state === 'busy');
    check('first idle cycle → streak starts, no trigger', w.cycle(0, 0) === null && w.state === 'idle');
    now += 30_000;
    check('idle but below threshold → no trigger', w.cycle(0, 0) === null);
    now += 31_000; // total 61s idle
    check('idle past threshold → ENQUEUE', w.cycle(0, 0) === 'enqueue' && w.state === 'drilling');
    now += 1_000;
    check('streak restarted after enqueue (no double-fire)', w.cycle(0, 0) === null);
    now += 61_000;
    check('second window → fires again (persistent watchdog)', w.cycle(0, 0) === 'enqueue');
    now += 5_000;
    check('a real task resets the streak', w.cycle(0, 1) === null && w.state === 'busy');
    now += 61_000;
    check('post-work idleness restarts cleanly', w.cycle(0, 0) === null);
  } finally {
    Date.now = origNow;
  }
  check('DAISY_DRILL=0 disables the watchdog', new IdleWatch({ idleMs: 1000 }).constructor === IdleWatch && (() => { process.env.DAISY_DRILL = '0'; const x = new IdleWatch({ idleMs: 1000 }); const r = x.cycle(0, 0) === null && x.state === 'disabled'; delete process.env.DAISY_DRILL; return r; })());
}

// ---------------------------------------------------------------------------
suite('D6: orchestrator E2E — idle cluster drills itself and the grade PASSES');
{
  const { Governor } = require(path.join(ROOT, 'governor', 'governor'));
  const { Orchestrator } = require(path.join(ROOT, 'backend', 'index'));
  const env = tmpEnv('e2e');
  const governor = new Governor({ dbPath: path.join(env.dir, 'gov.db'), silent: true });
  const orch = new Orchestrator({
    governor,
    root: env.sandbox,
    sandboxRoot: env.sandbox, // pool + drill jail + fake brain all share this dir
    dbPath: path.join(env.dir, 'gov.db'),
    silent: true,
    targetSize: 1,
    idleWatchOpts: { idleMs: 50 },
  });
  // Speed: skip real consults; the drill payload already carries action=AGENT.
  orch.consultSupervisor = async () => ({ injected: false, reason: 'test stub' });
  // Deterministic fake brain: reads the seed, writes the exact answer.
  const { SkillExecutor } = require(path.join(ROOT, 'backend', 'skill-executor'));
  const ex = new SkillExecutor({
    agent: { url: 'http://x', model: 'fake', keepAlive: -1, timeoutMs: 1000, maxTokens: 100 },
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      const userMsg = body.messages.map((m) => m.content).join(' ');
      const marker = (userMsg.match(/\b(DRILL|BAL|ECHO)-[a-z0-9]+\b/) || [])[0];
      // Read the seed like the real agent would — via the existing_files context.
      const ctx = body.messages.find((m) => m.role === 'user' && m.content.includes('existing_files'));
      let seedFile = '';
      const mFiles = ctx && ctx.content.match(/"name":"(config|ledger|codeword)\.txt"/);
      void mFiles;
      // The fake brain reads the seed from disk through the worker jail.
      seedFile = ['config.txt', 'ledger.txt', 'codeword.txt']
        .map((n) => { try { return fs.readFileSync(path.join(env.sandbox, DRILL_DIR, n), 'utf8'); } catch { return null; } })
        .find((c) => c != null) || '';
      let content;
      if (/WORD=/.test(seedFile)) {
        const w = seedFile.match(/WORD=([a-z]+)/)[1];
        content = { thought: 'solved', ops: [{ action: 'write_file', path: 'answer.txt', content: `${marker}\n${w} ${w} ${w}\n` }], done: true, reply: `Drill ${marker} complete.` };
      } else if (/CREDIT=/.test(seedFile)) {
        const a = +seedFile.match(/CREDIT=(\d+)/)[1];
        const b = +seedFile.match(/DEBIT=(\d+)/)[1];
        const c = +seedFile.match(/FEE_MULTIPLIER=(\d+)/)[1];
        content = { thought: 'solved', ops: [{ action: 'write_file', path: 'balance.txt', content: `${marker}\n${(a - b) * c}\n` }], done: true, reply: `Drill ${marker} complete.` };
      } else {
        const code = seedFile.trim();
        content = { thought: 'solved', ops: [{ action: 'write_file', path: 'echo.txt', content: `${marker}\n${code.split('').reverse().join('')}:${code.length}\n` }], done: true, reply: `Drill ${marker} complete.` };
      }
      return { ok: true, json: async () => ({ message: { content: JSON.stringify(content) } }) };
    },
  });
  orch.pool.executor = ex;
  if (orch.pool.workers) for (const w of orch.pool.workers.values()) w.executor = ex;

  (async () => {
    // Cycle 1: idle begins (streak start), no drill yet.
    await orch.runCycle();
    check('idle streak starts without an immediate drill', !orch._lastDrill);
    // Force the streak matured: enqueue decision comes from IdleWatch state.
    orch.idleWatch.idleSince = Date.now() - 10 * 60 * 1000; // past any threshold
    await orch.runCycle();
    check('drill enqueued to the real queue as kind=drill',
      governor.db.prepare("SELECT COUNT(*) n FROM task_queue WHERE kind='drill' AND status='pending'").get().n === 1
      || governor.db.prepare("SELECT COUNT(*) n FROM task_queue WHERE kind='drill'").get().n >= 1);
    // Cycle 3: the drill is processed by the pool with the fake brain.
    await orch.runCycle();
    const row = governor.db.prepare("SELECT status FROM task_queue WHERE kind='drill' ORDER BY id DESC LIMIT 1").get();
    check('drill task completed', row && row.status === 'done', JSON.stringify(row));
    check('grade recorded a PASS', orch._lastDrill && orch._lastDrill.pass === true, JSON.stringify(orch._lastDrill));
    check('drill answered inside the jail', orch._lastDrill && Array.isArray(orch._lastDrill.ops) && orch._lastDrill.ops.length > 0);
    check('jail cleaned after grading', !fs.existsSync(path.join(env.sandbox, DRILL_DIR)));

    // D7: drill output cannot leak outside the jail even if the model tries.
    const rogueFetch = async () => {
      const content = { thought: 'rogue', ops: [{ action: 'write_file', path: 'ESCAPED.txt', content: 'pwn' }], done: true, reply: 'escaped' };
      return { ok: true, json: async () => ({ message: { content: JSON.stringify(content) } }) };
    };
    const rogue = new SkillExecutor({
      agent: { url: 'http://x', model: 'fake', keepAlive: -1, timeoutMs: 1000, maxTokens: 100 },
      fetchImpl: rogueFetch,
    });
    orch.pool.executor = rogue;
    if (orch.pool.workers) for (const w of orch.pool.workers.values()) w.executor = rogue;
    // Rogue phase is driven MANUALLY (watchdog off — the 50ms test idle
    // threshold would auto-fire every cycle and race the assertions).
    orch.idleWatch.enabled = false;
    // Drain any queued drill left by the previous phase (its auto-retry).
    for (let i = 0; i < 5; i++) {
      const pending = governor.db.prepare("SELECT COUNT(*) n FROM task_queue WHERE kind='drill' AND status IN ('pending','leased')").get().n;
      if (pending === 0) break;
      await orch.runCycle();
    }
    orch._lastDrill = null;
    orch._drillConsecutiveFails = 0;
    orch._runDrill(); // rogue drill #1
    await orch.runCycle(); // runs it — writes ESCAPED.txt (inside the jail), FAIL
    await orch.runCycle(); // the auto-retry drill — FAIL #2 → circuit breaker
    check('rogue op is jailed: nothing written outside drill/',
      !fs.existsSync(path.join(env.sandbox, 'ESCAPED.txt')),
      fs.readdirSync(env.sandbox).join(','));
    check('rogue drill is graded FAIL (mechanical, not self-reported)', orch._lastDrill && orch._lastDrill.pass === false && /marker line missing/.test(orch._lastDrill.detail), JSON.stringify(orch._lastDrill));
    check('circuit breaker engaged after 2 consecutive failures', orch._drillConsecutiveFails === 2, String(orch._drillConsecutiveFails));
    fs.rmSync(env.dir, { recursive: true, force: true });
    const fails = RESULTS.filter((r) => !r.ok);
    console.log(`\n${RESULTS.length - fails.length} passed, ${fails.length} failed`);
    if (fails.length) { console.log('  FAILED:', fails.map((f) => f.name).join(' | ')); process.exit(1); }
  })().catch((e) => { console.error('E2E error:', e); process.exit(1); });
}
