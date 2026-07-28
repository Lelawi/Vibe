const fetch = globalThis.fetch;
(async () => {
  const res = await fetch('http://import-export.cc/');
  const txt = await res.text();
  const lines = txt.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('class="event event-link"') || line.includes('class=\"event event-link') || line.includes('data-postid') || line.includes('class="event event-link old hide"') || line.includes('class=event event-link old hide')) {
      console.log('---', i + 1);
      for (let j = Math.max(0, i - 5); j < Math.min(lines.length, i + 15); j++) {
        console.log(`${j + 1}: ${lines[j]}`);
      }
      break;
    }
  }
})();
