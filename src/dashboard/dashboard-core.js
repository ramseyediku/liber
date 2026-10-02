// src/dashboard/dashboard-core.js
// Shared rendering logic for both dashboard pages (the popup and the full
// view). Both pages have identical table markup — only their page chrome
// (sidebar, header) and CSS differ — so this module is the single place
// that builds rows, handles the notes popover, and re-renders on storage
// changes.
import {
  getAllJobs,
  updateJob,
  deleteJob,
  getProfile,
  STATUS_META,
} from "../shared/storage.js";

const EMPTY_MESSAGE =
  'No applications tracked yet. Click "Apply" on any job listing to get started.';
const COLUMN_COUNT = 7;
// src/assets/icons/trash.svg, inlined so its stroke can pick up currentColor.
const TRASH_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>`;

let tbody;
let greeting;
let avatar;
let activePopover = null;
// A storage change (e.g. our own notes edit, or a job saved from another
// tab) normally triggers a full re-render — but re-rendering while the
// notes popover is open would blow it away out from under the user's
// cursor. Defer it until the popover closes instead.
let rerenderPending = false;

async function renderGreeting() {
  const profile = await getProfile();
  if (profile) {
    greeting.textContent = `Tracking ${profile.profession} roles`;
    if (avatar)
      avatar.textContent = profile.name.trim().charAt(0).toUpperCase();
  }
}

function buildStatusSelect(job) {
  const select = document.createElement("select");
  select.className = `dashboard__select dashboard__select--${job.status}`;

  Object.entries(STATUS_META).forEach(([value, meta]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = meta.label;
    if (value === job.status) option.selected = true;
    select.appendChild(option);
  });

  select.addEventListener("change", async () => {
    await updateJob(job.id, { status: select.value });
    select.className = `dashboard__select dashboard__select--${select.value}`;
  });

  return select;
}

function closeNotesPopover() {
  activePopover?.remove();
  activePopover = null;
  document.removeEventListener("mousedown", handleOutsideClick, true);
  document.removeEventListener("keydown", handlePopoverKeydown, true);

  if (rerenderPending) {
    rerenderPending = false;
    renderJobs();
  }
}

function handleOutsideClick(event) {
  if (activePopover && !activePopover.contains(event.target)) {
    closeNotesPopover();
  }
}

function handlePopoverKeydown(event) {
  if (event.key === "Escape") closeNotesPopover();
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max).trim()}…` : text;
}

function openNotesPopover(job, anchorBtn) {
  if (activePopover) closeNotesPopover();

  const popover = document.createElement("div");
  popover.className = "dashboard__notes-popover";

  const textarea = document.createElement("textarea");
  textarea.placeholder = "Add a note…";
  textarea.value = job.notes || "";
  popover.appendChild(textarea);

  const actions = document.createElement("div");
  actions.className = "dashboard__notes-popover-actions";
  const doneBtn = document.createElement("button");
  doneBtn.type = "button";
  doneBtn.textContent = "Done";
  doneBtn.addEventListener("click", () => closeNotesPopover());
  actions.appendChild(doneBtn);
  popover.appendChild(actions);

  document.body.appendChild(popover);

  const anchorRect = anchorBtn.getBoundingClientRect();
  const popoverRect = popover.getBoundingClientRect();
  const left = Math.max(
    12,
    Math.min(anchorRect.left, window.innerWidth - popoverRect.width - 12),
  );
  popover.style.left = `${left}px`;
  popover.style.top = `${anchorRect.bottom + 6}px`;
  // Pop the popover in from whichever side sits nearest the button that
  // opened it, so the animation reads as coming out of the button.
  popover.style.transformOrigin =
    left < anchorRect.left ? "top right" : "top left";

  textarea.addEventListener("input", async () => {
    job.notes = textarea.value;
    anchorBtn.textContent = job.notes ? truncate(job.notes, 24) : "Add note";
    anchorBtn.classList.toggle("dashboard__notes-btn--empty", !job.notes);
    await updateJob(job.id, { notes: job.notes.trim() });
  });

  textarea.focus();
  activePopover = popover;

  document.addEventListener("mousedown", handleOutsideClick, true);
  document.addEventListener("keydown", handlePopoverKeydown, true);
}

function buildNotesCell(job) {
  const td = document.createElement("td");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "dashboard__notes-btn";
  if (!job.notes) btn.classList.add("dashboard__notes-btn--empty");
  btn.textContent = job.notes ? truncate(job.notes, 24) : "Add note";
  btn.addEventListener("click", () => openNotesPopover(job, btn));
  td.appendChild(btn);
  return td;
}

function buildRow(job) {
  const tr = document.createElement("tr");

  const companyTd = document.createElement("td");
  companyTd.className = "dashboard__col--company";
  companyTd.textContent = job.company;
  companyTd.title = job.company;
  tr.appendChild(companyTd);

  const titleTd = document.createElement("td");
  titleTd.className = "dashboard__col--title";
  titleTd.textContent = job.jobTitle;
  titleTd.title = job.jobTitle;
  tr.appendChild(titleTd);

  const locationTd = document.createElement("td");
  locationTd.className = "dashboard__col--full";
  locationTd.textContent = job.location;
  tr.appendChild(locationTd);

  const dateTd = document.createElement("td");
  dateTd.className = "dashboard__col--full";
  dateTd.textContent = new Date(job.dateAdded).toLocaleDateString();
  tr.appendChild(dateTd);

  const statusTd = document.createElement("td");
  statusTd.appendChild(buildStatusSelect(job));
  tr.appendChild(statusTd);

  tr.appendChild(buildNotesCell(job));

  const actionsTd = document.createElement("td");
  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "dashboard__delete";
  deleteBtn.setAttribute("aria-label", "Delete");
  deleteBtn.innerHTML = TRASH_ICON;
  deleteBtn.addEventListener("click", async () => {
    await deleteJob(job.id);
    tr.remove();
  });
  actionsTd.appendChild(deleteBtn);
  tr.appendChild(actionsTd);

  return tr;
}

function buildEmptyRow() {
  const tr = document.createElement("tr");
  const td = document.createElement("td");
  td.colSpan = COLUMN_COUNT;
  td.className = "dashboard__empty";
  td.textContent = EMPTY_MESSAGE;
  tr.appendChild(td);
  return tr;
}

async function renderJobs() {
  closeNotesPopover();
  const jobs = await getAllJobs();
  tbody.innerHTML = "";

  if (jobs.length === 0) {
    tbody.appendChild(buildEmptyRow());
    return;
  }

  jobs.forEach((job) => tbody.appendChild(buildRow(job)));
}

export function initDashboard() {
  tbody = document.getElementById("jobs-tbody");
  greeting = document.getElementById("greeting");
  avatar = document.getElementById("user-avatar");

  renderGreeting();
  renderJobs();

  // Re-render if storage changes from another context (e.g. a new job just saved).
  browser.storage.onChanged.addListener((changes) => {
    if (!changes.liber_jobs) return;
    if (activePopover) {
      rerenderPending = true;
    } else {
      renderJobs();
    }
  });
}
