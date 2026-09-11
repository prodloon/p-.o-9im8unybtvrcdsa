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

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
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
      </div>
    </div>
  );
}
