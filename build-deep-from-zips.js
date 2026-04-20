/**
 * build-deep-from-zips.js
 * Parses ALL hand history zips in data/ and rebuilds data/platinex_dashboard_complete.json
 * with VPIP, PFR, postflop stats, opponents, hand quality, etc. across every hand.
 *
 * Usage: node build-deep-from-zips.js
 */
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { DOMParser } = require('xmldom');

const DATA_DIR = path.join(__dirname, 'data');
const HERO = 'platinex';

// iPoker action types (from inspection):
// 0 = fold
// 1 = small blind (post)
// 2 = big blind (post) / call
// 3 = call / raise / bet
// 4 = check
// 5 = bet / raise
// 6 = all-in
// 7 = ante post
// 8 = sit out
// 9 = bet (big bet)
// 15 = re-raise
// We'll use: type 0 = fold; type 4 = check; types 3/5/9/15 = bet/raise; type 2 (round>0) = call

const parseAmt = (s) => parseFloat((s || '0').replace(/[^0-9.\-]/g, '')) || 0;

function det(els, tag) { const e = els.getElementsByTagName(tag); return e.length ? (e[0].textContent || '').trim() : ''; }

// Aggregators (cash + tournament use same shape so parseHand works for both)
function makeAcc() {
  return {
  total_hands: 0,
  total_sessions: 0,
  total_pnl: 0,
  total_rake: 0,
  hand_dates: [],
  by_month: {},          // YYYY-MM -> { hands, pnl, sessions }
  by_stakes: {},         // stakes -> { hands, pnl, sessions }
  by_dow: { Monday:{p:0,h:0,s:0}, Tuesday:{p:0,h:0,s:0}, Wednesday:{p:0,h:0,s:0}, Thursday:{p:0,h:0,s:0}, Friday:{p:0,h:0,s:0}, Saturday:{p:0,h:0,s:0}, Sunday:{p:0,h:0,s:0} },
  by_hour: {},           // 0-23 -> { p, h, s }

  // Preflop by position
  pre: {
    BTN:{hands:0,vpip:0,pfr:0,limp:0,three_bet:0,three_bet_opp:0,cold_call:0,cold_call_opp:0,fold_vs_raise:0,fold_vs_raise_opp:0,fold_to_3bet:0,fold_to_3bet_opp:0,call_3bet:0,four_bet:0,iso_raise:0,iso_opp:0,overlimp:0,overlimp_opp:0,squeeze:0,squeeze_opp:0,rfi:0,rfi_opp:0,open_sizes:[]},
    CO:{hands:0,vpip:0,pfr:0,limp:0,three_bet:0,three_bet_opp:0,cold_call:0,cold_call_opp:0,fold_vs_raise:0,fold_vs_raise_opp:0,fold_to_3bet:0,fold_to_3bet_opp:0,call_3bet:0,four_bet:0,iso_raise:0,iso_opp:0,overlimp:0,overlimp_opp:0,squeeze:0,squeeze_opp:0,rfi:0,rfi_opp:0,open_sizes:[]},
    HJ:{hands:0,vpip:0,pfr:0,limp:0,three_bet:0,three_bet_opp:0,cold_call:0,cold_call_opp:0,fold_vs_raise:0,fold_vs_raise_opp:0,fold_to_3bet:0,fold_to_3bet_opp:0,call_3bet:0,four_bet:0,iso_raise:0,iso_opp:0,overlimp:0,overlimp_opp:0,squeeze:0,squeeze_opp:0,rfi:0,rfi_opp:0,open_sizes:[]},
    UTG:{hands:0,vpip:0,pfr:0,limp:0,three_bet:0,three_bet_opp:0,cold_call:0,cold_call_opp:0,fold_vs_raise:0,fold_vs_raise_opp:0,fold_to_3bet:0,fold_to_3bet_opp:0,call_3bet:0,four_bet:0,iso_raise:0,iso_opp:0,overlimp:0,overlimp_opp:0,squeeze:0,squeeze_opp:0,rfi:0,rfi_opp:0,open_sizes:[]},
    SB:{hands:0,vpip:0,pfr:0,limp:0,three_bet:0,three_bet_opp:0,cold_call:0,cold_call_opp:0,fold_vs_raise:0,fold_vs_raise_opp:0,fold_to_3bet:0,fold_to_3bet_opp:0,call_3bet:0,four_bet:0,iso_raise:0,iso_opp:0,overlimp:0,overlimp_opp:0,squeeze:0,squeeze_opp:0,rfi:0,rfi_opp:0,open_sizes:[]},
    BB:{hands:0,vpip:0,pfr:0,limp:0,three_bet:0,three_bet_opp:0,cold_call:0,cold_call_opp:0,fold_vs_raise:0,fold_vs_raise_opp:0,fold_to_3bet:0,fold_to_3bet_opp:0,call_3bet:0,four_bet:0,iso_raise:0,iso_opp:0,overlimp:0,overlimp_opp:0,squeeze:0,squeeze_opp:0,rfi:0,rfi_opp:0,open_sizes:[]}
  },
  limp_pnl_bb: 0, limp_count: 0,

  // Postflop overall
  post: {
    flop:  { saw:0, bets:0, raises:0, calls:0, folds:0, checks:0, cbet:0, cbet_opp:0, cbet_ip:0, cbet_opp_ip:0, cbet_oop:0, cbet_opp_oop:0, fold_to_cbet:0, fold_to_cbet_opp:0, xr:0, xr_opp:0, xc:0, xf:0, donk:0, donk_opp:0, probe:0, probe_opp:0, wtsd:0, wsd:0 },
    turn:  { saw:0, bets:0, raises:0, calls:0, folds:0, checks:0, cbet:0, cbet_opp:0, fold_to_bet:0, faced_bet:0, xr:0, xr_opp:0, call_bet:0, raise_bet:0, probe:0, probe_opp:0 },
    river: { saw:0, bets:0, raises:0, calls:0, folds:0, checks:0, fold_to_bet:0, faced_bet:0, call_bet:0, raise_bet:0, bet_first:0 }
  },
  post_by_pos: {},  // pos -> { saw_flop, saw_turn, saw_river, cbet, cbet_opp, fold_to_cbet, fold_to_cbet_opp, wtsd, wsd }

  // Opponents
  opps: {},  // name -> { hands, vpip, pfr, three_bet, three_bet_opp, vpip_opp, pfr_opp, af_b_r, af_c, cbet, cbet_opp, wtsd, wtsd_opp, hero_pnl }

  // Hand quality (PLO classification of hero's pocket)
  hq: {
    premium:           { dealt:0, played:0, total_pnl_bb:0 },
    ds_rundown:        { dealt:0, played:0, total_pnl_bb:0 },
    strong_ace:        { dealt:0, played:0, total_pnl_bb:0 },
    high_pair:         { dealt:0, played:0, total_pnl_bb:0 },
    high_cards:        { dealt:0, played:0, total_pnl_bb:0 },
    suited_connected:  { dealt:0, played:0, total_pnl_bb:0 },
    suited_only:       { dealt:0, played:0, total_pnl_bb:0 },
    connected_rainbow: { dealt:0, played:0, total_pnl_bb:0 },
    trash:             { dealt:0, played:0, total_pnl_bb:0 }
  },

  // Sessions
  sessions: [],
  weekly: {},   // monday-week -> { hands, pnl }
  multitabling: { '1_table':{p:0,h:0,s:0}, '2_3_tables':{p:0,h:0,s:0}, '4_plus_tables':{p:0,h:0,s:0} }
  };
}

const agg = makeAcc();   // cash games (PLO)
const tagg = makeAcc();  // tournaments (Holdem NL MTT/SnG)
// Tournament-specific session-level data (one entry per tournament session)
const tournamentSessions = []; // { code, name, format, buyin, fee, totalbuyin, win, place, gamecount, rebuys, totalrebuycost, addon, totaladdoncost, tablesize, date, dow, hour, ym, currency, net, invested }

// === Position assignment based on dealer seat ===
function assignPositions(playersList, dealerSeat) {
  // playersList: [{name, seat, ...}], sorted by seat
  // Find dealer index, then assign clockwise
  const seats = playersList.map(p => p.seat).sort((a,b) => a-b);
  const dealerIdx = seats.indexOf(dealerSeat);
  if (dealerIdx === -1) return {};
  const n = seats.length;
  // Order from dealer: BTN, SB, BB, UTG, MP/HJ, CO (then back to BTN)
  // For 6-handed: BTN, SB, BB, UTG, HJ, CO
  // For 5-handed: BTN, SB, BB, UTG, CO (no HJ)
  // For 4-handed: BTN, SB, BB, UTG (or BTN, SB, BB, CO)
  // For 3-handed: BTN, SB, BB
  // For 2-handed (HU): BTN/SB, BB
  let posNames;
  if (n === 6) posNames = ['BTN','SB','BB','UTG','HJ','CO'];
  else if (n === 5) posNames = ['BTN','SB','BB','UTG','CO'];
  else if (n === 4) posNames = ['BTN','SB','BB','UTG'];
  else if (n === 3) posNames = ['BTN','SB','BB'];
  else if (n === 2) posNames = ['BTN','BB']; // BTN is also SB heads-up
  else return {};

  const seatToPos = {};
  for (let i = 0; i < n; i++) {
    const seatIdx = (dealerIdx + i) % n;
    seatToPos[seats[seatIdx]] = posNames[i];
  }
  return seatToPos;
}

// === PLO hand classifier (for hero's 4 cards) ===
// Cards format like "DA SK H10 C7" — suit prefix (S/H/D/C) + rank (2-9, T/10, J, Q, K, A)
function parseCard(c) {
  if (!c) return null;
  const m = c.match(/^([SHDC])(.+)$/);
  if (!m) return null;
  const r = m[2] === '10' ? 'T' : m[2];
  return { suit: m[1], rank: r };
}
const RANK_VAL = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'T':10,'J':11,'Q':12,'K':13,'A':14 };

