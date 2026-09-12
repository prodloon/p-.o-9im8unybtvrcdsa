'use strict';
/**
 * Supervisor LaunchAgent log parser — pure functions, no I/O.
 *
 * Feeds the dashboard's "Supervisor events" strip. The log is produced by
 * scripts/cluster.sh and comes in two eras:
 *
 *   timestamped (current):  \x1b[36m[cluster 2026-09-12 12:22:20]\x1b[0m supervisor: core service down — …
 *   legacy (pre-timestamp): \x1b[36m[cluster]\x1b[0m supervisor: core service down — …
 *
 * Rules that the S17 selftest pins in place:
 *  - only lines tagged `[cluster …]` count (substring test — the writer
 *    always leads its lines with the tag);
 *  - ANSI escapes are stripped BEFORE prefix/text splitting;
 *  - kind classification runs in declaration order and first match wins
 *    (the HALTED line also contains "ALERT:" via alert(), but must be
 *    classified HALTED);
 *  - newest first, capped at `limit` events;
 *  - ts is the log's own timestamp or null for legacy lines — callers
 *    must treat null as "unknown, pre-timestamp era", not "now".
 */

const KINDS = [
  [/core service down/, 'heal'],
  [/boot FAILED \((\d+)\//, 'boot-fail'],
  [/HALTED/, 'HALTED'],
  [/halt cleared/, 'halt-cleared'],
  [/ALERT:/, 'alert'],
];

const ANSI_RE = /\x1b\[[0-9;]*m/g;
// [cluster] (legacy) or [cluster YYYY-MM-DD HH:MM:SS] (timestamped)
const PREFIX_RE = /^\s*\[cluster(?: (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}))?\]\s*/;

/**
 * Parse raw log text into events.
 * @param {string} raw        full log contents
 * @param {number} [limit=6]  max events returned (newest first)
 * @returns {{events: Array<{kind: string, text: string, ts: number|null}>, eras: {timestamped: number, legacy: number}}}
 */
function parseSupervisorLog(raw, limit = 6) {
  const rawLines = String(raw ?? '').split('\n');
  const events = [];
  const eras = { timestamped: 0, legacy: 0 };
  for (let i = rawLines.length - 1; i >= 0 && events.length < limit; i--) {
    const line = rawLines[i];
    if (!line.includes('[cluster')) continue;
    const clean = line.replace(ANSI_RE, '');
    const m = clean.match(PREFIX_RE);
    if (!m) continue;
    const hit = KINDS.find(([re]) => re.test(clean));
    if (!hit) continue;
    let ts = null;
    if (m[1]) {
      // 'YYYY-MM-DD HH:MM:SS' is local time → build ISO 8601 with the offset
      // (guaranteed parse, unlike free-form Date.parse input).
      const parsed = Date.parse(`${m[1].replace(' ', 'T')}${tzOffset()}`);
      if (!Number.isNaN(parsed)) {
        ts = parsed;
        eras.timestamped++;
      } else {
        eras.legacy++;
      }
    } else {
      eras.legacy++;
    }
    events.push({ kind: hit[1], text: clean.replace(PREFIX_RE, '').slice(0, 90), ts });
  }
  return { events, eras };
}

/** Local-time offset string like '+02:00' — log stamps are written in local time. */
function tzOffset() {
  const min = -new Date().getTimezoneOffset();
  const sign = min >= 0 ? '+' : '-';
  const abs = Math.abs(min);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

module.exports = { parseSupervisorLog, KINDS, ANSI_RE, PREFIX_RE };
