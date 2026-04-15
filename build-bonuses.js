/**
 * Build script: Inject bonus tracker into index.html
 * - SEED_BONUSES constant
 * - Bonus storage functions
 * - Nav item
 * - Bonus view with import
 * - Dashboard P&L integration (Net Profit after Bonus)
 * - CSS for bonus components
 */
const fs = require('fs');
const path = require('path');

const bonuses = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'bonuses.json'), 'utf8'));
let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

// ========== 1. ADD CSS ==========
const bonusCSS = `
/* ===== BONUS TRACKER ===== */
.bonus-layout { display:flex; flex-direction:column; gap:1.25rem; }
.bonus-hero-row { display:grid; grid-template-columns:1fr 1fr 1fr 1fr; gap:1rem; }
.bonus-hero-card { background:var(--card); border:1px solid var(--border); border-radius:var(--radius-lg); padding:1.25rem 1.4rem; position:relative; overflow:hidden; }
.bonus-hero-card::before { content:''; position:absolute; top:0; left:0; right:0; height:2px; opacity:0.7; }
.bonus-hero-card.green::before { background:linear-gradient(90deg,transparent,var(--green),transparent); }
.bonus-hero-card.gold::before { background:linear-gradient(90deg,transparent,var(--gold),transparent); }
.bonus-hero-card.blue::before { background:linear-gradient(90deg,transparent,var(--blue),transparent); }
.bonus-hero-card.purple::before { background:linear-gradient(90deg,transparent,var(--purple),transparent); }
.bonus-hero-label { font-size:0.7rem; color:var(--text3); text-transform:uppercase; letter-spacing:0.5px; font-weight:600; margin-bottom:0.35rem; }
.bonus-hero-val { font-size:1.55rem; font-weight:800; line-height:1; }
.bonus-hero-sub { font-size:0.72rem; color:var(--text3); margin-top:0.35rem; }
.bonus-import-area { background:var(--card); border:1px solid var(--border); border-radius:var(--radius-lg); padding:1.25rem; }
.bonus-import-area textarea { width:100%; height:140px; background:var(--bg); border:1px solid var(--border); border-radius:8px; color:var(--text); font-family:'JetBrains Mono',monospace; font-size:0.78rem; padding:0.75rem; resize:vertical; }
.bonus-import-area textarea:focus { outline:none; border-color:var(--green); }
.bonus-import-area textarea::placeholder { color:var(--text3); }
.bonus-import-btn { display:inline-flex; align-items:center; gap:0.5rem; padding:0.55rem 1.25rem; border-radius:8px; font-size:0.8rem; font-weight:700; cursor:pointer; border:none; margin-top:0.75rem; transition:all 0.15s; }
.bonus-import-btn.primary { background:var(--green); color:#000; }
.bonus-import-btn.primary:hover { background:#00e6b8; }
.bonus-import-btn.danger { background:var(--red); color:#fff; margin-left:0.5rem; }
.bonus-import-btn.danger:hover { background:#ff5a75; }
.bonus-msg { font-size:0.78rem; margin-top:0.5rem; padding:0.5rem 0.75rem; border-radius:6px; display:none; }
.bonus-msg.success { display:block; background:var(--green-dim); color:var(--green); }
.bonus-msg.error { display:block; background:var(--red-dim); color:var(--red); }
.bonus-dist-grid { display:grid; grid-template-columns:1fr 1fr 1fr 1fr; gap:0.75rem; }
.bonus-dist-card { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:0.85rem 1rem; text-align:center; }
.bonus-dist-label { font-size:0.68rem; color:var(--text3); text-transform:uppercase; font-weight:600; margin-bottom:0.3rem; }
.bonus-dist-val { font-size:1.1rem; font-weight:800; color:var(--text); }
.bonus-dist-sub { font-size:0.68rem; color:var(--text3); margin-top:0.2rem; }
@media (max-width: 900px) { .bonus-hero-row, .bonus-dist-grid { grid-template-columns:1fr 1fr; } }
@media (max-width: 600px) { .bonus-hero-row, .bonus-dist-grid { grid-template-columns:1fr; } }
`;

const cssMarker = '/* ===== PLAYER STATS VIEW =====';
if (html.includes(cssMarker)) {
  html = html.replace(cssMarker, bonusCSS + '\n' + cssMarker);
}

// ========== 2. ADD NAV ITEM ==========
const navMarker = `    <button class="nav-item" data-view="playerstats">
      <span class="nav-icon">&#128202;</span> Player Stats
    </button>`;
