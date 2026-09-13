#!/usr/bin/env node
'use strict';
/**
 * Daisy Chain — OpenRouter Key-Health Monitor
 * ===========================================
 * A dead/revoked/exhausted OPENROUTER_API_KEY currently surfaces only as
 * mysterious "all models failed" tier-3 errors. This module makes the key's
 * health a first-class telemetry field (`keyHealth` in the payload) so the
 * dashboard can show a tiny badge instead of forcing an operator to correlate
 * consult failures with a rotation they forgot about (2026-09-12 rotation:
 * the old key began 401-ing "User not found" the moment a new one was made).
 *
 * Design laws:
 *   - NEVER inside the 1 Hz telemetry path. Probing is a network call; the
 *     monitor runs on its own interval (default 5 min) and telemetry() only
 *     reads the last snapshot.
 *   - The key NEVER enters the payload, logs, or errors verbatim. Only a
 *     masked fingerprint travels (`sk-or-v1-2b8…6361`).
 *   - fetch + clock are injectable; classification is a pure function so the
 *     battery pins every HTTP shape deterministically (S20).
 *
 * Classification (status → dashboard badge):
 *   ok            key authenticates; remaining = limit − usage when limited
 *   exhausted     402, or a limited key whose usage ≥ limit
 *   rate-limited  429 (transient — not dead, back off)
 *   invalid       401/403 (revoked or never valid — this is the rotation alarm)
 *   missing       no OPENROUTER_API_KEY configured
 *   error         network/timeout/unexpected body (transient — keep old verdict?
 *                 no: we show error; the next probe will re-classify)
 *   unknown       constructed but never probed (pre-first-probe bootstrap)
 */

const CLASSIFICATION = Object.freeze([
  'ok', 'exhausted', 'rate-limited', 'invalid', 'missing', 'error', 'unknown',
]);

/** Masked fingerprint of a key: prefix + last 4, middle elided. */
function fingerprintKey(key) {
  if (typeof key !== 'string' || key.length < 8) return '??';
  return `${key.slice(0, 12)}…${key.slice(-4)}`;
}

/**
 * Pure classifier for an /api/v1/auth/key response.
 * @param {number} status  HTTP status of the probe
 * @param {object|null} body  parsed JSON body (OpenRouter: { data: {...} })
 * @returns {{status: string, label: string|null, usage: number|null,
 *            limit: number|null, remaining: number|null, limitReached: boolean}}
 */
function classifyKeyResponse(status, body) {
  if (status === 401 || status === 403) {
    return { status: 'invalid', label: null, usage: null, limit: null, remaining: null, limitReached: false };
  }
  if (status === 402) {
    return { status: 'exhausted', label: null, usage: null, limit: null, remaining: null, limitReached: false };
  }
  if (status === 429) {
    return { status: 'rate-limited', label: null, usage: null, limit: null, remaining: null, limitReached: false };
  }
  if (status >= 200 && status < 300) {
    const d = body && body.data;
    if (!d || typeof d !== 'object') {
      // 2xx with an unexpected shape — treat as an error, not a healthy key.
      return { status: 'error', label: null, usage: null, limit: null, remaining: null, limitReached: false };
    }
    const usage = typeof d.usage === 'number' ? d.usage : null;
    const limit = typeof d.limit === 'number' ? d.limit : null; // null = no limit
    const limitReached = limit !== null && usage !== null && usage >= limit;
    return {
      status: limitReached ? 'exhausted' : 'ok',
      label: typeof d.label === 'string' ? d.label : null,
      usage,
      limit,
      remaining: limit !== null && usage !== null ? Math.round((limit - usage) * 10000) / 10000 : null,
      limitReached,
    };
  }
  return { status: 'error', label: null, usage: null, limit: null, remaining: null, limitReached: false };
}

class KeyHealthMonitor {
  /**
   * @param {object} [opts]
   * @param {Function} [opts.fetchImpl]  injectable fetch (tests); default global fetch
   * @param {Function} [opts.clock]      injectable clock ms (tests)
   * @param {string}   [opts.apiKey]     default: env OPENROUTER_API_KEY (tests inject)
   * @param {string}   [opts.endpoint]   default: OpenRouter /auth/key
   * @param {number}   [opts.intervalMs] probe cadence, default 300000 (5 min)
   * @param {number}   [opts.timeoutMs]  per-probe timeout, default 5000
   */
  constructor(opts = {}) {
    this.fetchImpl = opts.fetchImpl || ((...a) => globalThis.fetch(...a));
    this.clock = opts.clock || (() => Date.now());
    this.apiKey = opts.apiKey !== undefined ? opts.apiKey : process.env.OPENROUTER_API_KEY || null;
    this.endpoint = opts.endpoint || 'https://openrouter.ai/api/v1/auth/key';
    this.intervalMs = opts.intervalMs || 300_000;
    this.timeoutMs = opts.timeoutMs || 5000;
    this._timer = null;
    this._probing = false;
    this.state = {
      status: this.apiKey ? 'unknown' : 'missing',
      fingerprint: this.apiKey ? fingerprintKey(this.apiKey) : null,
      label: null,
      usage: null,
      limit: null,
      remaining: null,
      limitReached: false,
      httpStatus: null,
      error: null,
      checkedAt: null,
      nextCheckAt: null,
      probeCount: 0,
    };
  }

  /** Telemetry-safe view: masked, secret-free, cheap to embed at 1 Hz. */
  snapshot() {
    return { ...this.state };
  }

  /**
   * One probe now. Never throws — every failure mode becomes state.
   * Concurrent probes coalesce (the interval + a manual probe can overlap).
   */
  async probe() {
    if (this._probing) return this.state;
    if (!this.apiKey) {
      this.state.status = 'missing';
      return this.state;
    }
    this._probing = true;
    try {
      let res;
      try {
        res = await this.fetchImpl(this.endpoint, {
          headers: { Authorization: `Bearer ${this.apiKey}` },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        this._record({ status: 'error', error: `probe failed: ${String(err.message || err)}` });
        return this.state;
      }
      let body = null;
      try { body = await res.json(); } catch { /* non-JSON body → classifier sees null */ }
      const c = classifyKeyResponse(res.status, body);
      this._record({ ...c, httpStatus: res.status });
      return this.state;
    } finally {
      this._probing = false;
    }
  }

  _record(part) {
    Object.assign(this.state, part, {
      checkedAt: this.clock(),
      probeCount: this.state.probeCount + 1,
      nextCheckAt: this._timer ? this.clock() + this.intervalMs : null,
    });
  }

  /**
   * Begin the interval loop. No-ops without a key (nothing to check — the
   * badge already says "missing", and serve-mode tests must never touch the
   * network). Fires one probe immediately so a restarted stack shows a real
   * verdict within seconds, then re-probes every intervalMs. unref'd so the
   * loop never holds the process open.
   */
  start() {
    if (this._timer || !this.apiKey) return;
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

module.exports = { KeyHealthMonitor, classifyKeyResponse, fingerprintKey, CLASSIFICATION };
