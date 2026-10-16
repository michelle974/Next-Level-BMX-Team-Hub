// /api/raceinfo.js
// Race weekend details for the Florida State Series, read live from the
// official Sunshine State BMX site (sunshinestatebmx.com, a Wix blog).
//
//   GET /api/raceinfo?start=YYYY-MM-DD&end=YYYY-MM-DD
//
// 1. Reads the site's RSS feed to find the post whose dates overlap the
//    calendar event (titles look like "Event 1 - October 16-18, 2026").
// 2. Fetches that post and turns it into structured data: venue, parking and
//    camping, pre-sign link, and each day's schedule (Friday / Saturday / Sunday).
//
// Nothing is stored. When the series updates a post (a TBA gets filled in),
// the Team Hub shows the change within the cache window below.
// No env vars needed.

const SITE = 'https://www.sunshinestatebmx.com';
const FEED = SITE + '/blog-feed.xml';
const TTL_MS = 30 * 60 * 1000;          // per-instance cache: 30 minutes
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const cache = new Map();                // url -> { at, body }

async function getText(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.body;
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xml;q=0.9,*/*;q=0.8' } });
  if (!r.ok) throw new Error(`Sunshine State BMX returned ${r.status}`);
  const body = await r.text();
  cache.set(url, { at: Date.now(), body });
  return body;
}

/* ---------------- text helpers ---------------- */

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '-', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', hellip: '...' };
function decode(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}
function clean(s) {
  return decode(s).replace(/[\u200b\u200c\u200d\ufeff]/g, '').replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ').trim();
}
// HTML -> one line per paragraph / break.
function htmlToLines(html) {
  let h = String(html)
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h[1-6]|li|div|section|article|header|footer|tr|ul|ol|figure|blockquote)>/gi, '\n')
    .replace(/<(p|h[1-6]|li|div|tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return h.split('\n').map(clean).filter(Boolean);
}

/* ---------------- dates ---------------- */

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
function monthIdx(name) {
  const n = String(name || '').toLowerCase().slice(0, 3);
  return MONTHS.findIndex(m => m.startsWith(n));
}
const pad = n => String(n).padStart(2, '0');
// "Event 1 - October 16-18, 2026", "Final - May 14-16, 2027",
// "Event 9 - October 30 - November 1, 2026", "2027 Award Ceremony - May 16, 2027"
function titleRange(title) {
  const re = /([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*[-–]\s*(?:([A-Za-z]{3,9})\.?\s+)?(\d{1,2})(?:st|nd|rd|th)?)?,?\s+(\d{4})/;
  const m = String(title).match(re);
  if (!m) return null;
  const m1 = monthIdx(m[1]);
  if (m1 < 0) return null;
  const m2 = m[3] ? monthIdx(m[3]) : m1;
  if (m2 < 0) return null;
  let y2 = +m[5], y1 = y2;
  if (m2 < m1) y1 = y2 - 1;              // "December 30 - January 1, 2027"
  const start = `${y1}-${pad(m1 + 1)}-${pad(+m[2])}`;
  const end = `${y2}-${pad(m2 + 1)}-${pad(+(m[4] || m[2]))}`;
  return { start, end };
}
function dayNum(ymd) { return Math.round(Date.parse(ymd + 'T00:00:00Z') / 86400000); }
function overlapDays(a, b) {
  const s = Math.max(dayNum(a.start), dayNum(b.start));
  const e = Math.min(dayNum(a.end), dayNum(b.end));
  return e >= s ? e - s + 1 : 0;
}

/* ---------------- feed ---------------- */

function parseFeed(xml) {
  const items = [];
  const re = /<item\b[\s\S]*?<\/item>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[0];
    const pick = tag => {
      const x = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return x ? clean(x[1].replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '')) : '';
    };
    const title = pick('title');
    const link = pick('link');
    if (title && link) items.push({ title, link, range: titleRange(title) });
  }
  return items;
}
function matchPost(items, want) {
  let best = null, bestScore = -1;
  for (const it of items) {
    if (!it.range) continue;
    const ov = overlapDays(it.range, want);
    if (!ov) continue;
    // Prefer the race post over a same-weekend extra (the awards ceremony),
    // then the post whose dates line up most closely with the event.
    const extra = /award|ceremony|banquet/i.test(it.title) ? 0 : 100;
    const len = dayNum(it.range.end) - dayNum(it.range.start) + 1;
    const score = extra + ov * 10 - Math.abs(len - ov);
    if (score > bestScore) { best = it; bestScore = score; }
  }
  return best;
}

/* ---------------- post ---------------- */

const DAY_RE = /^(mon|tues|wednes|thurs|fri|satur|sun)day\b,?\s*(?:[A-Za-z]{3,9}\.?\s+\d|\d{1,2}\/\d{1,2})/i;
const TP = '\\d{1,2}(?::\\d{2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?)?';
const TN = '(?:12\\s*noon|noon|midnight)';
const TA = `(?:\\d{1,2}(?::\\d{2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?)|${TN})`;
const TIME_RE = new RegExp(`^((?:${TP}|${TN})\\s*(?:-|–|to)\\s*(?:${TP}|${TN})|${TA})\\s*[:\\-–]?\\s+(.+)$`, 'i');
// A real time has a colon, am/pm or noon ("8-10 M & F" is an age range, not a time).
const looksLikeTime = t => /:|[ap]\.?m|noon|midnight/i.test(t);
const INFO_LABELS = ['Parking', 'Camping', 'Track operator', 'Track Operator', 'Primary Contact', 'Track phone', 'Track Phone', 'Email', 'Hotels', 'Admission'];
const SKIP = [/^pre-?sign$/i, /^results$/i, /^https?:\/\//i, /^\d+\s+min read$/i, /^updated:/i, /^sunshine state bmx$/i,
  /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(,\s*\d{4})?$/i, /^local information:?$/i, /^welcome riders/i,
  /^writer:/i, /^\W+$/];
