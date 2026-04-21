import { getSessions } from './store.js';

let charts = [];

export function renderAnalyticsView(container) {
  const sessions = getSessions();

  container.innerHTML = `
    <div class="analytics-layout">
      <div class="filters-bar">
        <div class="filter-group">
          <label for="filter-from">From</label>
          <input type="date" id="filter-from">
        </div>
        <div class="filter-group">
          <label for="filter-to">To</label>
          <input type="date" id="filter-to">
        </div>
        <div class="filter-group">
          <label for="filter-location">Location</label>
          <select id="filter-location">
            <option value="">All</option>
            ${[...new Set(sessions.map(s => s.location).filter(Boolean))].map(l => `<option value="${l}">${l}</option>`).join('')}
          </select>
        </div>
        <div class="filter-group">
          <label for="filter-game">Game Type</label>
          <select id="filter-game">
            <option value="">All</option>
            ${[...new Set(sessions.map(s => s.gameType).filter(Boolean))].map(g => `<option value="${g}">${g}</option>`).join('')}
          </select>
        </div>
        <button class="btn btn-sm btn-secondary" id="reset-filters">Reset</button>
      </div>

      <div class="stats-cards" id="stats-cards"></div>

      <div class="charts-grid">
        <div class="chart-card">
          <h3>Cumulative Profit</h3>
          <canvas id="chart-cumulative"></canvas>
        </div>
        <div class="chart-card">
          <h3>Monthly Results</h3>
          <canvas id="chart-monthly"></canvas>
        </div>
        <div class="chart-card">
          <h3>Profit by Location</h3>
          <canvas id="chart-location"></canvas>
        </div>
        <div class="chart-card">
          <h3>Profit by Game Type</h3>
          <canvas id="chart-game"></canvas>
        </div>
        <div class="chart-card full-width">
          <h3>Session Results Distribution</h3>
          <canvas id="chart-distribution"></canvas>
        </div>
      </div>
    </div>
  `;

  const applyFilters = () => {
    const from = container.querySelector('#filter-from').value;
    const to = container.querySelector('#filter-to').value;
    const loc = container.querySelector('#filter-location').value;
    const game = container.querySelector('#filter-game').value;

    let filtered = sessions;
    if (from) filtered = filtered.filter(s => s.date >= from);
    if (to) filtered = filtered.filter(s => s.date <= to);
    if (loc) filtered = filtered.filter(s => s.location === loc);
    if (game) filtered = filtered.filter(s => s.gameType === game);

    renderStats(container.querySelector('#stats-cards'), filtered);
    renderCharts(container, filtered);
  };

  container.querySelectorAll('.filters-bar input, .filters-bar select').forEach(el => {
    el.addEventListener('change', applyFilters);
  });

  container.querySelector('#reset-filters').addEventListener('click', () => {
    container.querySelector('#filter-from').value = '';
    container.querySelector('#filter-to').value = '';
    container.querySelector('#filter-location').value = '';
    container.querySelector('#filter-game').value = '';
    applyFilters();
  });

  applyFilters();
}

function renderStats(el, sessions) {
  if (sessions.length === 0) {
    el.innerHTML = '<p class="empty-state">No sessions to analyze. Add some sessions first!</p>';
    return;
  }

  const totalProfit = sessions.reduce((sum, s) => sum + (s.cashOut - s.buyIn), 0);
  const totalHours = sessions.reduce((sum, s) => sum + (s.duration || 0), 0);
  const totalBuyIn = sessions.reduce((sum, s) => sum + s.buyIn, 0);
  const wins = sessions.filter(s => s.cashOut > s.buyIn).length;
  const winRate = ((wins / sessions.length) * 100).toFixed(0);
  const hourlyRate = totalHours > 0 ? totalProfit / totalHours : 0;
  const avgSession = totalProfit / sessions.length;
  const biggestWin = Math.max(...sessions.map(s => s.cashOut - s.buyIn));
  const biggestLoss = Math.min(...sessions.map(s => s.cashOut - s.buyIn));

  const profitClass = totalProfit >= 0 ? 'positive' : 'negative';
  const hourlyClass = hourlyRate >= 0 ? 'positive' : 'negative';

  el.innerHTML = `
    <div class="stat-card">
      <div class="stat-label">Total Sessions</div>
      <div class="stat-value">${sessions.length}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Total Profit</div>
      <div class="stat-value ${profitClass}">$${totalProfit >= 0 ? '+' : ''}${totalProfit.toLocaleString()}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Win Rate</div>
      <div class="stat-value">${winRate}%</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Hourly Rate</div>
      <div class="stat-value ${hourlyClass}">$${hourlyRate >= 0 ? '+' : ''}${hourlyRate.toFixed(2)}/hr</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Total Hours</div>
      <div class="stat-value">${totalHours.toFixed(1)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Avg Session</div>
      <div class="stat-value ${avgSession >= 0 ? 'positive' : 'negative'}">$${avgSession >= 0 ? '+' : ''}${avgSession.toFixed(0)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Biggest Win</div>
      <div class="stat-value positive">$+${biggestWin.toLocaleString()}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Biggest Loss</div>
      <div class="stat-value negative">$${biggestLoss.toLocaleString()}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Total Invested</div>
      <div class="stat-value">$${totalBuyIn.toLocaleString()}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">ROI</div>
      <div class="stat-value ${profitClass}">${totalBuyIn > 0 ? ((totalProfit / totalBuyIn) * 100).toFixed(1) : 0}%</div>
    </div>
  `;
}

