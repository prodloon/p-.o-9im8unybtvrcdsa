#!/usr/bin/env node
'use strict';
/**
 * Daisy Chain — Orchestrator (Phases 2+3)
 * ========================================
 * Event-driven control loop wiring the four subsystems:
 *
 *   Governor (SQLite, RAM policy)  ← heartbeats, leases, skill events
 *   WorkerPool (Worker state machines)
 *   SupervisorBridge (OpenRouter: claude-3.5-sonnet → llama-3.3-70b)
 *   SkillInjector (skillbase/ sniping + injection)
 *
 * Pipeline per task:
 *   enqueue → lease → worker.step (SNIPE gate?) → verdict from cloud
 *   [unreachable ⇒ local keyword snipe] → inject skill → SNIPE → complete
 *
 * The Governor's watchdog ticks inside the same interval loop (every 2s
 * default) — one owner for the SQLite writer role (knowledge.md §4).
 *
 * Modes:
 *   node backend/index.js              run one orchestration cycle then exit
 *   node backend/index.js --serve      loop forever (tick every ORCH_TICK_MS)
 *   node backend/index.js --enqueue '{"kind":...,"payload":{...}}'
 */

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { Governor, POLICY: GOV_POLICY, readProcessStats } = require('../governor/governor');
const { WorkerPool } = require('./worker-pool');
const { POLICY: EXECUTOR_POLICY } = require('./skill-executor');
const { SupervisorBridge } = require('./supervisor-bridge');
const { parseSupervisorLog } = require('./supervisor-log-parser');
const { resolveSupervisorRoot } = require('./supervisor-root');
const { SkillInjector } = require('./skill-injector');
const { SkillExecutor } = require('./skill-executor');
const { KeyHealthMonitor } = require('./key-health');
const { T2Canary } = require('./t2-canary');

/** Round to 4 decimal places — money formatting for cost rollups. */
const round4 = (x) => Math.round(x * 10000) / 10000;

const ORCH_POLICY = {
  TICK_MS: 2000,           // governor watchdog cadence (matches knowledge.md)
  LEASE_MS: 60000,         // per-task lease
  MAX_TASK_ATTEMPTS: 3,    // poison-task guard
  SKILLS_CATALOG_CACHE_MS: 5000,
  TELEMETRY_WRITE_MS: 1000, // telemetry.json refresh for the UI
};
// Data dir override for installed-app operation (the .app bundle in
// /Applications is read-only) — falls back to the repo database/ dir.
const DATA_DIR = process.env.DAISY_DATA_DIR || path.join(__dirname, '..', 'database');
const TELEMETRY_FILE = path.join(DATA_DIR, 'telemetry.json');

