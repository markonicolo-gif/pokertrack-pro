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

// === iPoker XML action types (CONFIRMED via direct inspection of 330 hands across 5 zips) ===
// Round 0 (blinds/posts only):
//   1  = small blind post
//   2  = big blind post
//   15 = ante / dead-blind / sit-down post
// Round 1 (preflop) and Round 2/3/4 (flop/turn/river):
//   0  = fold
//   3  = CALL  (always — never a bet/raise on any street)
//   4  = check
//   5  = BET   (opens action on a postflop street; preflop NEVER uses 5 because BB is "the bet")
//   7  = ALL-IN (any street: preflop=jam, postflop=shove)
//   23 = RAISE (over an existing bet — preflop opening raise IS type 23 because BB is "the bet")
//
// Critical: preflop, an "open raise" is type=23 (NOT type=5 as the old code assumed).
// Postflop, "bet" = type=5 (no prior bet on street), "raise" = type=23 (over a prior bet).
const PERIOD_CUTOFF_DATE = '2025-07-15';  // splits cash sessions into "good" (before) vs "bad" (>=)

const parseAmt = (s) => parseFloat((s || '0').replace(/[^0-9.\-]/g, '')) || 0;

function det(els, tag) { const e = els.getElementsByTagName(tag); return e.length ? (e[0].textContent || '').trim() : ''; }

// Empty position-stat record used for both main aggregator and period sub-aggregators
function makePosStat() {
  return {hands:0,vpip:0,pfr:0,limp:0,three_bet:0,three_bet_opp:0,cold_call:0,cold_call_opp:0,fold_vs_raise:0,fold_vs_raise_opp:0,fold_to_3bet:0,fold_to_3bet_opp:0,call_3bet:0,four_bet:0,four_bet_opp:0,iso_raise:0,iso_opp:0,overlimp:0,overlimp_opp:0,squeeze:0,squeeze_opp:0,rfi:0,rfi_opp:0,open_sizes:[]};
}
function makePreAcc() {
  return { BTN:makePosStat(), CO:makePosStat(), HJ:makePosStat(), UTG:makePosStat(), SB:makePosStat(), BB:makePosStat() };
}
function makePostAcc() {
  return {
    flop:  { saw:0, bets:0, raises:0, calls:0, folds:0, checks:0, cbet:0, cbet_opp:0, cbet_ip:0, cbet_opp_ip:0, cbet_oop:0, cbet_opp_oop:0, fold_to_cbet:0, fold_to_cbet_opp:0, xr:0, xr_opp:0, xc:0, xf:0, donk:0, donk_opp:0, probe:0, probe_opp:0, wtsd:0, wsd:0 },
    turn:  { saw:0, bets:0, raises:0, calls:0, folds:0, checks:0, cbet:0, cbet_opp:0, fold_to_bet:0, faced_bet:0, xr:0, xr_opp:0, call_bet:0, raise_bet:0, probe:0, probe_opp:0 },
    river: { saw:0, bets:0, raises:0, calls:0, folds:0, checks:0, fold_to_bet:0, faced_bet:0, call_bet:0, raise_bet:0, bet_first:0 }
  };
}
function makePeriod(label) {
  return { label, hands:0, pnl:0, sessions:0, rake:0, dates:[], pre: makePreAcc(), post: makePostAcc(), post_by_pos: {}, weekly: {}, by_stakes: {}, limp_count:0, limp_pnl_bb:0 };
}

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
  pre: makePreAcc(),
  limp_pnl_bb: 0, limp_count: 0,

  // Postflop overall
  post: makePostAcc(),
  post_by_pos: {},  // pos -> { saw_flop, saw_turn, saw_river, cbet, cbet_opp, fold_to_cbet, fold_to_cbet_opp, wtsd, wsd }

  // Period split (good vs bad) - only populated for cash agg
  period_split: {
    cutoff: PERIOD_CUTOFF_DATE,
    good: makePeriod('good'),
    bad:  makePeriod('bad')
  },
  hands_no_pos: 0,  // hands where dealer/seat could not be resolved

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
  // Order from dealer: BTN, SB, BB, then early→late positions
  // Convention: shorter tables drop EARLY positions first (UTG, then HJ).
  //   6-handed: BTN, SB, BB, UTG, HJ, CO   ← classic
  //   5-handed: BTN, SB, BB, HJ, CO        ← UTG dropped (early-pos role merges into HJ)
  //   4-handed: BTN, SB, BB, CO            ← UTG and HJ both dropped
  //   3-handed: BTN, SB, BB
  //   2-handed (HU): BTN/SB, BB
  let posNames;
  if (n >= 6) posNames = ['BTN','SB','BB','UTG','HJ','CO'];
  else if (n === 5) posNames = ['BTN','SB','BB','HJ','CO'];
  else if (n === 4) posNames = ['BTN','SB','BB','CO'];
  else if (n === 3) posNames = ['BTN','SB','BB'];
  else if (n === 2) posNames = ['BTN','BB']; // BTN is also SB heads-up
  else return {};

  // For tables larger than 6 (rare on iPoker PLO 6-max but defensive),
  // pad with extra UTG slots so we don't drop the hand entirely.
  while (posNames.length < n) posNames.splice(3, 0, 'UTG');

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

    // Payment method: <buyin>Token</buyin> = paid with rakeback ticket (no real cash out)
    // Else format like "€0 + €0.07 + €0.93" = real cash buy-in (prize+rake+bounty)
    const buyinRaw = det(gen, 'buyin');
    const paidWith = /token/i.test(buyinRaw) ? 'ticket' : 'cash';
    const cashInvested = paidWith === 'cash' ? invested : 0;
    const ticketInvested = paidWith === 'ticket' ? invested : 0;
    // Real money P&L: cash entries count cost vs win normally; ticket entries count win as pure profit (no cash out)
    const cashNet = paidWith === 'cash' ? net : winAmt;

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
      paidWith, cashInvested, ticketInvested, cashNet,
      itm: winAmt > 0
    });

    // tagg.total_pnl uses CASH-only P&L (real money out of pocket basis)
    // Tickets that win cash = pure profit; tickets that lose = €0 cost
    tagg.total_sessions++;
    tagg.total_pnl += cashNet;        // real-money tournament P&L
    tagg.total_hands += games.length;
    tagg.hand_dates.push(date);
    tagg.sessions.push({ pnl: Math.round(cashNet*100)/100, hands: games.length, date: startStr, stakes: format, dow, hour, tablesize });
    tagg.by_month[ym] = tagg.by_month[ym] || { hands:0, pnl:0, sessions:0 };
    tagg.by_month[ym].hands += games.length; tagg.by_month[ym].pnl += cashNet; tagg.by_month[ym].sessions++;
    tagg.by_stakes[format] = tagg.by_stakes[format] || { hands:0, pnl:0, sessions:0 };
    tagg.by_stakes[format].hands += games.length; tagg.by_stakes[format].pnl += cashNet; tagg.by_stakes[format].sessions++;
    tagg.by_dow[dow].p += cashNet; tagg.by_dow[dow].h += games.length; tagg.by_dow[dow].s++;
    tagg.by_hour[hour] = tagg.by_hour[hour] || { p:0, h:0, s:0 };
    tagg.by_hour[hour].p += cashNet; tagg.by_hour[hour].h += games.length; tagg.by_hour[hour].s++;
    const tWeekStart = new Date(date); const tDay = tWeekStart.getDay(); const tDiff = tDay === 0 ? -6 : 1 - tDay; tWeekStart.setDate(tWeekStart.getDate() + tDiff);
    const tWkKey = tWeekStart.toISOString().slice(0,10);
    tagg.weekly[tWkKey] = tagg.weekly[tWkKey] || { hands:0, pnl:0 };
    tagg.weekly[tWkKey].hands += games.length; tagg.weekly[tWkKey].pnl += cashNet;

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

  // === Period assignment (good vs bad) based on session date ===
  const sessionDateStr = date.toISOString().slice(0,10); // YYYY-MM-DD
  const period = sessionDateStr < PERIOD_CUTOFF_DATE ? agg.period_split.good : agg.period_split.bad;

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

  // Period totals
  period.sessions++;
  period.hands += games.length;
  period.pnl += sessionPnl;
  period.dates.push(sessionDateStr);
  period.by_stakes[stakesKey] = period.by_stakes[stakesKey] || { hands:0, pnl:0, sessions:0 };
  period.by_stakes[stakesKey].hands += games.length; period.by_stakes[stakesKey].pnl += sessionPnl; period.by_stakes[stakesKey].sessions++;

  // Weekly bucket (Monday)
  const weekStart = new Date(date); const day = weekStart.getDay(); const diff = day === 0 ? -6 : 1 - day; weekStart.setDate(weekStart.getDate() + diff);
  const wkKey = weekStart.toISOString().slice(0,10);
  agg.weekly[wkKey] = agg.weekly[wkKey] || { hands:0, pnl:0 };
  agg.weekly[wkKey].hands += games.length; agg.weekly[wkKey].pnl += sessionPnl;
  period.weekly[wkKey] = period.weekly[wkKey] || { hands:0, pnl:0 };
  period.weekly[wkKey].hands += games.length; period.weekly[wkKey].pnl += sessionPnl;

  // Per-hand parsing — pass period sub-aggregator so VPIP/PFR etc. are tracked per period too
  for (let g = 0; g < games.length; g++) {
    parseHand(games[g], bbSize, agg, period);
  }
}

