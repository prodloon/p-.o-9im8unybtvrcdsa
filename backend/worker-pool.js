#!/usr/bin/env node
'use strict';
/**
 * Daisy Chain — Worker Pool (Phase 2)
 * ====================================
 * Owns the fleet of Worker state machines. Registers every worker with the
 * governor, heartbeats through the worker, and refuses to spawn when the
 * governor has raised the spawn block (90% RAM).
 *
 * Hibernation: the governor may hibernate a worker (80% RAM policy). The
 * pool serializes the worker's `state` into SQLite via governor.hibernate()
 * and can restore it later with governor.wake() — the worker object itself
 * is rebuilt and its state re-injected (knowledge.md §4 worker_states).
 */

const { Worker } = require('./worker');
const { SkillExecutor } = require('./skill-executor');

class WorkerPool {
  /**
   * @param {object} opts
   * @param {object} opts.governor      Governor instance (source of truth for spawn block)
   * @param {string} [opts.root]        sandbox root for workers
   * @param {number} [opts.targetSize]  desired steady-state fleet size (config, not hardcode)
   * @param {number} [opts.maxSize]     absolute ceiling regardless of RAM
   */
  constructor({ governor, root = process.cwd(), targetSize = 8, maxSize = 100, clock, hostStatsReader }) {
    this.governor = governor;
    this.root = root;
    this.targetSize = targetSize;
    this.maxSize = maxSize;
    this.workers = new Map(); // id -> Worker
    this._seq = 0;
    // Per-agent usage telemetry (knowledge.md §6): the clock and host-stats
    // reader are injectable so the selftest can verify attribution deterministically.
    this.clock = clock || (() => Date.now());
    this.hostStatsReader = hostStatsReader || (() => ({ cpuPct: null, rssBytes: null }));
    this._lastStatsAt = 0;
    this._lastHostStats = { cpuPct: null, rssBytes: null };
    // Skill executor: one per pool, shared by every worker's SNIPE action.
    // tier2 === null → tier-1 builders only (no Ollama planning).
    this.executor = new SkillExecutor({ tier2: null });
  }

  _nextId(kind) {
    this._seq += 1;
    return `w-${String(this._seq).padStart(4, '0')}-${kind}`;
  }

  spawn(kind, { priority = 5 } = {}) {
    if (this.workers.size >= this.maxSize) {
      throw new Error(`pool at maxSize (${this.maxSize})`);
    }
    if (this.governor.isSpawnBlocked()) {
      throw new Error('spawn blocked: governor reports RAM >= 90%');
    }
    const id = this._nextId(kind);
    const worker = new Worker({ id, kind, governor: this.governor, root: this.root });
    worker.executor = this.executor;
    this.workers.set(id, worker);
    this.governor.registerWorker(id, kind, { priority });
    return worker;
  }

  get(id) {
    return this.workers.get(id) || null;
  }

  size() {
    return this.workers.size;
  }

  countByState(state) {
    let n = 0;
    for (const w of this.workers.values()) if (w.state.phase === state) n += 1;
    return n;
  }

  /** Fleet snapshot for telemetry (Phase 5 UI streams this). */
  snapshot() {
    return {
      size: this.workers.size,
      targetSize: this.targetSize,
      maxSize: this.maxSize,
      spawnBlocked: this.governor.isSpawnBlocked(),
      byPhase: [...this.workers.values()].reduce((acc, w) => {
        acc[w.state.phase] = (acc[w.state.phase] || 0) + 1;
        return acc;
      }, {}),
      // Per-agent usage rows for the dashboard's fleet table. cpuPct is the
      // last attributed value from heartbeatAll(); stateBytes/busyMs are
      // measured live (they are owned per-worker data, always current).
      workers: [...this.workers.values()].map((w) => {
        const u = w.getUsage();
        return {
          id: w.id,
          kind: w.kind,
          phase: w.state.phase,
          attempts: u.attempts,
          cpuPct: w.lastCpuPct ?? null,
          stateBytes: u.stateBytes,
          busyMs: u.busyMs,
        };
      }),
      hostStats: this._lastHostStats,
    };
  }

