// Normalisiert Venue-Namen auf eine kanonische Form, damit z.B. "Backstage
// Halle" und "Backstage - Werkstatt" als derselbe Ort erkannt werden.
// Serverseitige, autoritative Mappings liegen in
// collectors/core/known_venues.ts — das hier ist nur die client-seitige
// Heuristik für Filter/Gruppierung.
export function canonicalizeVenue(name?: string | null) {
  if (!name) return 'Unbekannt';

  let s = name.replace(/\(.*?\)/g, '').replace(/[\-–—]/g, ' ').toLowerCase().trim();

  const parts = s.split(/[,/\\]/).map((p) => p.trim()).filter(Boolean);

  const genericTokens = [
    'süd','nord','ost','west','arena','club','halle','werkstatt','werk','studio','biergarten',
    'open air','open-air','openair','all area','festsaal','night','saal','unterer schlosshof','jella',
    'bereich','saal','lounge'
  ];
  const stopwords = ['der','die','das','von','am','in','münchen','muenchen','residenz'];

  function cleanPart(p: string) {
    let x = p;
    genericTokens.forEach((g) => {
      const re = new RegExp('\\b' + g.replace(/[-\s]/g, '\\s?') + '\\b', 'gi');
      x = x.replace(re, ' ');
    });
    stopwords.forEach((w) => {
      const re = new RegExp('\\b' + w + '\\b', 'gi');
      x = x.replace(re, ' ');
    });
    x = x.replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
    return x;
  }

  const cleanedParts = parts.map((p) => cleanPart(p)).filter(Boolean);

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