const navReplacement = navMarker + `
    <button class="nav-item" data-view="bonuses">
      <span class="nav-icon">&#127873;</span> Bonuses
    </button>`;
html = html.replace(navMarker, navReplacement);

// ========== 3. ADD SEED_BONUSES + storage ==========
const storeMarker = "const SK = 'pokerSessions_v2';";
const bonusStore = `const SEED_BONUSES = ${JSON.stringify(bonuses.amounts)};
const BONUS_KEY = 'pokerBonuses_v1';

function getBonuses() {
  const stored = localStorage.getItem(BONUS_KEY);
  if (stored) {
    try { return JSON.parse(stored); } catch(e) {}
  }
  if (SEED_BONUSES.length > 0) { saveBonuses(SEED_BONUSES); return [...SEED_BONUSES]; }
  return [];
}
function saveBonuses(arr) { localStorage.setItem(BONUS_KEY, JSON.stringify(arr)); }
function addBonuses(newAmounts) {
  const current = getBonuses();
  const merged = current.concat(newAmounts);
  saveBonuses(merged);
  return merged;
}
function getTotalBonus() { return getBonuses().reduce((s,v) => s + v, 0); }

` + storeMarker;
html = html.replace(storeMarker, bonusStore);

// ========== 4. ADD VIEW ROUTING ==========
const routeMarker = "else if (view === 'playerstats') renderPlayerStatsView(content);";
html = html.replace(routeMarker, routeMarker + "\n  else if (view === 'bonuses') renderBonusView(content);");