  /**
   * Stats heartbeat for the whole fleet — call once per orchestrator cycle.
   *
   * Attribution (workers are in-process state machines sharing one event
   * loop, so true per-process CPU/RSS does not exist — see knowledge.md §4):
   *   cpuPct     = worker's share of the host event loop over the interval
   *                (busyMs delta / interval × 100 — owned, sums to ≤100%)
   *   stateBytes = exact serialized state size (what hibernation would store)
   *   RSS        = host process RSS split evenly across the live fleet
   * Values land in `workers` via governor.statsHeartbeat() and in the
   * snapshot for the per-agent dashboard table.
   */
  heartbeatAll() {
    const now = this.clock();
    const dtMs = this._lastStatsAt ? Math.max(1, now - this._lastStatsAt) : null;
    const hostStats = this.hostStatsReader() || { cpuPct: null, rssBytes: null };
    const perWorkerRss =
      hostStats.rssBytes && this.workers.size > 0
        ? Math.round(hostStats.rssBytes / this.workers.size)
        : null;

    for (const w of this.workers.values()) {
      let cpuPct = null;
      if (dtMs) {
        const busyDelta = w.busyMs - (w._lastBusyMs ?? 0);
        w._lastBusyMs = w.busyMs;
        cpuPct = Math.round(Math.min(100, (busyDelta / dtMs) * 100) * 10) / 10;
      }
      w.lastCpuPct = cpuPct;
      const usage = w.getUsage();
      this.governor.statsHeartbeat(w.id, {
        cpuPct,
        stateBytes: usage.stateBytes,
        busyMs: usage.busyMs,
      });
    }

    this._lastStatsAt = now;
    this._lastHostStats = { cpuPct: hostStats.cpuPct, rssBytes: hostStats.rssBytes, perWorkerRss };
    return { hostStats: this._lastHostStats, count: this.workers.size };
  }

  /**
   * Acquire a worker for a task of `kind`: reuse a released one, else spawn
   * (subject to governor block), else steal any released worker. Handed-out
   * workers are marked 'claimed' so two acquires never get the same worker.
   * EVERY handout runs beginTask() — skill grants are single-task scope, so
   * a reused worker never carries the previous task's injectedSkill (that
   * leak silently bypassed the SNIPE gate and the whole cascade).
   * Returns null when the pool is exhausted AND spawn is blocked.
   */
  acquire(kind) {
    const released = (w) => w.state.phase === 'idle' || w.state.phase === 'done' || w.state.phase === 'failed';
    for (const w of this.workers.values()) {
      if (w.kind === kind && released(w)) {
        w.beginTask();
        return w;
      }
    }
    if (this.workers.size < Math.min(this.targetSize, this.maxSize) && !this.governor.isSpawnBlocked()) {
      const w = this.spawn(kind);
      w.beginTask(); // spawn() seeds 'idle'; normalize to claimed
      return w;
    }
    let steal = null;
    for (const w of this.workers.values()) {
      if (released(w) && (!steal || w.state.attempts < steal.state.attempts)) steal = w;
    }
    if (!steal) return null;
    steal.beginTask();
    return steal;
  }

  /** Governor-driven hibernation of one worker (serialize → SQLite). */
  hibernate(id) {
    const w = this.workers.get(id);
    if (!w) return false;
    const ok = this.governor.hibernate(id, w.state, null);
    if (ok) this.workers.delete(id); // object dissolves; snapshot lives in SQLite
    return ok;
  }

  /** Restore a hibernated worker from its SQLite snapshot. */
  restore(id) {
    const { state } = this.governor.wake(id);
    const info = this.governor.db.prepare('SELECT kind FROM workers WHERE id = ?').get(id);
    const w = new Worker({ id, kind: info ? info.kind : 'generic', governor: this.governor, root: this.root });
    w.executor = this.executor;
    w.state = { ...w.state, ...state };
    this.workers.set(id, w);
    return w;
  }

  /** Hibernate as many idle workers as needed; returns count hibernated. */
  shrinkUnderPressure(minimumKeep = 1) {
    let hibernated = 0;
    const candidates = [...this.workers.values()]
      .filter((w) => w.state.phase === 'idle' || w.state.phase === 'done')
      .sort((a, b) => a.state.attempts - b.state.attempts);
    for (const w of candidates) {
      if (this.workers.size <= minimumKeep) break;
      if (this.hibernate(w.id)) hibernated += 1;
    }
    return hibernated;
  }
}

module.exports = { WorkerPool };