class Orchestrator {
  constructor(opts = {}) {
    this.root = opts.root || process.cwd();
    this.bridge = opts.bridge || new SupervisorBridge(opts.bridgeOpts || {});
    this.tickMs = opts.tickMs || ORCH_POLICY.TICK_MS;
    this.sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.verbose = opts.verbose !== false;

    this.governor = opts.governor || new Governor({ dbPath: opts.dbPath, silent: !this.verbose });
    // The orchestrator is itself a governor-tracked actor (FK on task_queue.leased_by
    // requires a real workers row for the leases it holds).
    this.governor.registerWorker('orchestrator', 'orchestrator', { priority: 1 });
    // The pool shares the governor's clock (fake in tests) and reads the real
    // host process stats (RSS/CPU of this Node process) for per-agent telemetry.
    this.pool = new WorkerPool({
      governor: this.governor,
      root: opts.sandboxRoot || process.env.DAISY_SANDBOX_DIR || path.join(this.root, 'daisy_sandbox_cluster'),
      targetSize: opts.targetSize || 8,
      clock: this.governor.clock,
      hostStatsReader: () => readProcessStats(process.pid),
    });
    // Skill executor: SNIPE tasks plan + execute their skill, not just consume
    // it. Shares the bridge's tier-2 config (same pinned model, timeout, and
    // residency knob as consults); null tier-2 → tier-1 builders only.
    this.pool.executor = new SkillExecutor({
      tier2: this.bridge && this.bridge.tier2 ? { url: this.bridge.tier2.url, model: this.bridge.tier2.model, keepAlive: this.bridge.tier2.keepAlive } : null,
      fetchImpl: this.bridge && this.bridge.fetchImpl ? (...a) => this.bridge.fetchImpl(...a) : undefined,
      timeoutMs: (this.bridge && this.bridge.tier2 && this.bridge.tier2.timeoutMs) || undefined,
      // Freeform AGENT brain: pinned fast planning model (NOT the 7b consult
      // model — minutes-per-request on CPU-only hosts). Unset env → null →
      // AGENT tasks fail honestly instead of wedging on a slow model.
      agent: process.env.DAISY_AGENT_MODEL === '0' ? null : {
        url: (this.bridge && this.bridge.tier2 && this.bridge.tier2.url) || 'http://localhost:11434/api/chat',
        model: process.env.DAISY_AGENT_MODEL || 'llama3.2:3b',
        keepAlive: -1,
        timeoutMs: Number(process.env.DAISY_AGENT_TIMEOUT_MS) || 240_000,
        maxTokens: 1200,
      },
    });
    // Per-round ReAct progress: the executor's hook updates the live-turn
    // registry (telemetry + reaper guard) with what the brain is doing.
    this.pool.executor.onRound = (info) => {
      // info: {round, tool, ops, taskId} — emitted by executeAgent.
      const turn = this._agentTurns.get(info.taskId);
      if (turn) {
        turn.rounds = info.round;
        turn.tool = info.tool;
        turn.ops = info.ops;
      }
    };
    this.injector = new SkillInjector({
      skillbaseDir: opts.skillbaseDir || path.join(this.root, 'skillbase'),
      governor: this.governor,
    });
    // OpenRouter key health (dashboard badge). Own interval loop — NEVER a
    // network probe inside the 1 Hz telemetry path. Injectable for tests.
    this.keyHealth = opts.keyHealth || new KeyHealthMonitor(opts.keyHealthOpts || {});
    // Dead-T2 residency canary (dashboard badge + edge-triggered alerts).
    // The 2026-09-12 lesson: a dead tier-2 degrades every consult to tier-3
    // silently. Own interval loop — NEVER inside the 1 Hz telemetry path.
    this.t2Canary = opts.t2Canary || new T2Canary(opts.t2CanaryOpts || {});
    this._catalogCache = { at: 0, names: null };
    this._cycle = 0;
    // 3-Tier cascade accounting (telemetry + dashboard pipeline panel)
    this._tiers = { 'tier1-template': 0, 'tier2-local': 0, supervisor: 0, 'local-fallback': 0 };
    this._lastTier = null;
    this._lastAgentReply = null; // latest freeform agent turn (chat UI)
    this._agentTurns = new Map(); // taskId → {startedAt, rounds, tool, ops, leaseStaleAt} — live ReAct turns
    // The governor's lease reaper must not requeue tasks whose AGENT turn is
    // running (the turn renews its own lease each round; the registry entry
    // is removed when the turn finishes either way).
    this.governor._isAgentTurnFn = (taskId) => this._agentTurns.has(taskId);
  }

  _catalog() {
    const now = Date.now();
    if (this._catalogCache.names && now - this._catalogCache.at < ORCH_POLICY.SKILLS_CATALOG_CACHE_MS) {
      return this._catalogCache.names;
    }
    try {
      this._catalogCache = { at: now, names: this.injector.listSkillNames() };
    } catch {
      if (!this._catalogCache.names) this._catalogCache = { at: now, names: [] };
    }
    return this._catalogCache.names;
  }

  enqueueTask(kind, payload) {
    return this.governor.enqueueTask(kind, payload);
  }

