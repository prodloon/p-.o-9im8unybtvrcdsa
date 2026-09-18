#!/usr/bin/env node
'use strict';
/**
 * Daisy Chain — Skill Executor (Round 9)
 * =======================================
 * The missing step between skill injection and task completion.
 *
 * Before this module, SNIPE only CONSUMED the injected skill (read its
 * prose into worker state and reported done) — the skill's directives
 * were never turned into actions. This executor closes that gap:
 *
 *   1. PLAN   — build a list of file operations from the skill + task.
 *               Tier 1: deterministic builders for skills whose directives
 *               are formulaic (scaffold-express-api, write-text) — instant, $0.
 *               Tier 2: when no builder exists, ask local Ollama for a JSON
 *               plan ({ops:[...]}), same model + timeout as the consult path.
 *   2. VALIDATE — strict op allowlist: write_file / append_file / mkdir only,
 *               relative paths (the worker's _safePath is the final jail),
 *               per-op and total size caps, op-count cap.
 *   3. EXECUTE — run each op through the worker's existing sandbox-guarded
 *               actions, so path safety has exactly one enforcement point.
 *   4. CHECK  — run the skill's acceptance checks (e.g. `node --check` on
 *               generated JS) and report filesWritten.
 *
 * Failure semantics: an execution error fails the task (it is a real
 * worker step, so the poison guard and retry path apply unchanged).
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const POLICY = {
  MAX_OPS: 50,               // runaway-plan guard
  MAX_OP_BYTES: 200_000,     // per-op content cap (200 KB)
  MAX_TOTAL_BYTES: 1_000_000, // whole-plan cap (1 MB)
  TIER2_PLAN_TIMEOUT_MS: Number(process.env.DAISY_OLLAMA_TIMEOUT_MS) || 30_000, // same knob as consults
  TIER2_PLAN_MAX_TOKENS: 800, // plans are bigger than consult verdicts
  // --- Freeform AGENT planning (own budget, own model) ---------------------
  // Model bake-off (2026-09-17, this CPU-only Mac, live planning probes):
  //   qwen2.5:1.5b — fast (~11s) but HALLUCINATES: replies "created X" with
  //     zero ops on every retry → useless as an agent brain.
  //   llama3.2:3b — reliably plans correct ops, ~40s warm. PINNED default.
  //   qwen2.5:3b — plans but wrong op shape; 2-4min for coder/12b models.
  // The AGENT path therefore does NOT share the consult model. Override:
  // DAISY_AGENT_MODEL (set '0' to disable the agent brain entirely).
  AGENT_MODEL: process.env.DAISY_AGENT_MODEL || 'llama3.2:3b',
  AGENT_PLAN_TIMEOUT_MS: Number(process.env.DAISY_AGENT_TIMEOUT_MS) || 240_000, // cold-load + thinking
  AGENT_PLAN_MAX_TOKENS: 1200,
  AGENT_KEEP_ALIVE: -1, // pin the model so warm replies stay ~40s not ~2min // plans are bigger than consult verdicts
  // --- ReAct loop (Round 10: reason → act → observe, until done) -----------
  // The brain no longer plans everything in one shot: each round it may
  // call a tool (list/read/write/…), see the REAL observation, and reason
  // again — until it answers with done:true. Hard step budget + byte
  // budget; every tool call goes through the worker's sandbox-jailed actions.
  AGENT_MAX_STEPS: Number(process.env.DAISY_AGENT_MAX_STEPS) || 12, // hard loop budget
  // Lease window for one agent round. MUST exceed the model round time
  // (AGENT_PLAN_TIMEOUT_MS) + tool time + margin: the lease is renewed at
  // the START of each round to cover the whole round — a 240s inference
  // with a 55s lease would get the task reaped mid-thinking.
  AGENT_LEASE_MS: 300_000,
  AGENT_OBSERVATION_CAP: 2000,  // chars of tool output fed back per round
  AGENT_READ_CAP: 12_000,       // read_file tool refuses bigger files (observation hygiene)
  AGENT_BUDGET: {
    maxBytes: Number(process.env.DAISY_AGENT_BUDGET_BYTES) || 600_000, // total bytes written per turn
  },
};

// Only content-producing actions are legal in a plan. delete_file is
// DELIBERATELY absent: a model-authored plan must never destroy data.
const PLAN_ACTIONS = new Set(['write_file', 'append_file', 'mkdir']);

const TIER1_BUILDERS = {
  'scaffold-express-api': planScaffoldExpress,
  'write-text': planWriteText,
};

// ---------------------------------------------------------------------------
// Tier-1 deterministic builders — pure functions of (task, summary) → ops.
// ---------------------------------------------------------------------------

/** Extract a project/resource name from a free-form summary. */
function _projectName(summary, fallback = 'app') {
  const m = String(summary || '').match(/\bfor\s+(?:my\s+|the\s+)?([a-z][a-z0-9 _-]{0,40})/i);
  let name = m ? m[1].trim() : '';
  // Drop trailing modifier clauses ("...for gym sessions with a health
  // endpoint" → project "gym-sessions", the "with…" is a requirement, not
  // the name). Cap at three words.
  name = name.split(/\bwith\b/i)[0].trim().split(/\s+/).slice(0, 3).join(' ');
  name = name.replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return name || fallback;
}