const STOP = [/^recent posts$/i, /^see all$/i, /^comments$/i, /^follow us here/i, /^write a comment/i, /^(\d+\s+)?views?$/i, /^like$/i];

function splitInfo(line) {
  // "Parking: daily $10 / Weekend $20 Camping: $150 for weekend" -> two entries
  const labels = INFO_LABELS.map(l => l.replace(/ /g, '\\s+')).join('|');
  const re = new RegExp(`(${labels})\\s*:`, 'gi');
  const hits = [...line.matchAll(re)];
  if (!hits.length || hits[0].index !== 0) return null;
  return hits.map((h, i) => ({
    label: h[1].replace(/\s+/g, ' ').replace(/^\w/, c => c.toUpperCase()),
    value: line.slice(h.index + h[0].length, i + 1 < hits.length ? hits[i + 1].index : undefined).trim(),
  })).filter(x => x.value);
}

function parsePost(html, title, url) {
  // Links worth keeping, straight from the HTML.
  const hrefs = [...String(html).matchAll(/href="([^"]+)"/gi)].map(m => decode(m[1]));
  const preSign = hrefs.find(h => /usabmx\.com\/(tracks\/[^/]+\/)?events\/\d+/i.test(h) && !/motoboard/i.test(h)) || '';
  const hotels = hrefs.find(h => /eventconnect\.io/i.test(h)) || '';

  const lines = htmlToLines(html);
  // Body starts right after the post title's heading; fall back to the first
  // "Welcome Riders" or the first day heading.
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === title && i + 1 < lines.length) { start = i + 1; }
  }
  if (start < 0) start = lines.findIndex(l => /^welcome riders/i.test(l));
  if (start < 0) start = lines.findIndex(l => DAY_RE.test(l));
  if (start < 0) return null;
  let body = lines.slice(start);
  const stopAt = body.findIndex(l => STOP.some(r => r.test(l)));
  if (stopAt >= 0) body = body.slice(0, stopAt);

  const out = { title, url, preSign, hotels, venue: '', series: '', address: [], info: [], days: [] };
  let day = null, block = null;
  const newBlock = (name) => { block = { title: name, items: [] }; day.blocks.push(block); };

  for (const raw of body) {
    const line = raw.replace(/\s*\/\s*hosted by track\s*\/\s*/i, ' · hosted by track · ');
    if (SKIP.some(r => r.test(line))) continue;

    if (DAY_RE.test(line)) {
      const [head, ...rest] = line.split(/\s+[-–]\s+/);
      day = { heading: head.replace(/:$/, ''), note: rest.join(' - '), blocks: [] };
      out.days.push(day);
      block = null;
      continue;
    }

    if (!day) {
      if (!out.venue && /\s:\s/.test(line)) { out.venue = line.replace(/\s+:\s+/, ' · '); continue; }
      if (/^scr races|^state championship|races?\s+\d/i.test(line) && !out.series) { out.series = line; continue; }
      const info = splitInfo(line);
      if (info) { out.info.push(...info); continue; }
      if (line.length < 80) out.address.push(line);
      continue;
    }

    const tm = line.match(TIME_RE);
    if (tm && looksLikeTime(tm[1])) {
      if (!block) newBlock('');
      block.items.push({ time: tm[1].replace(/\s+/g, ' ').trim(), text: tm[2].trim() });
      continue;
    }
    // A short line ending in ":" or naming a schedule opens a new group.
    if ((/:$/.test(line) && line.length < 60) || /^(practice|race|warm-?up)\s+schedule\b/i.test(line) || /^registration for sunday$/i.test(line)) {
      newBlock(line.replace(/:$/, ''));
      continue;
    }
    if (!block) newBlock('');
    const lv = line.match(/^([^:]{2,60}):\s+(.+)$/);
    if (lv && !/^https?$/i.test(lv[1])) block.items.push({ label: lv[1].trim(), text: lv[2].trim() });
    else block.items.push({ text: line });
  }

  // Drop empty groups, keep the order.
  for (const d of out.days) d.blocks = d.blocks.filter(b => b.items.length || b.title);
  return out;
}

/* ---------------- handler ---------------- */

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const start = String(req.query?.start || '').slice(0, 10);
    const end = String(req.query?.end || start).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      return res.status(400).json({ error: 'start and end must be YYYY-MM-DD' });
    }
    const items = parseFeed(await getText(FEED));
    const post = matchPost(items, { start, end });
    if (!post) return res.status(200).json({ found: false });

    let details = null, warning = '';
    try {
      details = parsePost(await getText(post.link), post.title, post.link);
      if (!details || !details.days.length) warning = 'Could not read the schedule from the post.';
    } catch (err) {
      warning = err.message;
    }
    return res.status(200).json({
      found: true,
      source: SITE,
      post: details || { title: post.title, url: post.link, days: [], info: [], address: [] },
      range: post.range,
      warning,
    });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}

// Exposed for local tests.
export const _test = { htmlToLines, parseFeed, matchPost, parsePost, titleRange, TIME_RE, DAY_RE };
