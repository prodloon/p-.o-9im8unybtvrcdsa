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

/** Shell alert channel: the Rust host emits `shell://no-node` when no Node
 *  runtime was found at launch (backend can never spawn). Returns unlisten,
 *  or null in plain-browser mode where the concept doesn't apply. */
export async function subscribeShellAlert(onAlert) {
  if (!isTauri()) return null;
  const { listen } = await import('@tauri-apps/api/event');
  return listen('shell://no-node', (event) => onAlert(String(event.payload || '')));
}

/** Updater channels: the Rust host emits `shell://update-available` when a
 *  feed check finds a newer version (download starting), and
 *  `shell://update-ready` after the update has been downloaded,
 *  signature-verified, and STAGED (applied on relaunch).
 *  Returns unlisten, or null in plain-browser mode. */
export async function subscribeUpdateAvailable(onAvailable) {
  if (!isTauri()) return null;
  const { listen } = await import('@tauri-apps/api/event');
  return listen('shell://update-available', (event) => onAvailable(String(event.payload || '')));
}

export async function subscribeUpdateReady(onReady) {
  if (!isTauri()) return null;
  const { listen } = await import('@tauri-apps/api/event');
  return listen('shell://update-ready', (event) => onReady(String(event.payload || '')));
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
