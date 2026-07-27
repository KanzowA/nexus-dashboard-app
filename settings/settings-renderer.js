const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('appPassword');
const saveBtn = document.getElementById('saveBtn');
const statusEl = document.getElementById('status');

saveBtn.addEventListener('click', async () => {
  const email = emailInput.value.trim();
  const appPassword = passwordInput.value.replace(/\s+/g, '');

  if (!email || !appPassword) {
    statusEl.textContent = 'Please fill in both fields.';
    statusEl.className = 'error';
    return;
  }

  saveBtn.disabled = true;
  statusEl.textContent = 'Connecting…';
  statusEl.className = '';

  const result = await window.nexusAPI.saveCredentials({ email, appPassword });

  if (result.ok) {
    statusEl.textContent = `Connected — ${result.unread} unread right now.`;
    statusEl.className = 'ok';
  } else {
    statusEl.textContent = result.error || 'Could not connect. Check your App Password.';
    statusEl.className = 'error';
  }
  saveBtn.disabled = false;
});

const clientIdInput = document.getElementById('clientId');
const clientSecretInput = document.getElementById('clientSecret');
const calConnectBtn = document.getElementById('calConnectBtn');
const calStatusEl = document.getElementById('calStatus');

async function refreshCalendarStatus() {
  const status = await window.nexusAPI.getCalendarStatus();
  if (status.connected) {
    calStatusEl.textContent = 'Connected.';
    calStatusEl.className = 'connected';
  }
}
refreshCalendarStatus();

calConnectBtn.addEventListener('click', async () => {
  const clientId = clientIdInput.value.trim();
  const clientSecret = clientSecretInput.value.trim();

  if (!clientId || !clientSecret) {
    calStatusEl.textContent = 'Please fill in both fields.';
    calStatusEl.className = 'error';
    return;
  }

  calConnectBtn.disabled = true;
  calStatusEl.textContent = 'Opening your browser to sign in…';
  calStatusEl.className = '';

  const result = await window.nexusAPI.connectCalendar({ clientId, clientSecret });

  if (result.ok) {
    calStatusEl.textContent = 'Connected.';
    calStatusEl.className = 'connected';
  } else {
    calStatusEl.textContent = result.error || 'Could not connect to Google Calendar.';
    calStatusEl.className = 'error';
  }
  calConnectBtn.disabled = false;
});

const syncNowBtn = document.getElementById('syncNowBtn');
const syncStatusEl = document.getElementById('syncStatus');

function fmtAgo(ts) {
  if (!ts) return null;
  const diffMin = Math.round((Date.now() - ts) / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  return `${Math.round(diffMin / 60)}h ago`;
}

async function refreshSyncStatus() {
  const status = await window.nexusAPI.getSyncStatus();
  if (!status.connected) {
    syncStatusEl.textContent = 'Not connected — connect Google Calendar above first.';
    syncStatusEl.className = '';
    return;
  }
  const ago = fmtAgo(status.lastSyncedAt);
  syncStatusEl.textContent = ago ? `Synced ${ago}.` : 'Connected — not synced yet.';
  syncStatusEl.className = 'connected';
}
refreshSyncStatus();

syncNowBtn.addEventListener('click', async () => {
  syncNowBtn.disabled = true;
  syncStatusEl.textContent = 'Requesting sync…';
  syncStatusEl.className = '';

  // The actual data lives in the dashboard window, not here - this just asks
  // it to run its own sync-now flow (result/errors show as a toast there).
  const result = await window.nexusAPI.requestSync();
  if (result.ok) {
    syncStatusEl.textContent = 'Requested — check the dashboard window.';
    syncStatusEl.className = 'connected';
  } else {
    syncStatusEl.textContent = result.error || 'Could not request a sync.';
    syncStatusEl.className = 'error';
  }
  syncNowBtn.disabled = false;
  setTimeout(refreshSyncStatus, 3000);
});
