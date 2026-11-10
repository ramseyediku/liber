// Shared rendering logic for both dashboard pages. Full view renders every
// job as a table row; the popup (cardMode) renders a capped card list —
// only page chrome/CSS and this render mode differ.
import { getAllJobs, updateJob, deleteJob, restoreJob, getProfile, STATUS_META } from "../shared/storage.ts";
import { getLogs, clearLogs } from "../shared/logStorage.ts";
import { ensureSession, getSupabaseClient, isPermanentUser } from "../shared/supabaseClient.ts";
import { isSyncEnabled, setSyncEnabled } from "../shared/sync.ts";
import type { Job, JobStatus, LogEntry, Profile } from "../shared/types.ts";

const EMPTY_MESSAGE = 'No applications tracked yet. Click "Apply" on any job listing to start.';
const COLUMN_COUNT = 7;
const PAGE_SIZE = 10;

// --- Module state (set by initDashboard) ----------------------------------
let tbody: HTMLElement | null;
let cardsList: HTMLElement | null;
let summaryEl: HTMLElement | null;
let cardMode = false;
let cardLimit = 4;

// One live-region snackbar at a time. Destructive or easy-to-misclick actions
// (delete, status change) apply immediately and offer a few seconds to undo,
// which is lighter than a confirm dialog and also confirms the action landed.
let toastEl: HTMLElement | null = null;
let toastTimer: number | undefined;

function showUndoToast(message: string, onUndo: () => Promise<void> | void): void {
  clearTimeout(toastTimer);
  toastEl?.remove();

  // Undo removes its own button, which would drop keyboard focus to the page.
  const returnFocus = document.activeElement as HTMLElement | null;

  const toast = document.createElement("div");
  toast.className = "dashboard__toast";
  toast.setAttribute("role", "status");

  const text = document.createElement("span");
  text.textContent = message;
  toast.appendChild(text);

  const undo = document.createElement("button");
  undo.type = "button";
  undo.className = "dashboard__toast-undo";
  undo.textContent = "Undo";
  undo.addEventListener("click", async () => {
    clearTimeout(toastTimer);
    toast.remove();
    toastEl = null;
    await onUndo();
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  });
  toast.appendChild(undo);

  document.body.appendChild(toast);
  toastEl = toast;
  toastTimer = window.setTimeout(() => {
    toast.remove();
    if (toastEl === toast) toastEl = null;
  }, 6000);
}

// "Today", "3 days ago", then "Nov 8" (with the year once it differs). A bare
// numeric date like 08/11/2026 reads as two different days depending on locale.
// date_applied is a bare YYYY-MM-DD. new Date() reads that as UTC midnight,
// which is the previous evening west of Greenwich, so parse it as a local date.
function parseDateAdded(iso: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(iso);
}

function daysSince(date: Date): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((today.getTime() - date.getTime()) / 86_400_000);
}

function formatDateAdded(iso: string): string {
  const date = parseDateAdded(iso);
  const days = daysSince(date);
  if (days >= 0 && days < 7) {
    const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(-days, "day");
    return relative.charAt(0).toUpperCase() + relative.slice(1);
  }
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}
let jobsCountEl: HTMLElement | null;
let professionLabel: HTMLElement | null;
// Full view only — the header's top-right avatar button. Doubles as the
// profile popover's anchor and the thing that shows the initial letter.
let accountTrigger: HTMLElement | null;
let loginLink: HTMLElement | null;
let syncSwitch: HTMLButtonElement | null;
let syncLoginLink: HTMLElement | null;
let syncDescEl: HTMLElement | null;
let sidebarToggle: HTMLElement | null;
let trashIconTemplate: HTMLTemplateElement | null;
let chevronDownIconTemplate: HTMLTemplateElement | null;
let checkIconTemplate: HTMLTemplateElement | null;
let plusIconTemplate: HTMLTemplateElement | null;
let paginationNav: HTMLElement | null;
let paginationPages: HTMLElement | null;
let paginationPrev: HTMLButtonElement | null;
let paginationNext: HTMLButtonElement | null;
let currentPage = 1;
let totalPages = 1;
let logsTriggerBtn: HTMLElement | null;
let activePopover: HTMLElement | null = null;