function classifyPLO(cardsStr) {
  if (!cardsStr || cardsStr.startsWith('X')) return null;
  const parts = cardsStr.split(/\s+/).map(parseCard).filter(Boolean);
  if (parts.length !== 4) return null;
  const ranks = parts.map(c => RANK_VAL[c.rank]).sort((a,b) => b-a); // desc
  const suits = parts.map(c => c.suit);
  const suitCounts = {}; suits.forEach(s => suitCounts[s] = (suitCounts[s]||0)+1);
  const suitVals = Object.values(suitCounts).sort((a,b) => b-a);
  const isDoubleSuited = suitVals[0] === 2 && suitVals[1] === 2;
  const isSingleSuited = suitVals[0] === 2 && suitVals[1] !== 2;
  const isRainbow = suitVals[0] === 1;
  // Pairs
  const rankCounts = {}; ranks.forEach(r => rankCounts[r] = (rankCounts[r]||0)+1);
  const pairs = Object.entries(rankCounts).filter(([_,n]) => n >= 2).map(([r]) => parseInt(r)).sort((a,b) => b-a);
  const hasAA = pairs[0] === 14;
  const hasKK = pairs[0] === 13 || (pairs[0] === 14 && pairs[1] === 13);
  // Connectivity
  const uniqRanks = [...new Set(ranks)].sort((a,b) => b-a);
  let maxGap = 0, totalGap = 0;
  for (let i = 0; i < uniqRanks.length-1; i++) { const g = uniqRanks[i] - uniqRanks[i+1]; if (g > maxGap) maxGap = g; totalGap += g; }
  const span = uniqRanks[0] - uniqRanks[uniqRanks.length-1];
  const isConnected = uniqRanks.length >= 4 && span <= 4 && maxGap <= 2;
  const isRundown = uniqRanks.length === 4 && span <= 3;

  // Premium: AAxx, KKxx (especially DS), AKQJ-type, top hands
  if (hasAA && (isDoubleSuited || (isSingleSuited && uniqRanks.length === 4 && span <= 4))) return 'premium';
  if (hasAA) return 'premium';
  if (hasKK && (isDoubleSuited || isSingleSuited)) return 'premium';
  if (uniqRanks[0] >= 13 && isRundown && (isDoubleSuited || isSingleSuited)) return 'premium';
  // Double-suited rundown
  if (isDoubleSuited && isRundown && uniqRanks[0] >= 9) return 'ds_rundown';
  if (isDoubleSuited && isConnected) return 'ds_rundown';
  // Strong ace: A with suit + connectivity (not pair)
  if (uniqRanks[0] === 14 && (isDoubleSuited || isSingleSuited) && isConnected) return 'strong_ace';
  if (uniqRanks[0] === 14 && isSingleSuited && uniqRanks.length === 4) return 'strong_ace';
  // High pair: any QQ+ or JJ
  if (pairs.length && pairs[0] >= 11) return 'high_pair';
  // High cards (broadway combos no good connectivity)
  if (uniqRanks.filter(r => r >= 10).length >= 3) return 'high_cards';
  // Suited connected
  if (isSingleSuited && isConnected) return 'suited_connected';
  // Suited only (single suited, no connectivity)
  if (isSingleSuited) return 'suited_only';
  // Connected rainbow
  if (isRainbow && isConnected) return 'connected_rainbow';
  // Trash
  return 'trash';
}

// === Parse one session XML ===
const seenSessionCodes = new Set();
async function parseSession(text) {
  const doc = new DOMParser({ errorHandler: { warning:()=>{}, error:()=>{}, fatalError:()=>{} } }).parseFromString(text, 'text/xml');
  const sessEl = doc.getElementsByTagName('session')[0];
  if (!sessEl) return;
  const sessionCode = sessEl.getAttribute('sessioncode');
  if (sessionCode) {
    if (seenSessionCodes.has(sessionCode)) return; // dedupe — same session in multiple zips
    seenSessionCodes.add(sessionCode);
  }
  const gen = doc.getElementsByTagName('general')[0];
  if (!gen) return;
  const nickname = det(gen, 'nickname');
  if (nickname !== HERO) return; // safety
  const gametype = det(gen, 'gametype');
  const startStr = det(gen, 'startdate');
  const tournamentCode = det(gen, 'tournamentcode');
  const isTournament = tournamentCode !== '';

  const dm = startStr.match(/(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})/);
  if (!dm) return;
  const date = new Date(`${dm[3]}-${dm[1]}-${dm[2]}T${dm[4]}:${dm[5]}:00`);
  if (isNaN(date)) return;
  const ym = `${dm[3]}-${dm[1]}`;
  const dow = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][date.getDay()];
  const hour = date.getHours();
  const games = doc.getElementsByTagName('game');
  const tablesize = parseInt(det(gen, 'tablesize')) || 6;

  if (isTournament) {
    // === TOURNAMENT SESSION ===
    const tName = det(gen, 'tournamentname') || det(gen, 'tablename') || 'Unknown';
    const totalBuyinStr = det(gen, 'totalbuyin');
    const totalBuyin = parseAmt(totalBuyinStr);
    // rebuy cost (e.g. "€9.10 + €0.90"), totalrebuycost is the unit cost per rebuy
    const totalRebuyCost = parseAmt(det(gen, 'totalrebuycost'));
    const totalAddonCost = parseAmt(det(gen, 'totaladdoncost'));
    const rebuys = parseInt(det(gen, 'rebuys')) || 0;
    const addon = parseInt(det(gen, 'addon')) || 0;
    const winAmt = parseAmt(det(gen, 'win'));
    const place = parseInt(det(gen, 'place')) || 0;
    const gamecount = parseInt(det(gen, 'gamecount')) || games.length;
    const currency = det(gen, 'tournamentcurrency') || det(gen, 'currency') || 'EUR';
    const invested = totalBuyin + (rebuys * totalRebuyCost) + (addon * totalAddonCost);
    const net = winAmt - invested;

    // Format classification from tournament name + table size
    let format;
    if (/twister|spin/i.test(tName)) format = 'Spin/Twister';
    else if (/double\s*or\s*nothing|\bdon\b/i.test(tName)) format = 'DoN';
    else if (/\bsat\b|satellite|step\s*sat/i.test(tName)) format = 'Satellite';
    else if (/sit\s*[&n]\s*go|\bsng\b|s&g/i.test(tName)) format = 'SnG';
    else if (tablesize <= 10 && !/gtd|guaranteed/i.test(tName)) format = 'SnG';
    else format = 'MTT';

    tournamentSessions.push({
      code: tournamentCode, name: tName, format,
      totalBuyin, rebuys, totalRebuyCost, addon, totalAddonCost,
      win: winAmt, place, gamecount, tablesize, date: startStr,
      dow, hour, ym, currency, invested, net,
      itm: winAmt > 0
    });

    // Tournament hand stats: bbSize is unknown for tournaments (chip stacks vary)
    // Use 1 as baseline; bb/100 for tournaments isn't meaningful so we won't use it
    tagg.total_sessions++;
    tagg.total_pnl += net;            // tournament net (cashes - cost)
    tagg.total_hands += games.length;
    tagg.hand_dates.push(date);
    tagg.sessions.push({ pnl: Math.round(net*100)/100, hands: games.length, date: startStr, stakes: format, dow, hour, tablesize });
    tagg.by_month[ym] = tagg.by_month[ym] || { hands:0, pnl:0, sessions:0 };
    tagg.by_month[ym].hands += games.length; tagg.by_month[ym].pnl += net; tagg.by_month[ym].sessions++;
    tagg.by_stakes[format] = tagg.by_stakes[format] || { hands:0, pnl:0, sessions:0 };
    tagg.by_stakes[format].hands += games.length; tagg.by_stakes[format].pnl += net; tagg.by_stakes[format].sessions++;
    tagg.by_dow[dow].p += net; tagg.by_dow[dow].h += games.length; tagg.by_dow[dow].s++;
    tagg.by_hour[hour] = tagg.by_hour[hour] || { p:0, h:0, s:0 };
    tagg.by_hour[hour].p += net; tagg.by_hour[hour].h += games.length; tagg.by_hour[hour].s++;
    const tWeekStart = new Date(date); const tDay = tWeekStart.getDay(); const tDiff = tDay === 0 ? -6 : 1 - tDay; tWeekStart.setDate(tWeekStart.getDate() + tDiff);
    const tWkKey = tWeekStart.toISOString().slice(0,10);
    tagg.weekly[tWkKey] = tagg.weekly[tWkKey] || { hands:0, pnl:0 };
    tagg.weekly[tWkKey].hands += games.length; tagg.weekly[tWkKey].pnl += net;

    // Hand-level analytics with bbSize=1 (tournament chips, classifyPLO will skip Holdem cards)
    for (let g = 0; g < games.length; g++) {
      parseHand(games[g], 1, tagg);
    }
    return;
  }

  // === CASH SESSION === (PLO only — gametype like "Omaha PL €0.50/€1")
  const sBets = parseAmt(det(gen, 'bets'));
  const sWins = parseAmt(det(gen, 'wins'));

  const stakeMatch = gametype.match(/[€$£]?([\d.]+)\/[€$£]?([\d.]+)/);
  const bbSize = stakeMatch ? parseFloat(stakeMatch[2]) : 1;
  const stakesKey = gametype;

  const sessionPnl = sWins - sBets;

  // Aggregate session-level
  agg.total_sessions++;
  agg.total_pnl += sessionPnl;
  agg.total_hands += games.length;
  agg.hand_dates.push(date);
  agg.sessions.push({ pnl: Math.round(sessionPnl*100)/100, hands: games.length, date: startStr, stakes: stakesKey, dow, hour, tablesize });
  agg.by_month[ym] = agg.by_month[ym] || { hands:0, pnl:0, sessions:0 };
  agg.by_month[ym].hands += games.length; agg.by_month[ym].pnl += sessionPnl; agg.by_month[ym].sessions++;
  agg.by_stakes[stakesKey] = agg.by_stakes[stakesKey] || { hands:0, pnl:0, sessions:0 };
  agg.by_stakes[stakesKey].hands += games.length; agg.by_stakes[stakesKey].pnl += sessionPnl; agg.by_stakes[stakesKey].sessions++;
  agg.by_dow[dow].p += sessionPnl; agg.by_dow[dow].h += games.length; agg.by_dow[dow].s++;
  agg.by_hour[hour] = agg.by_hour[hour] || { p:0, h:0, s:0 };
  agg.by_hour[hour].p += sessionPnl; agg.by_hour[hour].h += games.length; agg.by_hour[hour].s++;

  // Weekly bucket (Monday)
  const weekStart = new Date(date); const day = weekStart.getDay(); const diff = day === 0 ? -6 : 1 - day; weekStart.setDate(weekStart.getDate() + diff);
  const wkKey = weekStart.toISOString().slice(0,10);
  agg.weekly[wkKey] = agg.weekly[wkKey] || { hands:0, pnl:0 };
  agg.weekly[wkKey].hands += games.length; agg.weekly[wkKey].pnl += sessionPnl;

  // Per-hand parsing
  for (let g = 0; g < games.length; g++) {
    parseHand(games[g], bbSize, agg);
  }
}