  /**
   * One cognitive consult through the 3-Tier CASCADE (knowledge.md §9):
   *   T1 local skillbase templates → T2 local Ollama triage → T3 cloud brain,
   * with the offline keyword snipe as the final safety net. Tier provenance
   * is recorded in skill_events and accumulated into cycle stats for telemetry.
   */
  async consultSupervisor(worker, task) {
    const summary = String((task.payload && (task.payload.summary || task.payload.action)) || task.kind);
    const payload = this.bridge.buildRequestPayload({
      workerId: worker.id,
      taskKind: task.kind,
      taskSummary: summary,
      contextDigest: { historyLen: worker.state.history.length, filesTouched: worker.state.filesWritten.length, poolSize: this.pool.size() },
      skillsCatalog: this._catalog(),
    });

    let routed = null;
    try {
      routed = await this.bridge.routeTask(payload, this.injector.catalogWithTriggers());
    } catch (err) {
      if (this.verbose) console.log(`[orch] cascade error (${String(err.message)}) — local sniping`);
      routed = null;
    }

    if (routed && routed.verdict) {
      const src = routed.source === 'tier1-template' ? 'tier1-template'
        : routed.source === 'tier2-local' ? 'tier2-local'
        : 'supervisor';
      const outcome = this.injector.applyVerdict(routed.verdict, worker.id, task.id, src);
      if (outcome.injected) {
        this._tiers[src] = (this._tiers[src] || 0) + 1;
        this._lastTier = { source: src, model: routed.model, latencyMs: routed.latencyMs, escalated: routed.escalated === true || undefined };
        if (this.verbose) console.log(`[orch] task ${task.id} → ${src} (${routed.model}) in ${routed.latencyMs}ms`);
        return outcome;
      }
      if (this.verbose) console.log(`[orch] ${src} declined injection (${outcome.reason}) — local sniping`);
    } else if (routed && routed.error && this.verbose) {
      console.log(`[orch] cloud unavailable (${routed.error}) — local sniping`);
    }

    // Final safety net: offline keyword snipe (never dead).
    const out = this.injector.snipeLocally(summary, worker.id, task.id);
    if (out.injected) {
      this._tiers['local-fallback'] = (this._tiers['local-fallback'] || 0) + 1;
      this._lastTier = { source: 'local-fallback', model: 'keyword-triggers', latencyMs: 0 };
    }
    return out;
  }

