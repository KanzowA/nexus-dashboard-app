// Cross-device sync: one JSON file (nexus-sync-v1.json) in the signed-in user's
// own Google Drive "appDataFolder" - a hidden per-app storage space, invisible
// in their normal Drive UI. Reuses the same OAuth connection/token as Calendar
// (see googleCalendar.js's SCOPES) so there's no separate sign-in for this.
//
// Merge strategy is deliberately two-tier, matched to the shape of the data:
//   - todos / conferences / habitDefs: arrays of {id,...} items -> per-item
//     merge by `updatedAt`, with tombstones so a delete on one device doesn't
//     get resurrected by an unsynced copy still sitting on another device.
//   - habitLog / dailyStats: date-keyed maps -> whole-category last-write-wins,
//     which is enough for this low-stakes, easily-redone data.
//
// This file is kept in sync by hand with web/public/js/driveSync.js - same
// merge algorithm, ported (not shared) since the two apps don't share a build.

const googleCalendar = require('./googleCalendar');

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const SYNC_FILENAME = 'nexus-sync-v1.json';
const TOMBSTONE_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

let cachedFileId = null;

async function getAccessToken() {
  return googleCalendar.getAccessToken();
}

function driveError(status, text) {
  const err = new Error(`Drive request failed (${status}): ${text}`);
  err.driveStatus = status;
  err.insufficientScope = status === 403 && /insufficient/i.test(text || '');
  return err;
}

function emptyCategoryArray() {
  return { data: [], tombstones: [] };
}
function emptyCategoryMap() {
  return { updatedAt: 0, data: {} };
}
function emptySyncPayload() {
  return {
    version: 1,
    todos: emptyCategoryArray(),
    conferences: emptyCategoryArray(),
    habitDefs: emptyCategoryArray(),
    habitLog: emptyCategoryMap(),
    dailyStats: emptyCategoryMap()
  };
}

async function findFileId() {
  const token = await getAccessToken();
  const params = new URLSearchParams({
    spaces: 'appDataFolder',
    q: `name='${SYNC_FILENAME}' and trashed=false`,
    fields: 'files(id)'
  });
  const res = await fetch(`${DRIVE_API}/files?${params}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw driveError(res.status, text);
  }
  const data = await res.json();
  return (data.files && data.files[0] && data.files[0].id) || null;
}

async function createFile(content) {
  const token = await getAccessToken();
  const boundary = 'nexus-sync-boundary';
  const metadata = { name: SYNC_FILENAME, parents: ['appDataFolder'] };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(content)}\r\n` +
    `--${boundary}--`;
  const res = await fetch(`${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw driveError(res.status, text);
  }
  const data = await res.json();
  return data.id;
}

// Passes If-Match when we have a prior ETag so a concurrent write from another
// device surfaces as a 412 we can retry, instead of silently clobbering it.
async function updateFileContent(fileId, content, etag) {
  const token = await getAccessToken();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (etag) headers['If-Match'] = etag;
  const res = await fetch(`${DRIVE_UPLOAD_API}/files/${encodeURIComponent(fileId)}?uploadType=media`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(content)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw driveError(res.status, text);
  }
}

// Returns null (not an empty payload) on 404 so the caller can tell "file
// doesn't exist" (fall back to find-by-name) apart from "file exists but is
// genuinely empty".
async function readFileContent(fileId) {
  const token = await getAccessToken();
  const res = await fetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw driveError(res.status, text);
  }
  const etag = res.headers.get('etag') || res.headers.get('ETag') || null;
  const text = await res.text();
  if (!text) return { content: emptySyncPayload(), etag };
  try {
    return { content: JSON.parse(text), etag };
  } catch (_) {
    return { content: emptySyncPayload(), etag };
  }
}

async function fetchRemote() {
  if (cachedFileId) {
    const result = await readFileContent(cachedFileId);
    if (result !== null) return { fileId: cachedFileId, content: result.content, etag: result.etag };
    cachedFileId = null; // stale id (404) - fall through to re-resolve by name
  }
  const id = await findFileId();
  if (!id) return { fileId: null, content: emptySyncPayload(), etag: null };
  cachedFileId = id;
  const result = await readFileContent(id);
  if (result === null) return { fileId: id, content: emptySyncPayload(), etag: null };
  return { fileId: id, content: result.content, etag: result.etag };
}

// --- merge ---

function mergeArrayCategory(local, remote) {
  local = local || emptyCategoryArray();
  remote = remote || emptyCategoryArray();

  const tombstoneMap = new Map();
  for (const t of [...(local.tombstones || []), ...(remote.tombstones || [])]) {
    const existing = tombstoneMap.get(t.id);
    if (!existing || t.deletedAt > existing.deletedAt) tombstoneMap.set(t.id, t);
  }

  const itemMap = new Map();
  for (const item of [...(local.data || []), ...(remote.data || [])]) {
    const existing = itemMap.get(item.id);
    const itemUpdatedAt = item.updatedAt || 0;
    if (!existing || itemUpdatedAt > (existing.updatedAt || 0)) itemMap.set(item.id, item);
  }

  const now = Date.now();
  const tombstones = [];
  for (const t of tombstoneMap.values()) {
    if (now - t.deletedAt <= TOMBSTONE_MAX_AGE_MS) tombstones.push(t);
  }
  const data = [];
  for (const item of itemMap.values()) {
    const tomb = tombstoneMap.get(item.id);
    if (tomb && tomb.deletedAt >= (item.updatedAt || 0)) continue;
    data.push(item);
  }
  return { data, tombstones };
}

function mergeMapCategory(local, remote) {
  local = local || emptyCategoryMap();
  remote = remote || emptyCategoryMap();
  return (remote.updatedAt || 0) > (local.updatedAt || 0) ? remote : local;
}

function mergeSyncData(local, remote) {
  local = local || emptySyncPayload();
  remote = remote || emptySyncPayload();
  return {
    version: 1,
    todos: mergeArrayCategory(local.todos, remote.todos),
    conferences: mergeArrayCategory(local.conferences, remote.conferences),
    habitDefs: mergeArrayCategory(local.habitDefs, remote.habitDefs),
    habitLog: mergeMapCategory(local.habitLog, remote.habitLog),
    dailyStats: mergeMapCategory(local.dailyStats, remote.dailyStats)
  };
}

// One atomic pull -> merge -> push. Retries the whole cycle once on a 412
// (another device wrote in between our GET and our PATCH).
async function pullMergePush(localData) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { fileId, content: remote, etag } = await fetchRemote();
    const merged = mergeSyncData(localData, remote);
    try {
      if (fileId) {
        await updateFileContent(fileId, merged, etag);
      } else {
        cachedFileId = await createFile(merged);
      }
      return { ok: true, data: merged };
    } catch (err) {
      if (err.driveStatus === 412 && attempt < 2) continue;
      throw err;
    }
  }
}

async function getStatus() {
  const calStatus = googleCalendar.getStatus();
  return { connected: calStatus.connected };
}

module.exports = { pullMergePush, mergeSyncData, emptySyncPayload, getStatus };
