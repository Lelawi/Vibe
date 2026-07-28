import path from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import { run as runBackstage } from './sources/backstage/index.js';
import { run as runMuenchenticket } from './sources/muenchenticket/index.js';
import { run as runLostweekend } from './sources/lostweekend/index.js';
import { run as runMuenchenevent } from './sources/muenchenevent/index.js';
import { run as runEventbrite } from './sources/eventbrite/index.js';
import { run as runMeetup } from './sources/meetup/index.js';
import { run as runResidentadvisor } from './sources/residentadvisor/index.js';
import { run as runMuenchenDe } from './sources/muenchen_de/index.js';
import { run as runEventfrog } from './sources/eventfrog/index.js';
import { run as runTicketmaster } from './sources/ticketmaster/index.js';
import { run as runTickettailor } from './sources/tickettailor/index.js';
import { run as runBilletto } from './sources/billetto/index.js';
import { run as runFacebookEvents } from './sources/facebook_events/index.js';
import { run as runTzAz } from './sources/tz_az/index.js';
import { run as runSueddeutsche } from './sources/sueddeutsche/index.js';
import { run as runKulturserver } from './sources/kulturserver/index.js';
import { run as runXingEvents } from './sources/xing_events/index.js';
import { run as runImportExport } from './sources/import_export/index.js';
import { run as runTito } from './sources/tito/index.js';
import { run as runTicketsDe } from './sources/tickets_de/index.js';

async function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

const sources = [
  { name: 'backstage', run: runBackstage },
  { name: 'muenchenticket', run: runMuenchenticket },
  { name: 'lostweekend', run: runLostweekend },
  { name: 'muenchenevent', run: runMuenchenevent },
  { name: 'eventbrite', run: runEventbrite },
  { name: 'meetup', run: runMeetup },
  { name: 'residentadvisor', run: runResidentadvisor },
  { name: 'muenchen-de', run: runMuenchenDe },
  { name: 'eventfrog', run: runEventfrog },
  { name: 'ticketmaster', run: runTicketmaster },
  { name: 'tickettailor', run: runTickettailor },
  { name: 'billetto', run: runBilletto },
  { name: 'facebook-events', run: runFacebookEvents },
  { name: 'tz-az', run: runTzAz },
  { name: 'sueddeutsche', run: runSueddeutsche },
  { name: 'kulturserver', run: runKulturserver },
  { name: 'xing-events', run: runXingEvents },
  { name: 'import-export', run: runImportExport },
  { name: 'tito', run: runTito },
  { name: 'tickets-de', run: runTicketsDe },
];

async function runAll() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const envPath = existsSync(path.resolve(__dirname, '.env'))
    ? path.resolve(__dirname, '.env')
    : path.resolve(__dirname, '../app/.env');
  config({ path: envPath });
  console.log('[collect-all] starting run for', sources.length, 'sources');

  for (const source of sources) {
    console.log(`[collect-all] running ${source.name}`);
    try {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
      await source.run();
    } catch (err) {
      console.error('[collect-all] error running', source.name, err);
    }
    await wait(750);
  }

  console.log('[collect-all] finished');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runAll().catch((e) => { console.error(e); process.exit(1); });
}

export default runAll;
