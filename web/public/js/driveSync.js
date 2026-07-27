// Cross-device sync: one JSON file (nexus-sync-v1.json) in the signed-in
// user's own Google Drive "appDataFolder" - a hidden per-app storage space,
// invisible in their normal Drive UI. Reuses the same OAuth connection/token
// as Calendar/Gmail (see auth.js's SCOPE), no separate sign-in for this.
//
// This is the web/browser twin of src/driveSync.js (Electron) - same merge
// algorithm, ported (not shared) since the two apps don't share a build.
// Keep the two in sync by hand if the merge rules ever change.
var driveSync = (function(){
  var DRIVE_API = "https://www.googleapis.com/drive/v3";
  var DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
  var SYNC_FILENAME = "nexus-sync-v1.json";
  var TOMBSTONE_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
  var SYNC_DEBOUNCE_MS = 4000;
  var FOCUS_MIN_INTERVAL_MS = 30 * 1000;

  var cachedFileId = null;
  var syncDebounceTimer = null;
  var syncInFlight = false;
  var syncQueued = false;
  var lastSyncStatus = { state:"idle", at:null, error:null, insufficientScope:false };
  var applyCallback = null; // set via init(), called with merged data after a successful sync
  var toastCallback = null; // set via init(), for manual-sync feedback

  async function getAccessToken(){
    var token = await auth.getValidAccessToken();
    if(!token) throw new Error("Not connected. Connect your Google account in Settings.");
    return token;
  }

  function driveError(status, text){
    var err = new Error("Drive request failed (" + status + "): " + text);
    err.driveStatus = status;
    err.insufficientScope = status === 403 && /insufficient/i.test(text || "");
    return err;
  }

  function emptyCategoryArray(){ return { data: [], tombstones: [] }; }
  function emptyCategoryMap(){ return { updatedAt: 0, data: {} }; }
  function emptySyncPayload(){
    return {
      version: 1,
      todos: emptyCategoryArray(),
      conferences: emptyCategoryArray(),
      habitDefs: emptyCategoryArray(),
      habitLog: emptyCategoryMap(),
      dailyStats: emptyCategoryMap()
    };
  }

  async function findFileId(){
    var token = await getAccessToken();
    var params = new URLSearchParams({
      spaces: "appDataFolder",
      q: "name='" + SYNC_FILENAME + "' and trashed=false",
      fields: "files(id)"
    });
    var res = await fetch(DRIVE_API + "/files?" + params, {
      headers: { Authorization: "Bearer " + token }
    });
    if(!res.ok){
      var text = await res.text().catch(function(){ return ""; });
      throw driveError(res.status, text);
    }
    var data = await res.json();
    return (data.files && data.files[0] && data.files[0].id) || null;
  }

  async function createFile(content){
    var token = await getAccessToken();
    var boundary = "nexus-sync-boundary";
    var metadata = { name: SYNC_FILENAME, parents: ["appDataFolder"] };
    var body =
      "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + JSON.stringify(metadata) + "\r\n" +
      "--" + boundary + "\r\nContent-Type: application/json\r\n\r\n" + JSON.stringify(content) + "\r\n" +
      "--" + boundary + "--";
    var res = await fetch(DRIVE_UPLOAD_API + "/files?uploadType=multipart&fields=id", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "multipart/related; boundary=" + boundary },
      body: body
    });
    if(!res.ok){
      var text = await res.text().catch(function(){ return ""; });
      throw driveError(res.status, text);
    }
    var data = await res.json();
    return data.id;
  }

  // Passes If-Match when we have a prior ETag so a concurrent write from
  // another device surfaces as a 412 we can retry, instead of silently
  // clobbering it.
  async function updateFileContent(fileId, content, etag){
    var token = await getAccessToken();
    var headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
    if(etag) headers["If-Match"] = etag;
    var res = await fetch(DRIVE_UPLOAD_API + "/files/" + encodeURIComponent(fileId) + "?uploadType=media", {
      method: "PATCH",
      headers: headers,
      body: JSON.stringify(content)
    });
    if(!res.ok){
      var text = await res.text().catch(function(){ return ""; });
      throw driveError(res.status, text);
    }
  }

  // Returns null on 404 so the caller can tell "file doesn't exist" (fall
  // back to find-by-name) apart from "file exists but is genuinely empty".
  async function readFileContent(fileId){
    var token = await getAccessToken();
    var res = await fetch(DRIVE_API + "/files/" + encodeURIComponent(fileId) + "?alt=media", {
      headers: { Authorization: "Bearer " + token }
    });
    if(res.status === 404) return null;
    if(!res.ok){
      var text = await res.text().catch(function(){ return ""; });
      throw driveError(res.status, text);
    }
    var etag = res.headers.get("etag") || res.headers.get("ETag") || null;
    var text2 = await res.text();
    if(!text2) return { content: emptySyncPayload(), etag: etag };
    try {
      return { content: JSON.parse(text2), etag: etag };
    } catch(e){
      return { content: emptySyncPayload(), etag: etag };
    }
  }

  async function fetchRemote(){
    if(cachedFileId){
      var result = await readFileContent(cachedFileId);
      if(result !== null) return { fileId: cachedFileId, content: result.content, etag: result.etag };
      cachedFileId = null; // stale id (404) - fall through to re-resolve by name
    }
    var id = await findFileId();
    if(!id) return { fileId: null, content: emptySyncPayload(), etag: null };
    cachedFileId = id;
    var result2 = await readFileContent(id);
    if(result2 === null) return { fileId: id, content: emptySyncPayload(), etag: null };
    return { fileId: id, content: result2.content, etag: result2.etag };
  }

  // --- merge ---

  function mergeArrayCategory(local, remote){
    local = local || emptyCategoryArray();
    remote = remote || emptyCategoryArray();

    var tombstoneMap = {};
    (local.tombstones || []).concat(remote.tombstones || []).forEach(function(t){
      var existing = tombstoneMap[t.id];
      if(!existing || t.deletedAt > existing.deletedAt) tombstoneMap[t.id] = t;
    });

    var itemMap = {};
    (local.data || []).concat(remote.data || []).forEach(function(item){
      var existing = itemMap[item.id];
      var itemUpdatedAt = item.updatedAt || 0;
      if(!existing || itemUpdatedAt > (existing.updatedAt || 0)) itemMap[item.id] = item;
    });

    var now = Date.now();
    var tombstones = [];
    Object.keys(tombstoneMap).forEach(function(id){
      var t = tombstoneMap[id];
      if(now - t.deletedAt <= TOMBSTONE_MAX_AGE_MS) tombstones.push(t);
    });
    var data = [];
    Object.keys(itemMap).forEach(function(id){
      var item = itemMap[id];
      var tomb = tombstoneMap[id];
      if(tomb && tomb.deletedAt >= (item.updatedAt || 0)) return;
      data.push(item);
    });
    return { data: data, tombstones: tombstones };
  }

  function mergeMapCategory(local, remote){
    local = local || emptyCategoryMap();
    remote = remote || emptyCategoryMap();
    return (remote.updatedAt || 0) > (local.updatedAt || 0) ? remote : local;
  }

  function mergeSyncData(local, remote){
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
  async function pullMergePush(localData){
    for(var attempt = 1; attempt <= 2; attempt++){
      var remoteResult = await fetchRemote();
      var merged = mergeSyncData(localData, remoteResult.content);
      try {
        if(remoteResult.fileId){
          await updateFileContent(remoteResult.fileId, merged, remoteResult.etag);
        } else {
          cachedFileId = await createFile(merged);
        }
        return { ok: true, data: merged };
      } catch(err){
        if(err.driveStatus === 412 && attempt < 2) continue;
        throw err;
      }
    }
  }

  // --- orchestration ---

  // Background-triggered syncs (startup/debounce/focus) fail quietly - only
  // a manual "Sync now" click surfaces an error immediately.
  async function runSync(manual, gatherLocalData){
    if(syncInFlight){ syncQueued = true; return; }
    syncInFlight = true;
    try {
      var result = await pullMergePush(gatherLocalData());
      syncInFlight = false;
      lastSyncStatus = { state:"synced", at:Date.now(), error:null, insufficientScope:false };
      if(applyCallback) applyCallback(result.data);
      if(manual && toastCallback) toastCallback("Synced.");
    } catch(err){
      syncInFlight = false;
      var insufficientScope = !!err.insufficientScope;
      lastSyncStatus = { state:"error", at:Date.now(), error: err.message, insufficientScope: insufficientScope };
      if(manual && toastCallback){
        toastCallback(insufficientScope ? "Reconnect your Google account to enable sync." : (err.message || "Sync failed."), true);
      }
    }
    if(syncQueued){ syncQueued = false; runSync(false, gatherLocalData); }
  }

  var gatherFn = null;

  function init(opts){
    gatherFn = opts.gather;
    applyCallback = opts.apply;
    toastCallback = opts.toast || null;

    var lastFocusSync = 0;
    document.addEventListener("visibilitychange", function(){
      if(document.visibilityState !== "visible") return;
      if(Date.now() - lastFocusSync < FOCUS_MIN_INTERVAL_MS) return;
      if(!auth.isConnected()) return;
      lastFocusSync = Date.now();
      runSync(false, gatherFn);
    });
  }

  function syncOnLoad(){
    if(!gatherFn || !auth.isConnected()) return;
    runSync(false, gatherFn);
  }

  function scheduleSync(){
    if(!gatherFn) return;
    if(syncDebounceTimer) clearTimeout(syncDebounceTimer);
    syncDebounceTimer = setTimeout(function(){
      syncDebounceTimer = null;
      runSync(false, gatherFn);
    }, SYNC_DEBOUNCE_MS);
  }

  function syncNow(){
    if(!gatherFn) return;
    return runSync(true, gatherFn);
  }

  function getStatus(){
    return {
      connected: auth.isConnected(),
      state: lastSyncStatus.state,
      lastSyncedAt: lastSyncStatus.state === "synced" ? lastSyncStatus.at : null,
      error: lastSyncStatus.error,
      insufficientScope: lastSyncStatus.insufficientScope
    };
  }

  return {
    init: init,
    syncOnLoad: syncOnLoad,
    scheduleSync: scheduleSync,
    syncNow: syncNow,
    getStatus: getStatus,
    mergeSyncData: mergeSyncData
  };
})();
