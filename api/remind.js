// /api/remind.js
// Vercel cron, once a day (vercel.json: 12:00 UTC = 7am EST / 8am EDT).
// Posts two kinds of reminders to the team GroupMe through the bot:
//
//  1. SIGN-UPS  the day before a sign-up board's DATE: what is still
//     needed and who is bringing what.
//  2. RSVP      N days before each team calendar event (RSVP_REMIND_DAYS,
//     default 7 and 2): which riders have not answered Going / Not going.
//
// Everything editable lives in Asana, Config section, no redeploy:
//   CONFIG: GroupMe Bot        BOT_ID, TEST_KEY, RSVP_REMIND (on/off),
//                              RSVP_REMIND_DAYS (e.g. 7,2), RSVP_SHOW_NAMES,
//                              RSVP_SKIP (title words to skip, comma list)
//   CONFIG: Reminder Messages  MESSAGE_NEEDS_ITEMS, MESSAGE_ALL_CLAIMED,
//                              MESSAGE_RSVP
//
// Manual test (posts nothing):  /api/remind?key=TEST_KEY&dry=1
// Pretend it is another day:    add &date=2026-11-12
// Really post now:              /api/remind?key=TEST_KEY  (no dry)

const ASANA_TOKEN = process.env.ASANA_TOKEN;
const SECTIONS = {
  signups: process.env.SEC_SIGNUPS || process.env.SIGNUPS_SECTION_GID || '1217629408209469',
  config:  process.env.SEC_CONFIG  || process.env.CONFIG_SECTION_GID  || '1217629408316937',
  riders:  process.env.SEC_RIDERS  || '1217616432345566',
  rsvps:   process.env.SEC_RSVPS   || '1218431788865096',
};
const CAL_ID = (process.env.GOOGLE_CALENDAR_ID || 'nextlevelbmx239@gmail.com').trim();
const CAL_KEY = (process.env.GOOGLE_CALENDAR_API_KEY || '').trim();
const TZ = 'America/New_York';

