import React, { useEffect, useMemo, useRef, useState } from 'react';
import { subscribeTelemetry, createThrottledFeed } from './telemetry.js';

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

/** 3-Tier cascade pipeline: per-cycle tier distribution + model pins + last route. */
function CascadePanel({ cascade }) {
  const tiers = cascade?.tiers || {};
  const last = cascade?.lastTier;
  const total = Object.values(tiers).reduce((a, v) => a + (v || 0), 0);
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
    </div>
  );
}

export default function App() {
  const [sample, setSample] = useState(null);
  const [connected, setConnected] = useState(false);
  const [history, setHistory] = useState([]);
  const feedRef = useRef(null);

  useEffect(() => {
    // Throttled feed: transport can be chatty; React commits stay at 2Hz.
    feedRef.current = createThrottledFeed((s) => {
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

  const ramHistory = history;

  const pool = sample?.pool || {};
  const queue = sample?.queue || {};
  const ramPct = sample?.ramPct ?? 0;
  const ramTone = ramPct >= 80 ? 'rose' : ramPct >= 70 ? 'amber' : 'sky';

  return (
    <div className="min-h-screen bg-slate-900 p-6 text-slate-100">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Daisy Cluster</h1>
          <p className="text-sm text-slate-400">
            Hybrid cloud-local multi-agent telemetry
            <span className={`ml-2 inline-flex items-center gap-1 ${connected ? 'text-emerald-400' : 'text-rose-400'}`}>
              <span className={`inline-block h-2 w-2 rounded-full ${connected ? 'animate-pulse bg-emerald-400' : 'bg-rose-400'}`} />
              {connected ? 'live' : 'offline'}
            </span>
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
        <CascadePanel cascade={sample?.cascade} />
      </div>

      <div className="mt-4">
        <AgentTable workers={pool.workers} hostStats={sample?.hostStats} perWorkerRss={sample?.hostStats?.perWorkerRss} />
      </div>
    </div>
  );
}
