const fetch = globalThis.fetch;
(async () => {
  try {
    const res = await fetch('http://import-export.cc/');
    const txt = await res.text();
    const lines = txt.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/event|veranstaltung|schedule|showtime|programm|date|time|location|wp-block|article/i.test(line)) {
        console.log(i + 1, line.trim());
      }
    }
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
