// Shared rendering logic for both dashboard pages. The full view renders
// every job as a table row; the popup (cardMode) renders a capped list of
// cards instead — only page chrome/CSS and this render mode differ.
import {
  getAllJobs,
  updateJob,
  deleteJob,
  getProfile,
  STATUS_META,
} from "../shared/storage.js";
import { getLogs, clearLogs } from "../shared/logStorage.js";

const EMPTY_MESSAGE =
  'No applications tracked yet. Click "Apply" on any job listing to start.';
const COLUMN_COUNT = 7;
const PAGE_SIZE = 10;

let tbody;
let cardsList;
let cardMode = false;
let cardLimit = 4;
let jobsCountEl;
let professionLabel;
let avatar;
let sidebarProfileTrigger;
let sidebarProfileName;
let sidebarProfileProfession;
let sidebarToggle;
let trashIconTemplate;
let chevronDownIconTemplate;
let checkIconTemplate;
let plusIconTemplate;
let paginationNav;
let paginationPages;
let paginationPrev;
let paginationNext;
let currentPage = 1;
let totalPages = 1;
let logsList;
let logsClearBtn;
let activePopover = null;

// The slide-in detail drawer (full view only — see initDashboard). detailJobId
// is the source of truth for which record is open; currentDetailJob is the
// object last handed to renderDetailPanel, kept around so the note textarea's
// input handler doesn't have to re-fetch/re-find it on every keystroke.
let detailOverlay;
let detailPanel;
let detailPositionEl;
let detailPrevBtn;
let detailNextBtn;
let detailCloseBtn;
let detailFooterCloseBtn;
let detailDeleteBtn;
let detailRoleEl;
let detailStatusGroup;
let detailCompanyEl;
let detailLocationEl;
let detailDateEl;
let detailNoteEl;
let detailJobId = null;
let currentDetailJob = null;
let detailFocusReturn = null;
// Defers a storage-triggered re-render until the popover closes, so it
// doesn't get blown away out from under the user's cursor.
let rerenderPending = false;
let profileData = null;
let dashboardEl;
// The button that opened the current popover — mousedown on it must not
// count as an "outside" click, or the popover closes and immediately
// reopens before the anchor's own click handler runs.
let activePopoverAnchor = null;

const SIDEBAR_COLLAPSED_KEY = "liber_sidebar_collapsed";

async function renderGreeting() {
  profileData = await getProfile();
  if (profileData) {
    if (professionLabel) professionLabel.textContent = profileData.profession;
    if (avatar)
      avatar.textContent = profileData.name.trim().charAt(0).toUpperCase();
    if (sidebarProfileName) sidebarProfileName.textContent = profileData.name;
    if (sidebarProfileProfession)
      sidebarProfileProfession.textContent = profileData.profession;
  }
}

function openProfilePopover(anchorBtn) {
  if (activePopover) return closeActivePopover();
  if (!profileData) return;

  const popover = document.createElement("div");
  popover.className = "dashboard__popover dashboard__profile-popover";

  const name = document.createElement("p");
  name.className = "dashboard__profile-popover-name";
  name.textContent = profileData.name;
  popover.appendChild(name);

  const profession = document.createElement("p");
  profession.className = "dashboard__profile-popover-profession";
  profession.textContent = `Tracking: ${profileData.profession}`;
  popover.appendChild(profession);

  document.body.appendChild(popover);

  const anchorRect = anchorBtn.getBoundingClientRect();
  // This popover only ever opens while the sidebar is collapsed (see the
  // click handler in initDashboard), where the trigger shrinks to just the
  // avatar, centered in the column — so anchoring to the button's own edge
  // would plant the popover half over the sidebar. Anchor to the sidebar
  // panel's own right edge instead, with a gap, so it always lands clear of
  // it.
  const sidebar = dashboardEl?.querySelector(".dashboard__aside");
  const sidebarRight = sidebar
    ? sidebar.getBoundingClientRect().right
    : anchorRect.right;
  // offsetWidth/offsetHeight, unlike getBoundingClientRect(), ignore the
  // entrance animation's transform: scale(), which would otherwise shrink
  // the measured size and misplace the popover.
  const left = Math.min(
    sidebarRight + 12,
    window.innerWidth - popover.offsetWidth - 12,
  );
  popover.style.left = `${left}px`;

  // The trigger sits pinned to the bottom of the sidebar, so the popover
  // would otherwise usually open straight off the bottom of the viewport —
  // flip it above the anchor when there isn't room below.
  const openUp =
    anchorRect.bottom + popover.offsetHeight + 10 > window.innerHeight;
  popover.style.top = openUp
    ? `${anchorRect.top - popover.offsetHeight - 10}px`
    : `${anchorRect.bottom + 10}px`;

  activePopover = popover;
  activePopoverAnchor = anchorBtn;

  document.addEventListener("mousedown", handleOutsideClick, true);
  document.addEventListener("keydown", handlePopoverKeydown, true);
}