// ========== 5. ADD renderBonusView FUNCTION ==========
// Insert before renderLeakFinderView
const leakFnMarker = 'function renderLeakFinderView(container) {';
const bonusViewFn = `function renderBonusView(container) {
  const bonuses = getBonuses();
  const total = bonuses.reduce((s,v) => s + v, 0);
  const count = bonuses.length;
  const avg = count > 0 ? total / count : 0;
  const max = count > 0 ? Math.max(...bonuses) : 0;

  // Categories
  const big = bonuses.filter(v => v >= 100);
  const medium = bonuses.filter(v => v >= 25 && v < 100);
  const small = bonuses.filter(v => v >= 5 && v < 25);
  const micro = bonuses.filter(v => v < 5);
  const bigSum = big.reduce((s,v)=>s+v,0);
  const medSum = medium.reduce((s,v)=>s+v,0);
  const smlSum = small.reduce((s,v)=>s+v,0);
  const micSum = micro.reduce((s,v)=>s+v,0);

  // Session P&L
  const sessions = getSessions();
  const tablePnl = sessions.reduce((s, x) => s + (x.cashOut - x.buyIn), 0);
  const totalRake = sessions.reduce((s, x) => s + (x.rake || 0), 0);
  const netWithBonus = tablePnl + total;

  const f = (n) => (n >= 0 ? '+' : '') + n.toFixed(2);
  const fmt2 = (n) => n.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2});

  container.innerHTML = \`
    <div class="bonus-layout">
      <div class="bonus-hero-row">
        <div class="bonus-hero-card green">
          <div class="bonus-hero-label">Total Bonuses</div>
          <div class="bonus-hero-val" style="color:var(--green)">+\${fmt2(total)}</div>
          <div class="bonus-hero-sub">\${count.toLocaleString()} bonus payments</div>
        </div>
        <div class="bonus-hero-card blue">
          <div class="bonus-hero-label">Table P&L</div>
          <div class="bonus-hero-val" style="color:\${tablePnl >= 0 ? 'var(--green)' : 'var(--red)'}">\${f(tablePnl)}</div>
          <div class="bonus-hero-sub">from \${sessions.length} sessions</div>
        </div>
        <div class="bonus-hero-card purple">
          <div class="bonus-hero-label">Net P&L (with Bonus)</div>
          <div class="bonus-hero-val" style="color:\${netWithBonus >= 0 ? 'var(--green)' : 'var(--red)'}">\${f(netWithBonus)}</div>
          <div class="bonus-hero-sub">Table + Bonuses</div>
        </div>
        <div class="bonus-hero-card gold">
          <div class="bonus-hero-label">Rake Paid</div>
          <div class="bonus-hero-val" style="color:var(--gold)">\${fmt2(totalRake)}</div>
          <div class="bonus-hero-sub">Rakeback: \${totalRake > 0 ? (total / totalRake * 100).toFixed(1) : 0}%</div>
        </div>
      </div>

      <!-- Net Result Banner -->
      <div style="background:\${netWithBonus >= 0 ? 'rgba(0,212,170,0.08)' : 'rgba(244,63,94,0.08)'}; border:1px solid \${netWithBonus >= 0 ? 'rgba(0,212,170,0.2)' : 'rgba(244,63,94,0.2)'}; border-radius:12px; padding:1.25rem 1.5rem; text-align:center">
        <div style="font-size:0.72rem; color:var(--text3); text-transform:uppercase; letter-spacing:0.5px; font-weight:600; margin-bottom:0.5rem">\\ud83d\\udcb0 The Real Bottom Line</div>
        <div style="font-size:2rem; font-weight:800; color:\${netWithBonus >= 0 ? 'var(--green)' : 'var(--red)'}">\${f(netWithBonus)} EUR</div>
        <div style="font-size:0.82rem; color:var(--text2); margin-top:0.5rem">
          Table: <span style="color:\${tablePnl >= 0 ? 'var(--green)' : 'var(--red)'}">\${f(tablePnl)}</span>
          &nbsp;+&nbsp; Bonus: <span style="color:var(--green)">+\${fmt2(total)}</span>
          &nbsp;=&nbsp; Net: <span style="color:\${netWithBonus >= 0 ? 'var(--green)' : 'var(--red)'}; font-weight:700">\${f(netWithBonus)}</span>
        </div>
        <div style="font-size:0.75rem; color:var(--text3); margin-top:0.35rem">
          Rake paid: \${fmt2(totalRake)} &middot; Bonus covers \${totalRake > 0 ? (total / totalRake * 100).toFixed(1) : 0}% of rake
        </div>
      </div>

      <!-- Category Breakdown -->
      <div class="bonus-dist-grid">
        <div class="bonus-dist-card" style="border-top:2px solid var(--green)">
          <div class="bonus-dist-label">Big (100+)</div>
          <div class="bonus-dist-val" style="color:var(--green)">\${fmt2(bigSum)}</div>
          <div class="bonus-dist-sub">\${big.length} payments &middot; avg \${big.length > 0 ? fmt2(bigSum/big.length) : '0'}</div>
        </div>
        <div class="bonus-dist-card" style="border-top:2px solid var(--blue)">
          <div class="bonus-dist-label">Medium (25-99)</div>
          <div class="bonus-dist-val" style="color:var(--blue)">\${fmt2(medSum)}</div>
          <div class="bonus-dist-sub">\${medium.length} payments &middot; avg \${medium.length > 0 ? fmt2(medSum/medium.length) : '0'}</div>
        </div>
        <div class="bonus-dist-card" style="border-top:2px solid var(--gold)">
          <div class="bonus-dist-label">Small (5-24)</div>
          <div class="bonus-dist-val" style="color:var(--gold)">\${fmt2(smlSum)}</div>
          <div class="bonus-dist-sub">\${small.length} payments &middot; avg \${small.length > 0 ? fmt2(smlSum/small.length) : '0'}</div>
        </div>
        <div class="bonus-dist-card" style="border-top:2px solid var(--purple)">
          <div class="bonus-dist-label">Micro (&lt;5)</div>
          <div class="bonus-dist-val" style="color:var(--purple)">\${fmt2(micSum)}</div>
          <div class="bonus-dist-sub">\${micro.length} payments &middot; avg \${micro.length > 0 ? fmt2(micSum/micro.length) : '0'}</div>
        </div>
      </div>

      <!-- Charts -->
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:1rem">
        <div class="ps-card">
          <div class="ps-card-title">\\ud83c\\udf69 Bonus Distribution</div>
          <div style="height:260px; position:relative"><canvas id="bonus-pie"></canvas></div>
        </div>
        <div class="ps-card">
          <div class="ps-card-title">\\ud83d\\udcca P&L Breakdown</div>
          <div style="height:260px; position:relative"><canvas id="bonus-bar"></canvas></div>
        </div>
      </div>

      <!-- Histogram -->
      <div class="ps-card">
        <div class="ps-card-title">\\ud83d\\udcc8 Bonus Size Distribution</div>
        <div style="height:260px; position:relative"><canvas id="bonus-hist"></canvas></div>
      </div>

      <!-- Import Section -->
      <div class="bonus-import-area">
        <div class="ps-card-title">\\u2795 Import New Bonuses</div>
        <div style="font-size:0.78rem; color:var(--text3); margin-bottom:0.5rem">Paste bonus amounts, one per line. Numbers only. They will be added to your existing bonuses.</div>
        <textarea id="bonus-import-text" placeholder="11.95\\n56.71\\n10.78\\n500\\n25\\n..."></textarea>
        <div>
          <button class="bonus-import-btn primary" onclick="importBonuses()">\\u2795 Import Bonuses</button>
          <button class="bonus-import-btn danger" onclick="if(confirm('Reset all bonuses to original data?')){saveBonuses([...SEED_BONUSES]);renderBonusView(document.getElementById('content'));}">\\u21ba Reset to Original</button>
        </div>
        <div id="bonus-import-msg" class="bonus-msg"></div>
      </div>

      <!-- Stats Table -->
      <div class="ps-card">
        <div class="ps-card-title">\\ud83d\\udcdd Quick Stats</div>
        <table class="ps-table">
          <tbody>
            <tr><td class="ps-pos">Total Bonuses</td><td style="color:var(--green); font-weight:700">+\${fmt2(total)} EUR</td></tr>
            <tr><td class="ps-pos">Number of Payments</td><td>\${count.toLocaleString()}</td></tr>
            <tr><td class="ps-pos">Average Bonus</td><td>\${fmt2(avg)} EUR</td></tr>
            <tr><td class="ps-pos">Largest Bonus</td><td style="color:var(--green)">\${fmt2(max)} EUR</td></tr>
            <tr><td class="ps-pos">Median Bonus</td><td>\${count > 0 ? fmt2([...bonuses].sort((a,b)=>a-b)[Math.floor(count/2)]) : '0'} EUR</td></tr>
            <tr><td class="ps-pos">Table P&L</td><td style="color:\${tablePnl >= 0 ? 'var(--green)' : 'var(--red)'}">\${f(tablePnl)} EUR</td></tr>
            <tr><td class="ps-pos">Rake Paid</td><td style="color:var(--gold)">\${fmt2(totalRake)} EUR</td></tr>
            <tr><td class="ps-pos">Effective Rakeback</td><td style="color:var(--green)">\${totalRake > 0 ? (total / totalRake * 100).toFixed(1) : 0}%</td></tr>
            <tr><td class="ps-pos">Net After Bonus</td><td style="color:\${netWithBonus >= 0 ? 'var(--green)' : 'var(--red)'}; font-weight:700">\${f(netWithBonus)} EUR</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  \`;

  // Charts
  setTimeout(() => {
    // Pie chart
    const pieEl = document.getElementById('bonus-pie');
    if (pieEl) {
      activeCharts.push(new Chart(pieEl, {
        type: 'doughnut',
        data: {
          labels: ['Big (100+)', 'Medium (25-99)', 'Small (5-24)', 'Micro (<5)'],
          datasets: [{
            data: [bigSum, medSum, smlSum, micSum],
            backgroundColor: ['rgba(0,212,170,0.7)', 'rgba(59,130,246,0.7)', 'rgba(245,158,11,0.7)', 'rgba(139,92,246,0.7)'],
            borderWidth: 0
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { position: 'bottom', labels: { color: '#94a3b8', font: { size: 11 } } },
            tooltip: { callbacks: { label: ctx => ctx.label + ': ' + ctx.parsed.toFixed(2) + ' EUR (' + (ctx.parsed / total * 100).toFixed(1) + '%)' } }
          }
        }
      }));
    }

    // Bar chart - P&L breakdown
    const barEl = document.getElementById('bonus-bar');
    if (barEl) {
      activeCharts.push(new Chart(barEl, {
        type: 'bar',
        data: {
          labels: ['Table P&L', 'Bonuses', 'Rake Paid', 'Net Result'],
          datasets: [{
            data: [tablePnl, total, -totalRake, netWithBonus],
            backgroundColor: [
              tablePnl >= 0 ? 'rgba(0,212,170,0.7)' : 'rgba(244,63,94,0.7)',
              'rgba(0,212,170,0.7)',
              'rgba(244,63,94,0.7)',
              netWithBonus >= 0 ? 'rgba(59,130,246,0.7)' : 'rgba(244,63,94,0.7)'
            ],
            borderRadius: 6
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => (ctx.parsed.y >= 0 ? '+' : '') + ctx.parsed.y.toFixed(2) + ' EUR' } } },
          scales: {
            x: { ticks: { color: '#64748b' }, grid: { display: false } },
            y: { ticks: { color: '#64748b', callback: v => (v >= 0 ? '+' : '') + v }, grid: { color: 'rgba(255,255,255,0.05)' } }
          }
        }
      }));
    }

    // Histogram
    const histEl = document.getElementById('bonus-hist');
    if (histEl) {
      const bins = [
        { label: '<1', min:0, max:1 },
        { label: '1-5', min:1, max:5 },
        { label: '5-10', min:5, max:10 },
        { label: '10-25', min:10, max:25 },
        { label: '25-50', min:25, max:50 },
        { label: '50-100', min:50, max:100 },
        { label: '100-300', min:100, max:300 },
        { label: '300-500', min:300, max:500 },
        { label: '500+', min:500, max:Infinity }
      ];
      const counts = bins.map(b => bonuses.filter(v => v >= b.min && v < b.max).length);
      const colors = ['#8b5cf6','#8b5cf6','#f59e0b','#f59e0b','#3b82f6','#3b82f6','#00d4aa','#00d4aa','#00d4aa'];
      activeCharts.push(new Chart(histEl, {
        type: 'bar',
        data: {
          labels: bins.map(b => b.label),
          datasets: [{ data: counts, backgroundColor: colors.map(c => c + 'b3'), borderRadius: 4 }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ctx.parsed.y + ' bonuses' } } },
          scales: {
            x: { title: { display: true, text: 'Amount (EUR)', color: '#64748b' }, ticks: { color: '#64748b' }, grid: { display: false } },
            y: { title: { display: true, text: 'Count', color: '#64748b' }, ticks: { color: '#64748b' }, grid: { color: 'rgba(255,255,255,0.05)' } }
          }
        }
      }));
    }
  }, 50);
}

function importBonuses() {
  const text = document.getElementById('bonus-import-text').value;
  const msgEl = document.getElementById('bonus-import-msg');
  const lines = text.split(/[\\n,;]+/).map(l => l.trim()).filter(l => l.length > 0);
  const amounts = lines.map(l => parseFloat(l)).filter(n => !isNaN(n) && n > 0);

  if (amounts.length === 0) {
    msgEl.className = 'bonus-msg error';
    msgEl.textContent = 'No valid numbers found. Paste one number per line.';
    return;
  }

  const merged = addBonuses(amounts);
  msgEl.className = 'bonus-msg success';
  msgEl.textContent = '\\u2705 Imported ' + amounts.length + ' bonuses (total: +' + amounts.reduce((s,v)=>s+v,0).toFixed(2) + ' EUR). You now have ' + merged.length + ' bonus entries.';
  document.getElementById('bonus-import-text').value = '';

  // Re-render after short delay
  setTimeout(() => renderBonusView(document.getElementById('content')), 1500);
}

`;
html = html.replace(leakFnMarker, bonusViewFn + leakFnMarker);