function parseHand(gameEl, bbSize, agg) {
  // Extract players & dealer
  const playersEls = gameEl.getElementsByTagName('player');
  const playersList = [];
  let dealerSeat = -1;
  let heroNet = 0, heroRake = 0;
  for (let i = 0; i < playersEls.length; i++) {
    const p = playersEls[i];
    const name = p.getAttribute('name');
    const seat = parseInt(p.getAttribute('seat'));
    if (p.getAttribute('dealer') === '1') dealerSeat = seat;
    playersList.push({ name, seat });
    if (name === HERO) {
      heroNet = parseAmt(p.getAttribute('win')) - parseAmt(p.getAttribute('bet'));
      heroRake = parseAmt(p.getAttribute('rakeamount'));
    }
  }
  agg.total_rake += heroRake;
  if (dealerSeat === -1) return;

  const seatToPos = assignPositions(playersList, dealerSeat);
  const heroSeat = playersList.find(p => p.name === HERO)?.seat;
  const heroPos = seatToPos[heroSeat];
  if (!heroPos || !agg.pre[heroPos]) return;

  agg.pre[heroPos].hands++;

  // Get hero's pocket cards for hand quality
  const cardsEls = gameEl.getElementsByTagName('cards');
  let heroPocket = null;
  for (let c = 0; c < cardsEls.length; c++) {
    if (cardsEls[c].getAttribute('type') !== 'Pocket') continue;
    if (cardsEls[c].getAttribute('player') === HERO) { heroPocket = (cardsEls[c].textContent || '').trim(); break; }
  }
  const hqCat = classifyPLO(heroPocket);
  if (hqCat) {
    agg.hq[hqCat].dealt++;
  }

  // Walk through rounds: 0 = blinds, 1 = preflop actions (after blinds), 2 = flop, 3 = turn, 4 = river
  const rounds = gameEl.getElementsByTagName('round');
  // Build action sequence per round
  const roundActions = []; // [round# -> [{player, type, sum, no}]]
  for (let r = 0; r < rounds.length; r++) {
    const roundNo = parseInt(rounds[r].getAttribute('no'));
    roundActions[roundNo] = [];
    const acts = rounds[r].getElementsByTagName('action');
    for (let a = 0; a < acts.length; a++) {
      roundActions[roundNo].push({
        player: acts[a].getAttribute('player'),
        type: acts[a].getAttribute('type'),
        sum: parseAmt(acts[a].getAttribute('sum'))
      });
    }
  }

  // === PREFLOP ANALYSIS ===
  const preflop = roundActions[1] || roundActions[0] || [];
  // Determine if hero VPIP'd (any non-fold/non-check action by hero)
  // and PFR'd (any raise: type 3 with sum > BB or type 5)
  let heroVPIP = false, heroPFR = false, heroLimped = false, heroFolded = false;
  let heroRaised = false; let heroRaiseSize = 0;
  let openRaiseSeen = false;  // first voluntary raise opened the pot
  let limpsBeforeHero = 0, raisesBeforeHero = 0, callersBeforeHero = 0;
  let heroFacedRaise = false; // before hero's first action there was a raise
  let openRaiserName = null;
  let raiseCount = 0; // 1 = open, 2 = 3-bet, 3 = 4-bet
  let heroAction = null;

  // Process preflop actions in order
  let firstHeroIdx = -1;
  for (let i = 0; i < preflop.length; i++) {
    const ac = preflop[i];
    if (ac.player === HERO) {
      if (firstHeroIdx === -1) firstHeroIdx = i;
      // hero's actions
      const t = ac.type;
      if (t === '0') heroFolded = true;
      else if (t === '4') { /* check */ }
      else if (t === '3') {
        // call or raise — distinguish by sum vs current bet
        // If raiseCount === 0, this might be a limp (sum ≈ BB)
        heroVPIP = true;
        if (ac.sum > bbSize * 1.5) {
          heroPFR = true; heroRaised = true; heroRaiseSize = ac.sum;
          raiseCount++;
        } else {
          heroLimped = true;
        }
      } else if (t === '5') {
        heroVPIP = true; heroPFR = true; heroRaised = true; heroRaiseSize = ac.sum; raiseCount++;
      } else if (t === '2') {
        // call
        heroVPIP = true;
      }
      heroAction = t;
    } else {
      // opponent's preflop action before hero acts
      if (firstHeroIdx === -1) {
        if (ac.type === '3' && ac.sum > bbSize * 1.5) { raisesBeforeHero++; raiseCount = 1; openRaiserName = ac.player; }
        else if (ac.type === '5') { raisesBeforeHero++; raiseCount = 1; openRaiserName = ac.player; }
        else if (ac.type === '3') { limpsBeforeHero++; } // limp
        else if (ac.type === '2') { /* posting blind in round 0 */ }
      } else {
        // After hero acts, opponent can 3-bet → check if hero faces 3-bet
        if (heroPFR && (ac.type === '3' && ac.sum > heroRaiseSize) || ac.type === '5') {
          // hero opened, opponent 3-bet
          // We track this below
        }
      }
    }
  }
  if (raisesBeforeHero > 0) heroFacedRaise = true;

  // === Position-specific aggregates ===
  const posAgg = agg.pre[heroPos];
  if (heroVPIP) posAgg.vpip++;
  if (heroPFR) posAgg.pfr++;
  if (heroLimped) { posAgg.limp++; agg.limp_count++; agg.limp_pnl_bb += heroNet / bbSize; }

  // RFI: hero opens (raises) when no one has voluntarily put money in (no limpers/raisers before)
  // Excludes BB (they get to "check" not raise as RFI typical metric)
  if (heroPos !== 'BB') {
    if (limpsBeforeHero === 0 && raisesBeforeHero === 0) {
      posAgg.rfi_opp++;
      if (heroPFR && raiseCount === 1) {
        posAgg.rfi++;
        posAgg.open_sizes.push(heroRaiseSize / bbSize);
      }
    }
  }

  // 3-bet opportunity: faced an open-raise before acting
  if (heroFacedRaise && raisesBeforeHero === 1) {
    posAgg.three_bet_opp++;
    if (heroPFR) posAgg.three_bet++;
    // cold call: facing a raise, no money invested yet (not BB)
    if (heroPos !== 'SB' && heroPos !== 'BB') {
      posAgg.cold_call_opp++;
      if (heroVPIP && !heroPFR) posAgg.cold_call++;
    }
    // fold vs raise
    posAgg.fold_vs_raise_opp++;
    if (heroFolded) posAgg.fold_vs_raise++;
  }
  // squeeze: faced raise + ≥1 caller
  if (heroFacedRaise && raisesBeforeHero === 1 && callersBeforeHero >= 1) {
    posAgg.squeeze_opp++;
    if (heroPFR) posAgg.squeeze++;
  }
  // iso raise: faced limp(s) only (no raise), hero raises
  if (raisesBeforeHero === 0 && limpsBeforeHero >= 1) {
    posAgg.iso_opp++;
    if (heroPFR) posAgg.iso_raise++;
    if (heroVPIP && !heroPFR) posAgg.overlimp++;
    posAgg.overlimp_opp++;
  }
  // Fold to 3-bet: hero opened, faced a 3-bet
  if (heroPFR && raiseCount >= 2) {
    // detect if 3-bet came after hero's open
    let saw3bet = false, hero3betAct = null;
    for (let i = firstHeroIdx + 1; i < preflop.length; i++) {
      const ac = preflop[i];
      if (ac.player !== HERO) {
        if ((ac.type === '3' && ac.sum > heroRaiseSize) || ac.type === '5') saw3bet = true;
      } else if (saw3bet) { hero3betAct = ac.type; break; }
    }
    if (saw3bet) {
      posAgg.fold_to_3bet_opp++;
      if (hero3betAct === '0') posAgg.fold_to_3bet++;
      if (hero3betAct === '2' || hero3betAct === '3') posAgg.call_3bet++;
      if (hero3betAct === '5' || (hero3betAct === '3' && hero3betAct !== '0')) {
        // 4-bet
      }
    }
  }

  // === HAND QUALITY: was hero "played"? ===
  if (hqCat && heroVPIP) {
    agg.hq[hqCat].played++;
    agg.hq[hqCat].total_pnl_bb += heroNet / bbSize;
  }

  // === POSTFLOP ANALYSIS ===
  // Did hero see flop / turn / river?
  const sawFlop = !heroFolded && (roundActions[2] && roundActions[2].length > 0);
  const sawTurn = !heroFolded && (roundActions[3] && roundActions[3].length > 0);
  const sawRiver = !heroFolded && (roundActions[4] && roundActions[4].length > 0);

  // Was hero PFR? Then he's "the aggressor" for c-bet purposes
  agg.post_by_pos[heroPos] = agg.post_by_pos[heroPos] || { saw_flop:0, saw_turn:0, saw_river:0, cbet:0, cbet_opp:0, fold_to_cbet:0, fold_to_cbet_opp:0, wtsd:0, wsd:0 };

  // In PLO heads-up to flop with hero IP/OOP
  // IP = hero acted last preflop (BTN/CO usually); OOP otherwise
  const isIP = heroPos === 'BTN' || (heroPos === 'CO' && raisesBeforeHero === 0);

  // FLOP
  if (sawFlop) {
    agg.post.flop.saw++;
    agg.post_by_pos[heroPos].saw_flop++;
    const flopActs = roundActions[2];
    let heroFoldedFlop = false, heroBetFlop = false, heroCheckedFlop = false, heroRaisedFlop = false, heroCalledFlop = false;
    let heroFirstActFlop = null, faceCbet = false, oppBetFirst = false;
    let heroIdxFlop = -1;
    for (let i = 0; i < flopActs.length; i++) {
      if (flopActs[i].player === HERO) {
        if (heroIdxFlop === -1) heroIdxFlop = i;
        if (heroFirstActFlop === null) heroFirstActFlop = flopActs[i].type;
        if (flopActs[i].type === '0') heroFoldedFlop = true;
        if (flopActs[i].type === '4') heroCheckedFlop = true;
        if (flopActs[i].type === '3' || flopActs[i].type === '5') {
          // bet or raise
          // Check if there was a bet before — if so, it's a raise, otherwise bet
          let betBefore = false;
          for (let j = 0; j < i; j++) { if ((flopActs[j].type === '3' || flopActs[j].type === '5') && flopActs[j].sum > 0) { betBefore = true; break; } }
          if (betBefore) heroRaisedFlop = true; else heroBetFlop = true;
        }
        if (flopActs[i].type === '2') heroCalledFlop = true;
      } else if (heroIdxFlop === -1 && (flopActs[i].type === '3' || flopActs[i].type === '5') && flopActs[i].sum > 0) {
        oppBetFirst = true;
      }
    }
    if (heroBetFlop) agg.post.flop.bets++;
    if (heroRaisedFlop) agg.post.flop.raises++;
    if (heroCalledFlop) agg.post.flop.calls++;
    if (heroFoldedFlop) agg.post.flop.folds++;
    if (heroCheckedFlop) agg.post.flop.checks++;

    // C-bet: hero was PFR and bet flop on first action (and was either first to act, or it checked to him)
    if (heroPFR) {
      agg.post.flop.cbet_opp++;
      agg.post_by_pos[heroPos].cbet_opp++;
      if (isIP) agg.post.flop.cbet_opp_ip++; else agg.post.flop.cbet_opp_oop++;
      if (heroBetFlop && !oppBetFirst) {
        agg.post.flop.cbet++;
        agg.post_by_pos[heroPos].cbet++;
        if (isIP) agg.post.flop.cbet_ip++; else agg.post.flop.cbet_oop++;
      }
    }

    // Fold to c-bet: hero NOT PFR, faced a c-bet from PFR
    if (!heroPFR && heroVPIP && oppBetFirst) {
      agg.post.flop.fold_to_cbet_opp++;
      agg.post_by_pos[heroPos].fold_to_cbet_opp++;
      if (heroFoldedFlop) {
        agg.post.flop.fold_to_cbet++;
        agg.post_by_pos[heroPos].fold_to_cbet++;
      }
    }

    // Check-raise / check-call / check-fold
    if (heroCheckedFlop) {
      agg.post.flop.xr_opp++;
      if (heroRaisedFlop) agg.post.flop.xr++;
      else if (heroCalledFlop) agg.post.flop.xc++;
      else if (heroFoldedFlop) agg.post.flop.xf++;
    }

    // Donk: hero NOT PFR, hero bet first OOP
    if (!heroPFR && heroVPIP && !isIP && heroBetFlop && heroIdxFlop === 0) {
      agg.post.flop.donk++;
    }
    if (!heroPFR && heroVPIP && !isIP) agg.post.flop.donk_opp++;

    // WTSD / WSD
    if (sawRiver) {
      // Reached river — see if went to showdown (river round had bet+call or check-check)
      const riverActs = roundActions[4] || [];
      let heroReachedSD = !heroFoldedFlop;
      // Check if hero folded turn/river
      const turnActs = roundActions[3] || [];
      for (let i = 0; i < turnActs.length; i++) { if (turnActs[i].player === HERO && turnActs[i].type === '0') { heroReachedSD = false; break; } }
      for (let i = 0; i < riverActs.length; i++) { if (riverActs[i].player === HERO && riverActs[i].type === '0') { heroReachedSD = false; break; } }
      if (heroReachedSD) {
        // Did opponent reveal cards? (real showdown)
        let oppReveal = false;
        for (let c = 0; c < cardsEls.length; c++) {
          if (cardsEls[c].getAttribute('type') !== 'Pocket') continue;
          if (cardsEls[c].getAttribute('player') === HERO) continue;
          const txt = (cardsEls[c].textContent || '').trim();
          if (txt && !txt.startsWith('X')) { oppReveal = true; break; }
        }
        if (oppReveal) {
          agg.post.flop.wtsd++;
          agg.post_by_pos[heroPos].wtsd++;
          if (heroNet > 0) { agg.post.flop.wsd++; agg.post_by_pos[heroPos].wsd++; }
        }
      }
    }
  }

  // TURN (similar but simpler)
  if (sawTurn) {
    agg.post.turn.saw++;
    agg.post_by_pos[heroPos].saw_turn++;
    const turnActs = roundActions[3];
    let heroBetTurn = false, heroCheckedTurn = false, heroFoldedTurn = false, heroCalledTurn = false, heroRaisedTurn = false;
    let oppBetFirstTurn = false; let heroIdxTurn = -1;
    for (let i = 0; i < turnActs.length; i++) {
      if (turnActs[i].player === HERO) {
        if (heroIdxTurn === -1) heroIdxTurn = i;
        if (turnActs[i].type === '4') heroCheckedTurn = true;
        if (turnActs[i].type === '0') heroFoldedTurn = true;
        if (turnActs[i].type === '2') heroCalledTurn = true;
        if (turnActs[i].type === '3' || turnActs[i].type === '5') {
          let betBefore = false;
          for (let j = 0; j < i; j++) if ((turnActs[j].type === '3' || turnActs[j].type === '5') && turnActs[j].sum > 0) betBefore = true;
          if (betBefore) heroRaisedTurn = true; else heroBetTurn = true;
        }
      } else if (heroIdxTurn === -1 && (turnActs[i].type === '3' || turnActs[i].type === '5') && turnActs[i].sum > 0) {
        oppBetFirstTurn = true;
      }
    }
    if (heroBetTurn) agg.post.turn.bets++;
    if (heroRaisedTurn) agg.post.turn.raises++;
    if (heroCalledTurn) agg.post.turn.calls++;
    if (heroFoldedTurn) agg.post.turn.folds++;
    if (heroCheckedTurn) agg.post.turn.checks++;
    if (oppBetFirstTurn) {
      agg.post.turn.faced_bet++;
      if (heroFoldedTurn) agg.post.turn.fold_to_bet++;
      if (heroCalledTurn) agg.post.turn.call_bet++;
      if (heroRaisedTurn) agg.post.turn.raise_bet++;
    }
  }

  // RIVER
  if (sawRiver) {
    agg.post.river.saw++;
    agg.post_by_pos[heroPos].saw_river++;
    const rivActs = roundActions[4];
    let heroBetRiv = false, heroFoldedRiv = false, heroCalledRiv = false, heroRaisedRiv = false;
    let oppBetFirstRiv = false; let heroIdxRiv = -1; let heroBetFirstRiv = false;
    for (let i = 0; i < rivActs.length; i++) {
      if (rivActs[i].player === HERO) {
        if (heroIdxRiv === -1) heroIdxRiv = i;
        if (rivActs[i].type === '0') heroFoldedRiv = true;
        if (rivActs[i].type === '2') heroCalledRiv = true;
        if (rivActs[i].type === '3' || rivActs[i].type === '5') {
          let betBefore = false;
          for (let j = 0; j < i; j++) if ((rivActs[j].type === '3' || rivActs[j].type === '5') && rivActs[j].sum > 0) betBefore = true;
          if (betBefore) heroRaisedRiv = true; else { heroBetRiv = true; if (i === 0 || (i > 0 && !oppBetFirstRiv)) heroBetFirstRiv = true; }
        }
      } else if (heroIdxRiv === -1 && (rivActs[i].type === '3' || rivActs[i].type === '5') && rivActs[i].sum > 0) {
        oppBetFirstRiv = true;
      }
    }
    if (heroBetRiv) agg.post.river.bets++;
    if (heroBetFirstRiv) agg.post.river.bet_first++;
    if (heroRaisedRiv) agg.post.river.raises++;
    if (heroCalledRiv) agg.post.river.calls++;
    if (heroFoldedRiv) agg.post.river.folds++;
    if (oppBetFirstRiv) {
      agg.post.river.faced_bet++;
      if (heroFoldedRiv) agg.post.river.fold_to_bet++;
      if (heroCalledRiv) agg.post.river.call_bet++;
      if (heroRaisedRiv) agg.post.river.raise_bet++;
    }
  }

  // === OPPONENT TRACKING ===
  for (const p of playersList) {
    if (p.name === HERO) continue;
    const o = agg.opps[p.name] = agg.opps[p.name] || { hands:0, vpip:0, vpip_opp:0, pfr:0, pfr_opp:0, three_bet:0, three_bet_opp:0, af_b_r:0, af_c:0, hero_pnl_bb:0, hero_pnl_eur:0 };
    o.hands++;
    if (p.name === HERO) continue;
    // Track opponent VPIP/PFR from their preflop actions
    let oVPIP = false, oPFR = false;
    const pf = roundActions[1] || [];
    for (let i = 0; i < pf.length; i++) {
      if (pf[i].player !== p.name) continue;
      if (pf[i].type === '2' || pf[i].type === '3' || pf[i].type === '5') oVPIP = true;
      if (pf[i].type === '5' || (pf[i].type === '3' && pf[i].sum > 0)) oPFR = true;
    }
    o.vpip_opp++; if (oVPIP) o.vpip++;
    o.pfr_opp++; if (oPFR) o.pfr++;
    // Postflop AF for opponent
    for (let r = 2; r <= 4; r++) {
      const ra = roundActions[r] || [];
      for (let i = 0; i < ra.length; i++) {
        if (ra[i].player !== p.name) continue;
        if (ra[i].type === '3' || ra[i].type === '5') o.af_b_r++;
        if (ra[i].type === '2') o.af_c++;
      }
    }
  }
  // Track hero P&L vs each opponent at the table
  for (const p of playersList) {
    if (p.name === HERO) continue;
    agg.opps[p.name].hero_pnl_eur += heroNet;
    agg.opps[p.name].hero_pnl_bb += heroNet / bbSize;
  }
}

