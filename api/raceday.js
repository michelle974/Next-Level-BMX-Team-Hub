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

  const present = {};   // acId -> roundName -> Set(serial)
  const hits = {};      // riderId|acId -> {rider, acId, groups: {round: [{mg, r}]}}
  for (const mg of Object.values(race.motogroups || {})) {
    const rname = Object.keys(mg.round || {})[0] || 'Moto';
    const acId = mg.ageclass_id;
    if (!acById[acId]) continue;
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
      rc[k] = g ? { num: g.mg.name, gate: Number(g.r.lane_1) || 0 } : { num: '', gate: 0 };
    }
    e.races[type] = rc;

    // Results the live site has for this rider.
    const id = h.rider.id;
    const nextMoto = nextOf('Moto');
    const mres = {};
    if (tp) {
      mres.p1 = fin(1); mres.p2 = fin(2); mres.p3 = fin(3);
      if (posted(nextMoto)) mres.out = inRound(nextMoto) ? 'T' : 'OUT';
    } else if (motos.length) {
      const rd2Run = motos.some(x => Object.values(x.mg.riders || {}).some(o => parseInt(o.finish_2, 10) > 0));
      if (fin(1)) mres.out = 'T1';
      else if (fin(2)) mres.out = 'T2';
      else if (inRound(nextMoto)) mres.out = 'T';
      else if (posted(nextMoto) || rd2Run) mres.out = 'OUT';
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
  if (['T', 'T1', 'T2', 'OUT'].includes(v.out)) out.out = v.out;
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
        const task = await findDayTask(dayKey, false);
        const f = task?.fields || {};
        const { logs, acks } = task ? await readLogs(task.gid) : { logs: {}, acks: {} };
        const out = {
          me: { admin: me.admin, helper: me.helper || me.admin },
          days: me.admin ? [...days, TEST_DAY] : days,
          day,
          loaded: !!f.MOTOS_JSON,
          entries: jparse(f.MOTOS_JSON, {}),
          feed: jparse(f.FEED_JSON, {}),
          logs, acks,
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
          out.roster = riders
            .filter(r => r.fields.RACE_CLASSES !== undefined || DEFAULT_CLASSES[r.gid])
            .map(r => ({
              id: r.gid, name: r.name,
              proficiency: r.fields.PROFICIENCY || '',
              classes: cleanTypes(String(r.fields.RACE_CLASSES ?? DEFAULT_CLASSES[r.gid] ?? '').split(',')),
            }));
        }
        return res.json(out);
      }

      case 'update': {
        if (!me.admin && !me.helper) throw deny('Only Michelle and Race Day helpers can load motos.');
        const fr = await fetch(FEED_URL, { headers: { Accept: 'application/json' } });
        if (!fr.ok) throw new Error(`The USA BMX live site did not answer (${fr.status}). Try again in a minute.`);
        const feed = await fr.json();
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
