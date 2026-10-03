// Minimal RSS/Atom parser (enough for news feeds; no dependencies).

const decode = (s) => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/\s+/g, ' ').trim();

const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]) : '';
};

export function parseFeed(xml) {
  const items = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks) {
    const title = tag(b, 'title');
    if (!title) continue;
    const link = tag(b, 'link') || (b.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || '';
    const pub = tag(b, 'pubDate') || tag(b, 'updated') || tag(b, 'published');
    items.push({
      title,
      source: tag(b, 'source'),
      summary: tag(b, 'description').slice(0, 400) || tag(b, 'summary').slice(0, 400),
      link,
      published: pub ? Date.parse(pub) || null : null,
    });
  }
  return items;
}

export async function fetchFeed(url, timeoutMs = 10000) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 ValhallaRadio/0.1', Accept: 'application/rss+xml, application/xml, text/xml' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
  return parseFeed(await res.text());
}
