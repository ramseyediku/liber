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
let activePopover = null;
// Defers a storage-triggered re-render until the popover closes, so it
// doesn't get blown away out from under the user's cursor.
let rerenderPending = false;
let profileData = null;
let expandedCell = null;
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
  // offsetWidth/offsetHeight, unlike getBoundingClientRect(), ignore the
  // entrance animation's transform: scale(), which would otherwise shrink
  // the measured size and misplace the popover.
  const left = Math.max(12, anchorRect.right - popover.offsetWidth);
  popover.style.left = `${left}px`;

  // The trigger sits pinned to the bottom of the sidebar, so the popover
  // would otherwise usually open straight off the bottom of the viewport —
  // flip it above the anchor when there isn't room below.
  const openUp = anchorRect.bottom + popover.offsetHeight + 10 > window.innerHeight;
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

  const openUp = anchorRect.bottom + menu.offsetHeight + 10 > window.innerHeight;
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

  pill.addEventListener("click", () => openStatusMenu(job, pill));

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

function collapseExpandedCell() {
  if (!expandedCell) return;
  expandedCell.classList.remove("dashboard__cell-content--expanded");
  expandedCell.style.top = "";
  expandedCell.style.left = "";
  expandedCell.style.minHeight = "";
  expandedCell = null;
  document.removeEventListener("mousedown", handleCellOutsideClick, true);
  window.removeEventListener("scroll", collapseExpandedCell, true);
}

function handleCellOutsideClick(event) {
  if (expandedCell && !expandedCell.contains(event.target)) {
    collapseExpandedCell();
  }
}

// position: fixed, placed at the cell's own on-screen rect — rather than
// position: absolute inside the (overflow-x: auto) table-wrap — so an
// expansion that reaches past the table's edge never grows the wrap's
// scrollable area and shifts the pagination nav below it.
function toggleCellExpand(span) {
  if (expandedCell === span) {
    collapseExpandedCell();
    return;
  }
  collapseExpandedCell();
  const rect = span.getBoundingClientRect();
  span.style.top = `${rect.top}px`;
  span.style.left = `${rect.left}px`;
  span.style.minHeight = `${rect.height}px`;
  span.classList.add("dashboard__cell-content--expanded");
  expandedCell = span;
  document.addEventListener("mousedown", handleCellOutsideClick, true);
  // The fixed overlay doesn't track the cell on scroll, so close it rather
  // than let it drift away from the row it belongs to.
  window.addEventListener("scroll", collapseExpandedCell, true);
}

/* Truncates with an ellipsis; clicking the cell expands it in place,
   Excel-style, instead of resizing the column. */
function buildTruncatedCell(text, className) {
  const td = document.createElement("td");
  if (className) td.className = className;

  const span = document.createElement("span");
  span.className = "dashboard__cell-content";
  span.textContent = text;
  span.title = text;
  span.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleCellExpand(span);
  });

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
  btn.addEventListener("click", () => openNotesPopover(job, btn));
  td.appendChild(btn);
  return td;
}

function buildRow(job) {
  const tr = document.createElement("tr");

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

function buildCard(job) {
  const card = document.createElement("div");
  card.className = "dashboard__card";

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

async function renderJobs() {
  closeActivePopover();
  collapseExpandedCell();
  const jobs = await getAllJobs();

  if (cardMode) {
    cardsList.innerHTML = "";
    if (jobs.length === 0) {
      cardsList.appendChild(buildEmptyCard());
      if (jobsCountEl) jobsCountEl.textContent = "";
      return;
    }
    jobs.slice(0, cardLimit).forEach((job) => cardsList.appendChild(buildCard(job)));
    if (jobsCountEl) {
      const shown = Math.min(cardLimit, jobs.length);
      jobsCountEl.textContent = `Showing ${shown} of ${jobs.length} application${jobs.length === 1 ? "" : "s"}`;
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
      .forEach((job) => tbody.appendChild(buildRow(job)));
  }

  renderPagination();
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

  // Re-render on storage changes from another context (e.g. a new job saved).
  browser.storage.onChanged.addListener((changes) => {
    if (!changes.liber_jobs) return;
    if (activePopover) {
      rerenderPending = true;
    } else {
      renderJobs();
    }
  });
}
