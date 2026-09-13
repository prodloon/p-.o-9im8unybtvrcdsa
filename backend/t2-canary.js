#!/usr/bin/env node
'use strict';
/**
 * Daisy Chain — Dead-T2 Residency Canary
 * ======================================
 * Tier 2 is local Ollama serving qwen2.5:7b PINNED resident (keep_alive -1).
 * The 2026-09-12 Task-Optimizer-Pro incident showed the failure mode: boot
 * warm-up fails (runner SIGTERM'd ~2s into every load), qwen never becomes
 * resident, and EVERY consult silently degrades to tier-3 cloud — invisible
 * by design, because the T2 contract is "return null on trouble" and the
 * cascade correctly falls through. 38 load failures; nobody was told.
 *
 * This canary makes T2 residency a first-class telemetry field (`t2Health`)
 * and ALERTS on entering a bad state (macOS notification + console, mirroring
 * telemetry-server's outage ping), so warm-up failures are loud instead of
 * a $ line-item drift someone notices weeks later.
 *
 * Design laws (mirrors backend/key-health.js):
 *   - NEVER inside the 1 Hz telemetry path. Probing hits Ollama's /api/ps
 *     (a loopback network call); the monitor runs on its own interval
 *     (default 60 s) and telemetry() only reads the last snapshot.
 *   - fetch + clock + alert are injectable; classification is a pure
 *     function so the battery pins every HTTP shape deterministically (S22).
 *   - probe() never throws; every failure mode becomes state.
 *
 * Classification (status → dashboard badge):
 *   resident     qwen listed in /api/ps — weights loaded, T2 can serve
 *   dead         Ollama answers but qwen is NOT resident (the killer state:
 *                warm-up failed or weights were evicted)
 *   unreachable  Ollama not answering at all (connection refused, timeout,
 *                non-2xx) — T2 AND warm-up both impossible
 *   error        2xx but body shape unexpected (API drift — don't guess)
 *   off          keep_alive is 0 → residency is NOT expected by policy;
 *                the canary disables itself instead of false-alarming
 *   unknown      constructed but never probed (pre-first-probe bootstrap)
 *
 * Alerting is EDGE-TRIGGERED with a re-alert cooldown: one notification when
 * a bad state is entered, a reminder every reAlertMs while it persists,
 * silence on recovery (recovery is logged, not pinged). Flapping re-alerts
 * on each fresh entry, which is the correct bias for a cost-law breaker.
 */

const { POLICY } = require('./supervisor-bridge');

const CLASSIFICATION = Object.freeze([
  'resident', 'dead', 'unreachable', 'error', 'off', 'unknown',
]);

const BAD_STATES = Object.freeze(['dead', 'unreachable']);

/** Console + macOS notification. Same shape as telemetry-server.notifyOutage. */
function defaultAlert(msg) {
  console.log(`[t2-canary] ALERT: ${msg}`);
  if (process.env.DAISY_ALERT === '0' || process.platform !== 'darwin') return;
  require('child_process').execFile('osascript', ['-e',
    `display notification "${String(msg).replace(/"/g, '\\"')}" with title "Daisy Tier 2" sound name "Basso"`,
  ], () => {}); // best-effort — a failed notification must never throw up here
}

/**
 * Pure classifier for an Ollama /api/ps response.
 * @param {number} status      HTTP status of the probe (0 = transport failure)
 * @param {object|null} body   parsed JSON body ({ models: [...] })
 * @param {string} expectedModel  e.g. 'qwen2.5:7b' (prefix match on name,
 *                             same semantics as scripts/cluster.sh's grep)
 * @returns {{status: string, model: string|null, expiresAt: string|null,
 *           sizeVram: number|null, loadedCount: number|null}}
 */
function classifyPsResponse(status, body, expectedModel) {
  if (status < 200 || status >= 300) {
    return { status: 'unreachable', model: null, expiresAt: null, sizeVram: null, loadedCount: null };
  }
  if (!body || !Array.isArray(body.models)) {
    return { status: 'error', model: null, expiresAt: null, sizeVram: null, loadedCount: null };
  }
  const hit = body.models.find((m) => m && typeof m.name === 'string' && m.name.startsWith(expectedModel));
  if (!hit) {
    return { status: 'dead', model: null, expiresAt: null, sizeVram: null, loadedCount: body.models.length };
  }
  return {
    status: 'resident',
    model: hit.name,
    expiresAt: typeof hit.expires_at === 'string' ? hit.expires_at : null,
    sizeVram: typeof hit.size_vram === 'number' ? hit.size_vram : null,
    loadedCount: body.models.length,
  };
}

