// Shared rendering logic for both dashboard pages. Full view renders every
// job as a table row; the popup (cardMode) renders a capped card list —
// only page chrome/CSS and this render mode differ.
import {
  getAllJobs,
  updateJob,
  deleteJob,
  restoreJob,
  flushPendingUpdates,
  getProfile,
  getActiveJobProfileId,
  getAllJobProfiles,
  setActiveJobProfile,
  createJobProfile,
  STATUS_META,
} from "../shared/storage.ts";
import { isPaid } from "../shared/entitlements.ts";
import {
  ensureSession,
  getSupabaseClient,
  isPermanentUser,
} from "../shared/supabaseClient.ts";
import { isSyncEnabled, setSyncEnabled } from "../shared/sync.ts";
import type { Job, JobProfile, JobStatus, Profile } from "../shared/types.ts";

const EMPTY_MESSAGE =
  'No applications tracked yet. Click "Apply" on any job listing to start.';
const COLUMN_COUNT = 7;
const PAGE_SIZE = 9;

// --- Module state (set by initDashboard) ----------------------------------
let tbody: HTMLElement | null;
let cardsList: HTMLElement | null;
let cardMode = false;
let cardLimit = 4;

// One live-region snackbar at a time. Destructive or easy-to-misclick actions
// (delete, status change) apply immediately and offer a few seconds to undo,
// which is lighter than a confirm dialog and also confirms the action landed.
let toastEl: HTMLElement | null = null;
let toastTimer: number | undefined;

function showUndoToast(
  message: string,
  onUndo: () => Promise<void> | void,
): void {
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
  return m
    ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    : new Date(iso);
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
    const relative = new Intl.RelativeTimeFormat(undefined, {
      numeric: "auto",
    }).format(-days, "day");
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

// Full view only: what the table currently shows. Filters and sort act on the
// whole dataset before pagination, and the detail panel's prev/next follows
// the same filtered order.
type SortKey = "date" | "status";
let statusFilter: JobStatus | "all" = "all";
let searchQuery = "";
let sortKey: SortKey = "date";
let sortDir: "asc" | "desc" = "desc";
let toolbarEl: HTMLElement | null;
let filtersEl: HTMLElement | null;
let filterStatusEl: HTMLElement | null;
let totalPages = 1;
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
  renderJobs(true);
}

// The job profile whose applications the dashboard is showing. It is also the
// profile new saves land under (storage.ts), so switching here switches both.
let activeProfileId: string | null = null;
let activeProfileName = "";
let profileSwitcherBtn: HTMLElement | null = null;

async function getScopedJobs(refresh = false): Promise<Job[]> {
  activeProfileId ??= await getActiveJobProfileId();
  return (await getAllJobs({ refresh })).filter((j) => j.profileId === activeProfileId);
}

