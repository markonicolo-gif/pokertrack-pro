/**
 * Parse Novibet/Winamax XML hand history ZIPs → sessions JSON
 * Usage: node parse-hands.js
 * Output: data/sessions.json
 */
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { DOMParser } = require('xmldom');

const DATA_DIR = path.join(__dirname, 'data');
const OUT_FILE = path.join(DATA_DIR, 'sessions.json');

const parseAmt = (s) => parseFloat((s || '0').replace(/[^0-9.\-]/g, '')) || 0;

function parseDateTime(s) {
  const m = s && s.match(/(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(`${m[3]}-${m[1]}-${m[2]}T${m[4]}:${m[5]}:${m[6]}`);
}

async function parseXMLSession(text) {
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  const gen = doc.getElementsByTagName('general')[0];
  if (!gen) return null;

  const get = (tag) => {
    const els = gen.getElementsByTagName(tag);
    return els.length > 0 ? (els[0].textContent || '').trim() : '';
  };

  const nickname  = get('nickname');
  const gametype  = get('gametype');
  const startStr  = get('startdate');
  const bets      = parseAmt(get('bets'));
  const wins      = parseAmt(get('wins'));
  const tablesize = get('tablesize');
  const currency  = get('currency');

  const dm = startStr.match(/(\d{2})-(\d{2})-(\d{4})/);
  const date = dm ? `${dm[3]}-${dm[1]}-${dm[2]}` : '';
  if (!date) return null;

  const stakeMatch = gametype.match(/[€$£]?([\d.]+)\/[€$£]?([\d.]+)/);
  const stakes = stakeMatch ? `${stakeMatch[1]}/${stakeMatch[2]}` : '';

  let gameType = gametype;
  const gt = gametype.toLowerCase();
  if (gt.includes('omaha') && gt.includes('hi')) gameType = 'PLO Hi/Lo';
  else if (gt.includes('omaha')) gameType = 'PLO';
  else if (gt.includes('hold')) gameType = "NL Hold'em";
  else if (gt.includes('stud')) gameType = 'Stud';

  const games = doc.getElementsByTagName('game');
  let buyIn = 0;
  if (games.length > 0 && nickname) {
    const players = games[0].getElementsByTagName('player');
    for (let i = 0; i < players.length; i++) {
      if (players[i].getAttribute('name') === nickname) {
        buyIn = parseAmt(players[i].getAttribute('chips') || '0');
        break;
      }
    }
  }
  if (!buyIn) buyIn = bets;

  // cashOut = buyIn + session P&L (no clipping — preserves authoritative P&L)
  const cashOut = Math.round((buyIn + (wins - bets)) * 100) / 100;
  buyIn = Math.round(buyIn * 100) / 100;

  let duration = 0;
  if (games.length > 1) {
    const lastGame = games[games.length - 1];
    const lastGenEls = lastGame.getElementsByTagName('startdate');
    const lastStart = lastGenEls.length > 0 ? (lastGenEls[0].textContent || '').trim() : '';
    const t1 = parseDateTime(startStr);
    const t2 = parseDateTime(lastStart);
    if (t1 && t2 && t2 > t1) {
      duration = Math.max(0.25, Math.round(((t2 - t1) / 3600000 + 0.1) * 4) / 4);
    }
  }
  if (!duration) duration = Math.max(0.25, Math.round(games.length / 30 * 4) / 4);

  let totalRake = 0, showdownWin = 0, nonShowdownWin = 0;
  // Session-level P&L is authoritative (no uncalled-bet accounting errors)
  const sessionPnL = Math.round((wins - bets) * 100) / 100;

  if (nickname) {
    let sdHandCount = 0, nsdHandCount = 0;
    let sdPotWeight = 0, nsdPotWeight = 0;

    for (let g = 0; g < games.length; g++) {
      const players = games[g].getElementsByTagName('player');
      let p = null;
      for (let i = 0; i < players.length; i++) {
        if (players[i].getAttribute('name') === nickname) { p = players[i]; break; }
      }
      if (!p) continue;
      totalRake += parseAmt(p.getAttribute('rakeamount') || '0');

      const playerBet = parseAmt(p.getAttribute('bet') || '0');

      // iPoker XML showdown detection: muck="0" means the player showed cards.
      // A hand went to showdown if 2+ players have muck="0".
      let muckZeroCount = 0;
      for (let i = 0; i < players.length; i++) {
        if (players[i].getAttribute('muck') === '0') muckZeroCount++;
      }
      const hasShowdown = muckZeroCount >= 2;

      // Weight by how much money the player put in this hand (their action size).
      // This gives a fair split: big pots count more than min-bet folds.
      const weight = Math.max(playerBet, 0.01); // small floor so even checked hands count
      if (hasShowdown) { sdHandCount++; sdPotWeight += weight; }
      else { nsdHandCount++; nsdPotWeight += weight; }
    }

    // Split session P&L proportionally by pot-weighted action
    const totalWeight = sdPotWeight + nsdPotWeight;
    if (totalWeight > 0) {
      showdownWin = Math.round(sessionPnL * (sdPotWeight / totalWeight) * 100) / 100;
      nonShowdownWin = Math.round((sessionPnL - showdownWin) * 100) / 100;
    } else {
      nonShowdownWin = sessionPnL;
    }
  }
  totalRake = Math.round(totalRake * 100) / 100;

  return {
    id: require('crypto').randomUUID(),
    date,
    location: 'Online',
    gameType,
    stakes,
    buyIn,
    cashOut,
    duration,
    tableSize: tablesize,
    tags: 'Online',
    mood: 3,
    rake: totalRake,
    hands: games.length,
    showdownWin,
    nonShowdownWin,
    notes: `${games.length} hands · ${currency} · rake €${totalRake}`,
  };
}

async function main() {
  const zipFiles = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.zip'));
  console.log(`Found ${zipFiles.length} ZIP files in data/`);

  const allSessions = [];

  for (const zipFile of zipFiles) {
    const zipPath = path.join(DATA_DIR, zipFile);
    console.log(`\nParsing: ${zipFile}`);
    const buf = fs.readFileSync(zipPath);
    const zip = await JSZip.loadAsync(buf);

    const entries = Object.values(zip.files).filter(f => !f.dir && f.name.endsWith('.xml'));
    console.log(`  ${entries.length} XML files`);

    let parsed = 0, skipped = 0;
    for (const entry of entries) {
      try {
        const text = await entry.async('string');
        const session = await parseXMLSession(text);
        if (session) { allSessions.push(session); parsed++; }
        else skipped++;
      } catch (e) { skipped++; }
    }
    console.log(`  ✓ ${parsed} sessions parsed, ${skipped} skipped`);
  }

  // Sort by date
  allSessions.sort((a, b) => a.date.localeCompare(b.date));

  fs.writeFileSync(OUT_FILE, JSON.stringify(allSessions, null, 2));
  console.log(`\n✅ Total: ${allSessions.length} sessions saved to data/sessions.json`);
}

main().catch(console.error);