function openStatusMenu(job, pill) {
  if (activePopover) return closeActivePopover();

  const menu = document.createElement("div");
  menu.className = "dashboard__popover dashboard__status-menu";
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", "Choose status");

  Object.entries(STATUS_META).forEach(([value, meta]) => {
    const option = document.createElement("button");
    option.type = "button";
    option.setAttribute("role", "option");
    option.className = "dashboard__status-option";
    const selected = value === job.status;
    option.setAttribute("aria-selected", selected ? "true" : "false");

    const dot = document.createElement("span");
    dot.className = `dashboard__status-dot dashboard__status-dot--${value}`;
    option.appendChild(dot);

    const label = document.createElement("span");
    label.textContent = meta.label;
    option.appendChild(label);

    if (selected) option.appendChild(checkIconTemplate.content.cloneNode(true));

    option.addEventListener("click", async () => {
      if (value !== job.status) {
        job.status = value;
        pill.className = `dashboard__status-pill dashboard__status-pill--${value}`;
        pill.querySelector("span").textContent = meta.label;
        pill.setAttribute("aria-label", `Status: ${meta.label}. Change status`);
        await updateJob(job.id, { status: value });
      }
      closeActivePopover();
    });

    menu.appendChild(option);
  });

  document.body.appendChild(menu);

  const anchorRect = pill.getBoundingClientRect();
  // offsetWidth/offsetHeight, unlike getBoundingClientRect(), ignore the
  // entrance animation's transform: scale(), which would otherwise shrink
  // the measured size and misplace the menu.
  let left = anchorRect.left;
  left = Math.min(left, window.innerWidth - menu.offsetWidth - 12);
  left = Math.max(12, left);
  menu.style.left = `${left}px`;

  const openUp =
    anchorRect.bottom + menu.offsetHeight + 10 > window.innerHeight;
  menu.style.top = openUp
    ? `${anchorRect.top - menu.offsetHeight - 6}px`
    : `${anchorRect.bottom + 6}px`;

  pill.setAttribute("aria-expanded", "true");
  activePopover = menu;
  activePopoverAnchor = pill;

  document.addEventListener("mousedown", handleOutsideClick, true);
  document.addEventListener("keydown", handlePopoverKeydown, true);
}

function buildStatusCell(job) {
  const td = document.createElement("td");

  const pill = document.createElement("button");
  pill.type = "button";
  pill.className = `dashboard__status-pill dashboard__status-pill--${job.status}`;
  pill.setAttribute("aria-haspopup", "listbox");
  pill.setAttribute("aria-expanded", "false");
  pill.setAttribute(
    "aria-label",
    `Status: ${STATUS_META[job.status].label}. Change status`,
  );

  const label = document.createElement("span");
  label.textContent = STATUS_META[job.status].label;
  pill.appendChild(label);
  pill.appendChild(chevronDownIconTemplate.content.cloneNode(true));

  pill.addEventListener("click", (event) => {
    event.stopPropagation();
    openStatusMenu(job, pill);
  });

  td.appendChild(pill);
  return td;
}

function closeActivePopover() {
  if (!activePopover) return;

  const el = activePopover;
  const anchor = activePopoverAnchor;
  activePopover = null;
  activePopoverAnchor = null;
  if (anchor && anchor.hasAttribute("aria-expanded")) {
    anchor.setAttribute("aria-expanded", "false");
  }
  document.removeEventListener("mousedown", handleOutsideClick, true);
  document.removeEventListener("keydown", handlePopoverKeydown, true);

  // Plays the pop-out animation, then detaches once it finishes instead
  // of vanishing instantly.
  el.classList.add("dashboard__popover--closing");
  el.addEventListener("animationend", () => el.remove(), { once: true });

  if (rerenderPending) {
    rerenderPending = false;
    renderJobs();
  }
}

