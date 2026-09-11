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
      } catch {
        /* server not up yet; keep trying quietly */
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
