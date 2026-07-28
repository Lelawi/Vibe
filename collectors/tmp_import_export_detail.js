const fetch = globalThis.fetch;
(async () => {
  try {
    const url = 'https://import-export.cc/event/peoples-pride-soft-violet-rosa-rost-spinnen-djam-siam/';
    const res = await fetch(url);
    console.log('STATUS', res.status);
    const txt = await res.text();
    const lines = txt.split(/\r?\n/);
    for (let i = 0; i < Math.min(lines.length, 260); i++) {
      console.log(`${i+1}: ${lines[i]}`);
    }
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
