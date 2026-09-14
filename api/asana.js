// Next Level BMX Team Hub — Asana backend proxy
// Tokens live in Vercel env vars and never reach the browser.
// All operations are scoped to the Team Hub project.

import crypto from 'crypto';

const ASANA = 'https://app.asana.com/api/1.0';
const TOKEN = process.env.ASANA_TOKEN;
const SECRET = process.env.SESSION_SECRET || 'nlbmx-dev-secret-change-me';
const ZEFFY_KEY = process.env.ZEFFY_API_KEY;
const ZEFFY = 'https://api.zeffy.com/api/v1';

const PROJECT_GID = process.env.HUB_PROJECT_GID || '1217616477503428';
const SECTIONS = {
  riders:  process.env.SEC_RIDERS  || '1217616432345566',
  parents: process.env.SEC_PARENTS || '1217629407873450',
  tiles:   process.env.SEC_TILES   || '1217616481671348',
  signups: process.env.SEC_SIGNUPS || '1217629408209469',
  config:  process.env.SEC_CONFIG  || '1217629408316937',
  rsvps:   process.env.SEC_RSVPS   || '1218431788865096',
};

/* ---------- asana helpers ---------- */

async function asana(path, opts = {}, retries = 2) {
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
      return json.data;
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 400));
    }
  }
}

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

/* Parse color palette / keyword rules / overrides from the Schedule tile's fields.
   Fields look like:
     COLOR_GREEN: #38f100
     KEYWORD_TRAINING: GREEN
     OVERRIDE_1: 2026-10-16 Oldsmar = ORANGE
     COLOR_DEFAULT: GREY            (optional; defaults to GREY) */
function parseScheduleColors(fields = {}) {
  const palette = {}, keywords = {}, overrides = [];
  let def = 'GREY';
  for (const [k, v] of Object.entries(fields)) {
    if (k.startsWith('COLOR_')) {
      const name = k.slice(6);
      if (name === 'DEFAULT') { def = String(v).trim().toUpperCase(); }
      else { palette[name] = String(v).trim(); }
    } else if (k.startsWith('KEYWORD_')) {
      keywords[k.slice(8).toLowerCase()] = String(v).trim().toUpperCase();
    } else if (k.startsWith('OVERRIDE_')) {
      // "2026-10-16 Oldsmar = ORANGE"  or  "Oldsmar = ORANGE"
      const eq = String(v).lastIndexOf('=');
      if (eq === -1) continue;
      const left = v.slice(0, eq).trim();
      const code = v.slice(eq + 1).trim().toUpperCase();
      const m = left.match(/^(\d{4}-\d{2}-\d{2})\s+(.*)$/);
      overrides.push(m ? { date: m[1], title: m[2].trim(), code }
                       : { date: '', title: left, code });
    }
  }
  return { palette, keywords, overrides, default: def };
}

const signSession = gid =>
  crypto.createHmac('sha256', SECRET).update(`sess:${gid}`).digest('hex');

function verifySession(gid, sig) {
  if (!gid || !sig) return false;
  const a = Buffer.from(String(sig));
  const b = Buffer.from(signSession(gid));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const normName = n => String(n || '').toLowerCase().replace(/[^a-z]/g, '');

function nameSimilarity(a, b) {
  a = normName(a); b = normName(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.startsWith(b) || b.startsWith(a)) return 0.85;
  const short = a.length < b.length ? a : b;
  const long = a.length < b.length ? b : a;
  let hits = 0;
  for (const ch of new Set(short)) if (long.includes(ch)) hits++;
  return (hits / new Set(short).size) * 0.6;
}

const splitIds = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);

/* ---------- jersey helpers ---------- */

const JERSEY_SIZES_DEFAULT =
  'YXXS,YXS,YS,YM,YL,YXL,YXXL,S,M,L,XL,2XL,3XL,4XL';