/** Pluralize-ish resource slug for route files ("invoices" from "invoice"). */
function _resources(summary) {
  const m = String(summary || '').match(/\b(?:api|routes?|crud|endpoints?)\s+for\s+([a-z0-9 _-]{2,40})/i) ||
    String(summary || '').match(/\bfor\s+(?:managing\s+|tracking\s+)?([a-z][a-z0-9 _-]{2,40})/i);
  if (!m) return ['items'];
  // Same trailing-clause trim as _projectName: "gym sessions with a health
  // endpoint" is the resource "gym sessions" + a requirement.
  const raw = m[1].trim().split(/\bwith\b/i)[0].trim().split(/\s+/).slice(0, 3).join(' ')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return raw ? [raw] : ['items'];
}

function planScaffoldExpress(task, summary) {
  const name = _projectName(summary);
  const resources = _resources(summary);
  const pkg = JSON.stringify(
    { name, version: '0.1.0', private: true, scripts: { start: 'node src/index.js' }, dependencies: { express: '^4' } },
    null, 2,
  ) + '\n';
  const routes = resources
    .map((r) => `const express = require('express');\nconst router = express.Router();\n\n// ${r}: deterministic scaffold — handlers are synchronous placeholders.\nrouter.get('/', (req, res) => res.json({ resource: '${r}', items: [] }));\n\nmodule.exports = router;\n`)
    .join('\n');
  const ops = [
    { action: 'write_file', path: `${name}/package.json`, content: pkg },
    { action: 'write_file', path: `${name}/src/index.js`, content: `'use strict';\nconst express = require('express');\nconst app = express();\napp.get('/health', (req, res) => res.json({ ok: true }));\n${resources.map((r) => `app.use('/${r}', require('./routes/${r}'));\n`).join('')}module.exports = app;\n` },
    { action: 'write_file', path: `${name}/src/routes/${resources[0]}.js`, content: routes },
    { action: 'write_file', path: `${name}/README.md`, content: `# ${name}\n\nScaffolded by the Daisy Chain cluster (skill: scaffold-express-api, tier-1 template).\n\nRoutes: GET /health` + resources.map((r) => `, GET /${r}`).join('') + '\n' },
  ];
  // Extra resources beyond the first get their own route files (mirrors the
  // skill's "one route file per resource" directive).
  for (const r of resources.slice(1)) {
    ops.push({
      action: 'write_file',
      path: `${name}/src/routes/${r}.js`,
      content: `const express = require('express');\nconst router = express.Router();\nrouter.get('/', (req, res) => res.json({ resource: '${r}', items: [] }));\nmodule.exports = router;\n`,
    });
  }
  return { ops, note: `tier-1 scaffold of '${name}' (${resources.length} resource route)` };
}

