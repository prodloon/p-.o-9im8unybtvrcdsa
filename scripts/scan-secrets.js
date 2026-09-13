#!/usr/bin/env node
'use strict';
/**
 * Daisy Chain — Secret Leak Detection (item 25, built for cause)
 * =============================================================
 * On 2026-09-12 the S20 key-health fixture hardcoded the REAL, LIVE
 * OpenRouter key into backend/backend.selftest.js — committed, merged to
 * origin/main, and baked into the v1.1-key-health tag — while every
 * session record swore "the key appears nowhere in the repo". Nothing
 * scanned for exactly that. This scanner now gates every CI push.
 *
 * Laws (mirrors the other monitors):
 *   - Zero dependencies; pure `findSecrets(text)` so S23 pins every
 *     detection deterministically.
 *   - Findings are MASKED in all output (first 8 + … + last 4 for key-like
 *     material) — a leak scanner that prints the leak would be a leak.
 *   - The masked-fingerprint form (`sk-or-v1-2b8…6361`, ellipsis mid-key)
 *     is the repo's LEGITIMATE way to reference secrets in code, docs, and
 *     fixtures — the detectors structurally cannot match it (the ellipsis
 *     breaks every key shape), and MASKED_ALLOW is an explicit second gate.
 *   - Scopes to git TRACKED files only: .env is gitignored by design and
 *     is the one place a real key is supposed to live.
 *
 * Exit codes: 0 clean, 1 findings, 2 usage/internal error.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/** A finding is reported as { file, line, kind, masked, evidence } — evidence
 *  is evidence-shaped, never the secret itself. */
const DETECTORS = [
  {
    kind: 'openrouter-key',
    re: /\bsk-or-v1-[A-Za-z0-9]{32,}\b/g,
  },
  {
    kind: 'generic-sk-key',
    re: /\bsk-(?!or-v1-)[A-Za-z0-9_-]{28,}\b/g,
  },
  {
    kind: 'github-token',
    re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  },
  {
    kind: 'slack-token',
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    kind: 'aws-access-key',
    re: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    kind: 'private-key-block',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    kind: 'key-assignment',
    re: /\b(?:OPENROUTER_API_KEY|API_KEY|AUTH_TOKEN|SECRET_KEY|ACCESS_TOKEN)\s*[:=]\s*['"][A-Za-z0-9+/_-]{24,}['"]/g,
  },
];

/** Explicit second gate: the repo's masked fingerprint form is ALWAYS clean,
 *  even if a future detector grows permissive about ellipses. */
const MASKED_ALLOW = /\bsk-[A-Za-z0-9-]{2,12}…[A-Za-z0-9]{2,8}\b/;

/** Mask a secret-like string for reporting: keep head+tail only. */
function maskSecret(s) {
  if (typeof s !== 'string' || s.length < 12) return '…';
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
}

/**
 * Pure: scan one text body for secret-shaped material.
 * @returns {Array<{line: number, kind: string, masked: string}>}
 */
function findSecrets(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (MASKED_ALLOW.test(line)) continue; // the ellipsis form is the allowed idiom
    for (const d of DETECTORS) {
      d.re.lastIndex = 0;
      let m;
      while ((m = d.re.exec(line)) !== null) {
        out.push({ line: i + 1, kind: d.kind, masked: maskSecret(m[0]) });
      }
    }
  }
  return out;
}

/** List tracked files (respects .gitignore by construction; empty repo → []). */
function listTrackedFiles(cwd) {
  let out;
  try {
    out = execFileSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return [];
  }
  return out ? out.split('\0').filter(Boolean) : [];
}

/** Scan every tracked file under `cwd`. Never throws on unreadable files. */
function scanTrackedFiles(cwd) {
  const findings = [];
  for (const rel of listTrackedFiles(cwd)) {
    const abs = path.join(cwd, rel);
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue; // deleted between listing and read, or unreadable — not a leak
    }
    for (const f of findSecrets(text)) findings.push({ file: rel, ...f });
  }
  return findings;
}

function main() {
  const cwd = process.cwd();
  const findings = scanTrackedFiles(cwd);
  if (findings.length === 0) {
    console.log(`secret scan: CLEAN — ${listTrackedFiles(cwd).length} tracked files, 0 findings`);
    process.exit(0);
  }
  console.error(`secret scan: ${findings.length} FINDING(S) — committed secret-shaped material:\n`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  [${f.kind}]  ${f.masked}`);
  }
  console.error(`\nNever commit real keys — .env (gitignored) is their only home.`);
  console.error(`In code/docs/fixtures use the masked form: sk-or-v1-abc…wxyz`);
  process.exit(1);
}

if (require.main === module) main();

module.exports = { findSecrets, scanTrackedFiles, maskSecret, MASKED_ALLOW, DETECTORS: DETECTORS.map((d) => d.kind) };
