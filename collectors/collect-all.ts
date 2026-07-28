import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

async function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

const sources = [
  'backstage', 'muenchenticket', 'lostweekend', 'muenchenevent', 'eventbrite', 'meetup', 'residentadvisor', 'muenchen-de',
  'eventfrog', 'ticketmaster', 'tickettailor', 'billetto', 'facebook-events', 'tz-az', 'sueddeutsche', 'kulturserver', 'xing-events', 'tito', 'tickets-de'
];

async function runAll() {
  console.log('[collect-all] starting run for', sources.length, 'sources');
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
    for (const s of sources) {
      console.log(`[collect-all] running npm run ${s}`);
      try {
        await new Promise((resolve) => {
          const p = spawn('npm', ['run', s], { stdio: 'inherit', shell: true });
          p.on('close', (code) => {
            if (code !== 0) console.warn(`[collect-all] ${s} exited ${code}`);
            resolve(null);
          });
          p.on('error', (err) => { console.error('[collect-all] spawn error', err); resolve(null); });
        });
      } catch (err) {
        console.error('[collect-all] error running', s, err);
      }
      await wait(750);
    }
  console.log('[collect-all] finished');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runAll().catch((e) => { console.error(e); process.exit(1); });
}

export default runAll;
