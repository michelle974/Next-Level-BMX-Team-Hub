// Next Level BMX Team Hub — Race Day (moto board, results log, team sheets)
// Storage: one Asana task per race day in the "Race Day" section of the Team Hub
// project. Motos, feed results, picks and lock live in that task's notes.
// Parent-logged results are Asana comments on the task (append-only, so two
// parents logging at the same moment never overwrite each other).

import crypto from 'crypto';

const ASANA = 'https://app.asana.com/api/1.0';
const TOKEN = process.env.ASANA_TOKEN;
const SECRET = process.env.SESSION_SECRET || 'nlbmx-dev-secret-change-me';
const PROJECT_GID = process.env.HUB_PROJECT_GID || '1217616477503428';
const SEC_RIDERS = process.env.SEC_RIDERS || '1217616432345566';
const SEC_PARENTS = process.env.SEC_PARENTS || '1217629407873450';
const FEED_URL = process.env.RACEDAY_FEED_URL || 'https://motoboards.usabmx.com/events/track_1968.json';
const RD_SECTION_NAME = 'Race Day';
const LOG_PREFIX = 'RD1 ';

/* State series race days. Orlando State Champs is one day only. */
const SCHEDULE = [
  { race: 'OLDSMAR', sat: '2026-10-17', sun: '2026-10-18' },
  { race: 'DAYTONA', sat: '2026-11-14', sun: '2026-11-15' },
  { race: 'TAMPA', sat: '2027-01-09', sun: '2027-01-10' },
  { race: 'OKEEHEELEE', sat: '2027-02-06', sun: '2027-02-07' },
  { race: 'CHARLOTTE', sat: '2027-03-20', sun: '2027-03-21' },
  { race: 'HIGH SPRINGS', sat: '2027-04-24', sun: '2027-04-25' },
  { race: 'ORLANDO STATE CHAMPS', sun: '2027-05-16', single: true },
];
/* Points roster and each rider's usual classes. A RACE_CLASSES line on the
   rider's Team Hub record (set from ADMIN > tap a name > THIS SEASON) wins. */
const DEFAULT_CLASSES = {
  '1218574356224928': 'class',               // Danny
  '1218417819296738': 'cruiser,class',       // Westin
  '1218870867210707': 'class',               // Maverick
  '1218502006939913': 'class',               // Cameron
  '1218474207475104': 'open,class',          // Addison
  '1218499152780145': 'open,class',          // John
  '1218422751273322': 'open,cruiser,class',  // Finn
  '1218536822086540': 'open,cruiser,class',  // Beau
  '1217688811972923': 'cruiser,class',       // Gavin
  '1218534177518486': 'class',               // Davis
  '1218499552279429': 'cruiser,class',       // Jimmy
  '1217691735658902': 'cruiser,class',       // Vincenzo
  '1219017784885460': 'class',               // Noah
  '1218474699070852': 'cruiser',             // Caleb
  '1218868051910927': 'open,class',          // Juan
  '1218780741222024': 'open,class',          // Gage
};
/* Last season's state series results (2025-2026 tracker: Ancient City,
   Naples, Sarasota, Tampa), used for pick predictions.
   rider gid -> race type -> [[start-of-day rider count, main finish (0 = no main), class code], ...] */
