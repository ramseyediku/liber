// Settings page: display name, job profiles, cloud sync, CSV export, sign-in
// details, log out and account deletion. Layout/copy follow the Settings
// screen in the v2 mockup, extended with job profiles and credential
// updates (not in the mockup).
import {
  createJobProfile,
  flushPendingUpdates,
  deleteAccount,
  getActiveJobProfileId,
  getAllJobProfiles,
  getAllJobs,
  getProfile,
  setActiveJobProfile,
  setProfile,
  STATUS_META,
} from "../shared/storage.ts";
import { ensureSession, getSupabaseClient, isPermanentUser } from "../shared/supabaseClient.ts";
import { isSyncEnabled, setSyncEnabled } from "../shared/sync.ts";
import { isPaid, startCheckout } from "../shared/entitlements.ts";
import { isDevInstall, removeDemoJobs, seedDemoJobs } from "../shared/demoData.ts";
import type { Job, JobProfile, Profile } from "../shared/types.ts";

LiberTheme.initToggle(document.getElementById("theme-toggle"));

const SIDEBAR_COLLAPSED_KEY = "liber_sidebar_collapsed";
const MIN_PASSWORD_LENGTH = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALL_PROFILES = "all";

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const dashboardEl = document.querySelector(".dashboard") as HTMLElement;
const loginLink = el("login-link");
const accountAvatar = el("account-avatar");

const nameForm = el<HTMLFormElement>("name-form");
const nameInput = el<HTMLInputElement>("display-name");
const nameAvatar = el("name-avatar");
const nameSave = el<HTMLButtonElement>("name-save");
const nameError = el("name-error");

const profileList = el("profile-list");
const profileForm = el<HTMLFormElement>("profile-form");
const newProfileInput = el<HTMLInputElement>("new-profile");
const profileAddBtn = el<HTMLButtonElement>("profile-add");
const profileError = el("profile-error");

const syncSwitch = el<HTMLButtonElement>("sync-switch");
const syncLoginLink = el("sync-login-link");
const syncDesc = el("sync-desc");

const exportDesc = el("export-desc");
const exportSelect = el<HTMLSelectElement>("export-profile");
const exportBtn = el<HTMLButtonElement>("export-btn");

const planBadge = el("plan-badge");
const planDesc = el("plan-desc");
const planFreeNote = el("plan-free-note");
const planPremium = el("plan-premium");
const planPremiumTag = el("plan-premium-tag");
const planUpgrade = el<HTMLButtonElement>("plan-upgrade");
const planError = el("plan-error");
// Restore-code UI disabled for now:
// const planCodeRow = el("plan-code-row");
// const planCode = el("plan-code");
// const restoreForm = el<HTMLFormElement>("restore-form");
// const restoreInput = el<HTMLInputElement>("restore-code");
// const restoreError = el("restore-error");

const accountSignedOut = el("account-signed-out");
const accountSignedIn = el("account-signed-in");
const accountSignedInEnd = el("account-signed-in-end");
const emailForm = el<HTMLFormElement>("email-form");
const emailInput = el<HTMLInputElement>("account-email");
const emailSave = el<HTMLButtonElement>("email-save");
const emailError = el("email-error");
const passwordForm = el<HTMLFormElement>("password-form");
const passwordInput = el<HTMLInputElement>("account-password");
const passwordSave = el<HTMLButtonElement>("password-save");
const passwordError = el("password-error");
const signedInAs = el("signed-in-as");
const logoutBtn = el<HTMLButtonElement>("logout-btn");

const deleteDialog = el<HTMLDialogElement>("delete-dialog");
const deleteForm = el<HTMLFormElement>("delete-form");
const deleteConfirmInput = el<HTMLInputElement>("delete-confirm");
const deleteConfirmBtn = el<HTMLButtonElement>("delete-confirm-btn");
const deleteError = el("delete-error");

const toast = el("toast");
const toastText = el("toast-text");

let profile: Profile | null = null;
let savedName = "";
let currentEmail = "";
let jobProfiles: JobProfile[] = [];
let activeProfileId = "";
let toastTimer: ReturnType<typeof setTimeout> | undefined;

// --- Small helpers ----------------------------------------------------------