// Detail drawer (full view only). detailJobId is the source of truth for
// which record is open; currentDetailJob is kept around so the note
// textarea's input handler doesn't have to re-find it on every keystroke.
let detailOverlay: HTMLElement | null;
let detailPanel: HTMLElement | null;
let detailPositionEl: HTMLElement | null;
let detailPrevBtn: HTMLButtonElement | null;
let detailNextBtn: HTMLButtonElement | null;
let detailCloseBtn: HTMLElement | null;
let detailFooterCloseBtn: HTMLElement | null;
let detailDeleteBtn: HTMLElement | null;
let detailRoleEl: HTMLElement | null;
let detailStatusGroup: HTMLElement | null;
let detailCompanyEl: HTMLElement | null;
let detailLocationEl: HTMLElement | null;
let detailDateEl: HTMLElement | null;
let detailNoteEl: HTMLTextAreaElement | null;
let detailJobId: string | null = null;
let currentDetailJob: Job | null = null;
let detailFocusReturn: HTMLElement | null = null;
// Defers a storage-triggered re-render until the open popover closes.
let rerenderPending = false;
let profileData: Profile | null = null;
let dashboardEl: HTMLElement | null;
// Anchor of the open popover — a mousedown on it isn't an "outside" click.
let activePopoverAnchor: HTMLElement | null = null;

const SIDEBAR_COLLAPSED_KEY = "liber_sidebar_collapsed";

// Local-first: jobs/profile are always usable, anonymous or not — there's
// no sign-in gate on the dashboard itself anymore (see storage.ts). This
// just guarantees a session exists (anonymous, if nothing else) before the
// first storage/entitlements call.
async function refreshSignedInState(): Promise<void> {
  await ensureSession();
  renderGreeting();
  renderAccountArea();
  renderSyncRow();
  renderJobs();
  renderLogs();
}

async function renderGreeting(): Promise<void> {
  profileData = await getProfile();
  if (profileData) {
    if (professionLabel) professionLabel.textContent = profileData.profession;
    if (accountTrigger) accountTrigger.textContent = profileData.name.trim().charAt(0).toUpperCase();
  }
}

// Full view only — top-right corner shows a "Log in" link for an anonymous
// session, or the avatar (opens the profile popover) for a permanent one.
async function renderAccountArea(): Promise<void> {
  if (!accountTrigger || !loginLink) return;
  const permanent = await isPermanentUser();
  accountTrigger.classList.toggle("hidden", !permanent);
  loginLink.classList.toggle("hidden", permanent);
}

// Full view only — sidebar's cloud-sync row. Logged out: a switch-shaped
// link to Login instead of an interactive control (see sync.ts — turning
// sync on requires a permanent account).
async function renderSyncRow(): Promise<void> {
  if (!syncSwitch || !syncLoginLink || !syncDescEl) return;
  const permanent = await isPermanentUser();
  syncSwitch.classList.toggle("hidden", !permanent);
  syncLoginLink.classList.toggle("hidden", permanent);

  if (!permanent) {
    syncDescEl.textContent = "Off · log in to back up your applications and see them on any device.";
    return;
  }

  const enabled = await isSyncEnabled();
  syncSwitch.setAttribute("aria-checked", enabled ? "true" : "false");
  syncSwitch.classList.toggle("dashboard__switch--on", enabled);
  syncDescEl.textContent = enabled
    ? "On · your applications are synced to the cloud."
    : "Off · your applications are saved on this device only.";
}

// --- Popovers ---------------------------------------------------------------

async function openProfilePopover(anchorBtn: HTMLElement): Promise<void> {
  if (activePopover) {
    closeActivePopover();
    return;
  }
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

  // The trigger that opens this is only shown for a permanent account
  // (see renderAccountArea) — an anonymous session has nothing to "sign
  // out" of, so this button is always relevant here.
  const signOutBtn = document.createElement("button");
  signOutBtn.type = "button";
  signOutBtn.className = "dashboard__profile-popover-signout";
  signOutBtn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><use href="../shared/icons.svg#icon-log-out"></use></svg><span>Log out</span>';
  signOutBtn.addEventListener("click", async () => {
    await getSupabaseClient().auth.signOut();
    closeActivePopover();
    await refreshSignedInState(); // re-establishes a fresh anonymous session
  });
  popover.appendChild(signOutBtn);

  document.body.appendChild(popover);

  const anchorRect = anchorBtn.getBoundingClientRect();
  // Right-aligns under the button, same pattern as the notes/status
  // popovers — offsetWidth ignores the entrance animation's transform:
  // scale(), unlike getBoundingClientRect().
  const left = Math.max(12, Math.min(anchorRect.right - popover.offsetWidth, window.innerWidth - popover.offsetWidth - 12));
  popover.style.left = `${left}px`;

  // Flip above the anchor when there isn't room below (trigger sits at the
  // bottom of the sidebar).
  const openUp = anchorRect.bottom + popover.offsetHeight + 10 > window.innerHeight;
  popover.style.top = openUp
    ? `${anchorRect.top - popover.offsetHeight - 10}px`
    : `${anchorRect.bottom + 10}px`;

  activePopover = popover;
  activePopoverAnchor = anchorBtn;

  document.addEventListener("mousedown", handleOutsideClick, true);
  document.addEventListener("keydown", handlePopoverKeydown, true);
}

