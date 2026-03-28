const HEADERS = ['date', 'location', 'gameType', 'buyIn', 'cashOut', 'duration', 'notes'];

export function exportToCSV(sessions) {
  const rows = [HEADERS.join(',')];
  for (const s of sessions) {
    const row = HEADERS.map(h => {
      const val = s[h] ?? '';
      const str = String(val);
      return str.includes(',') || str.includes('"') || str.includes('\n')
        ? '"' + str.replace(/"/g, '""') + '"'
        : str;
    });
    rows.push(row.join(','));
  }
  const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `poker-sessions-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function parseCSV(text) {
  const lines = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === '\n' || ch === '\r') {
        if (current.length > 0 || lines.length > 0) {
          lines.push(current);
          current = '';
        }
        if (ch === '\r' && text[i + 1] === '\n') i++;
      } else {
        current += ch;
      }
    }
  }
  if (current.length > 0) lines.push(current);

  if (lines.length === 0) return { sessions: [], errors: ['Empty file'] };

  // Check if first line is header
  const firstLine = lines[0].toLowerCase();
  const startIdx = firstLine.includes('date') && firstLine.includes('buyin') ? 1 : 0;

  const sessions = [];
  const errors = [];

  for (let i = startIdx; i < lines.length; i++) {
    const fields = splitCSVLine(lines[i]);
    if (fields.length < 5) {
      errors.push(`Row ${i + 1}: not enough fields`);
      continue;
    }

    const date = fields[0]?.trim();
    const location = fields[1]?.trim() || '';
    const gameType = fields[2]?.trim() || '';
    const buyIn = parseFloat(fields[3]);
    const cashOut = parseFloat(fields[4]);
    const duration = parseFloat(fields[5]) || 0;
    const notes = fields[6]?.trim() || '';

    if (!date || isNaN(buyIn) || isNaN(cashOut)) {
      errors.push(`Row ${i + 1}: invalid data (need date, buyIn, cashOut)`);
      continue;
    }

    sessions.push({ date, location, gameType, buyIn, cashOut, duration, notes });
  }

  return { sessions, errors };
}

function splitCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

export function importCSV(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(parseCSV(e.target.result));
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}
