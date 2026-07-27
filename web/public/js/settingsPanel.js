// In-page settings drawer, replacing the Electron settings window (which was
// a separate BrowserWindow - no such concept in a browser tab). Styling
// reuses the desktop app's settings.html dark-navy palette (#0f172a bg,
// #38bdf8 accent, #1e293b cards, #334155 borders) for visual continuity.
// Expects a container element #settingsPanel to already exist in index.html.
var settingsPanel = (function(){
  var el = null;

  function esc(s){
    var d = document.createElement("div");
    d.textContent = s == null ? "" : s;
    return d.innerHTML;
  }

  function fmtAgo(ts){
    if(!ts) return null;
    var diffMin = Math.round((Date.now()-ts)/60000);
    if(diffMin < 1) return "just now";
    if(diffMin < 60) return diffMin+"m ago";
    return Math.round(diffMin/60)+"h ago";
  }

  function render(){
    var connected = auth.isConnected();
    var email = auth.getConnectedEmail();
    var senderFilter = gmailApi.getSenderFilter();
    var detectForwarded = gmailApi.getDetectForwarded();
    var syncStatus = driveSync.getStatus();

    el.innerHTML =
      '<div class="settings-backdrop"></div>' +
      '<div class="settings-card">' +
        '<div class="settings-header">' +
          '<h2>Settings</h2>' +
          '<button class="settings-close" id="settingsCloseBtn" title="Close">&times;</button>' +
        '</div>' +

        '<h3>Google account</h3>' +
        '<p class="settings-sub">One sign-in covers both Calendar and Gmail.</p>' +
        (connected
          ? '<div class="settings-status connected">Connected as ' + esc(email || "unknown") + '</div>' +
            '<button class="settings-btn secondary" id="settingsSignOutBtn">Sign out</button>' +
            '<div class="settings-help"><a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener">Manage access on your Google account</a></div>'
          : '<button class="settings-btn" id="settingsSignInBtn">Sign in with Google</button>'
        ) +
        '<div class="settings-help">' +
          'This app is in Google\'s "Testing" mode, so your account needs to be added as a test user first (ask the app owner), and you may need to sign in again roughly every 7 days.' +
        '</div>' +

        '<hr/>' +

        '<h3>Sync across devices</h3>' +
        '<p class="settings-sub">Keeps to-dos, habits, and conferences in sync with the desktop app, via your own Google Drive - uses the same sign-in as above.</p>' +
        (!connected
          ? '<div class="settings-status">Not connected - sign in above first.</div>'
          : (syncStatus.insufficientScope
              ? '<div class="settings-status error">Reconnect your Google account to enable sync.</div>'
              : '<div class="settings-status ' + (syncStatus.lastSyncedAt ? "connected" : "") + '">' +
                  (syncStatus.lastSyncedAt ? "Synced " + fmtAgo(syncStatus.lastSyncedAt) + "." : "Connected - not synced yet.") +
                '</div>'
            ) +
            '<button class="settings-btn secondary" id="settingsSyncNowBtn">Sync now</button>'
        ) +

        '<hr/>' +

        '<h3>Inbox filtering <span class="settings-optional">(optional)</span></h3>' +
        '<label for="settingsSenderFilter">Only show mail from sender containing</label>' +
        '<input id="settingsSenderFilter" type="text" placeholder="e.g. a name or domain - leave blank to show all unread mail" value="' + esc(senderFilter) + '" />' +
        '<label class="settings-checkbox-row">' +
          '<input id="settingsDetectForwarded" type="checkbox" ' + (detectForwarded ? "checked" : "") + ' />' +
          '<span>Detect original sender/subject in forwarded mail</span>' +
        '</label>' +

      '</div>';

    el.querySelector(".settings-backdrop").addEventListener("click", toggle);
    var closeBtn = document.getElementById("settingsCloseBtn");
    if(closeBtn) closeBtn.addEventListener("click", toggle);

    var signInBtn = document.getElementById("settingsSignInBtn");
    if(signInBtn) signInBtn.addEventListener("click", function(){ auth.startSignIn(); });

    var signOutBtn = document.getElementById("settingsSignOutBtn");
    if(signOutBtn) signOutBtn.addEventListener("click", function(){ auth.signOut(); render(); if(window.onSettingsAuthChange) window.onSettingsAuthChange(); });

    var senderInput = document.getElementById("settingsSenderFilter");
    if(senderInput) senderInput.addEventListener("change", function(){ gmailApi.setSenderFilter(senderInput.value); });

    var forwardedCheckbox = document.getElementById("settingsDetectForwarded");
    if(forwardedCheckbox) forwardedCheckbox.addEventListener("change", function(){ gmailApi.setDetectForwarded(forwardedCheckbox.checked); });

    var syncNowBtn = document.getElementById("settingsSyncNowBtn");
    if(syncNowBtn) syncNowBtn.addEventListener("click", function(){
      syncNowBtn.disabled = true;
      driveSync.syncNow().then(function(){ syncNowBtn.disabled = false; render(); });
    });
  }

  function toggle(){
    el.classList.toggle("open");
    if(el.classList.contains("open")) render();
  }

  function init(){
    el = document.getElementById("settingsPanel");
  }

  return { init: init, toggle: toggle };
})();
