// Leichte, abhängigkeitsfreie Tippfehler-Toleranz für die Event-Suche.
// Normalisiert Umlaute/Akzente und erlaubt pro Wort eine kleine
// Levenshtein-Distanz, statt nur exakte Teilstrings zu matchen.
// Unicode-Bereich "Combining Diacritical Marks" (U+0300–U+036F) — als
// \u-Escapes statt unsichtbarer Zeichen im Quelltext, damit es eindeutig bleibt.
const COMBINING_MARKS = /[̀-ͯ]/g;

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .replace(/ü/g, 'u')
    .replace(/ö/g, 'o')
    .replace(/ä/g, 'a')
    .replace(/ß/g, 'ss');
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[n];
}

// Für sehr kurze Suchwörter (<=2 Zeichen, z.B. "P1") ist eine Toleranz von 1
// Edit praktisch bedeutungslos — fast jedes zufällige 1-3-Zeichen-Wort im
// Haystack (Zahlen, Initialen, Markup-Reste) liegt dann "in der Nähe".
// Konkret beobachtet: ein nicht entferntes "<p>"-Tag im Rohtext einer Quelle
// spaltete sich beim Wort-Split in ein alleinstehendes "p" auf, das jede
// Suche nach "P1" fälschlich traf. Für tokenLength<=2 daher exakte
// Wortübereinstimmung verlangen statt Fuzzy-Toleranz.
function maxDistanceFor(tokenLength: number): number {
  if (tokenLength <= 2) return 0;
  if (tokenLength <= 4) return 1;
  if (tokenLength <= 8) return 2;
  return 3;
}

// Prüft, ob jedes Wort der Suchanfrage (getrennt durch Leerzeichen) im
// Haystack vorkommt — entweder als exakter Teilstring oder als Wort mit
// kleiner Tippfehler-Distanz. Mehrere Suchwörter müssen alle passen (UND).
export function fuzzyMatch(haystack: string, query: string): boolean {
  const h = normalize(haystack);
  const tokens = normalize(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;

  const hWords = h.split(/[^a-z0-9]+/).filter(Boolean);

  return tokens.every((token) => {
    if (h.includes(token)) return true;
    const maxDist = maxDistanceFor(token.length);
    return hWords.some(
      (w) => Math.abs(w.length - token.length) <= maxDist && levenshtein(w, token) <= maxDist
    );
  });
}
