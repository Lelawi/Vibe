import https from 'https';
import fetch from 'node-fetch';

const agent = new https.Agent({ rejectUnauthorized: false });
const url = 'https://import-export.cc/event/peoples-pride-soft-violet-rosa-rost-spinnen-djam-siam/';

(async () => {
  try {
    const res = await fetch(url, { agent });
    console.log('STATUS', res.status);
    const txt = await res.text();
    console.log(txt.slice(0, 2000));
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