// Notes are one KEY: value per line, so a stored value may never contain a
// newline, and the extra-jersey rows are pipe delimited.
const cleanVal = (v, max) =>
  String(v ?? '').replace(/[\r\n|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 60).trim();

const cleanNum = v => String(v ?? '').replace(/[^0-9]/g, '').slice(0, 12);

// JERSEY_EXTRA_1: AL | 239 | STEVENSON | 2
function parseExtras(fields = {}) {
  const rows = [];
  for (const [k, v] of Object.entries(fields)) {
    const m = /^JERSEY_EXTRA_(\d+)$/.exec(k);
    if (!m) continue;
    const parts = String(v).split('|').map(x => x.trim());
    if (!parts[0]) continue;
    rows.push({
      i: parseInt(m[1], 10),
      size: parts[0] || '',
      number: parts[1] || '',
      name: parts[2] || '',
      qty: Math.min(99, Math.max(1, parseInt(parts[3] || '1', 10) || 1)),
    });
  }
  return rows.sort((a, b) => a.i - b.i).map(({ i, ...rest }) => rest);
}

// Replaces every JERSEY_EXTRA_n on a task. Keys set to undefined are dropped
// by buildNotes, which is how a removed row actually leaves the notes.
function extrasUpdate(existingFields, extras) {
  const out = {};
  const had = Object.keys(existingFields).filter(k => /^JERSEY_EXTRA_\d+$/.test(k)).length;
  for (let i = 0; i < Math.max(had, extras.length); i++) {
    const e = extras[i];
    out[`JERSEY_EXTRA_${i + 1}`] = e
      ? `${e.size} | ${e.number} | ${e.name} | ${e.qty}`
      : undefined;
  }
  return out;
}

const jerseyOf = f => ({
  jerseySize: f.JERSEY_SIZE || '',
  jerseyNumber: f.JERSEY_NUMBER || '',
  jerseyName: f.JERSEY_NAME || '',
  jerseyQty: Math.min(99, Math.max(1, parseInt(f.JERSEY_QTY || '1', 10) || 1)),
  jerseyStatus: f.JERSEY_STATUS || 'Not Started',
});

async function listSection(sectionGid) {
  const tasks = await asana(
    `/sections/${sectionGid}/tasks?opt_fields=name,notes,completed&limit=100`);
  return (tasks || []).map(t => ({
    gid: t.gid, name: t.name, completed: t.completed,
    fields: parseNotes(t.notes || ''),
  }));
}

async function createInSection(sectionGid, name, fields) {
  const task = await asana('/tasks', {
    method: 'POST',
    body: JSON.stringify({ data: { name, notes: buildNotes(fields), projects: [PROJECT_GID] } }),
  });
  await asana(`/sections/${sectionGid}/addTask`, {
    method: 'POST',
    body: JSON.stringify({ data: { task: task.gid } }),
  });
  return task.gid;
}

async function assertInProject(gid) {
  const t = await asana(`/tasks/${gid}?opt_fields=projects,notes,name`);
  if (!(t.projects || []).some(p => p.gid === PROJECT_GID)) {
    throw new Error('Task is outside the Team Hub project');
  }
  return t;
}

async function patchTask(gid, updates) {
  const t = await assertInProject(gid);
  const merged = { ...parseNotes(t.notes || ''), ...updates };
  await asana(`/tasks/${gid}`, {
    method: 'PUT',
    body: JSON.stringify({ data: { notes: buildNotes(merged) } }),
  });
  return merged;
}

async function requireAdmin(gid, session) {
  if (!verifySession(gid, session)) {
    const e = new Error('Session invalid.'); e.code = 401; throw e;
  }
  const me = await assertInProject(gid);
  if ((parseNotes(me.notes || '').IS_ADMIN || '').toLowerCase() !== 'true') {
    const e = new Error('Admins only.'); e.code = 403; throw e;
  }
  return me;
}

// Can this logged-in user (callerGid) set RSVP/paid status for riderGid?
// Admins can manage anyone; everyone else only their own linked rider(s) or themselves.
async function canManageRider(callerGid, riderGid) {
  const me = await assertInProject(callerGid);
  const f = parseNotes(me.notes || '');
  if ((f.IS_ADMIN || '').toLowerCase() === 'true') return true;
  if (riderGid === callerGid) return true;
  if (splitIds(f.LINKED_RIDERS).includes(riderGid)) return true;
  return false;
}

// One Asana task per Google Calendar event, keyed by EVENT_ID (+ EVENT_DATE for
// recurring events sharing the same series id). Created on first RSVP.
async function findRsvpTask(eventId) {
  const tasks = await listSection(SECTIONS.rsvps);
  return tasks.find(t => t.fields.EVENT_ID === eventId) || null;
}

async function findOrCreateRsvpTask(eventId, eventDate, eventTitle) {
  const existing = await findRsvpTask(eventId);
  if (existing) return existing;
  const gid = await createInSection(SECTIONS.rsvps, eventTitle || 'Event', {
    EVENT_ID: eventId, EVENT_DATE: eventDate || '',
  });
  return { gid, name: eventTitle || 'Event', fields: { EVENT_ID: eventId, EVENT_DATE: eventDate || '' } };
}

async function getConfig() {
  const cfgTasks = await listSection(SECTIONS.config);
  const cfg = {};
  let agreementRaw = '';
  for (const c of cfgTasks) {
    Object.assign(cfg, c.fields);
    if (c.name.startsWith('CONFIG: Agreement Text')) {
      const raw = await asana(`/tasks/${c.gid}?opt_fields=notes`);
      const parts = (raw.notes || '').split('---');
      agreementRaw = parts.length > 1 ? parts.slice(1).join('---').trim() : '';
    }
  }
  return { cfg, agreementRaw };
}

const publicUser = (t, f) => ({
  gid: t.gid, name: t.name,
  role: f.ROLE || 'RIDER',
  email: f.EMAIL || '',
  isAdmin: (f.IS_ADMIN || '').toLowerCase() === 'true',
});

/* ---------- zeffy ---------- */

async function zeffy(path) {
  if (!ZEFFY_KEY) throw new Error('Zeffy API key is not configured.');
  const res = await fetch(`${ZEFFY}${path}`, {
    headers: { Authorization: `Bearer ${ZEFFY_KEY}` },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.message || `Zeffy ${res.status}`);
  return json;
}

// Look for a completed payment matching this email on the configured campaign.
// usedIds excludes payments already consumed to verify a different rider —
// without this, one payment (e.g. a parent's) can verify every sibling that
// shares that email.
async function findZeffyPayment(email, campaignId, usedIds = new Set()) {
  if (!email) return null;
  const target = String(email).trim().toLowerCase();
  let page = 1;
  while (page <= 5) {
    const data = await zeffy(`/payments?limit=100&page=${page}`);
    const rows = data?.data || data?.payments || (Array.isArray(data) ? data : []);
    if (!rows.length) break;
    for (const p of rows) {
      const payer = String(
        p.email || p.buyerEmail || p.contact?.email || p.buyer?.email || ''
      ).trim().toLowerCase();
      if (payer !== target) continue;
      if (campaignId) {
        const cid = String(p.campaignId || p.campaign?.id || p.campaign?.gid || '');
        if (cid && cid !== String(campaignId)) continue;
      }
      const status = String(p.status || 'succeeded').toLowerCase();
      if (['failed', 'refunded', 'canceled', 'cancelled'].includes(status)) continue;
      const id = p.id || p.paymentId || '';
      if (id && usedIds.has(id)) continue; // already applied to another rider
      return {
        id,
        amount: p.amount ?? p.totalAmount ?? '',
        date: p.createdAt || p.date || '',
      };
    }
    page++;
  }
  return null;
}

async function markPaid(riderGid, ref) {
  return patchTask(riderGid, {
    PAYMENT_STATUS: 'Paid',
    PAID_DATE: new Date().toISOString().slice(0, 10),
    PAYMENT_REF: ref || 'manual',
  });
}

// USED_PAYMENTS lives on the "CONFIG: Payment" task as a comma-separated list
// of Zeffy payment IDs that have already verified a rider. Recording/releasing
// here (rather than trusting per-rider state) means it works no matter which
// rider's checkPayment call happens to run first.
async function recordUsedPayment(paymentId) {
  if (!paymentId) return;
  const cfgTasks = await listSection(SECTIONS.config);
  const pay = cfgTasks.find(c => c.name === 'CONFIG: Payment');
  if (!pay) return; // fail open — don't block the payment flow over bookkeeping
  const used = new Set(splitIds(pay.fields.USED_PAYMENTS));
  if (used.has(paymentId)) return;
  used.add(paymentId);
  await patchTask(pay.gid, { USED_PAYMENTS: [...used].join(',') });
}

// Frees a payment ID back up, e.g. when an admin manually reverses a Paid
// status that had been set from a real Zeffy match (not a manual override).
async function releaseUsedPayment(paymentId) {
  if (!paymentId || paymentId.startsWith('manual')) return;
  const cfgTasks = await listSection(SECTIONS.config);
  const pay = cfgTasks.find(c => c.name === 'CONFIG: Payment');
  if (!pay) return;
  const used = new Set(splitIds(pay.fields.USED_PAYMENTS));
  if (!used.has(paymentId)) return;
  used.delete(paymentId);
  await patchTask(pay.gid, { USED_PAYMENTS: [...used].join(',') });
}

/* ---------- handler ---------- */

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!TOKEN) return res.status(500).json({ error: 'ASANA_TOKEN is not configured.' });

  const action = (req.method === 'GET' ? req.query.action : req.body?.action) || '';
  const body = req.body || {};

  try {
    switch (action) {

      /* ----- bootstrap ----- */
      case 'bootstrap': {
        const [tiles, { cfg, agreementRaw }] = await Promise.all([
          listSection(SECTIONS.tiles),
          getConfig(),
        ]);
        const scheduleTile = tiles.find(t => t.name.replace(/^TILE:\s*/, '') === 'Schedule');
        const scheduleColors = parseScheduleColors(scheduleTile?.fields || {});
        return res.json({
          tiles: tiles.filter(t => t.name.startsWith('TILE:')).map(t => ({
            gid: t.gid,
            label: t.name.replace(/^TILE:\s*/, ''),
            icon: t.fields.ICON_URL || '',
            link: t.fields.LINK || '',
            visibility: (t.fields.VISIBILITY || 'public').toLowerCase(),
            order: parseInt(t.fields.ORDER ?? '99', 10),
            sub: {
              gear: t.fields.SUBLINK_GEAR || '',
              jerseys: t.fields.SUBLINK_JERSEYS || '',
              plates: t.fields.SUBLINK_PLATES || '',
            },
          })).sort((a, b) => a.order - b.order),
          config: {
            seasonDates: cfg.SEASON_DATES || '',
            season: cfg.SEASON || '',
            teamFee: cfg.TEAM_OPERATIONS_FEE || '',
            feeAmount: cfg.FEE_AMOUNT || '100',
            payUrl: cfg.ZEFFY_CAMPAIGN_URL || '',
            verifyHours: parseInt(cfg.VERIFY_TIMEOUT_HOURS || '24', 10),
            scheduleColors,
            jersey: {
              open: (cfg.JERSEY_ORDER_OPEN || 'true').toLowerCase() !== 'false',
              deadline: cfg.JERSEY_DEADLINE || '',
              price: parseFloat(cfg.JERSEY_PRICE || '25') || 0,
              nameMax: parseInt(cfg.JERSEY_NAME_MAX || '0', 10),
              heading: cfg.JERSEY_HEADING || 'Jersey Sizing',
              sub: cfg.JERSEY_SUB || '',
              sizes: (cfg.JERSEY_SIZES || JERSEY_SIZES_DEFAULT)
                .split(',').map(x => x.trim()).filter(Boolean),
            },
            formText: {
              step1Heading: cfg.STEP1_HEADING || '',
              step1Sub: cfg.STEP1_SUB || '',
              step1Body: cfg.STEP1_BODY || '',
              step2Heading: cfg.STEP2_HEADING || '',
              step2Sub: cfg.STEP2_SUB || '',
              step3Heading: cfg.STEP3_HEADING || '',
              step3Sub: cfg.STEP3_SUB || '',
              step4Heading: cfg.STEP4_HEADING || '',
              step4Sub: cfg.STEP4_SUB || '',
            },
          },
          agreement: agreementRaw,
        });
      }

      /* ----- auth ----- */
      case 'signup': {
        const { name, email, phone, role, dob, pin, riderNames } = body;
        if (!name || !email || !pin || !role) {
          return res.status(400).json({ error: 'Missing required fields.' });
        }
        const [riders, parents] = await Promise.all([
          listSection(SECTIONS.riders), listSection(SECTIONS.parents),
        ]);
        if ([...riders, ...parents].some(
          t => (t.fields.EMAIL || '').toLowerCase() === email.toLowerCase())) {
          return res.status(409).json({ error: 'That email already has an account.' });
        }

        // Account fields only. FORM_STATUS is deliberately NOT included here —
        // writing it would wipe a form a parent already completed for this rider.
        const account = {
          EMAIL: email,
          PHONE: phone || '',
          PIN: String(pin),
          ROLE: role,
          CREATED: new Date().toISOString().slice(0, 10),
        };
        const freshDefaults = {
          PHONE_PUBLIC: 'true',
          EMAIL_PUBLIC: 'true',
          FORM_STATUS: 'Not Started',
          PAYMENT_STATUS: 'Unpaid',
        };

        let gid;
        const linked = [], pending = [];

        if (role === 'RIDER' || role === 'BOTH') {
          const existing = riders.find(r => normName(r.name) === normName(name));
          if (existing && !existing.fields.EMAIL) {
            gid = existing.gid;
            await patchTask(gid, { ...account, ...(dob ? { DOB: dob } : {}) });
          } else {
            gid = await createInSection(SECTIONS.riders, name,
              { ...freshDefaults, ...account, DOB: dob || '' });
          }
        } else {
          gid = await createInSection(SECTIONS.parents, name,
            { ...freshDefaults, ...account });
        }

        if ((role === 'PARENT' || role === 'BOTH') && Array.isArray(riderNames)) {
          for (const rn of riderNames.filter(Boolean)) {
            const exact = riders.find(r => normName(r.name) === normName(rn));
            if (exact) {
              linked.push({ gid: exact.gid, name: exact.name });
              const cur = splitIds(exact.fields.LINKED_PARENTS);
              if (!cur.includes(gid)) cur.push(gid);
              await patchTask(exact.gid, { LINKED_PARENTS: cur.join(', ') });
              continue;
            }
            const fuzzy = riders
              .map(r => ({ r, score: nameSimilarity(r.name, rn) }))
              .filter(x => x.score >= 0.7)
              .sort((a, b) => b.score - a.score)[0];
            if (fuzzy) {
              pending.push({ typed: rn, suggested: fuzzy.r.name });
              await patchTask(gid, { PENDING_MATCH: `${rn} -> ${fuzzy.r.name}` });
            } else {
              const newGid = await createInSection(SECTIONS.riders, rn, {
                ...freshDefaults, LINKED_PARENTS: gid, CREATED: account.CREATED,
              });
              linked.push({ gid: newGid, name: rn });
            }
          }
          if (linked.length) {
            await patchTask(gid, { LINKED_RIDERS: linked.map(l => l.gid).join(', ') });
          }
        }

        return res.json({
          user: { gid, name, role, email, isAdmin: false },
          session: signSession(gid), linked, pending,
        });
      }

      case 'login': {
        const { email, pin } = body;
        const [riders, parents] = await Promise.all([
          listSection(SECTIONS.riders), listSection(SECTIONS.parents),
        ]);
        const found = [...riders, ...parents].find(
          t => (t.fields.EMAIL || '').toLowerCase() === String(email || '').toLowerCase());
        if (!found || String(found.fields.PIN || '') !== String(pin)) {
          return res.status(401).json({ error: 'Email or PIN is incorrect.' });
        }
        return res.json({
          user: publicUser(found, found.fields),
          session: signSession(found.gid),
        });
      }

      case 'me': {
        const { gid, session } = body;
        if (!verifySession(gid, session)) return res.status(401).json({ error: 'Session invalid.' });
        const t = await assertInProject(gid);
        const fields = parseNotes(t.notes || '');
        delete fields.PIN;
        return res.json({ user: publicUser(t, parseNotes(t.notes || '')), fields });
      }

      /* ----- roster ----- */
      case 'roster': {
        const { gid, session } = body;
        if (!verifySession(gid, session)) return res.status(401).json({ error: 'Session invalid.' });
        const me = await assertInProject(gid);
        const isAdmin = (parseNotes(me.notes || '').IS_ADMIN || '').toLowerCase() === 'true';

        const [riders, parents] = await Promise.all([
          listSection(SECTIONS.riders), listSection(SECTIONS.parents),
        ]);

        // A BOTH account lives in the Riders section but acts as a parent too.
        // Every parent-side lookup must scan riders + parents, not parents alone.
        const isBoth = t => (t.fields.ROLE || '').toUpperCase() === 'BOTH';
        const parentPool = [...parents, ...riders.filter(isBoth)];

        const show = (f, key) => isAdmin || (f[`${key}_PUBLIC`] || 'true').toLowerCase() !== 'false';

        const list = riders.map(r => {
          const f = r.fields;
          const lp = splitIds(f.LINKED_PARENTS);
          const kids = parentPool
            .filter(p => p.gid !== r.gid &&
              (lp.includes(p.gid) || splitIds(p.fields.LINKED_RIDERS).includes(r.gid)))
            .map(p => ({
              gid: p.gid, name: p.name,
              phone: show(p.fields, 'PHONE') ? p.fields.PHONE || '' : '',
              email: show(p.fields, 'EMAIL') ? p.fields.EMAIL || '' : '',
              pin: isAdmin ? p.fields.PIN || '' : undefined,
            }));

          // For a BOTH account, the riders they are responsible for.
          const mine = splitIds(f.LINKED_RIDERS);
          const kidsOf = !isBoth(r) ? [] : riders
            .filter(x => x.gid !== r.gid &&
              (mine.includes(x.gid) || splitIds(x.fields.LINKED_PARENTS).includes(r.gid)))
            .map(x => ({ gid: x.gid, name: x.name }));

          const entry = {
            gid: r.gid, name: r.name,
            role: (f.ROLE || '').toUpperCase(),
            dob: f.DOB || '', raceNumber: f.RACE_NUMBER || '',
            proficiency: f.PROFICIENCY || '', nickname: f.NICKNAME || '',
            formStatus: f.FORM_STATUS || 'Not Started',
            paymentStatus: f.PAYMENT_STATUS || 'Unpaid',
            ...jerseyOf(f),
            phone: show(f, 'PHONE') ? f.PHONE || '' : '',
            email: show(f, 'EMAIL') ? f.EMAIL || '' : '',
            parents: kids,
            linkedRiders: kidsOf,
          };
          if (isAdmin) {
            entry.usabmx = f.USABMX || '';
            entry.emergencyContact = f.EMERGENCY_NAME || '';
            entry.emergencyPhone = f.EMERGENCY_PHONE || '';
            entry.pendingMatch = f.PENDING_MATCH || '';
            entry.pin = f.PIN || '';
            entry.signedBy = f.SIGNED_BY || '';
            entry.signedDate = f.SIGNED_DATE || '';
          }
          return entry;
        });

        let unlinked = [], pool = [];
        if (isAdmin) {
          unlinked = parentPool.filter(p =>
            !splitIds(p.fields.LINKED_RIDERS).length &&
            !riders.some(r => r.gid !== p.gid && splitIds(r.fields.LINKED_PARENTS).includes(p.gid))
          ).map(p => ({
            gid: p.gid, name: p.name,
            email: p.fields.EMAIL || '', phone: p.fields.PHONE || '',
            pin: p.fields.PIN || '', pendingMatch: p.fields.PENDING_MATCH || '',
            both: isBoth(p),
          }));

          // Everyone who can be linked to a rider as a parent, in one flat list.
          pool = parentPool
            .filter(p => p.fields.PIN)
            .map(p => ({
              gid: p.gid, name: p.name,
              email: p.fields.EMAIL || '', phone: p.fields.PHONE || '',
              both: isBoth(p),
            }));
        }

        return res.json({
          riders: list, unlinked, isAdmin, parentPool: pool,
          riderIndex: riders.map(r => ({ gid: r.gid, name: r.name })),
        });
      }

      case 'updateProfile': {
        const { gid, session, updates } = body;
        if (!verifySession(gid, session)) return res.status(401).json({ error: 'Session invalid.' });
        const allowed = ['PHONE', 'NICKNAME', 'RACE_NUMBER', 'PROFICIENCY', 'DOB',
                         'USABMX', 'EMERGENCY_NAME', 'EMERGENCY_PHONE',
                         'PHONE_PUBLIC', 'EMAIL_PUBLIC', 'PIN'];
        const safe = {};
        for (const [k, v] of Object.entries(updates || {})) if (allowed.includes(k)) safe[k] = v;
        const merged = await patchTask(gid, safe);
        delete merged.PIN;
        return res.json({ ok: true, fields: merged });
      }

      /* ----- forms ----- */
      case 'myRiders': {
        const { gid, session } = body;
        if (!verifySession(gid, session)) return res.status(401).json({ error: 'Session invalid.' });
        const me = await assertInProject(gid);
        const f = parseNotes(me.notes || '');
        const role = f.ROLE || 'RIDER';
        const riders = await listSection(SECTIONS.riders);
        const mine = splitIds(f.LINKED_RIDERS);

        const out = riders
          .filter(r => mine.includes(r.gid) || splitIds(r.fields.LINKED_PARENTS).includes(gid))
          .map(r => ({
            gid: r.gid, name: r.name,
            formStatus: r.fields.FORM_STATUS || 'Not Started',
            paymentStatus: r.fields.PAYMENT_STATUS || 'Unpaid',
            payOpenedAt: r.fields.PAY_OPENED_AT || '',
            ...jerseyOf(r.fields),
            phone: r.fields.PHONE || '',
            email: r.fields.EMAIL || '',
            phonePublic: (r.fields.PHONE_PUBLIC || 'true') !== 'false',
            emailPublic: (r.fields.EMAIL_PUBLIC || 'true') !== 'false',
            self: false,
          }));

        if (role === 'RIDER' || role === 'BOTH') {
          out.unshift({
            gid, name: me.name,
            formStatus: f.FORM_STATUS || 'Not Started',
            paymentStatus: f.PAYMENT_STATUS || 'Unpaid',
            payOpenedAt: f.PAY_OPENED_AT || '',
            ...jerseyOf(f),
            phone: f.PHONE || '',
            email: f.EMAIL || '',
            phonePublic: (f.PHONE_PUBLIC || 'true') !== 'false',
            emailPublic: (f.EMAIL_PUBLIC || 'true') !== 'false',
            self: true,
          });
        }
        return res.json({ riders: out, role, extras: parseExtras(f) });
      }

      case 'updateRiderContact': {
        // Parent updating their linked rider's contact info
        const { gid, session, riderGid, updates } = body;
        if (!verifySession(gid, session)) return res.status(401).json({ error: 'Session invalid.' });
        // Verify this parent is actually linked to this rider
        const me = await assertInProject(gid);
        const mf = parseNotes(me.notes || '');
        const rider = await asana(`/tasks/${riderGid}?opt_fields=gid,name,notes`);
        const rf = parseNotes(rider.notes || '');
        const linkedParents = splitIds(rf.LINKED_PARENTS || '');
        const linkedRiders = splitIds(mf.LINKED_RIDERS || '');
        if (!linkedParents.includes(gid) && !linkedRiders.includes(riderGid)) {
          return res.status(403).json({ error: 'Not authorized to edit this rider.' });
        }
        const allowed = ['PHONE', 'EMAIL', 'PHONE_PUBLIC', 'EMAIL_PUBLIC'];
        const safe = {};
        for (const [k, v] of Object.entries(updates || {})) if (allowed.includes(k)) safe[k] = v;
        await patchTask(riderGid, safe);
        return res.json({ ok: true });
      }

      case 'submitForm': {
        const { gid, session, riderGid, form } = body;
        if (!verifySession(gid, session)) return res.status(401).json({ error: 'Session invalid.' });
        const target = riderGid || gid;
        await assertInProject(target);

        if (form.name && form.name.trim()) {
          await asana(`/tasks/${target}`, {
            method: 'PUT', body: JSON.stringify({ data: { name: form.name.trim() } }),
          });
        }

        const merged = await patchTask(target, {
          NICKNAME: form.nickname || '',
          USABMX: form.usabmx || '',
          PROFICIENCY: form.proficiency || '',
          DOB: form.dob || '',
          RACE_NUMBER: form.raceNumber || '',
          EMERGENCY_NAME: form.emergencyName || '',
          EMERGENCY_PHONE: form.emergencyPhone || '',
          SIGNED_BY: form.signature || '',
          SIGNED_ROLE: form.signerRole || '',
          SIGNED_DATE: new Date().toISOString().slice(0, 10),
          FORM_STATUS: 'Complete',
        });

        await asana(`/tasks/${target}/stories`, {
          method: 'POST',
          body: JSON.stringify({ data: {
            text: `Agreement signed by ${form.signature} (${form.signerRole}) on ${new Date().toLocaleString('en-US')}.`,
          } }),
        }).catch(() => {});

        return res.json({ ok: true, fields: merged });
      }

      /* ----- jerseys ----- */
      case 'submitJersey': {
        const { gid, session, riders = [], extras = [] } = body;
        if (!verifySession(gid, session)) return res.status(401).json({ error: 'Session invalid.' });

        const me = await assertInProject(gid);
        const mf = parseNotes(me.notes || '');
        const myLinked = splitIds(mf.LINKED_RIDERS);
        const { cfg } = await getConfig();
        if ((cfg.JERSEY_ORDER_OPEN || 'true').toLowerCase() === 'false') {
          return res.status(400).json({ error: 'Jersey ordering is closed.' });
        }
        // 0 means no limit; cleanVal still guards the one-line notes format.
        const nameMax = parseInt(cfg.JERSEY_NAME_MAX || '0', 10) || 120;
        const sizes = (cfg.JERSEY_SIZES || JERSEY_SIZES_DEFAULT)
          .split(',').map(x => x.trim()).filter(Boolean);
        const okSize = z => sizes.includes(String(z || '').trim());

        // Riders: one jersey each, written to the rider's own task.
        for (const row of riders) {
          if (!row || !row.gid) continue;
          const size = cleanVal(row.size, 8);
          const number = cleanNum(row.number);
          const backName = cleanVal(row.name, nameMax).toUpperCase();
          const qty = Math.min(99, Math.max(1, parseInt(row.qty || '1', 10) || 1));
          if (!size && !number && !backName) continue;
          if (!okSize(size)) return res.status(400).json({ error: `Pick a valid size for each rider.` });
          if (!number) return res.status(400).json({ error: 'Each jersey needs a number.' });
          if (!backName) return res.status(400).json({ error: 'Each jersey needs a name for the back.' });

          const rider = await assertInProject(row.gid);
          const rf = parseNotes(rider.notes || '');
          const authorized = row.gid === gid
            || splitIds(rf.LINKED_PARENTS).includes(gid)
            || myLinked.includes(row.gid);
          if (!authorized) return res.status(403).json({ error: 'Not authorized for that rider.' });

          await patchTask(row.gid, {
            JERSEY_SIZE: size,
            JERSEY_NUMBER: number,
            JERSEY_NAME: backName,
            JERSEY_QTY: qty,
            JERSEY_STATUS: 'Complete',
            JERSEY_DATE: new Date().toISOString().slice(0, 10),
          });
        }

        // Extras: any number of additional jerseys, kept on this account's task.
        const cleanExtras = [];
        for (const e of extras) {
          if (!e) continue;
          const size = cleanVal(e.size, 8);
          const number = cleanNum(e.number);
          const backName = cleanVal(e.name, nameMax).toUpperCase();
          const eqty = Math.min(99, Math.max(1, parseInt(e.qty || '1', 10) || 1));
          if (!size && !number && !backName) continue;
          if (!okSize(size)) return res.status(400).json({ error: 'Pick a valid size for each extra jersey.' });
          if (!number) return res.status(400).json({ error: 'Each extra jersey needs a number.' });
          if (!backName) return res.status(400).json({ error: 'Each extra jersey needs a name for the back.' });
          cleanExtras.push({ size, number, name: backName, qty: eqty });
        }

        const riderQty = riders
          .filter(r => r && r.gid && cleanVal(r.size, 8))
          .reduce((n, r) => n + Math.min(99, Math.max(1, parseInt(r.qty || '1', 10) || 1)), 0);
        const extraQty = cleanExtras.reduce((n, e) => n + e.qty, 0);
        const price = parseFloat(cfg.JERSEY_PRICE || '25') || 0;

        await patchTask(gid, {
          ...extrasUpdate(mf, cleanExtras),
          JERSEY_EXTRA_QTY: extraQty || undefined,
          JERSEY_ORDER_DATE: new Date().toISOString().slice(0, 10),
        });

        await asana(`/tasks/${gid}/stories`, {
          method: 'POST',
          body: JSON.stringify({ data: {
            text: `Jersey order submitted: ${riderQty} rider jersey(s), ${extraQty} extra(s). `
                + `${riderQty + extraQty} total at $${price} each = $${((riderQty + extraQty) * price).toFixed(2)}. Invoice to follow.`,
          } }),
        }).catch(() => {});

        return res.json({ ok: true, riderQty, extraQty, total: (riderQty + extraQty) * price });
      }

      case 'adminSetJersey': {
        const { gid, session, riderGid, size, number, name } = body;
        await requireAdmin(gid, session);
        const { cfg } = await getConfig();
        const nameMax = parseInt(cfg.JERSEY_NAME_MAX || '0', 10) || 120;
        const clear = !size && !number && !name;
        await patchTask(riderGid, clear ? {
          JERSEY_SIZE: undefined, JERSEY_NUMBER: undefined, JERSEY_NAME: undefined,
          JERSEY_QTY: undefined, JERSEY_STATUS: undefined, JERSEY_DATE: undefined,
        } : {
          JERSEY_SIZE: cleanVal(size, 8),
          JERSEY_NUMBER: cleanNum(number),
          JERSEY_NAME: cleanVal(name, nameMax).toUpperCase(),
          JERSEY_QTY: Math.min(99, Math.max(1, parseInt(body.qty || '1', 10) || 1)),
          JERSEY_STATUS: 'Complete',
          JERSEY_DATE: new Date().toISOString().slice(0, 10),
        });
        return res.json({ ok: true });
      }

      // Every jersey on the team, grouped into the household that owes for it.
      case 'adminJerseyOrders': {
        const { gid, session } = body;
        await requireAdmin(gid, session);
        const { cfg } = await getConfig();
        const price = parseFloat(cfg.JERSEY_PRICE || '25') || 0;

        const [riders, parents] = await Promise.all([
          listSection(SECTIONS.riders), listSection(SECTIONS.parents),
        ]);
        const isBoth = t => (t.fields.ROLE || '').toUpperCase() === 'BOTH';
        const parentPool = [...parents, ...riders.filter(isBoth)];

        const parentsOf = r => parentPool.filter(p => p.gid !== r.gid &&
          (splitIds(r.fields.LINKED_PARENTS).includes(p.gid) ||
           splitIds(p.fields.LINKED_RIDERS).includes(r.gid)));

        // A household is keyed by its first linked parent, or the rider alone.
        const fam = new Map();
        const touch = (key, contact) => {
          if (!fam.has(key)) {
            fam.set(key, { key, contact, riders: [], extras: [], taskGids: new Set() });
          }
          return fam.get(key);
        };

        for (const r of riders) {
          const ps = parentsOf(r).sort((a, b) => a.gid.localeCompare(b.gid));
          const head = ps[0];
          const key = head ? head.gid : r.gid;
          const contact = head
            ? { name: head.name, email: head.fields.EMAIL || '', phone: head.fields.PHONE || '' }
            : { name: r.name, email: r.fields.EMAIL || '', phone: r.fields.PHONE || '' };
          const h = touch(key, contact);
          h.riders.push({
            gid: r.gid, name: r.name,
            size: r.fields.JERSEY_SIZE || '',
            number: r.fields.JERSEY_NUMBER || '',
            backName: r.fields.JERSEY_NAME || '',
            qty: Math.min(99, Math.max(1, parseInt(r.fields.JERSEY_QTY || '1', 10) || 1)),
            done: (r.fields.JERSEY_STATUS || '') === 'Complete',
          });
          for (const p of ps) h.taskGids.add(p.gid);
          h.taskGids.add(r.gid);
        }

        // A parent with no rider attached can still have bought extras.
        for (const p of parents) {
          const has = [...fam.values()].some(h => h.taskGids.has(p.gid));
          if (has) continue;
          if (!parseExtras(p.fields).length) continue;
          const h = touch(p.gid, { name: p.name, email: p.fields.EMAIL || '', phone: p.fields.PHONE || '' });
          h.taskGids.add(p.gid);
        }

        const byGid = new Map([...riders, ...parents].map(t => [t.gid, t]));
        const families = [];
        for (const h of fam.values()) {
          for (const tg of h.taskGids) {
            const t = byGid.get(tg);
            if (!t) continue;
            for (const e of parseExtras(t.fields)) {
              h.extras.push({ ...e, orderedBy: t.name });
            }
          }
          const riderQty = h.riders.filter(r => r.done).reduce((n, r) => n + r.qty, 0);
          const extraQty = h.extras.reduce((n, e) => n + e.qty, 0);
          families.push({
            key: h.key, contact: h.contact,
            riders: h.riders, extras: h.extras,
            qty: riderQty + extraQty,
            total: (riderQty + extraQty) * price,
          });
        }
        families.sort((a, b) => (a.contact.name || '').localeCompare(b.contact.name || ''));

        const sizeTotals = {};
        for (const f of families) {
          for (const r of f.riders) if (r.done) sizeTotals[r.size] = (sizeTotals[r.size] || 0) + r.qty;
          for (const e of f.extras) sizeTotals[e.size] = (sizeTotals[e.size] || 0) + e.qty;
        }
        const missing = [];
        for (const f of families) {
          for (const r of f.riders) if (!r.done) missing.push({ name: r.name, contact: f.contact.name });
        }

        return res.json({
          price,
          families,
          sizeTotals: Object.entries(sizeTotals).map(([size, qty]) => ({ size, qty })),
          missing,
          grandQty: families.reduce((n, f) => n + f.qty, 0),
          grandTotal: families.reduce((n, f) => n + f.total, 0),
        });
      }

      /* ----- payment ----- */
      case 'payOpened': {
        const { gid, session, riderGid } = body;
        if (!verifySession(gid, session)) return res.status(401).json({ error: 'Session invalid.' });
        await patchTask(riderGid || gid, {
          PAYMENT_STATUS: 'Verifying',
          PAY_OPENED_AT: new Date().toISOString(),
        });
        return res.json({ ok: true });
      }

      case 'checkPayment': {
        const { gid, session, riderGid } = body;
        if (!verifySession(gid, session)) return res.status(401).json({ error: 'Session invalid.' });
        const target = riderGid || gid;
        const t = await assertInProject(target);
        const f = parseNotes(t.notes || '');
        if ((f.PAYMENT_STATUS || '') === 'Paid') return res.json({ paid: true });

        const { cfg } = await getConfig();
        const emails = [f.EMAIL];
        for (const pg of splitIds(f.LINKED_PARENTS)) {
          try {
            const p = await assertInProject(pg);
            emails.push(parseNotes(p.notes || '').EMAIL);
          } catch {}
        }

        const usedIds = new Set(splitIds(cfg.USED_PAYMENTS));
        let hit = null;
        for (const em of emails.filter(Boolean)) {
          hit = await findZeffyPayment(em, cfg.ZEFFY_CAMPAIGN_ID, usedIds);
          if (hit) break;
        }
        if (hit) {
          await markPaid(target, hit.id);
          await recordUsedPayment(hit.id);
          return res.json({ paid: true, ref: hit.id });
        }

        // Time out a stale "Verifying" back to Unpaid.
        const hours = parseInt(cfg.VERIFY_TIMEOUT_HOURS || '24', 10);
        if (f.PAY_OPENED_AT) {
          const age = (Date.now() - new Date(f.PAY_OPENED_AT).getTime()) / 36e5;
          if (age > hours) await patchTask(target, { PAYMENT_STATUS: 'Unpaid' });
        }
        return res.json({ paid: false });
      }

      case 'adminMarkPaid': {
        const { gid, session, riderGid, unpay } = body;
        await requireAdmin(gid, session);
        if (unpay) {
          const prev = await assertInProject(riderGid);
          const prevRef = parseNotes(prev.notes || '').PAYMENT_REF;
          await patchTask(riderGid, { PAYMENT_STATUS: 'Unpaid', PAYMENT_REF: '' });
          await releaseUsedPayment(prevRef);
        } else {
          await markPaid(riderGid, 'manual (admin)');
        }
        return res.json({ ok: true });
      }

      case 'adminZeffyCampaigns': {
        const { gid, session } = body;
        await requireAdmin(gid, session);
        const data = await zeffy('/campaigns?limit=100');
        const rows = data?.data || data?.campaigns || (Array.isArray(data) ? data : []);
        return res.json({
          campaigns: rows.map(c => ({
            id: c.id || c.campaignId || '',
            title: c.title || c.name || '(untitled)',
            type: c.type || '',
          })),
        });
      }

      case 'adminSetCampaign': {
        const { gid, session, campaignId } = body;
        await requireAdmin(gid, session);
        const cfgTasks = await listSection(SECTIONS.config);
        const pay = cfgTasks.find(c => c.name === 'CONFIG: Payment');
        if (!pay) return res.status(404).json({ error: 'CONFIG: Payment task not found.' });
        await patchTask(pay.gid, { ZEFFY_CAMPAIGN_ID: campaignId });
        return res.json({ ok: true });
      }

      /* ----- sign-ups ----- */
      case 'signupEvents': {
        const { gid, session } = body;
        if (!verifySession(gid, session)) return res.status(401).json({ error: 'Session invalid.' });
        const events = await listSection(SECTIONS.signups);
        const out = [];
        for (const e of events) {
          if (e.name.startsWith('DEFAULT TEMPLATE')) continue;
          const subs = await asana(`/tasks/${e.gid}/subtasks?opt_fields=name,notes`);
          const slots = subs || [];
          const open = slots.filter(s => !(parseNotes(s.notes || '').CLAIMED_BY || '')).length;
          out.push({
            gid: e.gid, name: e.name,
            date: e.fields.DATE || '', endDate: e.fields.END_DATE || '',
            series: e.fields.SERIES || '',
            total: slots.length, open,
          });
        }
        out.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
        return res.json({ events: out });
      }

      case 'signupDetail': {
        const { gid, session, eventGid } = body;
        if (!verifySession(gid, session)) return res.status(401).json({ error: 'Session invalid.' });
        const ev = await assertInProject(eventGid);
        const f = parseNotes(ev.notes || '');
        const subs = await asana(`/tasks/${eventGid}/subtasks?opt_fields=name,notes`);
        return res.json({
          event: {
            gid: eventGid, name: ev.name,
            date: f.DATE || '', endDate: f.END_DATE || '', series: f.SERIES || '',
            slots: (subs || []).map(s => {
              const sf = parseNotes(s.notes || '');
              return {
                gid: s.gid, item: s.name,
                claimedBy: sf.CLAIMED_BY || '', claimedGid: sf.CLAIMED_GID || '',
              };
            }),
          },
        });
      }

      case 'claimSlot': {
        const { gid, session, slotGid, userName, release } = body;
        if (!verifySession(gid, session)) return res.status(401).json({ error: 'Session invalid.' });
        const slot = await asana(`/tasks/${slotGid}?opt_fields=notes,name`);
        const f = parseNotes(slot.notes || '');
        const stamp = new Date().toLocaleString('en-US');

        if (release) {
          if (f.CLAIMED_GID && f.CLAIMED_GID !== gid) {
            return res.status(403).json({ error: 'That slot belongs to someone else.' });
          }
          await asana(`/tasks/${slotGid}`, {
            method: 'PUT',
            body: JSON.stringify({ data: {
              notes: buildNotes({ ...f, CLAIMED_BY: '', CLAIMED_GID: '' }), completed: false,
            } }),
          });
          await asana(`/tasks/${slotGid}/stories`, {
            method: 'POST',
            body: JSON.stringify({ data: { text: `RELEASED by ${userName || 'someone'} — ${stamp}` } }),
          }).catch(() => {});
          return res.json({ ok: true });
        }

        if (f.CLAIMED_GID && f.CLAIMED_GID !== gid) {
          return res.status(409).json({ error: 'Someone just claimed that slot.' });
        }
        await asana(`/tasks/${slotGid}`, {
          method: 'PUT',
          body: JSON.stringify({ data: {
            notes: buildNotes({ ...f, CLAIMED_BY: userName || '', CLAIMED_GID: gid }),
            completed: true,
          } }),
        });
        await asana(`/tasks/${slotGid}/stories`, {
          method: 'POST',
          body: JSON.stringify({ data: { text: `CLAIMED by ${userName || 'someone'} — ${stamp}` } }),
        }).catch(() => {});
        return res.json({ ok: true });
      }

      /* ----- admin ----- */
      case 'adminSaveTile': {
        const { gid, session, tileGid, updates } = body;
        await requireAdmin(gid, session);
        const safe = {};
        for (const k of ['ICON_URL', 'LINK', 'VISIBILITY', 'ORDER',
                         'SUBLINK_GEAR', 'SUBLINK_JERSEYS', 'SUBLINK_PLATES']) {
          if (updates?.[k] !== undefined) safe[k] = updates[k];
        }
        return res.json({ ok: true, fields: await patchTask(tileGid, safe) });
      }

      case 'adminLink': {
        const { gid, session, parentGid, riderGid, unlink } = body;
        await requireAdmin(gid, session);
        const parent = await assertInProject(parentGid);
        const rider = await assertInProject(riderGid);
        let pR = splitIds(parseNotes(parent.notes || '').LINKED_RIDERS);
        let rP = splitIds(parseNotes(rider.notes || '').LINKED_PARENTS);
        if (unlink) {
          pR = pR.filter(x => x !== riderGid);
          rP = rP.filter(x => x !== parentGid);
        } else {
          if (!pR.includes(riderGid)) pR.push(riderGid);
          if (!rP.includes(parentGid)) rP.push(parentGid);
        }
        await patchTask(parentGid, { LINKED_RIDERS: pR.join(', '), PENDING_MATCH: '' });
        await patchTask(riderGid, { LINKED_PARENTS: rP.join(', ') });
        return res.json({ ok: true });
      }

      case 'adminCreateEvent': {
        const { gid, session, eventName, date, endDate, items } = body;
        await requireAdmin(gid, session);
        const eventGid = await createInSection(SECTIONS.signups, eventName, {
          DATE: date || '', END_DATE: endDate || '', SERIES: 'Team Event',
        });
        for (const item of items || []) {
          await asana('/tasks', {
            method: 'POST',
            body: JSON.stringify({ data: { name: item, parent: eventGid } }),
          });
        }
        return res.json({ ok: true, gid: eventGid });
      }

      case 'addSignupItem': {
        const { gid, session, eventGid, itemName } = body;
        await requireAdmin(gid, session);
        if (!itemName || !itemName.trim()) return res.status(400).json({ error: 'Item name is required.' });
        const created = await asana('/tasks', {
          method: 'POST',
          body: JSON.stringify({ data: {
            name: itemName.trim(), parent: eventGid,
            notes: 'CLAIMED_BY: \nCLAIMED_GID: ',
          } }),
        });
        return res.json({ ok: true, gid: created.gid });
      }

      case 'deleteSignupItem': {
        const { gid, session, slotGid } = body;
        await requireAdmin(gid, session);
        await asana(`/tasks/${slotGid}`, { method: 'DELETE' });
        return res.json({ ok: true });
      }

      /* ----- RSVP ----- */
      case 'rsvpStatus': {
        const { gid, session, eventId } = body;
        if (!verifySession(gid, session)) return res.status(401).json({ error: 'Session invalid.' });
        const [task, riders] = await Promise.all([
          findRsvpTask(eventId),
          listSection(SECTIONS.riders),
        ]);
        const rsvps = {};
        if (task) {
          for (const [k, v] of Object.entries(task.fields)) {
            const goingMatch = k.match(/^RSVP_(\d+)$/);
            if (goingMatch) { rsvps[goingMatch[1]] = { ...(rsvps[goingMatch[1]] || {}), going: v }; continue; }
            const paidMatch = k.match(/^PAID_(\d+)$/);
            if (paidMatch) { rsvps[paidMatch[1]] = { ...(rsvps[paidMatch[1]] || {}), paid: v }; }
          }
        }
        return res.json({
          rsvps,
          riders: riders.map(r => ({ gid: r.gid, name: r.name })),
        });
      }

      case 'rsvpSet': {
        const { gid, session, eventId, eventDate, eventTitle, riderGid, going, paid } = body;
        if (!verifySession(gid, session)) return res.status(401).json({ error: 'Session invalid.' });
        if (!eventId || !riderGid) return res.status(400).json({ error: 'Missing eventId or riderGid.' });
        if (!(await canManageRider(gid, riderGid))) {
          return res.status(403).json({ error: "You can only RSVP for your own linked rider(s)." });
        }
        const task = await findOrCreateRsvpTask(eventId, eventDate, eventTitle);
        const updates = {};
        if (going !== undefined) updates[`RSVP_${riderGid}`] = going;
        if (paid !== undefined) updates[`PAID_${riderGid}`] = paid;
        await patchTask(task.gid, updates);
        return res.json({ ok: true });
      }

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error('[hub]', action, err);
    return res.status(err.code || 500).json({ error: err.message || 'Server error' });
  }
}
