function canonicalizeVenue(name) {
  if (!name) return 'Unbekannt';
  const keyRaw = name.trim().toLowerCase();
  const OVERRIDES = {
    'hotel bayerischer hof, festsaal': 'Hotel Bayerischer Hof',
    'hotel bayerischer hof, night': 'Hotel Bayerischer Hof',
    'residenz, brunnenhof': 'Brunnenhof',
    'residenz, brunnenhof/herkulessaal': 'Brunnenhof',
    'brunnenhof der residenz': 'Brunnenhof',
    'backstage all area': 'Backstage',
    'schloss blutenburg, jella': 'Schloss Blutenburg',
    'schloss blutenburg, unterer schlosshof': 'Schloss Blutenburg',
      'deutsches theater silbersaal': 'Deutsches Theater München',
      'deutsches theater theatersaal': 'Deutsches Theater München',
  };
  if (OVERRIDES[keyRaw]) return OVERRIDES[keyRaw];
  let s = name.replace(/\(.*?\)/g, '').replace(/[\-–—]/g, ' ').toLowerCase().trim();
  const parts = s.split(/[,/\\]/).map((p) => p.trim()).filter(Boolean);
  const genericTokens = [
    'süd','nord','ost','west','arena','club','halle','werkstatt','werk','studio','biergarten',
    'open air','open-air','openair','all area','festsaal','night','saal','unterer schlosshof','jella',
    'bereich','saal','lounge'
  ];
  const stopwords = ['der','die','das','von','am','in','münchen','muenchen','residenz'];

  function cleanPart(p) {
    let x = p;
    // debug step
    console.error('  CLEAN start:', JSON.stringify(x));
    genericTokens.forEach((g) => {
      const re = new RegExp('\\b' + g.replace(/[-\\s]/g, '\\s?') + '\\b', 'gi');
      x = x.replace(re, ' ');
    });
    console.error('  after generic replace:', JSON.stringify(x));
    stopwords.forEach((w) => {
      const re = new RegExp('\\b' + w + '\\b', 'gi');
      x = x.replace(re, ' ');
    });
    console.error('  after stopwords:', JSON.stringify(x));
    x = x.replace(/[^\\p{L}\\p{N}\\s]/gu, '').replace(/\\s+/g, ' ').trim();
    console.error('  final cleaned:', JSON.stringify(x));
    return x;
  }

  const cleanedParts = parts.map((p) => cleanPart(p)).filter(Boolean);
  // debug:
  console.error('DEBUG parts=', parts, 'cleaned=', cleanedParts);
  const highPriority = ['brunnenhof','backstage','bayerischer hof','muffathalle','muffat','zenith','schloss blutenburg','pasinger fabrik','milla','ampere','olympiapark','residenz','hotel'];
  let chosen = '';
  for (const hp of highPriority) {
    const found = cleanedParts.find((cp) => cp.includes(hp));
    if (found) { chosen = found; break; }
  }
  if (!chosen) {
    chosen = cleanedParts.sort((a, b) => b.length - a.length)[0] || parts[0] || s;
  }
  return chosen
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

const examples = [
  'Hotel Bayerischer Hof, Festsaal',
  'Hotel Bayerischer Hof, Night',
  'Brunnenhof',
  'Brunnenhof Der Residenz',
  'Residenz, Brunnenhof',
  'Residenz, Brunnenhof/Herkulessaal',
  'Backstage',
  'Backstage All Area',
  'Schloss Blutenburg, Jella',
  'Schloss Blutenburg, Unterer Schlosshof'
  ,'Deutsches Theater Silbersaal'
  ,'Deutsches Theater Theatersaal'
];

for (const ex of examples) {
  const out = canonicalizeVenue(ex);
  console.log(ex.padEnd(50), '→', JSON.stringify(out));
}