function planWriteText(task, summary) {
  const params = (task && task.payload && task.payload.params) || {};
  const p = typeof params.path === 'string' && params.path.trim() ? params.path.trim() : 'notes/composition.txt';
  // Never overwrite (skill directive #3): write, don't clobber — a plain
  // write_file of a fresh path; if the worker already has the file the
  // acceptance path uses append with a separator. Simplest correct behavior:
  // use append_file with a dated header so re-runs compose, never clobber.
  const body = typeof params.content === 'string' && params.content.trim()
    ? params.content
    : `[daisy-cluster note]\n${String(summary || '').trim()}\n(composed by skill: write-text)\n`;
  return { ops: [{ action: 'append_file', path: p, content: body }], note: `tier-1 write-text → ${p}` };
}

// ---------------------------------------------------------------------------
// Tier-2 planner: ask local Ollama for a JSON op plan.
// ---------------------------------------------------------------------------

const PLAN_SYSTEM_PROMPT = [
  'You are the planner of a sandboxed file-worker in the Daisy Chain cluster.',
  'You get a skill (markdown directives) and a task summary.',
  'Return ONE JSON object, no prose: {"ops":[{"action":"write_file","path":"relative/path","content":"..."}]}',
  'Allowed actions: write_file, append_file, mkdir. Paths must be relative (no .., no leading /). Never delete files.',
  'Follow the skill directives exactly; keep total content under 500 KB.',
].join(' ');

/** Ask tier-2 Ollama for an op plan. Returns {ops, note} or null (any failure → null). */
async function askTier2Plan(skill, task, summary, opts = {}) {
  const tier2 = opts.tier2;
  if (!tier2) return null;
  const fetchImpl = opts.fetchImpl || ((...a) => globalThis.fetch(...a));
  try {
    const res = await fetchImpl(tier2.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: tier2.model,
        messages: [
          { role: 'system', content: PLAN_SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify({ skill: skill.name, directives: skill.content, task_summary: String(summary || ''), existing_files: opts.existingFiles || [] }) },
        ],
        stream: false,
        format: 'json',
        keep_alive: tier2.keepAlive,
        options: { temperature: 0.2, num_predict: POLICY.TIER2_PLAN_MAX_TOKENS },
      }),
      signal: AbortSignal.timeout(opts.timeoutMs || POLICY.TIER2_PLAN_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const content = (body && body.message && body.message.content) || '';
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed.ops)) return null;
    return { ops: parsed.ops, note: `tier-2 plan (${tier2.model})` };
  } catch {
    return null; // timeout/offline/malformed → caller decides fallback
  }
}

// ---------------------------------------------------------------------------
// Freeform agent planner (AGENT action) — no skill required.
// ---------------------------------------------------------------------------

/**
 * Normalize one model-authored op to the executor's {action, path, content}
 * shape. Small models emit variants: op/file/field instead of action/path.
 * Returns null for unrecognizable ops (dropped before validation).
 */
function normalizeOp(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const action = raw.action || raw.op || raw.type;
  const p = raw.path || raw.file || raw.target || raw.filename;
  const op = { action, path: p, content: raw.content };
  if (typeof op.action !== 'string' || typeof op.path !== 'string') return null;
  op.action = op.action.toLowerCase();
  if (op.action === 'write' || op.action === 'create') op.action = 'write_file';
  if (op.action === 'append') op.action = 'append_file';
  if (typeof op.content !== 'string') op.content = op.content == null ? '' : String(op.content);
  return op;
}

const AGENT_SYSTEM_PROMPT = [
  'You are the agent brain of the Daisy Chain cluster, running a Reason+Act loop against a sandboxed file worker.',
  'The sandbox may already contain a project — you start with the file inventory; call the read_file tool for contents before modifying anything.',
  'Each round you return ONE JSON object, no prose, and you will see the REAL result of your action before the next round:',
  '  call a tool: {"thought":"short reasoning","tool":"list_files","args":{"dir":"src"}}',
  '  write files: {"thought":"...","ops":[{"action":"write_file","path":"src/x.js","content":"..."}]}',
  '  finish:      {"thought":"...","done":true,"reply":"what you did for the user, 1-3 sentences"}',
  'Tools: list_files(dir?), read_file(path), file_stats(path), write_file(path,content), append_file(path,content), mkdir(path), http_get_json(url).',
  'Ops actions allowed: write_file, append_file, mkdir. Paths relative (no .., no leading /). Never delete files. Full file contents, never diffs.',
  'You have a limited step budget — do not waste rounds; work independently and never ask the user questions mid-task.',
  'HARD RULE: never claim a file exists unless you wrote it in THIS conversation. A pure question gets done:true and the answer, immediately.',
  'HARD RULE: finish honestly. The reply must state what you DID (tools called, files written) or the real answer — restating the request as if it were done ("a summary has been written") without doing the work is a failure and will be caught.',
].join(' ');

