import * as cheerio from 'cheerio';

const url = 'http://import-export.cc/';
const res = await fetch(url);
console.log('STATUS', res.status);
const html = await res.text();
const $ = cheerio.load(html);
const events = [];
$('.event.event-link.item').each((i, el) => {
  const anchor = $(el).find('a.content').first();
  const href = anchor.attr('href');
  const title = anchor.find('h2.io-title').text().trim();
  const dateText = anchor.find('button.system-color').text().trim();
  const info = anchor.find('.event-infos').text().trim().replace(/\s+/g, ' ');
  const img = anchor.find('img').attr('src') ?? null;
  events.push({ href, title, dateText, info, img });
});
console.log(JSON.stringify(events.slice(0, 10), null, 2));