function openStatusMenu(job: Job, pill: HTMLElement): void {
  if (activePopover) {
    closeActivePopover();
    return;
  }

  const menu = document.createElement("div");
  menu.className = "dashboard__popover dashboard__status-menu";
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", "Choose status");

  (Object.entries(STATUS_META) as [JobStatus, (typeof STATUS_META)[JobStatus]][]).forEach(
    ([value, meta]) => {
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

      if (selected) option.appendChild(checkIconTemplate!.content.cloneNode(true));

      option.addEventListener("click", async () => {
        if (value !== job.status) {
          const previous = job.status;
          const apply = async (next: JobStatus) => {
            job.status = next;
            pill.className = `dashboard__status-pill dashboard__status-pill--${next}`;
            pill.querySelector("span")!.textContent = STATUS_META[next].label;
            pill.setAttribute("aria-label", `Status: ${STATUS_META[next].label}. Change status`);
            await updateJob(job.id, { status: next });
            if (cardMode) renderStatusSummary(await getAllJobs());
          };
          await apply(value);
          showUndoToast(`Marked ${meta.label}`, () => apply(previous));
        }
        closeActivePopover();
      });

      menu.appendChild(option);
    },
  );

  document.body.appendChild(menu);

  const anchorRect = pill.getBoundingClientRect();
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
  menu.querySelector<HTMLElement>('[aria-selected="true"]')?.focus({ preventScroll: true });

  document.addEventListener("mousedown", handleOutsideClick, true);
  document.addEventListener("keydown", handlePopoverKeydown, true);
}

// Shared by the table's status cell and the popup's cards, so both open the
// same menu and keep the same aria wiring.
function buildStatusPill(job: Job): HTMLButtonElement {
  const pill = document.createElement("button");
  pill.type = "button";
  pill.className = `dashboard__status-pill dashboard__status-pill--${job.status}`;
  pill.setAttribute("aria-haspopup", "listbox");
  pill.setAttribute("aria-expanded", "false");
  pill.setAttribute("aria-label", `Status: ${STATUS_META[job.status].label}. Change status`);

  const label = document.createElement("span");
  label.textContent = STATUS_META[job.status].label;
  pill.appendChild(label);
  pill.appendChild(chevronDownIconTemplate!.content.cloneNode(true));

  pill.addEventListener("click", (event) => {
    event.stopPropagation();
    openStatusMenu(job, pill);
  });

  return pill;
}

// Keeps the table row behind the detail panel in step with a status change
// made inside the panel.
function syncTablePill(job: Job): void {
  const pill = tbody?.querySelector<HTMLElement>(
    `tr[data-job-id="${job.id}"] .dashboard__status-pill`,
  );
  if (!pill) return;
  pill.className = `dashboard__status-pill dashboard__status-pill--${job.status}`;
  pill.querySelector("span")!.textContent = STATUS_META[job.status].label;
  pill.setAttribute("aria-label", `Status: ${STATUS_META[job.status].label}. Change status`);
}

function buildStatusCell(job: Job): HTMLElement {
  const td = document.createElement("td");
  td.appendChild(buildStatusPill(job));
  return td;
}

function closeActivePopover(): void {
  if (!activePopover) return;

  const el = activePopover;
  const anchor = activePopoverAnchor;
  // Keyboard users keep their place: focus goes back to what opened the popover
  // when it was inside the popover (or lost to the body by the click).
  const hadFocus = el.contains(document.activeElement) || document.activeElement === document.body;
  activePopover = null;
  activePopoverAnchor = null;
  if (anchor?.hasAttribute("aria-expanded")) {
    anchor.setAttribute("aria-expanded", "false");
  }
  document.removeEventListener("mousedown", handleOutsideClick, true);
  document.removeEventListener("keydown", handlePopoverKeydown, true);
  if (hadFocus && anchor?.isConnected && anchor.hasAttribute("aria-expanded")) {
    anchor.focus({ preventScroll: true });
  }

  // Pop-out animation, then detach once it finishes.
  el.classList.add("dashboard__popover--closing");
  el.addEventListener("animationend", () => el.remove(), { once: true });

  if (rerenderPending) {
    rerenderPending = false;
    renderJobs();
  }
}

function handleOutsideClick(event: MouseEvent): void {
  const target = event.target as Node;
  if (!activePopover || activePopover.contains(target)) return;
  // Let the anchor's own click handler decide whether to toggle closed —
  // otherwise it reopens a fresh popover right after this closes it.
  if (activePopoverAnchor?.contains(target)) return;
  closeActivePopover();
}

function handlePopoverKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    closeActivePopover();
    return;
  }

  // Arrow-key roving through the status menu's options.
  if (!activePopover?.classList.contains("dashboard__status-menu")) return;
  const options = Array.from(activePopover.querySelectorAll<HTMLElement>('[role="option"]'));
  const current = options.indexOf(document.activeElement as HTMLElement);
  let next = -1;
  if (event.key === "ArrowDown") next = (current + 1) % options.length;
  else if (event.key === "ArrowUp") next = (current - 1 + options.length) % options.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = options.length - 1;
  if (next < 0) return;
  event.preventDefault();
  options[next]?.focus();
}

function openNotesPopover(job: Job, anchorBtn: HTMLElement): void {
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
  // Opens leftward from the button's right edge — anchors to the rightmost
  // table columns.
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

// Full view only — built fresh inside this popover each time it opens,
// same anchored-popover pattern as the notes/profile popovers (Escape,
// outside-click, and its close button all dismiss it; clicking the
// trigger again while open toggles it closed).
function openLogsPopover(anchorBtn: HTMLElement): void {
  if (activePopoverAnchor === anchorBtn) {
    closeActivePopover();
    return;
  }
  if (activePopover) closeActivePopover();

  const popover = document.createElement("div");
  popover.className = "dashboard__popover dashboard__logs-popover";

  const header = document.createElement("div");
  header.className = "dashboard__logs-header";

  const heading = document.createElement("h2");
  heading.textContent = "Scrape Activity Log";
  header.appendChild(heading);

  const headerActions = document.createElement("div");
  headerActions.className = "dashboard__logs-header-actions";

  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "dashboard__logs-clear";
  clearBtn.textContent = "Clear";
  clearBtn.addEventListener("click", async () => {
    await clearLogs();
    renderLogs();
  });
  headerActions.appendChild(clearBtn);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "dashboard__logs-popover-close";
  closeBtn.setAttribute("aria-label", "Close activity log");
  closeBtn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="../shared/icons.svg#icon-close"></use></svg>';
  closeBtn.addEventListener("click", () => closeActivePopover());
  headerActions.appendChild(closeBtn);

  header.appendChild(headerActions);
  popover.appendChild(header);

  const list = document.createElement("ol");
  list.className = "dashboard__logs-list";
  list.id = "logs-list";
  popover.appendChild(list);

  document.body.appendChild(popover);

  const anchorRect = anchorBtn.getBoundingClientRect();
  const left = Math.max(12, Math.min(anchorRect.left, window.innerWidth - popover.offsetWidth - 12));
  popover.style.left = `${left}px`;

  const openUp = anchorRect.bottom + popover.offsetHeight + 10 > window.innerHeight;
  popover.style.top = openUp
    ? `${anchorRect.top - popover.offsetHeight - 10}px`
    : `${anchorRect.bottom + 10}px`;

  anchorBtn.setAttribute("aria-expanded", "true");
  activePopover = popover;
  activePopoverAnchor = anchorBtn;

  document.addEventListener("mousedown", handleOutsideClick, true);
  document.addEventListener("keydown", handlePopoverKeydown, true);

  renderLogs();
}

// --- Detail drawer -----------------------------------------------------------

function renderDetailStatus(job: Job, jobs: Job[]): void {
  detailStatusGroup!.innerHTML = "";

  (Object.entries(STATUS_META) as [JobStatus, (typeof STATUS_META)[JobStatus]][]).forEach(
    ([value, meta]) => {
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
        const previous = job.status;
        const apply = async (next: JobStatus) => {
          job.status = next;
          renderDetailPanel(job, jobs);
          syncTablePill(job);
          await updateJob(job.id, { status: next });
        };
        await apply(value);
        showUndoToast(`Marked ${meta.label}`, () => apply(previous));
      });

      detailStatusGroup!.appendChild(btn);
    },
  );
}

function renderDetailPanel(job: Job, jobs: Job[]): void {
  if (!detailPanel) return;

  currentDetailJob = job;
  const index = jobs.findIndex((j) => j.id === job.id);

  detailPositionEl!.textContent = `Application ${index + 1} of ${jobs.length}`;
  detailPrevBtn!.disabled = index <= 0;
  detailNextBtn!.disabled = index === -1 || index >= jobs.length - 1;

  detailRoleEl!.textContent = job.jobTitle;
  detailCompanyEl!.textContent = job.company;

  detailLocationEl!.innerHTML = "";
  if (/^https?:\/\//.test(job.location || "")) {
    const link = document.createElement("a");
    link.href = job.location;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = job.location;
    detailLocationEl!.appendChild(link);
  } else {
    detailLocationEl!.textContent = job.location;
  }

  detailDateEl!.textContent = parseDateAdded(job.dateAdded).toLocaleDateString();
  detailNoteEl!.value = job.notes || "";

  detailPanel.setAttribute("aria-label", `Application details for ${job.company}`);
  detailDeleteBtn!.setAttribute("aria-label", `Delete ${job.company} application`);

  renderDetailStatus(job, jobs);
}

