import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Veralteter Einzelüberblick. Der npm-Befehl check-app-feedback verweist seit
// Migration 0033 auf weekly-review.ts. Dieses Skript bleibt vorerst nur als
// historische Diagnosehilfe bestehen.
//
// Nutzung: npx tsx collectors/scripts/check-app-feedback.ts

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../app/.env') });

async function run() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[check-app-feedback] missing supabase envs — skipping'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const { data: rows, error } = await supabase
    .from('app_feedback')
    .select('id,message,screenshot_url,page_context,status,created_at')
    .order('created_at', { ascending: false });
  if (error) { console.error('[check-app-feedback] fetch failed', error); return; }
  if (!rows || rows.length === 0) { console.log('[check-app-feedback] no feedback yet'); return; }

  const pending = rows.filter((r) => r.status === 'new');
  console.log(`[check-app-feedback] ${pending.length} pending, ${rows.length - pending.length} already reviewed\n`);
  for (const r of rows) {
    console.log(`- [${r.status}] ${r.created_at} (${r.page_context ?? 'unbekannte Seite'})`);
    console.log(`  ${r.message}`);
    if (r.screenshot_url) console.log(`  Screenshot: ${r.screenshot_url}`);
    console.log('');
  }
}

run();