async function main() {
  const zipFiles = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.zip'));
  console.log(`Found ${zipFiles.length} zips`);

  for (const zipFile of zipFiles) {
    const zipPath = path.join(DATA_DIR, zipFile);
    console.log(`\n→ ${zipFile}`);
    const buf = fs.readFileSync(zipPath);
    const zip = await JSZip.loadAsync(buf);
    const entries = Object.values(zip.files).filter(f => !f.dir && f.name.endsWith('.xml'));
    let parsed = 0, failed = 0;
    for (const entry of entries) {
      try {
        const text = await entry.async('string');
        await parseSession(text);
        parsed++;
        if (parsed % 200 === 0) process.stdout.write(`  ${parsed}/${entries.length}\r`);
      } catch (e) { failed++; }
    }
    console.log(`  ${parsed} sessions parsed, ${failed} failed`);
  }

  console.log(`\n=== TOTALS ===`);
  console.log(`Sessions: ${agg.total_sessions}`);
  console.log(`Hands:    ${agg.total_hands}`);
  console.log(`P&L:      €${agg.total_pnl.toFixed(2)}`);
  console.log(`Rake:     €${agg.total_rake.toFixed(2)}`);

  // === BUILD FINAL JSON ===
  const dates = agg.hand_dates.sort((a,b) => a-b);
  const minDate = dates[0], maxDate = dates[dates.length-1];
  const fmt = d => d ? d.toISOString().slice(0,10) : '';

  // Compute weighted average BB for bb/100
  let bbWeightedSum = 0, bbWeightedH = 0;
  for (const [k, v] of Object.entries(agg.by_stakes)) {
    const m = k.match(/[€$£]?([\d.]+)\/[€$£]?([\d.]+)/);
    if (m) { const bb = parseFloat(m[2]); bbWeightedSum += bb * v.hands; bbWeightedH += v.hands; }
  }
  const avgBB = bbWeightedH > 0 ? bbWeightedSum / bbWeightedH : 1;
  const bb100 = agg.total_hands > 0 ? (agg.total_pnl / avgBB) / (agg.total_hands / 100) : 0;

  // Preflop overall
  let totalH = 0, totalVPIP = 0, totalPFR = 0, totalLimp = 0;
  for (const pos of Object.keys(agg.pre)) {
    totalH += agg.pre[pos].hands;
    totalVPIP += agg.pre[pos].vpip;
    totalPFR += agg.pre[pos].pfr;
    totalLimp += agg.pre[pos].limp;
  }
  const pct = (n, d) => d > 0 ? Math.round((n/d)*1000)/10 : 0;

  const preByPos = {};
  for (const [pos, a] of Object.entries(agg.pre)) {
    preByPos[pos] = {
      hands: a.hands,
      vpip: pct(a.vpip, a.hands),
      pfr: pct(a.pfr, a.hands),
      rfi: pct(a.rfi, a.rfi_opp),
      limp: pct(a.limp, a.hands),
      three_bet: pct(a.three_bet, a.three_bet_opp),
      cold_call: pct(a.cold_call, a.cold_call_opp),
      fold_vs_raise: pct(a.fold_vs_raise, a.fold_vs_raise_opp),
      fold_to_3bet: pct(a.fold_to_3bet, a.fold_to_3bet_opp),
      call_3bet: pct(a.call_3bet, a.fold_to_3bet_opp),
      four_bet: 0,
      iso_raise: pct(a.iso_raise, a.iso_opp),
      overlimp: pct(a.overlimp, a.overlimp_opp),
      squeeze: pct(a.squeeze, a.squeeze_opp)
    };
  }

  // Open raise sizing
  const openSizing = {};
  for (const [pos, a] of Object.entries(agg.pre)) {
    const sizes = a.open_sizes;
    if (!sizes.length) continue;
    const sorted = [...sizes].sort((a,b) => a-b);
    openSizing[pos] = {
      avg: sizes.reduce((s,x) => s+x, 0) / sizes.length,
      median: sorted[Math.floor(sorted.length/2)],
      min: Math.min(...sizes),
      max: Math.max(...sizes),
      count: sizes.length
    };
  }

  // Postflop computed percentages
  const fl = agg.post.flop, tu = agg.post.turn, ri = agg.post.river;
  const postComp = {
    flop: {
      cbet_pct: pct(fl.cbet, fl.cbet_opp),
      cbet_ip_pct: pct(fl.cbet_ip, fl.cbet_opp_ip),
      cbet_oop_pct: pct(fl.cbet_oop, fl.cbet_opp_oop),
      xr_pct: pct(fl.xr, fl.xr_opp),
      xc_pct: pct(fl.xc, fl.xr_opp),
      xf_pct: pct(fl.xf, fl.xr_opp),
      donk_pct: pct(fl.donk, fl.donk_opp),
      fold_to_cbet_pct: pct(fl.fold_to_cbet, fl.fold_to_cbet_opp),
      probe_pct: 0,
      wtsd_pct: pct(fl.wtsd, fl.saw),
      wsd_pct: pct(fl.wsd, fl.wtsd)
    },
    turn: {
      cbet_pct: pct(tu.cbet, tu.cbet_opp),
      xr_pct: pct(tu.xr, tu.xr_opp),
      fold_to_bet_pct: pct(tu.fold_to_bet, tu.faced_bet),
      call_bet_pct: pct(tu.call_bet, tu.faced_bet),
      raise_bet_pct: pct(tu.raise_bet, tu.faced_bet),
      probe_pct: 0
    },
    river: {
      fold_to_bet_pct: pct(ri.fold_to_bet, ri.faced_bet),
      call_bet_pct: pct(ri.call_bet, ri.faced_bet),
      raise_bet_pct: pct(ri.raise_bet, ri.faced_bet)
    }
  };

  // Postflop by position computed
  const postByPosComputed = {};
  for (const [pos, p] of Object.entries(agg.post_by_pos)) {
    postByPosComputed[pos] = {
      saw_flop: p.saw_flop,
      saw_turn: p.saw_turn,
      saw_river: p.saw_river,
      cbet_pct: pct(p.cbet, p.cbet_opp),
      fold_to_cbet_pct: pct(p.fold_to_cbet, p.fold_to_cbet_opp),
      wtsd_pct: pct(p.wtsd, p.saw_flop),
      wsd_pct: pct(p.wsd, p.wtsd)
    };
  }

  // Hand quality
  const handQuality = {};
  for (const [k, v] of Object.entries(agg.hq)) {
    handQuality[k] = {
      dealt: v.dealt,
      played: v.played,
      play_rate: pct(v.played, v.dealt),
      total_pnl_bb: Math.round(v.total_pnl_bb * 10) / 10,
      avg_pnl_bb: v.played > 0 ? Math.round((v.total_pnl_bb / v.played) * 100) / 100 : 0
    };
  }

  // Opponents (filter to ≥5K hands like original)
  const opponents = {};
  for (const [name, o] of Object.entries(agg.opps)) {
    if (o.hands < 5000) continue;
    const heroBB = bbWeightedH > 0 ? avgBB : 1;
    opponents[name] = {
      hands: o.hands,
      vpip: pct(o.vpip, o.vpip_opp),
      pfr: pct(o.pfr, o.pfr_opp),
      af: o.af_c > 0 ? Math.round((o.af_b_r / o.af_c) * 100) / 100 : 0,
      three_bet: pct(o.three_bet, o.three_bet_opp),
      cbet: 0,
      wtsd: 0,
      hero_pnl_vs_eur: Math.round(o.hero_pnl_eur * 100) / 100,
      hero_bb100_vs: Math.round(((o.hero_pnl_eur / heroBB) / (o.hands/100)) * 10) / 10
    };
  }

  // P&L by month/stakes formatted
  const byMonth = {};
  for (const [k, v] of Object.entries(agg.by_month)) byMonth[k] = { hands: v.hands, pnl_eur: Math.round(v.pnl*100)/100, sessions: v.sessions };
  const byStakes = {};
  for (const [k, v] of Object.entries(agg.by_stakes)) byStakes[k] = { hands: v.hands, pnl_eur: Math.round(v.pnl*100)/100, sessions: v.sessions };

  // Time analysis
  const dowOut = {};
  for (const [d, v] of Object.entries(agg.by_dow)) {
    const stakes_match = 'Omaha PL €0.50/€1';
    dowOut[d] = { pnl_eur: Math.round(v.p*100)/100, hands: v.h, sessions: v.s, bb_per_100: v.h > 0 ? Math.round(((v.p / avgBB) / (v.h/100)) * 100)/100 : 0 };
  }
  const hourOut = {};
  for (let h = 0; h < 24; h++) {
    const v = agg.by_hour[h] || { p:0, h:0, s:0 };
    hourOut[h] = { pnl_eur: Math.round(v.p*100)/100, hands: v.h, sessions: v.s };
  }

  // Session analysis
  const wins = agg.sessions.filter(s => s.pnl > 0);
  const losses = agg.sessions.filter(s => s.pnl < 0);
  const breakeven = agg.sessions.filter(s => s.pnl === 0);
  // Streaks
  let maxLossStreak = 0, curLossStreak = 0;
  const sortedSess = [...agg.sessions].sort((a,b) => new Date(a.date.replace(/(\d{2})-(\d{2})-(\d{4}) (.+)/, '$3-$1-$2T$4')) - new Date(b.date.replace(/(\d{2})-(\d{2})-(\d{4}) (.+)/, '$3-$1-$2T$4')));
  for (const s of sortedSess) { if (s.pnl < 0) { curLossStreak++; if (curLossStreak > maxLossStreak) maxLossStreak = curLossStreak; } else curLossStreak = 0; }
  const top5wins = [...wins].sort((a,b) => b.pnl - a.pnl).slice(0,5);
  const top5loss = [...losses].sort((a,b) => a.pnl - b.pnl).slice(0,5);
  // Length distribution
  const len = { short_1_20: { c:0, p:0 }, medium_21_100: { c:0, p:0 }, long_100_plus: { c:0, p:0 } };
  for (const s of agg.sessions) {
    if (s.hands <= 20) { len.short_1_20.c++; len.short_1_20.p += s.pnl; }
    else if (s.hands <= 100) { len.medium_21_100.c++; len.medium_21_100.p += s.pnl; }
    else { len.long_100_plus.c++; len.long_100_plus.p += s.pnl; }
  }
  // Multitabling (estimate from tablesize — single session = 1 table, but we need multi-session detection)
  // Skip detailed multitabling — use placeholder structure
  // Tilt analysis: simple after-loss
  let afterLossSessions = [], afterWinSessions = [], afterNormalSessions = [];
  for (let i = 1; i < sortedSess.length; i++) {
    const prev = sortedSess[i-1].pnl;
    if (prev < -50) afterLossSessions.push(sortedSess[i].pnl);
    else if (prev > 50) afterWinSessions.push(sortedSess[i].pnl);
    else afterNormalSessions.push(sortedSess[i].pnl);
  }

  // Weekly P&L curve
  const weeklySorted = Object.entries(agg.weekly).sort();
  let cum = 0;
  const weeklyCurve = weeklySorted.map(([wk, v]) => { cum += v.pnl; return { week: wk, hands: v.hands, pnl: Math.round(v.pnl*100)/100, cumulative: Math.round(cum*100)/100, period: 'all' }; });

  // GTO benchmarks (PLO 6-max)
  const gtoBench = {
    preflop_by_position: {
      BTN:{vpip:[38,48],pfr:[30,40],three_bet:[6,10],open_raise:[40,52],limp:[0,2]},
      CO:{vpip:[28,36],pfr:[24,32],three_bet:[5,9],open_raise:[28,36],limp:[0,1]},
      HJ:{vpip:[22,30],pfr:[20,28],three_bet:[4,8],open_raise:[22,30],limp:[0,1]},
      UTG:{vpip:[16,24],pfr:[16,22],three_bet:[3,6],open_raise:[16,22],limp:[0,1]},
      SB:{vpip:[30,40],pfr:[20,30],three_bet:[6,12],open_raise:[22,32],limp:[0,5]},
      BB:{vpip:[30,40],pfr:[8,14],three_bet:[6,12]}
    },
    postflop:{cbet_flop:[50,65],cbet_turn:[45,60],fold_to_cbet_flop:[35,50],check_raise_flop:[8,15],donk_bet_flop:[0,5],wtsd:[28,35],wsd:[50,58],af:[2,3.5]}
  };

  // Leak analysis (auto-generated based on stats)
  const overallVPIP = pct(totalVPIP, totalH);
  const overallPFR = pct(totalPFR, totalH);
  const overallLimp = pct(totalLimp, totalH);
  const af = (fl.bets + fl.raises + tu.bets + tu.raises + ri.bets + ri.raises) / Math.max(1, fl.calls + tu.calls + ri.calls);
  const leaks = [];
  const sbLimp = preByPos.SB?.limp || 0;
  if (sbLimp > 15) leaks.push({severity:'critical',leak:`SB open-limp ${sbLimp}%`,value:sbLimp,gto:[0,5],fix:'Raise or fold from SB'});
  if (overallLimp > 5) leaks.push({severity:'critical',leak:`Overall limp ${overallLimp}%`,value:overallLimp,gto:[0,2],fix:'Stop limping all positions'});
  const overall3bet = totalH > 0 ? pct(Object.values(agg.pre).reduce((s,a) => s+a.three_bet, 0), Object.values(agg.pre).reduce((s,a) => s+a.three_bet_opp, 0)) : 0;
  if (overall3bet < 5) leaks.push({severity:'critical',leak:`3-Bet ${overall3bet}%`,value:overall3bet,gto:[6,10],fix:'3-bet premiums, stop cold-calling'});
  if (overallVPIP - overallPFR > 18) leaks.push({severity:'major',leak:`VPIP ${overallVPIP}% / PFR ${overallPFR}% (${(overallVPIP-overallPFR).toFixed(1)}pt gap)`,vpip:overallVPIP,pfr:overallPFR,gto_vpip:[28,36],gto_gap:[10,15],fix:'Tighten ranges, raise more'});
  if (postComp.flop.donk_pct > 10) leaks.push({severity:'major',leak:`Donk bet flop ${postComp.flop.donk_pct}%`,value:postComp.flop.donk_pct,gto:[0,5],fix:'Check to PFR, use check-raises'});
  if (postComp.flop.xr_pct < 8) leaks.push({severity:'major',leak:`Check-raise flop ${postComp.flop.xr_pct}%`,value:postComp.flop.xr_pct,gto:[8,15],fix:'Check-raise more with strong draws/sets'});
  if (postComp.flop.fold_to_cbet_pct > 50) leaks.push({severity:'major',leak:`Fold to cbet ${postComp.flop.fold_to_cbet_pct}%`,value:postComp.flop.fold_to_cbet_pct,gto:[35,50],fix:'Defend more vs c-bets with draws'});
  if (af < 2) leaks.push({severity:'major',leak:`AF ${af.toFixed(2)}`,value:Math.round(af*100)/100,gto:[2,3.5],fix:'Bet more for value, add river bluffs'});

  // Strengths
  const strengths = [];
  if (postComp.flop.wtsd_pct >= 28 && postComp.flop.wtsd_pct <= 35) strengths.push(`WTSD ${postComp.flop.wtsd_pct}% in GTO range`);
  if (postComp.flop.wsd_pct >= 50) strengths.push(`W$SD ${postComp.flop.wsd_pct}% solid`);

  // Build final JSON matching original schema
  const out = {
    _metadata: {
      player: HERO,
      platform: 'Novibet (iPoker network)',
      game: 'PLO 6-max',
      period: `${fmt(minDate)} – ${fmt(maxDate)}`,
      total_hands: agg.total_hands,
      total_sessions: agg.total_sessions,
      currency: 'EUR',
      confidence: {
        pnl_total: 'HIGH — from session headers',
        pnl_by_month: 'HIGH — from session headers',
        pnl_by_stakes: 'HIGH — from session headers',
        preflop_stats: `HIGH — ${(agg.total_hands/1000).toFixed(0)}K hands parsed`,
        postflop_stats: `HIGH — ${(fl.saw/1000).toFixed(0)}K flops`,
        positional_bb100: 'MEDIUM',
        opponents: `${Object.keys(opponents).length} opponents with 5K+ hands`,
        hand_quality: 'MEDIUM — heuristic PLO classification'
      }
    },
    pnl: {
      total_eur: Math.round(agg.total_pnl * 100) / 100,
      total_rake_eur: Math.round(agg.total_rake * 100) / 100,
      bb_per_100: Math.round(bb100 * 100) / 100,
      by_month: byMonth,
      by_stakes: byStakes
    },
    preflop: {
      overall: { vpip: overallVPIP, pfr: overallPFR, limp_pct: overallLimp },
      by_position: preByPos,
      open_raise_sizing: openSizing,
      limp_analysis: {
        total_limps: agg.limp_count,
        by_position: Object.fromEntries(Object.entries(agg.pre).map(([p,a]) => [p, a.limp])),
        avg_pnl_per_limp_bb: agg.limp_count > 0 ? Math.round((agg.limp_pnl_bb / agg.limp_count) * 100) / 100 : 0
      }
    },
    postflop: {
      flop: { wtsd: fl.wtsd, donk_opp: fl.donk_opp, probe_opp: 0, cbet_opp: fl.cbet_opp, cbet_opp_oop: fl.cbet_opp_oop, cbet: fl.cbet, cbet_oop: fl.cbet_oop, bets: fl.bets, xr_opp: fl.xr_opp, xf: fl.xf, folds: fl.folds, cbet_opp_ip: fl.cbet_opp_ip, wsd: fl.wsd, fold_to_cbet_opp: fl.fold_to_cbet_opp, xc: fl.xc, calls: fl.calls, cbet_ip: fl.cbet_ip, fold_to_cbet: fl.fold_to_cbet, donk: fl.donk, probe: 0, raises: fl.raises, xr: fl.xr },
      turn: { bets: tu.bets, xr_opp: tu.xr_opp, faced_bet: tu.faced_bet, fold_to_bet: tu.fold_to_bet, folds: tu.folds, cbet_opp: tu.cbet_opp, probe_opp: 0, xr: tu.xr, raise_bet: tu.raise_bet, raises: tu.raises, calls: tu.calls, cbet: tu.cbet, call_bet: tu.call_bet, probe: 0 },
      river: { raises: ri.raises, bets: ri.bets, bet_first: ri.bet_first, calls: ri.calls, faced_bet: ri.faced_bet, fold_to_bet: ri.fold_to_bet, folds: ri.folds, call_bet: ri.call_bet, raise_bet: ri.raise_bet },
      by_pos: agg.post_by_pos,
      computed_percentages: postComp,
      by_position_computed: postByPosComputed
    },
    session_analysis: {
      total_sessions: agg.total_sessions,
      winning_sessions: wins.length,
      losing_sessions: losses.length,
      breakeven_sessions: breakeven.length,
      win_rate_pct: agg.total_sessions > 0 ? (wins.length / agg.total_sessions * 100) : 0,
      avg_winning_session_eur: wins.length > 0 ? wins.reduce((s,x) => s+x.pnl, 0) / wins.length : 0,
      avg_losing_session_eur: losses.length > 0 ? losses.reduce((s,x) => s+x.pnl, 0) / losses.length : 0,
      biggest_win_session_eur: wins.length > 0 ? Math.max(...wins.map(w => w.pnl)) : 0,
      biggest_loss_session_eur: losses.length > 0 ? Math.min(...losses.map(l => l.pnl)) : 0,
      max_losing_streak: maxLossStreak,
      avg_session_hands: agg.total_sessions > 0 ? agg.total_hands / agg.total_sessions : 0,
      session_length_distribution: {
        short_1_20: { count: len.short_1_20.c, avg_pnl: len.short_1_20.c > 0 ? len.short_1_20.p / len.short_1_20.c : 0 },
        medium_21_100: { count: len.medium_21_100.c, avg_pnl: len.medium_21_100.c > 0 ? len.medium_21_100.p / len.medium_21_100.c : 0 },
        long_100_plus: { count: len.long_100_plus.c, avg_pnl: len.long_100_plus.c > 0 ? len.long_100_plus.p / len.long_100_plus.c : 0 }
      },
      by_hour_of_day: hourOut,
      top_5_winning_sessions: top5wins.map(s => ({ pnl: s.pnl, hands: s.hands, date: s.date, stakes: s.stakes })),
      top_5_losing_sessions: top5loss.map(s => ({ pnl: s.pnl, hands: s.hands, date: s.date, stakes: s.stakes }))
    },
    opponents,
    hand_quality: handQuality,
    gto_benchmarks: gtoBench,
    leak_analysis: leaks,
    strengths,
    trends: {
      concerning: [],
      stable: []
    },
    period_comparison: {
      _description: 'Period comparison not yet computed by this build script. Re-run with manual split if needed.',
      good_period: { dates: 'N/A', pnl_eur: 0, hands: 0, bb_per_100: 0, sessions: 0, stats: { hands: 0, vpip: 0, pfr: 0, vpip_pfr_gap: 0, limp_pct: 0, open_raise_pct: 0, three_bet_pct: 0, cold_call_pct: 0, fold_to_3bet_pct: 0, cbet_flop_pct: 0, cbet_turn_pct: 0, donk_bet_pct: 0, check_raise_flop_pct: 0, fold_to_cbet_pct: 0, wtsd_pct: 0, wsd_pct: 0, af: 0, river_fold_to_bet_pct: 0, avg_open_size_bb: 0, by_position: preByPos } },
      bad_period: { dates: 'N/A', pnl_eur: 0, hands: 0, bb_per_100: 0, sessions: 0, stats: { hands: 0, vpip: 0, pfr: 0, vpip_pfr_gap: 0, limp_pct: 0, open_raise_pct: 0, three_bet_pct: 0, cold_call_pct: 0, fold_to_3bet_pct: 0, cbet_flop_pct: 0, cbet_turn_pct: 0, donk_bet_pct: 0, check_raise_flop_pct: 0, fold_to_cbet_pct: 0, wtsd_pct: 0, wsd_pct: 0, af: 0, river_fold_to_bet_pct: 0, avg_open_size_bb: 0, by_position: preByPos } },
      stat_differences: {},
      key_changes: [],
      target_stats_from_good_period: { _description: 'Not computed', vpip: overallVPIP, pfr: overallPFR, vpip_pfr_gap: overallVPIP-overallPFR, limp_pct: overallLimp, three_bet_pct: overall3bet, cold_call_pct: 0, fold_to_3bet_pct: 0, open_raise_pct: 0, cbet_flop_pct: postComp.flop.cbet_pct, donk_bet_pct: postComp.flop.donk_pct, check_raise_flop_pct: postComp.flop.xr_pct, af: Math.round(af*100)/100, by_position: preByPos }
    },
    weekly_pnl_curve: weeklyCurve,
    time_analysis: { by_day_of_week: dowOut, by_hour_of_day: hourOut },
    tilt_analysis: {
      after_big_loss_gt_50eur: { sessions: afterLossSessions.length, total_pnl: afterLossSessions.reduce((s,x) => s+x, 0), avg_pnl: afterLossSessions.length > 0 ? afterLossSessions.reduce((s,x) => s+x, 0) / afterLossSessions.length : 0 },
      after_big_win_gt_50eur: { sessions: afterWinSessions.length, total_pnl: afterWinSessions.reduce((s,x) => s+x, 0), avg_pnl: afterWinSessions.length > 0 ? afterWinSessions.reduce((s,x) => s+x, 0) / afterWinSessions.length : 0 },
      after_normal_session: { sessions: afterNormalSessions.length, total_pnl: afterNormalSessions.reduce((s,x) => s+x, 0), avg_pnl: afterNormalSessions.length > 0 ? afterNormalSessions.reduce((s,x) => s+x, 0) / afterNormalSessions.length : 0 }
    },
    multitabling_analysis: { '1_table': { pnl: 0, hands: 0, sessions: 0 }, '2_3_tables': { pnl: 0, hands: 0, sessions: 0 }, '4_plus_tables': { pnl: agg.total_pnl, hands: agg.total_hands, sessions: agg.total_sessions } },
    stake_movement_analysis: { moved_up_stakes: { sessions: 0, total_pnl: 0, avg_pnl: 0 }, moved_down_stakes: { sessions: 0, total_pnl: 0, avg_pnl: 0 }, same_stakes: { sessions: agg.total_sessions, total_pnl: agg.total_pnl, avg_pnl: agg.total_sessions > 0 ? agg.total_pnl / agg.total_sessions : 0 } },
    action_plan: {
      _description: 'Auto-generated from current leaks',
      immediate_fixes: leaks.slice(0, 5).map((l, i) => ({ priority: i+1, action: l.fix, target: l.gto ? `${l.leak} → GTO ${l.gto[0]}-${l.gto[1]}` : l.leak, impact: l.severity })),
      session_management: [
        { action: 'Set stop-loss per session', detail: 'After losing >€50, take a break before next session.' },
        { action: 'Avoid late-night sessions', detail: 'Late hours often correlate with losing streaks.' },
        { action: 'Don\'t move up stakes during downswings', detail: 'Stay at your level when running bad.' }
      ],
      good_period_targets: { _description: 'Targets to aim for', vpip: 35, pfr: 25, vpip_pfr_gap: 12, limp_pct: 2, three_bet_pct: 7, cold_call_pct: 25, fold_to_3bet_pct: 45, open_raise_pct: 32, cbet_flop_pct: 58, donk_bet_pct: 3, check_raise_flop_pct: 12, af: 2.5 }
    }
  };

  // ====== TOURNAMENT SECTION ======
  out.tournaments = buildTournamentsSection(pct);

  // ====== COMBINED OVERALL TOTALS (cash + tournaments) ======
  out.combined = {
    total_pnl_eur: Math.round((agg.total_pnl + tagg.total_pnl) * 100) / 100,
    total_hands: agg.total_hands + tagg.total_hands,
    total_sessions: agg.total_sessions + tagg.total_sessions,
    cash_pnl_eur: Math.round(agg.total_pnl * 100) / 100,
    cash_hands: agg.total_hands,
    cash_sessions: agg.total_sessions,
    tournament_pnl_eur: Math.round(tagg.total_pnl * 100) / 100,
    tournament_hands: tagg.total_hands,
    tournament_sessions: tagg.total_sessions,
    rake_eur: Math.round(agg.total_rake * 100) / 100
  };

  fs.writeFileSync(path.join(DATA_DIR, 'platinex_dashboard_complete.json'), JSON.stringify(out));
  console.log(`\n✅ Wrote data/platinex_dashboard_complete.json (${(fs.statSync(path.join(DATA_DIR, 'platinex_dashboard_complete.json')).size / 1024).toFixed(0)} KB)`);
  console.log(`\n=== TOURNAMENT TOTALS ===`);
  console.log(`Tournaments entered: ${tournamentSessions.length}`);
  console.log(`Total invested:      €${tournamentSessions.reduce((s,t) => s+t.invested, 0).toFixed(2)}`);
  console.log(`Total cashed:        €${tournamentSessions.reduce((s,t) => s+t.win, 0).toFixed(2)}`);
  console.log(`Net winnings:        €${tagg.total_pnl.toFixed(2)}`);
  console.log(`Tournament hands:    ${tagg.total_hands}`);
  console.log(`\n=== COMBINED ===`);
  console.log(`Combined P&L:        €${(agg.total_pnl + tagg.total_pnl).toFixed(2)}`);
  console.log(`Combined hands:      ${agg.total_hands + tagg.total_hands}`);
  console.log(`Now run: node build-deep-analysis.js   to inject into index.html`);
}

