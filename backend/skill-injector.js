#!/usr/bin/env node
'use strict';
/**
 * Daisy Chain — Skill-Sniping Injector (Phase 3)
 * ===============================================
 * Owns the skillbase/ directory contract:
 *   skillbase/index.json  — machine-readable catalog: [{name, triggers[], file}]
 *   skillbase/*.md|json   — the skill scripts themselves
 *
 * Two paths to a skill (knowledge.md §5):
 *   1. Supervisor verdict names a skill  → validate + inject  (source: 'supervisor')
 *   2. Cloud unreachable / no verdict    → local keyword sniping via
 *      index.json triggers (source: 'local-fallback') — the cluster degrades
 *      gracefully, never dead. (Spiritual port of daisy_chain._keyword_skills.)
 *
 * Every injection is recorded to governor.logSkillEvent → skill_events.
 */

const fs = require('fs');
const path = require('path');

class SkillInjector {
  /**
   * @param {object} opts
   * @param {string} opts.skillbaseDir  absolute path to skillbase/
   * @param {object} opts.governor      Governor (for skill_events logging)
   */
  constructor({ skillbaseDir, governor }) {
    this.dir = path.resolve(skillbaseDir);
    this.governor = governor;
  }

  /** Load + validate the catalog. Throws on structural corruption. */
  loadCatalog() {
    const file = path.join(this.dir, 'index.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(raw)) throw new Error('skillbase/index.json: expected an array');
    const seen = new Set();
    for (const entry of raw) {
      if (!entry || typeof entry.name !== 'string' || !Array.isArray(entry.triggers) || typeof entry.file !== 'string') {
        throw new Error(`skillbase/index.json: malformed entry ${JSON.stringify(entry).slice(0, 80)}`);
      }
      if (seen.has(entry.name)) throw new Error(`skillbase/index.json: duplicate skill '${entry.name}'`);
      seen.add(entry.name);
      const skillPath = path.join(this.dir, entry.file);
      if (!fs.existsSync(skillPath)) throw new Error(`skillbase/index.json: missing file for '${entry.name}': ${entry.file}`);
      // Path-jail: entry.file must not escape skillbase/
      if (!skillPath.startsWith(this.dir + path.sep)) throw new Error(`skillbase/index.json: file escapes skillbase for '${entry.name}'`);
    }
    return raw;
  }

  listSkillNames() {
    return this.loadCatalog().map((e) => e.name);
  }

  /** Read + basic-validate a skill script's content. */
  readSkill(name) {
    const entry = this.loadCatalog().find((e) => e.name === name);
    if (!entry) return null;
    const content = fs.readFileSync(path.join(this.dir, entry.file), 'utf8');
    if (!content.trim()) throw new Error(`skill '${name}' is empty`);
    return { name, file: entry.file, triggers: entry.triggers, content };
  }

  /**
   * Route a supervisor verdict to an injection decision.
   * @returns {{injected:boolean, source:string, skill:object|null, reason:string}}
   */
  applyVerdict(verdict, workerId, taskId) {
    if (verdict && verdict.inject === true && verdict.skill) {
      const skill = this.readSkill(verdict.skill);
      if (skill) {
        this.governor.logSkillEvent(workerId, verdict.skill, 'supervisor', 'applied');
        return { injected: true, source: 'supervisor', skill, reason: 'supervisor verdict' };
      }
      this.governor.logSkillEvent(workerId, verdict.skill, 'supervisor', 'failed');
      return { injected: false, source: 'supervisor', skill: null, reason: `unknown skill '${verdict.skill}'` };
    }
    return { injected: false, source: 'supervisor', skill: null, reason: verdict ? 'verdict declined injection' : 'no verdict' };
  }

  /**
   * Local keyword sniping — the offline fallback. Scores catalog triggers
   * against the task summary; injects the best match above a floor.
   */
  snipeLocally(taskSummary, workerId, taskId) {
    let catalog;
    try {
      catalog = this.loadCatalog();
    } catch (err) {
      return { injected: false, source: 'local-fallback', skill: null, reason: `catalog unreadable: ${err.message}` };
    }
    const text = String(taskSummary || '').toLowerCase();
    let best = null;
    let bestScore = 0;
    for (const entry of catalog) {
      let score = 0;
      for (const trig of entry.triggers) {
        if (text.includes(String(trig).toLowerCase())) score += 1;
      }
      if (score > bestScore) {
        bestScore = score;
        best = entry;
      }
    }
    if (best && bestScore > 0) {
      const skill = this.readSkill(best.name);
      this.governor.logSkillEvent(workerId, best.name, 'local-fallback', 'applied');
      return { injected: true, source: 'local-fallback', skill, reason: `keyword match (${bestScore})` };
    }
    return { injected: false, source: 'local-fallback', skill: null, reason: 'no trigger match' };
  }
}

module.exports = { SkillInjector };
