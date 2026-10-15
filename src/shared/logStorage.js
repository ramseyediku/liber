// Rolling diagnostic log of the on-page scraping flow (see content.js),
// kept in storage.session rather than storage.local — this is debugging
// data, not something that needs to survive a browser restart. One shared
// list rather than per-tab, since the dashboard shows it page-wide.

const LOGS_KEY = "liber_logs";
const MAX_LOGS = 200; // caps growth — oldest entries drop off first

export async function getLogs() {
  const stored = (await browser.storage.session.get(LOGS_KEY))[LOGS_KEY];
  return stored || [];
}

export async function appendLog(entry) {
  const logs = await getLogs();
  logs.push({ ...entry, timestamp: Date.now() });
  await browser.storage.session.set({
    [LOGS_KEY]: logs.slice(-MAX_LOGS),
  });
}

export async function clearLogs() {
  await browser.storage.session.remove(LOGS_KEY);
}
