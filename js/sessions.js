import { getSessions, addSession, updateSession, deleteSession, clearAll } from './store.js';
import { exportToCSV, importCSV } from './csv.js';

let editingId = null;
let sortColumn = 'date';
let sortAsc = false;

const GAME_TYPES = [
  'NL Hold\'em 1/2', 'NL Hold\'em 1/3', 'NL Hold\'em 2/5', 'NL Hold\'em 5/10',
  'PLO 1/2', 'PLO 2/5', 'PLO 5/10',
  'Tournament', 'Sit & Go'
];

export function renderSessionsView(container) {
  const sessions = getSessions();
  const locations = [...new Set(sessions.map(s => s.location).filter(Boolean))];

  container.innerHTML = `
    <div class="sessions-layout">
      <div class="form-card">
        <h2 id="form-title">Add Session</h2>
        <form id="session-form">
          <div class="form-grid">
            <div class="form-group">
              <label for="date">Date</label>
              <input type="date" id="date" required value="${new Date().toISOString().slice(0, 10)}">
            </div>
            <div class="form-group">
              <label for="location">Location</label>
              <input type="text" id="location" list="location-list" placeholder="Casino / Home game">
              <datalist id="location-list">
                ${locations.map(l => `<option value="${l}">`).join('')}
              </datalist>
            </div>
            <div class="form-group">
              <label for="gameType">Game Type</label>
              <input type="text" id="gameType" list="game-type-list" placeholder="NL Hold'em 1/2">
              <datalist id="game-type-list">
                ${GAME_TYPES.map(g => `<option value="${g}">`).join('')}
              </datalist>
            </div>
            <div class="form-group">
              <label for="buyIn">Buy-in ($)</label>
              <input type="number" id="buyIn" required min="0" step="1" placeholder="0">
            </div>
            <div class="form-group">
              <label for="cashOut">Cash-out ($)</label>
              <input type="number" id="cashOut" required min="0" step="1" placeholder="0">
            </div>
            <div class="form-group">
              <label for="duration">Duration (hours)</label>
              <input type="number" id="duration" min="0" step="0.25" placeholder="0">
            </div>
            <div class="form-group full-width">
              <label for="notes">Notes</label>
              <textarea id="notes" rows="2" placeholder="Optional notes..."></textarea>
            </div>
          </div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary" id="submit-btn">Add Session</button>
            <button type="button" class="btn btn-secondary" id="cancel-btn" style="display:none">Cancel</button>
          </div>
        </form>
      </div>

      <div class="table-card">
        <div class="table-header">
          <h2>Sessions <span class="session-count">(${sessions.length})</span></h2>
          <div class="table-actions">
            <button class="btn btn-sm btn-secondary" id="import-btn">Import CSV</button>
            <button class="btn btn-sm btn-secondary" id="export-btn" ${sessions.length === 0 ? 'disabled' : ''}>Export CSV</button>
            <button class="btn btn-sm btn-danger" id="clear-btn" ${sessions.length === 0 ? 'disabled' : ''}>Clear All</button>
            <input type="file" id="csv-input" accept=".csv" style="display:none">
          </div>
        </div>
        ${sessions.length === 0
          ? '<p class="empty-state">No sessions yet. Add your first session above or import a CSV file.</p>'
          : renderTable(sessions)
        }
      </div>
    </div>
  `;

  bindEvents(container);
}

