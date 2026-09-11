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
const { Governor, POLICY: GOV_POLICY } = require('../governor/governor');
const { WorkerPool } = require('./worker-pool');
const { SupervisorBridge } = require('./supervisor-bridge');
const { SkillInjector } = require('./skill-injector');

const ORCH_POLICY = {
  TICK_MS: 2000,           // governor watchdog cadence (matches knowledge.md)
  LEASE_MS: 60000,         // per-task lease
  MAX_TASK_ATTEMPTS: 3,    // poison-task guard
  SKILLS_CATALOG_CACHE_MS: 5000,
};

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
    this.pool = new WorkerPool({ governor: this.governor, root: opts.sandboxRoot || path.join(this.root, 'daisy_sandbox_cluster'), targetSize: opts.targetSize || 8 });
    this.injector = new SkillInjector({
      skillbaseDir: opts.skillbaseDir || path.join(this.root, 'skillbase'),
      governor: this.governor,
    });
    this._catalogCache = { at: 0, names: null };
    this._cycle = 0;
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

  /** Attempt one cognitive consult: cloud verdict, else local snipe. */
  async consultSupervisor(worker, task) {
    const summary = String((task.payload && (task.payload.summary || task.payload.action)) || task.kind);
    const payload = this.bridge.buildRequestPayload({
      workerId: worker.id,
      taskKind: task.kind,
      taskSummary: summary,
      contextDigest: { historyLen: worker.state.history.length, filesTouched: worker.state.filesWritten.length, poolSize: this.pool.size() },
      skillsCatalog: this._catalog(),
    });
    let verdict = null;
    let cloudOk = false;
    try {
      const res = await this.bridge.getVerdict(payload);
      if (res.ok) {
        verdict = res.verdict;
        cloudOk = true;
      } else if (this.verbose) {
        console.log(`[orch] cloud unavailable (${res.error}) — local sniping`);
      }
    } catch (err) {
      if (this.verbose) console.log(`[orch] cloud error (${String(err.message)}) — local sniping`);
    }

    if (cloudOk && verdict) {
      const outcome = this.injector.applyVerdict(verdict, worker.id, task.id);
      if (outcome.injected) return outcome;
      // Supervisor answered but no injection — fall through to local snipe
      if (this.verbose) console.log(`[orch] supervisor declined injection (${outcome.reason})`);
    }
    return this.injector.snipeLocally(summary, worker.id, task.id);
  }

  /**
   * Run one full orchestration cycle:
   * governor tick → drain queue → return stats.
   */
  async runCycle({ maxTasks = 64 } = {}) {
    this._cycle += 1;
    this.governor.heartbeat('orchestrator'); // keep our own row fresh
    const gov = this.governor.tick(); // watchdog: hysteresis, spawn block, reapers
    const stats = { cycle: this._cycle, ramPct: gov.pct, hibernated: gov.hibernated, tasksDone: 0, tasksFailed: 0, sniped: 0, cloud: 0, local: 0 };

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

    if (this.verbose) {
      console.log(
        `[orch] cycle ${stats.cycle}: ram=${stats.ramPct}% tasks=${stats.tasksDone}✓/${stats.tasksFailed}✗ skills=${stats.sniped} (cloud=${stats.cloud}, local=${stats.local})`
      );
    }
    return stats;
  }

  /** Long-running mode. */
  async serve() {
    if (this.verbose) console.log(`[orch] serving — tick ${this.tickMs}ms, target fleet ${this.pool.targetSize}`);
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

  telemetry() {
    const r = this.governor.ramReader();
    return {
      cycle: this._cycle,
      pool: this.pool.snapshot(),
      ramPct: Math.round((r.usedBytes / r.totalBytes) * 1000) / 10,
      spawnBlocked: this.governor.isSpawnBlocked(),
      queue: {
        pending: this.governor.db.prepare("SELECT COUNT(*) n FROM task_queue WHERE status='pending'").get().n,
        leased: this.governor.db.prepare("SELECT COUNT(*) n FROM task_queue WHERE status='leased'").get().n,
        done: this.governor.db.prepare("SELECT COUNT(*) n FROM task_queue WHERE status='done'").get().n,
        failed: this.governor.db.prepare("SELECT COUNT(*) n FROM task_queue WHERE status='failed'").get().n,
      },
      workersHibernating: this.governor.db.prepare("SELECT COUNT(*) n FROM workers WHERE state='hibernating'").get().n,
    };
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
        console.log(JSON.stringify(stats));
        orch.close();
      })
      .catch((e) => {
        console.error(e);
        process.exit(1);
      });
  }
}
