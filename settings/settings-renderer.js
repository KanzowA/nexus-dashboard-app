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
