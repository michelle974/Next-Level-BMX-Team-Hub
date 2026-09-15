// /api/calendar.js
// Fetches events straight from the Google Calendar API so we get each
// event's real color and full details (location, description, link).
// Requires two Vercel env vars:
//   GOOGLE_CALENDAR_API_KEY  — API key with the Calendar API enabled
//   GOOGLE_CALENDAR_ID       — e.g. nextlevelbmx239@gmail.com
//
// Default call returns the upcoming window (a small buffer back, one year out).
// ?past=1 returns the previous 12 months, loaded on demand when an admin taps
// "Previous Events" so nobody pays for that payload unless they ask for it.

export default async function handler(req, res) {
  try {
    const API_KEY = (process.env.GOOGLE_CALENDAR_API_KEY || '').trim();
    const CAL_ID = (process.env.GOOGLE_CALENDAR_ID || 'nextlevelbmx239@gmail.com').trim();
    if (!API_KEY) {
      return res.status(500).json({ error: 'GOOGLE_CALENDAR_API_KEY is not set in Vercel.' });
    }

    const past = String(req.query?.past || '') === '1';
    const timeMin = new Date();
    const timeMax = new Date();
    if (past) {
      timeMin.setFullYear(timeMin.getFullYear() - 1);
      timeMax.setDate(timeMax.getDate() + 2);   // small overlap; the client trims it
    } else {
      timeMin.setDate(timeMin.getDate() - 2);   // keeps events running right now
      timeMax.setFullYear(timeMax.getFullYear() + 1);
    }

    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CAL_ID)}/events`
      + `?key=${API_KEY}&singleEvents=true&orderBy=startTime&maxResults=500`
      + `&timeMin=${encodeURIComponent(timeMin.toISOString())}`
      + `&timeMax=${encodeURIComponent(timeMax.toISOString())}`;

    const r = await fetch(url);
    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ error: data.error?.message || 'Calendar fetch failed.' });
    }

    const events = (data.items || [])
      .filter(e => e.status !== 'cancelled')
      .map(e => ({
        id: e.id,
        title: e.summary || '(No title)',
        start: e.start?.dateTime || e.start?.date,
        end: e.end?.dateTime || e.end?.date,
        allDay: !e.start?.dateTime,
        location: e.location || '',
        description: e.description || '',
        htmlLink: e.htmlLink || '',
      }));

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ events });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
