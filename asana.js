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
async function findZeffyPayment(email, campaignId) {
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
      return {
        id: p.id || p.paymentId || '',
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

        const show = (f, key) => isAdmin || (f[`${key}_PUBLIC`] || 'true').toLowerCase() !== 'false';

        const list = riders.map(r => {
          const f = r.fields;
          const lp = splitIds(f.LINKED_PARENTS);
          const kids = parents
            .filter(p => lp.includes(p.gid) || splitIds(p.fields.LINKED_RIDERS).includes(r.gid))
            .map(p => ({
              gid: p.gid, name: p.name,
              phone: show(p.fields, 'PHONE') ? p.fields.PHONE || '' : '',
              email: show(p.fields, 'EMAIL') ? p.fields.EMAIL || '' : '',
              pin: isAdmin ? p.fields.PIN || '' : undefined,
            }));

          const entry = {
            gid: r.gid, name: r.name,
            dob: f.DOB || '', raceNumber: f.RACE_NUMBER || '',
            proficiency: f.PROFICIENCY || '', nickname: f.NICKNAME || '',
            formStatus: f.FORM_STATUS || 'Not Started',
            paymentStatus: f.PAYMENT_STATUS || 'Unpaid',
            phone: show(f, 'PHONE') ? f.PHONE || '' : '',
            email: show(f, 'EMAIL') ? f.EMAIL || '' : '',
            parents: kids,
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

        let unlinked = [];
        if (isAdmin) {
          unlinked = parents.filter(p =>
            !splitIds(p.fields.LINKED_RIDERS).length &&
            !riders.some(r => splitIds(r.fields.LINKED_PARENTS).includes(p.gid))
          ).map(p => ({
            gid: p.gid, name: p.name,
            email: p.fields.EMAIL || '', phone: p.fields.PHONE || '',
            pin: p.fields.PIN || '', pendingMatch: p.fields.PENDING_MATCH || '',
          }));
        }

        return res.json({
          riders: list, unlinked, isAdmin,
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
            self: false,
          }));

        if (role === 'RIDER' || role === 'BOTH') {
          out.unshift({
            gid, name: me.name,
            formStatus: f.FORM_STATUS || 'Not Started',
            paymentStatus: f.PAYMENT_STATUS || 'Unpaid',
            payOpenedAt: f.PAY_OPENED_AT || '',
            self: true,
          });
        }
        return res.json({ riders: out, role });
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
          PHONE_PUBLIC: form.phonePublic ? 'true' : 'false',
          EMAIL_PUBLIC: form.emailPublic ? 'true' : 'false',
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

        let hit = null;
        for (const em of emails.filter(Boolean)) {
          hit = await findZeffyPayment(em, cfg.ZEFFY_CAMPAIGN_ID);
          if (hit) break;
        }
        if (hit) {
          await markPaid(target, hit.id);
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
          await patchTask(riderGid, { PAYMENT_STATUS: 'Unpaid', PAYMENT_REF: '' });
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

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error('[hub]', action, err);
    return res.status(err.code || 500).json({ error: err.message || 'Server error' });
  }
}
