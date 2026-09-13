#!/usr/bin/env node
'use strict';
/**
 * Daisy Chain — Cloud Supervisor Bridge (Phase 3, permanent mappings)
 * ===================================================================
 * 3-Tier cascade (knowledge.md §5.5 COST LAW — permanent model mappings):
 *   Tier 1: skillbase/ regex + markdown + JSON trigger templates — $0 (routeTask)
 *   Tier 2: local Ollama qwen2.5:7b at http://localhost:11434 — $0 (triage)
 *   Tier 3: OpenRouter ~anthropic/claude-sonnet-latest — frontier brain, exclusive
 *
 * The three model mappings are PINNED here and are NOT env-overridable:
 * this exists so no future session can silently re-pin a dead slug (the
 * original claude-3.5-sonnet pin rotted while the fallback masked it).
 * Only OLLAMA_TIMEOUT_MS remains tunable (performance, not mapping).
 *
 * Contract (knowledge.md §5):
 *   request  = { worker_id, task_kind, task_summary, context_digest, skills_catalog }
 *   verdict  = { verdict: 'delegate'|'reject', skill?, confidence?, inject? }
 *
 * Reliability: HTTP 429 / 5xx / network errors → exponential backoff with
 * jitter, honoring Retry-After, on the single Tier-3 model. API key strictly
 * from env (OPENROUTER_API_KEY) — never logged, never hardcoded. fetch is
 * injectable for deterministic tests.
 */

const POLICY = {
  // --- 3-Tier COST LAW — PERMANENT MAPPINGS (knowledge.md §5.5) ------------
  // Tier 1: local skillbase templates — $0 (implemented in routeTask)
  TIER1_ENGINE: 'skillbase-templates', // regex/markdown/JSON rules in skillbase/
  // Tier 2: local Ollama triage — free, offline
  TIER2_OLLAMA_MODEL: 'qwen2.5:7b', // PINNED — no env override
  OLLAMA_URL: 'http://localhost:11434/api/chat', // PINNED — no env override
  OLLAMA_TIMEOUT_MS: Number(process.env.DAISY_OLLAMA_TIMEOUT_MS) || 120_000, // generous: covers cold start
  // Residency policy: pin qwen weights in RAM so tier-2 consults skip the
  // 4-5 GB cold load (~20s+ on this box). -1 (JSON number) = resident
  // forever. GOTCHA (Ollama 0.33.3): keep_alive is parsed as a Go duration
  // — the STRING "-1" is rejected (400), only numeric -1/0 or duration
  // strings like '5m' are legal. DAISY_OLLAMA_KEEP_ALIVE: '-1' | '0' |
  // '5m' — the governor cannot evict pinned weights, so set a duration if
  // the box needs the RAM back.
  OLLAMA_KEEP_ALIVE: (() => {
    const raw = process.env.DAISY_OLLAMA_KEEP_ALIVE;
    if (raw === undefined || raw === '') return -1;
    if (raw === '-1' || raw === '0') return Number(raw); // numeric-only sentinels
    return raw; // duration string, e.g. '5m'
  })(),
  OLLAMA_MAX_TOKENS: 220,
  // Tier 3: frontier brain via OpenRouter — exclusive, no cloud fallback
  TIER3_MODEL: '~anthropic/claude-sonnet-latest', // PINNED — live-verified alias, no env override
  // Confidence-score dynamic escalation: the T2 triage self-assesses every
  // verdict; a BORDERLINE one (below this floor) is re-asked at the frontier
  // instead of being trusted blindly. Applies to T2 ONLY — T1's confidence
  // is synthetic (trigger-count) and its gate is the unambiguous-winner rule;
  // a missing confidence field NEVER escalates (legacy shapes stay free).
  TIER2_ESCALATE_BELOW_CONFIDENCE: 0.85,
  // --- Rate card for the cost rollup (measured live 2026-09-12) -----------
  // Pinned T3 list price: $2/M prompt, $10/M completion (OpenRouter catalog).
  // One real consult measured 286 prompt + 40 completion tokens →
  // $0.000972 (OpenRouter's own usage.cost matched to the digit). T1/T2
  // are $0 by law, so $ avoided per consult = TIER3_COST_PER_CONSULT_USD.
  TIER3_PROMPT_USD_PER_MTOK: 2,
  TIER3_COMPLETION_USD_PER_MTOK: 10,
  TIER3_EST_PROMPT_TOKENS: 286,
  TIER3_EST_COMPLETION_TOKENS: 40,
  ENDPOINT: 'https://openrouter.ai/api/v1/chat/completions',
  MAX_ATTEMPTS_PER_MODEL: 3,
  BASE_BACKOFF_MS: 500,
  MAX_BACKOFF_MS: 8000,
  REQUEST_TIMEOUT_MS: 30000,
};

