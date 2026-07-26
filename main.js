const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Menu, Notification, ipcMain } = require('electron');

// A dropped connection or socket timeout while checking Gmail/Calendar is a
// routine, expected event, not a reason to crash. Some of those show up as
// raw socket 'error' events from deep inside a library (imapflow/net/tls),
// which Node treats as fatal-by-default regardless of any try/catch around
// the code that triggered them, since they're not promise rejections.
// Without these handlers that surfaces as the native "A JavaScript error
// occurred in the main process" crash dialog and kills the whole app over a
// transient network hiccup. Log and keep running instead.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (app continues running):', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection (app continues running):', err);
});

Menu.setApplicationMenu(null);
if (process.platform === 'win32') {
  app.setAppUserModelId('com.axelkrappotke.nexusdashboard');
}
if (!app.isPackaged) {
  // Keep dev-mode runs (npm start) on a separate profile from the packaged
  // app, so testing never touches (or invalidates) the real saved
  // Gmail/Calendar connection.
  app.setPath('userData', path.join(app.getPath('userData'), 'dev'));
}
const secureStore = require('./src/secureStore');
const { getUnreadCount, getUnreadSummaries, markAsRead } = require('./src/mailChecker');
const googleCalendar = require('./src/googleCalendar');

const ICON_PNG = path.join(__dirname, 'assets', 'icon.png');

let mainWindow = null;
let settingsWindow = null;
let lastUnread = 0;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      createMainWindow();
    }
  });

  app.whenReady().then(() => {
    createMainWindow();

    if (!secureStore.hasCredentials()) {
      createSettingsWindow();
    } else {
      checkMail(false);
    }

    app.on('activate', () => {
      if (!mainWindow) createMainWindow();
      else mainWindow.show();
    });
  });

  // No tray, no background polling, nothing hanging around after the window
  // closes - closing the window (or all windows) fully quits the app and
  // ends the process, on every platform.
  app.on('window-all-closed', () => {
    app.quit();
  });

  ipcMain.handle('save-credentials', async (event, data) => {
    try {
      secureStore.saveCredentials(data);
      const result = await checkMail(false);
      if (!result.ok) {
        secureStore.clearCredentials();
        return { ok: false, error: 'Could not connect with those details. Check the address and App Password.' };
      }
      return { ok: true, unread: result.unread };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('check-mail-now', async () => checkMail(true));

  ipcMain.handle('open-settings', () => {
    createSettingsWindow();
    return { ok: true };
  });

  ipcMain.handle('get-inbox-summary', async () => {
    const creds = secureStore.loadCredentials();
    if (!creds) return { connected: false, emails: [] };
    try {
      const emails = await getUnreadSummaries(creds, 5);
      return { connected: true, emails };
    } catch (err) {
      return { connected: true, emails: [], error: err.message };
    }
  });

  ipcMain.handle('mark-email-read', async (event, uid) => {
    const creds = secureStore.loadCredentials();
    if (!creds) return { ok: false, error: 'No Gmail account connected.' };
    try {
      await markAsRead(creds, uid);
      await checkMail(false);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('get-calendar-status', async () => googleCalendar.getStatus());

  ipcMain.handle('connect-calendar', async (event, { clientId, clientSecret }) => {
    try {
      await googleCalendar.connect({ clientId, clientSecret });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('get-upcoming-events', async () => {
    if (!googleCalendar.getStatus().connected) return { connected: false, events: [] };
    try {
      const events = await googleCalendar.listUpcomingEvents();
      return { connected: true, events };
    } catch (err) {
      return { connected: true, events: [], error: err.message };
    }
  });

  ipcMain.handle('get-events-for-range', async (event, { timeMin, timeMax }) => {
    if (!googleCalendar.getStatus().connected) return { connected: false, events: [] };
    try {
      const events = await googleCalendar.listEvents({ timeMin, timeMax });
      return { connected: true, events };
    } catch (err) {
      return { connected: true, events: [], error: err.message };
    }
  });

  ipcMain.handle('create-calendar-event', async (event, { title, date, time, endTime, endDate, location }) => {
    if (!googleCalendar.getStatus().connected) {
      return { ok: false, error: 'Google Calendar is not connected. Connect it in Settings.' };
    }
    try {
      await googleCalendar.createEvent({ title, date, time, endTime, endDate, location });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // A main-process-owned copy of the renderer's localStorage data
  // (todos/habits/conferences/dailyStats), so a wiped or reset Chromium
  // Local Storage profile (e.g. from an Electron/Chromium upgrade) can be
  // recovered from disk instead of silently falling back to seeded dummy
  // data. Written on every save, read once at startup by the renderer.
  ipcMain.handle('backup-app-data', async (event, data) => {
    try {
      const backupPath = path.join(app.getPath('userData'), 'data-backup.json');
      await fs.promises.writeFile(backupPath, JSON.stringify(data), 'utf8');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('get-app-data-backup', async () => {
    try {
      const backupPath = path.join(app.getPath('userData'), 'data-backup.json');
      const raw = await fs.promises.readFile(backupPath, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      return null;
    }
  });

  ipcMain.handle('update-calendar-event', async (event, { eventId, title, date, time, endTime, endDate, location }) => {
    if (!googleCalendar.getStatus().connected) {
      return { ok: false, error: 'Google Calendar is not connected. Connect it in Settings.' };
    }
    try {
      await googleCalendar.updateEvent({ eventId, title, date, time, endTime, endDate, location });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('delete-calendar-event', async (event, { eventId }) => {
    if (!googleCalendar.getStatus().connected) {
      return { ok: false, error: 'Google Calendar is not connected. Connect it in Settings.' };
    }
    try {
      await googleCalendar.deleteEvent({ eventId });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('refresh-dashboard-data', async () => {
    const [inbox, calendar] = await Promise.all([
      (async () => {
        const creds = secureStore.loadCredentials();
        if (!creds) return { connected: false, emails: [] };
        try {
          return { connected: true, emails: await getUnreadSummaries(creds, 5) };
        } catch (err) {
          return { connected: true, emails: [], error: err.message };
        }
      })(),
      (async () => {
        if (!googleCalendar.getStatus().connected) return { connected: false, events: [] };
        try {
          return { connected: true, events: await googleCalendar.listUpcomingEvents() };
        } catch (err) {
          return { connected: true, events: [], error: err.message };
        }
      })()
    ]);
    return { inbox, calendar, syncedAt: new Date().toISOString() };
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    icon: ICON_PNG,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      backgroundThrottling: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'dashboard.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 460,
    height: 760,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Nexus Dashboard — Settings',
    icon: ICON_PNG,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true
    }
  });
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, 'settings', 'settings.html'));
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

async function checkMail(manual) {
  const creds = secureStore.loadCredentials();
  if (!creds) {
    if (manual) createSettingsWindow();
    return { ok: false, error: 'No account connected' };
  }

  try {
    const count = await getUnreadCount(creds);
    if (count > lastUnread) {
      new Notification({
        title: 'Nexus Dashboard',
        body: `${count} unread email${count === 1 ? '' : 's'} in Gmail`,
        icon: ICON_PNG
      }).show();
    }
    lastUnread = count;
    return { ok: true, unread: count };
  } catch (err) {
    console.error('Mail check failed:', err);
    if (manual) {
      new Notification({
        title: 'Nexus Dashboard',
        body: 'Could not check mail — verify your App Password in Settings.',
        icon: ICON_PNG
      }).show();
    }
    return { ok: false, error: err.message };
  }
}
