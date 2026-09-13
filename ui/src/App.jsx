import React, { useEffect, useMemo, useRef, useState } from 'react';
import { subscribeTelemetry, createThrottledFeed, FETCH_FAILED } from './telemetry.js';

const MAX_HISTORY = 60; // ~60s of samples at 1Hz

function Gauge({ label, pct, sub, tone = 'sky' }) {
  const tones = {
    sky: 'from-sky-500 to-cyan-400',
    amber: 'from-amber-500 to-yellow-400',
    rose: 'from-rose-500 to-red-400',
    emerald: 'from-emerald-500 to-green-400',
  };
  const p = Math.max(0, Math.min(100, pct ?? 0));
  return (
    <div className="rounded-xl border border-slate-700/60 bg-slate-800/60 p-4">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-medium uppercase tracking-wider text-slate-400">{label}</span>
        <span className="text-2xl font-semibold text-slate-100">{p.toFixed(1)}%</span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-700/60">
        <div
          className={`h-full rounded-full bg-gradient-to-r ${tones[tone]} transition-all duration-500`}
          style={{ width: `${p}%` }}
        />
      </div>
      {sub && <div className="mt-1.5 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

/** OpenRouter key-health chip — verdict from the backend's cached probe loop
 *  (backend/key-health.js): never the key itself, only a masked fingerprint. */
const KEY_HEALTH_TONES = {
  ok: 'text-emerald-400',
  unknown: 'text-slate-500',
  'rate-limited': 'text-amber-400',
  exhausted: 'text-rose-400',
  invalid: 'text-rose-400',
  missing: 'text-rose-400',
  error: 'text-amber-400',
};
function KeyHealthChip({ kh }) {
  if (!kh) return null;
  const tone = KEY_HEALTH_TONES[kh.status] || 'text-slate-500';
  const sub = kh.status === 'ok' && kh.limit != null
    ? ` · $${(kh.remaining ?? 0).toFixed(2)} left of $${kh.limit.toFixed(2)}`
    : kh.status === 'ok'
      ? ''
      : kh.status === 'invalid'
        ? ' · key revoked or wrong — rotate OPENROUTER_API_KEY'
        : kh.status === 'exhausted'
          ? ' · limit reached or no credits'
          : kh.status === 'missing'
            ? ' · OPENROUTER_API_KEY not set'
            : kh.status === 'error'
              ? ' · probe failed (network?)'
              : '';
  return (
    <span
      className={`ml-2 inline-flex items-center gap-1 ${tone}`}
      title={kh.fingerprint ? `key ${kh.fingerprint} · label ${kh.label ?? '—'} · checked ${kh.checkedAt ? new Date(kh.checkedAt).toLocaleTimeString() : 'never'}` : 'no key configured'}
    >
      <span className="font-mono text-[11px] text-slate-500">key</span> {kh.status}{sub}
    </span>
  );
}

/** Tier-2 residency chip — verdict from the backend's cached canary probe
 *  (backend/t2-canary.js): is qwen actually loaded? dead = silent tier-3 cost. */
const T2_HEALTH_TONES = {
  resident: 'text-emerald-400',
  unknown: 'text-slate-500',
  dead: 'text-rose-400',
  unreachable: 'text-rose-400',
  error: 'text-amber-400',
  off: 'text-slate-500',
};
function T2HealthChip({ t2 }) {
  if (!t2) return null;
  const tone = T2_HEALTH_TONES[t2.status] || 'text-slate-500';
  const sub = t2.status === 'dead'
    ? ' · qwen not resident — consults degrading to tier-3 ($)'
    : t2.status === 'unreachable'
      ? ' · ollama not answering — tier-2 and warm-up impossible'
      : t2.status === 'off'
        ? ' · keep_alive=0 — residency not expected'
        : t2.status === 'error'
          ? ' · probe failed'
          : '';
  return (
    <span
      className={`ml-2 inline-flex items-center gap-1 ${tone}`}
      title={`tier-2 ${t2.model ?? '—'} · models loaded: ${t2.loadedCount ?? '—'} · checked ${t2.checkedAt ? new Date(t2.checkedAt).toLocaleTimeString() : 'never'}${t2.alertCount ? ` · alerts fired: ${t2.alertCount}` : ''}`}
    >
      <span className="font-mono text-[11px] text-slate-500">t2</span> {t2.status}{sub}
    </span>
  );
}

/** Tiny inline sparkline — SVG polyline, no chart lib, no re-render storms. */
function Spark({ data, tone = '#38bdf8' }) {
  const pts = useMemo(() => {
    if (!data.length) return '';
    const w = 100;
    const h = 28;
    const max = Math.max(...data, 1);
    return data
      .map((v, i) => `${(i / Math.max(1, data.length - 1)) * w},${h - (v / max) * h}`)
      .join(' ');
  }, [data]);
  return (
    <svg viewBox="0 0 100 28" preserveAspectRatio="none" className="h-7 w-full">
      <polyline points={pts} fill="none" stroke={tone} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const fmtBytes = (b) => {
  if (b == null) return '—';
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
};

const fmtBusy = (ms) => {
  if (ms == null) return '—';
  if (ms >= 60_000) return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
};

const PHASE_TONES = {
  working: 'text-emerald-400',
  waiting_skill: 'text-amber-400',
  claimed: 'text-sky-400',
  idle: 'text-slate-400',
  done: 'text-slate-400',
  failed: 'text-rose-400',
};

/** Per-agent fleet table: CPU / state size / busy time for every live worker. */
const AgentTable = React.memo(function AgentTable({ workers, hostStats, perWorkerRss }) {
  const rows = workers || [];
  const totalCpu = rows.reduce((a, w) => a + (w.cpuPct || 0), 0);
  const totalState = rows.reduce((a, w) => a + (w.stateBytes || 0), 0);
  return (
    <div className="rounded-xl border border-slate-700/60 bg-slate-800/60 p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-xs font-medium uppercase tracking-wider text-slate-400">Agents ({rows.length})</span>
        <span className="text-xs text-slate-500">
          Σ cpu {totalCpu.toFixed(1)}% · Σ state {fmtBytes(totalState)}
          {hostStats?.rssBytes ? ` · host rss ${fmtBytes(hostStats.rssBytes)} (~${fmtBytes(perWorkerRss)}/agent)` : ''}
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="py-3 text-sm text-slate-500">no live workers — fleet idle</div>
      ) : (
        <div className="max-h-56 overflow-y-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-slate-500">
              <tr className="border-b border-slate-700/60">
                <th className="py-1.5 pr-3 font-medium">agent</th>
                <th className="py-1.5 pr-3 font-medium">phase</th>
                <th className="py-1.5 pr-3 text-right font-medium">cpu %</th>
                <th className="py-1.5 pr-3 text-right font-medium">state</th>
                <th className="py-1.5 pr-3 text-right font-medium">busy</th>
                <th className="py-1.5 text-right font-medium">steps</th>
              </tr>
            </thead>
            <tbody className="font-mono text-slate-300">
              {rows.map((w) => (
                <tr key={w.id} className="border-b border-slate-800/60 last:border-0">
                  <td className="py-1.5 pr-3">{w.id}</td>
                  <td className={`py-1.5 pr-3 ${PHASE_TONES[w.phase] || 'text-slate-400'}`}>{w.phase}</td>
                  <td className="py-1.5 pr-3 text-right">{w.cpuPct == null ? '—' : w.cpuPct.toFixed(1)}</td>
                  <td className="py-1.5 pr-3 text-right">{fmtBytes(w.stateBytes)}</td>
                  <td className="py-1.5 pr-3 text-right">{fmtBusy(w.busyMs)}</td>
                  <td className="py-1.5 text-right">{w.attempts ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-2 text-[10px] text-slate-600">
        cpu = attributed share of the host event loop · state = exact serialized size (what hibernation writes)
      </div>
    </div>
  );
});

/** 3-Tier cascade pipeline: per-cycle tier distribution + model pins + last route + cost rollup. */
function CascadePanel({ cascade, costs }) {
  const tiers = cascade?.tiers || {};
  const last = cascade?.lastTier;
  const total = Object.values(tiers).reduce((a, v) => a + (v || 0), 0);
  const fmtUsd = (v) => (v == null ? '—' : v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);
  const rows = [
    { key: 'tier1-template', label: 'T1 · skill templates', model: 'skillbase (local)', tone: 'bg-emerald-500' },
    { key: 'tier2-local', label: 'T2 · local LLM', model: cascade?.models?.tier2 || 'ollama', tone: 'bg-sky-500' },
    { key: 'supervisor', label: 'T3 · cloud frontier', model: cascade?.models?.tier3 || 'openrouter', tone: 'bg-violet-500' },
    { key: 'local-fallback', label: 'fallback · keyword snipe', model: 'keyword-triggers', tone: 'bg-slate-500' },
  ];
  return (
    <div className="rounded-xl border border-slate-700/60 bg-slate-800/60 p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-xs font-medium uppercase tracking-wider text-slate-400">Supervisor pipeline</span>
        <span className="text-xs text-slate-500">{total} consults this cycle</span>
      </div>
      {rows.map((r) => {
        const n = tiers[r.key] || 0;
        const pct = total ? (n / total) * 100 : 0;
        return (
          <div key={r.key} className="mb-1.5">
            <div className="flex justify-between text-xs">
              <span className="text-slate-300">{r.label} <span className="text-slate-500">· {r.model}</span></span>
              <span className="font-mono text-slate-400">{n}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-slate-700/60">
              <div className={`h-full rounded-full ${r.tone}`} style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
      <div className="mt-2 text-[10px] text-slate-600">
        last route: {last ? `${last.source} (${last.model ?? '?'}) in ${last.latencyMs ?? 0}ms` : 'none yet'}
      </div>
      {costs?.totals && (
        <div className="mt-2 border-t border-slate-700/60 pt-2">
          <div className="flex items-baseline justify-between text-xs">
            <span className="text-xs font-medium uppercase tracking-wider text-slate-400">Cost rollup (all time)</span>
            <span className="font-mono text-emerald-400">{costs.totals.savingsPct}% avoided</span>
          </div>
          <div className="mt-1 space-y-0.5 text-[11px] text-slate-400">
            <div className="flex justify-between"><span>avoided by T1/T2/fallback ({costs.totals.consults - (costs.perTier?.supervisor?.consults ?? 0)} consults)</span><span className="font-mono text-emerald-400">{fmtUsd(costs.totals.avoidedUsd)}</span></div>
            <div className="flex justify-between"><span>spent at T3 ({costs.perTier?.supervisor?.consults ?? 0} consults × {fmtUsd(costs.unitT3Usd)})</span><span className="font-mono text-slate-300">{fmtUsd(costs.totals.spentUsd)}</span></div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [sample, setSample] = useState(null);
  const [connected, setConnected] = useState(false);
  const [fetchFailed, setFetchFailed] = useState(false);
  const [history, setHistory] = useState([]);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const feedRef = useRef(null);

  useEffect(() => {
    // Throttled feed: transport can be chatty; React commits stay at 2Hz.
    feedRef.current = createThrottledFeed((s) => {
      if (s === FETCH_FAILED) {
        // Telemetry server unreachable — keep the last sample on screen but
        // let the badge say offline (distinct from stale: nothing is answering).
        setFetchFailed(true);
        return;
      }
      setFetchFailed(false);
      setSample(s);
      setConnected(!!(s && s.ts));
      setHistory((h) => [...h.slice(-MAX_HISTORY + 1), s?.ramPct ?? 0]);
    }, 500);
    const feed = feedRef.current;

    let unlisten = null;
    subscribeTelemetry((s) => feed.feed(s)).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
      feed.stop();
    };
  }, []);

  // Heartbeat: staleness must be re-evaluated even when NO new samples
  // arrive — during an orchestrator outage the telemetry server still
  // answers with the last snapshot, so `connected` alone would keep the
  // badge saying "live" over frozen data.
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const ramHistory = history;

  const pool = sample?.pool || {};
  const queue = sample?.queue || {};
  const ramPct = sample?.ramPct ?? 0;
  const ramTone = ramPct >= 80 ? 'rose' : ramPct >= 70 ? 'amber' : 'sky';

  // Feed state: live = fresh samples flowing; stale = poll still answered
  // but the payload's ts stopped advancing (orchestrator down — its
  // snapshot is frozen at the last write, ~2–3s cadence → 5s threshold);
  // offline = no sample with a ts at all (telemetry server unreachable).
  const STALE_MS = 5000;
  const staleAgeSec = sample?.ts != null ? Math.max(0, Math.round((nowTick - sample.ts) / 1000)) : null;
  const feedState = fetchFailed || !connected ? 'offline' : staleAgeSec == null || staleAgeSec * 1000 <= STALE_MS ? 'live' : 'stale';

  return (
    <div className="min-h-screen bg-slate-900 p-6 text-slate-100">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Daisy Cluster</h1>
          <p className="text-sm text-slate-400">
            Hybrid cloud-local multi-agent telemetry
            <span
              className={`ml-2 inline-flex items-center gap-1 ${feedState === 'live' ? 'text-emerald-400' : feedState === 'stale' ? 'text-amber-400' : 'text-rose-400'}`}
              title={feedState === 'stale' ? 'telemetry server answers, but the orchestrator snapshot is frozen — supervisor should heal within one tick (15s)' : undefined}
            >
              <span className={`inline-block h-2 w-2 rounded-full ${feedState === 'live' ? 'animate-pulse bg-emerald-400' : feedState === 'stale' ? 'bg-amber-400' : 'bg-rose-400'}`} />
              {feedState === 'live' ? 'live' : feedState === 'stale' ? `stale — orchestrator unreachable · data ${staleAgeSec}s old` : 'offline'}
            </span>
            <KeyHealthChip kh={sample?.keyHealth} />
            <T2HealthChip t2={sample?.t2Health} />
          </p>
        </div>
        <div className="text-right text-xs text-slate-500">
          {sample?.spawnBlocked && <span className="mr-2 rounded bg-rose-500/20 px-2 py-0.5 text-rose-300">spawn blocked</span>}
          cycle <span className="font-mono text-slate-300">{sample?.cycle ?? '—'}</span>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Gauge
          label="System RAM"
          pct={ramPct}
          tone={ramTone}
          sub={ramPct >= 80 ? 'hibernation zone — governor active' : `hysteresis 80→70 · block at 90`}
        />
        <Gauge
          label="Queue depth"
          pct={Math.min(100, ((queue.pending ?? 0) / Math.max(1, (queue.pending ?? 0) + (queue.done ?? 0) + 10)) * 100)}
          sub={`pending ${queue.pending ?? 0} · leased ${queue.leased ?? 0} · done ${queue.done ?? 0} · failed ${queue.failed ?? 0}`}
        />
        <Gauge
          label="Workers"
          pct={Math.min(100, ((pool.size ?? 0) / Math.max(1, pool.maxSize || 100)) * 100)}
          sub={`${pool.size ?? 0} live · target ${pool.targetSize ?? '—'} · hibernating ${sample?.workersHibernating ?? 0}`}
        />
        <Gauge
          label="Fleet phases"
          pct={((pool.byPhase?.working ?? 0) / Math.max(1, pool.size || 1)) * 100}
          sub={Object.entries(pool.byPhase || {}).map(([k, v]) => `${k}:${v}`).join(' · ') || 'idle fleet'}
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="rounded-xl border border-slate-700/60 bg-slate-800/60 p-4">
          <div className="mb-1 text-xs font-medium uppercase tracking-wider text-slate-400">RAM % (last {MAX_HISTORY}s)</div>
          <Spark data={ramHistory} tone={ramPct >= 80 ? '#fb7185' : '#38bdf8'} />
        </div>
        <div className="rounded-xl border border-slate-700/60 bg-slate-800/60 p-4">
          <div className="mb-1 text-xs font-medium uppercase tracking-wider text-slate-400">Governor</div>
          <div className="space-y-1 text-sm text-slate-300">
            <div className="flex justify-between"><span>Policy</span><span className="font-mono">hibernate ≥80% · wake &lt;70% · block ≥90%</span></div>
            <div className="flex justify-between"><span>Spawn block</span><span className={sample?.spawnBlocked ? 'text-rose-400' : 'text-emerald-400'}>{sample?.spawnBlocked ? 'ENGAGED' : 'clear'}</span></div>
            <div className="flex justify-between"><span>Hibernating workers</span><span className="font-mono">{sample?.workersHibernating ?? 0}</span></div>
          </div>
        </div>
        <div className="rounded-xl border border-slate-700/60 bg-slate-800/60 p-4">
          <div className="mb-1 text-xs font-medium uppercase tracking-wider text-slate-400">Supervisor events</div>
          {(sample?.supervisorEvents?.events?.length ?? 0) === 0 ? (
            <div className="text-sm text-slate-500">no heal/halt events in the log</div>
          ) : (
            <div className="space-y-1">
              {sample.supervisorEvents.events.map((ev, i) => {
                const tone = { heal: 'bg-sky-500/20 text-sky-300', 'boot-fail': 'bg-amber-500/20 text-amber-300', HALTED: 'bg-rose-500/20 text-rose-300', alert: 'bg-rose-500/20 text-rose-300', 'halt-cleared': 'bg-emerald-500/20 text-emerald-300' }[ev.kind] || 'bg-slate-600/40 text-slate-300';
                const time = ev.ts != null
                  ? new Date(ev.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                  : '—:—'; // legacy line from before log timestamping
                return (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <span className="w-[62px] shrink-0 font-mono text-[11px] text-slate-500" title={ev.ts != null ? new Date(ev.ts).toLocaleString() : 'logged before log timestamping — time unknown'}>{time}</span>
                    <span className={`rounded px-1.5 py-0.5 font-mono ${tone}`}>{ev.kind}</span>
                    <span className="truncate text-slate-400" title={ev.text}>{ev.text}</span>
                  </div>
                );
              })}
              <div className="pt-1 text-[11px] text-slate-500">
                {sample.supervisorEvents.hasTimestamps && !sample.supervisorEvents.hasLegacy
                  ? `log updated ${sample.supervisorEvents.logAge ?? '?'}s ago · newest first`
                  : sample.supervisorEvents.hasTimestamps
                    ? 'older entries predate log timestamping — their time is unknown · newest first'
                    : 'pre-timestamping log — times unknown · newest first'}
              </div>
            </div>
          )}
        </div>
        <div className="rounded-xl border border-slate-700/60 bg-slate-800/60 p-4">
          <div className="mb-1 text-xs font-medium uppercase tracking-wider text-slate-400">Supervisor guard</div>
          <div className="space-y-1 text-sm text-slate-300">
            <div className="flex justify-between">
              <span>Healer</span>
              <span className={sample?.supervisor?.loaded ? 'text-emerald-400' : 'text-amber-400'}>
                {sample?.supervisor?.loaded ? 'watching' : 'not running'}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Boot-failure streak</span>
              <span className={`font-mono ${(sample?.supervisor?.streak ?? 0) > 0 ? 'text-amber-400' : 'text-slate-400'}`}>
                {sample?.supervisor?.streak ?? 0} / {sample?.supervisor?.maxFailures ?? 5}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Halt</span>
              <span className={sample?.supervisor?.halted ? 'text-rose-400' : 'text-emerald-400'}>
                {sample?.supervisor?.halted ? 'HALTED — healing stopped' : 'clear'}
              </span>
            </div>
          </div>
        </div>
        <CascadePanel cascade={sample?.cascade} costs={sample?.costs} />
      </div>

      <div className="mt-4">
        <AgentTable workers={pool.workers} hostStats={sample?.hostStats} perWorkerRss={sample?.hostStats?.perWorkerRss} />
      </div>
    </div>
  );
}
