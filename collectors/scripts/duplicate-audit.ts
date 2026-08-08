import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../app/.env') });

// Findet Kandidaten für Fälle, die mark_duplicate_events() (siehe
// supabase/migrations/0035-0039) NICHT automatisch zusammenführt — nicht um
// sie automatisch zu entscheiden (das bleibt bei mark_duplicate_events()
// selbst, mit vorsichtigen, klar begründbaren Regeln), sondern um sie
// systematisch AUFFINDBAR zu machen, statt sie nur zufällig per Nutzer-
// Screenshot zu entdecken (per Nutzer-Feedback, 2026-08-08: "der Fall mit
// Doppelungen ist auffällig häufig").
//
// Zwei Kategorien:
// A) "Near-Miss Venue": gleiches Datum+Uhrzeit+Stadt, Location-Namen sich
//    ähnlich aber unter der 0.4-Trigram-Schwelle (z.B. "Muffathalle" vs.
//    "Muffatwerk", "FAT CAT" vs. "LUCKY PUNCH Comedy Club") — Kandidaten für
//    die kuratierte Alias-Liste (dedup_known_venue() in 0039, gespiegelt in
//    collectors/core/known_venues.ts).
// B) "Exakter Ort, fremder Titel": gleicher Location-Name (exakt oder sehr
//    ähnlich) + Datum + Uhrzeit, aber Titel praktisch unähnlich — kein
//    Aliasing möglich, da der Titel selbst keine gemeinsame Basis hat (z.B.
//    "Sternschnuppe" vs. "Familien-Mitsing-Konzert in München"). Diese
//    Kategorie kann mark_duplicate_events() strukturell nie automatisch
//    lösen (keine sichere Text-Heuristik ohne echtes Fehlerrisiko) — bleibt
//    Kandidat für eine manuelle Entscheidung oder eine quellenspezifische
//    Sonderregel.
//
// Nutzung: npm run duplicate-audit in collectors/

type EventRow = {
  id: string;
  title: string;
  location_name: string | null;
  start_date: string;
  start_time: string | null;
  city: string;
  source_id: string;
  price_info: string | null;
};

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Einfache Trigram-Ähnlichkeit (Jaccard über Zeichen-Trigramme) — im Sinn
// nah an Postgres' pg_trgm similarity(), reicht für eine grobe clientseitige
// Voreinstufung. Die eigentliche, autoritative Bewertung nutzt weiterhin
// echtes pg_trgm in der DB (mark_duplicate_events selbst).
function trigramSimilarity(a: string, b: string): number {
  const grams = (s: string) => {
    const padded = `  ${s} `;
    const set = new Set<string>();
    for (let i = 0; i < padded.length - 2; i++) set.add(padded.slice(i, i + 3));
    return set;
  };
  const ga = grams(normalize(a));
  const gb = grams(normalize(b));
  if (ga.size === 0 || gb.size === 0) return 0;
  let intersection = 0;
  for (const g of ga) if (gb.has(g)) intersection++;
  const union = ga.size + gb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export async function run(write: (value: string) => void = console.log): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { write('[duplicate-audit] Supabase-Umgebung fehlt'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const today = new Date().toISOString().slice(0, 10);
  let rows: EventRow[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('events')
      .select('id, title, location_name, start_date, start_time, city, source_id, price_info')
      .is('duplicate_of', null)
      .gte('start_date', today)
      .not('location_name', 'is', null)
      .range(from, from + pageSize - 1);
    if (error) throw error;
    rows = rows.concat(data as EventRow[]);
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  write(`[duplicate-audit] ${rows.length} zukünftige, nicht bereits zusammengeführte Events geladen\n`);

  // Gruppierung nach Datum+Uhrzeit+Stadt hält die O(n²)-Paarvergleiche klein
  // (nur innerhalb desselben Zeitslots vergleichen, nicht über alle Events).
  const byDateTime = new Map<string, EventRow[]>();
  for (const r of rows) {
    const key = `${r.start_date}|${r.start_time ?? ''}|${r.city}`;
    if (!byDateTime.has(key)) byDateTime.set(key, []);
    byDateTime.get(key)!.push(r);
  }

  const nearMissVenue: { a: EventRow; b: EventRow; venueSim: number }[] = [];
  const sameVenueDifferentTitle: { a: EventRow; b: EventRow; titleSim: number }[] = [];

  for (const group of byDateTime.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        if (!a.location_name || !b.location_name) continue;
        const venueSim = trigramSimilarity(a.location_name, b.location_name);
        const titleSim = trigramSimilarity(a.title, b.title);

        // Kategorie A: Venue-Namen erkennbar ähnlich, aber unter der
        // 0.4-Produktionsschwelle — 0.15 als untere Grenze, um komplett
        // unrelated Venues (Zufallsüberschneidung einzelner Trigramme)
        // nicht mit reinzuziehen.
        if (venueSim >= 0.15 && venueSim < 0.4 && titleSim > 0.3) {
          nearMissVenue.push({ a, b, venueSim });
        }

        // Kategorie B: (fast) derselbe Location-Name, aber Titel praktisch
        // unähnlich — kein Aliasing-Fall, sondern potenziell zwei komplett
        // verschieden benannte Quellen desselben Events.
        if (venueSim > 0.6 && titleSim < 0.2) {
          sameVenueDifferentTitle.push({ a, b, titleSim });
        }
      }
    }
  }

  write(`## A) Near-Miss Venue-Paare (${nearMissVenue.length})\n`);
  write('Kandidaten für die kuratierte Alias-Liste (dedup_known_venue in supabase/migrations, gespiegelt in collectors/core/known_venues.ts).\n');
  for (const { a, b, venueSim } of nearMissVenue.slice(0, 50)) {
    write(`- "${a.location_name}" vs. "${b.location_name}" (Ähnlichkeit ${venueSim.toFixed(2)}) — "${a.title}" (${a.source_id}) / "${b.title}" (${b.source_id}), ${a.start_date} ${a.start_time ?? ''}`);
  }

  write(`\n## B) Gleicher Ort, fremder Titel (${sameVenueDifferentTitle.length})\n`);
  write('Kann mark_duplicate_events() strukturell nicht automatisch lösen — Titel hat keine gemeinsame Textbasis. Manuell prüfen.\n');
  for (const { a, b, titleSim } of sameVenueDifferentTitle.slice(0, 50)) {
    write(`- "${a.title}" (${a.source_id}) vs. "${b.title}" (${b.source_id}) — ${a.location_name}, ${a.start_date} ${a.start_time ?? ''} (Titel-Ähnlichkeit ${titleSim.toFixed(2)})`);
  }

  write(`\nGesamt: ${nearMissVenue.length + sameVenueDifferentTitle.length} Kandidaten.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
