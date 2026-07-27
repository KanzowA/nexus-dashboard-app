const http = require('http');
const { OAuth2Client } = require('google-auth-library');
const { shell } = require('electron');
const secureStore = require('./secureStore');

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/drive.appdata'
];
const API_BASE = 'https://www.googleapis.com/calendar/v3';
const CONNECT_TIMEOUT_MS = 5 * 60 * 1000;

function getStatus() {
  const stored = secureStore.loadCalendarTokens();
  return { connected: !!(stored && stored.refreshToken) };
}

function connect({ clientId, clientSecret }) {
  return new Promise((resolve, reject) => {
    if (!clientId || !clientSecret) {
      reject(new Error('Client ID and Client Secret are required.'));
      return;
    }

    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname !== '/') return;

        const error = url.searchParams.get('error');
        const code = url.searchParams.get('code');

        if (error) {
          res.end('<html><body>Connection cancelled. You can close this tab.</body></html>');
          cleanup();
          reject(new Error(`Google denied access: ${error}`));
          return;
        }
        if (!code) return;

        const redirectUri = `http://127.0.0.1:${server.address().port}`;
        const client = new OAuth2Client({ clientId, clientSecret, redirectUri });
        const { tokens } = await client.getToken(code);

        if (!tokens.refresh_token) {
          res.end('<html><body>Google did not return a refresh token. Close this tab, revoke access at myaccount.google.com/permissions, and try connecting again.</body></html>');
          cleanup();
          reject(new Error('No refresh token returned. Revoke prior access and reconnect.'));
          return;
        }

        secureStore.saveCalendarTokens({ clientId, clientSecret, refreshToken: tokens.refresh_token });
        res.end('<html><body>Google Calendar connected — you can close this tab and return to Nexus Dashboard.</body></html>');
        cleanup();
        resolve({ ok: true });
      } catch (err) {
        try {
          res.end('<html><body>Something went wrong connecting to Google. Close this tab and try again.</body></html>');
        } catch (_) {}
        cleanup();
        reject(err);
      }
    });

    let settled = false;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for Google sign-in.'));
    }, CONNECT_TIMEOUT_MS);

    function cleanup() {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      server.close();
    }

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const redirectUri = `http://127.0.0.1:${port}`;
      const client = new OAuth2Client({ clientId, clientSecret, redirectUri });
      const authUrl = client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: SCOPES
      });
      shell.openExternal(authUrl);
    });
  });
}

async function getAccessToken() {
  const stored = secureStore.loadCalendarTokens();
  if (!stored || !stored.refreshToken) {
    throw new Error('Google Calendar is not connected. Connect it in Settings.');
  }
  const client = new OAuth2Client({ clientId: stored.clientId, clientSecret: stored.clientSecret });
  client.setCredentials({ refresh_token: stored.refreshToken });
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('Could not obtain a Google access token.');
  return token;
}

function addDaysISO(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function addHoursToTime(timeStr, hours) {
  const [h, m] = timeStr.split(':').map(Number);
  const total = (h * 60 + m + hours * 60) % (24 * 60);
  const endH = Math.floor(total / 60);
  const endM = total % 60;
  return String(endH).padStart(2, '0') + ':' + String(endM).padStart(2, '0');
}

function buildEventBody({ title, date, time, endTime, endDate, location }) {
  const isMultiDay = endDate && endDate !== date;
  const body = { summary: title };
  if (location) body.location = location;

  if (time) {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const finalEndDate = isMultiDay ? endDate : date;
    const finalEndTime = endTime || (isMultiDay ? time : addHoursToTime(time, 1));
    body.start = { dateTime: `${date}T${time}:00`, timeZone };
    body.end = { dateTime: `${finalEndDate}T${finalEndTime}:00`, timeZone };
  } else {
    const finalEndDate = isMultiDay ? endDate : date;
    body.start = { date };
    body.end = { date: addDaysISO(finalEndDate, 1) };
  }
  return body;
}

async function createEvent({ title, date, time, endTime, endDate, location }) {
  const token = await getAccessToken();
  const body = buildEventBody({ title, date, time, endTime, endDate, location });
  const res = await fetch(`${API_BASE}/calendars/primary/events`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Google Calendar rejected the event (${res.status}): ${text}`);
  }
  return res.json();
}

async function updateEvent({ eventId, title, date, time, endTime, endDate, location }) {
  const token = await getAccessToken();
  const body = buildEventBody({ title, date, time, endTime, endDate, location });
  const res = await fetch(`${API_BASE}/calendars/primary/events/${encodeURIComponent(eventId)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Google Calendar rejected the update (${res.status}): ${text}`);
  }
  return res.json();
}

async function deleteEvent({ eventId }) {
  const token = await getAccessToken();
  const res = await fetch(`${API_BASE}/calendars/primary/events/${encodeURIComponent(eventId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });
  // Google returns 204 on success and 410 if the event was already deleted -
  // both mean the event is gone, which is what the caller wanted.
  if (!res.ok && res.status !== 410) {
    const text = await res.text().catch(() => '');
    throw new Error(`Google Calendar rejected the delete (${res.status}): ${text}`);
  }
  return { ok: true };
}

async function listEvents({ timeMin, timeMax }) {
  const token = await getAccessToken();
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '250'
  });
  const res = await fetch(`${API_BASE}/calendars/primary/events?${params}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Could not list events (${res.status}): ${text}`);
  }
  const data = await res.json();
  return (data.items || []).map((e) => {
    const allDay = !!e.start.date;
    return {
      id: e.id,
      title: e.summary || '(untitled event)',
      location: e.location || null,
      startDate: allDay ? e.start.date : e.start.dateTime.slice(0, 10),
      startTime: allDay ? null : e.start.dateTime,
      endTime: allDay ? null : e.end.dateTime,
      // Google's all-day end.date is exclusive (the day after the last actual
      // day) - normalize to the inclusive last day so range checks elsewhere
      // (does this event cover day X?) don't count one day too many.
      endDate: allDay ? addDaysISO(e.end.date, -1) : e.end.dateTime.slice(0, 10),
      allDay
    };
  });
}

async function listUpcomingEvents() {
  const now = new Date();
  const in14Days = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  return listEvents({ timeMin: now.toISOString(), timeMax: in14Days.toISOString() });
}

module.exports = { getStatus, connect, createEvent, updateEvent, deleteEvent, listEvents, listUpcomingEvents, getAccessToken };
