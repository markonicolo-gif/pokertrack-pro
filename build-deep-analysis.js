/**
 * Build script: Injects deep analysis data + new 9-tab Player Stats view into index.html
 */
const fs = require('fs');
const path = require('path');

const deepData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'platinex_dashboard_complete.json'), 'utf8'));

// Strip the layout/instructions metadata — only keep actual data
delete deepData.dashboard_layout;

let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

// ========== 1. REPLACE PLAYER_STATS_DATA ==========
// IMPORTANT: slice from the FIRST `const DEEP_ANALYSIS` to remove any prior injection,
// so we never end up with two `const DEEP_ANALYSIS` declarations (SyntaxError → blank page).
let dataStart = html.indexOf('const DEEP_ANALYSIS');
if (dataStart === -1) dataStart = html.indexOf('const PLAYER_STATS_DATA = {');
const fnStart = html.indexOf('function renderPlayerStatsView');
if (dataStart === -1 || fnStart === -1) { console.error('Markers not found'); process.exit(1); }

// Find the end of renderPlayerStatsView — it ends just before renderLeakFinderView
const leakFn = html.indexOf('function renderLeakFinderView');
if (leakFn === -1) { console.error('renderLeakFinderView not found'); process.exit(1); }

const beforeData = html.substring(0, dataStart);
const afterView = html.substring(leakFn);

// ========== 2. BUILD NEW DEEP_ANALYSIS_DATA ==========
const dataJS = `const DEEP_ANALYSIS = ${JSON.stringify(deepData, null, 0)};

// Legacy alias for any code that references PLAYER_STATS_DATA
const PLAYER_STATS_DATA = {
  _metadata: DEEP_ANALYSIS._metadata,
  preflop_stats_overall: DEEP_ANALYSIS.preflop.overall,
  postflop_stats: {
    flops_seen: DEEP_ANALYSIS.postflop.flop.wtsd || 0,
    cbet_flop_pct: DEEP_ANALYSIS.postflop.computed_percentages.flop.cbet_pct,
    cbet_turn_pct: DEEP_ANALYSIS.postflop.computed_percentages.turn.cbet_pct,
    fold_to_cbet_flop_pct: DEEP_ANALYSIS.postflop.computed_percentages.flop.fold_to_cbet_pct,
    check_raise_flop_pct: DEEP_ANALYSIS.postflop.computed_percentages.flop.xr_pct,
    donk_bet_flop_pct: DEEP_ANALYSIS.postflop.computed_percentages.flop.donk_pct,
    wtsd_pct: DEEP_ANALYSIS.postflop.computed_percentages.flop.wtsd_pct,
    wsd_pct: DEEP_ANALYSIS.postflop.computed_percentages.flop.wsd_pct,
    aggression_factor: DEEP_ANALYSIS.leak_analysis.find(l => l.leak && l.leak.includes('AF'))?.value || 1.84,
    aggression_breakdown: { flop: { bets: DEEP_ANALYSIS.postflop.flop.bets, raises: DEEP_ANALYSIS.postflop.flop.raises, calls: DEEP_ANALYSIS.postflop.flop.calls }, turn: { bets: DEEP_ANALYSIS.postflop.turn.bets, raises: DEEP_ANALYSIS.postflop.turn.raises, calls: DEEP_ANALYSIS.postflop.turn.calls }, river: { bets: DEEP_ANALYSIS.postflop.river.bets, raises: DEEP_ANALYSIS.postflop.river.raises, calls: DEEP_ANALYSIS.postflop.river.calls } }
  },
  gto_benchmarks_plo_6max: DEEP_ANALYSIS.gto_benchmarks,
  leak_analysis: DEEP_ANALYSIS.leak_analysis,
  strengths: DEEP_ANALYSIS.strengths,
  confidence_levels: DEEP_ANALYSIS._metadata.confidence
};
`;