function handleOutsideClick(event) {
  if (!activePopover || activePopover.contains(event.target)) return;
  // Let the anchor's own click handler (fired right after this mousedown)
  // decide whether to toggle closed — otherwise it reopens a fresh popover
  // a beat after this closes it.
  if (activePopoverAnchor && activePopoverAnchor.contains(event.target)) return;
  closeActivePopover();
}

function handlePopoverKeydown(event) {
  if (event.key === "Escape") closeActivePopover();
}

function openNotesPopover(job, anchorBtn) {
  if (activePopover) closeActivePopover();

  const popover = document.createElement("div");
  popover.className = "dashboard__popover dashboard__notes-popover";

  const textarea = document.createElement("textarea");
  textarea.placeholder = "Add a note…";
  textarea.value = job.notes || "";
  popover.appendChild(textarea);

  const actions = document.createElement("div");
  actions.className = "dashboard__notes-popover-actions";
  const doneBtn = document.createElement("button");
  doneBtn.type = "button";
  doneBtn.textContent = "Done";
  doneBtn.addEventListener("click", () => closeActivePopover());
  actions.appendChild(doneBtn);
  popover.appendChild(actions);

  document.body.appendChild(popover);

  const anchorRect = anchorBtn.getBoundingClientRect();
  // offsetWidth, unlike getBoundingClientRect(), ignores the entrance
  // animation's transform: scale(), which would otherwise shrink the
  // measured width and push the popover off-screen.
  // Opens leftward from the button's right edge, since it anchors to the
  // rightmost table columns.
  const left = Math.max(12, anchorRect.right - popover.offsetWidth);
  popover.style.left = `${left}px`;
  popover.style.top = `${anchorRect.bottom + 6}px`;

  textarea.addEventListener("input", async () => {
    job.notes = textarea.value;
    const label = anchorBtn.querySelector("span");
    if (label) label.textContent = job.notes ? "View my note" : "Add a note";
    anchorBtn.classList.toggle("dashboard__notes-btn--empty", !job.notes);
    await updateJob(job.id, { notes: job.notes.trim() });
  });

  textarea.focus();
  activePopover = popover;
  activePopoverAnchor = anchorBtn;

  document.addEventListener("mousedown", handleOutsideClick, true);
  document.addEventListener("keydown", handlePopoverKeydown, true);
}

function renderDetailStatus(job, jobs) {
  detailStatusGroup.innerHTML = "";

  Object.entries(STATUS_META).forEach(([value, meta]) => {
    const selected = value === job.status;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", selected ? "true" : "false");
    btn.className = "dashboard__detail-status-option";

    const dot = document.createElement("span");
    dot.className = `dashboard__status-dot dashboard__status-dot--${value}`;
    btn.appendChild(dot);

    const label = document.createElement("span");
    label.textContent = meta.label;
    btn.appendChild(label);

    btn.addEventListener("click", async () => {
      if (value === job.status) return;
      job.status = value;
      renderDetailPanel(job, jobs);
      await updateJob(job.id, { status: value });
    });

    detailStatusGroup.appendChild(btn);
  });
}

function renderDetailPanel(job, jobs) {
  if (!detailPanel) return;

  currentDetailJob = job;
  const index = jobs.findIndex((j) => j.id === job.id);

  detailPositionEl.textContent = `Application ${index + 1} of ${jobs.length}`;
  detailPrevBtn.disabled = index <= 0;
  detailNextBtn.disabled = index === -1 || index >= jobs.length - 1;

  detailRoleEl.textContent = job.jobTitle;
  detailCompanyEl.textContent = job.company;

  detailLocationEl.innerHTML = "";
  if (/^https?:\/\//.test(job.location || "")) {
    const link = document.createElement("a");
    link.href = job.location;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = job.location;
    detailLocationEl.appendChild(link);
  } else {
    detailLocationEl.textContent = job.location;
  }

  detailDateEl.textContent = new Date(job.dateAdded).toLocaleDateString();
  detailNoteEl.value = job.notes || "";

  detailPanel.setAttribute(
    "aria-label",
    `Application details for ${job.company}`,
  );
  detailDeleteBtn.setAttribute(
    "aria-label",
    `Delete ${job.company} application`,
  );

  renderDetailStatus(job, jobs);
}

