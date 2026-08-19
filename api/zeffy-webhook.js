// Zeffy payment.completed webhook.
// Configure in Zeffy: Settings -> Integrations -> Webhook
//   URL: https://<your-app>.vercel.app/api/zeffy-webhook
//
// When a payment lands, find the rider (or the rider linked to the paying
// parent) whose email matches, and mark them paid.

const ASANA = 'https://app.asana.com/api/1.0';
const TOKEN = process.env.ASANA_TOKEN;
const PROJECT_GID = process.env.HUB_PROJECT_GID || '1217616477503428';
const SECTIONS = {
  riders: process.env.SEC_RIDERS || '1217616432345566',
  parents: process.env.SEC_PARENTS || '1217629407873450',
};

async function asana(path, opts = {}) {
  const res = await fetch(`${ASANA}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.errors?.[0]?.message || `Asana ${res.status}`);
  return json.data;
}

function parseNotes(notes = '') {
  const out = {};
  for (const line of notes.split('\n')) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    const k = line.slice(0, i).trim();
    if (!/^[A-Z0-9_]+$/.test(k)) continue;
    out[k] = line.slice(i + 1).trim();
  }
  return out;
}

const buildNotes = f => Object.entries(f)
  .filter(([, v]) => v !== undefined && v !== null)
  .map(([k, v]) => `${k}: ${v}`).join('\n');

const splitIds = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);

async function listSection(gid) {
  const tasks = await asana(`/sections/${gid}/tasks?opt_fields=name,notes&limit=100`);
  return (tasks || []).map(t => ({ gid: t.gid, name: t.name, fields: parseNotes(t.notes || '') }));
}

async function markPaid(gid, ref) {
  const t = await asana(`/tasks/${gid}?opt_fields=notes,projects`);
  if (!(t.projects || []).some(p => p.gid === PROJECT_GID)) return;
  const merged = {
    ...parseNotes(t.notes || ''),
    PAYMENT_STATUS: 'Paid',
    PAID_DATE: new Date().toISOString().slice(0, 10),
    PAYMENT_REF: ref || 'zeffy-webhook',
  };
  await asana(`/tasks/${gid}`, {
    method: 'PUT', body: JSON.stringify({ data: { notes: buildNotes(merged) } }),
  });
  await asana(`/tasks/${gid}/stories`, {
    method: 'POST',
    body: JSON.stringify({ data: {
      text: `Team fee payment confirmed via Zeffy — ${new Date().toLocaleString('en-US')}`,
    } }),
  }).catch(() => {});
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!TOKEN) return res.status(500).json({ error: 'ASANA_TOKEN not configured' });

  try {
    const body = req.body || {};
    const p = body.payment || body.data || body;
    const email = String(
      p.email || p.buyerEmail || p.contact?.email || p.buyer?.email || ''
    ).trim().toLowerCase();

    // Always 200 so Zeffy doesn't retry on payments we can't match.
    if (!email) return res.status(200).json({ ok: true, matched: false });

    const ref = p.id || p.paymentId || 'zeffy';
    const [riders, parents] = await Promise.all([
      listSection(SECTIONS.riders), listSection(SECTIONS.parents),
    ]);

    const rider = riders.find(r => (r.fields.EMAIL || '').toLowerCase() === email);
    if (rider) {
      await markPaid(rider.gid, ref);
      return res.status(200).json({ ok: true, matched: true, rider: rider.name });
    }

    // Parent paid — mark every rider linked to them.
    const parent = parents.find(x => (x.fields.EMAIL || '').toLowerCase() === email);
    if (parent) {
      const targets = new Set(splitIds(parent.fields.LINKED_RIDERS));
      for (const r of riders) {
        if (splitIds(r.fields.LINKED_PARENTS).includes(parent.gid)) targets.add(r.gid);
      }
      for (const gid of targets) await markPaid(gid, ref);
      return res.status(200).json({ ok: true, matched: true, count: targets.size });
    }

    return res.status(200).json({ ok: true, matched: false });
  } catch (err) {
    console.error('[zeffy-webhook]', err);
    return res.status(200).json({ ok: false, error: err.message });
  }
}
