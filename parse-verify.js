/**
 * Verification tool for parse-hands.js
 *
 * Goals:
 *  1. Pick N random hands across all ZIPs
 *  2. Show parser's decision trace for each (hero action, opp reveals, SD/NSD)
 *  3. Print the raw <round>/<cards> XML so you can eyeball-check
 *  4. Run invariant checks across the full sessions.json
 *
 * Usage: node parse-verify.js [N]    (default N=15)
 */
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { DOMParser } = require('xmldom');

const DATA_DIR = path.join(__dirname, 'data');
const N = parseInt(process.argv[2] || '15', 10);

const parseAmt = (s) => parseFloat((s || '0').replace(/[^0-9.\-]/g, '')) || 0;

// Action type mapping (from thlorenz/hhp-xml authoritative source):
// 0=fold 1=sb 2=bb 3=call 4=check 5=bet 6,7=allin 8,9=sitout 15=ante 23=raise
const ACTION_NAMES = {
  '0':'FOLD','1':'sb','2':'bb','3':'call','4':'check','5':'bet',
  '6':'allin','7':'allin','8':'sitout','9':'sitout','15':'ante','23':'raise'
};
const ROUND_NAMES = { '0':'posts','1':'preflop','2':'flop','3':'turn','4':'river' };

function analyseHand(game, hero) {
  // Find hero's per-hand aggregate
  const players = game.getElementsByTagName('player');
  let heroP = null;
  for (let i = 0; i < players.length; i++) {
    if (players[i].getAttribute('name') === hero) { heroP = players[i]; break; }
  }
  const win = heroP ? parseAmt(heroP.getAttribute('win') || '0') : 0;
  const bet = heroP ? parseAmt(heroP.getAttribute('bet') || '0') : 0;
  const net = Math.round((win - bet) * 100) / 100;

  // Scan actions: did hero fold? When?
  let heroFolded = false, heroFoldRound = null;
  const rounds = game.getElementsByTagName('round');
  const heroActionsPerRound = {};
  for (let r = 0; r < rounds.length; r++) {
    const roundNo = rounds[r].getAttribute('no');
    const acts = rounds[r].getElementsByTagName('action');
    for (let a = 0; a < acts.length; a++) {
      const player = acts[a].getAttribute('player');
      const type = acts[a].getAttribute('type');
      if (player === hero) {
        if (!heroActionsPerRound[roundNo]) heroActionsPerRound[roundNo] = [];
        heroActionsPerRound[roundNo].push(ACTION_NAMES[type] || `?${type}`);
        if (type === '0' && !heroFolded) {
          heroFolded = true;
          heroFoldRound = ROUND_NAMES[roundNo] || roundNo;
        }
      }
    }
  }

  // Count opponent pocket reveals (real cards, not "X X X X")
  const cardsEls = game.getElementsByTagName('cards');
  const reveals = [];
  let heroPocket = null;
  for (let c = 0; c < cardsEls.length; c++) {
    if (cardsEls[c].getAttribute('type') !== 'Pocket') continue;
    const owner = cardsEls[c].getAttribute('player');
    const txt = (cardsEls[c].textContent || '').trim();
    if (owner === hero) { heroPocket = txt; continue; }
    if (txt && !txt.startsWith('X')) reveals.push({ player: owner, cards: txt });
  }

  const hasShowdown = reveals.length >= 1 && !heroFolded;
  return {
    win, bet, net,
    heroFolded, heroFoldRound,
    heroActionsPerRound,
    heroPocket,
    oppReveals: reveals,
    classification: hasShowdown ? 'SD' : 'NSD',
  };
}

