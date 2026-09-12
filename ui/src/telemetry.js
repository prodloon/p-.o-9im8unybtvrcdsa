/**
 * Daisy Cluster telemetry client (Phase 5)
 * =========================================
 * Two transports, one interface:
 *   • Tauri shell  → native IPC events ('telemetry://metrics') emitted by
 *     the Rust host every second — zero network, zero lag.
 *   • Plain Vite   → loopback HTTP polling of backend/telemetry-server.js.
 *
 * Throttling: incoming samples land in a ref buffer; a 500ms interval
 * commits to React state. No matter how chatty the transport is, the UI
 * thread re-renders at most twice per second.
 */

const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Sentinel fed to the consumer when a poll fails outright (server down / non-OK). */
export const FETCH_FAILED = Symbol('fetch-failed');

export async function subscribeTelemetry(onSample) {
  if (isTauri()) {
    const { listen } = await import('@tauri-apps/api/event');
    const unlisten = await listen('telemetry://metrics', (event) => {
      onSample(event.payload);
    });
    return unlisten;
  }

  // Browser fallback: poll the loopback telemetry server.
  let stopped = false;
  const poll = async () => {
    while (!stopped) {
      try {
        const res = await fetch('http://127.0.0.1:6292/api/telemetry');
        if (res.ok) onSample(await res.json());
        else onSample(FETCH_FAILED);
      } catch {
        /* server not up yet; keep trying quietly — but tell the UI so the
           badge can distinguish offline from stale */
        onSample(FETCH_FAILED);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  };
  poll();
  return () => {
    stopped = true;
  };
}

/** Buffer + throttle helper: returns a feed function that commits at most `hz` times/sec. */
export function createThrottledFeed(onCommit, intervalMs = 500) {
  let buffer = null;
  const timer = setInterval(() => {
    if (buffer !== null) {
      const sample = buffer;
      buffer = null;
      onCommit(sample);
    }
  }, intervalMs);
  return {
    feed(sample) {
      buffer = sample;
    },
    stop() {
      clearInterval(timer);
    },
  };
}
