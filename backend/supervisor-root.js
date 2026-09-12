'use strict';
/**
 * Supervisor root resolution (backend/supervisor-root.js)
 * =======================================================
 * The supervisor (scripts/cluster.sh under launchd) lives in the operator's
 * checkout and writes logs/launchd-agent.log + .run/supervisor.* markers
 * THERE — never inside the app bundle, whose database/ is redirected to
 * Application Support and whose logs/ is installer-excluded.
 *
 * The orchestrator's supervisor views (events strip, guard panel) must
 * therefore read from the supervisor's tree, not this.root:
 *
 *   1. DAISY_SUPERVISOR_ROOT  — explicit override wins (tests, exotic setups)
 *   2. ~/daisy-chain          — the supervised checkout, probed only in app
 *                               mode (DAISY_DATA_DIR set ⇒ we are the app's
 *                               backend) and only when it actually holds a
 *                               daisy tree (scripts/cluster.sh present)
 *   3. this.root              — repo mode (the orchestrator launched by
 *                               cluster.sh itself): its own tree IS the
 *                               supervisor's tree
 *
 * Pure and probe-based (no shell-outs); returns { root, source } so the
 * telemetry payload can show WHY a root was chosen — the app backend's
 * stdout goes to /dev/null, so visibility has to live in the payload.
 */

const fs = require('fs');
const path = require('path');

/** Evidence that `root` is a daisy tree a supervisor could plausibly own. */
function _isDaisyTree(root) {
  try {
    fs.accessSync(path.join(root, 'scripts', 'cluster.sh'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the supervisor's root. `ownRoot` is the orchestrator's own tree
 * (this.root). Never returns a root equal to a non-existent tree: probes
 * fall through to ownRoot, which is always valid by construction.
 */
function resolveSupervisorRoot(ownRoot) {
  // 1. Explicit override wins — but only if it looks like a daisy tree.
  const override = process.env.DAISY_SUPERVISOR_ROOT;
  if (override) {
    const p = path.resolve(override);
    if (_isDaisyTree(p)) return { root: p, source: 'env' };
  }
  // 2. App mode: the supervised checkout at ~/daisy-chain (cluster.sh's
  //    LaunchAgent supervises exactly that path on this machine).
  if (process.env.DAISY_DATA_DIR && process.env.HOME) {
    const checkout = path.join(process.env.HOME, 'daisy-chain');
    if (checkout !== ownRoot && _isDaisyTree(checkout)) {
      return { root: checkout, source: 'checkout' };
    }
  }
  // 3. Repo mode (or app mode with no checkout on disk): our own tree.
  return { root: ownRoot, source: 'self' };
}

module.exports = { resolveSupervisorRoot };