class T2Canary {
  /**
   * @param {object} [opts]
   * @param {Function} [opts.fetchImpl]  injectable fetch (tests); default global fetch
   * @param {Function} [opts.clock]      injectable clock ms (tests)
   * @param {Function} [opts.alert]      injectable alert fn (tests spy); default console+osascript
   * @param {string}   [opts.endpoint]   default: Ollama /api/ps derived from POLICY.OLLAMA_URL
   * @param {string}   [opts.model]      default: POLICY.TIER2_OLLAMA_MODEL ('qwen2.5:7b')
   * @param {number|string} [opts.keepAlive] default: POLICY.OLLAMA_KEEP_ALIVE ('0' → auto-off)
   * @param {number}   [opts.intervalMs] probe cadence, default 60000 (60 s)
   * @param {number}   [opts.timeoutMs]  per-probe timeout, default 5000
   * @param {number}   [opts.reAlertMs]  re-alert cooldown while bad, default 1800000 (30 min)
   */
  constructor(opts = {}) {
    this.fetchImpl = opts.fetchImpl || ((...a) => globalThis.fetch(...a));
    this.clock = opts.clock || (() => Date.now());
    this.alert = opts.alert || defaultAlert;
    this.endpoint = opts.endpoint || POLICY.OLLAMA_URL.replace('/api/chat', '/api/ps');
    this.model = opts.model || POLICY.TIER2_OLLAMA_MODEL;
    this.keepAlive = opts.keepAlive !== undefined ? opts.keepAlive : POLICY.OLLAMA_KEEP_ALIVE;
    this.intervalMs = opts.intervalMs || 60_000;
    this.timeoutMs = opts.timeoutMs || 5000;
    this.reAlertMs = opts.reAlertMs || 30 * 60_000;
    this._timer = null;
    this._probing = false;
    this.state = {
      status: this.keepAlive === 0 ? 'off' : 'unknown',
      model: this.model,
      expectedResident: this.keepAlive !== 0,
      residentName: null,
      expiresAt: null,
      sizeVram: null,
      loadedCount: null,
      httpStatus: null,
      error: null,
      checkedAt: null,
      nextCheckAt: null,
      probeCount: 0,
      since: null,        // clock() when the current status was entered
      lastAlertAt: null,  // clock() of last alert fired (cooldown reference)
      alertCount: 0,
    };
  }

  /** Telemetry-safe view: cheap to embed at 1 Hz, no secrets involved. */
  snapshot() {
    return { ...this.state };
  }

  /**
   * One probe now. Never throws — every failure mode becomes state.
   * Concurrent probes coalesce (the interval + a manual probe can overlap).
   */
  async probe() {
    if (this._probing || this.state.status === 'off') return this.state;
    this._probing = true;
    try {
      let res;
      try {
        res = await this.fetchImpl(this.endpoint, { signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (err) {
        this._record({ status: 'unreachable', httpStatus: null, error: `probe failed: ${String(err.message || err)}` });
        return this.state;
      }
      let body = null;
      try { body = await res.json(); } catch { /* non-JSON body → classifier sees null */ }
      const c = classifyPsResponse(res.status, body, this.model);
      this._record({ ...c, httpStatus: res.status, error: c.status === 'error' ? `unexpected /api/ps body` : null });
      return this.state;
    } finally {
      this._probing = false;
    }
  }

  _record(part) {
    const now = this.clock();
    const prev = this.state.status;
    const next = part.status;
    const enteredBad = BAD_STATES.includes(next) && prev !== next;
    Object.assign(this.state, part, {
      checkedAt: now,
      probeCount: this.state.probeCount + 1,
      nextCheckAt: this._timer ? now + this.intervalMs : null,
      since: next !== prev ? now : this.state.since,
    });
    // Edge-triggered alerting: on entering a bad state, or as a periodic
    // reminder while a bad state persists. Recovery is logged, never pinged.
    if (BAD_STATES.includes(next)) {
      const cooled = this.state.lastAlertAt === null || now - this.state.lastAlertAt >= this.reAlertMs;
      if (enteredBad || cooled) {
        const what = next === 'dead'
          ? `tier-2 DOWN: ${this.model} not resident — consults silently degrading to tier-3 ($)`
          : `tier-2 UNREACHABLE: ollama not answering at ${this.endpoint} — T2 and warm-up both impossible`;
        this.alert(`${what} (probes=${this.state.probeCount})`);
        this.state.lastAlertAt = now;
        this.state.alertCount += 1;
      }
    } else if (prev !== next && BAD_STATES.includes(prev)) {
      console.log(`[t2-canary] recovered: ${this.model} ${next} (was ${prev})`);
      this.state.lastAlertAt = null;
    }
  }

  /**
   * Begin the interval loop. Auto-off when keep_alive is 0 (residency is not
   * expected — probing would false-alarm forever). Fires one probe
   * immediately so a restarted stack shows a real verdict (or fires the
   * warm-up-failure alert) within seconds, then re-probes every intervalMs.
   * unref'd so the loop never holds the process open.
   */
  start() {
    if (this._timer || this.state.status === 'off') return;
    this.probe().catch(() => {}); // fire-and-forget; probe() records its own failures
    this._timer = setInterval(() => {
      this.probe().catch(() => {});
    }, this.intervalMs);
    this._timer.unref();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}

module.exports = { T2Canary, classifyPsResponse, CLASSIFICATION, BAD_STATES };