// ========== 3. BUILD NEW renderPlayerStatsView ==========
const renderFn = `
function renderPlayerStatsView(container) {
  const D = DEEP_ANALYSIS;
  const sessions = getSessions();

  // === Dynamic P&L from sessions ===
  const totalPnl = sessions.reduce((s, x) => s + (x.cashOut - x.buyIn), 0);
  const totalHands = sessions.reduce((s, x) => s + (x.hands || 0), 0);
  const totalRake = sessions.reduce((s, x) => s + (x.rake || 0), 0);
  const totalSessions = sessions.length;
  let bbWeighted = 0, bbHands = 0;
  sessions.forEach(s => { if (s.stakes && s.hands) { const bb = parseFloat(s.stakes.split('/')[1]) || 0; if (bb > 0) { bbWeighted += bb * s.hands; bbHands += s.hands; } } });
  const avgBB = bbHands > 0 ? bbWeighted / bbHands : 0.74;
  const bbPer100 = totalHands > 0 && avgBB > 0 ? (totalPnl / avgBB) / (totalHands / 100) : 0;

  // Dynamic stakes
  const stkG = {};
  sessions.forEach(s => { if (!s.stakes) return; const k = s.stakes; if (!stkG[k]) stkG[k] = { h: 0, p: 0, bb: parseFloat(s.stakes.split('/')[1]) || 1 }; stkG[k].h += (s.hands||0); stkG[k].p += (s.cashOut - s.buyIn); });
  const stakeRows = Object.entries(stkG).map(([k,v]) => ({ label: k, hands: v.h, pnl: Math.round(v.p*100)/100, bb100: v.h > 0 && v.bb > 0 ? (v.p/v.bb)/(v.h/100) : 0 })).sort((a,b) => parseFloat(a.label.split('/')[1]) - parseFloat(b.label.split('/')[1]));

  // Dynamic months
  const moG = {};
  sessions.forEach(s => { if (!s.date) return; const ym = s.date.slice(0,7); if (!moG[ym]) moG[ym] = { h:0, p:0, bbS:0, bbH:0 }; moG[ym].h += (s.hands||0); moG[ym].p += (s.cashOut-s.buyIn); if (s.stakes) { const bb = parseFloat(s.stakes.split('/')[1])||0; if (bb>0) { moG[ym].bbS += bb*(s.hands||0); moG[ym].bbH += (s.hands||0); } } });
  const moNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const monthRows = Object.entries(moG).sort((a,b)=>a[0].localeCompare(b[0])).map(([ym,v]) => { const [y,m]=ym.split('-'); const ab=v.bbH>0?v.bbS/v.bbH:avgBB; return { label: moNames[parseInt(m)-1]+' '+y, hands: v.h, pnl: Math.round(v.p*100)/100, bb100: v.h>0&&ab>0?(v.p/ab)/(v.h/100):0 }; });

  // Helpers
  const f = (n) => n >= 0 ? '+' + n.toFixed(2) : '-' + Math.abs(n).toFixed(2);
  const fBB = (n) => (n >= 0 ? '+' : '') + n.toFixed(2);
  const c = (n) => n >= 0 ? 'ps-positive' : 'ps-negative';
  const fK = (n) => Math.abs(n) >= 1000 ? (n/1000).toFixed(1)+'K' : n.toLocaleString();
  const pB = (v, mx) => Math.min(100, (v / mx) * 100);

  // GTO helpers
  const pre = D.preflop.overall;
  const postC = D.postflop.computed_percentages;
  const gto = D.gto_benchmarks;
  const positions = ['BTN','CO','HJ','UTG','SB','BB'];

  function gtoBar(label, val, gtoRange, mx) {
    if (!gtoRange) return '';
    const inR = val >= gtoRange[0] && val <= gtoRange[1];
    const col = inR ? 'var(--green)' : (val < gtoRange[0] ? 'var(--gold)' : 'var(--red)');
    const bW = pB(val, mx||100), gL = pB(gtoRange[0], mx||100), gR = pB(gtoRange[1], mx||100);
    return '<div class="ps-bar-row"><div class="ps-bar-label">'+label+'</div><div class="ps-bar-track"><div class="ps-bar-gto" style="left:'+gL+'%;width:'+(gR-gL)+'%"></div><div class="ps-bar-fill" style="width:'+bW+'%;background:'+col+'"></div></div><div class="ps-bar-val" style="color:'+col+'">'+val+'%</div></div>';
  }

  function gtoStat(label, val, gtoRange, unit) {
    unit = unit || '';
    const inR = gtoRange ? val >= gtoRange[0] && val <= gtoRange[1] : true;
    const col = !gtoRange ? 'var(--text)' : inR ? 'var(--green)' : (val < gtoRange[0] ? 'var(--gold)' : 'var(--red)');
    const gtoStr = gtoRange ? '<div style="font-size:0.68rem;color:var(--text3)">GTO: '+gtoRange[0]+' - '+gtoRange[1]+unit+'</div>' : '';
    return '<div class="da-stat-box" style="border-color:'+col+'"><div class="da-stat-label">'+label+'</div><div class="da-stat-val" style="color:'+col+'">'+val+unit+'</div>'+gtoStr+'</div>';
  }

  function sevBadge(sev) {
    const cols = { critical:'var(--red)', major:'var(--gold)', minor:'var(--blue)' };
    const bgs = { critical:'var(--red-dim)', major:'var(--gold-dim)', minor:'var(--blue-dim)' };
    const icons = { critical:'\\ud83d\\udd34', major:'\\ud83d\\udfe1', minor:'\\ud83d\\udd35' };
    return '<span class="ps-leak-sev '+sev+'" style="background:'+(bgs[sev]||bgs.minor)+';color:'+(cols[sev]||cols.minor)+'">'+(icons[sev]||'')+' '+sev+'</span>';
  }

  // ===== TOOLTIP DICTIONARY (PLO 6-max) =====
  const STAT_TIPS = {
    'VPIP':'Voluntarily Put $ In Pot \u2014 % of hands you put money in preflop (excluding blinds). PLO 6-max GTO range: 28-36%. Higher = looser, lower = tighter.',
    'PFR':'Preflop Raise % \u2014 % of hands you raise preflop. GTO 20-28%. VPIP-PFR gap should be 8-12pts. Big gap = too many cold-calls.',
    '3-Bet':'% of hands you re-raise preflop after someone has opened. GTO 6-10%. Low 3-bet = too passive vs opens.',
    '4-Bet':'% of times you re-raise after a 3-bet. GTO 3-6% in PLO.',
    'Cold Call':'% you flat-call a raise without 3-betting. PLO often punishes flat calls without strong holdings.',
    'Limp':'% of hands you call the BB instead of raising or folding. GTO 0-2%. Limping bleeds money.',
    'RFI':'Raise First In \u2014 % you open-raise when no one has voluntarily put money in. Position-dependent: BTN ~45%, UTG ~18%.',
    'Squeeze':'3-bet after an open + at least one caller. Strong line for premiums.',
    'Iso Raise':'Isolation raise vs limper(s). Punishes passive limps.',
    'Fold to 3-Bet':'% you fold after opening and getting 3-bet. GTO 40-55%. Too high = exploitable; too low = calling weak hands.',
    'AF':'Aggression Factor = (Bets+Raises) / Calls postflop. GTO 2.0-3.5. Below 2 = too passive.',
    'WTSD':'Went To Showdown \u2014 % of times after seeing flop you reach showdown. GTO 28-35%.',
    'W$SD':'Won $ at Showdown \u2014 % of showdowns you win. GTO 50-58%. Below 50 = showing down weak.',
    'C-Bet':'Continuation bet \u2014 % of times you bet flop after raising preflop. GTO 50-65%.',
    'C-Bet IP':'C-bet when you act last (in position). Generally bet more often than OOP.',
    'C-Bet OOP':'C-bet when you act first (out of position). Bet less often, more selectively.',
    'Fold to C-Bet':'% you fold flop after calling preflop and facing a c-bet. GTO 35-50%. >50% = folding too much.',
    'Check-Raise':'% you check then raise on the flop. GTO 8-15%. Strong line in PLO with sets/strong draws.',
    'Donk Bet':'Bet into the preflop raiser without check. GTO 0-5%. Donk-betting is usually a mistake.',
    'Probe':'Bet on turn after PFR checked back the flop. Good for floats / equity denial.',
    'EV':'Expected Value \u2014 long-run profit you should make from a decision based on equity, not actual results. EV+ play = good decision regardless of outcome.',
    'bb/100':'Big blinds won per 100 hands. Standard PLO win rate metric. +5 bb/100 = solid winner; -5 = losing.',
    'BTN':'Button \u2014 best position. Acts last postflop. Open very wide.',
    'CO':'Cutoff \u2014 second-best position. Open wide.',
    'HJ':'Hijack \u2014 third position from button. Open tighter.',
    'UTG':'Under The Gun \u2014 first to act preflop. Open tightest range.',
    'SB':'Small Blind \u2014 worst position postflop. Forced to put 0.5bb. Avoid limping.',
    'BB':'Big Blind \u2014 already invested 1bb. Defend wider vs raises but still play OOP.',
    'Premium':'AAxx, KKxx (with suits/connectors), AKQJ-type rundowns. Top 5% of hands.',
    'DS Rundown':'Double-suited connected hand like JT98ds. Massive equity, plays great multi-way.',
    'Strong Ace':'Ace + suit + connectivity (not paired). E.g. AsKsQc9c. Play mostly raise/3-bet.',
    'High Pair':'JJ+ in PLO. Vulnerable without backup; play carefully OOP.',
    'Suited Connected':'Single-suited with 4 connected ranks. E.g. KsJs98. Decent equity, set-mining.',
    'Suited Only':'Single-suited but no connectivity. E.g. AsKs73. Plays bad postflop, fold often.',
    'Connected Rainbow':'4 connected ranks no suits. E.g. JT98r. Limited postflop, fold OOP.',
    'Trash':'Disconnected, unsuited, no high card. Auto-fold even from BB vs raise.'
  };
  function tip(label, key) { const t = STAT_TIPS[key||label]; return t ? '<span class="tip" data-tip="'+t.replace(/"/g,'&quot;')+'">'+label+'</span>' : label; }

  let currentTab = 'overview';

  // ===== Merge browser-imported tournaments into D.tournaments =====
  // Browser drop zone saves to localStorage.browserTournamentImports.
  // We merge them into D.tournaments (deduping by code) BEFORE every render
  // so the tab shows combined stats from .bat-parsed + browser-imported entries.
  const _D_TOURN_BASE = JSON.parse(JSON.stringify(D.tournaments || { _empty: true, summary: {}, sessions: [] }));
  function mergeBrowserTournamentImports() {
    let stored;
    try { stored = JSON.parse(localStorage.getItem('browserTournamentImports') || '[]'); } catch(e) { stored = []; }
    if (!stored.length) { D.tournaments = JSON.parse(JSON.stringify(_D_TOURN_BASE)); return 0; }

    // Start fresh from the .bat-parsed base each render
    const base = JSON.parse(JSON.stringify(_D_TOURN_BASE));
    const baseSessions = (base.sessions || []);
    const baseCodes = new Set(baseSessions.map(s => s.code).filter(Boolean));
    const newOnes = stored.filter(s => s.code && !baseCodes.has(s.code));
    if (!newOnes.length) { D.tournaments = base; return 0; }

    // Convert browser-format → dashboard-format session objects
    const brSessions = newOnes.map(t => ({
      code: t.code, paidWith: t.paidWith,
      date: t.date, name: t.name, format: t.format,
      buyin_eur: Math.round((t.totalBuyin||0)*100)/100,
      invested_eur: Math.round((t.invested||0)*100)/100,
      cashed_eur: Math.round((t.win||0)*100)/100,
      net_eur: Math.round(((t.win||0) - (t.invested||0))*100)/100,
      place: t.place||0, hands: 0, tablesize: 0, itm: !!t.itm
    }));

    // Combined sessions list (newest first)
    const allSessions = baseSessions.concat(brSessions).sort((a,b) => {
      const pa = (a.date||'').match(/(\\d{2})-(\\d{2})-(\\d{4})/);
      const pb = (b.date||'').match(/(\\d{2})-(\\d{2})-(\\d{4})/);
      if (!pa) return 1; if (!pb) return -1;
      return (pb[3]+pb[1]+pb[2]).localeCompare(pa[3]+pa[1]+pa[2]);
    });

    // Recompute summary using ALL combined entries
    const allEntries = allSessions; // both have same shape
    const cashE = allEntries.filter(t => t.paidWith === 'cash');
    const tickE = allEntries.filter(t => t.paidWith === 'ticket');
    const totalInv = allEntries.reduce((s,t) => s + (t.invested_eur||0), 0);
    const totalWon = allEntries.reduce((s,t) => s + (t.cashed_eur||0), 0);
    const cashInv = cashE.reduce((s,t) => s + (t.invested_eur||0), 0);
    const cashWon = cashE.reduce((s,t) => s + (t.cashed_eur||0), 0);
    const tickInv = tickE.reduce((s,t) => s + (t.invested_eur||0), 0);
    const tickWon = tickE.reduce((s,t) => s + (t.cashed_eur||0), 0);
    const itmTotal = allEntries.filter(t => t.itm).length;
    const realMoneyPnl = (cashWon - cashInv) + tickWon;

    base.sessions = allSessions;
    base._empty = false;
    base.summary = {
      ...(base.summary||{}),
      entries: allEntries.length,
      invested_eur: Math.round(totalInv*100)/100,
      cashed_eur: Math.round(totalWon*100)/100,
      net_eur: Math.round((totalWon - totalInv)*100)/100,
      roi_pct: totalInv > 0 ? Math.round(((totalWon - totalInv)/totalInv)*1000)/10 : 0,
      itm_pct: allEntries.length ? Math.round((itmTotal/allEntries.length)*1000)/10 : 0,
      itm_count: itmTotal,
      avg_buyin_eur: allEntries.length ? Math.round((totalInv/allEntries.length)*100)/100 : 0,
      cash_entries: cashE.length,
      cash_invested_eur: Math.round(cashInv*100)/100,
      cash_won_from_cash_entries_eur: Math.round(cashWon*100)/100,
      cash_entries_net_eur: Math.round((cashWon - cashInv)*100)/100,
      cash_entries_roi_pct: cashInv > 0 ? Math.round(((cashWon - cashInv)/cashInv)*1000)/10 : 0,
      cash_entries_itm_pct: cashE.length ? Math.round((cashE.filter(t=>t.itm).length/cashE.length)*1000)/10 : 0,
      ticket_entries: tickE.length,
      ticket_value_eur: Math.round(tickInv*100)/100,
      cash_won_from_tickets_eur: Math.round(tickWon*100)/100,
      ticket_conversion_pct: tickInv > 0 ? Math.round((tickWon/tickInv)*1000)/10 : 0,
      ticket_entries_itm_pct: tickE.length ? Math.round((tickE.filter(t=>t.itm).length/tickE.length)*1000)/10 : 0,
      real_money_pnl_eur: Math.round(realMoneyPnl*100)/100
    };

    // by_format recompute
    const fmtAcc = {};
    for (const t of allEntries) {
      const f = t.format || 'Other';
      if (!fmtAcc[f]) fmtAcc[f] = { entries:0, invested:0, cashed:0, itm:0, hands:0, places:[] };
      fmtAcc[f].entries++;
      fmtAcc[f].invested += t.invested_eur||0;
      fmtAcc[f].cashed   += t.cashed_eur||0;
      fmtAcc[f].hands    += t.hands||0;
      if (t.itm) fmtAcc[f].itm++;
      if (t.place) fmtAcc[f].places.push(t.place);
    }
    base.by_format = {};
    for (const [k,v] of Object.entries(fmtAcc)) {
      base.by_format[k] = {
        entries: v.entries,
        invested_eur: Math.round(v.invested*100)/100,
        cashed_eur: Math.round(v.cashed*100)/100,
        net_eur: Math.round((v.cashed - v.invested)*100)/100,
        roi_pct: v.invested > 0 ? Math.round(((v.cashed - v.invested)/v.invested)*1000)/10 : 0,
        itm_pct: v.entries ? Math.round((v.itm/v.entries)*1000)/10 : 0,
        hands: v.hands,
        avg_buyin_eur: v.entries ? Math.round((v.invested/v.entries)*100)/100 : 0,
        avg_place: v.places.length ? Math.round((v.places.reduce((s,p)=>s+p,0)/v.places.length)*10)/10 : 0
      };
    }

    // by_month recompute (key: YYYY-MM, parsed from "MM-DD-YYYY HH:MM:SS")
    const monthAcc = {};
    for (const t of allEntries) {
      const m = (t.date||'').match(/(\\d{2})-(\\d{2})-(\\d{4})/);
      if (!m) continue;
      const ym = m[3] + '-' + m[1];
      if (!monthAcc[ym]) monthAcc[ym] = { entries:0, invested:0, cashed:0, itm:0, hands:0 };
      monthAcc[ym].entries++;
      monthAcc[ym].invested += t.invested_eur||0;
      monthAcc[ym].cashed   += t.cashed_eur||0;
      monthAcc[ym].hands    += t.hands||0;
      if (t.itm) monthAcc[ym].itm++;
    }
    base.by_month = {};
    for (const [k,v] of Object.entries(monthAcc).sort()) {
      base.by_month[k] = {
        entries: v.entries,
        invested_eur: Math.round(v.invested*100)/100,
        cashed_eur: Math.round(v.cashed*100)/100,
        net_eur: Math.round((v.cashed - v.invested)*100)/100,
        roi_pct: v.invested > 0 ? Math.round(((v.cashed - v.invested)/v.invested)*1000)/10 : 0,
        itm_pct: v.entries ? Math.round((v.itm/v.entries)*1000)/10 : 0,
        hands: v.hands
      };
    }

    // by_buyin recompute (using same buckets as parser)
    const buyinBuckets = [
      { label: 'Micro (\\u20ac0-\\u20ac5)',     min: 0,    max: 5 },
      { label: 'Low (\\u20ac5-\\u20ac20)',      min: 5,    max: 20 },
      { label: 'Mid (\\u20ac20-\\u20ac50)',     min: 20,   max: 50 },
      { label: 'High (\\u20ac50-\\u20ac200)',   min: 50,   max: 200 },
      { label: 'Premium (>\\u20ac200)',         min: 200,  max: Infinity }
    ];
    base.by_buyin = {};
    for (const b of buyinBuckets) {
      const sub = allEntries.filter(t => (t.buyin_eur||0) >= b.min && (t.buyin_eur||0) < b.max);
      if (!sub.length) continue;
      const inv = sub.reduce((s,t)=>s+(t.invested_eur||0),0);
      const csh = sub.reduce((s,t)=>s+(t.cashed_eur||0),0);
      const itm = sub.filter(t=>t.itm).length;
      const hnds = sub.reduce((s,t)=>s+(t.hands||0),0);
      base.by_buyin[b.label] = {
        entries: sub.length,
        invested_eur: Math.round(inv*100)/100,
        cashed_eur: Math.round(csh*100)/100,
        net_eur: Math.round((csh - inv)*100)/100,
        roi_pct: inv > 0 ? Math.round(((csh - inv)/inv)*1000)/10 : 0,
        itm_pct: sub.length ? Math.round((itm/sub.length)*1000)/10 : 0,
        hands: hnds,
        avg_buyin_eur: sub.length ? Math.round((inv/sub.length)*100)/100 : 0
      };
    }

    // finish_distribution recompute
    const finishBuckets = { '1st':[1,1], '2nd':[2,2], '3rd':[3,3], 'Top 5':[1,5], 'Top 10':[1,10], '11th-25th':[11,25], '26th-100th':[26,100], '100th+':[101,Infinity] };
    base.finish_distribution = {};
    for (const [label, [lo, hi]] of Object.entries(finishBuckets)) {
      const sub = allEntries.filter(t => t.place >= lo && t.place <= hi);
      base.finish_distribution[label] = {
        count: sub.length,
        pct: allEntries.length ? Math.round((sub.length/allEntries.length)*1000)/10 : 0,
        avg_cash: sub.length ? Math.round((sub.reduce((s,t)=>s+(t.cashed_eur||0),0)/sub.length)*100)/100 : 0
      };
    }

    // top_cashes & worst_busts recompute
    base.top_cashes = [...allEntries].sort((a,b) => (b.cashed_eur||0) - (a.cashed_eur||0)).slice(0, 10).map(t => ({
      date: t.date, name: t.name, format: t.format, buyin_eur: t.buyin_eur||0, cashed_eur: t.cashed_eur||0, place: t.place||0, hands: t.hands||0
    }));
    base.worst_busts = [...allEntries].filter(t => !t.itm).sort((a,b) => (b.invested_eur||0) - (a.invested_eur||0)).slice(0, 10).map(t => ({
      date: t.date, name: t.name, format: t.format, buyin_eur: t.buyin_eur||0, invested_eur: t.invested_eur||0, place: t.place||0, hands: t.hands||0
    }));

    // weekly_pnl_curve recompute (Monday-anchored weeks)
    const weekAcc = {};
    for (const t of allEntries) {
      const m = (t.date||'').match(/(\\d{2})-(\\d{2})-(\\d{4})/);
      if (!m) continue;
      const d = new Date(m[3]+'-'+m[1]+'-'+m[2]);
      const day = d.getDay();
      const diff = day === 0 ? -6 : 1 - day;
      d.setDate(d.getDate() + diff);
      const wkKey = d.toISOString().slice(0,10);
      if (!weekAcc[wkKey]) weekAcc[wkKey] = { hands:0, pnl:0 };
      weekAcc[wkKey].hands += t.hands||0;
      // For weekly chart use real-money basis (cash net for cash entries, win for tickets)
      const pnlContrib = (t.paidWith === 'cash') ? ((t.cashed_eur||0) - (t.invested_eur||0)) : (t.cashed_eur||0);
      weekAcc[wkKey].pnl += pnlContrib;
    }
    let cum = 0;
    base.weekly_pnl_curve = Object.entries(weekAcc).sort().map(([wk,v]) => {
      cum += v.pnl;
      return { week: wk, hands: v.hands, pnl: Math.round(v.pnl*100)/100, cumulative: Math.round(cum*100)/100 };
    });

    // Update biggest_cash / best_finish in summary
    const biggest = allEntries.reduce((m,t) => ((t.cashed_eur||0) > (m.cashed_eur||0)) ? t : m, allEntries[0] || {});
    const bestFin = allEntries.reduce((m,t) => (t.place > 0 && ((m.place||0) === 0 || t.place < m.place)) ? t : m, allEntries[0] || {});
    base.summary.biggest_cash_eur = Math.round((biggest.cashed_eur||0)*100)/100;
    base.summary.biggest_cash_event = biggest.name || '';
    base.summary.best_finish = bestFin.place || 0;
    base.summary.best_finish_event = bestFin.name || '';

    // Update combined totals too
    if (D.combined) {
      const newTournPnl = realMoneyPnl;
      D.combined.tournament_pnl_eur = Math.round(newTournPnl*100)/100;
      D.combined.tournament_sessions = allEntries.length;
      D.combined.total_pnl_eur = Math.round(((D.combined.cash_pnl_eur||0) + newTournPnl)*100)/100;
    }

    D.tournaments = base;
    return newOnes.length;
  }

  function render() {
    const _mergedNew = mergeBrowserTournamentImports();
    // Clear any existing charts to prevent canvas reuse errors
    if (window.activeCharts) { window.activeCharts.forEach(c => { try { c.destroy(); } catch(e){} }); window.activeCharts = []; }
    // === Combined cash + tournament totals (from injected DEEP_ANALYSIS.combined) ===
    const _comb = D.combined || { tournament_pnl_eur: 0, tournament_hands: 0, tournament_sessions: 0, cash_pnl_eur: totalPnl };
    const tournPnl = _comb.tournament_pnl_eur || 0;
    const tournHands = _comb.tournament_hands || 0;
    const tournSessions = _comb.tournament_sessions || 0;
    const combinedPnl = totalPnl + tournPnl;     // overall (cash + tourn)
    const combinedHands = totalHands + tournHands;
    const combinedSessions = totalSessions + tournSessions;

    // ========== TAB: OVERVIEW ==========
    const overviewHTML = \`
      <div class="ps-hero-row">
        <div class="ps-hero-card \${combinedPnl >= 0 ? 'green' : 'red'}">
          <div class="ps-hero-label">Overall P&L (Cash + Tournaments)</div>
          <div class="ps-hero-val" style="color:\${combinedPnl >= 0 ? 'var(--green)' : 'var(--red)'}">\${f(combinedPnl)}</div>
          <div class="ps-hero-sub">Cash: <span style="color:\${totalPnl>=0?'var(--green)':'var(--red)'}">\${f(totalPnl)}</span> \\u00b7 Tourn: <span style="color:\${tournPnl>=0?'var(--green)':'var(--red)'}">\${f(tournPnl)}</span></div>
        </div>
        <div class="ps-hero-card blue">
          <div class="ps-hero-label">Total Hands</div>
          <div class="ps-hero-val" style="color:var(--blue)">\${combinedHands.toLocaleString()}</div>
          <div class="ps-hero-sub">\${totalHands.toLocaleString()} cash \\u00b7 \${tournHands.toLocaleString()} tourn</div>
        </div>
        <div class="ps-hero-card gold">
          <div class="ps-hero-label">Rake Paid</div>
          <div class="ps-hero-val" style="color:var(--gold)">\${totalRake.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
          <div class="ps-hero-sub">Avg BB: \${avgBB.toFixed(2)}</div>
        </div>
        <div class="ps-hero-card purple">
          <div class="ps-hero-label">VPIP / PFR</div>
          <div class="ps-hero-val" style="color:var(--purple)">\${pre.vpip} / \${pre.pfr}</div>
          <div class="ps-hero-sub">Gap: \${(pre.vpip - pre.pfr).toFixed(1)} pts</div>
        </div>
      </div>

      \${tournSessions > 0 ? \`
      <!-- Tournament summary strip (clickable to jump to tournaments tab) -->
      <div class="ps-card" style="cursor:pointer;border-color:var(--gold-dim);background:linear-gradient(90deg, rgba(245,158,11,0.06), rgba(245,158,11,0.02))" onclick="document.querySelectorAll('.ps-tab').forEach(t => { if (t.dataset.tab === 'tournaments') t.click(); })">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.75rem;padding:0.5rem">
          <div style="display:flex;align-items:center;gap:0.75rem">
            <div style="font-size:1.6rem">\\ud83c\\udfc6</div>
            <div>
              <div style="font-size:0.78rem;color:var(--text2);text-transform:uppercase;letter-spacing:0.05em">Tournament P&L (real money)</div>
              <div style="font-size:1.4rem;font-weight:700;color:\${tournPnl>=0?'var(--green)':'var(--red)'}">\${f(tournPnl)}</div>
              \${(D.tournaments && D.tournaments.summary && D.tournaments.summary.ticket_entries) ? \`<div style="font-size:0.7rem;color:var(--text3);margin-top:2px">\${D.tournaments.summary.ticket_entries} ticket entries (€0 cost) + \${D.tournaments.summary.cash_entries} cash buy-ins</div>\` : ''}
            </div>
          </div>
          <div style="display:flex;gap:1.5rem;flex-wrap:wrap;font-size:0.85rem;color:var(--text2)">
            <div><span style="color:var(--text3)">Entries:</span> <strong style="color:var(--text)">\${tournSessions.toLocaleString()}</strong></div>
            <div><span style="color:var(--text3)">ITM:</span> <strong style="color:var(--text)">\${(D.tournaments && D.tournaments.summary ? D.tournaments.summary.itm_pct : 0)}%</strong></div>
            <div><span style="color:var(--text3)">Hands:</span> <strong style="color:var(--text)">\${tournHands.toLocaleString()}</strong></div>
            <div style="color:var(--gold);font-size:0.78rem;align-self:center">Click for full tournament analysis \\u2192</div>
          </div>
        </div>
      </div>
      \` : ''}

      <!-- Key Stats Grid -->
      <div class="da-stats-grid">
        \${gtoStat('VPIP', pre.vpip, [28,36], '%')}
        \${gtoStat('PFR', pre.pfr, [20,28], '%')}
        \${gtoStat('3-Bet', D.preflop.by_position.BTN.three_bet, [6,10], '%')}
        \${gtoStat('AF', D.leak_analysis.find(l=>l.leak&&l.leak.includes('AF'))?.value||1.84, [2.0,3.5], '')}
        \${gtoStat('WTSD', postC.flop.wtsd_pct, [28,35], '%')}
        \${gtoStat('W$SD', postC.flop.wsd_pct, [50,58], '%')}
      </div>

      <!-- Weekly P&L Chart -->
      <div class="ps-card">
        <div class="ps-card-title">\\ud83d\\udcc8 Cumulative P&L by Week</div>
        <div style="height:280px;position:relative"><canvas id="da-weekly-pnl"></canvas></div>
      </div>

      <!-- Positional Breakdown -->
      <div class="ps-card">
        <div class="ps-card-title">\\ud83c\\udfaf Positional Breakdown</div>
        <table class="ps-table">
          <thead><tr><th>Pos</th><th>Hands</th><th>VPIP</th><th>PFR</th><th>Limp</th><th>3-Bet</th><th>RFI</th><th>Cold Call</th></tr></thead>
          <tbody>
            \${positions.map(p => {
              const s = D.preflop.by_position[p]; if (!s) return '';
              const g = gto.preflop_by_position[p] || {};
              const cz = (v, r) => !r ? '' : (v >= r[0] && v <= r[1]) ? 'ps-positive' : (v < r[0] ? 'ps-warn' : 'ps-negative');
              return '<tr><td class="ps-pos">'+p+'</td><td>'+s.hands.toLocaleString()+'</td><td class="'+cz(s.vpip,g.vpip)+'">'+s.vpip+'%</td><td class="'+cz(s.pfr,g.pfr)+'">'+s.pfr+'%</td><td class="'+cz(s.limp,g.limp)+'">'+s.limp+'%</td><td class="'+cz(s.three_bet,g.three_bet)+'">'+s.three_bet+'%</td><td>'+s.rfi+'%</td><td>'+s.cold_call+'%</td></tr>';
            }).join('')}
          </tbody>
        </table>
      </div>

      <!-- Monthly + Stakes -->
      <div class="ps-grid-2">
        <div class="ps-card">
          <div class="ps-card-title">\\ud83d\\udcc5 P&L by Month</div>
          <table class="ps-table"><thead><tr><th>Month</th><th>Hands</th><th>P&L</th><th>bb/100</th></tr></thead><tbody>
          \${monthRows.map(v => '<tr><td class="ps-pos">'+v.label+'</td><td>'+v.hands.toLocaleString()+'</td><td class="'+c(v.pnl)+'">'+f(v.pnl)+'</td><td class="'+c(v.bb100)+'">'+fBB(v.bb100)+'</td></tr>').join('')}
          </tbody></table>
        </div>
        <div class="ps-card">
          <div class="ps-card-title">\\ud83d\\udcb0 P&L by Stakes</div>
          <table class="ps-table"><thead><tr><th>Stake</th><th>Hands</th><th>P&L</th><th>bb/100</th></tr></thead><tbody>
          \${stakeRows.map(v => '<tr><td class="ps-pos">'+v.label+'</td><td>'+v.hands.toLocaleString()+'</td><td class="'+c(v.pnl)+'">'+f(v.pnl)+'</td><td class="'+c(v.bb100)+'">'+fBB(v.bb100)+'</td></tr>').join('')}
          </tbody></table>
        </div>
      </div>
    \`;

    // ========== TAB: GOOD VS BAD ==========
    const pc = D.period_comparison;
    const gp = pc.good_period, bp = pc.bad_period;
    const goodVsBadHTML = \`
      <div class="ps-grid-2">
        <div class="ps-card" style="border-top:3px solid var(--green)">
          <div class="ps-card-title" style="color:var(--green)">\\u2705 Good Period</div>
          <div style="font-size:0.78rem;color:var(--text3);margin-bottom:0.75rem">\${gp.dates}</div>
          <div class="da-stats-grid" style="grid-template-columns:1fr 1fr">
            <div class="da-stat-box" style="border-color:var(--green)"><div class="da-stat-label">P&L</div><div class="da-stat-val" style="color:var(--red)">\${f(gp.pnl_eur)}</div></div>
            <div class="da-stat-box" style="border-color:var(--green)"><div class="da-stat-label">bb/100</div><div class="da-stat-val" style="color:var(--red)">\${fBB(gp.bb_per_100)}</div></div>
            <div class="da-stat-box"><div class="da-stat-label">Hands</div><div class="da-stat-val">\${gp.hands.toLocaleString()}</div></div>
            <div class="da-stat-box"><div class="da-stat-label">Sessions</div><div class="da-stat-val">\${gp.sessions.toLocaleString()}</div></div>
          </div>
        </div>
        <div class="ps-card" style="border-top:3px solid var(--red)">
          <div class="ps-card-title" style="color:var(--red)">\\u274c Bad Period</div>
          <div style="font-size:0.78rem;color:var(--text3);margin-bottom:0.75rem">\${bp.dates}</div>
          <div class="da-stats-grid" style="grid-template-columns:1fr 1fr">
            <div class="da-stat-box" style="border-color:var(--red)"><div class="da-stat-label">P&L</div><div class="da-stat-val" style="color:var(--red)">\${f(bp.pnl_eur)}</div></div>
            <div class="da-stat-box" style="border-color:var(--red)"><div class="da-stat-label">bb/100</div><div class="da-stat-val" style="color:var(--red)">\${fBB(bp.bb_per_100)}</div></div>
            <div class="da-stat-box"><div class="da-stat-label">Hands</div><div class="da-stat-val">\${bp.hands.toLocaleString()}</div></div>
            <div class="da-stat-box"><div class="da-stat-label">Sessions</div><div class="da-stat-val">\${bp.sessions.toLocaleString()}</div></div>
          </div>
        </div>
      </div>

      <!-- Stat Comparison Table -->
      <div class="ps-card">
        <div class="ps-card-title">\\ud83d\\udd04 Stat Comparison</div>
        <table class="ps-table">
          <thead><tr><th>Stat</th><th>Good Period</th><th>Bad Period</th><th>Diff</th><th></th></tr></thead>
          <tbody>
            \${Object.entries(pc.stat_differences).map(([k, v]) => {
              const label = k.replace(/_/g, ' ').replace(/pct/g, '%');
              const imp = Math.abs(v.diff);
              const cls = imp >= 3 ? 'ps-negative' : imp >= 1 ? 'ps-warn' : '';
              return '<tr><td class="ps-pos">'+label+'</td><td>'+v.good+'</td><td>'+v.bad+'</td><td class="'+cls+'">'+(v.diff >= 0 ? '+' : '')+v.diff.toFixed(1)+'</td><td>'+v.direction+'</td></tr>';
            }).join('')}
          </tbody>
        </table>
      </div>

      <!-- Key Changes -->
      <div class="ps-card">
        <div class="ps-card-title">\\u26a0\\ufe0f Key Changes</div>
        \${pc.key_changes.map(kc => {
          const col = kc.impact === 'critical' ? 'var(--red)' : kc.impact === 'major' ? 'var(--gold)' : 'var(--blue)';
          const bg = kc.impact === 'critical' ? 'var(--red-dim)' : kc.impact === 'major' ? 'var(--gold-dim)' : 'var(--blue-dim)';
          return '<div style="display:flex;align-items:center;gap:0.75rem;padding:0.65rem 0.85rem;margin-bottom:0.5rem;border-radius:8px;background:'+bg+';border-left:3px solid '+col+'"><span style="font-size:0.68rem;font-weight:700;text-transform:uppercase;color:'+col+';min-width:60px">'+kc.impact+'</span><span style="font-size:0.82rem;color:var(--text)">'+kc.note+'</span><span style="margin-left:auto;font-size:0.78rem;color:var(--text3)">'+kc.good+' \\u2192 '+kc.bad+'</span></div>';
        }).join('')}
      </div>

      <!-- Positional Comparison -->
      <div class="ps-card">
        <div class="ps-card-title">\\ud83d\\udcca Position Changes: Good vs Bad</div>
        <table class="ps-table">
          <thead><tr><th>Pos</th><th colspan="2">VPIP</th><th colspan="2">PFR</th><th colspan="2">Limp</th><th colspan="2">3-Bet</th></tr>
          <tr><th></th><th style="color:var(--green);font-size:0.6rem">GOOD</th><th style="color:var(--red);font-size:0.6rem">BAD</th><th style="color:var(--green);font-size:0.6rem">GOOD</th><th style="color:var(--red);font-size:0.6rem">BAD</th><th style="color:var(--green);font-size:0.6rem">GOOD</th><th style="color:var(--red);font-size:0.6rem">BAD</th><th style="color:var(--green);font-size:0.6rem">GOOD</th><th style="color:var(--red);font-size:0.6rem">BAD</th></tr></thead>
          <tbody>
            \${positions.map(p => {
              const g = gp.stats.by_position[p], b = bp.stats.by_position[p]; if (!g || !b) return '';
              const d = (a,z) => { const df=z-a; return df > 1.5 ? 'ps-negative' : df < -1.5 ? 'ps-positive' : ''; };
              return '<tr><td class="ps-pos">'+p+'</td><td>'+g.vpip+'</td><td class="'+d(g.vpip,b.vpip)+'">'+b.vpip+'</td><td>'+g.pfr+'</td><td class="'+d(b.pfr,g.pfr)+'">'+b.pfr+'</td><td>'+g.limp+'</td><td class="'+d(g.limp,b.limp)+'">'+b.limp+'</td><td>'+g.three_bet+'</td><td class="'+d(b.three_bet,g.three_bet)+'">'+b.three_bet+'</td></tr>';
            }).join('')}
          </tbody>
        </table>
      </div>

      <!-- Target Stats -->
      <div class="ps-card" style="border:1px solid rgba(34,197,94,0.2);background:rgba(34,197,94,0.03)">
        <div class="ps-card-title" style="color:var(--green)">\\ud83c\\udfaf Your Winning Form \\u2014 Targets to Hit</div>
        <div class="da-stats-grid">
          \${Object.entries(D.action_plan.good_period_targets).filter(([k]) => k !== '_description' && k !== 'by_position').map(([k, v]) => typeof v === 'number' ? '<div class="da-stat-box" style="border-color:var(--green)"><div class="da-stat-label">'+k.replace(/_/g,' ').replace(/pct/g,'%')+'</div><div class="da-stat-val" style="color:var(--green)">'+v+'</div></div>' : '').join('')}
        </div>
      </div>
    \`;

    // ========== TAB: LEAK REPORT ==========
    const sevOrder = {critical:0,major:1,minor:2};
    const leakReportHTML = \`
      <!-- Leaks -->
      \${D.leak_analysis.sort((a,b) => (sevOrder[a.severity]||2) - (sevOrder[b.severity]||2)).map(l => {
        const hasGTO = l.gto && l.gto.length === 2;
        return '<div class="ps-leak-card '+l.severity+'"><div class="ps-leak-head">'+sevBadge(l.severity)+'<span class="ps-leak-title">'+l.leak+'</span></div><div class="ps-leak-body">'+(l.value !== undefined ? '<div class="ps-leak-vals"><div class="ps-leak-v">Your value: <span style="color:var(--red)">'+l.value+'</span></div>'+(hasGTO ? '<div class="ps-leak-v">GTO range: <span style="color:var(--green)">'+l.gto[0]+' \\u2014 '+l.gto[1]+'</span></div>' : '')+'</div>' : '')+'<div class="ps-leak-fix">\\ud83d\\udca1 '+l.fix+'</div></div></div>';
      }).join('')}

      <!-- Strengths -->
      <div class="ps-card" style="border:1px solid rgba(0,212,170,0.15)">
        <div class="ps-card-title">\\u2705 Strengths</div>
        <div class="ps-strength-list">
          \${D.strengths.map(s => '<div class="ps-strength-item"><div class="ps-strength-icon">\\u2713</div><div>'+s+'</div></div>').join('')}
        </div>
      </div>

      <!-- Action Plan -->
      <div class="ps-card">
        <div class="ps-card-title">\\ud83d\\ude80 Action Plan \\u2014 Immediate Fixes</div>
        \${D.action_plan.immediate_fixes.map(a => '<div style="display:flex;gap:0.75rem;padding:0.75rem 0.85rem;margin-bottom:0.5rem;border-radius:8px;background:var(--card);border:1px solid var(--border)"><div style="font-size:1.4rem;font-weight:800;color:var(--green);min-width:2rem;text-align:center">#'+a.priority+'</div><div><div style="font-weight:700;color:var(--text);font-size:0.85rem">'+a.action+'</div><div style="font-size:0.78rem;color:var(--text3);margin-top:0.2rem">Target: '+a.target+'</div><div style="font-size:0.75rem;color:var(--text2);margin-top:0.15rem">'+a.impact+'</div></div></div>').join('')}
      </div>

      <div class="ps-card">
        <div class="ps-card-title">\\ud83d\\uddd3\\ufe0f Session Management</div>
        \${D.action_plan.session_management.map(a => '<div style="padding:0.65rem 0.85rem;margin-bottom:0.4rem;border-radius:8px;background:rgba(245,158,11,0.04);border-left:3px solid var(--gold)"><div style="font-weight:700;color:var(--text);font-size:0.82rem">'+a.action+'</div><div style="font-size:0.78rem;color:var(--text2);margin-top:0.2rem">'+a.detail+'</div></div>').join('')}
      </div>
    \`;

    // ========== TAB: GTO ANALYSIS ==========
    const gtoHTML = \`
      <div class="ps-card">
        <div class="ps-card-title">\\ud83d\\udcca Preflop Stats vs GTO Range</div>
        <div style="font-size:0.7rem;color:var(--text3);margin-bottom:0.75rem">Dashed area = GTO range \\u00b7 Green = in range \\u00b7 Gold = below \\u00b7 Red = above</div>
        \${gtoBar('VPIP', pre.vpip, [28,36], 60)}
        \${gtoBar('PFR', pre.pfr, [20,28], 60)}
        \${gtoBar('Limp', pre.limp_pct, [0,2], 15)}
      </div>

      <!-- GTO by Position -->
      <div class="ps-card">
        <div class="ps-card-title">\\ud83c\\udfaf Preflop GTO by Position</div>
        <table class="ps-table">
          <thead><tr><th>Pos</th><th>Hands</th><th>VPIP</th><th>PFR</th><th>3-Bet</th><th>RFI</th><th>Limp</th><th>Fold to 3B</th><th>4-Bet</th><th>Squeeze</th></tr></thead>
          <tbody>
            \${positions.map(p => {
              const s = D.preflop.by_position[p]; if (!s) return '';
              const g = gto.preflop_by_position[p] || {};
              const cz = (v, r) => !r ? '' : (v >= r[0] && v <= r[1]) ? 'ps-positive' : (v < r[0] ? 'ps-warn' : 'ps-negative');
              return '<tr><td class="ps-pos">'+p+'</td><td>'+s.hands.toLocaleString()+'</td><td class="'+cz(s.vpip,g.vpip)+'">'+s.vpip+'%</td><td class="'+cz(s.pfr,g.pfr)+'">'+s.pfr+'%</td><td class="'+cz(s.three_bet,g.three_bet)+'">'+s.three_bet+'%</td><td>'+s.rfi+'%</td><td class="'+cz(s.limp,g.limp)+'">'+s.limp+'%</td><td>'+(s.fold_to_3bet||'-')+'%</td><td>'+(s.four_bet||'-')+'%</td><td>'+(s.squeeze||'-')+'%</td></tr>';
            }).join('')}
          </tbody>
        </table>
      </div>

      <!-- Postflop GTO -->
      <div class="ps-card">
        <div class="ps-card-title">\\ud83c\\udfb0 Postflop Stats vs GTO Range</div>
        \${gtoBar('C-bet Flop', postC.flop.cbet_pct, gto.postflop.cbet_flop, 80)}
        \${gtoBar('C-bet Turn', postC.turn.cbet_pct, gto.postflop.cbet_turn, 80)}
        \${gtoBar('Fold to C-bet', postC.flop.fold_to_cbet_pct, gto.postflop.fold_to_cbet_flop, 70)}
        \${gtoBar('Check-raise Flop', postC.flop.xr_pct, gto.postflop.check_raise_flop, 25)}
        \${gtoBar('Donk Bet Flop', postC.flop.donk_pct, gto.postflop.donk_bet_flop, 25)}
        \${gtoBar('WTSD', postC.flop.wtsd_pct, gto.postflop.wtsd, 50)}
        \${gtoBar('W$SD', postC.flop.wsd_pct, gto.postflop.wsd, 75)}
      </div>

      <!-- Open Raise Sizing -->
      <div class="ps-card">
        <div class="ps-card-title">\\ud83d\\udcb5 Open Raise Sizing (BB)</div>
        <table class="ps-table">
          <thead><tr><th>Position</th><th>Avg</th><th>Median</th><th>Min</th><th>Max</th><th>Count</th></tr></thead>
          <tbody>
            \${Object.entries(D.preflop.open_raise_sizing).map(([p, v]) => '<tr><td class="ps-pos">'+p+'</td><td>'+v.avg.toFixed(2)+'</td><td>'+v.median+'</td><td>'+v.min+'</td><td>'+v.max+'</td><td>'+v.count.toLocaleString()+'</td></tr>').join('')}
          </tbody>
        </table>
      </div>
    \`;

    // ========== TAB: POSTFLOP DEEP ==========
    const fl = D.postflop.flop, tu = D.postflop.turn, ri = D.postflop.river;
    const postflopHTML = \`
      <!-- Street by Street -->
      <div class="ps-grid-3">
        <div class="ps-card">
          <div class="ps-card-title">\\ud83c\\udccf Flop</div>
          <div class="da-mini-stats">
            <div><span class="da-mini-label">C-bet</span><span class="da-mini-val">\${postC.flop.cbet_pct}%</span></div>
            <div><span class="da-mini-label">C-bet IP</span><span class="da-mini-val">\${postC.flop.cbet_ip_pct}%</span></div>
            <div><span class="da-mini-label">C-bet OOP</span><span class="da-mini-val">\${postC.flop.cbet_oop_pct}%</span></div>
            <div><span class="da-mini-label">Check-raise</span><span class="da-mini-val">\${postC.flop.xr_pct}%</span></div>
            <div><span class="da-mini-label">Check-call</span><span class="da-mini-val">\${postC.flop.xc_pct}%</span></div>
            <div><span class="da-mini-label">Check-fold</span><span class="da-mini-val">\${postC.flop.xf_pct}%</span></div>
            <div><span class="da-mini-label">Donk bet</span><span class="da-mini-val">\${postC.flop.donk_pct}%</span></div>
            <div><span class="da-mini-label">Fold to C-bet</span><span class="da-mini-val">\${postC.flop.fold_to_cbet_pct}%</span></div>
            <div><span class="da-mini-label">Probe</span><span class="da-mini-val">\${postC.flop.probe_pct}%</span></div>
            <div><span class="da-mini-label">WTSD</span><span class="da-mini-val">\${postC.flop.wtsd_pct}%</span></div>
            <div><span class="da-mini-label">W$SD</span><span class="da-mini-val">\${postC.flop.wsd_pct}%</span></div>
          </div>
          <div style="font-size:0.7rem;color:var(--text3);margin-top:0.5rem">Bets \${fl.bets.toLocaleString()} \\u00b7 Raises \${fl.raises.toLocaleString()} \\u00b7 Calls \${fl.calls.toLocaleString()} \\u00b7 Folds \${fl.folds.toLocaleString()}</div>
        </div>
        <div class="ps-card">
          <div class="ps-card-title">\\ud83c\\udccf Turn</div>
          <div class="da-mini-stats">
            <div><span class="da-mini-label">C-bet</span><span class="da-mini-val">\${postC.turn.cbet_pct}%</span></div>
            <div><span class="da-mini-label">Check-raise</span><span class="da-mini-val">\${postC.turn.xr_pct}%</span></div>
            <div><span class="da-mini-label">Fold to bet</span><span class="da-mini-val">\${postC.turn.fold_to_bet_pct}%</span></div>
            <div><span class="da-mini-label">Call bet</span><span class="da-mini-val">\${postC.turn.call_bet_pct}%</span></div>
            <div><span class="da-mini-label">Raise bet</span><span class="da-mini-val">\${postC.turn.raise_bet_pct}%</span></div>
            <div><span class="da-mini-label">Probe</span><span class="da-mini-val">\${postC.turn.probe_pct}%</span></div>
          </div>
          <div style="font-size:0.7rem;color:var(--text3);margin-top:0.5rem">Bets \${tu.bets.toLocaleString()} \\u00b7 Raises \${tu.raises.toLocaleString()} \\u00b7 Calls \${tu.calls.toLocaleString()} \\u00b7 Folds \${tu.folds.toLocaleString()}</div>
        </div>
        <div class="ps-card">
          <div class="ps-card-title">\\ud83c\\udccf River</div>
          <div class="da-mini-stats">
            <div><span class="da-mini-label">Fold to bet</span><span class="da-mini-val">\${postC.river.fold_to_bet_pct}%</span></div>
            <div><span class="da-mini-label">Call bet</span><span class="da-mini-val">\${postC.river.call_bet_pct}%</span></div>
            <div><span class="da-mini-label">Raise bet</span><span class="da-mini-val">\${postC.river.raise_bet_pct}%</span></div>
          </div>
          <div style="font-size:0.7rem;color:var(--text3);margin-top:0.5rem">Bets \${ri.bets.toLocaleString()} \\u00b7 Raises \${ri.raises.toLocaleString()} \\u00b7 Calls \${ri.calls.toLocaleString()} \\u00b7 Folds \${ri.folds.toLocaleString()}</div>
        </div>
      </div>

      <!-- Positional Postflop -->
      <div class="ps-card">
        <div class="ps-card-title">\\ud83d\\udcca Postflop by Position</div>
        <table class="ps-table">
          <thead><tr><th>Pos</th><th>Flops Seen</th><th>Saw Turn</th><th>Saw River</th><th>C-bet</th><th>Fold to C-bet</th><th>WTSD</th><th>W$SD</th></tr></thead>
          <tbody>
            \${positions.map(p => {
              const s = D.postflop.by_position_computed[p]; if (!s) return '';
              return '<tr><td class="ps-pos">'+p+'</td><td>'+s.saw_flop.toLocaleString()+'</td><td>'+s.saw_turn.toLocaleString()+'</td><td>'+s.saw_river.toLocaleString()+'</td><td>'+s.cbet_pct+'%</td><td>'+s.fold_to_cbet_pct+'%</td><td>'+s.wtsd_pct+'%</td><td>'+s.wsd_pct+'%</td></tr>';
            }).join('')}
          </tbody>
        </table>
      </div>

      <!-- River Focus -->
      <div class="ps-card">
        <div class="ps-card-title">\\ud83c\\udfb2 River Play \\u2014 Good vs Bad Period</div>
        <div class="da-stats-grid" style="grid-template-columns:1fr 1fr 1fr">
          <div class="da-stat-box"><div class="da-stat-label">River Fold to Bet (Good)</div><div class="da-stat-val">66.8%</div></div>
          <div class="da-stat-box" style="border-color:var(--red)"><div class="da-stat-label">River Fold to Bet (Bad)</div><div class="da-stat-val" style="color:var(--red)">69.3%</div></div>
          <div class="da-stat-box"><div class="da-stat-label">Diff</div><div class="da-stat-val" style="color:var(--gold)">+2.5%</div><div style="font-size:0.68rem;color:var(--text3)">Folding more \\u2192 less value</div></div>
        </div>
      </div>
    \`;

    // ========== TAB: HAND QUALITY ==========
    const hqOrder = ['premium','ds_rundown','strong_ace','high_pair','high_cards','suited_connected','suited_only','connected_rainbow','trash'];
    const handQualityHTML = \`
      <div class="ps-card">
        <div class="ps-card-title">\\ud83d\\udc8e Hand Quality Analysis</div>
        <table class="ps-table">
          <thead><tr><th>Category</th><th>Dealt</th><th>Played</th><th>Play Rate</th><th>Avg P&L (bb)</th><th>Total P&L (bb)</th></tr></thead>
          <tbody>
            \${hqOrder.map(k => {
              const h = D.hand_quality[k]; if (!h) return '';
              const label = k.replace(/_/g, ' ').replace(/\\b\\w/g, l => l.toUpperCase());
              return '<tr><td class="ps-pos">'+label+'</td><td>'+h.dealt.toLocaleString()+'</td><td>'+h.played.toLocaleString()+'</td><td>'+h.play_rate+'%</td><td class="'+c(h.avg_pnl_bb)+'">'+(h.avg_pnl_bb >= 0 ? '+' : '')+h.avg_pnl_bb.toFixed(2)+'</td><td class="'+c(h.total_pnl_bb)+'">'+(h.total_pnl_bb >= 0 ? '+' : '')+h.total_pnl_bb.toFixed(1)+'</td></tr>';
            }).join('')}
          </tbody>
        </table>
      </div>

      <!-- Hand Quality Chart -->
      <div class="ps-card">
        <div class="ps-card-title">\\ud83d\\udcca Total P&L by Hand Category (bb)</div>
        <div style="height:280px;position:relative"><canvas id="da-hq-chart"></canvas></div>
      </div>

      <!-- Insights -->
      <div class="ps-card" style="border-left:3px solid var(--gold)">
        <div class="ps-card-title">\\ud83d\\udca1 Hand Quality Insights</div>
        <div style="font-size:0.82rem;color:var(--text2);line-height:1.65">
          <div style="margin-bottom:0.4rem">\\u2705 <strong style="color:var(--green)">Premium hands</strong> avg +1.30 bb/hand \\u2014 your bread and butter</div>
          <div style="margin-bottom:0.4rem">\\u2705 <strong style="color:var(--green)">Strong aces</strong> avg +0.24 bb/hand \\u2014 profitable selection</div>
          <div style="margin-bottom:0.4rem">\\u26a0\\ufe0f <strong style="color:var(--gold)">Suited only</strong> avg -0.80 bb/hand \\u2014 bleeding money, fold more</div>
          <div style="margin-bottom:0.4rem">\\u274c <strong style="color:var(--red)">Trash hands</strong> avg -2.60 bb/hand \\u2014 every trash hand costs 2.6 big blinds</div>
        </div>
      </div>

      <!-- Limp Analysis -->
      <div class="ps-card" style="border-left:3px solid var(--red)">
        <div class="ps-card-title">\\ud83e\\uddf9 Limp Analysis</div>
        <div class="da-stats-grid" style="grid-template-columns:1fr 1fr">
          <div class="da-stat-box"><div class="da-stat-label">Total Limps</div><div class="da-stat-val">\${D.preflop.limp_analysis.total_limps.toLocaleString()}</div></div>
          <div class="da-stat-box" style="border-color:var(--red)"><div class="da-stat-label">Avg P&L per Limp</div><div class="da-stat-val" style="color:var(--red)">\${D.preflop.limp_analysis.avg_pnl_per_limp_bb} bb</div></div>
        </div>
        <div style="font-size:0.82rem;color:var(--text2);margin-top:0.75rem">
          <div class="ps-card-title" style="font-size:0.75rem">Limps by Position</div>
          \${Object.entries(D.preflop.limp_analysis.by_position).sort((a,b)=>b[1]-a[1]).map(([p, v]) => '<div style="display:flex;justify-content:space-between;padding:0.3rem 0;border-bottom:1px solid rgba(255,255,255,0.03)"><span>'+p+'</span><span style="font-weight:600">'+v.toLocaleString()+'</span></div>').join('')}
        </div>
        <div style="font-size:0.78rem;color:var(--red);margin-top:0.75rem;font-weight:600">\\ud83d\\udca1 Every limp costs you half a big blind on average. Stop limping.</div>
      </div>
    \`;

    // ========== TAB: OPPONENTS ==========
    const oppEntries = Object.entries(D.opponents).sort((a,b) => b[1].hands - a[1].hands);
    const opponentsHTML = \`
      <div class="ps-card">
        <div class="ps-card-title">\\ud83d\\udc65 Opponents (5K+ hands) \\u2014 \${oppEntries.length} players</div>
        <div style="overflow-x:auto">
        <table class="ps-table" id="da-opp-table">
          <thead><tr><th>Name</th><th>Hands</th><th>VPIP</th><th>PFR</th><th>AF</th><th>3-Bet</th><th>C-bet</th><th>WTSD</th><th>Hero P&L</th><th>Hero bb/100</th></tr></thead>
          <tbody>
            \${oppEntries.map(([name, o]) => {
              return '<tr><td class="ps-pos">'+name+'</td><td>'+o.hands.toLocaleString()+'</td><td>'+o.vpip+'%</td><td>'+o.pfr+'%</td><td>'+o.af+'</td><td>'+o.three_bet+'%</td><td>'+o.cbet+'%</td><td>'+o.wtsd+'%</td><td class="'+c(o.hero_pnl_vs_eur)+'">'+f(o.hero_pnl_vs_eur)+'</td><td class="'+c(o.hero_bb100_vs)+'">'+(o.hero_bb100_vs >= 0 ? '+' : '')+o.hero_bb100_vs+'</td></tr>';
            }).join('')}
          </tbody>
        </table>
        </div>
      </div>

      <div class="ps-grid-2">
        <div class="ps-card" style="border-top:3px solid var(--red)">
          <div class="ps-card-title" style="color:var(--red)">\\ud83d\\udea8 Worst Matchups</div>
          \${oppEntries.sort((a,b) => a[1].hero_pnl_vs_eur - b[1].hero_pnl_vs_eur).slice(0,5).map(([n,o]) => '<div style="display:flex;justify-content:space-between;padding:0.45rem 0;border-bottom:1px solid rgba(255,255,255,0.03);font-size:0.82rem"><span style="font-weight:600;color:var(--text)">'+n+'</span><span style="color:var(--red);font-weight:600">'+f(o.hero_pnl_vs_eur)+' ('+o.hero_bb100_vs+' bb/100)</span></div>').join('')}
        </div>
        <div class="ps-card" style="border-top:3px solid var(--green)">
          <div class="ps-card-title" style="color:var(--green)">\\u2705 Best Matchups</div>
          \${oppEntries.sort((a,b) => b[1].hero_pnl_vs_eur - a[1].hero_pnl_vs_eur).slice(0,5).map(([n,o]) => '<div style="display:flex;justify-content:space-between;padding:0.45rem 0;border-bottom:1px solid rgba(255,255,255,0.03);font-size:0.82rem"><span style="font-weight:600;color:var(--text)">'+n+'</span><span style="color:var(--green);font-weight:600">'+f(o.hero_pnl_vs_eur)+' (+'+o.hero_bb100_vs+' bb/100)</span></div>').join('')}
        </div>
      </div>

      <!-- Scatter Plot -->
      <div class="ps-card">
        <div class="ps-card-title">\\ud83d\\udcca VPIP vs AF \\u2014 Opponent Map</div>
        <div style="height:320px;position:relative"><canvas id="da-opp-scatter"></canvas></div>
      </div>
    \`;

    // ========== TAB: SESSIONS ==========
    const sa = D.session_analysis;
    const ta = D.time_analysis;
    const ti = D.tilt_analysis;
    const mt = D.multitabling_analysis;
    const sm = D.stake_movement_analysis;
    const sessionsHTML = \`
      <!-- Session Stats -->
      <div class="da-stats-grid">
        <div class="da-stat-box"><div class="da-stat-label">Total Sessions</div><div class="da-stat-val">\${sa.total_sessions.toLocaleString()}</div></div>
        <div class="da-stat-box" style="border-color:var(--green)"><div class="da-stat-label">Win Rate</div><div class="da-stat-val">\${sa.win_rate_pct.toFixed(1)}%</div></div>
        <div class="da-stat-box"><div class="da-stat-label">Avg Win Session</div><div class="da-stat-val" style="color:var(--green)">+\${sa.avg_winning_session_eur.toFixed(2)}</div></div>
        <div class="da-stat-box"><div class="da-stat-label">Avg Loss Session</div><div class="da-stat-val" style="color:var(--red)">\${sa.avg_losing_session_eur.toFixed(2)}</div></div>
        <div class="da-stat-box" style="border-color:var(--green)"><div class="da-stat-label">Biggest Win</div><div class="da-stat-val" style="color:var(--green)">+\${sa.biggest_win_session_eur.toFixed(2)}</div></div>
        <div class="da-stat-box" style="border-color:var(--red)"><div class="da-stat-label">Biggest Loss</div><div class="da-stat-val" style="color:var(--red)">\${sa.biggest_loss_session_eur.toFixed(2)}</div></div>
        <div class="da-stat-box"><div class="da-stat-label">Max Losing Streak</div><div class="da-stat-val" style="color:var(--red)">\${sa.max_losing_streak}</div></div>
        <div class="da-stat-box"><div class="da-stat-label">Avg Hands/Session</div><div class="da-stat-val">\${sa.avg_session_hands.toFixed(0)}</div></div>
      </div>

      <!-- Day of Week -->
      <div class="ps-card">
        <div class="ps-card-title">\\ud83d\\udcc5 P&L by Day of Week</div>
        <div style="height:260px;position:relative"><canvas id="da-dow-chart"></canvas></div>
      </div>

      <!-- Hour of Day -->
      <div class="ps-card">
        <div class="ps-card-title">\\u23f0 P&L by Hour of Day</div>
        <div style="height:260px;position:relative"><canvas id="da-hour-chart"></canvas></div>
      </div>

      <!-- Session Length -->
      <div class="ps-card">
        <div class="ps-card-title">\\ud83d\\udccf Session Length</div>
        <div class="ps-grid-3">
          \${Object.entries(sa.session_length_distribution).map(([k, v]) => {
            const labels = { short_1_20: '1-20 hands', medium_21_100: '21-100 hands', long_100_plus: '100+ hands' };
            return '<div class="da-stat-box"><div class="da-stat-label">'+(labels[k]||k)+'</div><div class="da-stat-val">'+v.count+' sessions</div><div style="font-size:0.72rem;margin-top:0.3rem" class="'+c(v.avg_pnl)+'">Avg: '+(v.avg_pnl>=0?'+':'')+v.avg_pnl.toFixed(2)+'</div></div>';
          }).join('')}
        </div>
      </div>

      <!-- Tilt Analysis -->
      <div class="ps-card">
        <div class="ps-card-title">\\ud83e\\udde0 Tilt Analysis</div>
        <div class="ps-grid-3">
          <div class="da-stat-box" style="border-color:var(--red)">
            <div class="da-stat-label">After Big Loss (>50)</div>
            <div class="da-stat-val" style="color:var(--red)">\${ti.after_big_loss_gt_50eur.avg_pnl.toFixed(2)}/session</div>
            <div style="font-size:0.68rem;color:var(--text3)">\${ti.after_big_loss_gt_50eur.sessions} sessions</div>
          </div>
          <div class="da-stat-box" style="border-color:var(--gold)">
            <div class="da-stat-label">After Big Win (>50)</div>
            <div class="da-stat-val" style="color:var(--gold)">\${ti.after_big_win_gt_50eur.avg_pnl.toFixed(2)}/session</div>
            <div style="font-size:0.68rem;color:var(--text3)">\${ti.after_big_win_gt_50eur.sessions} sessions</div>
          </div>
          <div class="da-stat-box" style="border-color:var(--green)">
            <div class="da-stat-label">After Normal Session</div>
            <div class="da-stat-val" style="color:var(--text2)">\${ti.after_normal_session.avg_pnl.toFixed(2)}/session</div>
            <div style="font-size:0.68rem;color:var(--text3)">\${ti.after_normal_session.sessions} sessions</div>
          </div>
        </div>
      </div>

      <!-- Multitabling -->
      <div class="ps-card">
        <div class="ps-card-title">\\ud83d\\udcbb Multitabling Analysis</div>
        <div class="ps-grid-3">
          \${[['1 Table', mt['1_table']], ['2-3 Tables', mt['2_3_tables']], ['4+ Tables', mt['4_plus_tables']]].map(([label, v]) => '<div class="da-stat-box"><div class="da-stat-label">'+label+'</div><div class="da-stat-val" class="'+c(v.pnl)+'">'+f(v.pnl)+'</div><div style="font-size:0.68rem;color:var(--text3)">'+v.sessions+' sessions \\u00b7 '+v.hands.toLocaleString()+' hands</div></div>').join('')}
        </div>
      </div>

      <!-- Stake Movement -->
      <div class="ps-card">
        <div class="ps-card-title">\\ud83d\\udcc8 Stake Movement</div>
        <div class="ps-grid-3">
          <div class="da-stat-box" style="border-color:var(--red)">
            <div class="da-stat-label">Moved Up Stakes</div>
            <div class="da-stat-val" style="color:var(--red)">\${sm.moved_up_stakes.avg_pnl.toFixed(2)}/session</div>
            <div style="font-size:0.68rem;color:var(--text3)">\${sm.moved_up_stakes.sessions} sessions</div>
          </div>
          <div class="da-stat-box" style="border-color:var(--gold)">
            <div class="da-stat-label">Moved Down Stakes</div>
            <div class="da-stat-val" style="color:var(--gold)">\${sm.moved_down_stakes.avg_pnl.toFixed(2)}/session</div>
            <div style="font-size:0.68rem;color:var(--text3)">\${sm.moved_down_stakes.sessions} sessions</div>
          </div>
          <div class="da-stat-box">
            <div class="da-stat-label">Same Stakes</div>
            <div class="da-stat-val" style="color:var(--text2)">\${sm.same_stakes.avg_pnl.toFixed(2)}/session</div>
            <div style="font-size:0.68rem;color:var(--text3)">\${sm.same_stakes.sessions} sessions</div>
          </div>
        </div>
      </div>
    \`;

    // ========== TAB: TRENDS ==========
    const trendsHTML = \`
      <div class="ps-grid-2">
        <div class="ps-card" style="border-top:3px solid var(--red)">
          <div class="ps-card-title" style="color:var(--red)">\\u26a0\\ufe0f Concerning Trends</div>
          \${D.trends.concerning.map(t => '<div style="padding:0.45rem 0;border-bottom:1px solid rgba(255,255,255,0.03);font-size:0.8rem;color:var(--text2)">\\ud83d\\udfe5 '+t+'</div>').join('')}
        </div>
        <div class="ps-card" style="border-top:3px solid var(--green)">
          <div class="ps-card-title" style="color:var(--green)">\\u2705 Stable Stats</div>
          \${D.trends.stable.map(t => '<div style="padding:0.45rem 0;border-bottom:1px solid rgba(255,255,255,0.03);font-size:0.8rem;color:var(--text2)">\\ud83d\\udfe9 '+t+'</div>').join('')}
        </div>
      </div>

      <!-- Weekly P&L Curve -->
      <div class="ps-card">
        <div class="ps-card-title">\\ud83d\\udcc9 Weekly P&L Curve (Cumulative)</div>
        <div style="height:300px;position:relative"><canvas id="da-trends-pnl"></canvas></div>
      </div>

      <!-- Confidence -->
      <div class="ps-card">
        <div class="ps-card-title">\\ud83d\\udd12 Data Confidence Levels</div>
        \${Object.entries(D._metadata.confidence).map(([k, v]) => {
          const dot = v.startsWith('HIGH') ? 'high' : v.startsWith('MEDIUM') ? 'medium' : 'approx';
          return '<div class="ps-conf-row"><div class="ps-conf-dot '+dot+'"></div><div class="ps-conf-key">'+k.replace(/_/g,' ')+'</div><div class="ps-conf-val">'+v+'</div></div>';
        }).join('')}
      </div>
    \`;

    // ========== TAB: BB/SB ANALYSIS ==========
    const sb = D.preflop.by_position.SB || {hands:0,vpip:0,pfr:0,limp:0,three_bet:0,fold_vs_raise:0,cold_call:0,rfi:0};
    const bb = D.preflop.by_position.BB || {hands:0,vpip:0,pfr:0,limp:0,three_bet:0,fold_vs_raise:0,cold_call:0,rfi:0};
    const sbPost = D.postflop.by_position_computed?.SB || {cbet_pct:0,fold_to_cbet_pct:0,wtsd_pct:0,wsd_pct:0,saw_flop:0};
    const bbPost = D.postflop.by_position_computed?.BB || {cbet_pct:0,fold_to_cbet_pct:0,wtsd_pct:0,wsd_pct:0,saw_flop:0};
    const bbsbHTML = \`
      <div class="ps-card">
        <div class="ps-card-title">\\ud83c\\udfb2 Blind Defense Analysis</div>
        <div style="font-size:0.82rem;color:var(--text2);margin-bottom:0.75rem">How you play from the two worst positions \\u2014 the two seats where you lose money by default. Cutting losses here is one of the biggest winrate boosts.</div>
      </div>

      <div class="ps-grid-2">
        <!-- SB Card -->
        <div class="ps-card" style="border-top:3px solid var(--red)">
          <div class="ps-card-title" style="color:var(--red)">\\ud83d\\udd34 \${tip('Small Blind','SB')} \\u2014 \${sb.hands.toLocaleString()} hands</div>
          <div class="da-mini-stats">
            <div><span class="da-mini-label">\${tip('VPIP')}</span><span class="da-mini-val" style="color:\${sb.vpip>40?'var(--red)':sb.vpip>30?'var(--gold)':'var(--green)'}">\${sb.vpip}%</span></div>
            <div><span class="da-mini-label">\${tip('PFR')} (open-raise)</span><span class="da-mini-val">\${sb.pfr}%</span></div>
            <div><span class="da-mini-label">\${tip('Limp')} (CRITICAL leak)</span><span class="da-mini-val" style="color:\${sb.limp>10?'var(--red)':sb.limp>5?'var(--gold)':'var(--green)'}">\${sb.limp}%</span></div>
            <div><span class="da-mini-label">\${tip('3-Bet')} vs open</span><span class="da-mini-val">\${sb.three_bet}%</span></div>
            <div><span class="da-mini-label">\${tip('Cold Call')} vs open</span><span class="da-mini-val">\${sb.cold_call}%</span></div>
            <div><span class="da-mini-label">\${tip('Fold to 3-Bet')}</span><span class="da-mini-val">\${sb.fold_to_3bet}%</span></div>
            <div><span class="da-mini-label">\${tip('C-Bet')} flop</span><span class="da-mini-val">\${sbPost.cbet_pct}%</span></div>
            <div><span class="da-mini-label">\${tip('WTSD')}</span><span class="da-mini-val">\${sbPost.wtsd_pct}%</span></div>
          </div>
          <div style="margin-top:0.85rem;padding:0.75rem;background:rgba(239,68,68,0.08);border-radius:8px;font-size:0.78rem;color:var(--text2);line-height:1.55">
            <div style="font-weight:700;color:var(--red);margin-bottom:0.4rem">\\ud83d\\udcd6 Profitable SB Ranges (PLO 6-max GTO)</div>
            <div><strong>3-Bet (vs late opens):</strong> AAxx, KKxx (suited/conn), premium DS rundowns (JT98ds+), strong AK-suited combos.</div>
            <div style="margin-top:0.3rem"><strong>Cold-Call:</strong> NEVER from SB \\u2014 you're OOP for entire hand. 3-bet or fold.</div>
            <div style="margin-top:0.3rem"><strong>Open-raise (folded to SB):</strong> ~22-32% of hands \\u2014 anything playable becomes a raise.</div>
            <div style="margin-top:0.3rem"><strong>NEVER limp.</strong> Every SB limp = -0.3 bb on average.</div>
          </div>
        </div>

        <!-- BB Card -->
        <div class="ps-card" style="border-top:3px solid var(--gold)">
          <div class="ps-card-title" style="color:var(--gold)">\\ud83d\\udfe1 \${tip('Big Blind','BB')} \\u2014 \${bb.hands.toLocaleString()} hands</div>
          <div class="da-mini-stats">
            <div><span class="da-mini-label">\${tip('VPIP')}</span><span class="da-mini-val">\${bb.vpip}%</span></div>
            <div><span class="da-mini-label">\${tip('PFR')}</span><span class="da-mini-val">\${bb.pfr}%</span></div>
            <div><span class="da-mini-label">\${tip('3-Bet')} vs open</span><span class="da-mini-val" style="color:\${bb.three_bet<6?'var(--red)':bb.three_bet>14?'var(--red)':'var(--green)'}">\${bb.three_bet}%</span></div>
            <div><span class="da-mini-label">\${tip('Cold Call')} vs open</span><span class="da-mini-val">\${bb.cold_call}%</span></div>
            <div><span class="da-mini-label">\${tip('Fold')} vs raise</span><span class="da-mini-val" style="color:\${bb.fold_vs_raise>70?'var(--red)':'var(--text)'}">\${bb.fold_vs_raise}%</span></div>
            <div><span class="da-mini-label">\${tip('C-Bet')} flop (as PFR)</span><span class="da-mini-val">\${bbPost.cbet_pct}%</span></div>
            <div><span class="da-mini-label">\${tip('Fold to C-Bet')}</span><span class="da-mini-val" style="color:\${bbPost.fold_to_cbet_pct>55?'var(--red)':'var(--text)'}">\${bbPost.fold_to_cbet_pct}%</span></div>
            <div><span class="da-mini-label">\${tip('WTSD')}</span><span class="da-mini-val">\${bbPost.wtsd_pct}%</span></div>
          </div>
          <div style="margin-top:0.85rem;padding:0.75rem;background:rgba(234,179,8,0.08);border-radius:8px;font-size:0.78rem;color:var(--text2);line-height:1.55">
            <div style="font-weight:700;color:var(--gold);margin-bottom:0.4rem">\\ud83d\\udcd6 Profitable BB Defense (PLO 6-max GTO)</div>
            <div><strong>3-Bet (vs late opens):</strong> AAxx (always), KKxx-DS, top rundowns. Target ~7-12%.</div>
            <div style="margin-top:0.3rem"><strong>Cold-Call:</strong> Wide \\u2014 ~25-35% vs SB, ~22-30% vs BTN. Suited Aces, all rundowns 9-high+, double-suited junk OK at low SPR.</div>
            <div style="margin-top:0.3rem"><strong>Fold:</strong> Disconnected rainbow trash even at price. Do not defend with no-equity hands.</div>
            <div style="margin-top:0.3rem"><strong>Postflop:</strong> Defend with backdoors + check-raise sets/strong draws \\u2014 do not fold every flop you miss.</div>
          </div>
        </div>
      </div>

      <!-- Auto-detected blind leaks -->
      <div class="ps-card">
        <div class="ps-card-title">\\ud83d\\udd0d Auto-Detected Blind Leaks</div>
        <div style="display:flex;flex-direction:column;gap:0.6rem">
          \${(() => {
            const ls = [];
            if (sb.limp > 10) ls.push('<div style="padding:0.7rem;background:rgba(239,68,68,0.1);border-left:3px solid var(--red);border-radius:6px;font-size:0.82rem"><strong style="color:var(--red)">SB limp '+sb.limp+'%</strong> \\u2014 every SB limp loses 0.3-0.5 bb on average. Play 3-bet/fold from SB. <strong>Stop limping.</strong></div>');
            if (sb.cold_call > 10) ls.push('<div style="padding:0.7rem;background:rgba(234,179,8,0.1);border-left:3px solid var(--gold);border-radius:6px;font-size:0.82rem"><strong style="color:var(--gold)">SB cold-call '+sb.cold_call+'%</strong> \\u2014 Cold-calling OOP from SB gives away initiative + position. 3-bet premiums, fold the rest.</div>');
            if (bb.fold_vs_raise > 75) ls.push('<div style="padding:0.7rem;background:rgba(239,68,68,0.1);border-left:3px solid var(--red);border-radius:6px;font-size:0.82rem"><strong style="color:var(--red)">BB folds '+bb.fold_vs_raise+'% vs raise</strong> \\u2014 Too tight. With 1bb already in, you need ~70% fold rate max. Defend more rundowns + suited connectors.</div>');
            if (bb.three_bet < 5) ls.push('<div style="padding:0.7rem;background:rgba(234,179,8,0.1);border-left:3px solid var(--gold);border-radius:6px;font-size:0.82rem"><strong style="color:var(--gold)">BB 3-bet '+bb.three_bet+'%</strong> \\u2014 Below GTO 7-12%. Add more 3-bets with AA/KK to balance your range.</div>');
            if (bbPost.fold_to_cbet_pct > 60) ls.push('<div style="padding:0.7rem;background:rgba(239,68,68,0.1);border-left:3px solid var(--red);border-radius:6px;font-size:0.82rem"><strong style="color:var(--red)">BB folds '+bbPost.fold_to_cbet_pct+'% to flop c-bet</strong> \\u2014 You are getting bluffed off equity. Float more with backdoors.</div>');
            return ls.length ? ls.join('') : '<div style="padding:0.7rem;background:rgba(34,197,94,0.1);border-left:3px solid var(--green);border-radius:6px;font-size:0.82rem;color:var(--green)">\\u2705 No major blind leaks detected.</div>';
          })()}
        </div>
      </div>
    \`;

    // ========== TAB: POSITION PERFORMANCE ==========
    const posperfHTML = \`
      <div class="ps-card">
        <div class="ps-card-title">\\ud83c\\udfaf Performance by \${tip('Position','BTN').replace('Button','Position')}</div>
        <div style="font-size:0.82rem;color:var(--text2);margin-bottom:0.75rem">Your stat profile at every seat. Green = in GTO range, Gold = below, Red = above.</div>
        <table class="ps-table">
          <thead><tr><th>Pos</th><th>Hands</th><th>\${tip('VPIP')}</th><th>\${tip('PFR')}</th><th>\${tip('RFI')}</th><th>\${tip('3-Bet')}</th><th>\${tip('Cold Call')}</th><th>\${tip('Fold to 3-Bet')}</th><th>\${tip('C-Bet')} flop</th><th>\${tip('WTSD')}</th></tr></thead>
          <tbody>
            \${positions.map(p => {
              const s = D.preflop.by_position[p]; if (!s) return '';
              const ps = D.postflop.by_position_computed?.[p] || {cbet_pct:0,wtsd_pct:0};
              const g = gto.preflop_by_position[p] || {};
              const cz = (v, r) => !r ? '' : (v >= r[0] && v <= r[1]) ? 'ps-positive' : (v < r[0] ? 'ps-warn' : 'ps-negative');
              return '<tr><td class="ps-pos">'+tip(p,p)+'</td><td>'+s.hands.toLocaleString()+'</td><td class="'+cz(s.vpip,g.vpip)+'">'+s.vpip+'%</td><td class="'+cz(s.pfr,g.pfr)+'">'+s.pfr+'%</td><td>'+s.rfi+'%</td><td class="'+cz(s.three_bet,g.three_bet)+'">'+s.three_bet+'%</td><td>'+s.cold_call+'%</td><td>'+s.fold_to_3bet+'%</td><td>'+ps.cbet_pct+'%</td><td>'+ps.wtsd_pct+'%</td></tr>';
            }).join('')}
          </tbody>
        </table>
      </div>

      <!-- Best & Worst Positions -->
      <div class="ps-grid-2">
        <div class="ps-card" style="border-top:3px solid var(--green)">
          <div class="ps-card-title" style="color:var(--green)">\\u2705 Best Performing Positions</div>
          \${(() => {
            // Score = closeness to GTO targets
            const scored = positions.map(p => {
              const s = D.preflop.by_position[p]; const g = gto.preflop_by_position[p];
              if (!s || !g) return null;
              let score = 0, pen = 0;
              if (g.vpip) { const mid = (g.vpip[0]+g.vpip[1])/2; pen += Math.abs(s.vpip - mid); }
              if (g.pfr) { const mid = (g.pfr[0]+g.pfr[1])/2; pen += Math.abs(s.pfr - mid)*1.5; }
              if (g.limp) { pen += Math.max(0, s.limp - g.limp[1])*3; }
              return { p, hands: s.hands, score: -pen };
            }).filter(Boolean).sort((a,b) => b.score - a.score);
            return scored.slice(0, 3).map((x, i) => '<div style="display:flex;justify-content:space-between;padding:0.55rem 0;border-bottom:1px solid rgba(255,255,255,0.03)"><span style="font-weight:600">'+(i+1)+'. '+tip(x.p,x.p)+' ('+x.hands.toLocaleString()+' hands)</span><span style="color:var(--green);font-weight:700">Closest to GTO</span></div>').join('');
          })()}
        </div>
        <div class="ps-card" style="border-top:3px solid var(--red)">
          <div class="ps-card-title" style="color:var(--red)">\\u26a0\\ufe0f Worst Performing Positions</div>
          \${(() => {
            const scored = positions.map(p => {
              const s = D.preflop.by_position[p]; const g = gto.preflop_by_position[p];
              if (!s || !g) return null;
              let pen = 0;
              if (g.vpip) { const mid = (g.vpip[0]+g.vpip[1])/2; pen += Math.abs(s.vpip - mid); }
              if (g.pfr) { const mid = (g.pfr[0]+g.pfr[1])/2; pen += Math.abs(s.pfr - mid)*1.5; }
              if (g.limp) { pen += Math.max(0, s.limp - g.limp[1])*3; }
              return { p, hands: s.hands, pen, vpip:s.vpip, pfr:s.pfr, limp:s.limp };
            }).filter(Boolean).sort((a,b) => b.pen - a.pen);
            return scored.slice(0, 3).map((x, i) => '<div style="padding:0.55rem 0;border-bottom:1px solid rgba(255,255,255,0.03);font-size:0.82rem"><div style="display:flex;justify-content:space-between"><span style="font-weight:600">'+(i+1)+'. '+tip(x.p,x.p)+' ('+x.hands.toLocaleString()+' hands)</span><span style="color:var(--red);font-weight:700">Off by '+x.pen.toFixed(1)+'pts</span></div><div style="font-size:0.72rem;color:var(--text3);margin-top:0.2rem">VPIP '+x.vpip+'% / PFR '+x.pfr+'% / Limp '+x.limp+'%</div></div>').join('');
          })()}
        </div>
      </div>

      <!-- Best & Worst Hand Categories (overall) -->
      <div class="ps-card">
        <div class="ps-card-title">\\ud83d\\udd25 Best & Worst Hand Categories Overall</div>
        <div style="font-size:0.78rem;color:var(--text3);margin-bottom:0.5rem">Hover any category for the exact ranges it includes.</div>
        <div class="ps-grid-2">
          <div>
            <div style="font-weight:700;color:var(--green);margin-bottom:0.5rem;font-size:0.82rem">\\u2705 Most Profitable</div>
            \${Object.entries(D.hand_quality).filter(([_,v]) => v.played > 50).sort((a,b) => b[1].avg_pnl_bb - a[1].avg_pnl_bb).slice(0,4).map(([k,v]) => { const lab = k.split('_').map(w=>w[0].toUpperCase()+w.slice(1)).join(' '); return '<div style="display:flex;justify-content:space-between;padding:0.4rem 0;border-bottom:1px solid rgba(255,255,255,0.03);font-size:0.8rem"><span>'+tip(lab, lab.replace(/ /g,' '))+' <span style="color:var(--text3);font-size:0.7rem">('+v.played+' played)</span></span><span style="color:'+(v.avg_pnl_bb>=0?'var(--green)':'var(--red)')+';font-weight:700">'+(v.avg_pnl_bb>=0?'+':'')+v.avg_pnl_bb+' bb/hand</span></div>'; }).join('')}
          </div>
          <div>
            <div style="font-weight:700;color:var(--red);margin-bottom:0.5rem;font-size:0.82rem">\\u274c Biggest Bleeders</div>
            \${Object.entries(D.hand_quality).filter(([_,v]) => v.played > 50).sort((a,b) => a[1].avg_pnl_bb - b[1].avg_pnl_bb).slice(0,4).map(([k,v]) => { const lab = k.split('_').map(w=>w[0].toUpperCase()+w.slice(1)).join(' '); return '<div style="display:flex;justify-content:space-between;padding:0.4rem 0;border-bottom:1px solid rgba(255,255,255,0.03);font-size:0.8rem"><span>'+tip(lab, lab)+' <span style="color:var(--text3);font-size:0.7rem">('+v.played+' played)</span></span><span style="color:var(--red);font-weight:700">'+v.avg_pnl_bb+' bb/hand</span></div>'; }).join('')}
          </div>
        </div>
      </div>
    \`;

    // ========== TAB: CALL LEAK DETECTION ==========
    const callleakHTML = \`
      <div class="ps-card">
        <div class="ps-card-title">\\ud83d\\udcde Where Your Calls Bleed Money</div>
        <div style="font-size:0.82rem;color:var(--text2);margin-bottom:0.75rem">Calling stations lose. This tab shows where you call too much (limp, cold-call, fold-to-cbet refusals) and what to fix.</div>
        <table class="ps-table">
          <thead><tr><th>Pos</th><th>\${tip('Limp')}</th><th>\${tip('Cold Call')}</th><th>\${tip('Fold to C-Bet')}</th><th>Risk</th></tr></thead>
          <tbody>
            \${positions.map(p => {
              const s = D.preflop.by_position[p]; if (!s) return '';
              const ps = D.postflop.by_position_computed?.[p] || {fold_to_cbet_pct:0};
              let risk = 0; const reasons = [];
              if (s.limp > 5) { risk += s.limp; reasons.push('Limp '+s.limp+'%'); }
              if (s.cold_call > 25 && p !== 'BB') { risk += (s.cold_call-25)*2; reasons.push('Wide cold-call '+s.cold_call+'%'); }
              if (ps.fold_to_cbet_pct > 60) { risk += ps.fold_to_cbet_pct - 50; reasons.push('Auto-fold to c-bet '+ps.fold_to_cbet_pct+'%'); }
              const col = risk > 30 ? 'var(--red)' : risk > 15 ? 'var(--gold)' : 'var(--green)';
              const lvl = risk > 30 ? 'HIGH' : risk > 15 ? 'MED' : 'OK';
              return '<tr><td class="ps-pos">'+tip(p,p)+'</td><td class="'+(s.limp>5?'ps-negative':'')+'">'+s.limp+'%</td><td>'+s.cold_call+'%</td><td class="'+(ps.fold_to_cbet_pct>60?'ps-negative':'')+'">'+ps.fold_to_cbet_pct+'%</td><td><span style="color:'+col+';font-weight:700">'+lvl+'</span> <span style="color:var(--text3);font-size:0.7rem">'+reasons.join(' \\u00b7 ')+'</span></td></tr>';
            }).join('')}
          </tbody>
        </table>
      </div>

      <div class="ps-card" style="border-left:3px solid var(--red)">
        <div class="ps-card-title">\\ud83e\\uddf9 Limp Bleed Report</div>
        <div class="ps-grid-3">
          <div class="da-stat-box"><div class="da-stat-label">Total Limps</div><div class="da-stat-val">\${D.preflop.limp_analysis.total_limps.toLocaleString()}</div></div>
          <div class="da-stat-box" style="border-color:var(--red)"><div class="da-stat-label">Avg P&L per Limp</div><div class="da-stat-val" style="color:var(--red)">\${D.preflop.limp_analysis.avg_pnl_per_limp_bb} bb</div></div>
          <div class="da-stat-box" style="border-color:var(--red)"><div class="da-stat-label">Estimated Total Loss from Limps</div><div class="da-stat-val" style="color:var(--red)">\${(D.preflop.limp_analysis.total_limps * D.preflop.limp_analysis.avg_pnl_per_limp_bb).toFixed(0)} bb</div></div>
        </div>
        <div style="margin-top:0.85rem;padding:0.75rem;background:rgba(239,68,68,0.08);border-radius:8px;font-size:0.8rem;color:var(--text2);line-height:1.55">
          <strong style="color:var(--red)">Why limping loses:</strong> You give the BB free flops, you build no fold equity, and you cap your range. In PLO, the equity gap between hands is small \\u2014 if you are not raising, you should be folding.
        </div>
      </div>

      <div class="ps-card">
        <div class="ps-card-title">\\ud83d\\udca1 Action Plan to Stop Bleeding Calls</div>
        <div style="display:flex;flex-direction:column;gap:0.5rem;font-size:0.82rem">
          <div style="padding:0.65rem;background:rgba(99,102,241,0.08);border-left:3px solid var(--blue);border-radius:6px"><strong>1.</strong> Cut all SB limps \\u2014 either raise or fold. Target SB limp: 0%.</div>
          <div style="padding:0.65rem;background:rgba(99,102,241,0.08);border-left:3px solid var(--blue);border-radius:6px"><strong>2.</strong> Stop cold-calling from SB entirely. Cold-calling OOP for one street is fine, for four streets is suicide.</div>
          <div style="padding:0.65rem;background:rgba(99,102,241,0.08);border-left:3px solid var(--blue);border-radius:6px"><strong>3.</strong> Defend BB wider vs late-position opens with rundowns + suited Aces. Target BB fold-vs-raise: 65-70%.</div>
          <div style="padding:0.65rem;background:rgba(99,102,241,0.08);border-left:3px solid var(--blue);border-radius:6px"><strong>4.</strong> Do not auto-fold to flop c-bets when you have backdoors. Float wider \\u2014 PLO has tons of equity on most boards.</div>
          <div style="padding:0.65rem;background:rgba(99,102,241,0.08);border-left:3px solid var(--blue);border-radius:6px"><strong>5.</strong> Check-raise more on flop with sets/2-pair/strong draws \\u2014 do not just call.</div>
        </div>
      </div>
    \`;

    // ========== TAB: EV GRAPH ==========
    const evgraphHTML = \`
      <div class="ps-card">
        <div class="ps-card-title">\\ud83d\\udcc8 \${tip('EV')} vs Real Winnings</div>
        <div style="font-size:0.82rem;color:var(--text2);margin-bottom:0.75rem">Real cumulative P&L (solid) vs smoothed expected-value trendline (dashed). Gap above = running over EV (lucky), below = running under EV (cooler).</div>
        <div style="display:flex;gap:0.5rem;margin-bottom:0.75rem;flex-wrap:wrap">
          <select id="ev-period" class="ps-select" style="padding:0.4rem 0.6rem;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:0.78rem">
            <option value="all">All Time</option><option value="30">Last 30 days</option><option value="60">Last 60 days</option><option value="90">Last 90 days</option>
          </select>
          <select id="ev-stake" class="ps-select" style="padding:0.4rem 0.6rem;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:0.78rem">
            <option value="all">All Stakes</option>\${stakeRows.map(s => '<option value="'+s.label+'">'+s.label+'</option>').join('')}
          </select>
        </div>
        <div style="height:380px;position:relative"><canvas id="da-ev-chart"></canvas></div>
      </div>

      <div class="ps-grid-3">
        <div class="da-stat-box"><div class="da-stat-label">Real P&L</div><div class="da-stat-val" style="color:\${totalPnl>=0?'var(--green)':'var(--red)'}">\${f(totalPnl)}</div></div>
        <div class="da-stat-box"><div class="da-stat-label">EV Trend (smoothed)</div><div class="da-stat-val" style="color:var(--blue)" id="ev-trend-val">\\u2014</div></div>
        <div class="da-stat-box"><div class="da-stat-label">Variance Diff</div><div class="da-stat-val" id="ev-diff-val">\\u2014</div></div>
      </div>

      <div class="ps-card">
        <div class="ps-card-title">\\u2139\\ufe0f About this graph</div>
        <div style="font-size:0.82rem;color:var(--text2);line-height:1.6">
          True all-in EV requires hand-by-hand equity calculations from showdown spots. This graph approximates EV as a polynomial-smoothed trendline of your cumulative P&L \\u2014 the dashed line shows what a steady win-rate at your true skill level would look like, while the solid line shows actual results including variance.
        </div>
      </div>
    \`;

    // ========== TAB: RECENT (Last 5 days + Last session) ==========
    const today = new Date(); today.setHours(0,0,0,0);
    const sortedSessions = [...sessions].filter(s => s.date).sort((a,b) => new Date(b.date) - new Date(a.date));
    const lastSession = sortedSessions[0];
    const last5cutoff = new Date(today); last5cutoff.setDate(last5cutoff.getDate() - 5);
    const last5 = sortedSessions.filter(s => new Date(s.date) >= last5cutoff);
    const last30 = sortedSessions.filter(s => new Date(s.date) >= new Date(today.getTime() - 30*86400000));
    function aggSess(arr) {
      const p = arr.reduce((s,x) => s + (x.cashOut - x.buyIn), 0);
      const h = arr.reduce((s,x) => s + (x.hands||0), 0);
      let bbS = 0, bbH = 0;
      arr.forEach(x => { if (x.stakes) { const bb = parseFloat(x.stakes.split('/')[1])||0; if (bb>0) { bbS += bb*(x.hands||0); bbH += (x.hands||0); } } });
      const ab = bbH > 0 ? bbS/bbH : 0;
      return { p, h, sessions: arr.length, bb100: h > 0 && ab > 0 ? (p/ab)/(h/100) : 0 };
    }
    const a5 = aggSess(last5), a30 = aggSess(last30), aLast = lastSession ? { p: lastSession.cashOut - lastSession.buyIn, h: lastSession.hands||0, date: lastSession.date, stakes: lastSession.stakes } : null;
    // Trend: last 5 vs prior 5
    const prior5cutoff = new Date(today); prior5cutoff.setDate(prior5cutoff.getDate() - 10);
    const prior5 = sortedSessions.filter(s => new Date(s.date) >= prior5cutoff && new Date(s.date) < last5cutoff);
    const ap = aggSess(prior5);
    const trendArrow = a5.bb100 > ap.bb100 ? '\\u2197\\ufe0f' : a5.bb100 < ap.bb100 ? '\\u2198\\ufe0f' : '\\u27a1\\ufe0f';
    const trendCol = a5.bb100 > ap.bb100 ? 'var(--green)' : a5.bb100 < ap.bb100 ? 'var(--red)' : 'var(--text)';

    const recentHTML = \`
      <div class="ps-hero-row">
        <div class="ps-hero-card \${a5.p>=0?'green':'red'}">
          <div class="ps-hero-label">Last 5 Days</div>
          <div class="ps-hero-val" style="color:\${a5.p>=0?'var(--green)':'var(--red)'}">\${f(a5.p)}</div>
          <div class="ps-hero-sub">\${a5.h.toLocaleString()} hands \\u00b7 \${a5.sessions} sessions \\u00b7 \${fBB(a5.bb100)} \${tip('bb/100')}</div>
        </div>
        <div class="ps-hero-card \${a30.p>=0?'green':'red'}">
          <div class="ps-hero-label">Last 30 Days</div>
          <div class="ps-hero-val" style="color:\${a30.p>=0?'var(--green)':'var(--red)'}">\${f(a30.p)}</div>
          <div class="ps-hero-sub">\${a30.h.toLocaleString()} hands \\u00b7 \${a30.sessions} sessions \\u00b7 \${fBB(a30.bb100)} bb/100</div>
        </div>
        <div class="ps-hero-card blue">
          <div class="ps-hero-label">Trend (5d vs prior 5d)</div>
          <div class="ps-hero-val" style="color:\${trendCol}">\${trendArrow} \${(a5.bb100 - ap.bb100>=0?'+':'')}\${(a5.bb100 - ap.bb100).toFixed(2)} bb/100</div>
          <div class="ps-hero-sub">Prior 5d: \${fBB(ap.bb100)} bb/100 (\${ap.sessions} sessions)</div>
        </div>
        <div class="ps-hero-card \${aLast && aLast.p>=0?'green':'red'}">
          <div class="ps-hero-label">Last Session</div>
          <div class="ps-hero-val" style="color:\${aLast && aLast.p>=0?'var(--green)':'var(--red)'}">\${aLast?f(aLast.p):'\\u2014'}</div>
          <div class="ps-hero-sub">\${aLast?(aLast.h+' hands \\u00b7 '+aLast.stakes+' \\u00b7 '+aLast.date):'No data'}</div>
        </div>
      </div>

      <div class="ps-card">
        <div class="ps-card-title">\\ud83d\\udcca Recent Sessions (Last 10)</div>
        <table class="ps-table">
          <thead><tr><th>Date</th><th>Stakes</th><th>Hands</th><th>P&L</th><th>bb/100</th></tr></thead>
          <tbody>
            \${sortedSessions.slice(0, 10).map(s => { const pnl = s.cashOut - s.buyIn; const bb = s.stakes ? parseFloat(s.stakes.split('/')[1])||0 : 0; const bb100 = bb>0 && s.hands>0 ? (pnl/bb)/(s.hands/100) : 0; return '<tr><td class="ps-pos">'+s.date+'</td><td>'+(s.stakes||'-')+'</td><td>'+(s.hands||0).toLocaleString()+'</td><td class="'+c(pnl)+'">'+f(pnl)+'</td><td class="'+c(bb100)+'">'+fBB(bb100)+'</td></tr>'; }).join('')}
          </tbody>
        </table>
      </div>

      <div class="ps-card">
        <div class="ps-card-title">\\ud83d\\udcc8 Last 30 Days P&L Curve</div>
        <div style="height:280px;position:relative"><canvas id="da-recent-chart"></canvas></div>
      </div>
    \`;

    // ========== TAB: TOURNAMENTS ==========
    const T = D.tournaments || {};
    const tSum = T.summary || { entries:0, invested_eur:0, cashed_eur:0, net_eur:0, roi_pct:0, itm_pct:0, total_hands:0, avg_buyin_eur:0, biggest_cash_eur:0, biggest_cash_event:'', best_finish:0, best_finish_event:'', avg_hands_per_tourn:0, itm_count:0 };
    const tFmt = T.by_format || {};
    const tBuy = T.by_buyin || {};
    const tMon = T.by_month || {};
    const tFin = T.finish_distribution || {};
    const tTop = T.top_cashes || [];
    const tWorst = T.worst_busts || [];
    const tPre = T.preflop || { overall:{vpip:0,pfr:0,limp_pct:0}, by_position:{} };
    const tPost = T.postflop || { computed_percentages:{ flop:{}, turn:{}, river:{} } };
    const tSessions = T.sessions || [];
    const tournamentsHTML = (\`
      <!-- 📥 In-browser tournament zip importer -->
      <div class="ps-card" id="da-tourn-import-card" style="border-color:var(--gold-dim);background:linear-gradient(135deg, rgba(245,158,11,0.05), rgba(245,158,11,0.01))">
        <div class="ps-card-title" style="color:var(--gold);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem">
          <span>\\ud83d\\udce5 Import Tournament Zips</span>
          \${_mergedNew >= 0 && (function(){ try { return JSON.parse(localStorage.getItem('browserTournamentImports')||'[]').length; } catch(e){ return 0; } })() > 0 ? \`
            <span style="font-size:0.78rem;font-weight:400;color:var(--text2)">\\ud83d\\udcbe \${(function(){ try { return JSON.parse(localStorage.getItem('browserTournamentImports')||'[]').length; } catch(e){ return 0; } })()} browser-imported tournaments merged into stats <button id="da-tourn-clear" style="margin-left:0.5rem;padding:2px 8px;background:var(--red-dim);color:var(--red);border:none;border-radius:4px;cursor:pointer;font-size:0.72rem">Clear</button></span>
          \` : ''}
        </div>
        <div style="padding:0.5rem;color:var(--text2);font-size:0.85rem;margin-bottom:0.5rem">
          Drop your Novibet tournament .zip file(s) here. They'll be parsed in your browser, merged with existing stats (deduped by tournament code), and persist in localStorage.
          <br><span style="color:var(--text3);font-size:0.78rem">For permanent committed data + by-month/hand-level deep analysis, also drop the file onto <strong>IMPORT-TOURNAMENTS.bat</strong> in the project folder.</span>
        </div>
        <div id="da-tourn-drop" style="padding:1.2rem;border:2px dashed var(--gold-dim);border-radius:8px;text-align:center;cursor:pointer;background:rgba(245,158,11,0.03);transition:all 0.2s">
          <div style="font-size:1.4rem;margin-bottom:0.3rem">\\ud83c\\udfaf</div>
          <div id="da-tourn-drop-label" style="color:var(--text2);font-size:0.95rem">Drop tournament zip(s) here, or click to browse</div>
          <input type="file" id="da-tourn-input" accept=".zip" multiple style="display:none">
        </div>
        <div id="da-tourn-import-result" style="margin-top:0.75rem"></div>
      </div>

      \${T._empty || tSum.entries === 0 ? \`
        <div class="ps-card"><div class="ps-card-title">\\ud83c\\udfc6 No tournament data parsed yet</div><div style="padding:1rem;color:var(--text2)">Use the importer above for an instant summary, or run the parser via IMPORT-TOURNAMENTS.bat for the full deep analysis below.</div></div>
      \` : \`
      <!-- Tournament Hero Cards -->
      <div class="ps-hero-row">
        <div class="ps-hero-card \${(tSum.real_money_pnl_eur ?? tSum.net_eur) >= 0 ? 'green' : 'red'}">
          <div class="ps-hero-label">Tournament P&L (real money)</div>
          <div class="ps-hero-val" style="color:\${(tSum.real_money_pnl_eur ?? tSum.net_eur) >= 0 ? 'var(--green)' : 'var(--red)'}">\${f(tSum.real_money_pnl_eur ?? tSum.net_eur)}</div>
          <div class="ps-hero-sub" style="font-size:0.72rem">Out-of-pocket basis (tickets cost €0)</div>
        </div>
        <div class="ps-hero-card blue">
          <div class="ps-hero-label">Tournaments Played</div>
          <div class="ps-hero-val" style="color:var(--blue)">\${tSum.entries.toLocaleString()}</div>
          <div class="ps-hero-sub">\${tSum.total_hands.toLocaleString()} hands \\u00b7 \${tSum.avg_hands_per_tourn} avg</div>
        </div>
        <div class="ps-hero-card gold">
          <div class="ps-hero-label">Cash Buy-ins / Tickets Used</div>
          <div class="ps-hero-val" style="color:var(--gold);font-size:1.4rem">\${(tSum.cash_entries ?? 0)} / \${(tSum.ticket_entries ?? 0)}</div>
          <div class="ps-hero-sub">Real €\${(tSum.cash_invested_eur ?? 0).toFixed(2)} + Tickets €\${(tSum.ticket_value_eur ?? 0).toFixed(2)}</div>
        </div>
        <div class="ps-hero-card purple">
          <div class="ps-hero-label">ITM Rate</div>
          <div class="ps-hero-val" style="color:var(--purple)">\${tSum.itm_pct}%</div>
          <div class="ps-hero-sub">\${tSum.itm_count} of \${tSum.entries} cashed</div>
        </div>
      </div>

      <!-- Payment Method Breakdown -->
      \${(tSum.ticket_entries || tSum.cash_entries) ? \`
      <div class="ps-card" style="border-color:var(--gold-dim)">
        <div class="ps-card-title" style="color:var(--gold)">\\ud83c\\udfab Cash Buy-ins vs Rakeback Tickets</div>
        <div style="padding:0.5rem;color:var(--text3);font-size:0.78rem;margin-bottom:0.5rem">Tickets are earned from rakeback — they cost €0 real money but have face value. Tournament cashes from tickets are pure profit.</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:0.75rem">
          <!-- Cash -->
          <div style="padding:0.75rem;background:rgba(34,197,94,0.04);border:1px solid var(--green-dim);border-radius:6px">
            <div style="font-size:0.78rem;color:var(--text2);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.4rem">\\ud83d\\udcb0 Cash Buy-ins</div>
            <div style="display:grid;grid-template-columns:1fr auto;gap:0.3rem 1rem;font-size:0.88rem">
              <span style="color:var(--text2)">Entries</span><strong>\${tSum.cash_entries}</strong>
              <span style="color:var(--text2)">Real money in</span><strong>\\u20ac\${(tSum.cash_invested_eur ?? 0).toFixed(2)}</strong>
              <span style="color:var(--text2)">Cashed</span><strong>\\u20ac\${(tSum.cash_won_from_cash_entries_eur ?? 0).toFixed(2)}</strong>
              <span style="color:var(--text2)">Net</span><strong style="color:\${(tSum.cash_entries_net_eur ?? 0)>=0?'var(--green)':'var(--red)'}">\${f(tSum.cash_entries_net_eur ?? 0)}</strong>
              <span style="color:var(--text2)">ROI</span><strong style="color:\${(tSum.cash_entries_roi_pct ?? 0)>=0?'var(--green)':'var(--red)'}">\${(tSum.cash_entries_roi_pct ?? 0)>=0?'+':''}\${(tSum.cash_entries_roi_pct ?? 0)}%</strong>
              <span style="color:var(--text2)">ITM</span><strong>\${tSum.cash_entries_itm_pct ?? 0}%</strong>
            </div>
          </div>
          <!-- Ticket -->
          <div style="padding:0.75rem;background:rgba(245,158,11,0.04);border:1px solid var(--gold-dim);border-radius:6px">
            <div style="font-size:0.78rem;color:var(--text2);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.4rem">\\ud83c\\udfab Rakeback Tickets</div>
            <div style="display:grid;grid-template-columns:1fr auto;gap:0.3rem 1rem;font-size:0.88rem">
              <span style="color:var(--text2)">Entries</span><strong>\${tSum.ticket_entries}</strong>
              <span style="color:var(--text2)">Ticket value used</span><strong>\\u20ac\${(tSum.ticket_value_eur ?? 0).toFixed(2)} <span style="color:var(--text3);font-size:0.7rem">(€0 real)</span></strong>
              <span style="color:var(--text2)">Cashed (pure profit)</span><strong style="color:var(--green)">+\\u20ac\${(tSum.cash_won_from_tickets_eur ?? 0).toFixed(2)}</strong>
              <span style="color:var(--text2)">Ticket conversion</span><strong style="color:var(--gold)">\${tSum.ticket_conversion_pct ?? 0}%</strong>
              <span style="color:var(--text2)">ITM</span><strong>\${tSum.ticket_entries_itm_pct ?? 0}%</strong>
            </div>
          </div>
        </div>
        <div style="margin-top:0.75rem;padding:0.5rem;background:rgba(245,158,11,0.06);border-radius:4px;font-size:0.85rem">
          \\ud83d\\udcca <strong>Real-money tournament P&L:</strong> <span style="color:\${(tSum.real_money_pnl_eur ?? 0)>=0?'var(--green)':'var(--red)'};font-weight:700">\${f(tSum.real_money_pnl_eur ?? 0)}</span>
          <span style="color:var(--text3);font-size:0.78rem"> (cash net + ticket cashes, no €0-cost ticket losses counted)</span>
        </div>
      </div>
      \` : ''}

      <!-- Best/Worst Highlight -->
      <div class="ps-grid-2">
        <div class="ps-card" style="border-color:var(--green-dim)">
          <div class="ps-card-title" style="color:var(--green)">\\ud83c\\udfc6 Biggest Cash</div>
          <div style="padding:0.5rem"><div style="font-size:1.6rem;color:var(--green);font-weight:700">+\\u20ac\${tSum.biggest_cash_eur}</div><div style="color:var(--text2);font-size:0.9rem;margin-top:0.25rem">\${tSum.biggest_cash_event}</div></div>
        </div>
        <div class="ps-card" style="border-color:var(--gold-dim)">
          <div class="ps-card-title" style="color:var(--gold)">\\u2b50 Best Finish</div>
          <div style="padding:0.5rem"><div style="font-size:1.6rem;color:var(--gold);font-weight:700">#\${tSum.best_finish}</div><div style="color:var(--text2);font-size:0.9rem;margin-top:0.25rem">\${tSum.best_finish_event}</div></div>
        </div>
      </div>

      <!-- Tournament Cumulative P&L Chart -->
      <div class="ps-card">
        <div class="ps-card-title">\\ud83d\\udcc8 Tournament Cumulative P&L (Weekly)</div>
        <div style="height:260px;position:relative"><canvas id="da-tourn-pnl"></canvas></div>
      </div>

      <!-- By Format -->
      <div class="ps-card">
        <div class="ps-card-title">\\ud83c\\udfb2 Performance by Format</div>
        <table class="ps-table">
          <thead><tr><th>Format</th><th>Entries</th><th>Avg Buy-in</th><th>Invested</th><th>Cashed</th><th>Net</th><th>ROI</th><th>ITM%</th><th>Hands</th></tr></thead>
          <tbody>
            \${Object.entries(tFmt).sort((a,b) => b[1].entries - a[1].entries).map(([fmt, v]) => '<tr><td class="ps-pos">'+fmt+'</td><td>'+v.entries+'</td><td>\\u20ac'+v.avg_buyin_eur+'</td><td>\\u20ac'+v.invested_eur.toFixed(2)+'</td><td>\\u20ac'+v.cashed_eur.toFixed(2)+'</td><td class="'+c(v.net_eur)+'">'+f(v.net_eur)+'</td><td class="'+(v.roi_pct>=0?'ps-positive':'ps-negative')+'">'+(v.roi_pct>=0?'+':'')+v.roi_pct+'%</td><td>'+v.itm_pct+'%</td><td>'+v.hands.toLocaleString()+'</td></tr>').join('')}
          </tbody>
        </table>
      </div>

      <!-- By Buy-in Level -->
      <div class="ps-card">
        <div class="ps-card-title">\\ud83d\\udcb0 Performance by Buy-in Level</div>
        <table class="ps-table">
          <thead><tr><th>Buy-in Range</th><th>Entries</th><th>Invested</th><th>Cashed</th><th>Net</th><th>ROI</th><th>ITM%</th><th>Hands</th></tr></thead>
          <tbody>
            \${Object.entries(tBuy).map(([bl, v]) => '<tr><td class="ps-pos">'+bl+'</td><td>'+v.entries+'</td><td>\\u20ac'+v.invested_eur.toFixed(2)+'</td><td>\\u20ac'+v.cashed_eur.toFixed(2)+'</td><td class="'+c(v.net_eur)+'">'+f(v.net_eur)+'</td><td class="'+(v.roi_pct>=0?'ps-positive':'ps-negative')+'">'+(v.roi_pct>=0?'+':'')+v.roi_pct+'%</td><td>'+v.itm_pct+'%</td><td>'+v.hands.toLocaleString()+'</td></tr>').join('')}
          </tbody>
        </table>
      </div>

      <!-- By Month -->
      <div class="ps-grid-2">
        <div class="ps-card">
          <div class="ps-card-title">\\ud83d\\udcc5 Tournament P&L by Month</div>
          <table class="ps-table"><thead><tr><th>Month</th><th>Entries</th><th>Invested</th><th>Cashed</th><th>Net</th><th>ROI</th></tr></thead><tbody>
            \${Object.entries(tMon).sort().map(([ym, v]) => { const [y,m] = ym.split('-'); const moNms = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']; return '<tr><td class="ps-pos">'+moNms[parseInt(m)-1]+' '+y+'</td><td>'+v.entries+'</td><td>\\u20ac'+v.invested_eur.toFixed(2)+'</td><td>\\u20ac'+v.cashed_eur.toFixed(2)+'</td><td class="'+c(v.net_eur)+'">'+f(v.net_eur)+'</td><td class="'+(v.roi_pct>=0?'ps-positive':'ps-negative')+'">'+(v.roi_pct>=0?'+':'')+v.roi_pct+'%</td></tr>'; }).join('')}
          </tbody></table>
        </div>
        <div class="ps-card">
          <div class="ps-card-title">\\ud83c\\udfaf Finish Position Distribution</div>
          <table class="ps-table"><thead><tr><th>Finish</th><th>Count</th><th>%</th><th>Avg Cash</th></tr></thead><tbody>
            \${Object.entries(tFin).map(([lbl, v]) => '<tr><td class="ps-pos">'+lbl+'</td><td>'+v.count+'</td><td>'+v.pct+'%</td><td>'+(v.avg_cash > 0 ? '\\u20ac'+v.avg_cash : '\\u2014')+'</td></tr>').join('')}
          </tbody></table>
        </div>
      </div>

      <!-- Top Cashes -->
      <div class="ps-card">
        <div class="ps-card-title">\\ud83c\\udfc5 Top 10 Cashes</div>
        <table class="ps-table">
          <thead><tr><th>Date</th><th>Tournament</th><th>Format</th><th>Buy-in</th><th>Cashed</th><th>Place</th><th>Hands</th></tr></thead>
          <tbody>
            \${tTop.map(t => '<tr><td class="ps-pos">'+t.date.split(' ')[0]+'</td><td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+t.name+'">'+t.name+'</td><td>'+t.format+'</td><td>\\u20ac'+t.buyin_eur+'</td><td class="ps-positive">+\\u20ac'+t.cashed_eur+'</td><td>#'+t.place+'</td><td>'+t.hands+'</td></tr>').join('')}
          </tbody>
        </table>
      </div>

      <!-- Tournament Hand Stats (same depth as cash) -->
      <div class="ps-card">
        <div class="ps-card-title">\\ud83d\\udcca Tournament Hand-Level Stats (\${tSum.total_hands.toLocaleString()} hands)</div>
        <div class="da-stats-grid">
          \${gtoStat('VPIP', tPre.overall.vpip, [18,26], '%')}
          \${gtoStat('PFR', tPre.overall.pfr, [16,22], '%')}
          \${gtoStat('Limp', tPre.overall.limp_pct, [0,5], '%')}
          \${gtoStat('C-Bet Flop', tPost.computed_percentages.flop.cbet_pct||0, [55,70], '%')}
          \${gtoStat('Fold to C-Bet', tPost.computed_percentages.flop.fold_to_cbet_pct||0, [40,55], '%')}
          \${gtoStat('WTSD', tPost.computed_percentages.flop.wtsd_pct||0, [22,30], '%')}
          \${gtoStat('W$SD', tPost.computed_percentages.flop.wsd_pct||0, [50,58], '%')}
          \${gtoStat('Check-Raise', tPost.computed_percentages.flop.xr_pct||0, [8,15], '%')}
        </div>
        <div style="font-size:0.78rem;color:var(--text3);margin-top:0.5rem">GTO ranges shown are NLHE MTT/SnG benchmarks (different from PLO cash).</div>
      </div>

      <!-- Tournament By Position -->
      <div class="ps-card">
        <div class="ps-card-title">\\ud83c\\udfaf Tournament Positional Stats</div>
        <table class="ps-table">
          <thead><tr><th>Pos</th><th>Hands</th><th>VPIP</th><th>PFR</th><th>Limp</th><th>3-Bet</th><th>RFI</th><th>Cold Call</th><th>Fold to 3B</th></tr></thead>
          <tbody>
            \${positions.map(p => { const s = tPre.by_position[p]; if (!s || !s.hands) return ''; return '<tr><td class="ps-pos">'+p+'</td><td>'+s.hands.toLocaleString()+'</td><td>'+s.vpip+'%</td><td>'+s.pfr+'%</td><td>'+s.limp+'%</td><td>'+s.three_bet+'%</td><td>'+s.rfi+'%</td><td>'+s.cold_call+'%</td><td>'+s.fold_to_3bet+'%</td></tr>'; }).join('')}
          </tbody>
        </table>
      </div>

      <!-- Recent Tournaments -->
      <div class="ps-card">
        <div class="ps-card-title">\\u23f1\\ufe0f Recent Tournaments (Last 25)</div>
        <table class="ps-table">
          <thead><tr><th>Date</th><th>Tournament</th><th>Format</th><th>Buy-in</th><th>Place</th><th>Cashed</th><th>Net</th><th>Hands</th></tr></thead>
          <tbody>
            \${tSessions.slice(0, 25).map(t => '<tr><td class="ps-pos">'+t.date.split(' ')[0]+'</td><td style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+t.name+'">'+t.name+'</td><td>'+t.format+'</td><td>\\u20ac'+t.buyin_eur+'</td><td>'+(t.place > 0 ? '#'+t.place : '\\u2014')+'</td><td>'+(t.cashed_eur>0?'<span class="ps-positive">+\\u20ac'+t.cashed_eur+'</span>':'\\u20ac0')+'</td><td class="'+c(t.net_eur)+'">'+f(t.net_eur)+'</td><td>'+t.hands+'</td></tr>').join('')}
          </tbody>
        </table>
      </div>
    \`}\`);

    // ========== TAB SYSTEM ==========
    const tabs = [
      {id:'overview', label:'Overview', icon:'\\ud83d\\udcca'},
      {id:'tournaments', label:'Tournaments', icon:'\\ud83c\\udfc6'},
      {id:'recent', label:'Recent', icon:'\\ud83d\\udd52'},
      {id:'evgraph', label:'EV Graph', icon:'\\ud83d\\udcc8'},
      {id:'bbsb', label:'BB / SB', icon:'\\ud83c\\udfb2'},
      {id:'posperf', label:'Position Perf.', icon:'\\ud83c\\udfaf'},
      {id:'callleak', label:'Call Leaks', icon:'\\ud83d\\udcde'},
      {id:'goodvsbad', label:'Good vs Bad', icon:'\\u2696\\ufe0f'},
      {id:'leakreport', label:'Leak Report', icon:'\\u26a0\\ufe0f'},
      {id:'gto', label:'GTO Analysis', icon:'\\ud83c\\udfaf'},
      {id:'postflop', label:'Postflop Deep', icon:'\\ud83c\\udccf'},
      {id:'handquality', label:'Hand Quality', icon:'\\ud83d\\udc8e'},
      {id:'opponents', label:'Opponents', icon:'\\ud83d\\udc65'},
      {id:'sessions', label:'Sessions', icon:'\\u23f1\\ufe0f'},
      {id:'trends', label:'Trends', icon:'\\ud83d\\udcc9'}
    ];

    const tabContent = {
      overview: overviewHTML,
      tournaments: tournamentsHTML,
      recent: recentHTML,
      evgraph: evgraphHTML,
      bbsb: bbsbHTML,
      posperf: posperfHTML,
      callleak: callleakHTML,
      goodvsbad: goodVsBadHTML,
      leakreport: leakReportHTML,
      gto: gtoHTML,
      postflop: postflopHTML,
      handquality: handQualityHTML,
      opponents: opponentsHTML,
      sessions: sessionsHTML,
      trends: trendsHTML
    };

    // Get dynamic period
    const uniqueMonths = monthRows.map(e => e.label);
    const periodStr = uniqueMonths.length > 0 ? uniqueMonths.join(', ') : D._metadata.period;

    container.innerHTML = \`
      <div class="ps-layout">
        <div class="ps-meta-bar">
          <div class="ps-meta-chip"><span class="mc-icon">\\ud83d\\udc64</span> \${D._metadata.player}</div>
          <div class="ps-meta-chip"><span class="mc-icon">\\ud83c\\udf10</span> \${D._metadata.platform}</div>
          <div class="ps-meta-chip"><span class="mc-icon">\\ud83c\\udccf</span> \${D._metadata.game}</div>
          <div class="ps-meta-chip"><span class="mc-icon">\\ud83d\\udcc5</span> \${periodStr}</div>
          <div class="ps-meta-chip"><span class="mc-icon">\\ud83d\\udcb6</span> \${D._metadata.currency}</div>
        </div>
        <div class="ps-tabs" id="ps-tabs">
          \${tabs.map(t => '<div class="ps-tab '+(t.id === currentTab ? 'active' : '')+'" data-tab="'+t.id+'">'+t.icon+' '+t.label+'</div>').join('')}
        </div>
        <div id="ps-tab-content">
          \${tabContent[currentTab] || ''}
        </div>
      </div>
    \`;

    // Bind tabs
    container.querySelectorAll('.ps-tab').forEach(tab => {
      tab.addEventListener('click', () => { currentTab = tab.dataset.tab; render(); });
    });

    // ===== CHART.JS RENDERS =====
    setTimeout(() => {
      // Weekly P&L chart (overview + trends)
      const weeklyCanvas = document.getElementById('da-weekly-pnl') || document.getElementById('da-trends-pnl');
      if (weeklyCanvas) {
        const wk = D.weekly_pnl_curve;
        const labels = wk.map(w => w.week);
        const data = wk.map(w => w.cumulative);
        const colors = data.map(v => v >= 0 ? 'rgba(34,197,94,0.8)' : 'rgba(239,68,68,0.8)');
        activeCharts.push(new Chart(weeklyCanvas, {
          type: 'line',
          data: {
            labels,
            datasets: [{
              data,
              borderColor: 'rgba(99,102,241,0.9)',
              backgroundColor: 'rgba(99,102,241,0.1)',
              fill: true,
              tension: 0.3,
              pointRadius: 2,
              pointHoverRadius: 5,
              borderWidth: 2
            }]
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => f(ctx.parsed.y) } },
              annotation: D.weekly_pnl_curve.length > 15 ? { annotations: { periodSplit: { type: 'line', xMin: 'Jul 14', xMax: 'Jul 14', borderColor: 'rgba(255,255,255,0.3)', borderWidth: 1, borderDash: [5,5] } } } : undefined
            },
            scales: {
              x: { ticks: { color: '#64748b', maxRotation: 45, font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.03)' } },
              y: { ticks: { color: '#64748b', callback: v => v >= 0 ? '+'+v : v }, grid: { color: 'rgba(255,255,255,0.05)' } }
            }
          }
        }));
      }

      // Trends weekly chart
      const trendsCanvas = document.getElementById('da-trends-pnl');
      if (trendsCanvas && !weeklyCanvas) {
        // Same chart — handled above
      }

      // ===== In-browser Tournament Zip Importer =====
      const dropZone = document.getElementById('da-tourn-drop');
      const dropInput = document.getElementById('da-tourn-input');
      const dropLabel = document.getElementById('da-tourn-drop-label');
      const dropResult = document.getElementById('da-tourn-import-result');
      const clearBtn = document.getElementById('da-tourn-clear');
      if (clearBtn) {
        clearBtn.addEventListener('click', () => {
          if (confirm('Clear all browser-imported tournaments? (Files imported via IMPORT-TOURNAMENTS.bat are NOT affected.)')) {
            try { localStorage.removeItem('browserTournamentImports'); } catch(e) {}
            render();
          }
        });
      }
      if (dropZone && !dropZone._wired && window.JSZip && window.DOMParser) {
        dropZone._wired = true;

        const parseAmtT = (s) => parseFloat(String(s || '0').replace(/[^0-9.-]/g, '')) || 0;
        const detT = (xml, tag) => {
          const m = xml.match(new RegExp('<' + tag + '>([\\\\s\\\\S]*?)</' + tag + '>'));
          return m ? m[1].trim() : '';
        };

        async function processZips(files) {
          dropResult.innerHTML = '<div style="color:var(--text2);font-size:0.85rem">\\u23f3 Parsing ' + files.length + ' zip(s)...</div>';
          const allEntries = [];
          let skipped = 0, errors = 0;
          const seenCodes = new Set();

          for (const file of files) {
            try {
              const zip = await JSZip.loadAsync(file);
              const xmlFiles = Object.values(zip.files).filter(f => !f.dir && f.name.endsWith('.xml'));
              for (const xf of xmlFiles) {
                try {
                  const text = await xf.async('string');
                  const genMatch = text.match(/<general>([\\s\\S]*?)<\\/general>/);
                  if (!genMatch) { skipped++; continue; }
                  const gen = genMatch[1];
                  const tCode = detT(gen, 'tournamentcode');
                  if (!tCode) { skipped++; continue; } // not a tournament
                  if (seenCodes.has(tCode)) continue; // dedupe
                  seenCodes.add(tCode);

                  const tName = detT(gen, 'tournamentname') || detT(gen, 'tablename') || 'Unknown';
                  const totalBuyin = parseAmtT(detT(gen, 'totalbuyin'));
                  const rebuys = parseInt(detT(gen, 'rebuys')) || 0;
                  const addon = parseInt(detT(gen, 'addon')) || 0;
                  const totalRebuyCost = parseAmtT(detT(gen, 'totalrebuycost'));
                  const totalAddonCost = parseAmtT(detT(gen, 'totaladdoncost'));
                  const winAmt = parseAmtT(detT(gen, 'win'));
                  const place = parseInt(detT(gen, 'place')) || 0;
                  const startDate = detT(gen, 'startdate');
                  const buyinRaw = detT(gen, 'buyin');
                  const paidWith = /token/i.test(buyinRaw) ? 'ticket' : 'cash';
                  const invested = totalBuyin + (rebuys * totalRebuyCost) + (addon * totalAddonCost);

                  // Format classification
                  let fmt;
                  const tablesize = parseInt(detT(gen, 'tablesize')) || 6;
                  if (/twister|spin/i.test(tName)) fmt = 'Spin/Twister';
                  else if (/double\\s*or\\s*nothing|\\bdon\\b/i.test(tName)) fmt = 'DoN';
                  else if (/\\bsat\\b|satellite|step\\s*sat/i.test(tName)) fmt = 'Satellite';
                  else if (/sit\\s*[&n]\\s*go|\\bsng\\b|s&g/i.test(tName)) fmt = 'SnG';
                  else if (tablesize <= 10 && !/gtd|guaranteed/i.test(tName)) fmt = 'SnG';
                  else fmt = 'MTT';

                  allEntries.push({ code: tCode, name: tName, format: fmt, totalBuyin, invested, win: winAmt, place, date: startDate, paidWith, itm: winAmt > 0 });
                } catch(e) { errors++; }
              }
            } catch(e) { errors++; }
          }

          if (allEntries.length === 0) {
            dropResult.innerHTML = '<div style="color:var(--red);padding:0.75rem;background:rgba(239,68,68,0.08);border-radius:6px;font-size:0.9rem">\\u274c No tournament sessions found in dropped file(s). Are you sure these are tournament zips (not cash)? ' + (skipped ? '(' + skipped + ' cash/other sessions skipped)' : '') + '</div>';
            return;
          }

          // Compute summary
          const cashE = allEntries.filter(t => t.paidWith === 'cash');
          const tickE = allEntries.filter(t => t.paidWith === 'ticket');
          const totalInv = allEntries.reduce((s,t) => s + t.invested, 0);
          const totalWon = allEntries.reduce((s,t) => s + t.win, 0);
          const cashInv = cashE.reduce((s,t) => s + t.invested, 0);
          const cashWon = cashE.reduce((s,t) => s + t.win, 0);
          const tickInv = tickE.reduce((s,t) => s + t.invested, 0);
          const tickWon = tickE.reduce((s,t) => s + t.win, 0);
          const itm = allEntries.filter(t => t.itm).length;
          const realMoneyPnl = (cashWon - cashInv) + tickWon;

          const fmtStats = {};
          for (const t of allEntries) {
            if (!fmtStats[t.format]) fmtStats[t.format] = { n:0, pnl:0 };
            fmtStats[t.format].n++;
            fmtStats[t.format].pnl += (t.paidWith === 'cash' ? (t.win - t.invested) : t.win);
          }

          const fmtRows = Object.entries(fmtStats).sort((a,b) => b[1].pnl - a[1].pnl).map(([k,v]) =>
            '<tr><td>'+k+'</td><td>'+v.n+'</td><td class="'+(v.pnl>=0?'ps-positive':'ps-negative')+'">'+f(v.pnl)+'</td></tr>'
          ).join('');

          dropResult.innerHTML =
            '<div style="padding:0.75rem;background:rgba(245,158,11,0.06);border:1px solid var(--gold-dim);border-radius:6px">' +
              '<div style="font-size:0.78rem;color:var(--gold);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.5rem">\\u2728 Import Summary (browser-parsed)</div>' +
              '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:0.6rem;margin-bottom:0.75rem">' +
                '<div><div style="color:var(--text3);font-size:0.72rem">Total Tournaments</div><div style="font-size:1.2rem;font-weight:700">'+allEntries.length+'</div></div>' +
                '<div><div style="color:var(--text3);font-size:0.72rem">Real Money P&L</div><div style="font-size:1.2rem;font-weight:700;color:'+(realMoneyPnl>=0?'var(--green)':'var(--red)')+'">'+f(realMoneyPnl)+'</div></div>' +
                '<div><div style="color:var(--text3);font-size:0.72rem">ITM</div><div style="font-size:1.2rem;font-weight:700">'+(allEntries.length?((itm/allEntries.length*100).toFixed(1)):'0')+'%</div><div style="font-size:0.7rem;color:var(--text3)">'+itm+' cashed</div></div>' +
                '<div><div style="color:var(--text3);font-size:0.72rem">Cash buy-ins</div><div style="font-size:1rem;font-weight:700">'+cashE.length+'</div><div style="font-size:0.7rem;color:var(--text3)">\\u20ac'+cashInv.toFixed(2)+' in \\u2192 \\u20ac'+cashWon.toFixed(2)+' out</div></div>' +
                '<div><div style="color:var(--text3);font-size:0.72rem">Ticket entries</div><div style="font-size:1rem;font-weight:700">'+tickE.length+'</div><div style="font-size:0.7rem;color:var(--text3)">\\u20ac'+tickInv.toFixed(2)+' value \\u2192 +\\u20ac'+tickWon.toFixed(2)+' profit</div></div>' +
              '</div>' +
              '<table class="ps-table" style="margin-top:0.5rem"><thead><tr><th>Format</th><th>Entries</th><th>P&L</th></tr></thead><tbody>'+fmtRows+'</tbody></table>' +
              (errors||skipped ? '<div style="margin-top:0.5rem;font-size:0.75rem;color:var(--text3)">' + (errors?errors+' files failed. ':'') + (skipped?skipped+' non-tournament sessions skipped.':'') + '</div>' : '') +
              '<div style="margin-top:0.6rem;padding:0.5rem;background:rgba(59,130,246,0.08);border-radius:4px;font-size:0.78rem;color:var(--text2)">\\ud83d\\udca1 Want this merged into the full deep analysis (charts, by-month, hand stats)? Drop the zip onto <strong style="color:var(--gold)">IMPORT-TOURNAMENTS.bat</strong> in your project folder.</div>' +
            '</div>';

          // Persist to localStorage
          try {
            const stored = JSON.parse(localStorage.getItem('browserTournamentImports') || '[]');
            const merged = stored.concat(allEntries.map(t => ({ ...t, importedAt: Date.now() })));
            const dedup = {};
            for (const t of merged) dedup[t.code] = t;
            localStorage.setItem('browserTournamentImports', JSON.stringify(Object.values(dedup)));
          } catch(e) {}

          // Re-render the entire view so merged tournaments show in the hero cards,
          // recent tournaments table, by_format breakdown, AND in the Overview tab strip.
          // Brief delay so user sees the import summary first.
          setTimeout(() => {
            currentTab = 'tournaments';
            render();
            // Scroll to import card so user sees the new totals
            const card = document.getElementById('da-tourn-import-card');
            if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }, 1200);
        }

        dropZone.addEventListener('click', () => dropInput.click());
        dropInput.addEventListener('change', (e) => { if (e.target.files.length) processZips(Array.from(e.target.files)); });
        dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.style.background = 'rgba(245,158,11,0.12)'; dropLabel.textContent = '\\ud83d\\udce5 Drop to import'; });
        dropZone.addEventListener('dragleave', (e) => { e.preventDefault(); dropZone.style.background = 'rgba(245,158,11,0.03)'; dropLabel.textContent = 'Drop tournament zip(s) here, or click to browse'; });
        dropZone.addEventListener('drop', (e) => {
          e.preventDefault();
          dropZone.style.background = 'rgba(245,158,11,0.03)';
          dropLabel.textContent = 'Drop tournament zip(s) here, or click to browse';
          const files = Array.from(e.dataTransfer.files).filter(f => f.name.toLowerCase().endsWith('.zip'));
          if (files.length) processZips(files);
          else dropResult.innerHTML = '<div style="color:var(--red);font-size:0.85rem">Only .zip files are accepted</div>';
        });
      }

      // Tournament weekly P&L chart
      const tournCanvas = document.getElementById('da-tourn-pnl');
      if (tournCanvas && D.tournaments && D.tournaments.weekly_pnl_curve) {
        const wk = D.tournaments.weekly_pnl_curve;
        const labels = wk.map(w => w.week);
        const data = wk.map(w => w.cumulative);
        activeCharts.push(new Chart(tournCanvas, {
          type: 'line',
          data: { labels, datasets: [{ data, borderColor: 'rgba(245,158,11,0.95)', backgroundColor: 'rgba(245,158,11,0.12)', fill: true, tension: 0.3, pointRadius: 3, pointHoverRadius: 6, borderWidth: 2 }] },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => f(ctx.parsed.y) } } },
            scales: {
              x: { ticks: { color: '#64748b', maxRotation: 45, font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.03)' } },
              y: { ticks: { color: '#64748b', callback: v => v >= 0 ? '+'+v : v }, grid: { color: 'rgba(255,255,255,0.05)' } }
            }
          }
        }));
      }

      // Hand Quality chart
      const hqCanvas = document.getElementById('da-hq-chart');
      if (hqCanvas) {
        const cats = hqOrder.map(k => k.replace(/_/g, ' '));
        const vals = hqOrder.map(k => D.hand_quality[k] ? D.hand_quality[k].total_pnl_bb : 0);
        const bgColors = vals.map(v => v >= 0 ? 'rgba(34,197,94,0.7)' : 'rgba(239,68,68,0.7)');
        activeCharts.push(new Chart(hqCanvas, {
          type: 'bar',
          data: { labels: cats, datasets: [{ data: vals, backgroundColor: bgColors, borderRadius: 6 }] },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
              x: { ticks: { color: '#64748b', font: { size: 10 } }, grid: { display: false } },
              y: { ticks: { color: '#64748b' }, grid: { color: 'rgba(255,255,255,0.05)' } }
            }
          }
        }));
      }

      // Day of Week chart
      const dowCanvas = document.getElementById('da-dow-chart');
      if (dowCanvas) {
        const days = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
        const vals = days.map(d => ta.by_day_of_week[d] ? ta.by_day_of_week[d].bb_per_100 : 0);
        activeCharts.push(new Chart(dowCanvas, {
          type: 'bar',
          data: { labels: days.map(d => d.slice(0,3)), datasets: [{ data: vals, backgroundColor: vals.map(v => v >= 0 ? 'rgba(34,197,94,0.7)' : 'rgba(239,68,68,0.7)'), borderRadius: 6 }] },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => fBB(ctx.parsed.y) + ' bb/100' } } },
            scales: {
              x: { ticks: { color: '#64748b' }, grid: { display: false } },
              y: { ticks: { color: '#64748b', callback: v => fBB(v) }, grid: { color: 'rgba(255,255,255,0.05)' } }
            }
          }
        }));
      }

      // Hour of Day chart
      const hourCanvas = document.getElementById('da-hour-chart');
      if (hourCanvas) {
        const hours = Array.from({length:24}, (_,i) => i);
        const vals = hours.map(h => ta.by_hour_of_day[h] ? ta.by_hour_of_day[h].pnl_eur : 0);
        activeCharts.push(new Chart(hourCanvas, {
          type: 'bar',
          data: { labels: hours.map(h => h+'h'), datasets: [{ data: vals, backgroundColor: vals.map(v => v >= 0 ? 'rgba(34,197,94,0.6)' : 'rgba(239,68,68,0.6)'), borderRadius: 4 }] },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => f(ctx.parsed.y) } } },
            scales: {
              x: { ticks: { color: '#64748b', font: { size: 9 } }, grid: { display: false } },
              y: { ticks: { color: '#64748b', callback: v => v >= 0 ? '+'+v : v }, grid: { color: 'rgba(255,255,255,0.05)' } }
            }
          }
        }));
      }

      // EV Graph
      const evCanvas = document.getElementById('da-ev-chart');
      if (evCanvas) {
        const periodSel = document.getElementById('ev-period');
        const stakeSel = document.getElementById('ev-stake');
        const draw = () => {
          const period = periodSel?.value || 'all';
          const stk = stakeSel?.value || 'all';
          let arr = [...sessions].filter(s => s.date).sort((a,b) => new Date(a.date) - new Date(b.date));
          if (stk !== 'all') arr = arr.filter(s => s.stakes === stk);
          if (period !== 'all') {
            const d = parseInt(period); const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - d);
            arr = arr.filter(s => new Date(s.date) >= cutoff);
          }
          let cum = 0;
          const points = arr.map((s, i) => { cum += (s.cashOut - s.buyIn); return { x: i+1, y: cum, date: s.date }; });
          // EV trend = linear regression
          const n = points.length;
          if (n < 2) { return; }
          const sumX = points.reduce((a,p) => a+p.x, 0);
          const sumY = points.reduce((a,p) => a+p.y, 0);
          const sumXY = points.reduce((a,p) => a+p.x*p.y, 0);
          const sumXX = points.reduce((a,p) => a+p.x*p.x, 0);
          const slope = (n*sumXY - sumX*sumY) / (n*sumXX - sumX*sumX);
          const intercept = (sumY - slope*sumX) / n;
          const evLine = points.map(p => ({ x: p.x, y: slope*p.x + intercept }));
          const evFinal = evLine[evLine.length-1].y;
          const realFinal = points[points.length-1].y;
          const trendEl = document.getElementById('ev-trend-val');
          const diffEl = document.getElementById('ev-diff-val');
          if (trendEl) { trendEl.textContent = (evFinal>=0?'+':'')+evFinal.toFixed(2); trendEl.style.color = evFinal>=0?'var(--green)':'var(--red)'; }
          if (diffEl) { const d = realFinal - evFinal; diffEl.textContent = (d>=0?'+':'')+d.toFixed(2)+' '+(d>=0?'(over EV)':'(under EV)'); diffEl.style.color = d>=0?'var(--green)':'var(--red)'; }
          // Destroy existing
          if (evCanvas._chart) { try { evCanvas._chart.destroy(); } catch(e){} }
          evCanvas._chart = new Chart(evCanvas, {
            type: 'line',
            data: {
              labels: points.map(p => p.date),
              datasets: [
                { label:'Real P&L', data: points.map(p => p.y), borderColor:'rgba(99,102,241,1)', backgroundColor:'rgba(99,102,241,0.12)', fill:true, tension:0.2, pointRadius:0, borderWidth:2 },
                { label:'EV Trend', data: evLine.map(p => p.y), borderColor:'rgba(34,197,94,0.9)', borderDash:[8,4], fill:false, pointRadius:0, borderWidth:2 }
              ]
            },
            options: {
              responsive:true, maintainAspectRatio:false,
              plugins: { legend: { display:true, labels:{ color:'#cbd5e1', font:{size:11} } } },
              scales: {
                x: { ticks: { color:'#64748b', maxRotation:45, font:{size:9} }, grid: { color:'rgba(255,255,255,0.03)' } },
                y: { ticks: { color:'#64748b', callback: v => v >= 0 ? '+'+v : v }, grid: { color:'rgba(255,255,255,0.05)' } }
              }
            }
          });
          activeCharts.push(evCanvas._chart);
        };
        draw();
        periodSel?.addEventListener('change', draw);
        stakeSel?.addEventListener('change', draw);
      }

      // Recent (Last 30 days) chart
      const recentCanvas = document.getElementById('da-recent-chart');
      if (recentCanvas) {
        const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
        const arr = [...sessions].filter(s => s.date && new Date(s.date) >= cutoff).sort((a,b) => new Date(a.date) - new Date(b.date));
        let cum = 0; const pts = arr.map(s => { cum += (s.cashOut - s.buyIn); return { x: s.date, y: cum }; });
        activeCharts.push(new Chart(recentCanvas, {
          type:'line',
          data: { labels: pts.map(p => p.x), datasets: [{ data: pts.map(p => p.y), borderColor:'rgba(34,197,94,0.9)', backgroundColor:'rgba(34,197,94,0.1)', fill:true, tension:0.3, pointRadius:2, borderWidth:2 }] },
          options: { responsive:true, maintainAspectRatio:false, plugins:{ legend:{ display:false }, tooltip:{ callbacks:{ label: ctx => f(ctx.parsed.y) } } }, scales:{ x:{ ticks:{ color:'#64748b', maxRotation:45, font:{size:9} }, grid:{ color:'rgba(255,255,255,0.03)' } }, y:{ ticks:{ color:'#64748b', callback: v => v>=0?'+'+v:v }, grid:{ color:'rgba(255,255,255,0.05)' } } } }
        }));
      }

      // Opponent Scatter
      const scatterCanvas = document.getElementById('da-opp-scatter');
      if (scatterCanvas) {
        const oppData = Object.entries(D.opponents).map(([name, o]) => ({
          x: o.vpip,
          y: o.af,
          r: Math.max(4, Math.min(15, o.hands / 3000)),
          name,
          hands: o.hands,
          pnl: o.hero_pnl_vs_eur
        }));
        activeCharts.push(new Chart(scatterCanvas, {
          type: 'bubble',
          data: {
            datasets: [{
              data: oppData,
              backgroundColor: oppData.map(d => d.pnl >= 0 ? 'rgba(34,197,94,0.6)' : 'rgba(239,68,68,0.6)'),
              borderColor: oppData.map(d => d.pnl >= 0 ? 'rgba(34,197,94,0.9)' : 'rgba(239,68,68,0.9)'),
              borderWidth: 1
            }, {
              data: [{ x: pre.vpip, y: 1.84, r: 10 }],
              backgroundColor: 'rgba(99,102,241,0.7)',
              borderColor: 'rgba(99,102,241,1)',
              borderWidth: 2,
              label: 'Hero'
            }]
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: { callbacks: { label: ctx => {
                const d = ctx.raw;
                return d.name ? d.name + ' \\u2014 VPIP:'+d.x+'% AF:'+d.y+' P&L:'+f(d.pnl) : 'Hero (You)';
              }}}
            },
            scales: {
              x: { title: { display: true, text: 'VPIP %', color: '#64748b' }, ticks: { color: '#64748b' }, grid: { color: 'rgba(255,255,255,0.05)' } },
              y: { title: { display: true, text: 'AF', color: '#64748b' }, ticks: { color: '#64748b' }, grid: { color: 'rgba(255,255,255,0.05)' } }
            }
          }
        }));
      }
    }, 50);
  }

  render();
}

`;

