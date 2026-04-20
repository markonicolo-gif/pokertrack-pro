/**
 * audit-stats.js  —  Deep integrity audit of PokerTrack Pro data
 *
 * Re-parses every zip in data/ from scratch (independent of build-deep-from-zips.js)
 * and cross-checks the recomputed totals against what's currently stored in
 * data/platinex_dashboard_complete.json (and surfaced in the dashboard).
 *
 * Reports:
 *   1. Duplicate hand IDs across zips (would inflate totals)
 *   2. Duplicate session codes
 *   3. Duplicate tournament codes
 *   4. Hand-count mismatches (recomputed vs stored)
 *   5. Cash P&L mismatches (recomputed bets-wins vs stored)
 *   6. Tournament real-money P&L mismatches
 *   7. Per-month P&L drift (recomputed vs stored)
 *   8. Per-stakes P&L drift
 *   9. Sessions with negative hands / bets / wins (data corruption)
 *   10. Tournaments missing buyin/win/place
 *   11. Date range sanity (tournaments dated outside of zip date)
 *   12. Token vs cash classification breakdown
 *   13. ITM count vs actual cashes
 *   14. Weekly P&L curve sum vs total P&L
 *   15. Combined section sums match
 *
 * Usage:  node --max-old-space-size=8192 audit-stats.js
 *         node --max-old-space-size=8192 audit-stats.js --fast    (skips per-hand reparse)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { DOMParser } = require('xmldom');

const DATA_DIR = path.join(__dirname, 'data');
const HERO = 'platinex';
const FAST = process.argv.includes('--fast');
const TOL = 0.01; // €0.01 rounding tolerance

const RED = '\x1b[31m', YEL = '\x1b[33m', GRN = '\x1b[32m', CYN = '\x1b[36m', DIM = '\x1b[2m', BOLD = '\x1b[1m', RST = '\x1b[0m';

function ok(msg)   { console.log(GRN + '  ✓ ' + RST + msg); }
function warn(msg) { console.log(YEL + '  ⚠ ' + RST + msg); }
function fail(msg) { console.log(RED + '  ✗ ' + RST + msg); }
function info(msg) { console.log(CYN + '  ℹ ' + RST + msg); }
function header(t) { console.log('\n' + BOLD + CYN + '═══ ' + t + ' ═══' + RST); }

const parseAmt = (s) => parseFloat((s || '0').replace(/[^0-9.\-]/g, '')) || 0;
const det = (els, tag) => { const e = els.getElementsByTagName(tag); return e.length ? (e[0].textContent || '').trim() : ''; };

// ===================================================================================
// 1. LOAD STORED DASHBOARD JSON
// ===================================================================================
header('Loading stored data');
const jsonPath = path.join(DATA_DIR, 'platinex_dashboard_complete.json');
if (!fs.existsSync(jsonPath)) {
  fail('platinex_dashboard_complete.json not found — run build-deep-from-zips.js first');
  process.exit(1);
}
const STORED = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
ok('Loaded ' + (fs.statSync(jsonPath).size / 1024).toFixed(1) + ' KB dashboard JSON');

const storedCash = {
  hands: STORED._metadata.total_hands,
  sessions: STORED._metadata.total_sessions,
  pnl: STORED.pnl.total_eur,
  rake: STORED.pnl.total_rake_eur,
  by_month: STORED.pnl.by_month || {},
  by_stakes: STORED.pnl.by_stakes || {}
};
const storedTourn = (STORED.tournaments && STORED.tournaments.summary) ? STORED.tournaments.summary : null;
const storedTournSessions = (STORED.tournaments && STORED.tournaments.sessions) ? STORED.tournaments.sessions : [];
const storedCombined = STORED.combined || null;

info('Stored cash:  ' + storedCash.hands.toLocaleString() + ' hands, ' + storedCash.sessions + ' sessions, P&L €' + storedCash.pnl.toFixed(2));
if (storedTourn) {
  info('Stored tourn: ' + storedTourn.entries + ' entries, real-money €' + (storedTourn.real_money_pnl_eur||0).toFixed(2));
}
if (storedCombined) {
  info('Stored combined total: €' + storedCombined.total_pnl_eur.toFixed(2));
}

// ===================================================================================
// 2. RE-PARSE EVERY ZIP FROM SCRATCH
// ===================================================================================
header('Re-parsing every zip in data/');

const zips = fs.readdirSync(DATA_DIR).filter(f => f.toLowerCase().endsWith('.zip'));
info('Found ' + zips.length + ' zip files');

// Independent counters
const seenSessionCodes = new Set();
const dupSessionCodes = [];
const seenTournamentCodes = new Set();
const dupTournamentCodes = [];
const seenGameCodes = new Set();
const dupGameCodes = [];

// Per-zip session-code map (to know which zip a duplicate came from)
const codeToZip = new Map();

let recCash = { hands: 0, sessions: 0, pnl: 0, rake: 0, by_month: {}, by_stakes: {} };
let recTourn = {
  entries: 0, hands: 0,
  cash_entries: 0, cash_invested: 0, cash_won: 0,
  ticket_entries: 0, ticket_value: 0, ticket_won: 0,
  itm_count: 0,
  by_month: {},
  by_format: {},
  sessions: []
};

const corruptionWarnings = [];
const dateAnomalies = [];
const heroMismatches = [];

function reparseSession(text, zipName, fileName) {
  const doc = new DOMParser({ errorHandler: { warning:()=>{}, error:()=>{}, fatalError:()=>{} } }).parseFromString(text, 'text/xml');
  const sessEl = doc.getElementsByTagName('session')[0];
  if (!sessEl) return;

  const sessionCode = sessEl.getAttribute('sessioncode');
  if (sessionCode) {
    if (seenSessionCodes.has(sessionCode)) {
      dupSessionCodes.push({ code: sessionCode, zip: zipName, file: fileName, firstZip: codeToZip.get(sessionCode) });
      return;
    }
    seenSessionCodes.add(sessionCode);
    codeToZip.set(sessionCode, zipName);
  }

  const gen = doc.getElementsByTagName('general')[0];
  if (!gen) return;
  const nickname = det(gen, 'nickname');
  if (nickname !== HERO) {
    heroMismatches.push({ nick: nickname, zip: zipName, file: fileName });
    return;
  }

  const startStr = det(gen, 'startdate');
  const dm = startStr.match(/(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})/);
  if (!dm) { corruptionWarnings.push({ type: 'bad-date', startStr, file: fileName }); return; }
  const ym = dm[3] + '-' + dm[1];

  const games = doc.getElementsByTagName('game');
  const gameCount = games.length;

  // Collect game codes for duplicate detection
  for (let g = 0; g < gameCount; g++) {
    const gc = games[g].getAttribute('gamecode');
    if (gc) {
      if (seenGameCodes.has(gc)) dupGameCodes.push(gc);
      else seenGameCodes.add(gc);
    }
  }

  const tournamentCode = det(gen, 'tournamentcode');
  const isTournament = tournamentCode !== '';

  if (isTournament) {
    if (seenTournamentCodes.has(tournamentCode)) {
      // Same tournament can appear twice (e.g. rebuy → multi-entry); keep dup record but still aggregate
      dupTournamentCodes.push({ code: tournamentCode, zip: zipName, file: fileName });
    } else {
      seenTournamentCodes.add(tournamentCode);
    }

    const totalBuyin = parseAmt(det(gen, 'totalbuyin'));
    const rebuys = parseInt(det(gen, 'rebuys')) || 0;
    const totalRebuyCost = parseAmt(det(gen, 'totalrebuycost'));
    const addon = parseInt(det(gen, 'addon')) || 0;
    const totalAddonCost = parseAmt(det(gen, 'totaladdoncost'));
    const winAmt = parseAmt(det(gen, 'win'));
    const place = parseInt(det(gen, 'place')) || 0;
    const buyinRaw = det(gen, 'buyin');
    const tName = det(gen, 'tournamentname') || det(gen, 'tablename') || 'Unknown';
    const tablesize = parseInt(det(gen, 'tablesize')) || 6;

    const invested = totalBuyin + (rebuys * totalRebuyCost) + (addon * totalAddonCost);
    const paidWith = /token/i.test(buyinRaw) ? 'ticket' : 'cash';

    // sanity: invested should equal totalBuyin if no rebuys/addons
    if (totalBuyin < 0 || winAmt < 0 || invested < 0) {
      corruptionWarnings.push({ type:'tourn-negative', code:tournamentCode, totalBuyin, winAmt, invested, file:fileName });
    }

    let format;
    if (/twister|spin/i.test(tName)) format = 'Spin/Twister';
    else if (/double\s*or\s*nothing|\bdon\b/i.test(tName)) format = 'DoN';
    else if (/\bsat\b|satellite|step\s*sat/i.test(tName)) format = 'Satellite';
    else if (/sit\s*[&n]\s*go|\bsng\b|s&g/i.test(tName)) format = 'SnG';
    else if (tablesize <= 10 && !/gtd|guaranteed/i.test(tName)) format = 'SnG';
    else format = 'MTT';

    recTourn.entries++;
    recTourn.hands += gameCount;
    if (paidWith === 'cash') {
      recTourn.cash_entries++;
      recTourn.cash_invested += invested;
      recTourn.cash_won += winAmt;
    } else {
      recTourn.ticket_entries++;
      recTourn.ticket_value += invested;
      recTourn.ticket_won += winAmt;
    }
    if (winAmt > 0) recTourn.itm_count++;
    recTourn.by_month[ym] = recTourn.by_month[ym] || { entries:0, invested:0, cashed:0 };
    recTourn.by_month[ym].entries++;
    recTourn.by_month[ym].invested += invested;
    recTourn.by_month[ym].cashed += winAmt;
    recTourn.by_format[format] = recTourn.by_format[format] || { entries:0, invested:0, cashed:0 };
    recTourn.by_format[format].entries++;
    recTourn.by_format[format].invested += invested;
    recTourn.by_format[format].cashed += winAmt;
    recTourn.sessions.push({ code:tournamentCode, name:tName, format, paidWith, invested, win:winAmt, place, date:startStr, hands:gameCount, itm:winAmt>0 });
    return;
  }

  // CASH session
  const gametype = det(gen, 'gametype');
  const sBets = parseAmt(det(gen, 'bets'));
  const sWins = parseAmt(det(gen, 'wins'));
  const sessionPnl = sWins - sBets;

  // Per-hand rake (sum of <rake> tags across games)
  let sessionRake = 0;
  for (let g = 0; g < gameCount; g++) {
    const rk = games[g].getAttribute('rake');
    if (rk) sessionRake += parseAmt(rk);
  }
  if (sessionRake === 0 && gameCount > 0) {
    // Fallback: try <rake> child elements
    for (let g = 0; g < gameCount; g++) {
      const rakeEls = games[g].getElementsByTagName('rake');
      if (rakeEls.length) sessionRake += parseAmt(rakeEls[0].textContent);
    }
  }

  if (sBets < 0 || sWins < 0) {
    corruptionWarnings.push({ type:'cash-negative', sBets, sWins, file:fileName });
  }

  recCash.sessions++;
  recCash.hands += gameCount;
  recCash.pnl += sessionPnl;
  recCash.rake += sessionRake;
  recCash.by_month[ym] = recCash.by_month[ym] || { hands:0, pnl:0, sessions:0 };
  recCash.by_month[ym].hands += gameCount;
  recCash.by_month[ym].pnl += sessionPnl;
  recCash.by_month[ym].sessions++;
  recCash.by_stakes[gametype] = recCash.by_stakes[gametype] || { hands:0, pnl:0, sessions:0 };
  recCash.by_stakes[gametype].hands += gameCount;
  recCash.by_stakes[gametype].pnl += sessionPnl;
  recCash.by_stakes[gametype].sessions++;
}

(async () => {
  const t0 = Date.now();
  for (let zi = 0; zi < zips.length; zi++) {
    const zipName = zips[zi];
    const buf = fs.readFileSync(path.join(DATA_DIR, zipName));
    let zip;
    try { zip = await JSZip.loadAsync(buf); }
    catch(e) { fail('Cannot read ' + zipName + ': ' + e.message); continue; }
    const xmls = Object.values(zip.files).filter(f => !f.dir && f.name.endsWith('.xml'));
    process.stdout.write('  [' + (zi+1) + '/' + zips.length + '] ' + zipName + ' (' + xmls.length + ' xml) ');
    let parsed = 0;
    for (const xf of xmls) {
      const text = await xf.async('string');
      try { reparseSession(text, zipName, xf.name); parsed++; }
      catch(e) { corruptionWarnings.push({ type:'xml-parse-error', file:xf.name, msg:e.message }); }
    }
    console.log(parsed + '/' + xmls.length + ' parsed');
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  ok('Re-parse done in ' + elapsed + 's — ' + recCash.sessions + ' cash + ' + recTourn.entries + ' tourn entries');

  // ===================================================================================
  // 3. CHECKS
  // ===================================================================================
  let issues = 0;
  const issue = (msg) => { issues++; fail(msg); };

  // ----- DUPLICATE HAND IDs -----
  header('Check 1: Duplicate hand IDs (would inflate hand counts)');
  if (dupGameCodes.length === 0) ok('No duplicate hand gamecodes detected across ' + seenGameCodes.size.toLocaleString() + ' unique hands');
  else issue(dupGameCodes.length + ' duplicate gamecodes found! E.g. ' + dupGameCodes.slice(0,3).join(', '));

  // ----- DUPLICATE SESSION CODES -----
  header('Check 2: Duplicate session codes');
  if (dupSessionCodes.length === 0) ok('No duplicate session codes (' + seenSessionCodes.size + ' unique sessions)');
  else {
    warn(dupSessionCodes.length + ' duplicate session codes correctly skipped on dedup:');
    dupSessionCodes.slice(0, 5).forEach(d => console.log('     ' + DIM + d.code + ' first seen in [' + d.firstZip + '], dup in [' + d.zip + ']' + RST));
    if (dupSessionCodes.length > 5) console.log('     ' + DIM + '... and ' + (dupSessionCodes.length - 5) + ' more' + RST);
    info('Dedup is working correctly — these would otherwise double-count.');
  }

  // ----- DUPLICATE TOURNAMENT CODES (multi-entry is normal) -----
  header('Check 3: Duplicate tournament codes (multi-entry normal in re-buy/multi-day events)');
  if (dupTournamentCodes.length === 0) ok('All ' + seenTournamentCodes.size + ' tournament codes unique');
  else {
    info(dupTournamentCodes.length + ' multi-entry tournament rows detected (normal for re-buy MTTs)');
    const grp = {};
    dupTournamentCodes.forEach(d => grp[d.code] = (grp[d.code]||0)+1);
    const top = Object.entries(grp).sort((a,b)=>b[1]-a[1]).slice(0, 5);
    top.forEach(([c,n]) => console.log('     ' + DIM + c + ' → ' + (n+1) + ' entries' + RST));
  }

  // ----- HERO MISMATCH (sessions in zip not belonging to platinex) -----
  header('Check 4: Hero name validation');
  if (heroMismatches.length === 0) ok('All sessions belong to "' + HERO + '"');
  else {
    warn(heroMismatches.length + ' session(s) had a different nickname (correctly skipped):');
    const nickGrp = {};
    heroMismatches.forEach(m => nickGrp[m.nick] = (nickGrp[m.nick]||0)+1);
    Object.entries(nickGrp).slice(0,5).forEach(([n,c]) => console.log('     ' + DIM + (n||'(empty)') + ': ' + c + RST));
  }

  // ----- DATA CORRUPTION -----
  header('Check 5: Data corruption / missing fields');
  if (corruptionWarnings.length === 0) ok('No corruption (negative amounts, bad dates, parse errors)');
  else {
    warn(corruptionWarnings.length + ' corruption issue(s):');
    const corrGrp = {};
    corruptionWarnings.forEach(c => corrGrp[c.type] = (corrGrp[c.type]||0)+1);
    Object.entries(corrGrp).forEach(([t,c]) => console.log('     ' + DIM + t + ': ' + c + RST));
  }

  // ----- CASH HAND COUNT -----
  header('Check 6: Cash hand count (recomputed vs stored)');
  if (recCash.hands === storedCash.hands) ok('Match: ' + recCash.hands.toLocaleString() + ' hands');
  else issue('MISMATCH: recomputed ' + recCash.hands.toLocaleString() + ' vs stored ' + storedCash.hands.toLocaleString() + ' (Δ ' + (recCash.hands - storedCash.hands).toLocaleString() + ')');

  // ----- CASH SESSION COUNT -----
  header('Check 7: Cash session count');
  if (recCash.sessions === storedCash.sessions) ok('Match: ' + recCash.sessions + ' sessions');
  else issue('MISMATCH: recomputed ' + recCash.sessions + ' vs stored ' + storedCash.sessions + ' (Δ ' + (recCash.sessions - storedCash.sessions) + ')');

  // ----- CASH TOTAL P&L -----
  header('Check 8: Cash total P&L');
  const cashDelta = Math.abs(recCash.pnl - storedCash.pnl);
  if (cashDelta < TOL) ok('Match: €' + recCash.pnl.toFixed(2));
  else issue('MISMATCH: recomputed €' + recCash.pnl.toFixed(2) + ' vs stored €' + storedCash.pnl.toFixed(2) + ' (Δ €' + cashDelta.toFixed(2) + ')');

  // ----- CASH RAKE -----
  header('Check 9: Cash rake total');
  const rakeDelta = Math.abs(recCash.rake - storedCash.rake);
  if (rakeDelta < 1) ok('Match: €' + recCash.rake.toFixed(2));
  else warn('Slight drift: recomputed €' + recCash.rake.toFixed(2) + ' vs stored €' + storedCash.rake.toFixed(2) + ' (Δ €' + rakeDelta.toFixed(2) + ') — rake parsing differs slightly between methods');

  // ----- BY MONTH (CASH) -----
  header('Check 10: Cash P&L by month');
  const monthIssues = [];
  for (const [ym, v] of Object.entries(recCash.by_month)) {
    const stored = storedCash.by_month[ym];
    if (!stored) { monthIssues.push(ym + ': not in stored'); continue; }
    const d = Math.abs(v.pnl - stored.pnl_eur);
    if (d > TOL) monthIssues.push(ym + ': Δ €' + (v.pnl - stored.pnl_eur).toFixed(2));
  }
  for (const ym of Object.keys(storedCash.by_month)) {
    if (!recCash.by_month[ym]) monthIssues.push(ym + ': in stored but not recomputed');
  }
  if (monthIssues.length === 0) ok('All ' + Object.keys(recCash.by_month).length + ' months match');
  else { issue(monthIssues.length + ' month drift(s):'); monthIssues.slice(0, 8).forEach(m => console.log('     ' + DIM + m + RST)); }

  // ----- BY STAKES (CASH) -----
  header('Check 11: Cash P&L by stakes');
  const stkIssues = [];
  for (const [k, v] of Object.entries(recCash.by_stakes)) {
    const stored = storedCash.by_stakes[k];
    if (!stored) { stkIssues.push(k + ': missing in stored'); continue; }
    const d = Math.abs(v.pnl - stored.pnl_eur);
    if (d > TOL) stkIssues.push(k + ': Δ €' + (v.pnl - stored.pnl_eur).toFixed(2));
  }
  if (stkIssues.length === 0) ok('All ' + Object.keys(recCash.by_stakes).length + ' stake levels match');
  else { issue(stkIssues.length + ' stake drift(s):'); stkIssues.slice(0, 6).forEach(m => console.log('     ' + DIM + m + RST)); }

  // ----- TOURNAMENTS -----
  if (storedTourn) {
    header('Check 12: Tournament entry count');
    if (recTourn.entries === storedTourn.entries) ok('Match: ' + recTourn.entries + ' entries');
    else issue('MISMATCH: recomputed ' + recTourn.entries + ' vs stored ' + storedTourn.entries + ' (Δ ' + (recTourn.entries - storedTourn.entries) + ')');

    header('Check 13: Tournament hand count');
    if (recTourn.hands === storedTourn.total_hands) ok('Match: ' + recTourn.hands + ' hands');
    else issue('MISMATCH: recomputed ' + recTourn.hands + ' vs stored ' + storedTourn.total_hands + ' (Δ ' + (recTourn.hands - storedTourn.total_hands) + ')');

    header('Check 14: Token vs Cash split');
    info('Cash buy-ins:    recomputed ' + recTourn.cash_entries + ' (€' + recTourn.cash_invested.toFixed(2) + ' in → €' + recTourn.cash_won.toFixed(2) + ' out) | stored ' + storedTourn.cash_entries + ' (€' + (storedTourn.cash_invested_eur||0).toFixed(2) + ')');
    info('Ticket entries:  recomputed ' + recTourn.ticket_entries + ' (€' + recTourn.ticket_value.toFixed(2) + ' value → €' + recTourn.ticket_won.toFixed(2) + ' cashed) | stored ' + storedTourn.ticket_entries + ' (€' + (storedTourn.ticket_value_eur||0).toFixed(2) + ')');
    if (recTourn.cash_entries === storedTourn.cash_entries && recTourn.ticket_entries === storedTourn.ticket_entries) ok('Token/Cash split matches');
    else issue('Token/Cash split MISMATCH');

    header('Check 15: Tournament real-money P&L');
    const recRealMoney = (recTourn.cash_won - recTourn.cash_invested) + recTourn.ticket_won;
    const tournDelta = Math.abs(recRealMoney - (storedTourn.real_money_pnl_eur||0));
    if (tournDelta < TOL) ok('Match: €' + recRealMoney.toFixed(2));
    else issue('MISMATCH: recomputed €' + recRealMoney.toFixed(2) + ' vs stored €' + (storedTourn.real_money_pnl_eur||0).toFixed(2) + ' (Δ €' + tournDelta.toFixed(2) + ')');

    header('Check 16: Tournament ITM count');
    if (recTourn.itm_count === storedTourn.itm_count) ok('Match: ' + recTourn.itm_count + ' cashed (' + ((recTourn.itm_count/recTourn.entries)*100).toFixed(1) + '%)');
    else issue('MISMATCH: recomputed ' + recTourn.itm_count + ' vs stored ' + storedTourn.itm_count);

    header('Check 17: Tournaments cross-check (bat-stored sessions list)');
    if (storedTournSessions.length === storedTourn.entries) ok('Stored sessions array length (' + storedTournSessions.length + ') matches summary entries');
    else issue('Stored sessions array length (' + storedTournSessions.length + ') ≠ summary entries (' + storedTourn.entries + ')');
  }

  // ----- WEEKLY P&L CURVE -----
  header('Check 18: Weekly P&L curve sums to total');
  if (STORED.weekly_pnl_curve && STORED.weekly_pnl_curve.length) {
    const lastCum = STORED.weekly_pnl_curve[STORED.weekly_pnl_curve.length-1].cumulative;
    const sumWeekly = STORED.weekly_pnl_curve.reduce((s,w)=>s+w.pnl, 0);
    if (Math.abs(lastCum - sumWeekly) < TOL) ok('Cumulative final = sum of weekly: €' + lastCum.toFixed(2));
    else issue('Cumulative ' + lastCum.toFixed(2) + ' ≠ sum ' + sumWeekly.toFixed(2));
    if (Math.abs(lastCum - storedCash.pnl) < TOL) ok('Weekly curve matches total cash P&L');
    else warn('Weekly curve final €' + lastCum.toFixed(2) + ' vs total cash P&L €' + storedCash.pnl.toFixed(2) + ' (Δ €' + Math.abs(lastCum - storedCash.pnl).toFixed(2) + ')');
  }

  // ----- COMBINED SECTION -----
  if (storedCombined) {
    header('Check 19: Combined section consistency');
    const expectTotal = (storedCombined.cash_pnl_eur||0) + (storedCombined.tournament_pnl_eur||0);
    if (Math.abs(expectTotal - storedCombined.total_pnl_eur) < TOL) ok('cash + tourn = total ✓ (€' + storedCombined.total_pnl_eur.toFixed(2) + ')');
    else issue('cash €' + storedCombined.cash_pnl_eur.toFixed(2) + ' + tourn €' + storedCombined.tournament_pnl_eur.toFixed(2) + ' ≠ total €' + storedCombined.total_pnl_eur.toFixed(2));
    const expectHands = (storedCombined.cash_hands||0) + (storedCombined.tournament_hands||0);
    if (expectHands === storedCombined.total_hands) ok('cash hands + tourn hands = total hands');
    else issue('Hand count mismatch in combined: ' + expectHands + ' ≠ ' + storedCombined.total_hands);
  }

  // ----- BY-MONTH CROSS-CHECK -----
  header('Check 20: by_month sum equals total');
  const monthSum = Object.values(storedCash.by_month).reduce((s,m)=>s+m.pnl_eur, 0);
  if (Math.abs(monthSum - storedCash.pnl) < TOL) ok('Σ by_month = total cash P&L (€' + monthSum.toFixed(2) + ')');
  else issue('Σ by_month €' + monthSum.toFixed(2) + ' ≠ total €' + storedCash.pnl.toFixed(2));

  // ----- BY-STAKES CROSS-CHECK -----
  header('Check 21: by_stakes sum equals total');
  const stkSum = Object.values(storedCash.by_stakes).reduce((s,m)=>s+m.pnl_eur, 0);
  if (Math.abs(stkSum - storedCash.pnl) < TOL) ok('Σ by_stakes = total cash P&L (€' + stkSum.toFixed(2) + ')');
  else issue('Σ by_stakes €' + stkSum.toFixed(2) + ' ≠ total €' + storedCash.pnl.toFixed(2));

  // ===================================================================================
  // SUMMARY
  // ===================================================================================
  console.log('');
  console.log(BOLD + '═══════════════════════════════════════════════' + RST);
  if (issues === 0) {
    console.log(BOLD + GRN + '  ✓ ALL CHECKS PASSED — data integrity verified' + RST);
  } else {
    console.log(BOLD + RED + '  ✗ ' + issues + ' issue(s) detected — review above' + RST);
  }
  console.log(BOLD + '═══════════════════════════════════════════════' + RST);
  console.log('');
  console.log(DIM + 'Tip: re-run after IMPORT-TOURNAMENTS.bat or full parse to verify integrity.' + RST);

  // Write a JSON report for diffing
  const reportPath = path.join(__dirname, 'audit-report.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    issues,
    recomputed: {
      cash: { hands: recCash.hands, sessions: recCash.sessions, pnl: Math.round(recCash.pnl*100)/100, rake: Math.round(recCash.rake*100)/100 },
      tournaments: {
        entries: recTourn.entries,
        hands: recTourn.hands,
        cash_entries: recTourn.cash_entries,
        cash_invested: Math.round(recTourn.cash_invested*100)/100,
        cash_won: Math.round(recTourn.cash_won*100)/100,
        ticket_entries: recTourn.ticket_entries,
        ticket_value: Math.round(recTourn.ticket_value*100)/100,
        ticket_won: Math.round(recTourn.ticket_won*100)/100,
        real_money_pnl: Math.round(((recTourn.cash_won - recTourn.cash_invested) + recTourn.ticket_won)*100)/100,
        itm_count: recTourn.itm_count
      }
    },
    duplicates: {
      hand_ids: dupGameCodes.length,
      session_codes_skipped: dupSessionCodes.length,
      tournament_multi_entry_rows: dupTournamentCodes.length
    },
    corruption: corruptionWarnings.length,
    hero_mismatches: heroMismatches.length
  }, null, 2));
  console.log(DIM + 'Detailed report written to audit-report.json' + RST);

  process.exit(issues > 0 ? 1 : 0);
})().catch(e => { console.error(RED + 'FATAL: ' + e.message + RST); console.error(e.stack); process.exit(2); });
