import https from 'https';
import cheerio from 'cheerio';

const agent = new https.Agent({ rejectUnauthorized: false });
const url = 'http://import-export.cc/';

const res = await fetch(url, { agent });
console.log('STATUS', res.status);
const html = await res.text();
const $ = cheerio.load(html);
const events = [];
$('.event.event-link.item').each((i, el) => {
  const anchor = $(el).find('a.content').first();
  const href = anchor.attr('href');
  const title = $(el).find('h2.io-title').text().trim();
  const dateText = $(el).find('button.system-color').text().trim();
  const kind = $(el).find('.event-infos p').last().text().trim();
  const img = $(el).find('img').attr('src');
  events.push({ href, title, dateText, kind, img });
});
console.log(JSON.stringify(events.slice(0, 10), null, 2));