const LEGACY_MODELS = new Set([
  'anthropic/claude-3.5-sonnet',
  'anthropic/claude-sonnet-latest', // bare form is invalid; tilde alias verified live
]);

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
    // PERMANENT MAPPINGS: attempts to override the pinned models throw —
    // silently drifting a model pin is how claude-3.5-sonnet rotted.
    for (const k of ['tier3Model', 'fallbackModel']) {
      if (opts[k] !== undefined) throw new Error(`supervisor-bridge: '${k}' override rejected — Tier-3 is permanently pinned to ${POLICY.TIER3_MODEL} (knowledge.md §5.5)`);
    }
    // Tier-3 chain: the frontier brain, exclusively. No cloud fallback model.
    this.modelChain = [POLICY.TIER3_MODEL];
    // Tier-2 gate (injectable for tests): null/false disables Ollama. A
    // partial object may not move the mapping — model + host are validated.
    if (opts.tier2 === undefined) {
      this.tier2 = {
        url: POLICY.OLLAMA_URL,
        model: POLICY.TIER2_OLLAMA_MODEL,
        timeoutMs: POLICY.OLLAMA_TIMEOUT_MS,
        maxTokens: POLICY.OLLAMA_MAX_TOKENS,
        keepAlive: POLICY.OLLAMA_KEEP_ALIVE,
      };
    } else {
      this.tier2 = opts.tier2;
      if (this.tier2) {
        // Residency policy applies even to injected tier-2 objects (tests);
        // mapping fields stay permanently pinned and validated below.
        this.tier2.keepAlive = this.tier2.keepAlive !== undefined ? this.tier2.keepAlive : POLICY.OLLAMA_KEEP_ALIVE;
        if (this.tier2.model !== POLICY.TIER2_OLLAMA_MODEL || !String(this.tier2.url || '').startsWith('http://localhost:11434')) {
          throw new Error(`supervisor-bridge: tier2 mapping override rejected — permanently pinned to ${POLICY.TIER2_OLLAMA_MODEL} @ http://localhost:11434 (knowledge.md §5.5)`);
        }
      }
    }
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

  /**
   * Tier 1 — local skillbase template router ($0). Routine formatting,
   * pattern matching, and rule checks never leave the machine. Matches the
   * task summary against catalog triggers (same scoring as the offline
   * snipe); a confident single-match routes to a template verdict.
   * @returns {object|null} verdict, or null to escalate down the cascade
   */
  routeTier1(task, catalog) {
    const text = String(task.task_summary || '').toLowerCase();
    if (!text || !Array.isArray(catalog) || catalog.length === 0) return null;
    const scored = catalog
      .map((e) => ({
        name: e.name,
        score: (e.triggers || []).filter((t) => text.includes(String(t).toLowerCase())).length,
      }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);
    // Confident only when a single template clearly wins (no ambiguity).
    if (scored.length >= 1 && (scored.length === 1 || scored[0].score > scored[1].score)) {
      return {
        verdict: 'delegate',
        skill: scored[0].name,
        confidence: Math.min(0.95, 0.6 + 0.1 * scored[0].score),
        inject: true,
        reason: `tier1 template match (${scored[0].score} triggers)`,
      };
    }
    return null;
  }

  /**
   * Tier 2 — mid-level triage on local Ollama (free, offline-capable).
   * Uses OpenAI-compatible /api/chat with JSON mode. Returns a verdict or
   * null on any failure (model missing, timeout, malformed) — null always
   * means "escalate", never "fail the task".
   */
  async _askTier2(payload) {
    const t2 = this.tier2;
    if (!t2) return null;
    try {
      const res = await this.fetchImpl(t2.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: t2.model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: JSON.stringify(payload) },
          ],
          stream: false,
          format: 'json',
          keep_alive: t2.keepAlive, // re-pin residency on every consult
          options: { temperature: 0.2, num_predict: t2.maxTokens },
        }),
        signal: AbortSignal.timeout(t2.timeoutMs),
      });
      if (!res.ok) return null;
      const body = await res.json();
      const content = (body && body.message && body.message.content) || '';
      return this._parseVerdict({ choices: [{ message: { content } }] });
    } catch {
      return null; // timeout/offline/malformed → escalate to Tier 3
    }
  }

  /**
   * THE CASCADE GATEKEEPER (knowledge.md §9 cost law).
   * Route one consult through 3 tiers:
   *   T1 local skillbase templates ($0) → T2 local Ollama triage ($0) →
   *   T3 frontier cloud brain (OpenRouter, full retry + fallback chain).
   * @param {object} task      Supervisor request payload (knowledge.md §5)
   * @param {Array}  catalog   [{name, triggers}] from SkillInjector.catalogWithTriggers()
   * @returns {{source:'tier1-template'|'tier2-local'|'supervisor', model:string|null,
   *                 verdict:object|null, error?:string, attempts?:number, latencyMs:number}}
   */
  async routeTask(task, catalog = []) {
    const t0 = this.clock();

    // --- Tier 1: local templates ----------------------------------------
    const t1 = this.routeTier1(task, catalog);
    if (t1) {
      return { source: 'tier1-template', model: 'skillbase-templates', verdict: t1, attempts: 0, latencyMs: this.clock() - t0 };
    }

    // --- Tier 2: local Ollama triage -------------------------------------
    if (this.tier2) {
      const t2verdict = await this._askTier2(task);
      if (t2verdict) {
        const conf = typeof t2verdict.confidence === 'number' ? t2verdict.confidence : null;
        const borderline = conf !== null && conf < POLICY.TIER2_ESCALATE_BELOW_CONFIDENCE;
        if (!borderline) {
          return { source: 'tier2-local', model: this.tier2.model, verdict: t2verdict, attempts: 0, latencyMs: this.clock() - t0 };
        }
        // Borderline local verdict — buy certainty at the frontier.
        console.log(`[bridge] tier2 confidence ${conf} < ${POLICY.TIER2_ESCALATE_BELOW_CONFIDENCE} — escalating to tier3`);
        const res = await this.getVerdict(task);
        if (res.ok) {
          return { source: 'supervisor', model: res.model, verdict: res.verdict, attempts: res.attempts, latencyMs: this.clock() - t0, escalated: true };
        }
        // Frontier unavailable: the borderline LOCAL verdict is still the
        // best free decision available — degrade to it rather than burning
        // a real model verdict to the keyword snipe (which may match nothing
        // and fail the SNIPE gate outright).
        return { source: 'tier2-local', model: this.tier2.model, verdict: t2verdict, attempts: res.attempts || 0, latencyMs: this.clock() - t0, escalated: true, escalationFailed: res.error || 'tier3 unavailable' };
      }
    }

    // --- Tier 3: frontier cloud brain ------------------------------------
    const res = await this.getVerdict(task); // full retry/backoff + model chain
    return {
      source: res.ok ? 'supervisor' : 'cloud-unavailable',
      model: res.model || null,
      verdict: res.ok ? res.verdict : null,
      error: res.ok ? undefined : res.error,
      attempts: res.attempts || 0,
      latencyMs: this.clock() - t0,
    };
  }

  /**
   * Modeled cost of ONE tier-3 consult at the pinned rate card (USD).
   * Calibration measured live: 286 prompt + 40 completion tokens →
   * $0.000972, matching OpenRouter's own usage.cost to the digit.
   */
  tier3ConsultCostUsd() {
    const prompt = (POLICY.TIER3_EST_PROMPT_TOKENS / 1e6) * POLICY.TIER3_PROMPT_USD_PER_MTOK;
    const completion = (POLICY.TIER3_EST_COMPLETION_TOKENS / 1e6) * POLICY.TIER3_COMPLETION_USD_PER_MTOK;
    return prompt + completion;
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