async function main() {
  const zipFiles = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.zip'));
  console.log(`\n━━━ PARSER VERIFICATION ━━━`);
  console.log(`Picking ${N} random hands across ${zipFiles.length} ZIPs...\n`);

  // Collect all XML entries
  const allEntries = [];
  for (const zipFile of zipFiles) {
    const zip = await JSZip.loadAsync(fs.readFileSync(path.join(DATA_DIR, zipFile)));
    for (const entry of Object.values(zip.files)) {
      if (!entry.dir && entry.name.endsWith('.xml')) {
        allEntries.push({ zipFile, entry });
      }
    }
  }
  console.log(`Total XML sessions available: ${allEntries.length}`);

  // Pick N random sessions, then 1 random hand from each
  const picks = [];
  const used = new Set();
  while (picks.length < N && used.size < allEntries.length) {
    const idx = Math.floor(Math.random() * allEntries.length);
    if (used.has(idx)) continue;
    used.add(idx);
    const { zipFile, entry } = allEntries[idx];
    const text = await entry.async('string');
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    const gen = doc.getElementsByTagName('general')[0];
    if (!gen) continue;
    const hero = (gen.getElementsByTagName('nickname')[0] || {}).textContent?.trim() || '';
    const games = doc.getElementsByTagName('game');
    if (!games.length) continue;
    const g = games[Math.floor(Math.random() * games.length)];
    picks.push({ zipFile, file: entry.name, hero, game: g, gameCode: g.getAttribute('gamecode') });
  }

  let sdCount = 0, nsdCount = 0, sdNet = 0, nsdNet = 0;
  let foldedNSD = 0, foldedSD = 0;

  for (let i = 0; i < picks.length; i++) {
    const p = picks[i];
    const r = analyseHand(p.game, p.hero);
    console.log(`\n─── Hand ${i+1}/${N} ─── ${p.zipFile} :: ${path.basename(p.file)} :: game ${p.gameCode}`);
    console.log(`  Hero: ${p.hero}   net: €${r.net.toFixed(2)}  (win €${r.win} − bet €${r.bet})`);
    console.log(`  Hero pocket: ${r.heroPocket || '(none)'}`);
    const actStr = Object.entries(r.heroActionsPerRound)
      .map(([rn, acts]) => `${ROUND_NAMES[rn]}[${acts.join(',')}]`).join(' → ') || '(no actions)';
    console.log(`  Hero actions: ${actStr}`);
    console.log(`  Hero folded? ${r.heroFolded ? `YES on ${r.heroFoldRound}` : 'no'}`);
    console.log(`  Opponent pocket reveals: ${r.oppReveals.length}`);
    r.oppReveals.forEach(o => console.log(`     └─ ${o.player}: ${o.cards}`));
    console.log(`  → Classified as: ${r.classification}  (hero ${r.heroFolded?'folded':'stayed'} & ${r.oppReveals.length} opp reveal${r.oppReveals.length!==1?'s':''})`);

    if (r.classification === 'SD') { sdCount++; sdNet += r.net; }
    else { nsdCount++; nsdNet += r.net; if (r.heroFolded) foldedNSD++; }
    if (r.heroFolded && r.classification === 'SD') foldedSD++;
  }

  console.log(`\n━━━ SAMPLE AGGREGATE ━━━`);
  console.log(`  SD hands:  ${sdCount}  net €${sdNet.toFixed(2)}  (avg €${(sdNet/(sdCount||1)).toFixed(2)})`);
  console.log(`  NSD hands: ${nsdCount}  net €${nsdNet.toFixed(2)}  (avg €${(nsdNet/(nsdCount||1)).toFixed(2)})`);
  console.log(`  Hero-folded hands that ended in NSD: ${foldedNSD}  ← should equal (all fold-hands in sample)`);
  console.log(`  Hero-folded hands that ended in SD:  ${foldedSD}  ← MUST be 0 (hero can't showdown if folded)`);

  // ━━━ Full-dataset invariant checks ━━━
  console.log(`\n━━━ FULL-DATASET INVARIANTS (from sessions.json) ━━━`);
  const sessions = require('./data/sessions.json');
  let totalPnL = 0, totalSD = 0, totalNSD = 0, totalRake = 0, totalHands = 0;
  let badRake = 0, badPnL = 0, badHands = 0;
  for (const s of sessions) {
    const pnl = Math.round((s.cashOut - s.buyIn) * 100) / 100;
    const sdnsd = Math.round((s.showdownWin + s.nonShowdownWin) * 100) / 100;
    totalPnL += pnl;
    totalSD += s.showdownWin;
    totalNSD += s.nonShowdownWin;
    totalRake += s.rake;
    totalHands += s.hands;
    if (s.rake < 0) badRake++;
    if (Math.abs(pnl - sdnsd) > 0.05) badPnL++;
    if (s.hands <= 0) badHands++;
  }
  console.log(`  Sessions: ${sessions.length}`);
  console.log(`  Total hands: ${totalHands.toLocaleString()}`);
  console.log(`  Total P&L: €${totalPnL.toFixed(2)}`);
  console.log(`  Total SD:  €${totalSD.toFixed(2)}`);
  console.log(`  Total NSD: €${totalNSD.toFixed(2)}`);
  console.log(`  SD + NSD:  €${(totalSD+totalNSD).toFixed(2)}   ${Math.abs((totalSD+totalNSD)-totalPnL) < 1 ? '✓ matches P&L' : '✗ MISMATCH'}`);
  console.log(`  Total rake: €${totalRake.toFixed(2)}`);
  console.log(`  Invariant checks:`);
  console.log(`    Sessions with negative rake:     ${badRake}  ${badRake===0?'✓':'✗'}`);
  console.log(`    Sessions where SD+NSD ≠ P&L:     ${badPnL}   ${badPnL===0?'✓':'✗'}`);
  console.log(`    Sessions with 0 or negative hands: ${badHands}  ${badHands===0?'✓':'✗'}`);

  console.log(`\n━━━ HOW TO VERIFY ━━━`);
  console.log(`1. Pick any hand above, open the XML file listed, find <game gamecode="...">`);
  console.log(`2. Look at its <round no="..."> blocks. Check:`);
  console.log(`     - Does hero (${picks[0]?.hero || '…'}) have a <action type="0"> (fold)? → that's a fold`);
  console.log(`     - Are there opponent <cards type="Pocket">REAL_CARDS</cards>? → that's a reveal`);
  console.log(`3. Parser rule: classified as SD iff (hero did NOT fold) AND (≥1 opponent revealed pocket)`);
  console.log(`4. Gold standard: import same XMLs into PokerTracker 4 → compare its SD/NSD totals\n`);
}

main().catch(console.error);