function showToast(message: string): void {
  toastText.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 2600);
}

// Error pills hold a <span> for the message; null/"" hides the pill.
function setError(pill: HTMLElement, message: string | null): void {
  pill.classList.toggle("hidden", !message);
  const span = pill.querySelector("span");
  if (span && message) span.textContent = message;
}

function initialOf(name: string): string {
  return (name.trim().charAt(0) || "?").toUpperCase();
}

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "Something went wrong. Try again.";
}

// --- Sidebar (same persisted state as the dashboard's) -------------------

function initSidebarToggle(): void {
  const toggle = el("sidebar-toggle");
  const syncLabel = () =>
    toggle.setAttribute(
      "aria-label",
      dashboardEl.classList.contains("is-sidebar-collapsed") ? "Expand sidebar" : "Collapse sidebar",
    );

  let collapsed = false;
  try {
    collapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
  } catch {
    // Storage unavailable — default open.
  }
  dashboardEl.classList.add("dashboard--no-transition");
  dashboardEl.classList.toggle("is-sidebar-collapsed", collapsed);
  syncLabel();
  requestAnimationFrame(() =>
    requestAnimationFrame(() => dashboardEl.classList.remove("dashboard--no-transition")),
  );

  toggle.addEventListener("click", () => {
    dashboardEl.classList.toggle("is-sidebar-collapsed");
    syncLabel();
    try {
      localStorage.setItem(
        SIDEBAR_COLLAPSED_KEY,
        String(dashboardEl.classList.contains("is-sidebar-collapsed")),
      );
    } catch {
      // Nothing to persist to.
    }
  });
}

// --- Profile (display name) -------------------------------------------------

function syncNameForm(): void {
  const draft = nameInput.value.trim();
  const empty = draft.length === 0;
  nameAvatar.textContent = initialOf(nameInput.value);
  nameInput.setAttribute("aria-invalid", empty ? "true" : "false");
  setError(nameError, empty ? "Enter a display name" : null);
  nameSave.disabled = empty || draft === savedName;
}

nameInput.addEventListener("input", syncNameForm);

nameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const draft = nameInput.value.trim();
  if (!draft || draft === savedName) return;

  nameSave.disabled = true;
  try {
    // Name and profession share one user_metadata write (see storage.ts),
    // so carry the existing profession through unchanged.
    await setProfile({ name: draft, profession: profile?.profession ?? "" });
    profile = { name: draft, profession: profile?.profession ?? "" };
    savedName = draft;
    accountAvatar.textContent = initialOf(draft);
    showToast("Display name saved");
  } catch (err) {
    setError(nameError, errorMessage(err));
  } finally {
    syncNameForm();
  }
});

// --- Job profiles -----------------------------------------------------------

function renderJobProfiles(): void {
  profileList.replaceChildren();
  for (const p of jobProfiles) {
    const item = document.createElement("li");
    item.className = "settings__profile";

    const name = document.createElement("span");
    name.className = "settings__profile-name";
    name.textContent = p.name;
    item.appendChild(name);

    if (p.id === activeProfileId) {
      const badge = document.createElement("span");
      badge.className = "settings__badge";
      badge.textContent = "Active";
      item.appendChild(badge);
    } else {
      const useBtn = document.createElement("button");
      useBtn.type = "button";
      useBtn.className = "settings__btn settings__btn--ghost";
      useBtn.textContent = "Use for new saves";
      useBtn.addEventListener("click", async () => {
        await setActiveJobProfile(p);
        activeProfileId = p.id;
        renderJobProfiles();
        showToast(`New applications will be saved to "${p.name}"`);
      });
      item.appendChild(useBtn);
    }
    profileList.appendChild(item);
  }
}

function renderExportOptions(): void {
  const previous = exportSelect.value || ALL_PROFILES;
  exportSelect.replaceChildren(new Option("All job profiles", ALL_PROFILES));
  for (const p of jobProfiles) exportSelect.add(new Option(p.name, p.id));
  exportSelect.value = jobProfiles.some((p) => p.id === previous) ? previous : ALL_PROFILES;
}

