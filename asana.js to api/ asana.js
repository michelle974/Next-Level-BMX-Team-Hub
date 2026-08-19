// Next Level BMX Team Hub — Asana backend proxy
// The Asana token NEVER reaches the browser. It lives in Vercel env vars.
// All operations are scoped to the Team Hub project only.

import crypto from 'crypto';

const ASANA = 'https://app.asana.com/api/1.0';
const TOKEN = process.env.ASANA_TOKEN;
const SECRET = process.env.SESSION_SECRET || 'nlbmx-dev-secret-change-me';

const PROJECT_GID = process.env.HUB_PROJECT_GID || '1217616477503428';
const SECTIONS = {
  riders:   process.env.SEC_RIDERS   || '1217616432345566',
  parents:  process.env.SEC_PARENTS  || '1217629407873450',
  tiles:    process.env.SEC_TILES    || '1217616481671348',
  signups:  process.env.SEC_SIGNUPS  || '1217629408209469',
  config:   process.env.SEC_CONFIG   || '1217629408316937',
};

/* ---------- helpers ---------- */

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

// Parse "KEY: value" lines out of a task's notes into an object.
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

function buildNotes(fields) {
  return Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

const hashPin = pin => crypto.createHmac('sha256', SECRET).update(String(pin)).digest('hex');
const signSession = gid => crypto.createHmac('sha256', SECRET).update(`sess:${gid}`).digest('hex');

function verifySession(gid, sig) {
  if (!gid || !sig) return false;
  const expected = signSession(gid);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Normalize a name for fuzzy comparison
const normName = n => String(n || '').toLowerCase().replace(/[^a-z]/g, '');

function nameSimilarity(a, b) {
  a = normName(a); b = normName(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.startsWith(b) || b.startsWith(a)) return 0.85;
  // simple character-overlap ratio
  const short = a.length < b.length ? a : b;
  const long = a.length < b.length ? b : a;
  let hits = 0;
  for (const ch of new Set(short)) if (long.includes(ch)) hits++;
  return (hits / new Set(short).size) * 0.6;
}

async function listSection(sectionGid) {
  const tasks = await asana(
    `/sections/${sectionGid}/tasks?opt_fields=name,notes,completed&limit=100`
  );
  return (tasks || []).map(t => ({
    gid: t.gid,
    name: t.name,
    completed: t.completed,
    fields: parseNotes(t.notes || ''),
  }));
}

async function createInSection(sectionGid, name, fields) {
  const task = await asana('/tasks', {
    method: 'POST',
    body: JSON.stringify({
      data: { name, notes: buildNotes(fields), projects: [PROJECT_GID] },
    }),
  });
  await asana(`/sections/${sectionGid}/addTask`, {
    method: 'POST',
    body: JSON.stringify({ data: { task: task.gid } }),
  });
  return task.gid;
}

// Confirm a task belongs to the Hub project before touching it.
async function assertInProject(gid) {
  const t = await asana(`/tasks/${gid}?opt_fields=projects,notes,name`);
  const ok = (t.projects || []).some(p => p.gid === PROJECT_GID);
  if (!ok) throw new Error('Task is outside the Team Hub project');
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

const publicUser = (t, fields) => ({
  gid: t.gid,
  name: t.name,
  role: fields.ROLE || 'RIDER',
  email: fields.EMAIL || '',
  isAdmin: (fields.IS_ADMIN || '').toLowerCase() === 'true',
});

/* ---------- handler ---------- */

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (!TOKEN) {
    return res.status(500).json({ error: 'ASANA_TOKEN is not configured on the server.' });
  }

  const action = (req.method === 'GET' ? req.query.action : req.body?.action) || '';
  const body = req.body || {};

  try {
    switch (action) {
      /* ----- public bootstrap ----- */

      case 'bootstrap': {
        const [tiles, config] = await Promise.all([
          listSection(SECTIONS.tiles),
          listSection(SECTIONS.config),
        ]);
        const cfg = {};
        for (const c of config) Object.assign(cfg, c.fields);
        return res.json({
          tiles: tiles
            .filter(t => t.name.startsWith('TILE:'))
            .map(t => ({
              gid: t.gid,
              label: t.name.replace(/^TILE:\s*/, ''),
              icon: t.fields.ICON_URL || '',
              link: t.fields.LINK || '',
              visibility: (t.fields.VISIBILITY || 'public').toLowerCase(),
              order: parseInt(t.fields.ORDER ?? '99', 10),
              pinned: (t.fields.PINNED || '').toLowerCase() === 'true',
              sub: {
                gear: t.fields.SUBLINK_GEAR || '',
                jerseys: t.fields.SUBLINK_JERSEYS || '',
                plates: t.fields.SUBLINK_PLATES || '',
              },
            }))
            .sort((a, b) => a.order - b.order),
          config: {
            seasonDates: cfg.SEASON_DATES || '',
            teamFee: cfg.TEAM_OPERATIONS_FEE || '',
            season: cfg.SEASON || '',
          },
        });
      }

      /* ----- auth ----- */

      case 'signup': {
        const { name, email, phone, role, dob, pin, riderNames } = body;
        if (!name || !email || !pin || !role) {
          return res.status(400).json({ error: 'Missing required fields.' });
        }

        const [riders, parents] = await Promise.all([
          listSection(SECTIONS.riders),
          listSection(SECTIONS.parents),
        ]);
        const taken = [...riders, ...parents].find(
          t => (t.fields.EMAIL || '').toLowerCase() === email.toLowerCase()
        );
        if (taken) return res.status(409).json({ error: 'That email already has an account.' });

        const base = {
          EMAIL: email,
          PHONE: phone || '',
          PIN_HASH: hashPin(pin),
          ROLE: role,
          PHONE_PUBLIC: 'false',
          EMAIL_PUBLIC: 'false',
          FORM_STATUS: 'Not Started',
          CREATED: new Date().toISOString().slice(0, 10),
        };

        let gid;
        const linked = [];
        const pending = [];

        if (role === 'RIDER' || role === 'BOTH') {
          const existing = riders.find(r => normName(r.name) === normName(name));
          if (existing && !existing.fields.EMAIL) {
            gid = existing.gid;
            await patchTask(gid, { ...base, DOB: dob || '' });
          } else {
            gid = await createInSection(SECTIONS.riders, name, { ...base, DOB: dob || '' });
          }
        } else {
          gid = await createInSection(SECTIONS.parents, name, base);
        }

        // Link parent -> rider tasks by name
        if ((role === 'PARENT' || role === 'BOTH') && Array.isArray(riderNames)) {
          for (const rn of riderNames.filter(Boolean)) {
            const exact = riders.find(r => normName(r.name) === normName(rn));
            if (exact) {
              linked.push({ gid: exact.gid, name: exact.name });
              const cur = exact.fields.LINKED_PARENTS || '';
              await patchTask(exact.gid, {
                LINKED_PARENTS: cur ? `${cur}, ${gid}` : gid,
              });
              continue;
            }
            const fuzzy = riders
              .map(r => ({ r, score: nameSimilarity(r.name, rn) }))
              .filter(x => x.score >= 0.7)
              .sort((a, b) => b.score - a.score)[0];

            if (fuzzy) {
              pending.push({ typed: rn, suggested: fuzzy.r.name, gid: fuzzy.r.gid });
              await patchTask(gid, {
                PENDING_MATCH: `${rn} -> ${fuzzy.r.name} (${fuzzy.r.gid})`,
              });
            } else {
              const newGid = await createInSection(SECTIONS.riders, rn, {
                FORM_STATUS: 'Not Started',
                LINKED_PARENTS: gid,
                CREATED: base.CREATED,
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
          session: signSession(gid),
          linked,
          pending,
        });
      }

      case 'login': {
        const { email, pin } = body;
        const [riders, parents] = await Promise.all([
          listSection(SECTIONS.riders),
          listSection(SECTIONS.parents),
        ]);
        const found = [...riders, ...parents].find(
          t => (t.fields.EMAIL || '').toLowerCase() === String(email || '').toLowerCase()
        );
        if (!found || found.fields.PIN_HASH !== hashPin(pin)) {
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
        return res.json({ user: publicUser(t, fields), fields });
      }

      /* ----- roster ----- */

      case 'roster': {
        const { gid, session } = body;
        if (!verifySession(gid, session)) return res.status(401).json({ error: 'Session invalid.' });
        const me = await assertInProject(gid);
        const isAdmin = (parseNotes(me.notes || '').IS_ADMIN || '').toLowerCase() === 'true';

        const riders = await listSection(SECTIONS.riders);
        const list = riders.map(r => {
          const f = r.fields;
          const showPhone = isAdmin || (f.PHONE_PUBLIC || '').toLowerCase() === 'true';
          const showEmail = isAdmin || (f.EMAIL_PUBLIC || '').toLowerCase() === 'true';
          const entry = {
            gid: r.gid,
            name: r.name,
            dob: f.DOB || '',
            raceNumber: f.RACE_NUMBER || '',
            proficiency: f.PROFICIENCY || '',
            nickname: f.NICKNAME || '',
            formStatus: f.FORM_STATUS || 'Not Started',
            phone: showPhone ? f.PHONE || '' : '',
            email: showEmail ? f.EMAIL || '' : '',
          };
          if (isAdmin) {
            entry.usabmx = f.USABMX || '';
            entry.emergencyContact = f.EMERGENCY_NAME || '';
            entry.emergencyPhone = f.EMERGENCY_PHONE || '';
            entry.pendingMatch = f.PENDING_MATCH || '';
          }
          return entry;
        });
        return res.json({ riders: list, isAdmin });
      }

      case 'updateProfile': {
        const { gid, session, updates } = body;
        if (!verifySession(gid, session)) return res.status(401).json({ error: 'Session invalid.' });
        const allowed = [
          'PHONE', 'EMAIL', 'NICKNAME', 'RACE_NUMBER', 'PROFICIENCY', 'DOB',
          'USABMX', 'EMERGENCY_NAME', 'EMERGENCY_PHONE',
          'PHONE_PUBLIC', 'EMAIL_PUBLIC',
        ];
        const safe = {};
        for (const [k, v] of Object.entries(updates || {})) {
          if (allowed.includes(k)) safe[k] = v;
        }
        const merged = await patchTask(gid, safe);
        return res.json({ ok: true, fields: merged });
      }

      /* ----- team forms ----- */

      case 'submitForm': {
        const { gid, session, riderGid, form } = body;
        if (!verifySession(gid, session)) return res.status(401).json({ error: 'Session invalid.' });
        const target = riderGid || gid;
        await assertInProject(target);

        const merged = await patchTask(target, {
          NICKNAME: form.nickname || '',
          USABMX: form.usabmx || '',
          PROFICIENCY: form.proficiency || '',
          DOB: form.dob || '',
          RACE_NUMBER: form.raceNumber || '',
          EMERGENCY_NAME: form.emergencyName || '',
          EMERGENCY_PHONE: form.emergencyPhone || '',
          PHONE_PUBLIC: form.phonePublic ? 'true' : 'false',
          EMAIL_PUBLIC: form.emailPublic ? 'true' : 'false',
          SIGNED_BY: form.signature || '',
          SIGNED_ROLE: form.signerRole || '',
          SIGNED_DATE: new Date().toISOString().slice(0, 10),
          FORM_STATUS: 'Complete',
        });

        await asana(`/tasks/${target}`, {
          method: 'PUT',
          body: JSON.stringify({ data: { completed: true } }),
        });

        return res.json({ ok: true, fields: merged });
      }

      /* ----- sign-ups ----- */

      case 'signups': {
        const { gid, session } = body;
        if (!verifySession(gid, session)) return res.status(401).json({ error: 'Session invalid.' });
        const events = await listSection(SECTIONS.signups);
        const out = [];
        for (const e of events) {
          if (e.name.startsWith('DEFAULT TEMPLATE')) continue;
          const subs = await asana(`/tasks/${e.gid}/subtasks?opt_fields=name,notes,completed`);
          out.push({
            gid: e.gid,
            name: e.name,
            date: e.fields.DATE || '',
            slots: (subs || []).map(s => {
              const f = parseNotes(s.notes || '');
              return {
                gid: s.gid,
                item: s.name,
                claimedBy: f.CLAIMED_BY || '',
                claimedGid: f.CLAIMED_GID || '',
              };
            }),
          });
        }
        return res.json({ events: out });
      }

      case 'claimSlot': {
        const { gid, session, slotGid, userName, release } = body;
        if (!verifySession(gid, session)) return res.status(401).json({ error: 'Session invalid.' });
        const slot = await asana(`/tasks/${slotGid}?opt_fields=notes,name,parent`);
        const f = parseNotes(slot.notes || '');

        if (release) {
          if (f.CLAIMED_GID && f.CLAIMED_GID !== gid) {
            return res.status(403).json({ error: 'That slot belongs to someone else.' });
          }
          const cleared = buildNotes({ ...f, CLAIMED_BY: '', CLAIMED_GID: '' });
          await asana(`/tasks/${slotGid}`, {
            method: 'PUT',
            body: JSON.stringify({ data: { notes: cleared, completed: false } }),
          });
          return res.json({ ok: true, claimedBy: '' });
        }

        if (f.CLAIMED_GID && f.CLAIMED_GID !== gid) {
          return res.status(409).json({ error: 'Someone just claimed that slot.' });
        }
        const updated = buildNotes({ ...f, CLAIMED_BY: userName || '', CLAIMED_GID: gid });
        await asana(`/tasks/${slotGid}`, {
          method: 'PUT',
          body: JSON.stringify({ data: { notes: updated, completed: true } }),
        });
        return res.json({ ok: true, claimedBy: userName });
      }

      /* ----- admin ----- */

      case 'adminSaveTile': {
        const { gid, session, tileGid, updates } = body;
        if (!verifySession(gid, session)) return res.status(401).json({ error: 'Session invalid.' });
        const me = await assertInProject(gid);
        if ((parseNotes(me.notes || '').IS_ADMIN || '').toLowerCase() !== 'true') {
          return res.status(403).json({ error: 'Admins only.' });
        }
        const safe = {};
        for (const k of ['ICON_URL', 'LINK', 'VISIBILITY', 'ORDER', 'PINNED',
                         'SUBLINK_GEAR', 'SUBLINK_JERSEYS', 'SUBLINK_PLATES']) {
          if (updates?.[k] !== undefined) safe[k] = updates[k];
        }
        const merged = await patchTask(tileGid, safe);
        return res.json({ ok: true, fields: merged });
      }

      case 'adminAddTile': {
        const { gid, session, label, link, icon, order } = body;
        if (!verifySession(gid, session)) return res.status(401).json({ error: 'Session invalid.' });
        const me = await assertInProject(gid);
        if ((parseNotes(me.notes || '').IS_ADMIN || '').toLowerCase() !== 'true') {
          return res.status(403).json({ error: 'Admins only.' });
        }
        const newGid = await createInSection(SECTIONS.tiles, `TILE: ${label}`, {
          ICON_URL: icon || '',
          LINK: link || '',
          VISIBILITY: 'public',
          ORDER: order ?? 99,
        });
        return res.json({ ok: true, gid: newGid });
      }

      case 'adminCreateEvent': {
        const { gid, session, eventName, date, items } = body;
        if (!verifySession(gid, session)) return res.status(401).json({ error: 'Session invalid.' });
        const me = await assertInProject(gid);
        if ((parseNotes(me.notes || '').IS_ADMIN || '').toLowerCase() !== 'true') {
          return res.status(403).json({ error: 'Admins only.' });
        }
        const eventGid = await createInSection(SECTIONS.signups, eventName, { DATE: date || '' });
        for (const item of items || []) {
          await asana('/tasks', {
            method: 'POST',
            body: JSON.stringify({
              data: { name: item, parent: eventGid, notes: 'CLAIMED_BY: \nCLAIMED_GID: ' },
            }),
          });
        }
        return res.json({ ok: true, gid: eventGid });
      }

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error('[hub]', action, err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