function renderTable(sessions) {
  const sorted = [...sessions].sort((a, b) => {
    let va = a[sortColumn], vb = b[sortColumn];
    if (sortColumn === 'profit') { va = a.cashOut - a.buyIn; vb = b.cashOut - b.buyIn; }
    if (sortColumn === 'hourly') {
      va = a.duration > 0 ? (a.cashOut - a.buyIn) / a.duration : 0;
      vb = b.duration > 0 ? (b.cashOut - b.buyIn) / b.duration : 0;
    }
    if (typeof va === 'number' && typeof vb === 'number') return sortAsc ? va - vb : vb - va;
    return sortAsc ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
  });

  const cols = [
    { key: 'date', label: 'Date' },
    { key: 'location', label: 'Location' },
    { key: 'gameType', label: 'Game' },
    { key: 'buyIn', label: 'Buy-in' },
    { key: 'cashOut', label: 'Cash-out' },
    { key: 'profit', label: 'Profit' },
    { key: 'duration', label: 'Hours' },
    { key: 'hourly', label: '$/hr' },
  ];

  const arrow = (key) => sortColumn === key ? (sortAsc ? ' \u25B2' : ' \u25BC') : '';

  return `
    <div class="table-wrapper">
      <table>
        <thead>
          <tr>
            ${cols.map(c => `<th class="sortable" data-sort="${c.key}">${c.label}${arrow(c.key)}</th>`).join('')}
            <th>Notes</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${sorted.map(s => {
            const profit = s.cashOut - s.buyIn;
            const hourly = s.duration > 0 ? profit / s.duration : 0;
            const cls = profit > 0 ? 'positive' : profit < 0 ? 'negative' : '';
            return `
              <tr>
                <td>${s.date}</td>
                <td>${s.location || '-'}</td>
                <td>${s.gameType || '-'}</td>
                <td>$${s.buyIn.toLocaleString()}</td>
                <td>$${s.cashOut.toLocaleString()}</td>
                <td class="${cls}">$${profit >= 0 ? '+' : ''}${profit.toLocaleString()}</td>
                <td>${s.duration || '-'}</td>
                <td class="${cls}">${s.duration > 0 ? '$' + (hourly >= 0 ? '+' : '') + hourly.toFixed(0) : '-'}</td>
                <td class="notes-cell" title="${(s.notes || '').replace(/"/g, '&quot;')}">${s.notes || '-'}</td>
                <td class="action-cell">
                  <button class="btn-icon edit-btn" data-id="${s.id}" title="Edit">&#9998;</button>
                  <button class="btn-icon delete-btn" data-id="${s.id}" title="Delete">&#10005;</button>
                </td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function bindEvents(container) {
  const form = container.querySelector('#session-form');
  const cancelBtn = container.querySelector('#cancel-btn');

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const data = {
      date: form.date.value,
      location: form.location.value.trim(),
      gameType: form.gameType.value.trim(),
      buyIn: parseFloat(form.buyIn.value) || 0,
      cashOut: parseFloat(form.cashOut.value) || 0,
      duration: parseFloat(form.duration.value) || 0,
      notes: form.notes.value.trim(),
    };

    if (editingId) {
      updateSession(editingId, data);
      editingId = null;
    } else {
      addSession(data);
    }
    renderSessionsView(container);
  });

  cancelBtn.addEventListener('click', () => {
    editingId = null;
    renderSessionsView(container);
  });

  // Sort
  container.querySelectorAll('.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (sortColumn === key) sortAsc = !sortAsc;
      else { sortColumn = key; sortAsc = key === 'date' ? false : true; }
      renderSessionsView(container);
    });
  });

  // Edit
  container.querySelectorAll('.edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const session = getSessions().find(s => s.id === btn.dataset.id);
      if (!session) return;
      editingId = session.id;
      form.date.value = session.date;
      form.location.value = session.location;
      form.gameType.value = session.gameType;
      form.buyIn.value = session.buyIn;
      form.cashOut.value = session.cashOut;
      form.duration.value = session.duration;
      form.notes.value = session.notes || '';
      container.querySelector('#form-title').textContent = 'Edit Session';
      container.querySelector('#submit-btn').textContent = 'Update Session';
      cancelBtn.style.display = '';
      form.scrollIntoView({ behavior: 'smooth' });
    });
  });

  // Delete
  container.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (confirm('Delete this session?')) {
        deleteSession(btn.dataset.id);
        renderSessionsView(container);
      }
    });
  });

  // Import/Export
  container.querySelector('#import-btn').addEventListener('click', () => {
    container.querySelector('#csv-input').click();
  });

  container.querySelector('#csv-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const { sessions, errors } = await importCSV(file);
      if (errors.length > 0) alert('Warnings:\n' + errors.join('\n'));
      const store = getSessions();
      for (const s of sessions) {
        s.id = crypto.randomUUID();
        store.push(s);
      }
      const { saveSessions } = await import('./store.js');
      saveSessions(store);
      alert(`Imported ${sessions.length} sessions`);
      renderSessionsView(container);
    } catch (err) {
      alert('Import failed: ' + err.message);
    }
  });

  container.querySelector('#export-btn').addEventListener('click', () => {
    exportToCSV(getSessions());
  });

  container.querySelector('#clear-btn').addEventListener('click', () => {
    if (confirm('Delete ALL sessions? This cannot be undone.')) {
      clearAll();
      renderSessionsView(container);
    }
  });
}