async function loadJobProfiles(): Promise<void> {
  jobProfiles = await getAllJobProfiles();
  activeProfileId = await getActiveJobProfileId();
  renderJobProfiles();
  renderExportOptions();
}

profileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setError(profileError, null);
  const name = newProfileInput.value.trim();
  if (!name) {
    setError(profileError, "Enter a name for the job profile");
    return;
  }
  if (jobProfiles.some((p) => p.name.trim().toLowerCase() === name.toLowerCase())) {
    setError(profileError, "You already have a job profile with that name");
    return;
  }

  profileAddBtn.disabled = true;
  try {
    const result = await createJobProfile(name);
    if (result.status === "limit") {
      setError(
        profileError,
        "The free plan includes 1 job profile. Unlock Liber for unlimited job profiles.",
      );
      return;
    }
    newProfileInput.value = "";
    await loadJobProfiles();
    showToast(`Job profile "${result.profile.name}" added`);
  } catch (err) {
    setError(profileError, errorMessage(err));
  } finally {
    profileAddBtn.disabled = false;
  }
});

// --- Cloud sync -------------------------------------------------------------

async function renderSyncRow(permanent: boolean): Promise<void> {
  syncSwitch.classList.toggle("hidden", !permanent);
  syncLoginLink.classList.toggle("hidden", permanent);

  if (!permanent) {
    syncDesc.textContent = "Off · log in to back up your applications and see them on any device.";
    return;
  }
  const enabled = await isSyncEnabled();
  syncSwitch.setAttribute("aria-checked", enabled ? "true" : "false");
  syncSwitch.classList.toggle("dashboard__switch--on", enabled);
  syncDesc.textContent = enabled
    ? "On · your applications are synced to the cloud."
    : "Off · your applications are saved on this device only.";
}

syncSwitch.addEventListener("click", async () => {
  const enable = syncSwitch.getAttribute("aria-checked") !== "true";
  await setSyncEnabled(enable);
  if (enable) void flushPendingUpdates().catch(() => {});
  await renderSyncRow(true);
  await renderExportSummary();
  showToast(enable ? "Cloud sync turned on" : "Cloud sync turned off");
});

// --- CSV export -------------------------------------------------------------

const CSV_COLUMNS = ["Job profile", "Company", "Job title", "Location", "Status", "Date applied", "URL", "Notes"];

// Job fields are scraped from arbitrary pages and notes are free text, so a
// cell starting with = + - @ would run as a formula when opened in Excel or
// Sheets. Prefixing a quote makes it inert text.
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function buildCsv(jobs: Job[], profileNames: Map<string, string>): string {
  const rows = jobs.map((job) => [
    profileNames.get(job.profileId) ?? "",
    job.company,
    job.jobTitle,
    job.location,
    STATUS_META[job.status]?.label ?? job.status,
    job.dateAdded,
    job.url,
    job.notes,
  ]);
  return [CSV_COLUMNS, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

function download(filename: string, content: string): void {
  // BOM so Excel reads the file as UTF-8.
  const url = URL.createObjectURL(new Blob(["﻿", content], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "profile";
}

async function exportCsv(profileId: string): Promise<void> {
  const [jobs, profiles] = await Promise.all([getAllJobs(), getAllJobProfiles()]);
  const selected = profileId === ALL_PROFILES ? jobs : jobs.filter((j) => j.profileId === profileId);
  if (selected.length === 0) {
    showToast("No applications to export");
    return;
  }

  const names = new Map(profiles.map((p) => [p.id, p.name]));
  const filename =
    profileId === ALL_PROFILES
      ? "liber-applications.csv"
      : `liber-applications-${slug(names.get(profileId) ?? "")}.csv`;
  download(filename, buildCsv(selected, names));
  showToast(`${filename} downloaded`);
}

async function renderExportSummary(): Promise<void> {
  const count = (await getAllJobs()).length;
  exportDesc.textContent = `Download all ${count} application${count === 1 ? "" : "s"} as a CSV file you can open in Excel or Google Sheets.`;
}

exportBtn.addEventListener("click", () => exportCsv(exportSelect.value));

// --- Sign-in details --------------------------------------------------------

function syncEmailForm(): void {
  const value = emailInput.value.trim();
  emailSave.disabled = !EMAIL_RE.test(value) || value === currentEmail;
}

function syncPasswordForm(): void {
  passwordSave.disabled = passwordInput.value.length < MIN_PASSWORD_LENGTH;
}

emailInput.addEventListener("input", () => {
  setError(emailError, null);
  syncEmailForm();
});

passwordInput.addEventListener("input", () => {
  setError(passwordError, null);
  syncPasswordForm();
});

emailForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  syncEmailForm();
  if (emailSave.disabled) return;

  emailSave.disabled = true;
  try {
    const { error } = await getSupabaseClient().auth.updateUser({ email: emailInput.value.trim() });
    if (error) {
      setError(emailError, error.message);
      return;
    }
    // The address only changes once the confirmation link is clicked.
    showToast("Check your new email to confirm the change");
  } finally {
    syncEmailForm();
  }
});

passwordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  syncPasswordForm();
  if (passwordSave.disabled) return;

  passwordSave.disabled = true;
  try {
    const { error } = await getSupabaseClient().auth.updateUser({ password: passwordInput.value });
    if (error) {
      setError(passwordError, error.message);
      return;
    }
    passwordInput.value = "";
    showToast("Password updated");
  } finally {
    syncPasswordForm();
  }
});

