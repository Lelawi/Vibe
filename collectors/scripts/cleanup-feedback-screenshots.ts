import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../app/.env') });

export async function run() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) throw new Error('Supabase-Umgebung fehlt');
  const supabase = createClient(supabaseUrl, supabaseKey);
  const { data, error } = await supabase
    .from('app_feedback')
    .select('id,screenshot_path')
    .eq('status', 'reviewed')
    .not('screenshot_path', 'is', null)
    .lte('screenshot_delete_after', new Date().toISOString())
    .limit(100);
  if (error) throw error;
  const rows = data ?? [];
  const paths = rows.map((row) => row.screenshot_path).filter((value): value is string => Boolean(value));
  if (paths.length === 0) { console.log('[cleanup-feedback-screenshots] nichts zu loeschen'); return; }
  const { error: removeError } = await supabase.storage.from('feedback-screenshots').remove(paths);
  if (removeError) throw removeError;
  const { error: updateError } = await supabase
    .from('app_feedback')
    .update({ screenshot_path: null })
    .in('id', rows.map((row) => row.id));
  if (updateError) throw updateError;
  console.log(`[cleanup-feedback-screenshots] ${paths.length} private(s) Bild(er) geloescht`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
}