async function renderGreeting(): Promise<void> {
  profileData = await getProfile();
  const profiles = await getAllJobProfiles();
  activeProfileId = await getActiveJobProfileId();
  activeProfileName =
    profiles.find((p) => p.id === activeProfileId)?.name ??
    profileData?.profession ??
    "";
  if (professionLabel) professionLabel.textContent = activeProfileName;
  if (profileData) {
    if (accountTrigger)
      accountTrigger.textContent = profileData.name
        .trim()
        .charAt(0)
        .toUpperCase();
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

// --- Popovers ---------------------------------------------------------------

async function openProfilePopover(anchorBtn: HTMLElement): Promise<void> {
  // Already open: clicking its own button does nothing. Clicking anywhere
  // else closes it (handleOutsideClick).
  if (activePopover) return;
  const paid = await isPaid().catch(() => false);
  if (activePopover) return; // a second click landed while we were checking

  const popover = document.createElement("div");
  popover.className = "dashboard__popover dashboard__profile-popover";

  const name = document.createElement("p");
  name.className = "dashboard__profile-popover-name";
  name.textContent = profileData?.name || "Your account";
  popover.appendChild(name);

  const plan = document.createElement("span");
  plan.className = `dashboard__plan-pill${paid ? " dashboard__plan-pill--premium" : ""}`;
  plan.textContent = paid ? "Premium" : "Free plan";
  popover.appendChild(plan);

  // Cloud sync lives here now (it needs a logged-in account, which is the
  // only case this popover opens for).
  let syncOn = await isSyncEnabled();
  const syncRow = document.createElement("div");
  syncRow.className = "dashboard__profile-popover-sync";
  syncRow.title = "Back up your applications to the cloud and see them on any device.";
  const syncLabel = document.createElement("span");
  syncLabel.id = "popover-sync-label";
  syncLabel.textContent = "Cloud sync";
  const syncSwitch = document.createElement("button");
  syncSwitch.type = "button";
  syncSwitch.setAttribute("role", "switch");
  syncSwitch.setAttribute("aria-labelledby", "popover-sync-label");
  syncSwitch.className = "dashboard__switch";
  syncSwitch.innerHTML = '<span class="dashboard__switch-knob"></span>';
  const paintSwitch = () => {
    syncSwitch.setAttribute("aria-checked", String(syncOn));
    syncSwitch.classList.toggle("dashboard__switch--on", syncOn);
  };
  paintSwitch();
  syncSwitch.addEventListener("click", async () => {
    syncOn = !syncOn;
    paintSwitch();
    await setSyncEnabled(syncOn);
    if (syncOn) void flushPendingUpdates().catch(() => {});
    renderJobs(true); // getAllJobs() reads from a different source depending on the flag
  });
  syncRow.append(syncLabel, syncSwitch);
  popover.appendChild(syncRow);

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
  const left = Math.max(
    12,
    Math.min(
      anchorRect.right - popover.offsetWidth,
      window.innerWidth - popover.offsetWidth - 12,
    ),
  );
  popover.style.left = `${left}px`;

  // Flip above the anchor when there isn't room below (trigger sits at the
  // bottom of the sidebar).
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

function openStatusMenu(job: Job, pill: HTMLElement): void {
  // Already open: clicking its own button does nothing. Clicking anywhere
  // else closes it (handleOutsideClick).
  if (activePopover) return;

  const menu = document.createElement("div");
  menu.className = "dashboard__popover dashboard__status-menu";
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", "Choose status");

  (
    Object.entries(STATUS_META) as [
      JobStatus,
      (typeof STATUS_META)[JobStatus],
    ][]
  ).forEach(([value, meta]) => {
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

    if (selected)
      option.appendChild(checkIconTemplate!.content.cloneNode(true));

    option.addEventListener("click", async () => {
      // Dismiss first so the menu goes the moment an option is picked,
      // not after the storage round trip.
      closeActivePopover();
      if (value !== job.status) {
        const previous = job.status;
        const apply = async (next: JobStatus) => {
          job.status = next;
          pill.className = `dashboard__status-pill dashboard__status-pill--${next}`;
          pill.querySelector("span")!.textContent = STATUS_META[next].label;
          pill.setAttribute(
            "aria-label",
            `Status: ${STATUS_META[next].label}. Change status`,
          );
          await updateJob(job.id, { status: next });
        };
        await apply(value);
        showUndoToast(`Marked ${meta.label}`, () => apply(previous));
      }
    });

    menu.appendChild(option);
  });

  document.body.appendChild(menu);

  const anchorRect = pill.getBoundingClientRect();
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
  menu
    .querySelector<HTMLElement>('[aria-selected="true"]')
    ?.focus({ preventScroll: true });

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
  pill.setAttribute(
    "aria-label",
    `Status: ${STATUS_META[job.status].label}. Change status`,
  );

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
  pill.setAttribute(
    "aria-label",
    `Status: ${STATUS_META[job.status].label}. Change status`,
  );
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
  const hadFocus =
    el.contains(document.activeElement) ||
    document.activeElement === document.body;
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
  const options = Array.from(
    activePopover.querySelectorAll<HTMLElement>('[role="option"]:not([hidden])'),
  );
  const current = options.indexOf(document.activeElement as HTMLElement);
  let next = -1;
  if (event.key === "ArrowDown") next = (current + 1) % options.length;
  else if (event.key === "ArrowUp")
    next = (current - 1 + options.length) % options.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = options.length - 1;
  if (next < 0) return;
  event.preventDefault();
  options[next]?.focus();
}

function positionPopover(menu: HTMLElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  const left = Math.max(
    12,
    Math.min(rect.left, window.innerWidth - menu.offsetWidth - 12),
  );
  menu.style.left = `${left}px`;
  const openUp = rect.bottom + menu.offsetHeight + 10 > window.innerHeight;
  menu.style.top = openUp
    ? `${rect.top - menu.offsetHeight - 6}px`
    : `${rect.bottom + 6}px`;
}

async function switchJobProfile(profile: JobProfile): Promise<void> {
  await setActiveJobProfile(profile);
  activeProfileId = profile.id;
  activeProfileName = profile.name;
  if (professionLabel) professionLabel.textContent = profile.name;
  statusFilter = "all";
  searchQuery = "";
  const search = document.getElementById("jobs-search") as HTMLInputElement | null;
  if (search) search.value = "";
  currentPage = 1;
  renderJobs();
}

// Dropdown on the greeting pill: pick which job profile the dashboard shows,
// or add one (paid plan only — free accounts see the entry locked).
async function openProfileSwitcher(anchor: HTMLElement): Promise<void> {
  // Already open: clicking its own button does nothing. Clicking anywhere
  // else closes it (handleOutsideClick).
  if (activePopover) return;
  const [profiles, paid] = await Promise.all([getAllJobProfiles(), isPaid()]);

  const menu = document.createElement("div");
  menu.className = "dashboard__popover dashboard__status-menu dashboard__profile-menu";
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", "Choose job profile");

  profiles
    .filter((p) => !p.deleted)
    .forEach((p) => {
      const option = document.createElement("button");
      option.type = "button";
      option.setAttribute("role", "option");
      option.className = "dashboard__status-option";
      const selected = p.id === activeProfileId;
      option.setAttribute("aria-selected", selected ? "true" : "false");
      const label = document.createElement("span");
      label.textContent = p.name;
      option.appendChild(label);
      if (selected) option.appendChild(checkIconTemplate!.content.cloneNode(true));
      option.addEventListener("click", () => {
        closeActivePopover();
        if (!selected) switchJobProfile(p);
      });
      menu.appendChild(option);
    });

  const divider = document.createElement("div");
  divider.className = "dashboard__profile-menu-divider";
  menu.appendChild(divider);

  const add = document.createElement("button");
  add.type = "button";
  add.className = "dashboard__status-option dashboard__profile-add";
  add.setAttribute("role", "option");
  add.setAttribute("aria-selected", "false");
  const addLabel = document.createElement("span");
  addLabel.textContent = "+ Add profile";
  add.appendChild(addLabel);
  if (!paid) {
    add.setAttribute("aria-disabled", "true");
    add.title = "Unlock Liber for unlimited job profiles";
    const tag = document.createElement("small");
    tag.className = "dashboard__profile-premium";
    tag.textContent = "Premium";
    add.appendChild(tag);
  }
  menu.appendChild(add);

  const form = document.createElement("form");
  form.className = "dashboard__profile-form";
  form.hidden = true;
  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 40;
  input.placeholder = "Profile name";
  input.setAttribute("aria-label", "New job profile name");
  const error = document.createElement("p");
  error.className = "dashboard__profile-error";
  error.setAttribute("role", "alert");
  form.append(input, error);
  menu.appendChild(form);

  add.addEventListener("click", () => {
    if (!paid) return;
    add.hidden = true;
    form.hidden = false;
    input.focus();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = input.value.trim();
    if (!name) return;
    if (profiles.some((p) => p.name.trim().toLowerCase() === name.toLowerCase())) {
      error.textContent = "You already have a profile with that name";
      return;
    }
    input.disabled = true;
    try {
      const result = await createJobProfile(name);
      if (result.status === "limit") {
        error.textContent = "Unlock Liber for unlimited job profiles";
        input.disabled = false;
        return;
      }
      closeActivePopover();
      await switchJobProfile(result.profile);
    } catch {
      error.textContent = "Couldn't add the profile. Try again.";
      input.disabled = false;
    }
  });

  document.body.appendChild(menu);
  positionPopover(menu, anchor);
  anchor.setAttribute("aria-expanded", "true");
  activePopover = menu;
  activePopoverAnchor = anchor;
  menu
    .querySelector<HTMLElement>('[aria-selected="true"]')
    ?.focus({ preventScroll: true });
  document.addEventListener("mousedown", handleOutsideClick, true);
  document.addEventListener("keydown", handlePopoverKeydown, true);
}

function openNotesPopover(job: Job, anchorBtn: HTMLElement): void {
  // Already open: clicking its own button does nothing.
  if (activePopover) return;

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

// --- Detail drawer -----------------------------------------------------------

function renderDetailStatus(job: Job, jobs: Job[]): void {
  detailStatusGroup!.innerHTML = "";

  (
    Object.entries(STATUS_META) as [
      JobStatus,
      (typeof STATUS_META)[JobStatus],
    ][]
  ).forEach(([value, meta]) => {
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
  });
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

  detailDateEl!.textContent = parseDateAdded(
    job.dateAdded,
  ).toLocaleDateString();
  detailNoteEl!.value = job.notes || "";

  detailPanel.setAttribute(
    "aria-label",
    `Application details for ${job.company}`,
  );
  detailDeleteBtn!.setAttribute(
    "aria-label",
    `Delete ${job.company} application`,
  );

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
  if (!detailPanel || (detailPanel as HTMLElement & { hidden: boolean }).hidden)
    return;

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
  const jobs = getVisibleJobs(await getScopedJobs());
  const index = jobs.findIndex((j) => j.id === detailJobId);
  const target = jobs[index + delta];
  if (!target) return;
  detailJobId = target.id;
  renderDetailPanel(target, jobs);
}

async function handleDetailDelete(): Promise<void> {
  if (!currentDetailJob) return;
  const jobId = currentDetailJob.id;
  const jobs = await getScopedJobs();
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
  tr.tabIndex = 0;
  tr.addEventListener("click", () => openDetail(job, jobs));
  tr.addEventListener("keydown", (event) => {
    // Only when the row itself has focus, so the pill/notes/delete buttons
    // inside it keep their own Enter and Space.
    if (event.target !== tr || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    openDetail(job, jobs);
  });

  tr.appendChild(buildTruncatedCell(job.company, "dashboard__col--company"));
  tr.appendChild(buildTruncatedCell(job.jobTitle, "dashboard__col--title"));
  tr.appendChild(
    buildTruncatedCell(
      job.location,
      "dashboard__col--full dashboard__col--location",
    ),
  );

  const dateTd = document.createElement("td");
  dateTd.className = "dashboard__col--full";
  dateTd.textContent = formatDateAdded(job.dateAdded);
  dateTd.title = parseDateAdded(job.dateAdded).toLocaleDateString();
  const stale = staleLabel(job);
  if (stale) {
    const staleEl = document.createElement("span");
    staleEl.className = "dashboard__cell-stale";
    staleEl.classList.toggle("dashboard__stale--overdue", stale.overdue);
    staleEl.textContent = stale.text;
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

// Applied for this long with no status change reads as "follow up".
const STALE_AFTER_DAYS = 14;

// Past this long the cue turns red: it's unlikely to be answered now.
const OVERDUE_AFTER_DAYS = 90;

// "Waiting N days" for an Applied job past the threshold, otherwise null.
// `overdue` switches the cue from amber to red (see the stale CSS classes).
function staleLabel(job: Job): { text: string; overdue: boolean } | null {
  if (job.status !== "applied") return null;
  const days = daysSince(parseDateAdded(job.dateAdded));
  if (days < STALE_AFTER_DAYS) return null;
  return { text: `Waiting ${days} days`, overdue: days >= OVERDUE_AFTER_DAYS };
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
    browser.tabs.create({
      url: browser.runtime.getURL("src/dashboard/dashboard-full.html"),
    });
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
    staleEl.classList.toggle("dashboard__stale--overdue", stale.overdue);
    staleEl.textContent = stale.text;
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

  // Always shown (a single page when empty) so it never shifts position.

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

const STATUS_ORDER = Object.keys(STATUS_META) as JobStatus[];

function filtersActive(): boolean {
  return statusFilter !== "all" || searchQuery !== "";
}

function getVisibleJobs(all: Job[]): Job[] {
  const query = searchQuery.trim().toLowerCase();
  const visible = all.filter((job) => {
    if (statusFilter !== "all" && job.status !== statusFilter) return false;
    if (!query) return true;
    return [job.company, job.jobTitle, job.location, job.notes].some((field) =>
      field?.toLowerCase().includes(query),
    );
  });

  // getAllJobs() already returns newest first, and sort() is stable, so the
  // default (date, descending) needs no work and ties keep that order.
  if (sortKey === "date") {
    if (sortDir === "asc") visible.reverse();
  } else {
    const dir = sortDir === "asc" ? 1 : -1;
    visible.sort((a, b) => dir * (STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)));
  }
  return visible;
}

function renderToolbar(all: Job[], visibleCount: number): void {
  if (!toolbarEl || !filtersEl) return;
  toolbarEl.hidden = false;
  filtersEl.innerHTML = "";

  const addChip = (value: JobStatus | "all", label: string, count: number) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `dashboard__chip${value === "all" ? "" : ` dashboard__chip--${value}`}`;
    chip.setAttribute("aria-pressed", String(statusFilter === value));
    if (value !== "all") {
      const dot = document.createElement("span");
      dot.className = `dashboard__status-dot dashboard__status-dot--${value}`;
      dot.setAttribute("aria-hidden", "true");
      chip.appendChild(dot);
    }
    chip.appendChild(document.createTextNode(label));
    const countEl = document.createElement("span");
    countEl.className = "dashboard__chip-count";
    countEl.textContent = String(count);
    chip.appendChild(countEl);
    chip.addEventListener("click", () => {
      // Clicking the active chip again clears it.
      statusFilter = statusFilter === value ? "all" : value;
      currentPage = 1;
      renderJobs();
    });
    filtersEl!.appendChild(chip);
  };

  addChip("all", "All", all.length);
  STATUS_ORDER.forEach((status) => {
    const count = all.filter((j) => j.status === status).length;
    addChip(status, STATUS_META[status].label, count);
  });

  document.querySelectorAll<HTMLElement>("th[data-sort]").forEach((th) => {
    if (th.dataset.sort === sortKey) {
      th.setAttribute("aria-sort", sortDir === "asc" ? "ascending" : "descending");
    } else {
      th.removeAttribute("aria-sort");
    }
  });

  if (filterStatusEl) {
    filterStatusEl.textContent = filtersActive()
      ? `Showing ${visibleCount} of ${all.length} applications`
      : "";
  }
}

function clearFilters(): void {
  statusFilter = "all";
  searchQuery = "";
  const input = document.getElementById("jobs-search") as HTMLInputElement | null;
  if (input) input.value = "";
  currentPage = 1;
  renderJobs();
}

function buildNoMatchRow(): HTMLElement {
  const tr = document.createElement("tr");
  const td = document.createElement("td");
  td.colSpan = COLUMN_COUNT;
  td.className = "dashboard__empty dashboard__empty--no-match";
  const text = document.createElement("p");
  text.textContent = searchQuery
    ? `No applications match "${searchQuery.trim()}"${statusFilter !== "all" ? ` in ${STATUS_META[statusFilter].label}` : ""}.`
    : `No applications are marked ${STATUS_META[statusFilter as JobStatus].label}.`;
  td.appendChild(text);
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "dashboard__link-btn";
  clear.textContent = "Clear filters";
  clear.addEventListener("click", clearFilters);
  td.appendChild(clear);
  tr.appendChild(td);
  return tr;
}

// `refresh` re-pulls from the cloud (sync on); every other re-render reads
// the local cache so paging/filtering/editing makes no network call.
async function renderJobs(refresh = false): Promise<void> {
  closeActivePopover();
  const jobs = await getScopedJobs(refresh);

  if (cardMode) {
    cardsList!.innerHTML = "";
    if (jobs.length === 0) {
      cardsList!.appendChild(buildEmptyCard());
      if (jobsCountEl) jobsCountEl.textContent = "";
      return;
    }
    jobs
      .slice(0, cardLimit)
      .forEach((job) => cardsList!.appendChild(buildCard(job)));
    if (jobsCountEl) {
      const shown = Math.min(cardLimit, jobs.length);
      jobsCountEl.textContent =
        shown < jobs.length
          ? `Showing ${shown} of ${jobs.length} applications, most recent first`
          : `${jobs.length} application${jobs.length === 1 ? "" : "s"}`;
    }
    return;
  }

  const all = jobs;
  const view = getVisibleJobs(all);
  renderToolbar(all, view.length);

  totalPages = Math.max(1, Math.ceil(view.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;

  tbody!.innerHTML = "";

  if (all.length === 0) {
    tbody!.appendChild(buildEmptyRow());
  } else if (view.length === 0) {
    tbody!.appendChild(buildNoMatchRow());
  } else {
    const start = (currentPage - 1) * PAGE_SIZE;
    view
      .slice(start, start + PAGE_SIZE)
      .forEach((job) => tbody!.appendChild(buildRow(job, view)));
  }

  renderPagination();
  syncDetailPanel(view);
}

// Full view only — the popup has no room for a collapsible sidebar.
// Collapsed state persists across visits like the theme does.
function initSidebarToggle(): void {
  sidebarToggle = document.getElementById("sidebar-toggle");
  if (!sidebarToggle || !dashboardEl) return;

  const syncLabel = () => {
    const collapsed = dashboardEl!.classList.contains("is-sidebar-collapsed");
    sidebarToggle!.setAttribute(
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
  checkIconTemplate = document.getElementById(
    "check-icon-template",
  ) as HTMLTemplateElement | null;

  if (cardMode) {
    cardsList = document.getElementById("jobs-cards");
    jobsCountEl = document.getElementById("jobs-count");
  } else {
    professionLabel = document.getElementById("profession-label");
    tbody = document.getElementById("jobs-tbody");
    trashIconTemplate = document.getElementById(
      "trash-icon-template",
    ) as HTMLTemplateElement | null;
    plusIconTemplate = document.getElementById(
      "plus-icon-template",
    ) as HTMLTemplateElement | null;

    detailOverlay = document.getElementById("detail-overlay");
    detailPanel = document.getElementById("detail-panel");
    detailPositionEl = document.getElementById("detail-position");
    detailPrevBtn = document.getElementById(
      "detail-prev",
    ) as HTMLButtonElement | null;
    detailNextBtn = document.getElementById(
      "detail-next",
    ) as HTMLButtonElement | null;
    detailCloseBtn = document.getElementById("detail-close");
    detailFooterCloseBtn = document.getElementById("detail-footer-close");
    detailDeleteBtn = document.getElementById("detail-delete");
    detailRoleEl = document.getElementById("detail-role");
    detailStatusGroup = document.getElementById("detail-status");
    detailCompanyEl = document.getElementById("detail-company");
    detailLocationEl = document.getElementById("detail-location");
    detailDateEl = document.getElementById("detail-date");
    detailNoteEl = document.getElementById(
      "detail-note",
    ) as HTMLTextAreaElement | null;

    detailOverlay?.addEventListener("click", closeDetail);
    detailCloseBtn?.addEventListener("click", closeDetail);
    detailFooterCloseBtn?.addEventListener("click", closeDetail);
    detailPrevBtn?.addEventListener("click", () => navigateDetail(-1));
    detailNextBtn?.addEventListener("click", () => navigateDetail(1));
    detailDeleteBtn?.addEventListener("click", handleDetailDelete);
    detailNoteEl?.addEventListener("input", handleDetailNoteInput);

    paginationNav = document.getElementById("jobs-pagination");
    paginationPages = document.getElementById("pagination-pages");
    paginationPrev = document.getElementById(
      "pagination-prev",
    ) as HTMLButtonElement | null;
    paginationNext = document.getElementById(
      "pagination-next",
    ) as HTMLButtonElement | null;
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

    toolbarEl = document.getElementById("jobs-toolbar");
    filtersEl = document.getElementById("status-filters");
    filterStatusEl = document.getElementById("filter-status");

    let searchTimer: number | undefined;
    document.getElementById("jobs-search")?.addEventListener("input", (event) => {
      const value = (event.target as HTMLInputElement).value;
      clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => {
        searchQuery = value;
        currentPage = 1;
        renderJobs();
      }, 150);
    });

    document.querySelectorAll<HTMLElement>("th[data-sort]").forEach((th) => {
      th.querySelector("button")?.addEventListener("click", () => {
        const key = th.dataset.sort as SortKey;
        if (sortKey === key) {
          sortDir = sortDir === "asc" ? "desc" : "asc";
        } else {
          sortKey = key;
          sortDir = key === "date" ? "desc" : "asc";
        }
        currentPage = 1;
        renderJobs();
      });
    });

    profileSwitcherBtn = document.getElementById("profile-switcher");
    profileSwitcherBtn?.addEventListener("click", () =>
      openProfileSwitcher(profileSwitcherBtn!),
    );

    accountTrigger = document.getElementById("account-trigger");
    loginLink = document.getElementById("login-link");

    accountTrigger?.addEventListener("click", () =>
      openProfilePopover(accountTrigger!),
    );
  }
  dashboardEl = document.querySelector(".dashboard");

  initSidebarToggle();

  refreshSignedInState();

  // Edits are saved locally right away and pushed to Supabase in batches
  // (see storage.ts): on load, every minute, and when the page is hidden.
  // flushPendingUpdates() does nothing while Cloud Sync is off.
  const flush = () => void flushPendingUpdates().catch(() => {});
  flush();
  setInterval(flush, 60_000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
  window.addEventListener("pagehide", flush);

  // jobs/job_profiles live in browser.storage.local now (local-first —
  // see storage.ts), so a plain liber_jobs change already is the real
  // data changing.
  browser.storage.onChanged.addListener(
    (changes: { [key: string]: chrome.storage.StorageChange }) => {
      if (changes.liber_jobs) {
        if (activePopover) {
          rerenderPending = true;
        } else {
          renderJobs();
        }
      }
    },
  );

  // Keeps the popup/full view in sync with a sign-in/out that happened
  // elsewhere (onboarding tab, or this page's own "Sign out").
  getSupabaseClient().auth.onAuthStateChange(() => {
    refreshSignedInState();
  });
}
