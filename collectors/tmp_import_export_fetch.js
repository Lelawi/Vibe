const fetch = globalThis.fetch;
(async () => {
  try {
    const res = await fetch('http://import-export.cc/');
    console.log('STATUS', res.status);
    const txt = await res.text();
    console.log(txt.slice(0,2000));
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
