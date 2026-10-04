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

let tbody;
let cardsList;
let cardMode = false;
let cardLimit = 5;
let greeting;
let avatar;
let sidebarToggle;
let trashIconTemplate;
let activePopover = null;
// Defers a storage-triggered re-render until the popover closes, so it
// doesn't get blown away out from under the user's cursor.
let rerenderPending = false;
let profileData = null;
let expandedCell = null;
// The button that opened the current popover — mousedown on it must not
// count as an "outside" click, or the popover closes and immediately
// reopens before the anchor's own click handler runs.
let activePopoverAnchor = null;

const SIDEBAR_COLLAPSED_KEY = "liber_sidebar_collapsed";

async function renderGreeting() {
  profileData = await getProfile();
  if (profileData) {
    if (greeting)
      greeting.textContent = `Tracking my applications for: ${profileData.profession}`;
    if (avatar)
      avatar.textContent = profileData.name.trim().charAt(0).toUpperCase();
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
  // offsetWidth, unlike getBoundingClientRect(), ignores the entrance
  // animation's transform: scale(), which would otherwise shrink the
  // measured width and push the popover off-screen.
  const left = Math.max(12, anchorRect.right - popover.offsetWidth);
  popover.style.left = `${left}px`;
  popover.style.top = `${anchorRect.bottom + 10}px`;

  activePopover = popover;
  activePopoverAnchor = anchorBtn;

  document.addEventListener("mousedown", handleOutsideClick, true);
  document.addEventListener("keydown", handlePopoverKeydown, true);
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

function closeActivePopover() {
  if (!activePopover) return;

  const el = activePopover;
  activePopover = null;
  activePopoverAnchor = null;
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
    anchorBtn.textContent = job.notes ? "View my note" : "Add a note";
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
  expandedCell = null;
  document.removeEventListener("mousedown", handleCellOutsideClick, true);
}

function handleCellOutsideClick(event) {
  if (expandedCell && !expandedCell.contains(event.target)) {
    collapseExpandedCell();
  }
}

function toggleCellExpand(span) {
  if (expandedCell === span) {
    collapseExpandedCell();
    return;
  }
  collapseExpandedCell();
  span.classList.add("dashboard__cell-content--expanded");
  expandedCell = span;
  document.addEventListener("mousedown", handleCellOutsideClick, true);
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
  btn.textContent = job.notes ? "View my note" : "Add a note";
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

  const statusTd = document.createElement("td");
  statusTd.appendChild(buildStatusSelect(job));
  tr.appendChild(statusTd);

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

  const company = document.createElement("p");
  company.className = "dashboard__card-company";
  company.textContent = job.company;
  main.appendChild(company);

  card.appendChild(main);

  const date = document.createElement("p");
  date.className = "dashboard__card-date";
  date.textContent = new Date(job.dateAdded).toLocaleDateString();
  card.appendChild(date);

  return card;
}

function buildEmptyCard() {
  const div = document.createElement("div");
  div.className = "dashboard__empty";
  div.textContent = EMPTY_MESSAGE;
  return div;
}

async function renderJobs() {
  closeActivePopover();
  collapseExpandedCell();
  const jobs = await getAllJobs();

  if (cardMode) {
    cardsList.innerHTML = "";
    if (jobs.length === 0) {
      cardsList.appendChild(buildEmptyCard());
      return;
    }
    jobs.slice(0, cardLimit).forEach((job) => cardsList.appendChild(buildCard(job)));
    return;
  }

  tbody.innerHTML = "";

  if (jobs.length === 0) {
    tbody.appendChild(buildEmptyRow());
    return;
  }

  jobs.forEach((job) => tbody.appendChild(buildRow(job)));
}

// Only present on the full view — the popup has no room for a sidebar to
// collapse. Collapsed state persists across visits like the theme does.
function initSidebarToggle() {
  sidebarToggle = document.getElementById("sidebar-toggle");
  const dashboardEl = document.querySelector(".dashboard");
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
  } else {
    tbody = document.getElementById("jobs-tbody");
    trashIconTemplate = document.getElementById("trash-icon-template");
  }
  greeting = document.getElementById("greeting");
  avatar = document.getElementById("user-avatar");

  if (avatar)
    avatar.addEventListener("click", () => openProfilePopover(avatar));

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
