const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

// Only mail forwarded by this sender is shown in the inbox widget - the
// user's institutional account, which they forward to Gmail from.
const FORWARD_SENDER_FILTER = 'Kanzow, Alexander';

function makeClient({ email, appPassword }) {
  return new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: email, pass: appPassword },
    logger: false
  });
}

async function getUnreadCount(creds) {
  const client = makeClient(creds);
  await client.connect();
  try {
    const status = await client.status('INBOX', { unseen: true });
    return status.unseen || 0;
  } finally {
    await client.logout().catch(() => client.close());
  }
}

// Strips one or more leading "WG:"/"FW:"/"FWD:"/"AW:"/"RE:" reply/forward
// prefixes (German + English) so the real original subject is left over.
function stripForwardPrefixes(subject) {
  if (!subject) return subject;
  let prev;
  let s = subject;
  do {
    prev = s;
    s = s.replace(/^\s*(WG|FW|FWD|AW|RE)\s*:\s*/i, '');
  } while (s !== prev);
  return s.trim();
}

// "Name <email>" / "Name [mailto:email]" / "<email>" -> just the readable name.
function cleanOriginalFrom(raw) {
  if (!raw) return null;
  const angle = raw.match(/^(.*?)<[^>]+>\s*$/);
  if (angle && angle[1].trim()) return angle[1].trim().replace(/^["']|["']$/g, '');
  const mailto = raw.match(/^(.*?)\[mailto:[^\]]+\]\s*$/i);
  if (mailto && mailto[1].trim()) return mailto[1].trim().replace(/^["']|["']$/g, '');
  const emailOnly = raw.match(/^<?([^<>\s]+@[^<>\s]+)>?$/);
  if (emailOnly) return emailOnly[1];
  return raw.trim();
}

// Forwarded messages (Outlook/Exchange, German or English) embed the
// original message's headers as plain text lines in the body, e.g.
// "Von: Original Sender <x@y.com>" / "Betreff: Some subject" or the
// English "From:"/"Subject:" equivalents. Pull those out if present.
function parseForwardedOriginal(bodyText) {
  if (!bodyText) return null;
  const fromMatch = bodyText.match(/^(?:Von|From)\s*:\s*(.+)$/im);
  const subjectMatch = bodyText.match(/^(?:Betreff|Subject)\s*:\s*(.+)$/im);
  if (!fromMatch && !subjectMatch) return null;
  return {
    originalFrom: fromMatch ? cleanOriginalFrom(fromMatch[1]) : null,
    originalSubject: subjectMatch ? stripForwardPrefixes(subjectMatch[1].trim()) : null
  };
}

async function getUnreadSummaries(creds, limit = 10) {
  const client = makeClient(creds);
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = await client.search({ seen: false, from: FORWARD_SENDER_FILTER }, { uid: true });
      const recentUids = uids.slice(-limit).reverse();
      const results = [];

      for (const uid of recentUids) {
        let from = 'Unknown sender';
        let subject = '(no subject)';
        let date = new Date().toISOString();
        let snippet = '';

        for await (const msg of client.fetch(uid, { envelope: true }, { uid: true })) {
          if (msg.envelope) {
            const fromAddr = msg.envelope.from && msg.envelope.from[0];
            if (fromAddr) from = fromAddr.name || fromAddr.address;
            subject = stripForwardPrefixes(msg.envelope.subject || subject);
            date = msg.envelope.date ? new Date(msg.envelope.date).toISOString() : date;
          }
        }

        try {
          const { content } = await client.download(uid, undefined, { uid: true });
          const parsed = await simpleParser(content);
          const bodyText = parsed.text || '';
          snippet = bodyText.replace(/\s+/g, ' ').trim().slice(0, 140);

          const original = parseForwardedOriginal(bodyText);
          if (original) {
            if (original.originalFrom) from = original.originalFrom;
            if (original.originalSubject) subject = original.originalSubject;
          }
        } catch (_) {
          snippet = '';
        }

        results.push({ uid, from, subject, date, snippet });
      }

      return results;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => client.close());
  }
}

async function markAsRead(creds, uid) {
  const client = makeClient(creds);
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => client.close());
  }
}

module.exports = { getUnreadCount, getUnreadSummaries, markAsRead };