const HISTORY_2026 = {"1217688662198033":{"class":[[18,0,"8i"],[15,0,"8i"],[16,0,"8i"],[15,0,"8i"],[14,0,"8i"],[11,7,"8i"],[13,0,"8i"]]},"1218422751273322":{"class":[[13,0,"9x"],[12,0,"9x"],[13,0,"9x"],[10,7,"9x"],[9,8,"9x"],[11,0,"9x"],[12,0,"9x"]],"open":[[9,0,"9-10 o"],[9,0,"9-10 o"]]},"1218868051910927":{"open":[[10,2,"9-10 mix"],[10,2,"9-10 mix"],[17,6,"9-10 mix"],[14,5,"9-10 mix"],[13,5,"9-10 mix"],[20,7,"9-10 mix"],[9,5,"9-10 mix"],[11,3,"9-10 mix"]],"class":[[20,4,"10i"],[21,6,"10i"],[20,7,"10i"],[18,6,"9i"],[17,6,"9i"],[18,4,"9i"],[17,2,"9i"]]},"1218536822086540":{"open":[[10,3,"9-10 mix"],[14,4,"9-10 mix"],[13,3,"9-10 mix"],[20,4,"9-10 mix"],[9,1,"9-10 mix"],[11,2,"9-10 mix"]],"class":[[20,3,"10i"],[21,2,"10i"],[20,8,"10i"],[18,3,"10i"],[19,3,"10i"],[12,1,"10n"],[17,1,"10n"]],"cruiser":[[9,5,"10c"]]},"1218499152780145":{"class":[[13,5,"9x"],[12,4,"9x"],[13,0,"9x"]]},"1217688811972923":{"cruiser":[[7,4,"11c"],[7,6,"11c"],[9,5,"11c"],[7,4,"11c"],[6,5,"11c"],[6,3,"11c"],[8,4,"11c"],[8,5,"11c"]],"class":[[16,3,"11x"],[15,5,"11x"],[9,7,"11x"],[13,8,"11x"],[13,0,"11x"],[17,0,"11x"],[15,0,"11x"]]},"1217691735658902":{"cruiser":[[6,5,"14c"],[6,6,"14c"],[7,5,"14c"],[6,6,"14c"],[5,4,"14c"],[5,4,"14c"],[5,4,"14c"]],"class":[[16,0,"14x"],[16,0,"14x"],[15,0,"14x"],[18,0,"14x"],[16,0,"14x"],[19,0,"14x"],[21,0,"14x"]]},"1218499552279429":{"cruiser":[[6,1,"14c"],[6,1,"14c"],[7,2,"14c"]],"class":[[16,2,"14x"],[16,0,"14x"],[15,0,"14x"]]},"1218474207475104":{"open":[[10,0,"pro-am"],[8,8,"pro-am"],[11,2,"13-14 mix"],[10,2,"13-14 mix"],[19,2,"13-14 mix"],[12,4,"13-14 mix"],[12,4,"13-14 mix"]],"class":[[9,6,"13gx"],[7,6,"13gx"],[4,2,"14gx"],[3,2,"14gx"],[15,1,"13gx"],[15,1,"13gx"],[15,5,"13gx"],[16,4,"13gx"]]},"1218474699070852":{"cruiser":[[6,5,"16c"],[6,3,"16c"],[4,2,"16c"],[4,3,"16c"],[4,2,"16c"],[4,2,"16c"],[5,3,"15c"],[5,5,"15c"]],"class":[[16,0,"16x"],[15,0,"16x"],[9,0,"16x"],[15,0,"16x"],[15,0,"16x"],[17,8,"15x"],[16,8,"15x"]]},"1218574356224928":{"class":[[10,1,"36-40n"],[7,1,"36-40n"],[9,2,"36-40n"]]},"1218552188030900":{"cruiser":[[9,6,"11c"],[7,3,"11c"],[9,4,"10c"],[8,3,"10c"],[9,7,"10c"],[10,8,"10c"]],"class":[[9,6,"11x"],[18,5,"10x"],[18,5,"10x"],[18,7,"10x"],[21,4,"10x"]],"open":[[9,3,""]]},"1218780741222024":{"open":[[4,2,"11-12 o"]],"class":[[17,4,"12x"]]}};

// This season's race days that Michelle finalized on the Team Sheets page.
// Only finalized scores count, so predictions match what she signed off on.
// Only days before the one being viewed count (all days when testing).
function seasonHistory(dayTasks, skipKey) {
  const rows = {}, days = [];
  const order = allDays().map(d => d.key);
  const cur = order.indexOf(skipKey);
  for (const t of dayTasks) {
    const key = t.fields.DAY_KEY || t.name.replace(/^RACEDAY:\s*/, '');
    if (key === skipKey || key === TEST_DAY.key) continue;
    if (cur >= 0 && order.indexOf(key) > cur) continue;
    const fin = jparse(t.fields.FINAL_JSON, null);
    if (!fin || !fin.scores) continue;
    days.push({ key, at: fin.at || '' });
    for (const [k, sc] of Object.entries(fin.scores)) {
      if (sc.state !== 'scored' && sc.state !== 'dnq') continue; // did not race or not finished
      const [id, type] = k.split('|');
      ((rows[id] = rows[id] || {})[type] = rows[id][type] || []).push([sc.count || 0, sc.place || 0, String(sc.code || '').toLowerCase()]);
    }
  }
  days.sort((a, b) => allDays().findIndex(d => d.key === a.key) - allDays().findIndex(d => d.key === b.key));
  return { rows, days };
}