// ========== 4. BUILD NEW CSS ==========
const newCSS = `
/* ===== DEEP ANALYSIS COMPONENTS ===== */
.da-stats-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(140px, 1fr)); gap:0.75rem; margin-bottom:1rem; }
.da-stat-box { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:0.85rem 1rem; text-align:center; }
.da-stat-label { font-size:0.68rem; color:var(--text3); text-transform:uppercase; letter-spacing:0.5px; font-weight:600; margin-bottom:0.3rem; }
.da-stat-val { font-size:1.15rem; font-weight:800; color:var(--text); }
.da-mini-stats { display:flex; flex-direction:column; gap:0.3rem; }
.da-mini-stats > div { display:flex; justify-content:space-between; padding:0.3rem 0; border-bottom:1px solid rgba(255,255,255,0.03); }
.da-mini-label { font-size:0.78rem; color:var(--text2); }
.da-mini-val { font-size:0.78rem; font-weight:700; color:var(--text); }
@media (max-width: 900px) { .da-stats-grid { grid-template-columns:repeat(auto-fill, minmax(120px, 1fr)); } .ps-grid-3 { grid-template-columns:1fr; } }
`;

// Insert new CSS before the closing </style>
const cssInsertPoint = html.indexOf('/* ===== PLAYER STATS VIEW =====');
if (cssInsertPoint === -1) {
  console.error('CSS insert point not found');
  // Try to insert before the existing PS CSS
}

// Now assemble the new HTML
const newHTML = beforeData + dataJS + renderFn + afterView;

// Insert new CSS
const finalHTML = newHTML.replace('/* ===== PLAYER STATS VIEW =====', newCSS + '\n/* ===== PLAYER STATS VIEW =====');

fs.writeFileSync(path.join(__dirname, 'index.html'), finalHTML, 'utf8');
console.log('✅ Deep analysis integrated!');
console.log('File size:', finalHTML.length, 'chars');
console.log('Tabs: Overview, Good vs Bad, Leak Report, GTO Analysis, Postflop Deep, Hand Quality, Opponents, Sessions, Trends');
