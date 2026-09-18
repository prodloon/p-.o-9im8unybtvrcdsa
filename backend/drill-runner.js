'use strict';
/**
 * Daisy Chain — Idle-Drill Failsafe
 * ==================================
 * What: when the cluster has been fully idle (zero tasks done AND failed
 * across a whole cycle window) for DRILL_IDLE_MS, the orchestrator enqueues
 * a DRILL task for itself: a puzzle that
 *   (a) requires multiple rounds of tool use (read → reason → write),
 *   (b) has a different solution every time (crypto-random inputs),
 *   (c) is graded mechanically against the expected answer — success is
 *       measured, never self-reported,
 *   (d) runs in its own drill/ jail so it cannot touch real project files,
 *   (e) every outcome is visible in telemetry + the orchestrator log.
 *
 * Why: an idle agent that self-directs drifts (rogue rewrites, file spam,
 * hallucinated busy-work). A measured drill gives the brain a legitimate,
 * contained outlet for self-directed behavior and turns "is the agent
 * still functional?" into a continuously-verified property instead of a
 * hope. A failed drill is an alert, not a silent degradation.
 *
 * Off-switch: DAISY_DRILL=0 disables the watchdog entirely (idle metrics
 * still flow to telemetry). Override the cadence with DAISY_DRILL_IDLE_MS.
 */
const crypto = require('crypto');

const DRILL_DIR = 'drill';
const TOKEN_BYTES = 6; // 48 bits of entropy per token — collision-proof for drills

/** Crypto-random token, lowercase alphanumeric, ~11 chars. */
function token() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url').replace(/[^a-z0-9]/gi, '').toLowerCase()
    || crypto.randomBytes(4).toString('hex');
}

/** Pick a random element. */
function pick(arr) {
  return arr[crypto.randomInt(arr.length)];
}

/**
 * Generate one drill: { id, task, expected, grade }.
 *  - task:     the exact natural-language prompt for the agent
 *  - expected: hidden from the model; the grader compares against it
 *  - grade:    (files) → { pass, detail } — pure function of written files
 * The puzzle mixes three phases so one round cannot pass: the agent must
 * READ (config + ledger), REASON (arithmetic/composition), and WRITE.
 */