  /**
   * Run one full orchestration cycle:
   * governor tick → drain queue → return stats.
   */
  async runCycle({ maxTasks = 64 } = {}) {
    this._cycle += 1;
    this.governor.heartbeat('orchestrator'); // keep our own row fresh
    const gov = this.governor.tick(); // watchdog: hysteresis, spawn block, reapers
    this.pool.heartbeatAll(); // per-agent CPU/state accounting (dashboard fleet table)
    this._tiers = { 'tier1-template': 0, 'tier2-local': 0, supervisor: 0, 'local-fallback': 0 }; // per-cycle tier mix
    const stats = {
      cycle: this._cycle, ramPct: gov.pct, hibernated: gov.hibernated,
      tasksDone: 0, tasksFailed: 0, sniped: 0, cloud: 0, local: 0,
      tiers: this._tiers, lastTier: null,
    };

    if (this.governor.isSpawnBlocked() && this.verbose) {
      console.log(`[orch] spawn block active at ${gov.pct}% — draining queue carefully`);
    }

    for (let n = 0; n < maxTasks; n++) {
      const task = this.governor.leaseNextTask(`orchestrator`, { leaseMs: ORCH_POLICY.LEASE_MS, kindFilter: null });
      if (!task) break;

      const kind = task.kind || 'generic';
      let worker = null;
      try {
        worker = this.pool.acquire(kind);
      } catch {
        // pool empty AND spawn-blocked — park the task back for later
        this.governor.db
          .prepare("UPDATE task_queue SET status='pending', leased_by=NULL, lease_expires=NULL WHERE id=?")
          .run(task.id);
        break; // no capacity this cycle
      }
      if (!worker) {
        this.governor.completeTask(task.id, false); // no capacity at all
        stats.tasksFailed += 1;
        continue;
      }

      // Freeform AGENT turns run a multi-round ReAct loop and can outlive
      // one lease window; register the turn so (a) the executor renews the
      // lease each round and (b) the reaper knows this lease is ALIVE, not
      // abandoned — it must never requeue a running agent turn.
      const isAgentTurn = (task.payload && task.payload.action) === 'AGENT';
      if (isAgentTurn) {
        this._agentTurns.set(task.id, { startedAt: Date.now(), rounds: 0, tool: null, ops: 0, leaseStaleAt: Date.now() + EXECUTOR_POLICY.AGENT_LEASE_MS });
      }

      let report = await worker.step(task);

      // --- SNIPE gate: cognitive task needs a skill before it may act ------
      if (report.needSkill) {
        const outcome = await this.consultSupervisor(worker, task);
        if (outcome.injected) {
          worker.state.injectedSkill = outcome.skill.name;
          worker.state.skillSource = outcome.source;
          worker.state.skillContent = outcome.skill.content;
          if (outcome.source === 'supervisor') stats.cloud += 1;
          else stats.local += 1;
          stats.sniped += 1;
          report = await worker.step(task); // proceed (SNIPE or real action)
        } else if (this.verbose) {
          console.log(`[orch] no skill found for task ${task.id} (${outcome.reason})`);
        }
      }

      const ok = !!(report && report.ok);
      worker.state.phase = ok ? 'done' : 'failed'; // release back to the pool
      if (isAgentTurn) this._agentTurns.delete(task.id); // turn finished (either way)
      if (ok && report.result && report.result.reply) {
        // Freeform AGENT turn: keep the model's user-facing reply for the
        // chat UI (latest reply only — the conversation is one thread).
        this._lastAgentReply = {
          taskId: task.id,
          reply: String(report.result.reply).slice(0, 2000),
          ops: report.result.ops || [],
          rounds: report.result.rounds || 1,
          observations: report.result.observations || [],
          at: Date.now(),
        };
        if (this.verbose) console.log(`[orch] agent turn ${task.id}: ${report.result.ops ? report.result.ops.length : 0} op(s), ${report.result.rounds || 1} round(s), reply ready`);
      }
      if (ok) {
        this.governor.completeTask(task.id, true);
        stats.tasksDone += 1;
      } else {
        // Poison guard: fail permanently after MAX_TASK_ATTEMPTS
        const attempts = (task.attempts || 0) + 1;
        if (attempts >= ORCH_POLICY.MAX_TASK_ATTEMPTS) {
          this.governor.completeTask(task.id, false);
          stats.tasksFailed += 1;
          if (this.verbose) console.log(`[orch] task ${task.id} failed permanently after ${attempts} attempts`);
        } else {
          this.governor.db
            .prepare("UPDATE task_queue SET status='pending', leased_by=NULL, lease_expires=NULL, attempts=? WHERE id=?")
            .run(attempts, task.id); // release for retry, counting the attempt
          stats.tasksFailed += 1;
        }
      }
    }

    this.pool.heartbeatAll(); // end-of-cycle pass: workers spawned mid-cycle get usage rows too

    stats.lastTier = this._lastTier; // which tier handled the last consult
    if (this.verbose) {
      const t = stats.tiers;
      console.log(
        `[orch] cycle ${stats.cycle}: ram=${stats.ramPct}% tasks=${stats.tasksDone}✓/${stats.tasksFailed}✗ tiers t1=${t['tier1-template']} t2=${t['tier2-local']} t3=${t.supervisor} fallback=${t['local-fallback']}`
      );
    }
    return stats;
  }