// Re-syncs the open drawer (if any) whenever the job list is re-fetched —
// shared by storage-change re-renders and pagination, so the drawer never
// drifts from the table. Closes itself if its job was deleted elsewhere.
function syncDetailPanel(jobs) {
  if (!detailPanel || detailJobId === null) return;
  const job = jobs.find((j) => j.id === detailJobId);
  if (!job) {
    closeDetail();
    return;
  }
  renderDetailPanel(job, jobs);
}

function openDetail(job, jobs) {
  if (!detailPanel) return;
  closeActivePopover();
  detailJobId = job.id;
  renderDetailPanel(job, jobs);

  detailFocusReturn = document.activeElement;
  detailOverlay.classList.remove("dashboard__detail-overlay--closing");
  detailPanel.classList.remove("dashboard__detail--closing");
  detailOverlay.hidden = false;
  detailPanel.hidden = false;
  detailCloseBtn.focus();

  document.addEventListener("keydown", handleDetailKeydown);
}

function closeDetail() {
  detailJobId = null;
  currentDetailJob = null;
  if (!detailPanel || detailPanel.hidden) return;

  document.removeEventListener("keydown", handleDetailKeydown);
  detailOverlay.classList.add("dashboard__detail-overlay--closing");
  detailPanel.classList.add("dashboard__detail--closing");

  const finish = () => {
    detailOverlay.hidden = true;
    detailPanel.hidden = true;
    detailOverlay.classList.remove("dashboard__detail-overlay--closing");
    detailPanel.classList.remove("dashboard__detail--closing");
  };
  detailPanel.addEventListener("animationend", finish, { once: true });

  if (detailFocusReturn && document.contains(detailFocusReturn)) {
    detailFocusReturn.focus();
  }
  detailFocusReturn = null;
}

function handleDetailKeydown(event) {
  if (event.key === "Escape") closeDetail();
}

async function navigateDetail(delta) {
  if (detailJobId === null) return;
  const jobs = await getAllJobs();
  const index = jobs.findIndex((j) => j.id === detailJobId);
  const target = jobs[index + delta];
  if (!target) return;
  detailJobId = target.id;
  renderDetailPanel(target, jobs);
}

async function handleDetailDelete() {
  if (!currentDetailJob) return;
  const jobId = currentDetailJob.id;
  const jobs = await getAllJobs();
  const index = jobs.findIndex((j) => j.id === jobId);
  const next = jobs[index + 1] || jobs[index - 1];

  if (next) {
    const remaining = jobs.filter((j) => j.id !== jobId);
    detailJobId = next.id;
    renderDetailPanel(next, remaining);
  } else {
    closeDetail();
  }

  await deleteJob(jobId);
}

function handleDetailNoteInput() {
  if (!currentDetailJob) return;
  const value = detailNoteEl.value;
  currentDetailJob.notes = value;
  updateJob(currentDetailJob.id, { notes: value.trim() });
}

/* Truncates with an ellipsis; the title attribute surfaces the full text
   on hover. */
function buildTruncatedCell(text, className) {
  const td = document.createElement("td");
  if (className) td.className = className;

  const span = document.createElement("span");
  span.className = "dashboard__cell-content";
  span.textContent = text;
  span.title = text;

  td.appendChild(span);
  return td;
}

function buildNotesCell(job) {
  const td = document.createElement("td");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "dashboard__notes-btn";
  if (!job.notes) btn.classList.add("dashboard__notes-btn--empty");
  btn.appendChild(plusIconTemplate.content.cloneNode(true));
  const label = document.createElement("span");
  label.textContent = job.notes ? "View my note" : "Add a note";
  btn.appendChild(label);
  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    openNotesPopover(job, btn);
  });
  td.appendChild(btn);
  return td;
}