const TEST_DAY = { key: 'TEST|SAT', race: 'TEST', day: 'SAT', date: '', test: true };

function allDays() {
  const out = [];
  for (const r of SCHEDULE) {
    if (r.sat) out.push({ key: `${r.race}|SAT`, race: r.race, day: 'SAT', date: r.sat });
    if (r.sun) out.push({ key: `${r.race}|SUN`, race: r.race, day: 'SUN', date: r.sun, single: !!r.single });
  }
  return out;
}

function todayET() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

// Race day shown by default: today if it is a race day, otherwise the next one.
function defaultDayKey() {
  const t = todayET();
  const days = allDays();
  return (days.find(d => d.date >= t) || days[days.length - 1]).key;
}

/* ---------- session + asana helpers (same scheme as api/asana.js) ---------- */

const signSession = gid =>
  crypto.createHmac('sha256', SECRET).update(`sess:${gid}`).digest('hex');

function verifySession(gid, sig) {
  if (!gid || !sig) return false;
  const a = Buffer.from(String(sig));
  const b = Buffer.from(signSession(gid));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function asanaRaw(path, opts = {}, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${ASANA}${path}`, {
        ...opts,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'Content-Type': 'application/json',
          ...(opts.headers || {}),
        },
      });
      if (res.status === 429) {
        const wait = parseInt(res.headers.get('Retry-After') || '2', 10) * 1000;
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      const json = await res.json();
      if (!res.ok) throw new Error(json?.errors?.[0]?.message || `Asana ${res.status}`);
      return json;
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 400));
    }
  }
}
const asana = async (path, opts, retries) => (await asanaRaw(path, opts, retries)).data;

function parseNotes(notes = '') {
  const out = {};
  for (const line of notes.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (!/^[A-Z0-9_]+$/.test(key)) continue;
    out[key] = line.slice(idx + 1).trim();
  }
  return out;
}

const buildNotes = f => Object.entries(f)
  .filter(([, v]) => v !== undefined && v !== null)
  .map(([k, v]) => `${k}: ${v}`).join('\n');

async function listSection(sectionGid) {
  const tasks = await asana(
    `/sections/${sectionGid}/tasks?opt_fields=name,notes,completed&limit=100`);
  return (tasks || []).map(t => ({
    gid: t.gid, name: t.name, completed: t.completed,
    fields: parseNotes(t.notes || ''),
  }));
}

async function getTask(gid) {
  const t = await asana(`/tasks/${gid}?opt_fields=projects,notes,name`);
  if (!(t.projects || []).some(p => p.gid === PROJECT_GID)) {
    throw new Error('Task is outside the Team Hub project');
  }
  return { gid: t.gid, name: t.name, fields: parseNotes(t.notes || '') };
}

async function patchTask(gid, updates) {
  const t = await getTask(gid);
  const merged = { ...t.fields, ...updates };
  await asana(`/tasks/${gid}`, {
    method: 'PUT',
    body: JSON.stringify({ data: { notes: buildNotes(merged) } }),
  });
  return merged;
}

const jparse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const jline = v => JSON.stringify(v).replace(/\n/g, ' ');

let rdSectionGid = process.env.SEC_RACEDAY || null;
async function raceDaySection() {
  if (rdSectionGid) return rdSectionGid;
  const secs = await asana(`/projects/${PROJECT_GID}/sections?opt_fields=name`);
  const hit = (secs || []).find(s => s.name.trim().toLowerCase() === RD_SECTION_NAME.toLowerCase());
  if (hit) return (rdSectionGid = hit.gid);
  const made = await asana(`/projects/${PROJECT_GID}/sections`, {
    method: 'POST', body: JSON.stringify({ data: { name: RD_SECTION_NAME } }),
  });
  return (rdSectionGid = made.gid);
}

async function findDayTask(key, create) {
  const sec = await raceDaySection();
  const tasks = await listSection(sec);
  const hit = tasks.find(t => t.name === `RACEDAY: ${key}`);
  if (hit || !create) return hit || null;
  const task = await asana('/tasks', {
    method: 'POST',
    body: JSON.stringify({ data: { name: `RACEDAY: ${key}`, notes: buildNotes({ DAY_KEY: key }), projects: [PROJECT_GID] } }),
  });
  await asana(`/sections/${sec}/addTask`, { method: 'POST', body: JSON.stringify({ data: { task: task.gid } }) });
  return { gid: task.gid, name: `RACEDAY: ${key}`, fields: { DAY_KEY: key } };
}

// All comments on the race day task, oldest first.
async function readLogs(taskGid) {
  const logs = {}, acks = {};
  let path = `/tasks/${taskGid}/stories?opt_fields=text,created_at,resource_subtype&limit=100`;
  for (let page = 0; page < 30 && path; page++) {
    const json = await asanaRaw(path);
    for (const s of json.data || []) {
      if (s.resource_subtype !== 'comment_added' || !(s.text || '').startsWith(LOG_PREFIX)) continue;
      const e = jparse(s.text.slice(LOG_PREFIX.length), null);
      if (!e || !e.k) continue;
      if (e.ack !== undefined) acks[e.k] = e.ack;
      else logs[e.k] = { v: e.v || {}, by: e.n || '', at: s.created_at };
    }
    const next = json.next_page?.offset;
    path = next ? `/tasks/${taskGid}/stories?opt_fields=text,created_at,resource_subtype&limit=100&offset=${next}` : null;
  }
  return { logs, acks };
}

async function addLog(taskGid, entry) {
  await asana(`/tasks/${taskGid}/stories`, {
    method: 'POST', body: JSON.stringify({ data: { text: LOG_PREFIX + JSON.stringify(entry) } }),
  });
}

/* ---------- feed parsing (pure; tested against the May 2026 State Champs feed) ---------- */
// FEED-PARSER-START
const normName = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

function raceType(cls) {
  if (/cruiser/i.test(cls)) return 'cruiser';
  if (/mix|open|pro-?am/i.test(cls)) return 'open';
  return 'class';
}

function classCode(cls) {
  const s = String(cls || '').trim();
  if (/pro-?am/i.test(s)) return 'pro-am';
  const age = (s.match(/^[\d+\-]+\+?/) || [''])[0];
  const rest = s.slice(age.length).toLowerCase();
  const girl = /girl|\bw\b|women/.test(rest);
  let suf = '';
  if (/pro-?am/.test(rest)) suf = 'pa';
  else if (/cruiser/.test(rest)) suf = 'c';
  else if (/mix/.test(rest)) suf = 'mix';
  else if (/open/.test(rest)) suf = 'o';
  else if (/nov/.test(rest)) suf = 'n';
  else if (/int/.test(rest)) suf = 'i';
  else if (/ex/.test(rest)) suf = 'x';
  if (!age) return s.toLowerCase().replace(/\s+/g, '');
  return age + (girl ? 'g' : '') + suf;
}

const transferN = desc => parseInt((String(desc).match(/(\d+)\s*To\b/i) || [])[1] || '0', 10);
const numSort = (a, b) => (parseInt(a, 10) - parseInt(b, 10)) || String(a).localeCompare(String(b));
const roundKey = { Qtr: 'Q', Semi: 'S', Main: 'M' };

/* riders: [{id, name, serial}] from the Team Hub. Returns entries + feed results. */
function parseFeed(feed, riders, opts = {}) {
  const races = Object.values(feed.races || {}).sort((a, b) => (a.order || 0) - (b.order || 0));
  if (!races.length) return { error: 'No races in the live feed yet.' };
  let race = opts.raceId ? races.find(r => r.id === opts.raceId) : null;
  if (!race && races.length > 1 && opts.day) {
    const word = opts.day === 'SAT' ? /sat/i : /sun/i;
    race = races.find(r => word.test(r.name || '')) || races[opts.day === 'SAT' ? 0 : 1];
  }
  race = race || races[0];

  const bySerial = {}, byName = {};
  for (const r of riders) {
    if (r.serial) bySerial[String(r.serial).trim()] = r;
    byName[normName(r.name)] = r;
  }

  const acById = {};
  for (const [name, ac] of Object.entries(race.ageclasses || {})) {
    acById[ac.id] = { name, rounds: (ac.rounds || []).map(o => Object.values(o)[0]).filter(Boolean) };
  }

  const roundMotos = {}; // acId -> roundName -> [moto numbers]
  const present = {};   // acId -> roundName -> Set(serial)
  const hits = {};      // riderId|acId -> {rider, acId, groups: {round: [{mg, r}]}}
  for (const mg of Object.values(race.motogroups || {})) {
    const rname = Object.keys(mg.round || {})[0] || 'Moto';
    const acId = mg.ageclass_id;
    if (!acById[acId]) continue;
    // Every moto posted for each class round, riders listed yet or not.
    ((roundMotos[acId] = roundMotos[acId] || {})[rname] = roundMotos[acId][rname] || []).push(mg.name);
    for (const r of Object.values(mg.riders || {})) {
      const serial = String(r.serial_number || '').trim();
      ((present[acId] = present[acId] || {})[rname] = present[acId][rname] || new Set()).add(serial);
      let rider = bySerial[serial] || byName[normName(`${r.first_name}${r.last_name}`)];
      if (!rider && /next\s*level/i.test(r.sponsor || '')) {
        const nm = `${r.first_name} ${r.last_name}`.trim().toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
        rider = { id: `x${serial}`, name: nm, serial, guest: true };
        bySerial[serial] = rider;
      }
      if (!rider) continue;
      const hk = `${rider.id}|${acId}`;
      const h = hits[hk] = hits[hk] || { rider, acId, serial, groups: {} };
      (h.groups[rname] = h.groups[rname] || []).push({ mg, r });
    }
  }

  const entries = {}, results = {};
  for (const h of Object.values(hits)) {
    const ac = acById[h.acId];
    const type = raceType(ac.name);
    const motoRound = ac.rounds.find(x => x.name === 'Moto') || ac.rounds[0] || {};
    const order = ac.rounds.map(x => x.name);
    const nextOf = name => order[order.indexOf(name) + 1];
    const posted = name => !!(name && present[h.acId]?.[name]?.size);
    const inRound = name => !!(name && present[h.acId]?.[name]?.has(h.serial));

    const e = entries[h.rider.id] = entries[h.rider.id] ||
      { id: h.rider.id, name: h.rider.name, guest: !!h.rider.guest, races: {} };
    if (e.races[type]) continue; // two classes of the same type in one day: keep the first

    const motos = (h.groups.Moto || []).sort((a, b) => numSort(a.mg.name, b.mg.name));
    const lane = i => motos.map(x => Number(x.r[`lane_${i}`]) || 0).find(Boolean) || 0;
    const fin = i => motos.map(x => x.r[`finish_${i}`]).map(v => parseInt(v, 10)).find(n => n > 0) || 0;
    const rule = motoRound.transfer_description || '';
    const tp = /^total points/i.test(rule);
    const rc = {
      cls: ac.name, code: classCode(ac.name), rule, tp,
      count: motoRound.rider_count || 0,
      num: motos.map(x => x.mg.name).join(' · '),
      gates: [lane(1), lane(2), lane(3)],
    };
    // Later rounds: real moto number once posted, a placeholder before that.
    for (const rn of order.slice(order.indexOf('Moto') + 1)) {
      const k = roundKey[rn];
      if (!k) continue;
      const g = (h.groups[rn] || [])[0];
      // Not placed in that round yet: still show the class's posted moto number(s).
      const all = [...new Set(roundMotos[h.acId]?.[rn] || [])].sort(numSort);
      rc[k] = g ? { num: g.mg.name, gate: Number(g.r.lane_1) || 0 } : { num: all.join('/'), gate: 0 };
    }
    e.races[type] = rc;

    // Results the live site has for this rider.
    const id = h.rider.id;
    const nextMoto = nextOf('Moto');
    const mres = {};
    // Small classes (8 or fewer) can have the main posted before anyone races,
    // so being in the next round only means a transfer once motos have results.
    const roundRun = n => motos.some(x => Object.values(x.mg.riders || {}).some(o => parseInt(o[`finish_${n}`], 10) > 0));
    if (tp) {
      mres.p1 = fin(1); mres.p2 = fin(2); mres.p3 = fin(3);
      // Plain "Total Points": the whole class races the main, so there is no transfer.
      const tpAll = !/\bto\b/i.test(rule);
      if (!tpAll && posted(nextMoto) && (mres.p1 || mres.p2 || mres.p3)) mres.out = inRound(nextMoto) ? 'T' : 'OUT';
    } else if (motos.length) {
      const rd2Run = roundRun(2);
      if (fin(1)) mres.out = 'T1';
      else if (fin(2)) mres.out = 'T2';
      else if (inRound(nextMoto) && roundRun(1)) mres.out = 'T';
      else if ((posted(nextMoto) && roundRun(1)) || rd2Run) mres.out = 'OUT';
      else if (roundRun(1)) mres.out = 'R2'; // raced round 1 without transferring
    }
    if (mres.out || mres.p1) results[`${id}|${type}`] = mres;

    for (const rn of ['Qtr', 'Semi']) {
      const g = (h.groups[rn] || [])[0];
      if (!g) continue;
      const nx = nextOf(rn);
      const f = parseInt(g.r.finish_1, 10) || 0;
      const roundInfo = ac.rounds.find(x => x.name === rn) || {};
      let out = '';
      if (posted(nx)) out = inRound(nx) ? 'T' : 'OUT';
      else if (f) out = f <= (transferN(roundInfo.transfer_description) || 4) ? 'T' : 'OUT';
      if (out) results[`${id}|${type}${roundKey[rn]}`] = { out };
    }
    const mg = (h.groups.Main || [])[0];
    const mf = mg ? parseInt(mg.r.finish_1, 10) || 0 : 0;
    if (mf) results[`${id}|${type}M`] = { p1: mf };
  }

  return {
    eventName: feed.event_name || '', publishAt: feed.publish_at || '', publishUntil: feed.publish_until || '',
    raceId: race.id, raceName: (race.name || '').trim(),
    races: races.map(r => ({ id: r.id, name: (r.name || '').trim() })),
    entries, results,
  };
}
// FEED-PARSER-END

/* ---------- roles ---------- */

async function whoAmI(gid, session) {
  if (!verifySession(gid, session)) { const e = new Error('Session invalid.'); e.code = 401; throw e; }
  const me = await getTask(gid);
  return {
    gid, name: me.name,
    admin: (me.fields.IS_ADMIN || '').toLowerCase() === 'true',
    helper: (me.fields.RACE_HELPER || '').toLowerCase() === 'true',
  };
}
const deny = msg => { const e = new Error(msg); e.code = 403; return e; };

const TYPES = ['open', 'cruiser', 'class'];
const cleanTypes = arr => TYPES.filter(t => (arr || []).map(x => String(x).toLowerCase()).includes(t));
const KEY_RE = /^[x0-9]+\|(open|cruiser|class)[QSM]?$/;

function cleanValue(v = {}) {
  const out = {};
  if (['T', 'T1', 'T2', 'R2', 'OUT'].includes(v.out)) out.out = v.out;
  for (const p of ['p1', 'p2', 'p3']) {
    const n = parseInt(v[p], 10);
    if (n >= 1 && n <= 8) out[p] = n;
  }
  return out;
}

/* ---------- handler ---------- */

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!TOKEN) return res.status(500).json({ error: 'ASANA_TOKEN is not configured.' });
  const body = req.body || {};
  const action = body.action || req.query.action || '';

  try {
    const me = await whoAmI(body.gid, body.session);
    const days = allDays();
    const dayKey = body.day === TEST_DAY.key && me.admin ? TEST_DAY.key
      : (days.some(d => d.key === body.day) ? body.day : defaultDayKey());
    const day = dayKey === TEST_DAY.key ? TEST_DAY : days.find(d => d.key === dayKey);

    switch (action) {

      case 'state': {
        const dayTasks = await listSection(await raceDaySection());
        const task = dayTasks.find(t => t.name === `RACEDAY: ${dayKey}`) || null;
        const f = task?.fields || {};
        // Last season plus finalized days before this one, oldest first.
        const { rows: season, days: finalDays } = seasonHistory(dayTasks, dayKey);
        const history = JSON.parse(JSON.stringify(HISTORY_2026));
        for (const [id, types] of Object.entries(season)) {
          for (const [type, rows] of Object.entries(types)) {
            ((history[id] = history[id] || {})[type] = history[id][type] || []).push(...rows);
          }
        }
        // Everyone gets each rider's last race per class (for the IMPROVED box).
        const last = {};
        for (const [id, types] of Object.entries(history)) {
          for (const [type, rows] of Object.entries(types)) if (rows.length) last[`${id}|${type}`] = rows[rows.length - 1];
        }
        const { logs, acks } = task ? await readLogs(task.gid) : { logs: {}, acks: {} };
        const out = {
          me: { admin: me.admin, helper: me.helper || me.admin },
          days: me.admin ? [...days, TEST_DAY] : days,
          day,
          loaded: !!f.MOTOS_JSON,
          entries: jparse(f.MOTOS_JSON, {}),
          feed: jparse(f.FEED_JSON, {}),
          logs, acks, last,
        };
        if (me.admin || me.helper) {
          out.updated = f.UPDATED || '';
          out.eventName = f.EVENT_NAME || '';
        }
        if (me.admin) {
          const riders = await listSection(SEC_RIDERS);
          out.picks = jparse(f.PICKS_JSON, { s1: [], s2: [] });
          out.locked = (f.LOCKED || '').toLowerCase() === 'true';
          out.dayClasses = jparse(f.CLASSES_JSON, {});
          // Pick predictions: last season plus this season's finished days.
          out.historyDays = finalDays;
          out.final = jparse(f.FINAL_JSON, null);
          out.history = history;
          out.roster = riders
            .filter(r => r.fields.RACE_CLASSES !== undefined || DEFAULT_CLASSES[r.gid])
            .map(r => ({
              id: r.gid, name: r.name,
              proficiency: r.fields.PROFICIENCY || '',
              dob: r.fields.DOB || '',
              classes: cleanTypes(String(r.fields.RACE_CLASSES ?? DEFAULT_CLASSES[r.gid] ?? '').split(',')),
            }));
        }
        return res.json(out);
      }

      case 'update': {
        if (!me.admin && !me.helper) throw deny('Only Michelle and Race Day helpers can load motos.');
        // The phone sends the feed when the USA BMX site will not answer the server.
        let feed = body.feed && typeof body.feed === 'object' ? body.feed : null;
        if (!feed) {
          let fr = null;
          try { fr = await fetch(FEED_URL, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (NextLevelBMX TeamHub)' } }); }
          catch { fr = null; }
          if (!fr || !fr.ok) {
            return res.status(502).json({ error: 'The USA BMX live site did not answer the server.', feedBlocked: true });
          }
          feed = await fr.json();
        }
        if (!feed.races) return res.status(409).json({ error: 'The USA BMX live site has no motos posted right now.' });
        if (!day.test && feed.publish_until) {
          const until = new Date(feed.publish_until);
          if (until < new Date(`${day.date}T00:00:00-05:00`)) {
            return res.status(409).json({
              error: `Motos for this race aren't posted yet. The live site still shows ${String(feed.event_name || 'the last race').trim()}.`,
            });
          }
        }
        const task = await findDayTask(dayKey, true);
        const riders = (await listSection(SEC_RIDERS)).map(r => ({
          id: r.gid, name: r.name, serial: r.fields.USABMX || '',
        }));
        const parsed = parseFeed(feed, riders, { day: day.day, raceId: body.raceId || task.fields.FEED_RACE || '' });
        if (parsed.error) return res.status(409).json({ error: parsed.error });
        const now = new Date().toISOString();
        await patchTask(task.gid, {
          MOTOS_JSON: jline(parsed.entries),
          FEED_JSON: jline(parsed.results),
          UPDATED: now,
          EVENT_NAME: `${parsed.eventName} · ${parsed.raceName}`.replace(/\s+/g, ' '),
          FEED_RACE: parsed.raceId,
        });
        return res.json({
          ok: true, updated: now, riders: Object.keys(parsed.entries).length,
          races: parsed.races, raceId: parsed.raceId,
        });
      }

      case 'log':
      case 'ack': {
        const { key } = body;
        if (!KEY_RE.test(String(key || ''))) return res.status(400).json({ error: 'Bad race key.' });
        const task = await findDayTask(dayKey, false);
        if (!task) return res.status(409).json({ error: 'Motos are not loaded for this day yet.' });
        const entry = action === 'log'
          ? { k: key, v: cleanValue(body.value), n: me.name }
          : { k: key, ack: jline(cleanValue(body.live)), n: me.name };
        await addLog(task.gid, entry);
        return res.json({ ok: true });
      }

      case 'picks': {
        if (!me.admin) throw deny('Admins only.');
        const task = await findDayTask(dayKey, true);
        if ((task.fields.LOCKED || '').toLowerCase() === 'true') {
          return res.status(409).json({ error: 'Team sheets are locked for this day. Unlock to change picks.' });
        }
        const clean = list => (Array.isArray(list) ? list : []).slice(0, 6)
          .filter(p => p && /^[x0-9]+$/.test(p.id) && TYPES.includes(p.type))
          .map(p => ({ id: p.id, type: p.type }));
        const picks = { s1: clean(body.picks?.s1), s2: clean(body.picks?.s2) };
        await patchTask(task.gid, { PICKS_JSON: jline(picks) });
        return res.json({ ok: true, picks });
      }

      // Freeze the day's team scores as shown on the Team Sheets page (or clear them).
      case 'finalize': {
        if (!me.admin) throw deny('Admins only.');
        const task = await findDayTask(dayKey, true);
        if (!body.final) {
          await patchTask(task.gid, { FINAL_JSON: '' });
          return res.json({ ok: true, final: null });
        }
        const STATES = ['scored', 'dnq', 'none', 'nolevel', 'pending'];
        const num = (v, max) => Math.max(0, Math.min(max, parseInt(v, 10) || 0));
        const scores = {};
        for (const [k, v] of Object.entries(body.final.scores || {})) {
          if (!/^[x0-9]+\|(open|cruiser|class)$/.test(k) || !v) continue;
          scores[k] = {
            state: STATES.includes(v.state) ? v.state : 'pending',
            count: num(v.count, 200), place: num(v.place, 8), fp: num(v.fp, 100), pts: num(v.pts, 400),
            code: String(v.code || '').slice(0, 20),
          };
        }
        const final = {
          at: new Date().toISOString(), by: (me.name || '').split(' ')[0],
          scores, totals: { s1: num(body.final.totals?.s1, 2000), s2: num(body.final.totals?.s2, 2000) },
        };
        await patchTask(task.gid, { FINAL_JSON: jline(final) });
        return res.json({ ok: true, final });
      }

      case 'lock': {
        if (!me.admin) throw deny('Admins only.');
        const task = await findDayTask(dayKey, true);
        await patchTask(task.gid, { LOCKED: body.locked ? 'true' : 'false' });
        return res.json({ ok: true, locked: !!body.locked });
      }

      case 'classes': {
        if (!me.admin) throw deny('Admins only.');
        const { riderId, types, scope } = body;
        const list = cleanTypes(types);
        if (scope === 'season') {
          await patchTask(riderId, { RACE_CLASSES: list.join(',') });
        } else {
          const task = await findDayTask(dayKey, true);
          const dc = jparse(task.fields.CLASSES_JSON, {});
          dc[riderId] = list;
          await patchTask(task.gid, { CLASSES_JSON: jline(dc) });
        }
        return res.json({ ok: true });
      }

      case 'helpers': {
        if (!me.admin) throw deny('Admins only.');
        const [riders, parents] = await Promise.all([listSection(SEC_RIDERS), listSection(SEC_PARENTS)]);
        const ids = [...riders, ...parents]
          .filter(t => (t.fields.RACE_HELPER || '').toLowerCase() === 'true').map(t => t.gid);
        return res.json({ helpers: ids });
      }

      case 'setHelper': {
        if (!me.admin) throw deny('Admins only.');
        await patchTask(body.targetGid, { RACE_HELPER: body.on ? 'true' : 'false' });
        return res.json({ ok: true });
      }

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error('[raceday]', action, err);
    return res.status(err.code || 500).json({ error: err.message || 'Server error' });
  }
}