// --- Log out / delete account ----------------------------------------------

logoutBtn.addEventListener("click", async () => {
  logoutBtn.disabled = true;
  await getSupabaseClient().auth.signOut();
  window.location.href = "../dashboard/dashboard-full.html";
});

el("delete-open").addEventListener("click", () => {
  deleteConfirmInput.value = "";
  deleteConfirmBtn.disabled = true;
  setError(deleteError, null);
  deleteDialog.showModal();
});

el("delete-cancel").addEventListener("click", () => deleteDialog.close());
el("delete-export").addEventListener("click", () => exportCsv(ALL_PROFILES));

deleteConfirmInput.addEventListener("input", () => {
  deleteConfirmBtn.disabled = deleteConfirmInput.value.trim() !== "DELETE";
});

deleteForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (deleteConfirmInput.value.trim() !== "DELETE") return;

  deleteConfirmBtn.disabled = true;
  setError(deleteError, null);
  try {
    await deleteAccount();
    window.location.href = "../onboarding/onboarding.html";
  } catch {
    // Deliberately generic: the real cause (network, server, permissions)
    // isn't actionable for the user and shouldn't be shown raw.
    setError(deleteError, "Something went wrong. Please try again.");
    deleteConfirmBtn.disabled = false;
  }
});

// --- Init -------------------------------------------------------------------

async function init(): Promise<void> {
  await ensureSession();
  const permanent = await isPermanentUser();

  profile = await getProfile();
  savedName = profile?.name ?? "";
  nameInput.value = savedName;
  syncNameForm();

  loginLink.classList.toggle("hidden", permanent);
  accountAvatar.classList.toggle("hidden", !permanent);
  accountAvatar.textContent = initialOf(savedName);

  accountSignedIn.classList.toggle("hidden", !permanent);
  accountSignedInEnd.classList.toggle("hidden", !permanent);
  accountSignedOut.classList.toggle("hidden", permanent);
  if (permanent) {
    const { data } = await getSupabaseClient().auth.getUser();
    currentEmail = data.user?.email ?? "";
    emailInput.value = currentEmail;
    signedInAs.textContent = `Signed in as ${currentEmail}`;
    syncEmailForm();
  }

  await Promise.all([loadJobProfiles(), renderSyncRow(permanent), renderExportSummary()]);
}

// --- Plan -------------------------------------------------------------------

async function renderPlan(): Promise<void> {
  const paid = await isPaid().catch(() => false);
  planBadge.textContent = paid ? "Premium" : "Free";
  planDesc.textContent = paid
    ? "You're on Premium. Thanks for supporting Liber."
    : "You're on the free plan. Unlock Liber once to remove every limit.";
  planFreeNote.textContent = paid ? "Included" : "Your current plan";
  planPremium.classList.toggle("settings__plan--current", paid);
  planPremiumTag.classList.toggle("hidden", !paid);
  planUpgrade.classList.toggle("hidden", paid);
  // Restore-code UI disabled for now:
  // restoreForm.classList.toggle("hidden", paid);
  // setError(restoreError, null);
  //
  // const code = paid ? await getRestoreCode() : null;
  // planCodeRow.classList.toggle("hidden", !code);
  // if (code) planCode.textContent = code;
}