// jobs is the full (unpaginated) list, passed through so the detail drawer
// can report "Application X of Y" and page across the whole dataset.
function buildRow(job, jobs) {
  const tr = document.createElement("tr");
  tr.addEventListener("click", () => openDetail(job, jobs));

  tr.appendChild(buildTruncatedCell(job.company, "dashboard__col--company"));
  tr.appendChild(buildTruncatedCell(job.jobTitle, "dashboard__col--title"));
  tr.appendChild(buildTruncatedCell(job.location, "dashboard__col--full"));

  const dateTd = document.createElement("td");
  dateTd.className = "dashboard__col--full";
  dateTd.textContent = new Date(job.dateAdded).toLocaleDateString();
  tr.appendChild(dateTd);

  tr.appendChild(buildStatusCell(job));

  tr.appendChild(buildNotesCell(job));

  const actionsTd = document.createElement("td");

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "dashboard__delete";
  deleteBtn.setAttribute("aria-label", "Delete");
  deleteBtn.appendChild(trashIconTemplate.content.cloneNode(true));
  deleteBtn.addEventListener("click", async (event) => {
    event.stopPropagation();
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

// Only ever built in cardMode (the popup), so navigating to the full
// dashboard here mirrors the "View all" button's own behavior exactly.
function buildCard(job) {
  const card = document.createElement("div");
  card.className = "dashboard__card";
  card.addEventListener("click", () => {
    browser.tabs.create({
      url: browser.runtime.getURL("src/dashboard/dashboard-full.html"),
    });
    window.close();
  });

  const main = document.createElement("div");
  main.className = "dashboard__card-main";

  const title = document.createElement("p");
  title.className = "dashboard__card-title";
  title.textContent = job.jobTitle;
  main.appendChild(title);

  const meta = document.createElement("p");
  meta.className = "dashboard__card-meta";
  const dateAdded = new Date(job.dateAdded).toLocaleDateString();
  meta.textContent = `${job.company} · ${dateAdded}`;
  main.appendChild(meta);

  card.appendChild(main);

  const statusBadge = document.createElement("span");
  statusBadge.className = `dashboard__status-pill dashboard__status-pill--${job.status}`;
  statusBadge.textContent = STATUS_META[job.status].label;
  card.appendChild(statusBadge);

  return card;
}

function buildEmptyCard() {
  const div = document.createElement("div");
  div.className = "dashboard__empty";
  div.textContent = EMPTY_MESSAGE;
  return div;
}

// Shows a windowed set of page buttons centered on the current page, so the
// nav stays a fixed, reasonable width no matter how many pages there are.
function renderPagination() {
  if (!paginationNav) return;

  if (totalPages <= 1) {
    paginationNav.style.display = "none";
    return;
  }

  paginationNav.style.display = "";
  paginationPrev.disabled = currentPage === 1;
  paginationNext.disabled = currentPage === totalPages;

  paginationPages.innerHTML = "";
  const windowSize = 5;
  let start = Math.max(1, currentPage - Math.floor(windowSize / 2));
  const end = Math.min(totalPages, start + windowSize - 1);
  start = Math.max(1, end - windowSize + 1);

  for (let n = start; n <= end; n++) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dashboard__page-btn";
    btn.textContent = n;
    btn.setAttribute("aria-label", `Page ${n}`);
    if (n === currentPage) btn.setAttribute("aria-current", "page");
    btn.addEventListener("click", () => {
      if (n === currentPage) return;
      currentPage = n;
      renderJobs();
    });
    paginationPages.appendChild(btn);
  }
}

// Pretty-printed (not one-line) — each entry's detail now always carries
// jobInfoSoFar/multipleListingsDetected alongside whatever that step adds
// (see content.js's logStep), so there's enough nested structure that
// indentation is worth the extra height. Strings pass through as-is so a
// plain message doesn't get wrapped in quotes.
function formatLogDetail(detail) {
  if (detail == null) return "";
  if (typeof detail === "string") return detail;
  try {
    return JSON.stringify(detail, null, 2);
  } catch {
    return String(detail);
  }
}

function formatLogPage(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url || "";
  }
}

function buildLogRow(entry) {
  const li = document.createElement("li");
  li.className = "dashboard__log-row";

  const time = document.createElement("span");
  time.className = "dashboard__log-time";
  time.textContent = new Date(entry.timestamp).toLocaleTimeString();
  li.appendChild(time);

  const page = document.createElement("span");
  page.className = "dashboard__log-page";
  page.textContent = formatLogPage(entry.url);
  page.title = entry.url || "";
  li.appendChild(page);

  const step = document.createElement("span");
  step.className = "dashboard__log-step";
  step.textContent = entry.step;
  li.appendChild(step);

  const detailText = formatLogDetail(entry.detail);
  const detail = document.createElement("span");
  detail.className = "dashboard__log-detail";
  detail.textContent = detailText;
  detail.title = detailText;
  li.appendChild(detail);

  return li;
}

// Full view only (see initDashboard) — logStorage's rolling buffer backs
// this, and the storage.onChanged listener below keeps it live-refreshed
// as new scrape steps come in from content.js, without a page reload.
async function renderLogs() {
  if (!logsList) return;
  const logs = await getLogs();

  logsList.innerHTML = "";
  if (logs.length === 0) {
    const li = document.createElement("li");
    li.className = "dashboard__logs-empty";
    li.textContent =
      'No scrape activity yet. Click "Apply" on a job listing to see logs here.';
    logsList.appendChild(li);
    return;
  }

  // Newest first — getLogs() returns oldest-first (append order).
  logs
    .slice()
    .reverse()
    .forEach((entry) => logsList.appendChild(buildLogRow(entry)));
}

async function renderJobs() {
  closeActivePopover();
  const jobs = await getAllJobs();

  if (cardMode) {
    cardsList.innerHTML = "";
    if (jobs.length === 0) {
      cardsList.appendChild(buildEmptyCard());
      if (jobsCountEl) jobsCountEl.textContent = "";
      return;
    }
    jobs
      .slice(0, cardLimit)
      .forEach((job) => cardsList.appendChild(buildCard(job)));
    if (jobsCountEl) {
      const shown = Math.min(cardLimit, jobs.length);
      jobsCountEl.textContent = `Only showing ${shown} most recent application${jobs.length === 1 ? "" : "s"}`;
    }
    return;
  }

  totalPages = Math.max(1, Math.ceil(jobs.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;

  tbody.innerHTML = "";

  if (jobs.length === 0) {
    tbody.appendChild(buildEmptyRow());
  } else {
    const start = (currentPage - 1) * PAGE_SIZE;
    jobs
      .slice(start, start + PAGE_SIZE)
      .forEach((job) => tbody.appendChild(buildRow(job, jobs)));
  }

  renderPagination();
  syncDetailPanel(jobs);
}

// Only present on the full view — the popup has no room for a sidebar to
// collapse. Collapsed state persists across visits like the theme does.
function initSidebarToggle() {
  sidebarToggle = document.getElementById("sidebar-toggle");
  if (!sidebarToggle || !dashboardEl) return;

  const syncLabel = () => {
    const collapsed = dashboardEl.classList.contains("is-sidebar-collapsed");
    sidebarToggle.setAttribute(
      "aria-label",
      collapsed ? "Expand sidebar" : "Collapse sidebar",
    );
  };

  let collapsed = false;
  try {
    collapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
  } catch {
    // Storage may be unavailable (e.g. private browsing) — default open.
  }

  // Restoring a saved state shouldn't replay the collapse transition —
  // only a user-triggered click (below) should animate. Removed after the
  // first paint so later toggles transition normally.
  dashboardEl.classList.add("dashboard--no-transition");
  dashboardEl.classList.toggle("is-sidebar-collapsed", collapsed);
  syncLabel();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      dashboardEl.classList.remove("dashboard--no-transition");
    });
  });

  sidebarToggle.addEventListener("click", () => {
    dashboardEl.classList.toggle("is-sidebar-collapsed");
    syncLabel();
    try {
      localStorage.setItem(
        SIDEBAR_COLLAPSED_KEY,
        dashboardEl.classList.contains("is-sidebar-collapsed"),
      );
    } catch {
      // Ignore — nothing to persist to.
    }
  });
}

