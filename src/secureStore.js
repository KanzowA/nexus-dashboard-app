const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

function makeStore(filename) {
  function filePath() {
    return path.join(app.getPath('userData'), filename);
  }
  function has() {
    return fs.existsSync(filePath());
  }
  function save(data) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS-level credential encryption is not available on this machine.');
    }
    const encrypted = safeStorage.encryptString(JSON.stringify(data));
    fs.writeFileSync(filePath(), encrypted);
  }
  function load() {
    if (!has()) return null;
    try {
      const encrypted = fs.readFileSync(filePath());
      return JSON.parse(safeStorage.decryptString(encrypted));
    } catch (err) {
      // Corrupt or undecryptable (e.g. written under a different OS user/key) -
      // treat as "nothing stored" rather than crashing every caller.
      console.error(`Could not decrypt ${filename}, discarding it:`, err.message);
      try { fs.unlinkSync(filePath()); } catch (_) {}
      return null;
    }
  }
  function clear() {
    if (has()) fs.unlinkSync(filePath());
  }
  return { has, save, load, clear };
}

const gmailStore = makeStore('credentials.bin');
const calendarStore = makeStore('calendar_tokens.bin');

module.exports = {
  hasCredentials: gmailStore.has,
  saveCredentials: gmailStore.save,
  loadCredentials: gmailStore.load,
  clearCredentials: gmailStore.clear,

  hasCalendarTokens: calendarStore.has,
  saveCalendarTokens: calendarStore.save,
  loadCalendarTokens: calendarStore.load,
  clearCalendarTokens: calendarStore.clear
};
