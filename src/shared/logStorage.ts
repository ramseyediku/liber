// Rolling scrape-activity log, storage.session (debug data, not durable).
import type { LogEntry } from "./types.ts";

const LOGS_KEY = "liber_logs";
const MAX_LOGS = 200;

export async function getLogs(): Promise<LogEntry[]> {
  const result = (await browser.storage.session.get(LOGS_KEY)) as Record<string, LogEntry[]>;
  return result[LOGS_KEY] || [];
}

export async function appendLog(entry: Omit<LogEntry, "timestamp">): Promise<void> {
  const logs = await getLogs();
  logs.push({ ...entry, timestamp: Date.now() });
  await browser.storage.session.set({ [LOGS_KEY]: logs.slice(-MAX_LOGS) });
}

export async function clearLogs(): Promise<void> {
  await browser.storage.session.remove(LOGS_KEY);
}

export async function getLogsForTab(tabId: number): Promise<LogEntry[]> {
  return (await getLogs()).filter((entry) => entry.tabId === tabId);
}

export async function clearLogsForTab(tabId: number): Promise<void> {
  const remaining = (await getLogs()).filter((entry) => entry.tabId !== tabId);
  await browser.storage.session.set({ [LOGS_KEY]: remaining });
}
