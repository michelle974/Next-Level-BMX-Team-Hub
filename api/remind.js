// /api/remind.js
// Vercel cron function — runs daily at 8am ET (12:00 UTC).
// Finds sign-up events whose start date is tomorrow ET,
// checks claimed vs unclaimed items, and posts to GroupMe.

const ASANA_TOKEN = process.env.ASANA_TOKEN;
const GROUPME_BOT_ID = process.env.GROUPME_BOT_ID;
const SECTIONS = {
  signups: process.env.SIGNUPS_SECTION_GID,
  config:  process.env.CONFIG_SECTION_GID,
};

// ---- Asana helpers ----
async function asana(path, opts = {}) {
  const r = await fetch(`https://app.asana.com/api/1.0${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${ASANA_TOKEN}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.errors?.[0]?.message || `Asana ${r.status}`);
  return j.data;
}

async function listSection(sectionGid) {
  return asana(`/sections/${sectionGid}/tasks?opt_fields=gid,name,notes,completed`);
}

async function getSubtasks(taskGid) {
  return asana(`/tasks/${taskGid}/subtasks?opt_fields=gid,name,notes,completed`);
}

// ---- Config helpers ----
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

// Parse both message templates from the CONFIG: Reminder Messages task notes.
// Templates are separated by MESSAGE_NEEDS_ITEMS: and MESSAGE_ALL_CLAIMED: labels.
function parseMessageTemplates(notes = '') {
  const needsMatch = notes.match(/MESSAGE_NEEDS_ITEMS:\s*([\s\S]*?)(?=MESSAGE_ALL_CLAIMED:|$)/);
  const allMatch   = notes.match(/MESSAGE_ALL_CLAIMED:\s*([\s\S]*?)$/);
  return {
    needsItems:  needsMatch ? needsMatch[1].trim() : '',
    allClaimed:  allMatch   ? allMatch[1].trim()   : '',
  };
}

async function getConfig() {
  const tasks = await listSection(SECTIONS.config);
  let groupmeBotId = GROUPME_BOT_ID || '';
  let msgNeedsItems = '';
  let msgAllClaimed = '';

  for (const t of tasks) {
    if (t.name === 'CONFIG: GroupMe Bot') {
      const f = parseNotes(t.notes);
      if (!groupmeBotId) groupmeBotId = f.BOT_ID || '';
    }
    if (t.name === 'CONFIG: Reminder Messages') {
      const full = await asana(`/tasks/${t.gid}?opt_fields=notes`);
      const tpl = parseMessageTemplates(full.notes || '');
      msgNeedsItems = tpl.needsItems;
      msgAllClaimed = tpl.allClaimed;
    }
  }
  return { groupmeBotId, msgNeedsItems, msgAllClaimed };
}

// ---- Date helpers (ET) ----
function tomorrowET() {
  // Convert current UTC to ET (UTC-4 EDT / UTC-5 EST) and get tomorrow's date string
  const now = new Date();
  const etOffset = isDST(now) ? -4 : -5;
  const etNow = new Date(now.getTime() + etOffset * 3600 * 1000);
  const tomorrow = new Date(etNow);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return tomorrow.toISOString().slice(0, 10); // YYYY-MM-DD
}

function isDST(date) {
  // DST in US: second Sunday in March to first Sunday in November
  const jan = new Date(date.getFullYear(), 0, 1).getTimezoneOffset();
  const jul = new Date(date.getFullYear(), 6, 1).getTimezoneOffset();
  return Math.max(jan, jul) !== date.getTimezoneOffset();
}

// ---- GroupMe ----
async function sendGroupMe(botId, text) {
  const r = await fetch('https://api.groupme.com/v3/bots/post', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bot_id: botId, text }),
  });
  if (!r.ok) throw new Error(`GroupMe ${r.status}`);
}

// ---- Main handler ----
export default async function handler(req, res) {
  // Vercel cron passes a special header — verify it in production
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const tomorrow = tomorrowET();
    const [cfg, signupTasks] = await Promise.all([
      getConfig(),
      listSection(SECTIONS.signups),
    ]);

    if (!cfg.groupmeBotId) return res.status(500).json({ error: 'No GroupMe bot ID configured.' });

    const results = [];

    for (const event of signupTasks) {
      if (event.completed) continue;
      const f = parseNotes(event.notes || '');
      const eventDate = f.DATE || '';
      if (!eventDate || !eventDate.startsWith(tomorrow)) continue;

      // Fetch items (subtasks)
      const items = await getSubtasks(event.gid);
      const claimed = [], unclaimed = [];

      for (const item of items) {
        if (item.completed) continue; // skip completed items
        const sf = parseNotes(item.notes || '');
        const claimedBy = (sf.CLAIMED_BY || '').trim();
        if (claimedBy) {
          claimed.push(`✅ ${item.name} — ${claimedBy}`);
        } else {
          unclaimed.push(`❌ ${item.name}`);
        }
      }

      const eventName = event.name.replace(/^EVENT:\s*/i, '').trim();
      const claimedList   = claimed.length   ? claimed.join('\n')   : '(none yet)';
      const unclaimedList = unclaimed.length ? unclaimed.join('\n') : '';

      let message;
      if (unclaimed.length === 0) {
        message = (cfg.msgAllClaimed || '✅ All set for tomorrow — {EVENT_NAME}!\n\nEverything is covered:\n{CLAIMED_LIST}\n\nSee you at the track! 🏁')
          .replace('{EVENT_NAME}', eventName)
          .replace('{CLAIMED_LIST}', claimedList);
      } else {
        message = (cfg.msgNeedsItems || '🚨 Race tomorrow — {EVENT_NAME}!\n\nStill needed:\n{UNCLAIMED_LIST}\n\nAlready covered:\n{CLAIMED_LIST}\n\nClaim yours in the Team Hub Sign-Ups! 🏁')
          .replace('{EVENT_NAME}', eventName)
          .replace('{UNCLAIMED_LIST}', unclaimedList)
          .replace('{CLAIMED_LIST}', claimedList);
      }

      await sendGroupMe(cfg.groupmeBotId, message);
      results.push({ event: eventName, unclaimed: unclaimed.length, claimed: claimed.length });
    }

    res.status(200).json({ sent: results.length, results });
  } catch (err) {
    console.error('remind.js error:', err);
    res.status(500).json({ error: err.message });
  }
}