function renderCharts(container, sessions) {
  // Destroy old charts
  charts.forEach(c => c.destroy());
  charts = [];

  if (sessions.length === 0) return;

  const sorted = [...sessions].sort((a, b) => a.date.localeCompare(b.date));

  // 1. Cumulative Profit — proper poker graph (PokerTracker/HM style)
  //   - x-axis: session number (constant spacing, so slope = real win rate)
  //   - y-axis: cumulative $ profit
  //   - peak line (highest point ever reached) shown faintly to visualize drawdowns
  //   - zero baseline drawn explicitly
  //   - line colour: green when above peak, red while in drawdown
  //   - area fill below line down to 0 (or up to 0 if underwater)
  let cum = 0, peak = 0;
  const points = sorted.map((s, i) => {
    cum += s.cashOut - s.buyIn;
    if (cum > peak) peak = cum;
    return { idx: i + 1, date: s.date, sessionPnl: s.cashOut - s.buyIn, cum, peak, drawdown: cum - peak };
  });
  // Prepend a (0, 0) origin point so the line starts at zero
  const xs = [0, ...points.map(p => p.idx)];
  const ys = [0, ...points.map(p => p.cum)];
  const peaks = [0, ...points.map(p => p.peak)];
  const finalPnl = points.length ? points[points.length - 1].cum : 0;
  const lineColor = finalPnl >= 0 ? '#10b981' : '#ef4444';
  const fillColor = finalPnl >= 0 ? 'rgba(16, 185, 129, 0.12)' : 'rgba(239, 68, 68, 0.12)';

  charts.push(new Chart(container.querySelector('#chart-cumulative'), {
    type: 'line',
    data: {
      labels: xs,
      datasets: [
        {
          label: 'Cumulative Profit',
          data: ys,
          borderColor: lineColor,
          backgroundColor: fillColor,
          fill: { target: 'origin', above: fillColor, below: 'rgba(239, 68, 68, 0.12)' },
          borderWidth: 2,
          tension: 0.15,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: lineColor,
          pointHoverBorderColor: '#fff',
          pointHoverBorderWidth: 2,
          order: 1
        },
        {
          label: 'All-Time Peak',
          data: peaks,
          borderColor: 'rgba(148, 163, 184, 0.45)',
          borderWidth: 1,
          borderDash: [4, 4],
          pointRadius: 0,
          pointHoverRadius: 0,
          fill: false,
          stepped: 'before',
          order: 0
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          align: 'end',
          labels: { color: '#9ca3af', boxWidth: 12, boxHeight: 2, font: { size: 11 } }
        },
        tooltip: {
          backgroundColor: 'rgba(15, 23, 42, 0.95)',
          titleColor: '#f1f5f9',
          bodyColor: '#cbd5e1',
          borderColor: 'rgba(148,163,184,0.2)',
          borderWidth: 1,
          padding: 10,
          callbacks: {
            title: (items) => {
              const idx = items[0].dataIndex;
              if (idx === 0) return 'Start';
              const p = points[idx - 1];
              return `Session #${p.idx} — ${p.date}`;
            },
            label: (item) => {
              const idx = item.dataIndex;
              if (idx === 0) return 'Cumulative: $0';
              const p = points[idx - 1];
              const sign = (n) => (n >= 0 ? '+' : '') + '$' + n.toLocaleString();
              if (item.datasetIndex === 0) {
                return [
                  `Session result: ${sign(p.sessionPnl)}`,
                  `Cumulative:     ${sign(p.cum)}`,
                  p.drawdown < 0 ? `Drawdown:       ${sign(p.drawdown)}` : `At all-time high`
                ];
              }
              return `Peak: ${sign(p.peak)}`;
            }
          }
        },
        // Zero baseline annotation via custom plugin (drawn in beforeDatasetsDraw)
      },
      scales: {
        y: {
          ticks: {
            color: '#9ca3af',
            callback: v => (v >= 0 ? '+' : '') + '$' + v.toLocaleString()
          },
          grid: {
            color: (ctx) => ctx.tick.value === 0 ? 'rgba(148,163,184,0.5)' : 'rgba(255,255,255,0.05)',
            lineWidth: (ctx) => ctx.tick.value === 0 ? 1.5 : 1
          }
        },
        x: {
          title: { display: true, text: 'Session #', color: '#6b7280', font: { size: 11 } },
          ticks: { color: '#9ca3af', maxTicksLimit: 12 },
          grid: { color: 'rgba(255,255,255,0.04)' }
        }
      }
    }
  }));

  // 2. Monthly Results
  const monthly = {};
  sorted.forEach(s => {
    const month = s.date.slice(0, 7);
    monthly[month] = (monthly[month] || 0) + (s.cashOut - s.buyIn);
  });
  const monthLabels = Object.keys(monthly);
  const monthValues = Object.values(monthly);

  charts.push(new Chart(container.querySelector('#chart-monthly'), {
    type: 'bar',
    data: {
      labels: monthLabels,
      datasets: [{
        label: 'Monthly Profit',
        data: monthValues,
        backgroundColor: monthValues.map(v => v >= 0 ? 'rgba(16, 185, 129, 0.7)' : 'rgba(239, 68, 68, 0.7)'),
        borderColor: monthValues.map(v => v >= 0 ? '#10b981' : '#ef4444'),
        borderWidth: 1,
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        y: {
          ticks: { callback: v => '$' + v.toLocaleString() },
          grid: { color: 'rgba(255,255,255,0.06)' }
        },
        x: { grid: { color: 'rgba(255,255,255,0.06)' } }
      }
    }
  }));

  // 3. Profit by Location
  const byLocation = {};
  sessions.forEach(s => {
    const loc = s.location || 'Unknown';
    byLocation[loc] = (byLocation[loc] || 0) + (s.cashOut - s.buyIn);
  });
  const locLabels = Object.keys(byLocation);
  const locValues = Object.values(byLocation);

  charts.push(new Chart(container.querySelector('#chart-location'), {
    type: 'bar',
    data: {
      labels: locLabels,
      datasets: [{
        label: 'Profit',
        data: locValues,
        backgroundColor: locValues.map(v => v >= 0 ? 'rgba(16, 185, 129, 0.7)' : 'rgba(239, 68, 68, 0.7)'),
        borderColor: locValues.map(v => v >= 0 ? '#10b981' : '#ef4444'),
        borderWidth: 1,
      }]
    },
    options: {
      responsive: true,
      indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: {
        x: {
          ticks: { callback: v => '$' + v.toLocaleString() },
          grid: { color: 'rgba(255,255,255,0.06)' }
        },
        y: { grid: { color: 'rgba(255,255,255,0.06)' } }
      }
    }
  }));

  // 4. Profit by Game Type
  const byGame = {};
  sessions.forEach(s => {
    const g = s.gameType || 'Unknown';
    byGame[g] = (byGame[g] || 0) + (s.cashOut - s.buyIn);
  });
  const gameLabels = Object.keys(byGame);
  const gameValues = Object.values(byGame);

  charts.push(new Chart(container.querySelector('#chart-game'), {
    type: 'doughnut',
    data: {
      labels: gameLabels,
      datasets: [{
        data: gameValues.map(Math.abs),
        backgroundColor: [
          '#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6',
          '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16'
        ],
        borderWidth: 0,
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: 'bottom', labels: { color: '#9ca3af' } },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const val = gameValues[ctx.dataIndex];
              return `${ctx.label}: $${val >= 0 ? '+' : ''}${val.toLocaleString()}`;
            }
          }
        }
      }
    }
  }));

  // 5. Distribution
  const profits = sessions.map(s => s.cashOut - s.buyIn);
  const min = Math.min(...profits);
  const max = Math.max(...profits);
  const range = max - min || 1;
  const bucketSize = Math.max(50, Math.ceil(range / 10 / 50) * 50);
  const bucketStart = Math.floor(min / bucketSize) * bucketSize;
  const buckets = {};
  for (let b = bucketStart; b <= max; b += bucketSize) {
    buckets[b] = 0;
  }
  profits.forEach(p => {
    const b = Math.floor(p / bucketSize) * bucketSize;
    buckets[b] = (buckets[b] || 0) + 1;
  });
  const distLabels = Object.keys(buckets).map(Number).sort((a, b) => a - b);
  const distValues = distLabels.map(b => buckets[b]);

  charts.push(new Chart(container.querySelector('#chart-distribution'), {
    type: 'bar',
    data: {
      labels: distLabels.map(b => `$${b} to $${b + bucketSize}`),
      datasets: [{
        label: 'Sessions',
        data: distValues,
        backgroundColor: distLabels.map(b => b >= 0 ? 'rgba(16, 185, 129, 0.7)' : 'rgba(239, 68, 68, 0.7)'),
        borderColor: distLabels.map(b => b >= 0 ? '#10b981' : '#ef4444'),
        borderWidth: 1,
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        y: {
          title: { display: true, text: 'Sessions', color: '#9ca3af' },
          ticks: { stepSize: 1 },
          grid: { color: 'rgba(255,255,255,0.06)' }
        },
        x: { grid: { color: 'rgba(255,255,255,0.06)' } }
      }
    }
  }));
}