// Re-syncs the open drawer whenever the job list is re-fetched, so it never
// drifts from the table. Closes itself if its job was deleted elsewhere.
function syncDetailPanel(jobs: Job[]): void {
  if (!detailPanel || detailJobId === null) return;
  const job = jobs.find((j) => j.id === detailJobId);
  if (!job) {
    closeDetail();
    return;
  }
  renderDetailPanel(job, jobs);
}

function openDetail(job: Job, jobs: Job[]): void {
  if (!detailPanel) return;
  closeActivePopover();
  detailJobId = job.id;
  renderDetailPanel(job, jobs);

  detailFocusReturn = document.activeElement as HTMLElement | null;
  detailOverlay!.classList.remove("dashboard__detail-overlay--closing");
  detailPanel.classList.remove("dashboard__detail--closing");
  (detailOverlay as HTMLElement & { hidden: boolean }).hidden = false;
  (detailPanel as HTMLElement & { hidden: boolean }).hidden = false;
  detailCloseBtn!.focus();

  document.addEventListener("keydown", handleDetailKeydown);
}

function closeDetail(): void {
  detailJobId = null;
  currentDetailJob = null;
  if (!detailPanel || (detailPanel as HTMLElement & { hidden: boolean }).hidden) return;

  document.removeEventListener("keydown", handleDetailKeydown);
  detailOverlay!.classList.add("dashboard__detail-overlay--closing");
  detailPanel.classList.add("dashboard__detail--closing");

  const finish = () => {
    (detailOverlay as HTMLElement & { hidden: boolean }).hidden = true;
    (detailPanel as HTMLElement & { hidden: boolean }).hidden = true;
    detailOverlay!.classList.remove("dashboard__detail-overlay--closing");
    detailPanel!.classList.remove("dashboard__detail--closing");
  };
  detailPanel.addEventListener("animationend", finish, { once: true });

  if (detailFocusReturn && document.contains(detailFocusReturn)) {
    detailFocusReturn.focus();
  }
  detailFocusReturn = null;
}

function handleDetailKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") closeDetail();
}

async function navigateDetail(delta: number): Promise<void> {
  if (detailJobId === null) return;
  const jobs = await getAllJobs();
  const index = jobs.findIndex((j) => j.id === detailJobId);
  const target = jobs[index + delta];
  if (!target) return;
  detailJobId = target.id;
  renderDetailPanel(target, jobs);
}

async function handleDetailDelete(): Promise<void> {
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
  showUndoToast("Application deleted", async () => {
    await restoreJob(jobId);
    renderJobs();
  });
}

function handleDetailNoteInput(): void {
  if (!currentDetailJob) return;
  const value = detailNoteEl!.value;
  currentDetailJob.notes = value;
  updateJob(currentDetailJob.id, { notes: value.trim() });
}

// --- Table / card rendering --------------------------------------------------

// Truncates with an ellipsis; the title attribute surfaces the full text on hover.
function buildTruncatedCell(text: string, className?: string): HTMLElement {
  const td = document.createElement("td");
  if (className) td.className = className;

  const span = document.createElement("span");
  span.className = "dashboard__cell-content";
  span.textContent = text;
  span.title = text;

  td.appendChild(span);
  return td;
}

