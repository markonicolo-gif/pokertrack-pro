/**
 * Rebuild index.html with fresh session data from data/sessions.json
 * - Replaces SEED_SESSIONS
 * - Fixes getSessions() to merge instead of wipe
 * - Bumps DATA_VERSION
 * - NO bonus code
 */
const fs = require('fs');
const sessions = require('./data/sessions.json');

let html = fs.readFileSync('index.html', 'utf8');

// 1. Replace SEED_SESSIONS
const seedStart = html.indexOf('const SEED_SESSIONS = [');
if (seedStart === -1) { console.error('ERROR: SEED_SESSIONS not found'); process.exit(1); }
const seedEnd = html.indexOf('];', seedStart) + 2;
const seedJSON = JSON.stringify(sessions);
html = html.substring(0, seedStart) + 'const SEED_SESSIONS = ' + seedJSON + ';' + html.substring(seedEnd);
console.log('SEED_SESSIONS replaced: ' + sessions.length + ' sessions');

// 2. Bump DATA_VERSION to 11
html = html.replace(
  /const DATA_VERSION = \d+;.*/,
  'const DATA_VERSION = 11; // v11: all 13 ZIPs, 8220 sessions, correct P&L (wins-bets), no bonus'
);
console.log('DATA_VERSION bumped to 11');

// 3. Replace getSessions() with merge-based version
const gsStart = html.indexOf('function getSessions() {');
if (gsStart === -1) { console.error('ERROR: getSessions not found'); process.exit(1); }
// Find the end of the function: look for the next function definition or closing brace pattern
const gsEnd = html.indexOf('\nfunction saveSessions', gsStart);
if (gsEnd === -1) { console.error('ERROR: could not find end of getSessions'); process.exit(1); }

const newGetSessions = [
  'function getSessions() {',
  '  try {',
  '    const storedVer = parseInt(localStorage.getItem(DVK)) || 0;',
  '    const stored = JSON.parse(localStorage.getItem(SK)) || [];',
  '    if (storedVer < DATA_VERSION && SEED_SESSIONS.length > 0) {',
  '      // Merge: keep user-added sessions, replace seed data',
  '      const seedIds = new Set(SEED_SESSIONS.map(s => s.id));',
  '      const userAdded = stored.filter(s => !seedIds.has(s.id));',
  '      const merged = [...SEED_SESSIONS, ...userAdded];',
  '      merged.sort((a, b) => (a.date || "").localeCompare(b.date || ""));',
  '      localStorage.setItem(DVK, String(DATA_VERSION));',
  '      saveSessions(merged);',
  '      return merged;',
  '    }',
  '    if (stored.length > 0) return stored;',
  '    if (SEED_SESSIONS.length > 0) { saveSessions(SEED_SESSIONS); localStorage.setItem(DVK, String(DATA_VERSION)); return [...SEED_SESSIONS]; }',
  '    return [];',
  '  } catch { return []; }',
  '}',
].join('\n');

html = html.substring(0, gsStart) + newGetSessions + html.substring(gsEnd);
console.log('getSessions() replaced with merge version');

fs.writeFileSync('index.html', html);
const sizeKB = (fs.statSync('index.html').size / 1024).toFixed(0);
console.log('\nDone! index.html: ' + sizeKB + ' KB');

// Verification
const totalPnL = sessions.reduce((a, x) => a + x.cashOut - x.buyIn, 0);
const totalRake = sessions.reduce((a, x) => a + x.rake, 0);
const totalHands = sessions.reduce((a, x) => a + x.hands, 0);
console.log('\n=== VERIFICATION ===');
console.log('Sessions: ' + sessions.length);
console.log('Hands: ' + totalHands);
console.log('P&L: ' + totalPnL.toFixed(2));
console.log('Rake: ' + totalRake.toFixed(2));