function parseHand(gameEl, bbSize, agg, periodAgg) {
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
  if (dealerSeat === -1) { agg.hands_no_pos = (agg.hands_no_pos||0) + 1; return; }

  const seatToPos = assignPositions(playersList, dealerSeat);
  const heroSeat = playersList.find(p => p.name === HERO)?.seat;
  const heroPos = seatToPos[heroSeat];
  if (!heroPos || !agg.pre[heroPos]) { agg.hands_no_pos = (agg.hands_no_pos||0) + 1; return; }

  agg.pre[heroPos].hands++;
  if (periodAgg && periodAgg.pre[heroPos]) periodAgg.pre[heroPos].hands++;

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
  // Action types in iPoker preflop:
  //   0 = fold | 3 = call (any size — limp or call vs raise) | 4 = check (BB option) |
  //   23 = raise | 7 = all-in | 1/2/15 = blind/ante posts (skip)
  const preflop = roundActions[1] || [];
  const PRE_RAISE = (t) => (t === '23' || t === '7');  // raise or all-in
  const PRE_CALL  = (t) => (t === '3');                 // call (limp or vs raise)
  const PRE_CHECK = (t) => (t === '4');
  const PRE_FOLD  = (t) => (t === '0');
  const PRE_VOL   = (t) => PRE_CALL(t) || PRE_RAISE(t); // any voluntary money in

  let heroVPIP = false, heroPFR = false, heroLimped = false, heroFolded = false;
  let heroRaiseSize = 0;
  let limpsBeforeHero = 0, raisesBeforeHero = 0, callersBeforeHero = 0;
  let heroFacedRaise = false;
  let raiseCount = 0; // 1 = open, 2 = 3-bet, 3 = 4-bet
  let firstHeroIdx = -1;

  for (let i = 0; i < preflop.length; i++) {
    const ac = preflop[i];
    const t = ac.type;
    if (ac.player === HERO) {
      if (firstHeroIdx === -1) firstHeroIdx = i;
      if (PRE_FOLD(t))       heroFolded = true;
      else if (PRE_CHECK(t)) { /* BB option */ }
      else if (PRE_CALL(t)) {
        heroVPIP = true;
        if (raiseCount === 0) heroLimped = true;  // call before any raise = limp
      } else if (PRE_RAISE(t)) {
        heroVPIP = true; heroPFR = true;
        heroRaiseSize = ac.sum;
        raiseCount++;
      }
    } else {
      if (firstHeroIdx === -1) {
        // Opponent action BEFORE hero acts
        if (PRE_RAISE(t))      { raisesBeforeHero++; raiseCount = 1; }
        else if (PRE_CALL(t)) {
          if (raisesBeforeHero === 0) limpsBeforeHero++;
          else                        callersBeforeHero++; // cold-caller of an open
        }
      } else {
        // Opponent action AFTER hero — track raise count for fold-to-3bet detection
        if (PRE_RAISE(t)) raiseCount++;
      }
    }
  }
  if (raisesBeforeHero > 0) heroFacedRaise = true;

  // === Position-specific aggregates (mirror to periodAgg if present) ===
  const posAgg  = agg.pre[heroPos];
  const posAggP = periodAgg ? periodAgg.pre[heroPos] : null;
  const bumpPos = (k, n=1) => { posAgg[k] += n; if (posAggP) posAggP[k] += n; };

  if (heroVPIP) bumpPos('vpip');
  if (heroPFR)  bumpPos('pfr');
  if (heroLimped) {
    bumpPos('limp');
    agg.limp_count++; agg.limp_pnl_bb += heroNet / bbSize;
    if (periodAgg) { periodAgg.limp_count++; periodAgg.limp_pnl_bb += heroNet / bbSize; }
  }

  // RFI: hero opens (raises) when no one has voluntarily put money in
  // (excludes BB — BB doesn't "open" in the conventional sense)
  if (heroPos !== 'BB') {
    if (limpsBeforeHero === 0 && raisesBeforeHero === 0) {
      bumpPos('rfi_opp');
      if (heroPFR && raiseCount === 1) {
        bumpPos('rfi');
        posAgg.open_sizes.push(heroRaiseSize / bbSize);
        if (posAggP) posAggP.open_sizes.push(heroRaiseSize / bbSize);
      }
    }
  }

  // 3-bet opportunity: faced an open-raise before acting
  if (heroFacedRaise && raisesBeforeHero === 1) {
    bumpPos('three_bet_opp');
    if (heroPFR) bumpPos('three_bet');
    // cold call: facing a raise, no money in pot yet (excludes blinds)
    if (heroPos !== 'SB' && heroPos !== 'BB') {
      bumpPos('cold_call_opp');
      if (heroVPIP && !heroPFR) bumpPos('cold_call');
    }
    // fold vs raise (separate metric)
    bumpPos('fold_vs_raise_opp');
    if (heroFolded) bumpPos('fold_vs_raise');
  }
  // squeeze: faced raise + ≥1 cold-caller
  if (heroFacedRaise && raisesBeforeHero === 1 && callersBeforeHero >= 1) {
    bumpPos('squeeze_opp');
    if (heroPFR) bumpPos('squeeze');
  }
  // iso raise / overlimp: faced limp(s) only (no raise yet)
  if (raisesBeforeHero === 0 && limpsBeforeHero >= 1 && heroPos !== 'BB') {
    bumpPos('iso_opp');
    bumpPos('overlimp_opp');
    if (heroPFR) bumpPos('iso_raise');
    if (heroVPIP && !heroPFR) bumpPos('overlimp');
  }
  // Fold to 3-bet: hero opened, faced a 3-bet (raise after hero's open)
  if (heroPFR && raiseCount >= 2) {
    let saw3bet = false, hero3betAct = null;
    for (let i = firstHeroIdx + 1; i < preflop.length; i++) {
      const ac = preflop[i];
      if (ac.player !== HERO) {
        if (PRE_RAISE(ac.type)) saw3bet = true;
      } else if (saw3bet) { hero3betAct = ac.type; break; }
    }
    if (saw3bet) {
      bumpPos('fold_to_3bet_opp');
      bumpPos('four_bet_opp');
      if (hero3betAct && PRE_FOLD(hero3betAct)) bumpPos('fold_to_3bet');
      if (hero3betAct && PRE_CALL(hero3betAct)) bumpPos('call_3bet');
      if (hero3betAct && PRE_RAISE(hero3betAct)) bumpPos('four_bet');
    }
  }

  // === HAND QUALITY: was hero "played"? ===
  if (hqCat && heroVPIP) {
    agg.hq[hqCat].played++;
    agg.hq[hqCat].total_pnl_bb += heroNet / bbSize;
  }

  // === POSTFLOP ANALYSIS ===
  // Action types in iPoker postflop:
  //   0 = fold | 3 = call | 4 = check | 5 = BET (no prior bet on street) |
  //   23 = RAISE (over a prior bet) | 7 = all-in (bet or raise depending on prior action)
  const POST_BET   = (t) => (t === '5');
  const POST_RAISE = (t) => (t === '23');
  const POST_CALL  = (t) => (t === '3');
  const POST_CHECK = (t) => (t === '4');
  const POST_FOLD  = (t) => (t === '0');
  const POST_ALLIN = (t) => (t === '7');
  const POST_AGG   = (t) => POST_BET(t) || POST_RAISE(t) || POST_ALLIN(t);  // any aggressive action

  // Did hero see flop / turn / river?
  const sawFlop = !heroFolded && (roundActions[2] && roundActions[2].length > 0);
  const sawTurn = !heroFolded && (roundActions[3] && roundActions[3].length > 0);
  const sawRiver = !heroFolded && (roundActions[4] && roundActions[4].length > 0);

  // Init by-position postflop accumulator
  const initBP = (target) => { target[heroPos] = target[heroPos] || { saw_flop:0, saw_turn:0, saw_river:0, cbet:0, cbet_opp:0, fold_to_cbet:0, fold_to_cbet_opp:0, wtsd:0, wsd:0 }; };
  initBP(agg.post_by_pos);
  if (periodAgg) initBP(periodAgg.post_by_pos);

  const bumpFlop  = (k, n=1) => { agg.post.flop[k]  += n; if (periodAgg) periodAgg.post.flop[k]  += n; };
  const bumpTurn  = (k, n=1) => { agg.post.turn[k]  += n; if (periodAgg) periodAgg.post.turn[k]  += n; };
  const bumpRiver = (k, n=1) => { agg.post.river[k] += n; if (periodAgg) periodAgg.post.river[k] += n; };
  const bumpBP    = (k, n=1) => { agg.post_by_pos[heroPos][k] += n; if (periodAgg) periodAgg.post_by_pos[heroPos][k] += n; };

  // IP = hero acted last preflop (BTN typically, CO if no raise from BTN)
  const isIP = heroPos === 'BTN' || (heroPos === 'CO' && raisesBeforeHero === 0);

  // === FLOP ===
  if (sawFlop) {
    bumpFlop('saw'); bumpBP('saw_flop');
    const flopActs = roundActions[2];
    let heroFoldedFlop = false, heroBetFlop = false, heroCheckedFlop = false, heroRaisedFlop = false, heroCalledFlop = false;
    let oppBetFirst = false; let heroIdxFlop = -1;
    for (let i = 0; i < flopActs.length; i++) {
      const ac = flopActs[i];
      if (ac.player === HERO) {
        if (heroIdxFlop === -1) heroIdxFlop = i;
        if (POST_FOLD(ac.type))  heroFoldedFlop  = true;
        if (POST_CHECK(ac.type)) heroCheckedFlop = true;
        if (POST_CALL(ac.type))  heroCalledFlop  = true;
        if (POST_AGG(ac.type)) {
          // Determine if this was a bet (no prior agg on street) or a raise (over prior agg)
          let aggBefore = false;
          for (let j = 0; j < i; j++) if (POST_AGG(flopActs[j].type) && flopActs[j].sum > 0) { aggBefore = true; break; }
          if (aggBefore || POST_RAISE(ac.type)) heroRaisedFlop = true;
          else                                  heroBetFlop = true;
        }
      } else if (heroIdxFlop === -1 && POST_AGG(ac.type) && ac.sum > 0) {
        oppBetFirst = true;
      }
    }
    if (heroBetFlop)     bumpFlop('bets');
    if (heroRaisedFlop)  bumpFlop('raises');
    if (heroCalledFlop)  bumpFlop('calls');
    if (heroFoldedFlop)  bumpFlop('folds');
    if (heroCheckedFlop) bumpFlop('checks');

    // C-bet: hero was PFR, has opportunity (any flop seen as PFR), bet on first action without opp betting first
    if (heroPFR) {
      bumpFlop('cbet_opp'); bumpBP('cbet_opp');
      if (isIP) bumpFlop('cbet_opp_ip'); else bumpFlop('cbet_opp_oop');
      if (heroBetFlop && !oppBetFirst) {
        bumpFlop('cbet'); bumpBP('cbet');
        if (isIP) bumpFlop('cbet_ip'); else bumpFlop('cbet_oop');
      }
    }
    // Fold to c-bet: hero NOT PFR, faced an opponent bet
    if (!heroPFR && heroVPIP && oppBetFirst) {
      bumpFlop('fold_to_cbet_opp'); bumpBP('fold_to_cbet_opp');
      if (heroFoldedFlop) { bumpFlop('fold_to_cbet'); bumpBP('fold_to_cbet'); }
    }
    // Check-raise / check-call / check-fold (only when hero checked at least once)
    if (heroCheckedFlop) {
      bumpFlop('xr_opp');
      if (heroRaisedFlop)      bumpFlop('xr');
      else if (heroCalledFlop) bumpFlop('xc');
      else if (heroFoldedFlop) bumpFlop('xf');
    }
    // Donk: hero NOT PFR, OOP, bet first
    if (!heroPFR && heroVPIP && !isIP) {
      bumpFlop('donk_opp');
      if (heroBetFlop && heroIdxFlop === 0) bumpFlop('donk');
    }

    // WTSD / WSD
    if (sawRiver) {
      const riverActs = roundActions[4] || [];
      const turnActs = roundActions[3] || [];
      let heroReachedSD = !heroFoldedFlop;
      for (let i = 0; i < turnActs.length; i++)  if (turnActs[i].player === HERO  && POST_FOLD(turnActs[i].type))  { heroReachedSD = false; break; }
      for (let i = 0; i < riverActs.length; i++) if (riverActs[i].player === HERO && POST_FOLD(riverActs[i].type)) { heroReachedSD = false; break; }
      if (heroReachedSD) {
        let oppReveal = false;
        for (let c = 0; c < cardsEls.length; c++) {
          if (cardsEls[c].getAttribute('type') !== 'Pocket') continue;
          if (cardsEls[c].getAttribute('player') === HERO) continue;
          const txt = (cardsEls[c].textContent || '').trim();
          if (txt && !txt.startsWith('X')) { oppReveal = true; break; }
        }
        if (oppReveal) {
          bumpFlop('wtsd'); bumpBP('wtsd');
          if (heroNet > 0) { bumpFlop('wsd'); bumpBP('wsd'); }
        }
      }
    }
  }

  // === TURN ===
  if (sawTurn) {
    bumpTurn('saw'); bumpBP('saw_turn');
    const turnActs = roundActions[3];
    let heroBetTurn = false, heroCheckedTurn = false, heroFoldedTurn = false, heroCalledTurn = false, heroRaisedTurn = false;
    let oppBetFirstTurn = false; let heroIdxTurn = -1;
    for (let i = 0; i < turnActs.length; i++) {
      const ac = turnActs[i];
      if (ac.player === HERO) {
        if (heroIdxTurn === -1) heroIdxTurn = i;
        if (POST_CHECK(ac.type)) heroCheckedTurn = true;
        if (POST_FOLD(ac.type))  heroFoldedTurn  = true;
        if (POST_CALL(ac.type))  heroCalledTurn  = true;
        if (POST_AGG(ac.type)) {
          let aggBefore = false;
          for (let j = 0; j < i; j++) if (POST_AGG(turnActs[j].type) && turnActs[j].sum > 0) { aggBefore = true; break; }
          if (aggBefore || POST_RAISE(ac.type)) heroRaisedTurn = true;
          else                                  heroBetTurn = true;
        }
      } else if (heroIdxTurn === -1 && POST_AGG(ac.type) && ac.sum > 0) {
        oppBetFirstTurn = true;
      }
    }
    if (heroBetTurn)     bumpTurn('bets');
    if (heroRaisedTurn)  bumpTurn('raises');
    if (heroCalledTurn)  bumpTurn('calls');
    if (heroFoldedTurn)  bumpTurn('folds');
    if (heroCheckedTurn) bumpTurn('checks');
    if (oppBetFirstTurn) {
      bumpTurn('faced_bet');
      if (heroFoldedTurn) bumpTurn('fold_to_bet');
      if (heroCalledTurn) bumpTurn('call_bet');
      if (heroRaisedTurn) bumpTurn('raise_bet');
    }
  }

  // === RIVER ===
  if (sawRiver) {
    bumpRiver('saw'); bumpBP('saw_river');
    const rivActs = roundActions[4];
    let heroBetRiv = false, heroFoldedRiv = false, heroCalledRiv = false, heroRaisedRiv = false;
    let heroCheckedRiv = false;
    let oppBetFirstRiv = false; let heroIdxRiv = -1; let heroBetFirstRiv = false;
    for (let i = 0; i < rivActs.length; i++) {
      const ac = rivActs[i];
      if (ac.player === HERO) {
        if (heroIdxRiv === -1) heroIdxRiv = i;
        if (POST_FOLD(ac.type))  heroFoldedRiv  = true;
        if (POST_CHECK(ac.type)) heroCheckedRiv = true;
        if (POST_CALL(ac.type))  heroCalledRiv  = true;
        if (POST_AGG(ac.type)) {
          let aggBefore = false;
          for (let j = 0; j < i; j++) if (POST_AGG(rivActs[j].type) && rivActs[j].sum > 0) aggBefore = true;
          if (aggBefore || POST_RAISE(ac.type)) heroRaisedRiv = true;
          else { heroBetRiv = true; if (!oppBetFirstRiv) heroBetFirstRiv = true; }
        }
      } else if (heroIdxRiv === -1 && POST_AGG(ac.type) && ac.sum > 0) {
        oppBetFirstRiv = true;
      }
    }
    if (heroBetRiv)      bumpRiver('bets');
    if (heroBetFirstRiv) bumpRiver('bet_first');
    if (heroRaisedRiv)   bumpRiver('raises');
    if (heroCalledRiv)   bumpRiver('calls');
    if (heroFoldedRiv)   bumpRiver('folds');
    if (heroCheckedRiv)  bumpRiver('checks');
    if (oppBetFirstRiv) {
      bumpRiver('faced_bet');
      if (heroFoldedRiv) bumpRiver('fold_to_bet');
      if (heroCalledRiv) bumpRiver('call_bet');
      if (heroRaisedRiv) bumpRiver('raise_bet');
    }
  }

  // === OPPONENT TRACKING (uses corrected action types) ===
  for (const p of playersList) {
    if (p.name === HERO) continue;
    const o = agg.opps[p.name] = agg.opps[p.name] || { hands:0, vpip:0, vpip_opp:0, pfr:0, pfr_opp:0, three_bet:0, three_bet_opp:0, af_b_r:0, af_c:0, hero_pnl_bb:0, hero_pnl_eur:0 };
    o.hands++;
    // Opponent VPIP/PFR from preflop actions (corrected: type 3 = call, type 23/7 = raise)
    let oVPIP = false, oPFR = false;
    const pf = roundActions[1] || [];
    for (let i = 0; i < pf.length; i++) {
      if (pf[i].player !== p.name) continue;
      const t = pf[i].type;
      if (PRE_CALL(t) || PRE_RAISE(t)) oVPIP = true;
      if (PRE_RAISE(t))                oPFR  = true;
    }
    o.vpip_opp++; if (oVPIP) o.vpip++;
    o.pfr_opp++;  if (oPFR)  o.pfr++;
    // Postflop AF for opponent (bets+raises / calls)
    for (let r = 2; r <= 4; r++) {
      const ra = roundActions[r] || [];
      for (let i = 0; i < ra.length; i++) {
        if (ra[i].player !== p.name) continue;
        if (POST_AGG(ra[i].type))  o.af_b_r++;
        if (POST_CALL(ra[i].type)) o.af_c++;
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

  // === Merge any browser-exported tournaments saved as data/browser-tournaments*.json ===
  // Prevents the localStorage-only data loss when user imports tournaments via the
  // dashboard drop-zone but never moves the original zips into data/.
  const extraJsons = fs.readdirSync(DATA_DIR).filter(f => /^browser-tournaments.*\.json$/i.test(f));
  if (extraJsons.length > 0) {
    console.log(`\n=== Browser-exported tournament JSON ===`);
    const seenTournCodes = new Set(tournamentSessions.map(t => t.code));
    let added = 0, skippedDup = 0;
    for (const jf of extraJsons) {
      try {
        const raw = fs.readFileSync(path.join(DATA_DIR, jf), 'utf8');
        const obj = JSON.parse(raw);
        const list = Array.isArray(obj) ? obj : (obj.tournaments || []);
        console.log(`→ ${jf}: ${list.length} entries`);
        for (const t of list) {
          if (!t.code) continue;
          if (seenTournCodes.has(t.code)) { skippedDup++; continue; }
          seenTournCodes.add(t.code);

          // Reconstruct fields the parser would have created
          const totalBuyin = +t.totalBuyin || 0;
          const invested = +t.invested || totalBuyin || 0;
          const winAmt = +t.win || 0;
          const place = +t.place || 0;
          const paidWith = t.paidWith === 'ticket' ? 'ticket' : 'cash';
          const cashInvested = paidWith === 'cash' ? invested : 0;
          const ticketInvested = paidWith === 'ticket' ? invested : 0;
          const net = winAmt - invested;
          const cashNet = paidWith === 'cash' ? net : winAmt;
          const tName = t.name || 'Unknown';
          const format = t.format || 'MTT';
          const startStr = t.date || '';
          const dm = startStr.match(/(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})/);
          let date = null, ym = '', dow = 'Monday', hour = 12;
          if (dm) {
            date = new Date(`${dm[3]}-${dm[1]}-${dm[2]}T${dm[4]}:${dm[5]}:00`);
            if (!isNaN(date)) {
              ym = `${dm[3]}-${dm[1]}`;
              dow = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][date.getDay()];
              hour = date.getHours();
            }
          }
          if (!date || isNaN(date)) continue;

          tournamentSessions.push({
            code: t.code, name: tName, format,
            totalBuyin, rebuys: 0, totalRebuyCost: 0, addon: 0, totalAddonCost: 0,
            win: winAmt, place, gamecount: 0, tablesize: 6, date: startStr,
            dow, hour, ym, currency: 'EUR', invested, net,
            paidWith, cashInvested, ticketInvested, cashNet,
            itm: winAmt > 0,
            _source: 'browser-export'
          });
          tagg.total_sessions++;
          tagg.total_pnl += cashNet;
          // No hand count in browser exports — leave total_hands untouched
          tagg.hand_dates.push(date);
          tagg.sessions.push({ pnl: Math.round(cashNet*100)/100, hands: 0, date: startStr, stakes: format, dow, hour, tablesize: 6 });
          tagg.by_month[ym] = tagg.by_month[ym] || { hands:0, pnl:0, sessions:0 };
          tagg.by_month[ym].pnl += cashNet; tagg.by_month[ym].sessions++;
          tagg.by_stakes[format] = tagg.by_stakes[format] || { hands:0, pnl:0, sessions:0 };
          tagg.by_stakes[format].pnl += cashNet; tagg.by_stakes[format].sessions++;
          tagg.by_dow[dow].p += cashNet; tagg.by_dow[dow].s++;
          tagg.by_hour[hour] = tagg.by_hour[hour] || { p:0, h:0, s:0 };
          tagg.by_hour[hour].p += cashNet; tagg.by_hour[hour].s++;
          const tWeekStart = new Date(date); const tDay = tWeekStart.getDay(); const tDiff = tDay === 0 ? -6 : 1 - tDay; tWeekStart.setDate(tWeekStart.getDate() + tDiff);
          const tWkKey = tWeekStart.toISOString().slice(0,10);
          tagg.weekly[tWkKey] = tagg.weekly[tWkKey] || { hands:0, pnl:0 };
          tagg.weekly[tWkKey].pnl += cashNet;
          added++;
        }
      } catch (e) { console.log(`  ! failed to load ${jf}: ${e.message}`); }
    }
    console.log(`Browser-export merge: +${added} new tournaments, ${skippedDup} skipped (already in zips)`);
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
      four_bet: pct(a.four_bet, a.four_bet_opp),
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

  // ====== PERIOD COMPARISON (Good vs Bad split at PERIOD_CUTOFF_DATE) ======
  function computePeriodSnapshot(P) {
    if (!P || P.hands === 0) {
      return { dates: 'N/A', pnl_eur: 0, hands: 0, bb_per_100: 0, sessions: 0, stats: null };
    }
    const datesSorted = [...P.dates].sort();
    const fmtD = (s) => s; // already YYYY-MM-DD
    // Weighted avg BB for this period
    let wH = 0, wBB = 0;
    for (const [stk, v] of Object.entries(P.by_stakes)) {
      const m = stk.match(/€?([\d.]+)\s*\/\s*€?([\d.]+)/);
      if (m) { wBB += parseFloat(m[2]) * v.hands; wH += v.hands; }
    }
    const periodAvgBB = wH > 0 ? wBB / wH : avgBB;
    const bb100p = P.hands > 0 ? Math.round(((P.pnl / periodAvgBB) / (P.hands / 100)) * 100) / 100 : 0;
    // Aggregate preflop totals
    let tH=0, tV=0, tP=0, tL=0, t3=0, t3o=0, tCC=0, tCCo=0, tF3=0, tF3o=0, tFR=0, tFRo=0, t4=0, t4o=0, tRfi=0, tRfio=0;
    let allOpens = [];
    const periodPreByPos = {};
    for (const [pos, a] of Object.entries(P.pre)) {
      tH += a.hands; tV += a.vpip; tP += a.pfr; tL += a.limp;
      t3 += a.three_bet; t3o += a.three_bet_opp;
      tCC += a.cold_call; tCCo += a.cold_call_opp;
      tF3 += a.fold_to_3bet; tF3o += a.fold_to_3bet_opp;
      tFR += a.fold_vs_raise; tFRo += a.fold_vs_raise_opp;
      t4 += a.four_bet; t4o += a.four_bet_opp;
      tRfi += a.rfi; tRfio += a.rfi_opp;
      allOpens = allOpens.concat(a.open_sizes);
      periodPreByPos[pos] = {
        hands: a.hands,
        vpip: pct(a.vpip, a.hands), pfr: pct(a.pfr, a.hands),
        rfi: pct(a.rfi, a.rfi_opp), limp: pct(a.limp, a.hands),
        three_bet: pct(a.three_bet, a.three_bet_opp),
        cold_call: pct(a.cold_call, a.cold_call_opp),
        fold_vs_raise: pct(a.fold_vs_raise, a.fold_vs_raise_opp),
        fold_to_3bet: pct(a.fold_to_3bet, a.fold_to_3bet_opp),
        call_3bet: pct(a.call_3bet, a.fold_to_3bet_opp),
        four_bet: pct(a.four_bet, a.four_bet_opp),
        iso_raise: pct(a.iso_raise, a.iso_opp),
        overlimp: pct(a.overlimp, a.overlimp_opp),
        squeeze: pct(a.squeeze, a.squeeze_opp)
      };
    }
    const flP = P.post.flop, tuP = P.post.turn, riP = P.post.river;
    const afP = (flP.bets+flP.raises+tuP.bets+tuP.raises+riP.bets+riP.raises) / Math.max(1, flP.calls+tuP.calls+riP.calls);
    const avgOpenBB = allOpens.length > 0 ? Math.round((allOpens.reduce((s,x)=>s+x,0) / allOpens.length) * 100) / 100 : 0;
    return {
      dates: `${fmtD(datesSorted[0])} → ${fmtD(datesSorted[datesSorted.length-1])}`,
      pnl_eur: Math.round(P.pnl * 100) / 100,
      hands: P.hands,
      bb_per_100: bb100p,
      sessions: P.sessions,
      stats: {
        hands: tH,
        vpip: pct(tV, tH),
        pfr: pct(tP, tH),
        vpip_pfr_gap: Math.round((pct(tV, tH) - pct(tP, tH)) * 10) / 10,
        limp_pct: pct(tL, tH),
        open_raise_pct: pct(tRfi, tRfio),
        three_bet_pct: pct(t3, t3o),
        cold_call_pct: pct(tCC, tCCo),
        fold_to_3bet_pct: pct(tF3, tF3o),
        four_bet_pct: pct(t4, t4o),
        fold_vs_raise_pct: pct(tFR, tFRo),
        cbet_flop_pct: pct(flP.cbet, flP.cbet_opp),
        cbet_turn_pct: pct(tuP.cbet, tuP.cbet_opp),
        donk_bet_pct: pct(flP.donk, flP.donk_opp),
        check_raise_flop_pct: pct(flP.xr, flP.xr_opp),
        fold_to_cbet_pct: pct(flP.fold_to_cbet, flP.fold_to_cbet_opp),
        wtsd_pct: pct(flP.wtsd, flP.saw),
        wsd_pct: pct(flP.wsd, flP.wtsd),
        af: Math.round(afP * 100) / 100,
        river_fold_to_bet_pct: pct(riP.fold_to_bet, riP.faced_bet),
        avg_open_size_bb: avgOpenBB,
        by_position: periodPreByPos
      }
    };
  }
  const goodPeriod = computePeriodSnapshot(agg.period_split.good);
  const badPeriod  = computePeriodSnapshot(agg.period_split.bad);

  // Compute differences (bad - good) for each numeric stat
  // Schema kept compatible with renderer in index.html (diff/direction/impact/note)
  const statDiffs = {};
  const keyChanges = [];
  // Stats where INCREASE = bad (looser leaks, more passive defense)
  const higherIsWorse = new Set(['limp_pct','fold_to_3bet_pct','fold_to_cbet_pct','fold_vs_raise_pct','river_fold_to_bet_pct','donk_bet_pct']);
  // Stats where DECREASE = bad (less aggression, fewer opens, less playing)
  const lowerIsWorse = new Set(['vpip','pfr','three_bet_pct','four_bet_pct','open_raise_pct','cold_call_pct','cbet_flop_pct','cbet_turn_pct','check_raise_flop_pct','wtsd_pct','wsd_pct','af','avg_open_size_bb']);
  function arrowFor(stat, d) {
    if (d === 0) return '→ same';
    const worsened = (d > 0 && higherIsWorse.has(stat)) || (d < 0 && lowerIsWorse.has(stat));
    const improved = (d < 0 && higherIsWorse.has(stat)) || (d > 0 && lowerIsWorse.has(stat));
    if (worsened) return d > 0 ? '↑ worse' : '↓ worse';
    if (improved) return d > 0 ? '↑ better' : '↓ better';
    return d > 0 ? '↑' : '↓';
  }
  if (goodPeriod.stats && badPeriod.stats) {
    for (const k of Object.keys(goodPeriod.stats)) {
      if (typeof goodPeriod.stats[k] !== 'number') continue;
      const d = Math.round((badPeriod.stats[k] - goodPeriod.stats[k]) * 10) / 10;
      statDiffs[k] = { good: goodPeriod.stats[k], bad: badPeriod.stats[k], diff: d, delta: d, direction: arrowFor(k, d) };
      if (Math.abs(d) >= 2 && k !== 'hands') {
        const absD = Math.abs(d);
        const impact = absD >= 5 ? 'critical' : absD >= 3 ? 'major' : 'minor';
        const label = k.replace(/_/g,' ').replace(/pct/g,'%');
        const note = `${label}: ${goodPeriod.stats[k]} → ${badPeriod.stats[k]} (${d > 0 ? '+' : ''}${d})`;
        keyChanges.push({ stat: k, good: goodPeriod.stats[k], bad: badPeriod.stats[k], delta: d, diff: d, impact, note });
      }
    }
    keyChanges.sort((a,b) => Math.abs(b.delta) - Math.abs(a.delta));
  }

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
      _description: `Cash sessions split at ${PERIOD_CUTOFF_DATE}. "good" = before cutoff, "bad" = on/after.`,
      cutoff_date: PERIOD_CUTOFF_DATE,
      good_period: goodPeriod,
      bad_period: badPeriod,
      stat_differences: statDiffs,
      key_changes: keyChanges.slice(0, 10),
      target_stats_from_good_period: goodPeriod.stats || { _description: 'No good-period data', vpip: overallVPIP, pfr: overallPFR, vpip_pfr_gap: overallVPIP-overallPFR, limp_pct: overallLimp, three_bet_pct: overall3bet, cbet_flop_pct: postComp.flop.cbet_pct, donk_bet_pct: postComp.flop.donk_pct, check_raise_flop_pct: postComp.flop.xr_pct, af: Math.round(af*100)/100, by_position: preByPos }
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
  const cashE = tournamentSessions.filter(t => t.paidWith === 'cash');
  const tickE = tournamentSessions.filter(t => t.paidWith === 'ticket');
  const cashInvT = cashE.reduce((s,t)=>s+t.invested,0);
  const tickInvT = tickE.reduce((s,t)=>s+t.invested,0);
  const cashWonC = cashE.reduce((s,t)=>s+t.win,0);
  const cashWonT = tickE.reduce((s,t)=>s+t.win,0);
  console.log(`Tournaments entered: ${tournamentSessions.length} (cash buy-ins: ${cashE.length}, ticket entries: ${tickE.length})`);
  console.log(`-- Cash buy-ins --`);
  console.log(`  Real money invested: €${cashInvT.toFixed(2)}`);
  console.log(`  Cashed:              €${cashWonC.toFixed(2)}`);
  console.log(`  Net (real money):    €${(cashWonC - cashInvT).toFixed(2)}`);
  console.log(`-- Ticket entries (€0 real money cost) --`);
  console.log(`  Ticket value used:   €${tickInvT.toFixed(2)}  (rakeback tickets, not real €)`);
  console.log(`  Cashed (pure profit):€${cashWonT.toFixed(2)}`);
  console.log(`-- TOTAL real-money tournament P&L: €${tagg.total_pnl.toFixed(2)} --`);
  console.log(`Tournament hands:    ${tagg.total_hands}`);
  console.log(`\n=== COMBINED (real money) ===`);
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

  // === Cash vs Ticket split ===
  const cashEntries   = T.filter(t => t.paidWith === 'cash');
  const ticketEntries = T.filter(t => t.paidWith === 'ticket');
  const cashInvestedT   = cashEntries.reduce((s,t) => s + t.invested, 0);   // real € spent
  const ticketInvestedT = ticketEntries.reduce((s,t) => s + t.invested, 0); // ticket face value
  const cashWonFromCash   = cashEntries.reduce((s,t) => s + t.win, 0);
  const cashWonFromTicket = ticketEntries.reduce((s,t) => s + t.win, 0);    // pure profit (no cash out)
  const realMoneyPnl = (cashWonFromCash - cashInvestedT) + cashWonFromTicket;
  const ticketItm   = ticketEntries.filter(t => t.itm).length;
  const cashItm     = cashEntries.filter(t => t.itm).length;
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
    code: t.code, paidWith: t.paidWith,
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
      best_finish_event: bestFinish.name,

      // === Real money vs Ticket breakdown ===
      _payment_note: 'Token entries cost €0 real money but had ticket face value. real_money_pnl_eur is the true out-of-pocket P&L.',
      cash_entries: cashEntries.length,
      cash_invested_eur: Math.round(cashInvestedT*100)/100,
      cash_won_from_cash_entries_eur: Math.round(cashWonFromCash*100)/100,
      cash_entries_net_eur: Math.round((cashWonFromCash - cashInvestedT)*100)/100,
      cash_entries_roi_pct: cashInvestedT > 0 ? Math.round(((cashWonFromCash - cashInvestedT)/cashInvestedT)*1000)/10 : 0,
      cash_entries_itm_pct: pct(cashItm, cashEntries.length),

      ticket_entries: ticketEntries.length,
      ticket_value_eur: Math.round(ticketInvestedT*100)/100,
      cash_won_from_tickets_eur: Math.round(cashWonFromTicket*100)/100,
      ticket_conversion_pct: ticketInvestedT > 0 ? Math.round((cashWonFromTicket/ticketInvestedT)*1000)/10 : 0,
      ticket_entries_itm_pct: pct(ticketItm, ticketEntries.length),

      real_money_pnl_eur: Math.round(realMoneyPnl*100)/100
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