function buildNotesCell(job: Job): HTMLElement {
  const td = document.createElement("td");
  td.className = "dashboard__col--notes";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "dashboard__notes-btn";
  if (!job.notes) btn.classList.add("dashboard__notes-btn--empty");
  btn.appendChild(plusIconTemplate!.content.cloneNode(true));
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

// jobs is the full (unpaginated) list, so the detail drawer can report
// "Application X of Y" across the whole dataset.
function buildRow(job: Job, jobs: Job[]): HTMLElement {
  const tr = document.createElement("tr");
  tr.dataset.jobId = job.id;
  tr.addEventListener("click", () => openDetail(job, jobs));

  tr.appendChild(buildTruncatedCell(job.company, "dashboard__col--company"));
  tr.appendChild(buildTruncatedCell(job.jobTitle, "dashboard__col--title"));
  tr.appendChild(buildTruncatedCell(job.location, "dashboard__col--full dashboard__col--location"));

  const dateTd = document.createElement("td");
  dateTd.className = "dashboard__col--full";
  dateTd.textContent = formatDateAdded(job.dateAdded);
  dateTd.title = parseDateAdded(job.dateAdded).toLocaleDateString();
  const stale = staleLabel(job);
  if (stale) {
    const staleEl = document.createElement("span");
    staleEl.className = "dashboard__cell-stale";
    staleEl.textContent = stale;
    dateTd.appendChild(staleEl);
  }
  tr.appendChild(dateTd);

  tr.appendChild(buildStatusCell(job));
  tr.appendChild(buildNotesCell(job));

  const actionsTd = document.createElement("td");

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "dashboard__delete";
  deleteBtn.setAttribute("aria-label", "Delete");
  deleteBtn.appendChild(trashIconTemplate!.content.cloneNode(true));
  deleteBtn.addEventListener("click", async (event) => {
    event.stopPropagation();
    await deleteJob(job.id);
    tr.remove();
    showUndoToast("Application deleted", async () => {
      await restoreJob(job.id);
      renderJobs();
    });
  });
  actionsTd.appendChild(deleteBtn);
  tr.appendChild(actionsTd);

  return tr;
}

function buildEmptyRow(): HTMLElement {
  const tr = document.createElement("tr");
  const td = document.createElement("td");
  td.colSpan = COLUMN_COUNT;
  td.className = "dashboard__empty";
  td.textContent = EMPTY_MESSAGE;
  tr.appendChild(td);
  return tr;
}

// Popup header strip: how many applications sit in each status, so the state
// of the whole search reads before any single card does.
function renderStatusSummary(jobs: Job[]): void {
  if (!summaryEl) return;
  summaryEl.innerHTML = "";
  (Object.entries(STATUS_META) as [JobStatus, (typeof STATUS_META)[JobStatus]][]).forEach(
    ([value, meta]) => {
      const count = jobs.filter((j) => j.status === value).length;
      if (!count) return;
      const li = document.createElement("li");
      const dot = document.createElement("span");
      dot.className = `dashboard__status-dot dashboard__status-dot--${value}`;
      dot.setAttribute("aria-hidden", "true");
      li.appendChild(dot);
      li.appendChild(document.createTextNode(`${count} ${meta.label}`));
      summaryEl!.appendChild(li);
    },
  );
  summaryEl.hidden = !summaryEl.children.length;
}

// Applied for this long with no status change reads as "follow up".
const STALE_AFTER_DAYS = 14;

// "Waiting N days" for an Applied job past the threshold, otherwise null.
function staleLabel(job: Job): string | null {
  if (job.status !== "applied") return null;
  const days = daysSince(parseDateAdded(job.dateAdded));
  return days >= STALE_AFTER_DAYS ? `Waiting ${days} days` : null;
}

// Only built in cardMode (the popup). The title area opens the full dashboard;
// the status pill beside it changes status in place, so a card holds two
// separate buttons rather than one clickable div.
function buildCard(job: Job): HTMLElement {
  const card = document.createElement("div");
  card.className = "dashboard__card";

  const main = document.createElement("button");
  main.type = "button";
  main.className = "dashboard__card-main";
  main.addEventListener("click", () => {
    browser.tabs.create({ url: browser.runtime.getURL("src/dashboard/dashboard-full.html") });
    window.close();
  });

  const title = document.createElement("span");
  title.className = "dashboard__card-title";
  title.textContent = job.jobTitle;
  main.appendChild(title);

  const meta = document.createElement("span");
  meta.className = "dashboard__card-meta";
  const dateAdded = formatDateAdded(job.dateAdded);
  meta.textContent = `${job.company} · ${dateAdded}`;
  main.appendChild(meta);

  // Its own line: the meta line ellipsizes long company names and would clip it.
  const stale = staleLabel(job);
  if (stale) {
    const staleEl = document.createElement("span");
    staleEl.className = "dashboard__card-stale";
    staleEl.textContent = stale;
    main.appendChild(staleEl);
  }

  card.appendChild(main);
  card.appendChild(buildStatusPill(job));

  return card;
}

function buildEmptyCard(): HTMLElement {
  const div = document.createElement("div");
  div.className = "dashboard__empty";
  div.textContent = EMPTY_MESSAGE;
  return div;
}

// Windowed page buttons centered on the current page — fixed, reasonable width.
function renderPagination(): void {
  if (!paginationNav) return;

  if (totalPages <= 1) {
    paginationNav.style.display = "none";
    return;
  }

  paginationNav.style.display = "";
  paginationPrev!.disabled = currentPage === 1;
  paginationNext!.disabled = currentPage === totalPages;

  paginationPages!.innerHTML = "";
  const windowSize = 5;
  let start = Math.max(1, currentPage - Math.floor(windowSize / 2));
  const end = Math.min(totalPages, start + windowSize - 1);
  start = Math.max(1, end - windowSize + 1);

  for (let n = start; n <= end; n++) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dashboard__page-btn";
    btn.textContent = String(n);
    btn.setAttribute("aria-label", `Page ${n}`);
    if (n === currentPage) btn.setAttribute("aria-current", "page");
    btn.addEventListener("click", () => {
      if (n === currentPage) return;
      currentPage = n;
      renderJobs();
    });
    paginationPages!.appendChild(btn);
  }
}