// ---------- Asana ----------
async function asana(path) {
  const r = await fetch(`https://app.asana.com/api/1.0${path}`, {
    headers: { Authorization: `Bearer ${ASANA_TOKEN}` },
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.errors?.[0]?.message || `Asana ${r.status}`);
  return j.data;
}

async function listSection(gid) {
  const out = [];
  let offset = '';
  do {
    const r = await fetch(`https://app.asana.com/api/1.0/sections/${gid}/tasks?opt_fields=gid,name,notes,completed&limit=100${offset ? `&offset=${offset}` : ''}`, {
      headers: { Authorization: `Bearer ${ASANA_TOKEN}` },
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j?.errors?.[0]?.message || `Asana ${r.status}`);
    out.push(...j.data);
    offset = j.next_page?.offset || '';
  } while (offset);
  return out;
}

function parseNotes(notes = '') {
  const out = {};
  for (const line of notes.split('\n')) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    if (!/^[A-Z0-9_]+$/.test(key)) continue;
    out[key] = line.slice(i + 1).trim();
  }
  return out;
}

// Each MESSAGE_X: block runs until the next MESSAGE_ label or the end.
function parseTemplates(notes = '') {
  const out = {};
  const re = /^(MESSAGE_[A-Z_]+):[ \t]*\n?([\s\S]*?)(?=^MESSAGE_[A-Z_]+:|(?![\s\S]))/gm;
  let m;
  while ((m = re.exec(notes))) out[m[1]] = m[2].trim();
  return out;
}

const DEFAULTS = {
  MESSAGE_NEEDS_ITEMS: '🚨 Race tomorrow: {EVENT_NAME}!\n\nStill needed:\n{UNCLAIMED_LIST}\n\nAlready covered:\n{CLAIMED_LIST}\n\nClaim yours in the Team Hub Sign-Ups! 🏁',
  MESSAGE_ALL_CLAIMED: '✅ All set for tomorrow: {EVENT_NAME}!\n\nEverything is covered:\n{CLAIMED_LIST}\n\nSee you at the track! 🏁',
  MESSAGE_RSVP: '📅 {EVENT_NAME} is {WHEN} ({EVENT_DATE}).\n\nStill need an RSVP from:\n{NO_RSVP_LIST}\n\nOpen the Team Hub > Schedule > tap the event > Going or Not going. 🏁',
};

async function getConfig() {
  const tasks = await listSection(SECTIONS.config);
  const bot = parseNotes((tasks.find(t => t.name === 'CONFIG: GroupMe Bot') || {}).notes || '');
  const msgTask = tasks.find(t => t.name === 'CONFIG: Reminder Messages');
  const tpl = { ...DEFAULTS };
  for (const [k, v] of Object.entries(parseTemplates(msgTask?.notes || ''))) if (v) tpl[k] = v;
  const days = String(bot.RSVP_REMIND_DAYS || '7,2').split(',').map(s => parseInt(s, 10)).filter(n => n >= 0);
  return {
    botId: (process.env.GROUPME_BOT_ID || bot.BOT_ID || '').trim(),
    testKey: (bot.TEST_KEY || '').trim(),
    rsvpOn: String(bot.RSVP_REMIND || 'on').toLowerCase() !== 'off',
    rsvpDays: days,
    showNames: String(bot.RSVP_SHOW_NAMES || 'yes').toLowerCase() !== 'no',
    skip: String(bot.RSVP_SKIP || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean),
    tpl,
  };
}

// ---------- dates (Eastern) ----------
function ymdET(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function niceDate(ymd) {
  return new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
function whenWord(n) {
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === 7) return 'one week away';
  return `${n} days away`;
}

// ---------- GroupMe ----------
async function sendGroupMe(botId, text) {
  // GroupMe caps a message at 1000 characters.
  const chunks = [];
  let rest = text;
  while (rest.length > 1000) {
    let cut = rest.lastIndexOf('\n', 1000);
    if (cut < 500) cut = 1000;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  chunks.push(rest);
  for (const c of chunks) {
    const r = await fetch('https://api.groupme.com/v3/bots/post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot_id: botId, text: c }),
    });
    if (!r.ok) throw new Error(`GroupMe refused the post (${r.status}). Check BOT_ID on CONFIG: GroupMe Bot.`);
  }
}

const fill = (tpl, vars) => tpl.replace(/\{([A-Z_]+)\}/g, (m, k) => (k in vars ? vars[k] : m));

// ---------- 1. sign-up boards ----------
async function signupMessages(cfg, today) {
  const tomorrow = addDays(today, 1);
  const boards = await listSection(SECTIONS.signups);
  const out = [];
  for (const b of boards) {
    if (b.completed) continue;
    const f = parseNotes(b.notes || '');
    if (!f.DATE || !f.DATE.startsWith(tomorrow)) continue;
    const items = await asana(`/tasks/${b.gid}/subtasks?opt_fields=name,notes`);
    const claimed = [], unclaimed = [];
    for (const it of items) {
      // A claimed slot is marked complete by the app, so read CLAIMED_BY, not completed.
      const by = (parseNotes(it.notes || '').CLAIMED_BY || '').trim();
      if (by) claimed.push(`✅ ${it.name}: ${by}`);
      else unclaimed.push(`❌ ${it.name}`);
    }
    if (!items.length) continue;
    const vars = {
      EVENT_NAME: b.name.replace(/^EVENT:\s*/i, '').trim(),
      CLAIMED_LIST: claimed.length ? claimed.join('\n') : '(none yet)',
      UNCLAIMED_LIST: unclaimed.join('\n'),
    };
    out.push({
      kind: 'signups', event: vars.EVENT_NAME, unclaimed: unclaimed.length, claimed: claimed.length,
      text: fill(unclaimed.length ? cfg.tpl.MESSAGE_NEEDS_ITEMS : cfg.tpl.MESSAGE_ALL_CLAIMED, vars),
    });
  }
  return out;
}

// ---------- 2. RSVP nudges ----------
async function calendarEvents(fromYmd, toYmd) {
  if (!CAL_KEY) throw new Error('GOOGLE_CALENDAR_API_KEY is not set in Vercel.');
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CAL_ID)}/events`
    + `?key=${CAL_KEY}&singleEvents=true&orderBy=startTime&maxResults=250`
    + `&timeMin=${encodeURIComponent(new Date(`${fromYmd}T00:00:00-05:00`).toISOString())}`
    + `&timeMax=${encodeURIComponent(new Date(`${addDays(toYmd, 1)}T06:00:00-05:00`).toISOString())}`;
  const r = await fetch(url);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || 'Calendar fetch failed.');
  return (j.items || []).filter(e => e.status !== 'cancelled').map(e => ({
    id: e.id,
    title: e.summary || 'Team event',
    startYmd: e.start?.date || ymdET(new Date(e.start?.dateTime)),
  }));
}

const isGuest = f => String(f.GUEST || '').toLowerCase() === 'true';
const hiddenGuest = f => isGuest(f) && String(f.HUB_VISIBLE || '').toLowerCase() !== 'true';

async function rsvpMessages(cfg, today) {
  if (!cfg.rsvpOn || !cfg.rsvpDays.length) return [];
  const maxDays = Math.max(...cfg.rsvpDays);
  const [events, riders, rsvpTasks] = await Promise.all([
    calendarEvents(today, addDays(today, maxDays)),
    listSection(SECTIONS.riders),
    listSection(SECTIONS.rsvps),
  ]);
  const roster = riders
    .filter(r => !r.completed)
    .map(r => ({ gid: r.gid, name: r.name, f: parseNotes(r.notes || '') }))
    .filter(r => !hiddenGuest(r.f));
  const rsvpByEvent = {};
  for (const t of rsvpTasks) {
    const f = parseNotes(t.notes || '');
    if (f.EVENT_ID) rsvpByEvent[f.EVENT_ID] = f;
  }
  const out = [];
  for (const e of events) {
    const n = Math.round((new Date(`${e.startYmd}T12:00:00Z`) - new Date(`${today}T12:00:00Z`)) / 86400000);
    if (!cfg.rsvpDays.includes(n)) continue;
    const t = e.title.toLowerCase();
    if (cfg.skip.some(w => t.includes(w))) continue;
    const answered = rsvpByEvent[e.id] || {};
    const missing = roster.filter(r => answered[`RSVP_${r.gid}`] === undefined || answered[`RSVP_${r.gid}`] === '');
    if (!missing.length) continue;
    const names = missing.map(r => r.name).sort((a, b) => a.localeCompare(b));
    const list = cfg.showNames
      ? names.map(x => `• ${x}`).join('\n')
      : `${names.length} rider${names.length === 1 ? '' : 's'}`;
    out.push({
      kind: 'rsvp', event: e.title, daysOut: n, missing: names.length,
      text: fill(cfg.tpl.MESSAGE_RSVP, {
        EVENT_NAME: e.title, EVENT_DATE: niceDate(e.startYmd), WHEN: whenWord(n),
        NO_RSVP_LIST: list, NO_RSVP_COUNT: String(names.length),
      }),
    });
  }
  return out;
}

// ---------- handler ----------
export default async function handler(req, res) {
  try {
    const cfg = await getConfig();
    const q = req.query || {};
    const secret = process.env.CRON_SECRET;
    const auth = req.headers['authorization'] || '';
    const fromCron = secret
      ? auth === `Bearer ${secret}`
      : /vercel-cron/i.test(req.headers['user-agent'] || '');
    const withKey = !!q.key && ((cfg.testKey && q.key === cfg.testKey) || (secret && q.key === secret));
    if (!fromCron && !withKey) return res.status(401).json({ error: 'Unauthorized' });

    const dry = String(q.dry || '') === '1';
    const today = withKey && /^\d{4}-\d{2}-\d{2}$/.test(q.date || '') ? q.date : ymdET();
    if (!cfg.botId && !dry) return res.status(500).json({ error: 'No GroupMe bot ID configured.' });

    const errors = [];
    const msgs = [];
    for (const job of [signupMessages, rsvpMessages]) {
      try { msgs.push(...(await job(cfg, today))); }
      catch (err) { errors.push(`${job.name}: ${err.message}`); }
    }
    if (!dry) for (const m of msgs) await sendGroupMe(cfg.botId, m.text);

    console.log('[remind]', today, dry ? 'dry' : 'sent', msgs.length, errors);
    return res.status(errors.length && !msgs.length ? 500 : 200).json({
      today, dry, botConfigured: !!cfg.botId, sent: dry ? 0 : msgs.length, messages: msgs, errors,
    });
  } catch (err) {
    console.error('[remind] error', err);
    return res.status(500).json({ error: err.message });
  }
}
