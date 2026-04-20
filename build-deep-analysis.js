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

  let currentTab = 'overview';

  function render() {
    // ========== TAB: OVERVIEW ==========
    const overviewHTML = \`
      <div class="ps-hero-row">
        <div class="ps-hero-card \${totalPnl >= 0 ? 'green' : 'red'}">
          <div class="ps-hero-label">Total P&L</div>
          <div class="ps-hero-val" style="color:\${totalPnl >= 0 ? 'var(--green)' : 'var(--red)'}">\${f(totalPnl)}</div>
          <div class="ps-hero-sub">\${fBB(bbPer100)} bb/100</div>
        </div>
        <div class="ps-hero-card blue">
          <div class="ps-hero-label">Total Hands</div>
          <div class="ps-hero-val" style="color:var(--blue)">\${totalHands.toLocaleString()}</div>
          <div class="ps-hero-sub">\${totalSessions.toLocaleString()} sessions</div>
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

    // ========== TAB SYSTEM ==========
    const tabs = [
      {id:'overview', label:'Overview', icon:'\\ud83d\\udcca'},
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