// Pretty-printed (not one-line) — a log entry's detail usually has nested
// structure. Strings pass through as-is so a plain message isn't quoted.
function formatLogDetail(detail: unknown): string {
  if (detail == null) return "";
  if (typeof detail === "string") return detail;
  try {
    return JSON.stringify(detail, null, 2);
  } catch {
    return String(detail);
  }
}

function formatLogPage(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url || "";
  }
}

function buildLogRow(entry: LogEntry): HTMLElement {
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

// Full view only — built fresh inside the logs popover each time it opens.
// A no-op whenever the logs popover isn't the open one, so storage.onChanged
// can call this unconditionally without erroring when it's closed.
async function renderLogs(): Promise<void> {
  if (!activePopover || !activePopover.classList.contains("dashboard__logs-popover")) {
    return;
  }
  const logsListEl = activePopover.querySelector("#logs-list");
  if (!logsListEl) return;
  const logs = await getLogs();

  logsListEl.innerHTML = "";
  if (logs.length === 0) {
    const li = document.createElement("li");
    li.className = "dashboard__logs-empty";
    li.textContent = 'No scrape activity yet. Click "Apply" on a job listing to see logs here.';
    logsListEl.appendChild(li);
    return;
  }

  // Newest first — getLogs() returns oldest-first (append order).
  logs
    .slice()
    .reverse()
    .forEach((entry) => logsListEl.appendChild(buildLogRow(entry)));
}

async function renderJobs(): Promise<void> {
  closeActivePopover();
  const jobs = await getAllJobs();

  if (cardMode) {
    cardsList!.innerHTML = "";
    renderStatusSummary(jobs);
    if (jobs.length === 0) {
      cardsList!.appendChild(buildEmptyCard());
      if (jobsCountEl) jobsCountEl.textContent = "";
      return;
    }
    jobs.slice(0, cardLimit).forEach((job) => cardsList!.appendChild(buildCard(job)));
    if (jobsCountEl) {
      const shown = Math.min(cardLimit, jobs.length);
      jobsCountEl.textContent =
        shown < jobs.length
          ? `Showing ${shown} of ${jobs.length} applications, most recent first`
          : `${jobs.length} application${jobs.length === 1 ? "" : "s"}`;
    }
    return;
  }

  totalPages = Math.max(1, Math.ceil(jobs.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;

  tbody!.innerHTML = "";

  if (jobs.length === 0) {
    tbody!.appendChild(buildEmptyRow());
  } else {
    const start = (currentPage - 1) * PAGE_SIZE;
    jobs.slice(start, start + PAGE_SIZE).forEach((job) => tbody!.appendChild(buildRow(job, jobs)));
  }

  renderPagination();
  syncDetailPanel(jobs);
}

// Full view only — the popup has no room for a collapsible sidebar.
// Collapsed state persists across visits like the theme does.
function initSidebarToggle(): void {
  sidebarToggle = document.getElementById("sidebar-toggle");
  if (!sidebarToggle || !dashboardEl) return;

  const syncLabel = () => {
    const collapsed = dashboardEl!.classList.contains("is-sidebar-collapsed");
    sidebarToggle!.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
  };

  let collapsed = false;
  try {
    collapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
  } catch {
    // Storage may be unavailable (e.g. private browsing) — default open.
  }

  // Restoring a saved state shouldn't replay the collapse transition — only
  // a user-triggered click should animate. Removed after first paint.
  dashboardEl.classList.add("dashboard--no-transition");
  dashboardEl.classList.toggle("is-sidebar-collapsed", collapsed);
  syncLabel();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      dashboardEl!.classList.remove("dashboard--no-transition");
    });
  });

  sidebarToggle.addEventListener("click", () => {
    dashboardEl!.classList.toggle("is-sidebar-collapsed");
    syncLabel();
    try {
      localStorage.setItem(
        SIDEBAR_COLLAPSED_KEY,
        String(dashboardEl!.classList.contains("is-sidebar-collapsed")),
      );
    } catch {
      // Ignore — nothing to persist to.
    }
  });
}

export interface InitDashboardOptions {
  cardMode?: boolean;
  cardLimit?: number;
}

