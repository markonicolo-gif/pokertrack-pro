/**
 * Rebuild SEED_SESSIONS in index.html from data/sessions.json
 * Also fixes version mechanism to merge instead of wipe
 */
const fs = require('fs');
const path = require('path');

let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const sessions = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'sessions.json'), 'utf8'));

console.log(`Sessions loaded: ${sessions.length}`);

// 1. Replace SEED_SESSIONS
const seedRe = /const SEED_SESSIONS = \[.*?\];/s;
if (!seedRe.test(html)) {
  console.error('Could not find SEED_SESSIONS');
  process.exit(1);
}
html = html.replace(seedRe, 'const SEED_SESSIONS = ' + JSON.stringify(sessions) + ';');
console.log('SEED_SESSIONS replaced with', sessions.length, 'sessions');

// 2. Bump DATA_VERSION (sessions actually changed)
html = html.replace(/const DATA_VERSION = \d+;[^\n]*/, 'const DATA_VERSION = 10; // bump ONLY when SEED_SESSIONS change');
console.log('DATA_VERSION set to 10');

// 3. Fix getSessions() to merge instead of wipe
const oldFn = /function getSessions\(\) \{\s*try \{[\s\S]*?\} catch \{[^}]*\}\s*\}/;
const newGetSessions = `function getSessions() {
  try {
    const storedVer = parseInt(localStorage.getItem(DVK)) || 0;
    if (storedVer < DATA_VERSION && SEED_SESSIONS.length > 0) {
      // Seed data updated - merge: keep seed + any user-added sessions not in seed
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

if (oldFn.test(html)) {
  html = html.replace(oldFn, newGetSessions);
  console.log('getSessions() fixed - merges instead of wiping');
} else {
  console.error('Could not find getSessions()');
  process.exit(1);
}

fs.writeFileSync(path.join(__dirname, 'index.html'), html, 'utf8');
console.log('\nindex.html rebuilt:', sessions.length, 'sessions,', html.length, 'chars');

// Verify
const pnl = sessions.reduce((s,x) => s + (x.cashOut - x.buyIn), 0);
const rake = sessions.reduce((s,x) => s + (x.rake||0), 0);
const hands = sessions.reduce((s,x) => s + (x.hands||0), 0);
console.log('P&L:', pnl.toFixed(2), 'Rake:', rake.toFixed(2), 'Hands:', hands);
console.log('Merge logic:', html.includes('seedIds') ? 'OK' : 'FAIL');
console.log('DATA_VERSION=10:', html.includes('DATA_VERSION = 10') ? 'OK' : 'FAIL');
