// /api/_nationalnotes.js  (underscore = helper module, not a route)
//
// Reads a national race weekend from an Asana task's notes. Each national is a
// task in the Team Hub's Config section named "NATIONAL: <race name>".
// Edit the task in Asana and the Team Hub shows the change within a minute.
//
// Notes format (blank lines are ignored):
//
//   START: 2026-10-21                first day shown (YYYY-MM-DD)
//   END: 2026-10-25                  last day shown
//   VENUE: Oldsmar BMX Supercross · Oldsmar, FL
//   SERIES: USA BMX National · Races 1-3
//   PRESIGN: https://www.usabmx.com/events/634637
//   FLYER: https://admin.usabmx.com/assets/...
//   HOTEL_LINK: https://www.bmxhotels.com
//   ADDRESS: 3120 Tampa Road, Oldsmar, FL 34677
//   PARKING: $10 per day ...         chips on the card (also CAMPING, ADMISSION)
//   HOTELS: Rates as low as $152     shown in the card footer
//   NOTE: Transponders required ...  one line per "Good to know" bullet
//
//   Thursday, October 22 - Elite Hill and practice    <- a day (weekday first)
//   10:00am - 1:00pm: Elite Hill practice             <- time: what
//   Practice by Age:                                  <- a sub-heading
//   5:00pm - 5:45pm: 12 & Under
//   Any other line is shown as plain text.

const DAY_RE = /^(mon|tues|wednes|thurs|fri|satur|sun)day\b,?\s*(?:[A-Za-z]{3,9}\.?\s+\d|\d{1,2}\/\d{1,2})/i;
const TP = '\\d{1,2}(?::\\d{2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?)?';
const TN = '(?:12\\s*noon|noon|midnight)';
const TA = `(?:\\d{1,2}(?::\\d{2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?)|${TN})`;
const TIME_RE = new RegExp(`^((?:${TP}|${TN})\\s*(?:-|–|to)\\s*(?:${TP}|${TN})|${TA})\\s*[:\\-–]?\\s+(.+)$`, 'i');
const looksLikeTime = t => /:|[ap]\.?m|noon|midnight/i.test(t);
const KEY_RE = /^([A-Z][A-Z_]*)\s*:\s*(.*)$/;
const CHIPS = { PARKING: 'Parking', CAMPING: 'Camping', ADMISSION: 'Admission', HOTELS: 'Hotels', CONTACT: 'Contact' };

export function parseNationalTask(name, notes) {
  const title = String(name || '').replace(/^NATIONAL:\s*/i, '').trim();
  const post = { title, series: '', venue: '', url: '', preSign: '', hotels: '', flyer: '', address: [], info: [], notes: [], days: [] };
  let start = '', end = '', day = null, block = null;

  for (const raw of String(notes || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    if (DAY_RE.test(line)) {
      const [head, ...rest] = line.split(/\s+[-–]\s+/);
      day = { heading: head.replace(/:$/, ''), note: rest.join(' - '), blocks: [] };
      post.days.push(day);
      block = null;
      continue;
    }

    if (!day) {
      const m = line.match(KEY_RE);
      if (!m) { post.notes.push(line); continue; }
      const [, key, val] = m;
      if (!val) continue;
      if (key === 'START') start = val.slice(0, 10);
      else if (key === 'END') end = val.slice(0, 10);
      else if (key === 'VENUE') post.venue = val;
      else if (key === 'SERIES') post.series = val;
      else if (key === 'PRESIGN') { post.preSign = val; post.url = post.url || val; }
      else if (key === 'FLYER') post.flyer = val;
      else if (key === 'HOTEL_LINK') post.hotels = val;
      else if (key === 'ADDRESS') post.address.push(val);
      else if (key === 'NOTE') post.notes.push(val);
      else if (CHIPS[key]) post.info.push({ label: CHIPS[key], value: val });
      continue;
    }

    const tm = line.match(TIME_RE);
    if (tm && looksLikeTime(tm[1])) {
      if (!block) { block = { title: '', items: [] }; day.blocks.push(block); }
      block.items.push({ time: tm[1].replace(/\s+/g, ' ').trim(), text: tm[2].trim() });
      continue;
    }
    if (/:$/.test(line) && line.length < 80) {
      block = { title: line.replace(/:$/, '').trim(), items: [] };
      day.blocks.push(block);
      continue;
    }
    if (!block) { block = { title: '', items: [] }; day.blocks.push(block); }
    block.items.push({ text: line });
  }

  if (!end) end = start;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return null;
  for (const d of post.days) d.blocks = d.blocks.filter(b => b.items.length || b.title);
  return { start, end, post };
}
