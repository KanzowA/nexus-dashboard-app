const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nexusAPI', {
  saveCredentials: (data) => ipcRenderer.invoke('save-credentials', data),
  checkMailNow: () => ipcRenderer.invoke('check-mail-now'),

  getInboxSummary: () => ipcRenderer.invoke('get-inbox-summary'),
  markEmailRead: (uid) => ipcRenderer.invoke('mark-email-read', uid),

  getCalendarStatus: () => ipcRenderer.invoke('get-calendar-status'),
  connectCalendar: (data) => ipcRenderer.invoke('connect-calendar', data),
  getUpcomingEvents: () => ipcRenderer.invoke('get-upcoming-events'),
  getEventsForRange: (range) => ipcRenderer.invoke('get-events-for-range', range),
  createCalendarEvent: (data) => ipcRenderer.invoke('create-calendar-event', data),
  updateCalendarEvent: (data) => ipcRenderer.invoke('update-calendar-event', data),
  deleteCalendarEvent: (data) => ipcRenderer.invoke('delete-calendar-event', data),

  refreshDashboardData: () => ipcRenderer.invoke('refresh-dashboard-data'),
  openSettings: () => ipcRenderer.invoke('open-settings'),

  backupAppData: (data) => ipcRenderer.invoke('backup-app-data', data),
  getAppDataBackup: () => ipcRenderer.invoke('get-app-data-backup'),

  syncNow: (data) => ipcRenderer.invoke('sync-now', data),
  getSyncStatus: () => ipcRenderer.invoke('get-sync-status'),
  requestSync: () => ipcRenderer.invoke('request-sync'),
  // Events, not invokes: main.js proactively pings the main window's
  // renderer (on focus, or on a Settings-window "Sync now" click) to run its
  // own sync-now flow, rather than main.js trying to hold a copy of
  // localStorage data itself.
  onTriggerSync: (callback) => ipcRenderer.on('trigger-sync', () => callback()),
  onTriggerSyncManual: (callback) => ipcRenderer.on('trigger-sync-manual', () => callback())
});
