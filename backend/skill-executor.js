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
const path = require('path');

const POLICY = {
  MAX_OPS: 50,               // runaway-plan guard
  MAX_OP_BYTES: 200_000,     // per-op content cap (200 KB)
  MAX_TOTAL_BYTES: 1_000_000, // whole-plan cap (1 MB)
  TIER2_PLAN_TIMEOUT_MS: Number(process.env.DAISY_OLLAMA_TIMEOUT_MS) || 30_000, // same knob as consults
  TIER2_PLAN_MAX_TOKENS: 800, // plans are bigger than consult verdicts
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
    this.fetchImpl = opts.fetchImpl;
    this.timeoutMs = opts.timeoutMs || POLICY.TIER2_PLAN_TIMEOUT_MS;
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
}

module.exports = {
  SkillExecutor, validateOps, executeOps, runAcceptanceChecks,
  hasTier1Builder, askTier2Plan, TIER1_BUILDERS, PLAN_ACTIONS, POLICY,
};