const AGENT_TOOLS = ['list_files', 'read_file', 'file_stats', 'write_file', 'append_file', 'mkdir', 'http_get_json'];

function _clip(v, cap) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > cap ? s.slice(0, cap) + `…[clipped, ${s.length} chars]` : s;
}

/**
 * One Ollama JSON request with the given transcript → parsed object.
 * Returns null on any failure (offline, timeout, non-JSON, unparseable).
 */
async function callOllamaJson(opts, messages) {
  const agent = opts.agent;
  const fetchImpl = opts.fetchImpl || ((...a) => globalThis.fetch(...a));
  try {
    const res = await fetchImpl(agent.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: agent.model,
        messages,
        stream: false,
        format: 'json',
        keep_alive: agent.keepAlive,
        options: { temperature: 0.2, num_predict: agent.maxTokens || POLICY.AGENT_PLAN_MAX_TOKENS },
      }),
      signal: AbortSignal.timeout(agent.timeoutMs || POLICY.AGENT_PLAN_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const content = (body && body.message && body.message.content) || '';
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/**
 * Execute one tool call inside the sandbox jail. Returns {ok, result} and
 * NEVER throws — errors become observations the brain can reason about
 * (that is the O in ReAct: a failed read teaches the model the file is absent).
 */
async function runTool(worker, name, args) {
  try {
    if (!AGENT_TOOLS.includes(name)) throw new Error(`unknown tool '${name}' (have: ${AGENT_TOOLS.join(', ')})`);
    if (!args || typeof args !== 'object') throw new Error('args must be an object');
    const p = typeof args.path === 'string' ? args.path : '';
    if ((name === 'read_file' || name === 'file_stats') && p) {
      const st = fs.statSync(path.join(worker.root, p));
      if (st.size > POLICY.AGENT_READ_CAP) {
        return { ok: true, result: `[skipped: ${p} is ${st.size} bytes, over the ${POLICY.AGENT_READ_CAP}-byte read cap]` };
      }
    }
    const fn = worker[`act_${name}`];
    if (!fn) throw new Error(`tool '${name}' unavailable`);
    const out = fn.call(worker, args);
    return { ok: true, result: out && typeof out.then === 'function' ? await out : out };
  } catch (e) {
    return { ok: false, result: e && e.message ? e.message : String(e) };
  }
}

/**
 * The ReAct loop — the agentic flow proper.
 * Round: brain answers {thought, tool, args} → runTool → observation appended
 * to the transcript → next round. When the brain answers with ops, they are
 * executed through the sandbox-jailed actions. When it answers with
 * done:true + reply, the turn ends. Single-round {ops, reply} answers (the
 * Round-9 format) remain valid: they finish immediately.
 *
 * Safety: hard step budget (AGENT_MAX_STEPS), per-op + total byte budgets,
 * sandbox jail on every tool/op, and a lease-renewal hook so long turns are
 * not reaped mid-flight (the loop abandons itself if the lease is lost).
 */
async function runAgentLoop(worker, task, summary, existingFiles, opts = {}) {
  const agent = opts.agent;
  if (!agent) throw new Error('agent brain not configured (no AGENT model)');
  const fetchImpl = opts.fetchImpl || ((...a) => globalThis.fetch(...a));
  const leaseMs = agent.leaseMs || POLICY.AGENT_LEASE_MS;
  const maxSteps = agent.maxSteps || POLICY.AGENT_MAX_STEPS;
  const renew = typeof opts.renewLease === 'function' ? opts.renewLease : null;
  const onRound = typeof opts.onRound === 'function' ? opts.onRound : null;
  const reportRound = (info) => { if (onRound) { try { onRound(info); } catch { /* progress is best-effort */ } } };

  const messages = [
    { role: 'system', content: AGENT_SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify({ request: String(summary || ''), existing_files: existingFiles || [] }) },
  ];
  const ops = [];
  const toolCalls = [];
  let bytesWritten = 0;
  let reply = '';
  let steps = 0;
  let nudges = 0;
  // Does the user's request ask for actual work? Pure Q&A ("explain X",
  // "what is Y") never needs a nudge; work verbs do.
  const requestDemandsWork = /\b(write|create|make|add|update|fix|organize|scaffold|summarize|summarise|review|refactor|clean|rename|move|generate|build)\b/i.test(String(summary || ''));
  let staleAt = Date.now() + leaseMs;
  reportRound({ round: 0, tool: null, ops: 0 });

  while (steps < maxSteps) {
    steps += 1;
    // Renew the lease to cover THIS round (model call + tool). The renewal
    // itself is the liveness check: it throws if the task's lease was lost
    // (worker died / reaper raced), aborting the turn promptly.
    staleAt = Date.now() + leaseMs;
    if (renew) {
      try {
        renew(staleAt, { round: steps });
      } catch (e) {
        // Lease lost — the reaper requeued this task; continuing would work
        // under a stale identity. Abandon the turn promptly.
        throw new Error(`agent turn aborted: lease lost after round ${steps} (${e.message})`);
      }
    }

    const parsed = await callOllamaJson(opts, messages);
    if (!parsed || typeof parsed !== 'object') {
      // Same honest-failure contract as before the loop existed: model down,
      // timed out, or returned garbage → the task fails, it never fakes done.
      throw new Error('agent planner unavailable (model down or timed out) — task failed honestly, retry');
 }
    const thought = typeof parsed.thought === 'string' ? parsed.thought : '';

    // --- ACT: model-authored file ops -------------------------------------
    if (Array.isArray(parsed.ops) && parsed.ops.length) {
      for (const raw of parsed.ops) {
        const op = normalizeOp(raw);
        if (!op) continue;
        if (!PLAN_ACTIONS.has(op.action)) throw new Error(`round ${steps}: op action '${op.action}' not allowed`);
        const size = Buffer.byteLength(String(op.content || ''), 'utf8');
        if (size > POLICY.MAX_OP_BYTES) throw new Error(`round ${steps}: op content ${size}B exceeds per-op cap ${POLICY.MAX_OP_BYTES}`);
        bytesWritten += size;
        if (bytesWritten > POLICY.AGENT_BUDGET.maxBytes) throw new Error(`agent budget exceeded: ${bytesWritten}B written (cap ${POLICY.AGENT_BUDGET.maxBytes})`);
        const fn = worker[`act_${op.action}`];
        if (!fn) throw new Error(`round ${steps}: worker has no action '${op.action}'`);
        const params = op.action === 'mkdir' ? { path: op.path } : { path: op.path, content: op.content };
        try { fn.call(worker, params); } catch (e) { throw new Error(`round ${steps}: ${op.action} ${op.path} failed: ${e.message}`); }
        // Keep the FULL op (content included): executeAgent validates this
        // list and must not re-execute it — the op already landed.
        ops.push({ action: op.action, path: op.path, content: op.content });
      }
      reportRound({ round: steps, tool: null, ops: ops.length });
      // Single-round plan (Round-9 shape: ops + reply, no tool/done) or an
      // explicit done after ops → finish now.
      if (parsed.done === true || (!parsed.tool && typeof parsed.reply === 'string' && parsed.reply.trim())) {
        reply = String(parsed.reply || '').trim();
        break;
      }
      messages.push({ role: 'assistant', content: JSON.stringify({ thought, wrote: parsed.ops.length }) });
      messages.push({ role: 'user', content: JSON.stringify({ observation: `${parsed.ops.length} op(s) written to the sandbox. Continue with the next tool call, or finish with {"done":true,"reply":"..."}.` }) });
      continue;
    }

    // --- FINISH: pure answer / explicit done ------------------------------
    if ((typeof parsed.reply === 'string' && parsed.reply.trim() && !parsed.tool) || parsed.done === true) {
      // Anti-laziness guard: finishing with ZERO work (no ops, no tool calls
      // all turn) on a request that asks for work is exactly how small models
      // "answer" without acting — e.g. replying "A summary of the project."
      // to "write a summary file". Give ONE pointed continuation whose
      // observation makes the omission explicit, then accept the reply even
      // if it stays work-free (genuine Q&A must keep working).
      if (ops.length === 0 && toolCalls.length === 0 && nudges < 1 && requestDemandsWork) {
        nudges += 1;
        messages.push({ role: 'assistant', content: JSON.stringify({ thought, done: true, reply: _clip(String(parsed.reply || ''), 120) }) });
        messages.push({ role: 'user', content: JSON.stringify({ observation: 'you have made no tool calls and written nothing this turn — do the actual work with tools/ops now, or answer done:true with the complete real result if none is genuinely needed', ok: false }) });
        continue;
      }
      reply = String(parsed.reply || '').trim();
      break;
    }

    // --- REASON+ACT: call a tool, observe, loop ---------------------------
    const tool = typeof parsed.tool === 'string' ? parsed.tool : null;
    if (!tool) throw new Error(`agent brain round ${steps}: no tool, no ops, not done (thought: ${_clip(thought, 120) || 'none'})`);
    const obs = await runTool(worker, tool, parsed.args);
    toolCalls.push({ step: steps, tool, args: parsed.args, ok: obs.ok });
    reportRound({ round: steps, tool, ops: ops.length });
    if (tool === 'write_file' || tool === 'append_file') ops.push({ action: tool, path: (parsed.args && parsed.args.path) || '?' });
    messages.push({ role: 'assistant', content: JSON.stringify({ thought, tool, args: parsed.args }) });
    messages.push({ role: 'user', content: JSON.stringify({ observation: _clip(obs.result, POLICY.AGENT_OBSERVATION_CAP), ok: obs.ok }) });
  }
  if (!reply) throw new Error(`agent ran out of steps (${maxSteps}) without finishing`);
  return {
    ops,
    reply,
    note: `agent plan (react: ${agent.model}, ${steps} round(s), ${toolCalls.length} tool call(s))`,
    rounds: steps,
    toolCalls,
    alreadyExecuted: true, // the loop executes ops as it goes — never re-run
  };
}

// ---------------------------------------------------------------------------
// Validation + execution.
// ---------------------------------------------------------------------------

/**
 * Validate a plan. Throws on ANY violation — a plan is either fully legal
 * or not executed at all (no partial application of a corrupt plan).
 */
function validateOps(ops) {
  if (!Array.isArray(ops) || ops.length === 0) throw new Error('plan contains no ops');
  if (ops.length > POLICY.MAX_OPS) throw new Error(`plan too large: ${ops.length} ops (max ${POLICY.MAX_OPS})`);
  let total = 0;
  for (const [i, op] of ops.entries()) {
    if (!op || typeof op !== 'object') throw new Error(`op ${i}: not an object`);
    if (!PLAN_ACTIONS.has(op.action)) throw new Error(`op ${i}: action '${op.action}' not allowed (only ${[...PLAN_ACTIONS].join(', ')})`);
    const p = op.path;
    if (typeof p !== 'string' || !p.trim()) throw new Error(`op ${i}: missing path`);
    if (path.isAbsolute(p) || p.includes('..')) throw new Error(`op ${i}: path must be relative and stay inside the sandbox: ${p}`);
    const size = Buffer.byteLength(String(op.content || ''), 'utf8');
    if (size > POLICY.MAX_OP_BYTES) throw new Error(`op ${i}: content ${size} bytes exceeds per-op cap ${POLICY.MAX_OP_BYTES}`);
    total += size;
    if (total > POLICY.MAX_TOTAL_BYTES) throw new Error(`plan total ${total} bytes exceeds cap ${POLICY.MAX_TOTAL_BYTES}`);
  }
  return ops;
}

/**
 * Execute a validated plan through the worker's own (sandbox-jailed) actions.
 * @returns {{executed: Array, filesWritten: string[]}}
 */
function executeOps(worker, ops) {
  const executed = [];
  const filesWritten = [];
  for (const op of ops) {
    const fn = worker[`act_${op.action}`];
    if (!fn) throw new Error(`worker has no action '${op.action}'`);
    const params = op.action === 'mkdir' ? { path: op.path } : { path: op.path, content: op.content };
    const result = fn.call(worker, params);
    executed.push({ action: op.action, path: op.path, ok: true });
    if (op.action !== 'mkdir') filesWritten.push(op.path);
  }
  return { executed, filesWritten };
}

/**
 * Acceptance checks per skill (knowledge: skill "Acceptance checks" blocks).
 * Throws on failure → the task fails honestly instead of lying "done".
 */
function runAcceptanceChecks(skillName, worker, ops) {
  if (skillName === 'scaffold-express-api') {
    // Every generated .js must parse.
    const jsOps = ops.filter((o) => o.action === 'write_file' && o.path.endsWith('.js'));
    for (const op of jsOps) {
      const full = require('path').join(worker.root, op.path);
      execFileSync(process.execPath, ['--check', full], { timeout: 10_000 });
    }
    return `${jsOps.length} js file(s) parse`;
  }
  if (skillName === 'write-text') {
    const wrote = ops.find((o) => o.action === 'write_file' || o.action === 'append_file');
    if (!wrote) throw new Error('write-text acceptance: nothing written');
    return 'target written';
  }
  return null; // no acceptance contract for this skill yet
}

/** Skill name → tier-1 builder, if one exists. */
function hasTier1Builder(skillName) {
  return typeof TIER1_BUILDERS[skillName] === 'function';
}

class SkillExecutor {
  /**
   * @param {object} opts
   * @param {object} [opts.tier2]      bridge-tier2 object {url, model, keepAlive} — null disables the planner
   * @param {Function} [opts.fetchImpl] injectable fetch (tests)
   * @param {number}   [opts.timeoutMs]
   */
  constructor(opts = {}) {
    this.tier2 = opts.tier2 !== undefined ? opts.tier2 : null;
    this.agent = opts.agent !== undefined ? opts.agent : null;
    this.fetchImpl = opts.fetchImpl;
    this.timeoutMs = opts.timeoutMs || POLICY.TIER2_PLAN_TIMEOUT_MS;
    this.onRound = typeof opts.onRound === 'function' ? opts.onRound : null; // per-round progress hook (orchestrator registry)
  }

  /**
   * Full pipeline for one injected skill + task.
   * @returns {{planSource:'tier1-builder'|'tier2-plan', note:string, ops:Array,
   *                 executed:Array, filesWritten:string[], acceptance:string|null}}
   */
  async execute(worker, task) {
    const skill = worker.state.skillContent != null
      ? { name: worker.state.injectedSkill, content: worker.state.skillContent }
      : null;
    if (!skill) throw new Error('executor: no skill injected');
    const summary = String((task.payload && (task.payload.summary || task.payload.action)) || task.kind);

    // --- PLAN ---------------------------------------------------------------
    let plan = null;
    let planSource = null;
    const builder = TIER1_BUILDERS[skill.name];
    if (builder) {
      plan = builder(task, summary);
      planSource = 'tier1-builder';
    } else {
      let existingFiles = [];
      try { existingFiles = worker.act_list_files({ dir: '.' }).files; } catch { /* fresh sandbox */ }
      const t2 = await askTier2Plan(skill, task, summary, {
        tier2: this.tier2, fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs, existingFiles,
      });
      if (t2) {
        plan = t2;
        planSource = 'tier2-plan';
      }
    }
    if (!plan) throw new Error(`no plan possible for skill '${skill.name}' (no tier-1 builder, tier-2 planner unavailable)`);

    // --- VALIDATE → EXECUTE → CHECK ------------------------------------------
    const ops = validateOps(plan.ops);
    const { executed, filesWritten } = executeOps(worker, ops);
    worker.state.filesWritten.push(...filesWritten);
    const acceptance = runAcceptanceChecks(skill.name, worker, ops);

    return {
      appliedSkill: skill.name,
      source: worker.state.skillSource, // consult provenance, unchanged contract
      planSource,
      note: plan.note,
      executed,
      filesWritten,
      acceptance,
    };
  }

  /**
   * Freeform agent turn: no skill, no triggers — the user just says what
   * they want and the model plans ops against the existing sandbox (with
   * existing file CONTENTS so it can read/modify the project). The user-
   * facing reply comes back in `reply` for the chat UI.
   */
  async executeAgent(worker, task, opts = {}) {
    if (!this.agent) throw new Error('agent brain not configured (no AGENT model)');
    const summary = String((task.payload && (task.payload.summary || task.payload.action)) || task.kind);
    // Hand the model the project: names + contents of text files under 20KB,
    // names only for big/binary ones. This is what makes it work "on the
    // project" — it sees the code before planning.
    const existingFiles = [];
    try {
      const walk = (dir, prefix) => {
        for (const name of worker.act_list_files({ dir }).files) {
          if (name === 'node_modules' || name.startsWith('.')) continue;
          const rel = prefix ? `${prefix}/${name}` : name;
          const full = require('path').join(worker.root, rel);
          let st = null;
          try { st = fs.statSync(full); } catch { continue; }
          if (st.isDirectory()) { walk(name, rel); continue; }
          if (st.size <= 20_000 && st.isFile()) {
            let content = '';
            try { content = fs.readFileSync(full, 'utf8'); } catch { /* binary-ish */ }
            existingFiles.push({ path: rel, content });
          } else {
            existingFiles.push({ path: rel, content: null }); // name only
          }
        }
      };
      walk('.', null);
    } catch { /* fresh sandbox */ }
    if (existingFiles.length > 120) existingFiles.length = 120; // context cap

    const plan = await runAgentLoop(worker, task, summary, existingFiles, {
      agent: this.agent,
      fetchImpl: this.fetchImpl,
      maxSteps: opts.maxSteps,
      renewLease: typeof opts.renewLease === 'function' ? opts.renewLease : null,
      onRound: (info) => {
        // Fan the round info out: the caller's per-task hook (worker →
        // progress file) and the executor-level hook (orchestrator → live
        // registry), enriched with the task id so both can attribute it.
        const enriched = { ...info, taskId: task.id };
        if (typeof opts.onRound === 'function') { try { opts.onRound(enriched); } catch { /* best-effort */ } }
        if (typeof this.onRound === 'function') { try { this.onRound(enriched); } catch { /* best-effort */ } }
      },
    });
    if (!plan) throw new Error('agent planner unavailable (model down or timed out) — task failed honestly, retry');
    // Unlike skill plans, an AGENT turn may legitimately have ZERO ops — a
    // pure answer to a question is a complete turn. Only NON-empty plans
    // are validated/executed.
    const ops = plan.ops.length > 0 ? validateOps(plan.ops) : [];
    // ReAct turns execute their ops INSIDE the loop (the model observes each
    // round's real result) — re-running them here would clobber files with
    // empty content. Builders return planSource='tier1-builder' and DO rely
    // on this trailing execution, so only skip for executed ReAct turns.
    let executed = [];
    let filesWritten = [];
    if (plan.alreadyExecuted) {
      executed = ops.map((o) => ({ action: o.action, path: o.path, ok: true }));
      filesWritten = ops.filter((o) => o.action !== 'mkdir').map((o) => o.path);
    } else {
      ({ executed, filesWritten } = executeOps(worker, ops));
    }
    worker.state.filesWritten.push(...filesWritten);
    let reply = String(plan.reply || '').trim();
    if (ops.length === 0 && /\b(created|wrote|writt?en|added|updated|modified|deleted|saved|made)\b/i.test(reply)) {
      const sentences = reply.split(/(?<=[.!?])\s+/);
      const honest = sentences.filter((s) => !/\b(created|wrote|writt?en|added|updated|modified|deleted|saved|made)\b/i.test(s));
      reply = (honest.length ? honest.join(' ') : 'No changes were made.')
        + ' No changes were made to the sandbox this turn.';
    }
    return {
      appliedSkill: null,
      source: 'agent',
      planSource: 'agent-plan',
      note: plan.note,
      executed,
      filesWritten,
      acceptance: null,
      reply,
      ops: ops.map((o) => ({ action: o.action, path: o.path })),
      rounds: plan.rounds || 1,
      observations: plan.toolCalls || [],
    };
  }
}

module.exports = {
  SkillExecutor, validateOps, executeOps, runAcceptanceChecks,
  hasTier1Builder, askTier2Plan, runAgentLoop, runTool, callOllamaJson, AGENT_TOOLS,
  TIER1_BUILDERS, PLAN_ACTIONS, POLICY,
};