function generateDrill() {
  const nonce = token();
  const shape = pick(['word-chain', 'ledger-balance', 'echo-encode']);

  if (shape === 'word-chain') {
    const marker = `DRILL-${nonce}`;
    const task = [
      `This is a scheduled drill (nonce ${nonce}). Two steps, nothing else.`,
      `Step 1: read the file config.txt — it lists a WORD.`,
      `Step 2: write the file answer.txt with EXACTLY two lines:`,
      `  line 1: the marker ${marker}`,
      `  line 2: that WORD repeated exactly 3 times, space-separated (e.g. "w w w")`,
      `Do not create any other files or directories. Finish with done:true as soon as answer.txt is written.`,
    ].join(' ');
    return {
      id: `drill-wordchain-${nonce}`,
      task,
      expected: { marker },
      grade(files) {
        const body = String(files['answer.txt'] || '');
        const lines = body.split(/\r?\n/).filter((l) => l.trim() !== '');
        const cfg = String(files['config.txt'] || '');
        const m = cfg.match(/WORD=([a-z]+)/);
        if (!lines[0] || !lines[0].includes(marker)) return { pass: false, detail: 'marker line missing or wrong' };
        if (!m) return { pass: false, detail: 'config.txt corrupted (grader bug)' };
        const want = `${m[1]} ${m[1]} ${m[1]}`;
        if (lines[1] !== want) return { pass: false, detail: `line 2 is "${lines[1] || ''}", want "${want}"` };
        if (lines.length > 2) return { pass: false, detail: `${lines.length - 2} extra lines` };
        return { pass: true, detail: `word-chain correct (${m[1]} ×3)` };
      },
    };
  }

  if (shape === 'ledger-balance') {
    const a = crypto.randomInt(11, 99);
    const b = crypto.randomInt(11, 99);
    const c = crypto.randomInt(2, 9);
    const marker = `BAL-${nonce}`;
    const task = [
      `This is a scheduled drill (nonce ${nonce}). Two steps, nothing else.`,
      `Step 1: read ledger.txt — it records three transactions (a credit, a debit, a fee multiplier).`,
      `Step 2: write balance.txt with exactly two lines:`,
      `  line 1: the marker ${marker}`,
      `  line 2: the net balance as a plain integer (credit minus debit, times the multiplier)`,
      `Do not create any other files or directories. Finish with done:true as soon as balance.txt is written.`,
    ].join(' ');
    return {
      id: `drill-ledger-${nonce}`,
      task,
      expected: { marker, a, b, c },
      grade(files) {
        const lines = String(files['balance.txt'] || '').split(/\r?\n/).filter((l) => l.trim() !== '');
        if (!lines[0] || !lines[0].includes(marker)) return { pass: false, detail: 'marker line missing or wrong' };
        const want = String((a - b) * c);
        if (lines[1] !== want) return { pass: false, detail: `balance is "${lines[1] || ''}", want ${want}` };
        if (lines.length > 2) return { pass: false, detail: `${lines.length - 2} extra lines` };
        return { pass: true, detail: `ledger balanced ((${a}-${b})×${c}=${want})` };
      },
    };
  }

  // echo-encode
  const codeword = token(8);
  const marker = `ECHO-${nonce}`;
  const task = [
    `This is a scheduled drill (nonce ${nonce}). Two steps, nothing else.`,
    `Step 1: read codeword.txt.`,
    `Step 2: write echo.txt with exactly two lines:`,
    `  line 1: the marker ${marker}`,
    `  line 2: the codeword reversed, then ":${codeword.length}" appended (the original length)`,
    `Do not create any other files or directories. Finish with done:true as soon as echo.txt is written.`,
  ].join(' ');
  return {
    id: `drill-echo-${nonce}`,
    task,
    expected: { marker, codeword },
    grade(files) {
      const lines = String(files['echo.txt'] || '').split(/\r?\n/).filter((l) => l.trim() !== '');
      if (!lines[0] || !lines[0].includes(marker)) return { pass: false, detail: 'marker line missing or wrong' };
      const want = `${codeword.split('').reverse().join('')}:${codeword.length}`;
      if (lines[1] !== want) return { pass: false, detail: `echo is "${lines[1] || ''}", want "${want}"` };
      if (lines.length > 2) return { pass: false, detail: `${lines.length - 2} extra lines` };
      return { pass: true, detail: 'echo encoded correctly' };
    },
  };
}

/**
 * Seed files for a drill, written straight into the sandbox drill/ jail
 * (plain fs, not the model — the grader's ground truth must be exact).
 * Returns [{path, content}] for the caller to persist.
 */
function seedFiles(drill) {
  const files = [];
  const cfgName = drill.id.startsWith('drill-wordchain') ? 'config.txt'
    : drill.id.startsWith('drill-ledger') ? 'ledger.txt'
    : 'codeword.txt';
  if (drill.id.startsWith('drill-wordchain')) {
    const word = token(4);
    files.push({ path: `${DRILL_DIR}/config.txt`, content: `WORD=${word}\n` });
  } else if (drill.id.startsWith('drill-ledger')) {
    const { a, b, c } = drill.expected;
    files.push({
      path: `${DRILL_DIR}/ledger.txt`,
      content: `CREDIT=${a}\nDEBIT=${b}\nFEE_MULTIPLIER=${c}\n`,
    });
  } else {
    files.push({ path: `${DRILL_DIR}/codeword.txt`, content: `${drill.expected.codeword}\n` });
  }
  return files;
}

/**
 * IdleWatch: records per-cycle activity and says when to drill.
 * Fed the per-cycle task counts; drives nothing itself.
 */
class IdleWatch {
  constructor(opts = {}) {
    this.idleMs = Number(opts.idleMs || process.env.DAISY_DRILL_IDLE_MS) || 20 * 60 * 1000;
    this.enabled = process.env.DAISY_DRILL !== '0';
    this.state = 'disabled';
    this.idleSince = null;   // Date.now() when the current idle streak began
    this.lastDrillAt = null; // last drill enqueue time
    this.drillsQueued = 0;
  }

