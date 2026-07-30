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

// Optimal-String-Alignment-Variante von Levenshtein: benachbarte Buchstaben-
// Vertauschungen ("konzret" statt "konzert") kosten nur 1 Edit statt 2 (zwei
// Substitutionen bei reinem Levenshtein). Ohne diese Sonderregel müsste die
// Toleranz in maxDistanceFor() großzügiger sein, um Buchstabendreher noch zu
// tolerieren — genau diese Großzügigkeit ließ aber z.B. "apache" fälschlich
// auf "space" matchen (Editierdistanz 2 bei reinem Levenshtein, beides
// eigenständige, unverwandte Wörter). Mit Transpositions-Sonderregel kann
// die generelle Toleranz enger bleiben, ohne echte Tippfehler zu verlieren.
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const d: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

// Für sehr kurze Suchwörter (<=2 Zeichen, z.B. "P1") ist eine Toleranz von 1
// Edit praktisch bedeutungslos — fast jedes zufällige 1-3-Zeichen-Wort im
// Haystack (Zahlen, Initialen, Markup-Reste) liegt dann "in der Nähe".
// Konkret beobachtet: ein nicht entferntes "<p>"-Tag im Rohtext einer Quelle
// spaltete sich beim Wort-Split in ein alleinstehendes "p" auf, das jede
// Suche nach "P1" fälschlich traf. Für tokenLength<=2 daher exakte
// Wortübereinstimmung verlangen statt Fuzzy-Toleranz.
//
// Toleranz 2 für 5-8-Zeichen-Wörter (frühere Fassung) erlaubte genug
// Editierabstand, um komplett andere, gleich lange Wörter zu treffen (z.B.
// "apache" -> "space", Distanz 2) — kein Tippfehler mehr, sondern ein
// falscher Treffer. Dank Transpositions-Sonderregel oben deckt Distanz 1
// weiterhin Buchstabendreher ab, daher bis 8 Zeichen auf 1 verschärft; erst
// ab 9 Zeichen (mehr "Spielraum" im Wort, seltener zufällige Kollision mit
// einem echten anderen Wort) noch 2 zulassen.
function maxDistanceFor(tokenLength: number): number {
  if (tokenLength <= 2) return 0;
  if (tokenLength <= 8) return 1;
  return 2;
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
