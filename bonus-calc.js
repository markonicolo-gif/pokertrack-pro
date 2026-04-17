// Computes totals from Novibet bonus report data, grouping by Bonus Type,
// with and without FreeBet.
const fs = require('fs');
const text = fs.readFileSync('bonus-raw.txt', 'utf8');
const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);

const byType = {};
let total = 0, totalExFB = 0, rowCount = 0, fbCount = 0;
let earliest = null, latest = null;

for (const line of lines) {
  const f = line.split('\t');
  if (f.length < 6) continue;
  if (f[0].toLowerCase().includes('userid')) continue; // header
  const created = f[2];
  const amt = parseFloat(f[3]);
  const cur = f[4];
  const type = (f[5] || '').trim();
  if (isNaN(amt) || cur !== 'EUR') continue;
  rowCount++;
  byType[type] = (byType[type] || 0) + amt;
  total += amt;
  if (type.toLowerCase() === 'freebet') { fbCount++; }
  else { totalExFB += amt; }

  // parse DD/MM/YYYY
  const m = created.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const d = `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
    if (!earliest || d < earliest) earliest = d;
    if (!latest || d > latest) latest = d;
  }
}

console.log('Total rows:', rowCount);
console.log('Date range:', earliest, '→', latest);
console.log('');
console.log('By type:');
Object.entries(byType).sort((a,b) => b[1]-a[1]).forEach(([t,v]) => {
  console.log(`  ${t.padEnd(12)} €${v.toFixed(2)}`);
});
console.log('');
console.log(`TOTAL (all):           €${total.toFixed(2)}`);
console.log(`TOTAL (excl. FreeBet): €${totalExFB.toFixed(2)}`);
console.log(`FreeBet rows excluded: ${fbCount}`);