  /**
   * Feed one cycle's task outcome counts. Returns 'enqueue' | null.
   * Idle = zero tasks done AND failed this cycle (leased-in-flight does
   * not reset the streak: a genuinely stuck lease trips the reaper).
   */
  cycle(doneCount, failedCount) {
    if (!this.enabled) { this.state = 'disabled'; return null; }
    if (doneCount > 0 || failedCount > 0) {
      this.idleSince = null;
      this.state = 'busy';
      return null;
    }
    if (this.idleSince == null) {
      this.idleSince = Date.now();
      this.state = 'idle';
      return null;
    }
    this.state = 'idle';
    if (Date.now() - this.idleSince >= this.idleMs) {
      this.idleSince = Date.now(); // restart the streak window
      this.lastDrillAt = Date.now();
      this.drillsQueued += 1;
      this.state = 'drilling';
      return 'enqueue';
    }
    return null;
  }

  snapshot() {
    return {
      enabled: this.enabled,
      state: this.state,
      idleForSec: this.idleSince == null ? 0 : Math.round((Date.now() - this.idleSince) / 1000),
      thresholdSec: Math.round(this.idleMs / 1000),
      drillsQueued: this.drillsQueued,
      lastDrillAt: this.lastDrillAt,
    };
  }
}

/**
 * Stateless mechanical grader: re-derive the expected answer from the SEED
 * files (written by the failsafe, not the model) plus the marker embedded
 * in the task's own prompt — no in-memory state, survives restarts, and
 * trusts nothing the agent produced. `written` = {filename → content} of
 * the drill jail; seeds = raw seed-file contents (null = absent).
 */
function gradeFromDisk(written, { seedCfg, seedLedger, seedCodeword, taskSummary }) {
  const summary = String(taskSummary || '');
  const markerMatch = summary.match(/\b(DRILL|BAL|ECHO)-([a-z0-9]+)\b/);
  if (!markerMatch) return { pass: false, detail: 'no drill marker in task prompt (grader bug)' };
  const marker = markerMatch[0];
  const linesOf = (name) => String(written[name] || '').split(/\r?\n/).filter((l) => l.trim() !== '');

  if (seedCfg != null) {
    const m = seedCfg.match(/WORD=([a-z]+)/);
    if (!m) return { pass: false, detail: 'config.txt seed corrupted (grader bug)' };
    const lines = linesOf('answer.txt');
    if (!lines[0] || !lines[0].includes(marker)) return { pass: false, detail: 'marker line missing or wrong' };
    const want = `${m[1]} ${m[1]} ${m[1]}`;
    if (lines[1] !== want) return { pass: false, detail: `line 2 is "${lines[1] || ''}", want "${want}"` };
    if (lines.length > 2) return { pass: false, detail: `${lines.length - 2} extra lines` };
    return { pass: true, detail: `word-chain correct (${m[1]} ×3)` };
  }
  if (seedLedger != null) {
    const a = Number((seedLedger.match(/CREDIT=(\d+)/) || [])[1]);
    const b = Number((seedLedger.match(/DEBIT=(\d+)/) || [])[1]);
    const c = Number((seedLedger.match(/FEE_MULTIPLIER=(\d+)/) || [])[1]);
    if (![a, b, c].every(Number.isFinite)) return { pass: false, detail: 'ledger seed corrupted (grader bug)' };
    const lines = linesOf('balance.txt');
    if (!lines[0] || !lines[0].includes(marker)) return { pass: false, detail: 'marker line missing or wrong' };
    const want = String((a - b) * c);
    if (lines[1] !== want) return { pass: false, detail: `balance is "${lines[1] || ''}", want ${want}` };
    if (lines.length > 2) return { pass: false, detail: `${lines.length - 2} extra lines` };
    return { pass: true, detail: `ledger balanced ((${a}-${b})×${c}=${want})` };
  }
  if (seedCodeword != null) {
    const code = seedCodeword.trim();
    if (!code) return { pass: false, detail: 'codeword seed corrupted (grader bug)' };
    const lines = linesOf('echo.txt');
    if (!lines[0] || !lines[0].includes(marker)) return { pass: false, detail: 'marker line missing or wrong' };
    const want = `${code.split('').reverse().join('')}:${code.length}`;
    if (lines[1] !== want) return { pass: false, detail: `echo is "${lines[1] || ''}", want "${want}"` };
    if (lines.length > 2) return { pass: false, detail: `${lines.length - 2} extra lines` };
    return { pass: true, detail: 'echo encoded correctly' };
  }
  return { pass: false, detail: 'no seed files found in drill jail (grader bug)' };
}

module.exports = { generateDrill, seedFiles, gradeFromDisk, IdleWatch, DRILL_DIR };