  /** Long-running mode. */
  async serve() {
    if (this.verbose) console.log(`[orch] serving — tick ${this.tickMs}ms, target fleet ${this.pool.targetSize}`);
    // Key-health probe loop (no-op without an API key; unref'd timer).
    this.keyHealth.start();
    // T2 residency canary: the first probe fires here — seconds after the
    // boot warm-up attempt — so a failed warm-up alerts immediately instead
    // of silently degrading every consult to tier-3 (unref'd timer).
    this.t2Canary.start();
    // Orphan guard (app-bundle backend only): when the Tauri shell dies
    // abnormally (kill -9, AppleScript quit bypassing the child-reaper),
    // the backend would linger as a duplicate orchestrator fighting over
    // the same queue (two backends on one SQLite = task double-runs).
    // The repo orchestrator is spawned DETACHED by clusterctl and must NOT
    // self-exit — it legitimately lives with ppid 1 by design.
    // Bundle detection via our own install path (no spawn-side env needed).
    const IN_APP_BUNDLE = __dirname.includes(`${path.sep}Contents${path.sep}Resources${path.sep}appdata`);
    if (IN_APP_BUNDLE && process.platform !== 'win32') {
      const shellPid = process.ppid; // number property — NOT a function
      setInterval(() => {
        // kill(pid, 0) = existence probe: fails once the shell is gone.
        try {
          process.kill(shellPid, 0);
        } catch {
          console.error('[orch] shell parent died — orphan guard exiting (prevents duplicate orchestrators)');
          process.exit(0);
        }
      }, 5_000).unref();
    }
    // Telemetry heartbeat: a SEPARATE unref'd timer, deliberately not in
    // the tick loop below. runCycle awaits task processing inline (tier-2
    // consults, worker steps), so a hung consult would freeze any write
    // that lives inside the loop — the stale-dashboard incident. This
    // timer fires on the event loop independently, so dashboard freshness
    // holds even while a cycle is stuck mid-consult (snapshot shows the
    // last-known pool/queue state plus a live ts).
    setInterval(() => {
      try {
        this.writeTelemetryFile();
      } catch (err) {
        // Never let a telemetry hiccup kill the heartbeat.
        if (this.verbose) console.error(`[orch] telemetry heartbeat error: ${String(err.message)}`);
      }
    }, ORCH_POLICY.TELEMETRY_WRITE_MS).unref();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        await this.runCycle();
      } catch (err) {
        console.error(`[orch] cycle error: ${String(err.message)}`);
      }
      await this.sleep(this.tickMs);
    }
  }

  /**
   * Where the supervisor (scripts/cluster.sh under launchd) actually lives.
   * In app mode that is the operator's checkout, NOT this.root — the bundle
   * has no logs/ and its database/ is redirected. Resolution rules and
   * source labels: backend/supervisor-root.js. Memoized (env is fixed at
   * spawn, so the answer cannot change mid-process).
   */
  _supervisorRoot() {
    if (!this._supRootCache) this._supRootCache = resolveSupervisorRoot(this.root);
    return this._supRootCache;
  }

  /**
   * Recent supervisor heal/halt events, parsed from the LaunchAgent log
   * (logs/launchd-agent.log) via backend/supervisor-log-parser.js (pure,
   * S17-tested). Lines written by the current cluster.sh carry real
   * timestamps → ts is a unix ms value; lines from before the timestamping
   * change carry ts: null (the UI shows those as time-unknown, plus a
   * legacy footnote while any are visible). Cached 5 s; newest 6 events.
   */
  _supervisorEvents() {
    const now = Date.now();
    if (this._evAt && now - this._evAt < 5000) return this._evCache;
    this._evAt = now;
    let parsed = { events: [], eras: { timestamped: 0, legacy: 0 } };
    let logAge = null;
    try {
      const logPath = path.join(this._supervisorRoot().root, 'logs', 'launchd-agent.log');
      const raw = fs.readFileSync(logPath, 'utf8');
      logAge = Math.round((Date.now() - fs.statSync(logPath).mtimeMs) / 1000);
      parsed = parseSupervisorLog(raw);
    } catch {
      parsed = { events: [], eras: { timestamped: 0, legacy: 0 } };
      logAge = null;
    }
    this._evCache = {
      events: parsed.events,
      logAge,
      hasLegacy: parsed.eras.legacy > 0,
      hasTimestamps: parsed.eras.timestamped > 0,
      rootSource: this._supervisorRoot().source,
    };
    return this._evCache;
  }

  /**
   * Supervisor crash-loop guard state, read straight from the marker files
   * scripts/cluster.sh maintains (single source of truth — the backend never
   * writes guard state, it only observes). The pgrep is cached 5 s because
   * this runs inside the 1 Hz telemetry path.
   */
  _supervisorGuard() {
    const runDir = path.join(this._supervisorRoot().root, '.run');
    const now = Date.now();
    if (!this._supCheckAt || now - this._supCheckAt > 5000) {
      try {
        execSync('pgrep -f "scripts/cluster[.]sh supervise"', { stdio: 'ignore' });
        this._supLoaded = true;
      } catch {
        this._supLoaded = false;
      }
      this._supCheckAt = now;
    }
    let streak = 0;
    try {
      streak = parseInt(fs.readFileSync(path.join(runDir, 'supervisor.bootfailures'), 'utf8').trim(), 10) || 0;
    } catch {
      streak = 0;
    }
    return {
      loaded: this._supLoaded === true,
      halted: fs.existsSync(path.join(runDir, 'supervisor.halted')),
      streak,
      maxFailures: 5, // scripts/cluster.sh MAX_CONSECUTIVE_FAILED_BOOTS default (DAISY_MAX_BOOT_FAILURES)
    };
  }

  telemetry() {
    const r = this.governor.ramReader();
    return {
      ts: Date.now(),
      cycle: this._cycle,
      pool: this.pool.snapshot(),
      hostStats: this.pool._lastHostStats, // CPU/RSS of the backend process itself
      ramPct: Math.round((r.usedBytes / r.totalBytes) * 1000) / 10,
      spawnBlocked: this.governor.isSpawnBlocked(),
      queue: {
        pending: this.governor.db.prepare("SELECT COUNT(*) n FROM task_queue WHERE status='pending'").get().n,
        leased: this.governor.db.prepare("SELECT COUNT(*) n FROM task_queue WHERE status='leased'").get().n,
        done: this.governor.db.prepare("SELECT COUNT(*) n FROM task_queue WHERE status='done'").get().n,
        failed: this.governor.db.prepare("SELECT COUNT(*) n FROM task_queue WHERE status='failed'").get().n,
      },
      // 3-Tier cascade telemetry (dashboard pipeline panel)
      cascade: {
        tiers: { ...this._tiers },
        lastTier: this._lastTier,
        models: {
          tier2: this.bridge.tier2 ? this.bridge.tier2.model : null,
          tier3: this.bridge.modelChain[0],
        },
      },
      // Cost rollup (dashboard: $ avoided by handling consults at T1/T2).
      // T1/T2 are $0 by the COST LAW; the avoided spend is the modeled
      // T3 consult price × count of consults handled below the frontier
      // tier. Computed from skill_events (the permanent audit trail), so
      // the number survives restarts and agrees with the DB.
      costs: this.costRollup(),
      workersHibernating: this.governor.db.prepare("SELECT COUNT(*) n FROM workers WHERE state='hibernating'").get().n,
      // Supervisor healer + crash-loop guard (dashboard "Supervisor guard")
      supervisor: this._supervisorGuard(),
      // Recent supervisor events (dashboard heal strip) + log freshness
      supervisorEvents: this._supervisorEvents(),
      // OpenRouter key health (dashboard badge) — masked, never the key itself
      keyHealth: this.keyHealth.snapshot(),
      // Tier-2 residency canary (dashboard badge) — is qwen actually loaded?
      t2Health: this.t2Canary.snapshot(),
      // Freeform agent chat: the latest turn's user-facing reply.
      agentReply: this._lastAgentReply || null,
      agentTurns: [...this._agentTurns.values()].map((t) => ({
        ...t,
        runningSec: Math.round((Date.now() - t.startedAt) / 1000),
      })),
    };
  }

  /**
   * Per-tier cost accounting from skill_events (audit trail = source of
   * truth). Tier-3 consults count ONLY successful ones (source='supervisor'
   * — a consulted-but-declined route still cost money in reality, but the
   * audit trail cannot distinguish it; counting it would overstate T3
   * spend, so we under-count and stay honest about the method).
   */
  costRollup() {
    const unit = this.bridge.tier3ConsultCostUsd();
    const rows = this.governor.db
      .prepare('SELECT source, COUNT(*) AS n FROM skill_events GROUP BY source')
      .all()
      .reduce((acc, r) => ((acc[r.source] = r.n), acc), {});
    const t1 = rows['tier1-template'] || 0;
    const t2 = rows['tier2-local'] || 0;
    const fb = rows['local-fallback'] || 0;
    const t3 = rows.supervisor || 0;
    const avoided = t1 + t2 + fb;
    return {
      unitT3Usd: round4(unit),
      perTier: {
        'tier1-template': { consults: t1, costUsd: 0, avoidedUsd: round4(t1 * unit) },
        'tier2-local': { consults: t2, costUsd: 0, avoidedUsd: round4(t2 * unit) },
        supervisor: { consults: t3, costUsd: round4(t3 * unit), avoidedUsd: 0 },
        'local-fallback': { consults: fb, costUsd: 0, avoidedUsd: round4(fb * unit) },
      },
      totals: {
        spentUsd: round4(t3 * unit),
        avoidedUsd: round4(avoided * unit),
        consults: t1 + t2 + fb + t3,
        savingsPct: t1 + t2 + fb + t3 > 0 ? Math.round((avoided / (t1 + t2 + fb + t3)) * 1000) / 10 : 0,
      },
      method: 'modeled: T1/T2 $0 by COST LAW; $ avoided = below-frontier consults × measured T3 consult price ($0.000972, live-calibrated 2026-09-12)',
      burnProjection: this._recentBurnProjection(rows, unit),
    };
  }

  /**
   * Same audit trail as costRollup, same honesty law: this is a projection,
   * not a guarantee. Reads recent skill_events (≥1 hour old) and estimates a
   //     recentWindowUsd, recentWindowConsults, recentWindowDays, dailyBurnUsd,
   //     projectedWeekUsd, projectedMonthUsd, windowStartAt, staleAt.
   * T1/T2 still $0; supervisor consults still the counted cost. A window with
   //     no recent activity returns a stall signal (dailyBurn $0) rather than
   //     projecting from ancient data — better to look quiet than to lie.
   */
  _recentBurnProjection(rows, unit) {
    const now = Date.now();
    const oneHour = 3600 * 1000;
    // "Recent" = events written within the trailing hour. If the table has
    // nothing newer than an hour, the window is stale and we don't project.
    const recentSources = this.governor.db
      .prepare("SELECT source, COUNT(*) n FROM skill_events WHERE ts >= ? GROUP BY source")
      .all(Date.now() - oneHour)
      .reduce((a, r) => ((a[r.source] = r.n), a), {});
    if (!recentSources || Object.values(recentSources).every((n) => !n)) {
      return {
        recentWindowUsd: 0, recentWindowConsults: 0, recentWindowDays: 1, dailyBurnUsd: 0,
        projectedWeekUsd: 0, projectedMonthUsd: 0,
        windowStartAt: null, staleAt: now,
        method: 'no skill_events in the trailing hour — stall signal, not a projection',
      };
    }
    const recentT3 = recentSources.supervisor || 0;
    const recentConsults = Object.values(recentSources).reduce((s, n) => s + n, 0);
    const recentSpend = round4(recentT3 * unit);
    // Project from the trailing hour to a day: scale by 24. A recursive
    // per-source holdback is not worth inventing here — the hill we're on
    // is "does the dashboard show a defensible burn trend", and the honest
    // calibration point is the trailing-hour snapshot.
    const dailyBurnUsd = round4(recentSpend * 24);
    const projectedWeekUsd = round4(dailyBurnUsd * 7);
    const projectedMonthUsd = round4(dailyBurnUsd * 30);
    return {
      recentWindowUsd: recentSpend, recentWindowConsults: recentConsults, recentWindowDays: 1,
      dailyBurnUsd, projectedWeekUsd, projectedMonthUsd,
      windowStartAt: now - oneHour, staleAt: now + oneHour,
      method: 'trailing-hour snapshot × 24 → daily; supervisor consults only (T1/T2 $0); stalled when quiet',
    };
  }

  /** Atomically persist telemetry for the Tauri shell / UI (tmp+rename). */
  writeTelemetryFile() {
    try {
      const dir = path.dirname(TELEMETRY_FILE);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${TELEMETRY_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.telemetry()));
      fs.renameSync(tmp, TELEMETRY_FILE); // atomic swap (the audit's #1 item)
    } catch (err) {
      if (this.verbose) console.log(`[orch] telemetry write failed: ${err.message}`);
    }
  }

  close() {
    this.governor.close();
  }
}

module.exports = { Orchestrator, ORCH_POLICY };

// --- CLI ---------------------------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);
  const orch = new Orchestrator({ verbose: true });
  if (args[0] === '--enqueue') {
    const spec = JSON.parse(args[1] || '{}');
    const id = orch.enqueueTask(spec.kind || 'generic', spec.payload || {});
    console.log(`enqueued task ${id}`);
    orch.close();
  } else if (args[0] === '--serve') {
    orch.serve().catch((e) => {
      console.error(e);
      process.exit(1);
    });
  } else {
    orch
      .runCycle()
      .then((stats) => {
        orch.writeTelemetryFile(); // one-shot cycles leave telemetry for the UI too
        console.log(JSON.stringify(stats));
        orch.close();
      })
      .catch((e) => {
        console.error(e);
        process.exit(1);
      });
  }
}
