const fs = require('fs');
const path = require('path');

const filePath = path.resolve(__dirname, '..', 'collectors', 'core', 'known_venues.ts');
const txt = fs.readFileSync(filePath, 'utf8');

const blockMatch = txt.match(/export const KNOWN_VENUES:[\s\S]*?=\s*{([\s\S]*?)};/m);
if (!blockMatch) {
  console.error('KNOWN_VENUES block not found');
  process.exit(2);
}

const body = blockMatch[1];
const lineRe = /['"]([^'"]+)['"]\s*:\s*['"]([^'"]+)['"]/g;
const entries = [];
let m;
while ((m = lineRe.exec(body))) {
  entries.push({ key: m[1], value: m[2] });
}

const genericWords = ['werk', 'club', 'halle', 'platz', 'park', 'garten', 'arena', 'studio', 'haus', 'zentrum', 'museum'];

const shortKeys = entries.filter(e => e.key.replace(/[^a-zA-Z0-9]/g, '').length < 4);
const genericKeys = entries.filter(e => genericWords.includes(e.key));

// substring conflicts: key A is substring of key B
const substrConflicts = [];
for (let i = 0; i < entries.length; i++) {
  for (let j = 0; j < entries.length; j++) {
    if (i === j) continue;
    if (entries[j].key.includes(entries[i].key) && entries[i].key.length >= 3 && entries[j].key !== entries[i].key) {
      substrConflicts.push({ small: entries[i].key, big: entries[j].key });
    }
  }
}

console.log('KNOWN_VENUES analysis report');
console.log('file:', filePath);
console.log('total entries:', entries.length);
console.log('short keys (<4 letters):', shortKeys.map(e => e.key));
console.log('generic keys (explicit list):', genericKeys.map(e => e.key));

// summarize substring conflicts limited
const grouped = {};
substrConflicts.forEach(c => {
  grouped[c.small] = grouped[c.small] || new Set();
  grouped[c.small].add(c.big);
});

const summary = Object.entries(grouped).map(([k, set]) => ({ key: k, conflicts: Array.from(set) }));
console.log('substring conflicts (sample):', summary.slice(0, 30));

// exit code 0 but also write a JSON report
const out = { total: entries.length, shortKeys: shortKeys.map(e=>e.key), genericKeys: genericKeys.map(e=>e.key), substrConflicts: summary };
fs.writeFileSync(path.resolve(__dirname, 'known_venues_report.json'), JSON.stringify(out, null, 2));
console.log('Report written to scripts/known_venues_report.json');