// ============================================================================
// TOURNAMENT SUMMARY BUILDER
// ============================================================================
function buildTournamentsSection(pct) {
  const T = tournamentSessions;
  if (T.length === 0) {
    return { _empty: true, summary: { entries: 0, invested_eur: 0, cashed_eur: 0, net_eur: 0, roi_pct: 0, itm_pct: 0, total_hands: 0 } };
  }

  const totalInvested = T.reduce((s,t) => s + t.invested, 0);
  const totalCashed   = T.reduce((s,t) => s + t.win, 0);
  const itmCount      = T.filter(t => t.itm).length;
  const dates         = T.map(t => new Date(t.date.replace(/(\d{2})-(\d{2})-(\d{4}) (.+)/, '$3-$1-$2T$4'))).sort((a,b)=>a-b);
  const minDate = dates[0], maxDate = dates[dates.length-1];

  // Format breakdown
  const byFormat = {};
  for (const t of T) {
    const f = t.format;
    if (!byFormat[f]) byFormat[f] = { entries: 0, invested: 0, cashed: 0, itm: 0, hands: 0, places: [] };
    byFormat[f].entries++;
    byFormat[f].invested += t.invested;
    byFormat[f].cashed   += t.win;
    byFormat[f].hands    += t.gamecount;
    if (t.itm) byFormat[f].itm++;
    byFormat[f].places.push(t.place);
  }
  const byFormatOut = {};
  for (const [k,v] of Object.entries(byFormat)) {
    byFormatOut[k] = {
      entries: v.entries,
      invested_eur: Math.round(v.invested*100)/100,
      cashed_eur:   Math.round(v.cashed*100)/100,
      net_eur:      Math.round((v.cashed - v.invested)*100)/100,
      roi_pct:      v.invested > 0 ? Math.round(((v.cashed - v.invested)/v.invested)*1000)/10 : 0,
      itm_pct:      pct(v.itm, v.entries),
      hands:        v.hands,
      avg_buyin_eur: v.entries > 0 ? Math.round((v.invested/v.entries)*100)/100 : 0
    };
  }

  // Buy-in level breakdown
  const buyinBuckets = { 'Micro (≤€5)':[0,5], 'Low (€5-€20)':[5,20], 'Mid (€20-€50)':[20,50], 'High (€50-€200)':[50,200], 'Premium (>€200)':[200,Infinity] };
  const byBuyin = {};
  for (const [label, [lo, hi]] of Object.entries(buyinBuckets)) {
    const sub = T.filter(t => t.totalBuyin > lo && t.totalBuyin <= hi);
    if (sub.length === 0) continue;
    const inv = sub.reduce((s,t) => s+t.invested, 0);
    const csh = sub.reduce((s,t) => s+t.win, 0);
    const itm = sub.filter(t => t.itm).length;
    byBuyin[label] = {
      entries: sub.length,
      invested_eur: Math.round(inv*100)/100,
      cashed_eur:   Math.round(csh*100)/100,
      net_eur:      Math.round((csh-inv)*100)/100,
      roi_pct:      inv > 0 ? Math.round(((csh-inv)/inv)*1000)/10 : 0,
      itm_pct:      pct(itm, sub.length),
      hands:        sub.reduce((s,t)=>s+t.gamecount,0)
    };
  }

  // Monthly breakdown
  const byMonthT = {};
  for (const t of T) {
    if (!byMonthT[t.ym]) byMonthT[t.ym] = { entries:0, invested:0, cashed:0, itm:0, hands:0 };
    byMonthT[t.ym].entries++;
    byMonthT[t.ym].invested += t.invested;
    byMonthT[t.ym].cashed   += t.win;
    byMonthT[t.ym].hands    += t.gamecount;
    if (t.itm) byMonthT[t.ym].itm++;
  }
  const byMonthOut = {};
  for (const [k,v] of Object.entries(byMonthT)) {
    byMonthOut[k] = {
      entries: v.entries,
      invested_eur: Math.round(v.invested*100)/100,
      cashed_eur:   Math.round(v.cashed*100)/100,
      net_eur:      Math.round((v.cashed-v.invested)*100)/100,
      roi_pct:      v.invested > 0 ? Math.round(((v.cashed-v.invested)/v.invested)*1000)/10 : 0,
      itm_pct:      pct(v.itm, v.entries),
      hands:        v.hands
    };
  }

  // Finish position distribution
  const finishBuckets = { '1st':[1,1], '2nd':[2,2], '3rd':[3,3], 'Top 5':[1,5], 'Top 10':[1,10], '11th-25th':[11,25], '26th-100th':[26,100], '100th+':[101,Infinity] };
  const finishDist = {};
  for (const [label, [lo, hi]] of Object.entries(finishBuckets)) {
    const sub = T.filter(t => t.place >= lo && t.place <= hi);
    finishDist[label] = { count: sub.length, pct: pct(sub.length, T.length), avg_cash: sub.length > 0 ? Math.round((sub.reduce((s,t)=>s+t.win,0)/sub.length)*100)/100 : 0 };
  }

  // Top 10 cashes
  const topCashes = [...T].sort((a,b) => b.win - a.win).slice(0, 10).map(t => ({
    date: t.date, name: t.name, format: t.format, buyin_eur: Math.round(t.totalBuyin*100)/100, cashed_eur: Math.round(t.win*100)/100, place: t.place, hands: t.gamecount
  }));
  // Worst (biggest losses by absolute net)
  const worst = [...T].filter(t=>!t.itm).sort((a,b) => b.invested - a.invested).slice(0, 10).map(t => ({
    date: t.date, name: t.name, format: t.format, buyin_eur: Math.round(t.totalBuyin*100)/100, invested_eur: Math.round(t.invested*100)/100, place: t.place, hands: t.gamecount
  }));

  // Hand-level analytics from tagg (same shape as cash)
  let totalHt = 0, totalVPIPt = 0, totalPFRt = 0, totalLimpt = 0;
  for (const pos of Object.keys(tagg.pre)) {
    totalHt += tagg.pre[pos].hands;
    totalVPIPt += tagg.pre[pos].vpip;
    totalPFRt += tagg.pre[pos].pfr;
    totalLimpt += tagg.pre[pos].limp;
  }
  const preByPosT = {};
  for (const [pos, a] of Object.entries(tagg.pre)) {
    preByPosT[pos] = {
      hands: a.hands,
      vpip: pct(a.vpip, a.hands),
      pfr: pct(a.pfr, a.hands),
      rfi: pct(a.rfi, a.rfi_opp),
      limp: pct(a.limp, a.hands),
      three_bet: pct(a.three_bet, a.three_bet_opp),
      cold_call: pct(a.cold_call, a.cold_call_opp),
      fold_vs_raise: pct(a.fold_vs_raise, a.fold_vs_raise_opp),
      fold_to_3bet: pct(a.fold_to_3bet, a.fold_to_3bet_opp),
      iso_raise: pct(a.iso_raise, a.iso_opp),
      squeeze: pct(a.squeeze, a.squeeze_opp)
    };
  }
  const flT = tagg.post.flop, tuT = tagg.post.turn, riT = tagg.post.river;
  const postCompT = {
    flop: {
      cbet_pct: pct(flT.cbet, flT.cbet_opp),
      cbet_ip_pct: pct(flT.cbet_ip, flT.cbet_opp_ip),
      cbet_oop_pct: pct(flT.cbet_oop, flT.cbet_opp_oop),
      xr_pct: pct(flT.xr, flT.xr_opp),
      donk_pct: pct(flT.donk, flT.donk_opp),
      fold_to_cbet_pct: pct(flT.fold_to_cbet, flT.fold_to_cbet_opp),
      wtsd_pct: pct(flT.wtsd, flT.saw),
      wsd_pct: pct(flT.wsd, flT.wtsd)
    },
    turn: {
      cbet_pct: pct(tuT.cbet, tuT.cbet_opp),
      xr_pct: pct(tuT.xr, tuT.xr_opp),
      fold_to_bet_pct: pct(tuT.fold_to_bet, tuT.faced_bet),
      call_bet_pct: pct(tuT.call_bet, tuT.faced_bet),
      raise_bet_pct: pct(tuT.raise_bet, tuT.faced_bet)
    },
    river: {
      fold_to_bet_pct: pct(riT.fold_to_bet, riT.faced_bet),
      call_bet_pct: pct(riT.call_bet, riT.faced_bet),
      raise_bet_pct: pct(riT.raise_bet, riT.faced_bet)
    }
  };

  // Best/worst tournament
  const biggestCash = T.reduce((m,t) => t.win > m.win ? t : m, T[0]);
  const bestFinish  = T.reduce((m,t) => (t.place > 0 && (m.place === 0 || t.place < m.place)) ? t : m, T[0]);

  // Sorted sessions list (most recent first)
  const sessionsList = [...T].sort((a,b) => new Date(b.date.replace(/(\d{2})-(\d{2})-(\d{4}) (.+)/, '$3-$1-$2T$4')) - new Date(a.date.replace(/(\d{2})-(\d{2})-(\d{4}) (.+)/, '$3-$1-$2T$4'))).map(t => ({
    date: t.date, name: t.name, format: t.format,
    buyin_eur: Math.round(t.totalBuyin*100)/100,
    invested_eur: Math.round(t.invested*100)/100,
    cashed_eur: Math.round(t.win*100)/100,
    net_eur: Math.round(t.net*100)/100,
    place: t.place, hands: t.gamecount, tablesize: t.tablesize, itm: t.itm
  }));

  // Weekly P&L curve (tournaments)
  const weeklySortedT = Object.entries(tagg.weekly).sort();
  let cumT = 0;
  const weeklyCurveT = weeklySortedT.map(([wk, v]) => { cumT += v.pnl; return { week: wk, hands: v.hands, pnl: Math.round(v.pnl*100)/100, cumulative: Math.round(cumT*100)/100 }; });

  return {
    _metadata: {
      period: `${minDate.toISOString().slice(0,10)} – ${maxDate.toISOString().slice(0,10)}`,
      game: 'Holdem NL Tournaments (MTT/SnG/Sat/Spin)'
    },
    summary: {
      entries: T.length,
      invested_eur: Math.round(totalInvested*100)/100,
      cashed_eur:   Math.round(totalCashed*100)/100,
      net_eur:      Math.round((totalCashed - totalInvested)*100)/100,
      roi_pct:      totalInvested > 0 ? Math.round(((totalCashed - totalInvested)/totalInvested)*1000)/10 : 0,
      itm_pct:      pct(itmCount, T.length),
      itm_count:    itmCount,
      total_hands:  tagg.total_hands,
      avg_buyin_eur: Math.round((totalInvested/T.length)*100)/100,
      avg_hands_per_tourn: Math.round((tagg.total_hands/T.length)*10)/10,
      biggest_cash_eur: Math.round(biggestCash.win*100)/100,
      biggest_cash_event: biggestCash.name,
      best_finish: bestFinish.place,
      best_finish_event: bestFinish.name
    },
    by_format: byFormatOut,
    by_buyin: byBuyin,
    by_month: byMonthOut,
    finish_distribution: finishDist,
    top_cashes: topCashes,
    worst_busts: worst,
    preflop: {
      overall: { vpip: pct(totalVPIPt, totalHt), pfr: pct(totalPFRt, totalHt), limp_pct: pct(totalLimpt, totalHt) },
      by_position: preByPosT
    },
    postflop: {
      computed_percentages: postCompT,
      flop_raw: flT, turn_raw: tuT, river_raw: riT
    },
    weekly_pnl_curve: weeklyCurveT,
    sessions: sessionsList
  };
}

main().catch(e => { console.error(e); process.exit(1); });
