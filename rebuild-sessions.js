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
// Use a monotonically increasing version derived from sessions count + build time
// so every rebuild from build-deep-from-zips.js triggers the merge logic in
// browsers that already loaded an older seed.
const newVersion = sessions.length + Math.floor(Date.now() / 1000);
html = html.replace(/const DATA_VERSION = \d+;[^\n]*/, `const DATA_VERSION = ${newVersion}; // auto-bumped by rebuild-sessions.js`);
console.log('DATA_VERSION set to', newVersion);

// 3. Fix getSessions() to merge instead of wipe
const oldFn = /function getSessions\(\) \{\s*try \{[\s\S]*?\} catch \{[^}]*\}\s*\}/;
const newGetSessions = `function getSessions() {
  try {
    const storedVer = parseInt(localStorage.getItem(DVK)) || 0;
    // Self-heal: if storage size exceeds the seed by more than 200 sessions, the
    // user is almost certainly carrying a doubled history from the v10 -> v1+ epoch
    // bump. Force a re-merge regardless of version comparison.
    let storedSnap = (() => { try { return JSON.parse(localStorage.getItem(SK)) || []; } catch { return []; } })();
    const doubled = storedSnap.length > SEED_SESSIONS.length + 200;
    if ((storedVer < DATA_VERSION || doubled) && SEED_SESSIONS.length > 0) {
      // Dedup by CONTENT signature (date|hands|buyIn|cashOut|stakes) NOT by id,
      // because the seed-generator changed id schemes (UUID -> hash) so an id-based
      // dedup would treat every old localStorage row as 'user-added' and keep both
      // copies, doubling the history.
      const sig = s => (s.date||'') + '|' + (s.hands||0) + '|' + Number(s.buyIn||0).toFixed(2) + '|' + Number(s.cashOut||0).toFixed(2) + '|' + (s.stakes||'');
      const seedSigs = new Set(SEED_SESSIONS.map(sig));
      const userAdded = storedSnap.filter(s => !seedSigs.has(sig(s)));
      const merged = [...SEED_SESSIONS, ...userAdded];
      merged.sort((a, b) => a.date.localeCompare(b.date));
      localStorage.setItem(DVK, String(DATA_VERSION));
      saveSessions(merged);
      return merged;
    }
    if (storedSnap.length > 0) return storedSnap;
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
