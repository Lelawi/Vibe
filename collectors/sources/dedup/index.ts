import { createClient } from '@supabase/supabase-js';

const OUR_SUPABASE_URL = process.env.SUPABASE_URL!;
const OUR_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

async function main() {
  console.log('Dedup-Lauf gestartet...');

  const supabase = createClient(OUR_SUPABASE_URL, OUR_SERVICE_ROLE_KEY);
  const { error } = await supabase.rpc('mark_duplicate_events');

  if (error) {
    console.error('Fehler beim Deduplizieren:', error);
    process.exit(1);
  }

  console.log('Duplikat-Erkennung abgeschlossen.');

  // Kein Duplikat-Merge, sondern reines Bild-Teilen zwischen echten,
  // unterschiedlichen Terminen derselben Produktion (siehe Migration 0041)
  // — z.B. eventim liefert für viele Theater-Einzeltermine kein Bild,
  // während eine andere Quelle für dieselbe Produktion eins hat.
  const { error: imageShareError } = await supabase.rpc('share_images_across_same_production');
  if (imageShareError) console.error('Fehler beim Bild-Teilen:', imageShareError);
  else console.log('Bild-Teilen (gleiche Produktion) abgeschlossen.');
}

main();