export function initDashboard(options: InitDashboardOptions = {}): void {
  cardMode = !!options.cardMode;
  if (options.cardLimit) cardLimit = options.cardLimit;

  // Both the table's status cell and the popup's cards build a status pill.
  chevronDownIconTemplate = document.getElementById(
    "chevron-down-icon-template",
  ) as HTMLTemplateElement | null;
  checkIconTemplate = document.getElementById("check-icon-template") as HTMLTemplateElement | null;

  if (cardMode) {
    cardsList = document.getElementById("jobs-cards");
    summaryEl = document.getElementById("status-summary");
    jobsCountEl = document.getElementById("jobs-count");
  } else {
    professionLabel = document.getElementById("profession-label");
    tbody = document.getElementById("jobs-tbody");
    trashIconTemplate = document.getElementById("trash-icon-template") as HTMLTemplateElement | null;
    plusIconTemplate = document.getElementById("plus-icon-template") as HTMLTemplateElement | null;

    detailOverlay = document.getElementById("detail-overlay");
    detailPanel = document.getElementById("detail-panel");
    detailPositionEl = document.getElementById("detail-position");
    detailPrevBtn = document.getElementById("detail-prev") as HTMLButtonElement | null;
    detailNextBtn = document.getElementById("detail-next") as HTMLButtonElement | null;
    detailCloseBtn = document.getElementById("detail-close");
    detailFooterCloseBtn = document.getElementById("detail-footer-close");
    detailDeleteBtn = document.getElementById("detail-delete");
    detailRoleEl = document.getElementById("detail-role");
    detailStatusGroup = document.getElementById("detail-status");
    detailCompanyEl = document.getElementById("detail-company");
    detailLocationEl = document.getElementById("detail-location");
    detailDateEl = document.getElementById("detail-date");
    detailNoteEl = document.getElementById("detail-note") as HTMLTextAreaElement | null;

    detailOverlay?.addEventListener("click", closeDetail);
    detailCloseBtn?.addEventListener("click", closeDetail);
    detailFooterCloseBtn?.addEventListener("click", closeDetail);
    detailPrevBtn?.addEventListener("click", () => navigateDetail(-1));
    detailNextBtn?.addEventListener("click", () => navigateDetail(1));
    detailDeleteBtn?.addEventListener("click", handleDetailDelete);
    detailNoteEl?.addEventListener("input", handleDetailNoteInput);

    paginationNav = document.getElementById("jobs-pagination");
    paginationPages = document.getElementById("pagination-pages");
    paginationPrev = document.getElementById("pagination-prev") as HTMLButtonElement | null;
    paginationNext = document.getElementById("pagination-next") as HTMLButtonElement | null;
    paginationPrev?.addEventListener("click", () => {
      if (currentPage <= 1) return;
      currentPage--;
      renderJobs();
    });
    paginationNext?.addEventListener("click", () => {
      if (currentPage >= totalPages) return;
      currentPage++;
      renderJobs();
    });

    logsTriggerBtn = document.getElementById("logs-trigger");
    logsTriggerBtn?.addEventListener("click", () => openLogsPopover(logsTriggerBtn!));

    accountTrigger = document.getElementById("account-trigger");
    loginLink = document.getElementById("login-link");
    syncSwitch = document.getElementById("sync-switch") as HTMLButtonElement | null;
    syncLoginLink = document.getElementById("sync-login-link");
    syncDescEl = document.getElementById("sync-desc");

    accountTrigger?.addEventListener("click", () => openProfilePopover(accountTrigger!));
    syncSwitch?.addEventListener("click", async () => {
      const enabled = syncSwitch!.getAttribute("aria-checked") === "true";
      await setSyncEnabled(!enabled);
      await renderSyncRow();
      await renderJobs(); // getAllJobs() reads from a different source depending on the flag
    });
  }
  dashboardEl = document.querySelector(".dashboard");

  initSidebarToggle();

  refreshSignedInState();

  // jobs/job_profiles live in browser.storage.local now (local-first —
  // see storage.ts), so a plain liber_jobs change already is the real
  // data changing; liber_logs still works exactly as before.
  browser.storage.onChanged.addListener((changes: { [key: string]: chrome.storage.StorageChange }) => {
    if (changes.liber_jobs) {
      if (activePopover) {
        rerenderPending = true;
      } else {
        renderJobs();
      }
    }
    if (changes.liber_logs) renderLogs();
  });

  // Keeps the popup/full view in sync with a sign-in/out that happened
  // elsewhere (onboarding tab, or this page's own "Sign out").
  getSupabaseClient().auth.onAuthStateChange(() => {
    refreshSignedInState();
  });
}
