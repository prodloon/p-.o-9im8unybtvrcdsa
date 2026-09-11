#!/usr/bin/env node
'use strict';
/**
 * Daisy Chain — Cloud Supervisor Bridge (Phase 3)
 * ================================================
 * Talks to OpenRouter. Primary model: anthropic/claude-3.5-sonnet;
 * fallback: meta-llama/llama-3.3-70b-instruct (per knowledge.md session log).
 *
 * Contract (knowledge.md §5):
 *   request  = { worker_id, task_kind, task_summary, context_digest, skills_catalog }
 *   verdict  = { verdict: 'delegate'|'reject', skill?, confidence?, inject? }
 *
 * Reliability: HTTP 429 / 5xx / network errors → exponential backoff with
 * jitter, honoring Retry-After. Model fallback after retries exhaust.
 * API key strictly from env (OPENROUTER_API_KEY) — never logged, never
 * hardcoded. fetch is injectable for deterministic tests.
 */

const POLICY = {
  PRIMARY_MODEL: 'anthropic/claude-3.5-sonnet',
  FALLBACK_MODEL: 'meta-llama/llama-3.3-70b-instruct',
  ENDPOINT: 'https://openrouter.ai/api/v1/chat/completions',
  MAX_ATTEMPTS_PER_MODEL: 3,
  BASE_BACKOFF_MS: 500,
  MAX_BACKOFF_MS: 8000,
  REQUEST_TIMEOUT_MS: 30000,
};

const SYSTEM_PROMPT = [
  'You are the Cloud Supervisor of the Daisy Chain multi-agent cluster.',
  'You receive a JSON payload describing a worker task and must return ONE JSON object (no prose):',
  '{"verdict":"delegate","skill":"<name from skills_catalog>","confidence":0.9,"inject":true}',
  'or {"verdict":"reject","reason":"..."}.',
  'Choose `skill` ONLY from skills_catalog. Choose `inject:true` only when the skill genuinely helps.',
  'If no skill applies, return {"verdict":"delegate","skill":null,"inject":false,"confidence":0.5}.',
].join(' ');

class SupervisorBridge {
  /**
   * @param {object} [opts]
   * @param {Function} [opts.fetchImpl]  injectable fetch (tests); default global fetch
   * @param {Function} [opts.clock]      injectable clock (tests)
   * @param {Function} [opts.sleep]      injectable sleep (tests pass a no-op)
   * @param {string}   [opts.apiKey]     default: env OPENROUTER_API_KEY (tests inject)
   * @param {string}   [opts.endpoint]
   */
  constructor(opts = {}) {
    this.fetchImpl = opts.fetchImpl || ((...a) => globalThis.fetch(...a));
    this.clock = opts.clock || (() => Date.now());
    this.sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.apiKey = opts.apiKey !== undefined ? opts.apiKey : process.env.OPENROUTER_API_KEY || null;
    this.endpoint = opts.endpoint || POLICY.ENDPOINT;
    this.modelChain = [POLICY.PRIMARY_MODEL, POLICY.FALLBACK_MODEL];
    if (!this.apiKey) {
      console.warn('[bridge] OPENROUTER_API_KEY not set — cloud calls will fail until it is');
    }
  }

  /** Structured worker payload → Supervisor request body (knowledge.md §5). */
  buildRequestPayload({ workerId, taskKind, taskSummary, contextDigest = {}, skillsCatalog }) {
    return {
      worker_id: workerId,
      task_kind: taskKind,
      task_summary: String(taskSummary || '').slice(0, 2000),
      context_digest: contextDigest,
      skills_catalog: skillsCatalog,
    };
  }

  _headers() {
    return {
      authorization: `Bearer ${this.apiKey}`,
      'content-type': 'application/json',
      'http-referer': 'http://localhost/daisy-chain',
      'x-title': 'Daisy Chain Cluster',
    };
  }

  /**
   * POST with retry/backoff for 429/5xx/network errors.
   * @returns {{status:number, ok:boolean, body:object|string, attempts:number}}
   */
  async _postWithBackoff(model, payload) {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        const res = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: this._headers(),
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: JSON.stringify(payload) },
            ],
            response_format: { type: 'json_object' },
            temperature: 0.2,
            max_tokens: 300,
          }),
          signal: AbortSignal.timeout(POLICY.REQUEST_TIMEOUT_MS),
        });

        if (res.ok) {
          const body = await res.json();
          return { status: res.status, ok: true, body, attempts: attempt };
        }

        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && attempt < POLICY.MAX_ATTEMPTS_PER_MODEL) {
          const retryAfter = Number(res.headers.get('retry-after')) || null;
          const backoff = retryAfter
            ? retryAfter * 1000
            : Math.min(POLICY.BASE_BACKOFF_MS * 2 ** (attempt - 1), POLICY.MAX_BACKOFF_MS) + Math.random() * 250;
          await this.sleep(backoff);
          continue;
        }
        if (retryable) {
          return { status: res.status, ok: false, body: `HTTP ${res.status} after ${attempt} attempts`, attempts: attempt };
        }
        return { status: res.status, ok: false, body: await res.text(), attempts: attempt };
      } catch (err) {
        if (attempt >= POLICY.MAX_ATTEMPTS_PER_MODEL) {
          return { status: 0, ok: false, body: String((err && err.message) || err), attempts: attempt };
        }
        const backoff = Math.min(POLICY.BASE_BACKOFF_MS * 2 ** (attempt - 1), POLICY.MAX_BACKOFF_MS) + Math.random() * 250;
        await this.sleep(backoff);
      }
    }
  }

  /** Ask the Supervisor for a verdict on a worker task. */
  async getVerdict(payload) {
    if (!this.apiKey) {
      return { ok: false, source: 'cloud', error: 'no api key (OPENROUTER_API_KEY)' };
    }
    for (const model of this.modelChain) {
      const r = await this._postWithBackoff(model, payload);
      if (r.ok) {
        const verdict = this._parseVerdict(r.body);
        if (verdict) return { ok: true, source: 'cloud', model, verdict, attempts: r.attempts };
        continue; // malformed JSON from an otherwise-200 response → next model
      }
      // model-level failure → next model in chain
    }
    return { ok: false, source: 'cloud', error: 'all models failed' };
  }

  /**
   * Extract the verdict JSON from an OpenRouter completion.
   * Tolerates fenced code blocks and stray prose around the JSON.
   */
  _parseVerdict(body) {
    try {
      const content = (body && body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content) || '';
      const match = content.match(/\{[\s\S]*\}/);
      if (!match) return null;
      const v = JSON.parse(match[0]);
      if (typeof v.verdict !== 'string') return null;
      return {
        verdict: v.verdict,
        skill: typeof v.skill === 'string' ? v.skill : null,
        confidence: typeof v.confidence === 'number' ? v.confidence : null,
        inject: v.inject === true,
        reason: typeof v.reason === 'string' ? v.reason : null,
      };
    } catch {
      return null;
    }
  }
}

module.exports = { SupervisorBridge, POLICY };