export function initDashboard(options = {}) {
  cardMode = !!options.cardMode;
  if (options.cardLimit) cardLimit = options.cardLimit;

  if (cardMode) {
    cardsList = document.getElementById("jobs-cards");
    jobsCountEl = document.getElementById("jobs-count");
  } else {
    sidebarProfileName = document.getElementById("profile-name");
    sidebarProfileProfession = document.getElementById("profile-profession");
    professionLabel = document.getElementById("profession-label");
    tbody = document.getElementById("jobs-tbody");
    trashIconTemplate = document.getElementById("trash-icon-template");
    chevronDownIconTemplate = document.getElementById(
      "chevron-down-icon-template",
    );
    checkIconTemplate = document.getElementById("check-icon-template");
    plusIconTemplate = document.getElementById("plus-icon-template");

    detailOverlay = document.getElementById("detail-overlay");
    detailPanel = document.getElementById("detail-panel");
    detailPositionEl = document.getElementById("detail-position");
    detailPrevBtn = document.getElementById("detail-prev");
    detailNextBtn = document.getElementById("detail-next");
    detailCloseBtn = document.getElementById("detail-close");
    detailFooterCloseBtn = document.getElementById("detail-footer-close");
    detailDeleteBtn = document.getElementById("detail-delete");
    detailRoleEl = document.getElementById("detail-role");
    detailStatusGroup = document.getElementById("detail-status");
    detailCompanyEl = document.getElementById("detail-company");
    detailLocationEl = document.getElementById("detail-location");
    detailDateEl = document.getElementById("detail-date");
    detailNoteEl = document.getElementById("detail-note");

    if (detailOverlay) detailOverlay.addEventListener("click", closeDetail);
    if (detailCloseBtn) detailCloseBtn.addEventListener("click", closeDetail);
    if (detailFooterCloseBtn)
      detailFooterCloseBtn.addEventListener("click", closeDetail);
    if (detailPrevBtn)
      detailPrevBtn.addEventListener("click", () => navigateDetail(-1));
    if (detailNextBtn)
      detailNextBtn.addEventListener("click", () => navigateDetail(1));
    if (detailDeleteBtn)
      detailDeleteBtn.addEventListener("click", handleDetailDelete);
    if (detailNoteEl)
      detailNoteEl.addEventListener("input", handleDetailNoteInput);

    paginationNav = document.getElementById("jobs-pagination");
    paginationPages = document.getElementById("pagination-pages");
    paginationPrev = document.getElementById("pagination-prev");
    paginationNext = document.getElementById("pagination-next");
    if (paginationPrev) {
      paginationPrev.addEventListener("click", () => {
        if (currentPage <= 1) return;
        currentPage--;
        renderJobs();
      });
    }
    if (paginationNext) {
      paginationNext.addEventListener("click", () => {
        if (currentPage >= totalPages) return;
        currentPage++;
        renderJobs();
      });
    }

    logsList = document.getElementById("logs-list");
    logsClearBtn = document.getElementById("logs-clear");
    if (logsClearBtn) {
      logsClearBtn.addEventListener("click", async () => {
        await clearLogs();
        renderLogs();
      });
    }
  }
  avatar = document.getElementById("user-avatar");
  sidebarProfileTrigger = document.getElementById("sidebar-profile-trigger");
  dashboardEl = document.querySelector(".dashboard");

  // The popup has no avatar/profile trigger of its own anymore — only the
  // full view's sidebar profile section opens the popover, and only while
  // the sidebar is collapsed (expanded, the name/profession are already
  // shown inline, so there's nothing the popover would add).
  if (sidebarProfileTrigger) {
    sidebarProfileTrigger.addEventListener("click", () => {
      if (!dashboardEl?.classList.contains("is-sidebar-collapsed")) return;
      openProfilePopover(sidebarProfileTrigger);
    });
  }

  initSidebarToggle();

  renderGreeting();
  renderJobs();
  renderLogs();

  // Re-render on storage changes from another context (e.g. a new job
  // saved, or a new scrape step logged by content.js/background.js).
  browser.storage.onChanged.addListener((changes) => {
    if (changes.liber_jobs) {
      if (activePopover) {
        rerenderPending = true;
      } else {
        renderJobs();
      }
    }
    if (changes.liber_logs) renderLogs();
  });
}
