#!/usr/bin/env node
'use strict';
/**
 * Daisy Chain — Worker state machine (Phase 2)
 * =============================================
 * One deterministic state machine per task. NO local LLM inference —
 * cognitive decisions are delegated to the Cloud Supervisor by the
 * orchestrator (knowledge.md §2 division of labor).
 *
 * Lifecycle: registered → working → (SNIPE gate?) → done | failed
 *
 * SNIPE gate (Phase 3 contract): if a task's payload contains
 * `needsSkill: true`, the worker will NOT act until the orchestrator
 * injects a skill (injectedSkill) — enforcing the Supervisor's role
 * as the sole decider of "how" a cognitive task is done.
 *
 * Action library is intentionally deterministic and path-safe:
 * every file operation is jailed to `root` (no `..`, no absolute paths).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ACTIONS = ['list_files', 'read_file', 'write_file', 'append_file', 'delete_file', 'mkdir', 'file_stats', 'scaffold', 'http_get_json', 'SNIPE'];

class Worker {
  /**
   * @param {object} opts
   * @param {string} opts.id          e.g. 'w-0001'
   * @param {string} opts.kind        'file-io' | 'scaffold' | 'api-route' | ...
   * @param {object} opts.governor    Governor instance (for heartbeats/skill events)
   * @param {string} [opts.root]      sandbox root; defaults to cwd
   * @param {number} [opts.maxSteps]  safety bound on state transitions per task
   */
  constructor({ id, kind, governor, root = process.cwd(), maxSteps = 32 }) {
    if (!ACTIONS.every((a) => typeof a === 'string')) throw new Error('action table corrupted');
    this.id = id;
    this.kind = kind;
    this.governor = governor;
    // Per-agent usage accounting (surfaced in the telemetry dashboard):
    this.busyMs = 0;        // cumulative wall time inside step() — owned signal
    this._stepStartedAt = null;
    this.root = path.resolve(root);
    this.maxSteps = maxSteps;
    this.state = {
      phase: 'idle',           // idle | waiting_skill | working | done | failed
      attempts: 0,
      history: [],
      lastError: null,
      injectedSkill: null,     // set by orchestrator after skill-sniping
      skillSource: null,       // 'supervisor' | 'local-fallback'
      filesTouched: [],
      filesWritten: [],
    };
  }

  // --- path safety: jail all file ops to this.root ---------------------------
  _safePath(p) {
    const resolved = path.resolve(this.root, String(p));
    if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) {
      throw new Error(`path escapes sandbox: ${p}`);
    }
    return resolved;
  }

  _serialize(value) {
    if (value == null) return null;
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  // --- deterministic action library ------------------------------------------
  act_list_files({ dir = '.', pattern = null } = {}) {
    const base = this._safePath(dir);
    let names = fs.readdirSync(base);
    if (pattern) {
      const rx = new RegExp(pattern);
      names = names.filter((n) => rx.test(n));
    }
    return { files: names.sort() };
  }

  act_read_file({ path: p }) {
    const full = this._safePath(p);
    const stat = fs.statSync(full);
    if (stat.size > 1_000_000) throw new Error('file too large to read (1MB cap, mirrors daisy audit cap)');
    return { content: fs.readFileSync(full, 'utf8'), bytes: stat.size };
  }

  act_write_file({ path: p, content = '' }) {
    const full = this._safePath(p);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    this.state.filesWritten.push(p);
    return { written: p, bytes: Buffer.byteLength(content) };
  }

  act_append_file({ path: p, content = '' }) {
    const full = this._safePath(p);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.appendFileSync(full, content);
    return { appended: p, bytes: Buffer.byteLength(content) };
  }

  act_delete_file({ path: p }) {
    const full = this._safePath(p);
    fs.rmSync(full, { force: true });
    return { deleted: p };
  }

  act_mkdir({ path: p }) {
    const full = this._safePath(p);
    fs.mkdirSync(full, { recursive: true });
    return { created: p };
  }

  act_file_stats({ path: p }) {
    const s = fs.statSync(this._safePath(p));
    return { bytes: s.size, mtimeMs: s.mtimeMs, isFile: s.isFile() };
  }

  /** Scaffold a standard structure deterministically. */
  act_scaffold({ name, kind: projectKind = 'node-api' }) {
    const base = this._safePath(name);
    const files =
      projectKind === 'node-api'
        ? { 'package.json': `{\n  "name": "${name}",\n  "version": "0.1.0",\n  "private": true\n}\n`, 'src/index.js': "'use strict';\nconsole.log('scaffolded by daisy cluster');\n", 'README.md': `# ${name}\n` }
        : { 'README.md': `# ${name}\n` };
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(base, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    this.state.filesWritten.push(...Object.keys(files).map((r) => `${name}/${r}`));
    return { scaffolded: name, files: Object.keys(files) };
  }

  /** Deterministic JSON-only HTTP GET with size cap (no cognitive decisions). */
  async act_http_get_json({ url, timeoutMs = 10_000 }) {
    if (!/^https?:\/\//i.test(url)) throw new Error('http_get_json: only http(s) URLs allowed (mirrors daisy fetch_url policy)');
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'daisy-cluster-worker/0.1' },
    });
    const text = (await res.text()).slice(0, 1_000_000);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    try {
      return { json: JSON.parse(text) };
    } catch {
      throw new Error('http_get_json: response was not JSON');
    }
  }

  /**
   * SNIPE: consume the injected skill. This action is only legal AFTER the
   * orchestrator has run skill-sniping for this task — that's the gate.
   */
  act_SNIPE() {
    if (!this.state.injectedSkill) {
      throw new Error('SNIPE refused: no skill injected by orchestrator yet');
    }
    return {
      appliedSkill: this.state.injectedSkill,
      source: this.state.skillSource,
      note: 'skill context consumed into worker state',
    };
  }

  // --- state machine ----------------------------------------------------------

  /** The single transition step. Returns the worker's report for this step. */
  async step(task) {
    const startedAt = Date.now();
    this._stepStartedAt = startedAt;
    try {
      return await this._step(task);
    } finally {
      this.busyMs += Date.now() - startedAt; // busy time even on thrown steps
      this._stepStartedAt = null;
    }
  }

  /** Inner transition (wrapped by step() for busy-time accounting). */
  async _step(task) {
    this.state.attempts += 1;
    if (this.state.attempts > this.maxSteps) {
      this.state.phase = 'failed';
      throw new Error(`worker exceeded maxSteps (${this.maxSteps}) — runaway guard`);
    }
    this.governor.heartbeat(this.id);

    const { action, params = {} } = task.payload || {};
    if (task.payload && task.payload.needsSkill && !this.state.injectedSkill) {
      // Gate: cognitive task may not act until the Supervisor (or fallback)
      // has had its say — applies to SNIPE itself and any other action.
      this.state.phase = 'waiting_skill';
      return { workerId: this.id, taskId: task.id, phase: 'waiting_skill', needSkill: true };
    }

    this.state.phase = 'working';
    const fn = this[`act_${action}`];
    if (!fn) {
      this.state.phase = 'failed';
      return { workerId: this.id, taskId: task.id, ok: false, error: `unknown action '${action}'` };
    }
    try {
      const result = await fn.call(this, params);
      this.state.history.push({ action, ok: true });
      const done = action === 'SNIPE'; // SNIPE consumes the gate and finishes
      if (done) this.state.phase = 'done';
      return { workerId: this.id, taskId: task.id, ok: true, action, result, phase: this.state.phase, done };
    } catch (err) {
      this.state.history.push({ action, ok: false, error: String(err.message) });
      this.state.lastError = String(err.message);
      return { workerId: this.id, taskId: task.id, ok: false, error: String(err.message), action };
    }
  }

  /**
   * Exact size of this worker's serialized state — the true measure of what
   * hibernation would write to SQLite. Measured on demand (not cached),
   * so it always reflects the current history/files arrays.
   */
  getUsage() {
    return {
      busyMs: this.busyMs,
      stateBytes: Buffer.byteLength(JSON.stringify(this.state), 'utf8'),
      phase: this.state.phase,
      attempts: this.state.attempts,
    };
  }
}

module.exports = { Worker, ACTIONS };
