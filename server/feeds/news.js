// Local + national headlines from Google News RSS searches and any custom feeds.
import { store } from '../store.js';
import { fetchFeed } from './rss.js';

let cache = { at: 0, key: '', data: null };

function gnews(q) {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
}

const cleanTitle = (t) => t.replace(/\s+-\s+[^-]+$/, ''); // strip " - Publisher"

export async function getNews() {
  const market = store.station.market || {};
  const locs = (market.locations || []).map((l) => l.name.split(',')[0]);
  const key = JSON.stringify([locs, store.settings.newsFeeds]);
  if (cache.data && cache.key === key && Date.now() - cache.at < 15 * 60_000) return cache.data;

  const dedupe = (items) => {
    const seen = new Set();
    return items.filter((i) => {
      const k = cleanTitle(i.title).toLowerCase().slice(0, 60);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  const fresh = (i) => !i.published || Date.now() - i.published < 36 * 3600_000;

  const local = [];
  for (const name of locs.slice(0, 5)) {
    try {
      const items = await fetchFeed(gnews(`"${name}" when:1d`));
      local.push(...items.filter(fresh).slice(0, 6).map((i) => ({ ...i, title: cleanTitle(i.title), area: name })));
    } catch (e) { console.warn('[news]', name, e.message); }
  }
  for (const url of store.settings.newsFeeds || []) {
    try {
      const items = await fetchFeed(url);
      local.push(...items.filter(fresh).slice(0, 6).map((i) => ({ ...i, title: cleanTitle(i.title), area: 'feed' })));
    } catch (e) { console.warn('[news]', url, e.message); }
  }
  let national = [];
  try {
    national = (await fetchFeed('https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en'))
      .filter(fresh).slice(0, 8).map((i) => ({ ...i, title: cleanTitle(i.title) }));
  } catch (e) { console.warn('[news] national', e.message); }
  let entertainment = [];
  try {
    entertainment = (await fetchFeed(gnews('music OR concert OR album OR singer when:1d')))
      .filter(fresh).slice(0, 8).map((i) => ({ ...i, title: cleanTitle(i.title) }));
  } catch { /* optional */ }

  const data = { local: dedupe(local).slice(0, 14), national: dedupe(national), entertainment: dedupe(entertainment) };
  cache = { at: Date.now(), key, data };
  return data;
}
