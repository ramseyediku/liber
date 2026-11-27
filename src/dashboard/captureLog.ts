// Floating capture-log button for the full dashboard: opens a panel with what
// each capture did — what was captured, which source answered (the page's own
// data, a stored site structure, or Claude), whether Claude was called, and
// how the save ended. The entries are the rolling log background.ts and
// content.ts write to storage.session (shared/logStorage.ts), newest first.
//
// Shown on unpacked (dev) installs by default, or wherever Settings →
// Developer turns it on.
import { isDevInstall } from "../shared/demoData.ts";
import { clearLogs, getLogs } from "../shared/logStorage.ts";
import type { LogEntry } from "../shared/types.ts";

const LOG_BUTTON_FLAG = "liber_show_log_button";
const LOGS_KEY = "liber_logs";
const HOST_ID = "capture-log";

let host: HTMLElement | null = null;
let panel: HTMLElement | null = null;
let dot: HTMLElement | null = null;

async function shouldShow(): Promise<boolean> {
  const stored = ((await browser.storage.local.get(LOG_BUTTON_FLAG)) as Record<string, unknown>)[
    LOG_BUTTON_FLAG
  ];
  return typeof stored === "boolean" ? stored : isDevInstall();
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

// The latest "capture summary" entry, as label/value rows.
function summaryRows(entries: LogEntry[]): [string, string][] | null {
  const latest = [...entries].reverse().find((e) => e.step === "capture summary");
  if (!latest || !latest.detail || typeof latest.detail !== "object") return null;
  const d = latest.detail as Record<string, unknown>;
  const text = (v: unknown) => (v === undefined || v === null || v === "" ? "—" : String(v));
  return [
    ["Site", text(d.hostname)],
    ["Method", text(d.method)],
    ["Claude", text(d.claude)],
    ["Site structure", text(d.structure)],
    ["Result", text(d.outcome)],
  ];
}

async function renderPanel(): Promise<void> {
  if (!panel) return;
  const body = panel.querySelector<HTMLElement>(".capture-log__body")!;
  body.replaceChildren();

  const entries = await getLogs();
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "capture-log__empty";
    empty.textContent = "Nothing captured yet. Click an Apply button on a job page, then come back.";
    body.appendChild(empty);
    return;
  }

  const rows = summaryRows(entries);
  if (rows) {
    const dl = document.createElement("dl");
    dl.className = "capture-log__summary";
    for (const [label, value] of rows) {
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      dl.append(dt, dd);
    }
    body.appendChild(dl);
  }

  const list = document.createElement("div");
  list.className = "capture-log__list";
  for (const entry of [...entries].reverse()) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    const time = document.createElement("span");
    time.className = "capture-log__time";
    time.textContent = new Date(entry.timestamp).toLocaleTimeString();
    const step = document.createElement("span");
    step.textContent = entry.step;
    summary.append(time, step);
    const site = hostOf(entry.url);
    if (site) {
      const tag = document.createElement("span");
      tag.className = "capture-log__site";
      tag.textContent = site;
      summary.appendChild(tag);
    }
    details.appendChild(summary);
    if (entry.detail !== null && entry.detail !== undefined) {
      const pre = document.createElement("pre");
      pre.textContent = JSON.stringify(entry.detail, null, 2).slice(0, 4000);
      details.appendChild(pre);
    }
    list.appendChild(details);
  }
  body.appendChild(list);
}

function closePanel(): void {
  panel?.remove();
  panel = null;
}

function openPanel(): void {
  if (!host || panel) return;
  if (dot) dot.hidden = true;

  panel = document.createElement("div");
  panel.className = "capture-log__panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Capture log");

  const head = document.createElement("div");
  head.className = "capture-log__head";
  const title = document.createElement("strong");
  title.textContent = "Capture log";
  const clear = document.createElement("button");
  clear.type = "button";
  clear.textContent = "Clear";
  clear.addEventListener("click", async () => {
    await clearLogs();
    renderPanel();
  });
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Close";
  close.addEventListener("click", closePanel);
  head.append(title, clear, close);

  const body = document.createElement("div");
  body.className = "capture-log__body";
  panel.append(head, body);
  host.appendChild(panel);
  renderPanel();
}

function mount(): void {
  if (host) return;
  host = document.createElement("div");
  host.id = HOST_ID;
  host.className = "capture-log";

  const fab = document.createElement("button");
  fab.type = "button";
  fab.className = "capture-log__fab";
  fab.setAttribute("aria-label", "Capture log");
  fab.title = "Capture log";
  fab.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>';
  dot = document.createElement("span");
  dot.className = "capture-log__dot";
  dot.hidden = true;
  fab.appendChild(dot);
  fab.addEventListener("click", () => (panel ? closePanel() : openPanel()));

  host.appendChild(fab);
  document.body.appendChild(host);
}

function unmount(): void {
  closePanel();
  host?.remove();
  host = null;
  dot = null;
}

async function sync(): Promise<void> {
  if (await shouldShow()) mount();
  else unmount();
}

export function initCaptureLog(): void {
  sync().catch((err) => console.warn("Liber: capture log button failed", err));

  browser.storage.onChanged.addListener(
    (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
      if (area === "local" && changes[LOG_BUTTON_FLAG]) {
        sync().catch(() => {});
      } else if (area === "session" && changes[LOGS_KEY]) {
        if (panel) renderPanel();
        else if (dot) dot.hidden = false; // new activity while closed
      }
    },
  );
}
