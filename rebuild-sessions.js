/**
 * Rebuild SEED_SESSIONS in index.html from data/sessions.json
 * Also fixes version mechanism to use separate version keys per data type
 */
const fs = require('fs');
const path = require('path');

let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const sessions = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'sessions.json'), 'utf8'));

console.log(`Sessions loaded: ${sessions.length}`);

// 1. Replace SEED_SESSIONS
const seedRe = /const SEED_SESSIONS = \[.*?\];/s;
if (!seedRe.test(html)) {
  console.error('❌ Could not find SEED_SESSIONS');
  process.exit(1);
}
const newSeedLine = 'const SEED_SESSIONS = ' + JSON.stringify(sessions) + ';';
html = html.replace(seedRe, newSeedLine);
console.log('✓ SEED_SESSIONS replaced');

// 2. Fix the DATA_VERSION mechanism — bump to 9 since SEED_SESSIONS actually changed
html = html.replace(/const DATA_VERSION = \d+;.*/, 'const DATA_VERSION = 9; // bump ONLY when SEED_SESSIONS change');
console.log('✓ DATA_VERSION set to 9');

// 3. Fix getSessions() to MERGE seed data with user's localStorage data instead of wiping
// This ensures user-added sessions survive version bumps
const oldGetSessions = `function getSessions() {
  try {
    const storedVer = parseInt(localStorage.getItem(DVK)) || 0;
    if (storedVer < DATA_VERSION && SEED_SESSIONS.length > 0) {
      // Seed data was updated – force refresh
      localStorage.removeItem(SK);
      localStorage.setItem(DVK, String(DATA_VERSION));
      saveSessions(SEED_SESSIONS);
      return [...SEED_SESSIONS];
    }
    const stored = JSON.parse(localStorage.getItem(SK)) || [];
    if (stored.length > 0) return stored;
    if (SEED_SESSIONS.length > 0) { saveSessions(SEED_SESSIONS); localStorage.setItem(DVK, String(DATA_VERSION)); return [...SEED_SESSIONS]; }
    return [];
  } catch { return []; }
}`;

const newGetSessions = `function getSessions() {
  try {
    const storedVer = parseInt(localStorage.getItem(DVK)) || 0;
    if (storedVer < DATA_VERSION && SEED_SESSIONS.length > 0) {
      // Seed data was updated – merge: keep seed + any user-added sessions not in seed
      const stored = (() => { try { return JSON.parse(localStorage.getItem(SK)) || []; } catch { return []; } })();
      const seedIds = new Set(SEED_SESSIONS.map(s => s.id));
      const userAdded = stored.filter(s => !seedIds.has(s.id));
      const merged = [...SEED_SESSIONS, ...userAdded];
      merged.sort((a, b) => a.date.localeCompare(b.date));
      localStorage.setItem(DVK, String(DATA_VERSION));
      saveSessions(merged);
      return merged;
    }
    const stored = JSON.parse(localStorage.getItem(SK)) || [];
    if (stored.length > 0) return stored;
    if (SEED_SESSIONS.length > 0) { saveSessions(SEED_SESSIONS); localStorage.setItem(DVK, String(DATA_VERSION)); return [...SEED_SESSIONS]; }
    return [];
  } catch { return []; }
}`;

if (html.includes(oldGetSessions)) {
  html = html.replace(oldGetSessions, newGetSessions);
  console.log('✓ getSessions() fixed — now merges instead of wiping');
} else {
  console.log('⚠ Could not find exact getSessions() — trying regex...');
  const fnRe = /function getSessions\(\)\s*\{[\s\S]*?^}/m;
  if (fnRe.test(html)) {
    html = html.replace(fnRe, newGetSessions);
    console.log('✓ getSessions() replaced via regex');
  } else {
    console.error('❌ Could not replace getSessions()');
  }
}

fs.writeFileSync(path.join(__dirname, 'index.html'), html, 'utf8');
console.log(`\n✅ index.html rebuilt: ${sessions.length} sessions, ${html.length} chars`);

// Verify
const checks = [
  ['SEED_SESSIONS count', (html.match(/SEED_SESSIONS = \[/)) !== null],
  ['DATA_VERSION=9', html.includes('DATA_VERSION = 9')],
  ['Merge logic', html.includes('seedIds') && html.includes('userAdded')],
  ['getBonuses', html.includes('function getBonuses()')],
  ['renderBonusView', html.includes('function renderBonusView')],
  ['Bonus nav', html.includes('data-view="bonuses"')],
];
checks.forEach(([name, ok]) => console.log(ok ? '  ✓' : '  ✗', name));