// ========== 6. INTEGRATE BONUS INTO DASHBOARD ==========
// Add a "Net Profit (with Bonus)" line to the dashboard hero card
const dashHeroMarker = `<div class="hero-label">All-Time Net Profit</div>
      <div class="hero-profit \${heroClass}">\${fmt(tp)}</div>`;
const dashHeroReplacement = `<div class="hero-label">All-Time Net Profit</div>
      <div class="hero-profit \${heroClass}">\${fmt(tp)}</div>
      <div style="font-size:0.82rem; color:var(--text2); margin-top:0.25rem">
        With Bonus: <span style="color:\${(tp + getTotalBonus()) >= 0 ? 'var(--green)' : 'var(--red)'}; font-weight:700">\${(tp + getTotalBonus() >= 0 ? '+' : '') + (tp + getTotalBonus()).toFixed(2)}</span>
        <span style="color:var(--text3); font-size:0.72rem; margin-left:0.5rem">(+\${getTotalBonus().toFixed(2)} bonus)</span>
      </div>`;
html = html.replace(dashHeroMarker, dashHeroReplacement);

// ========== 7. BUMP DATA_VERSION ==========
html = html.replace(/const DATA_VERSION = \d+;/, 'const DATA_VERSION = 8;');

fs.writeFileSync(path.join(__dirname, 'index.html'), html, 'utf8');
console.log('✅ Bonus tracker integrated!');
console.log('File size:', html.length, 'chars');

// Verify
const checks = [
  ['SEED_BONUSES', html.includes('SEED_BONUSES')],
  ['getBonuses()', html.includes('function getBonuses()')],
  ['renderBonusView', html.includes('function renderBonusView')],
  ['importBonuses', html.includes('function importBonuses()')],
  ['Nav item', html.includes('data-view="bonuses"')],
  ['Dashboard bonus', html.includes('getTotalBonus()')],
  ['Bonus CSS', html.includes('bonus-layout')],
  ['DATA_VERSION=8', html.includes('DATA_VERSION = 8')],
];
checks.forEach(([name, ok]) => console.log(ok ? '  ✓' : '  ✗', name));