planUpgrade.addEventListener("click", async () => {
  setError(planError, null);
  planUpgrade.disabled = true;
  try {
    const url = await startCheckout();
    await browser.tabs.create({ url });
  } catch (err) {
    setError(planError, errorMessage(err));
  } finally {
    planUpgrade.disabled = false;
  }
});

// Restore-code UI disabled for now:
// restoreForm.addEventListener("submit", async (event) => {
//   event.preventDefault();
//   setError(restoreError, null);
//   const code = restoreInput.value.trim();
//   if (!code) {
//     setError(restoreError, "Enter your restore code");
//     return;
//   }
//   try {
//     if (await redeemRestoreCode(code)) {
//       restoreInput.value = "";
//       await renderPlan();
//       showToast("Premium restored");
//     } else {
//       setError(restoreError, "That code wasn't recognised");
//     }
//   } catch (err) {
//     setError(restoreError, errorMessage(err));
//   }
// });

// Checkout happens in another tab — re-check when the user comes back.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void renderPlan();
});
void renderPlan();

// --- Developer (unpacked installs only) -------------------------------------

if (isDevInstall()) {
  el("dev-card").classList.remove("hidden");
  el("tab-dev").classList.remove("hidden");

  // Floating capture-log button (content.ts). On by default for dev installs.
  const LOG_BUTTON_FLAG = "liber_show_log_button";
  const logSwitch = el<HTMLButtonElement>("logbtn-switch");
  const paintLogSwitch = (on: boolean) => {
    logSwitch.setAttribute("aria-checked", String(on));
    logSwitch.classList.toggle("dashboard__switch--on", on);
  };
  (browser.storage.local.get(LOG_BUTTON_FLAG) as Promise<Record<string, unknown>>).then((r) =>
    paintLogSwitch(typeof r[LOG_BUTTON_FLAG] === "boolean" ? (r[LOG_BUTTON_FLAG] as boolean) : true),
  );
  logSwitch.addEventListener("click", async () => {
    const next = logSwitch.getAttribute("aria-checked") !== "true";
    await browser.storage.local.set({ [LOG_BUTTON_FLAG]: next });
    paintLogSwitch(next);
  });

  el("demo-load").addEventListener("click", async () => {
    const count = await seedDemoJobs();
    await renderExportSummary();
    showToast(
      (await isSyncEnabled())
        ? `${count} demo jobs added. Turn off Cloud sync to see them.`
        : `${count} demo jobs added`,
    );
  });

  el("demo-remove").addEventListener("click", async () => {
    const count = await removeDemoJobs();
    await renderExportSummary();
    showToast(count ? `${count} demo jobs removed` : "No demo jobs to remove");
  });
}

// --- Section tabs -----------------------------------------------------------

const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>(".settings__tab"));

function selectTab(tab: HTMLButtonElement): void {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    document.getElementById(t.getAttribute("aria-controls")!)!.hidden = !on;
  }
  try {
    history.replaceState(null, "", `#${tab.dataset.panel}`);
  } catch {
    // Non-critical: the section just won't survive a reload.
  }
}

for (const tab of tabs) {
  tab.addEventListener("click", () => selectTab(tab));
  tab.addEventListener("keydown", (event) => {
    const visible = tabs.filter((t) => !t.classList.contains("hidden"));
    const i = visible.indexOf(tab);
    let next = -1;
    if (event.key === "ArrowRight") next = (i + 1) % visible.length;
    else if (event.key === "ArrowLeft") next = (i - 1 + visible.length) % visible.length;
    if (next < 0) return;
    event.preventDefault();
    visible[next]!.focus();
    selectTab(visible[next]!);
  });
}

const hashTab = tabs.find(
  (t) => t.dataset.panel === location.hash.slice(1) && !t.classList.contains("hidden"),
);
if (hashTab) selectTab(hashTab);

initSidebarToggle();
init();
