// Single source of truth for reading/writing Liber's data, local-first.
// browser.storage.local is where jobs and job profiles live. Nothing about
// them is sent to Supabase unless Cloud Sync is on: saves, edits and deletes
// are applied here at once and queued, and only go up while sync is on (saves
// via record-save, which enforces the free limit; edits via update-job in
// batches; deletes straight from the table once the undo window has passed).
// See docs/architecture.md.
import { ensureSession, getSupabaseClient } from "./supabaseClient.ts";
import { accountStorage, clearAccountData, currentUserId } from "./accountStore.ts";
import { FREE_EXTRA_JOB_PROFILES, FREE_JOB_LIMIT, isPaid } from "./entitlements.ts";
import { isSyncEnabled } from "./sync.ts";
import type { ImportedJob } from "./csvImport.ts";
import type { Job, JobProfile, JobStatus, Profile, SaveJobResult } from "./types.ts";

export const STATUS = {
  APPLIED: "applied",
  INTERVIEWING: "interviewing",
  OFFER: "offer",
  REJECTED: "rejected",
  WITHDRAWN: "withdrawn",
} as const satisfies Record<string, JobStatus>;

export const STATUS_META: Record<JobStatus, { label: string; color: string }> = {
  applied: { label: "Applied", color: "#3b82f6" },
  interviewing: { label: "Interviewing", color: "#f59e0b" },
  offer: { label: "Offer", color: "#22c55e" },
  rejected: { label: "Rejected", color: "#ef4444" },
  withdrawn: { label: "Withdrawn", color: "#9ca3af" },
};

const JOBS_CACHE_KEY = "liber_jobs";
const DEFAULT_PROFILE_KEY = "liber_default_profile";
const ONBOARDED_KEY = "liber_onboarded";

// Local-first bookkeeping (see "Where job data lives" below).
const PENDING_CREATES_KEY = "liber_pending_creates"; // job ids not yet uploaded
const PENDING_DELETES_KEY = "liber_pending_deletes"; // job id -> when it was deleted
const LOCAL_PROFILES_KEY = "liber_local_profiles"; // extra profiles made on this device
const SYNCED_PROFILES_KEY = "liber_synced_profiles"; // profile ids known to exist remotely
const LOCAL_SAVES_KEY = "liber_local_saves"; // lifetime saves made while sync was off
const LOCAL_ONLY_KEY = "liber_local_only"; // job ids the server refused (free limit)

function rowToJob(row: any): Job {
  return {
    id: row.id,
    profileId: row.profile_id,
    company: row.company || "",
    jobTitle: row.title || "",
    url: row.url || "",
    dateAdded: row.date_applied,
    status: row.status,
    location: row.location || "",
    notes: row.notes || "",
    deleted: !!row.deleted,
    updatedAt: row.updated_at,
  };
}

async function cacheJobs(jobs: Job[]): Promise<void> {
  await accountStorage.set({ [JOBS_CACHE_KEY]: jobs });
}

async function readJobsCache(): Promise<Job[]> {
  const result = (await accountStorage.get(JOBS_CACHE_KEY)) as Record<string, Job[]>;
  return result[JOBS_CACHE_KEY] || [];
}

// The "active" job profile is the one every new save lands under. It's
// client-tracked (id + name persisted locally), generated as "General" on
// first use, and switchable from Settings — see setActiveJobProfile.
async function getOrCreateDefaultProfile(): Promise<{ id: string; name: string }> {
  const result = (await accountStorage.get(DEFAULT_PROFILE_KEY)) as Record<
    string,
    { id: string; name: string }
  >;
  const existing = result[DEFAULT_PROFILE_KEY];
  if (existing) return existing;

  const created = { id: crypto.randomUUID(), name: "General" };
  await accountStorage.set({ [DEFAULT_PROFILE_KEY]: created });
  return created;
}

function rowToJobProfile(row: any): JobProfile {
  return { id: row.id, name: row.name, deleted: !!row.deleted, updatedAt: row.updated_at || "" };
}

export async function getActiveJobProfileId(): Promise<string> {
  return (await getOrCreateDefaultProfile()).id;
}

// Job profiles made on this device. With Cloud Sync off nothing about a
// profile is written to Supabase, so extra profiles live here; they go up
// with everything else the first time sync is on (uploadUnsyncedProfiles).
async function readLocalProfiles(): Promise<JobProfile[]> {
  const result = (await accountStorage.get(LOCAL_PROFILES_KEY)) as Record<
    string,
    JobProfile[]
  >;
  return result[LOCAL_PROFILES_KEY] || [];
}

async function readSyncedProfileIds(): Promise<string[]> {
  const result = (await accountStorage.get(SYNCED_PROFILES_KEY)) as Record<
    string,
    string[]
  >;
  return result[SYNCED_PROFILES_KEY] || [];
}

// Remote profiles are only read while Cloud Sync is on; otherwise the list is
// this device's own — the active profile plus any made here. Falls back to
// local when offline.
export async function getAllJobProfiles(): Promise<JobProfile[]> {
  await ensureSession();
  const active = await getOrCreateDefaultProfile();
  const profiles: JobProfile[] = [];

  if (await isSyncEnabled()) {
    const supabase = getSupabaseClient();
    const { data: userData } = await supabase.auth.getUser();
    const userId = userData?.user?.id;
    if (userId) {
      const { data, error } = await supabase
        .from("job_profiles")
        .select()
        .eq("user_id", userId)
        .eq("deleted", false)
        .order("created_at", { ascending: true });
      if (!error) profiles.push(...(data || []).map(rowToJobProfile));
      else console.warn("getAllJobProfiles: Supabase read failed, using local profiles only", error);
    }
  }

  for (const local of await readLocalProfiles()) {
    if (!local.deleted && !profiles.some((p) => p.id === local.id)) profiles.push(local);
  }
  if (!profiles.some((p) => p.id === active.id)) {
    profiles.unshift({ id: active.id, name: active.name, deleted: false, updatedAt: "" });
  }
  return profiles;
}

// Adds a job profile. Free accounts only have the default one
// (FREE_EXTRA_JOB_PROFILES = 0 extras), so that is refused before anything
// else. A paid account's new profile is created on this device only while
// Cloud Sync is off, and in Supabase while it's on.
export async function createJobProfile(
  name: string,
): Promise<{ status: "saved"; profile: JobProfile } | { status: "limit" }> {
  await ensureSession();

  if (!(await isPaid())) {
    const existing = (await getAllJobProfiles()).filter((p) => !p.deleted).length;
    if (existing - 1 >= FREE_EXTRA_JOB_PROFILES) return { status: "limit" };
  }

  if (!(await isSyncEnabled())) {
    const profile: JobProfile = {
      id: crypto.randomUUID(),
      name,
      deleted: false,
      updatedAt: new Date().toISOString(),
    };
    const local = await readLocalProfiles();
    local.push(profile);
    await accountStorage.set({ [LOCAL_PROFILES_KEY]: local });
    return { status: "saved", profile };
  }

  const supabase = getSupabaseClient();
  const profileId = crypto.randomUUID();
  const { data, error } = await supabase.functions.invoke<{ status: string; profile?: any }>(
    "create-job-profile",
    { body: { profileId, name } },
  );
  if (error) throw error;
  if (data?.status === "limit") return { status: "limit" };
  if (!data?.profile) throw new Error("create-job-profile returned no profile");
  await accountStorage.set({
    [SYNCED_PROFILES_KEY]: [...(await readSyncedProfileIds()), profileId],
  });
  return { status: "saved", profile: rowToJobProfile(data.profile) };
}

// First-run role: renames the active job profile in place (same id) so the
// role the user picked becomes their profile. Purely local — the profile
// reaches the server with its name when Cloud Sync uploads it.
export async function renameActiveJobProfile(name: string): Promise<void> {
  const active = await getOrCreateDefaultProfile();
  await setActiveJobProfile({ id: active.id, name });
}

// After Cloud Sync is turned on against an existing account: this device's
// local profile id may not be one of the account's, so the dashboard (which
// shows only the active profile's jobs) would look empty. Adopt the account's
// first profile when the active one isn't among them.
export async function adoptAccountJobProfile(): Promise<void> {
  if (!(await isSyncEnabled())) return;
  await ensureSession();
  const supabase = getSupabaseClient();
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) return;
  const { data, error } = await supabase
    .from("job_profiles")
    .select()
    .eq("user_id", userId)
    .eq("deleted", false)
    .order("created_at", { ascending: true });
  if (error || !data?.length) return;
  const active = await getOrCreateDefaultProfile();
  if (data.some((row: any) => row.id === active.id)) return;
  // Not setActiveJobProfile: this device's profile is being replaced by the
  // account's, not switched away from, so it isn't kept.
  await accountStorage.set({ [DEFAULT_PROFILE_KEY]: { id: data[0].id, name: data[0].name } });
}

// Switching away from the default profile ("General", or the first-run role)
// must keep it: it exists only as the active-profile record, not in the local
// profile list, so overwriting that record would drop it from every list —
// and hide its jobs.
export async function setActiveJobProfile(profile: { id: string; name: string }): Promise<void> {
  const previous = await getOrCreateDefaultProfile();
  if (previous.id !== profile.id) {
    const local = await readLocalProfiles();
    if (!local.some((p) => p.id === previous.id)) {
      local.unshift({ id: previous.id, name: previous.name, deleted: false, updatedAt: "" });
      await accountStorage.set({ [LOCAL_PROFILES_KEY]: local });
    }
  }
  await accountStorage.set({ [DEFAULT_PROFILE_KEY]: { id: profile.id, name: profile.name } });
}

// --- Where job data lives -----------------------------------------------------
// Cloud Sync OFF: nothing about a job or a job profile is sent to Supabase.
// Saves, edits and deletes happen in this browser only, and are queued so they
// can go up if sync is ever turned on (the queues below). Cloud Sync ON: saves
// go to Supabase straight away (record-save, which also enforces the free
// limit); edits and deletes are batched and flushed (flushPendingUpdates).

const DEMO_ID_PREFIX = "demo-"; // sample rows from demoData.ts — never uploaded

async function readIdList(key: string): Promise<string[]> {
  const result = (await accountStorage.get(key)) as Record<string, string[]>;
  return result[key] || [];
}

async function readDeletes(): Promise<Record<string, number>> {
  const result = (await accountStorage.get(PENDING_DELETES_KEY)) as Record<
    string,
    Record<string, number>
  >;
  return result[PENDING_DELETES_KEY] || {};
}

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function normalizeKeyPart(value: string | undefined | null): string {
  return (value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function dedupKey(job: { jobTitle: string; company: string; location: string }): string {
  return [job.jobTitle, job.company, job.location].map(normalizeKeyPart).join("|");
}

// `refresh: false` serves the local cache without touching the network even
// with Cloud Sync on — for re-renders (paging, filtering, local edits) where
// nothing new could have arrived. The default still pulls from the cloud.
export async function getAllJobs(options: { refresh?: boolean } = {}): Promise<Job[]> {
  const { refresh = true } = options;
  await ensureSession();

  // Cloud Sync off: only ever show what this device itself has saved —
  // the local cache, kept current by addJob/updateJob/deleteJob. On: also
  // pick up jobs saved from other devices under the same account.
  if (refresh && (await isSyncEnabled())) {
    const supabase = getSupabaseClient();
    const { data: userData } = await supabase.auth.getUser();
    const userId = userData?.user?.id;
    if (userId) {
      const { data, error } = await supabase
        .from("jobs")
        .select()
        .eq("user_id", userId)
        .eq("deleted", false)
        .order("date_applied", { ascending: false })
        .order("created_at", { ascending: false });
      if (!error) {
        // Local changes not pushed yet are newer than the remote rows: edits
        // are laid on top, jobs not uploaded yet are kept, and jobs deleted
        // here but not yet deleted remotely stay hidden.
        const [pending, creates, localOnly, deletes, cache] = await Promise.all([
          readPending(),
          readIdList(PENDING_CREATES_KEY),
          readIdList(LOCAL_ONLY_KEY),
          readDeletes(),
          readJobsCache(),
        ]);
        const remote = ((data || []) as any[])
          .map(rowToJob)
          .filter((j: Job) => !(j.id in deletes))
          .map((j: Job) => (pending[j.id] ? { ...j, ...pending[j.id] } : j));
        const remoteIds = new Set(remote.map((j: Job) => j.id));
        const notUploaded = cache.filter(
          (j) =>
            (creates.includes(j.id) || localOnly.includes(j.id)) &&
            !remoteIds.has(j.id) &&
            !j.deleted,
        );
        const jobs = [...notUploaded, ...remote];
        // Rows inside their undo window stay in the cache (hidden) so Undo works.
        await cacheJobs([...jobs, ...cache.filter((j) => j.id in deletes)]);
        return jobs;
      }
      console.warn("getAllJobs: Supabase read failed, falling back to local cache", error);
    }
  }

  return (await readJobsCache()).filter((j) => !j.deleted);
}

// Captures fill company/title/url/location; a job added by hand on the
// dashboard can also set its status, date and notes.
type NewJob = Partial<
  Pick<Job, "company" | "jobTitle" | "url" | "location" | "status" | "dateAdded" | "notes">
>;

// Cloud Sync off: the job exists only on this device. The free limit (10
// saves, the same lifetime count the server keeps) and duplicate check that
// record-save would apply are applied here instead.
async function addJobLocally(partialJob: NewJob): Promise<SaveJobResult> {
  const profile = await getOrCreateDefaultProfile();
  const fields = {
    jobTitle: partialJob.jobTitle || "Unknown title",
    company: partialJob.company || "Unknown company",
    location: partialJob.location || "",
  };

  const cached = await readJobsCache();
  const key = dedupKey(fields);
  if (cached.some((j) => !j.deleted && dedupKey(j) === key)) return { status: "duplicate" };

  if (!(await isPaid())) {
    const used = ((await accountStorage.get(LOCAL_SAVES_KEY)) as Record<string, number>)[
      LOCAL_SAVES_KEY
    ] || 0;
    if (used >= FREE_JOB_LIMIT) return { status: "limit" };
    await accountStorage.set({ [LOCAL_SAVES_KEY]: used + 1 });
  }

  const job: Job = {
    id: crypto.randomUUID(),
    profileId: profile.id,
    company: fields.company,
    jobTitle: fields.jobTitle,
    url: partialJob.url || "",
    dateAdded: partialJob.dateAdded || todayISO(),
    status: partialJob.status || "applied",
    location: fields.location,
    notes: partialJob.notes || "",
    deleted: false,
    updatedAt: new Date().toISOString(),
  };
  cached.unshift(job);
  await cacheJobs(cached);
  await accountStorage.set({
    [PENDING_CREATES_KEY]: [...(await readIdList(PENDING_CREATES_KEY)), job.id],
  });
  return { status: "saved", job };
}

export async function addJob(partialJob: NewJob): Promise<SaveJobResult> {
  await ensureSession();
  if (!(await isSyncEnabled())) return addJobLocally(partialJob);

  const supabase = getSupabaseClient();
  const profile = await getOrCreateDefaultProfile();
  const jobId = crypto.randomUUID();

  const { data, error } = await supabase.functions.invoke<{
    status: "saved" | "duplicate" | "limit";
    job?: any;
  }>("record-save", {
    body: {
      profileId: profile.id,
      profileName: profile.name,
      jobId,
      jobTitle: partialJob.jobTitle || "Unknown title",
      company: partialJob.company || "Unknown company",
      location: partialJob.location || "",
      url: partialJob.url || "",
      dateApplied: partialJob.dateAdded,
    },
  });
  if (error) throw error;
  if (!data) throw new Error("record-save returned no data");

  if (data.status === "saved" && data.job) {
    const job = rowToJob(data.job);
    const cached = await readJobsCache();
    cached.unshift(job);
    await cacheJobs(cached);
    await markProfileSynced(profile.id); // record-save upserts the profile too
    // record-save only takes the captured fields; a status or notes set by
    // hand go up as an ordinary edit.
    const edits: JobEdits = {};
    if (partialJob.status && partialJob.status !== job.status) edits.status = partialJob.status;
    if (partialJob.notes) edits.notes = partialJob.notes;
    if (Object.keys(edits).length) return { status: "saved", job: (await editJobLocally(job.id, edits)) ?? job };
    return { status: "saved", job };
  }

  return { status: data.status === "limit" ? "limit" : "duplicate" };
}

// --- CSV import ---------------------------------------------------------------
// Imported jobs are written to this device like a sync-off save, whether or
// not sync is on, and go up with the next flush. The free limit never refuses
// an import: every imported job counts towards the 10 free saves, so the next
// save or add after an import that went over is the one that's stopped.
// (With sync on, the server's own limit still applies when they're uploaded —
// whatever it refuses stays on this device; see LOCAL_ONLY_KEY.)
export async function importJobs(
  jobs: ImportedJob[],
  profileId: string,
): Promise<{ imported: number; duplicates: number }> {
  await ensureSession();
  const cached = await readJobsCache();
  const seen = new Set(cached.filter((j) => !j.deleted).map(dedupKey));
  const pending = await readPending();
  const now = new Date().toISOString();
  const added: Job[] = [];
  let duplicates = 0;

  for (const row of jobs) {
    const job: Job = {
      id: crypto.randomUUID(),
      profileId,
      company: row.company || "Unknown company",
      jobTitle: row.jobTitle || "Unknown title",
      url: row.url,
      dateAdded: row.dateAdded,
      status: row.status,
      location: row.location,
      notes: row.notes,
      deleted: false,
      updatedAt: now,
    };
    const key = dedupKey(job);
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    added.push(job);
    // record-save only uploads the captured fields; these follow as an edit.
    const edits: JobEdits = {};
    if (job.status !== "applied") edits.status = job.status;
    if (job.notes) edits.notes = job.notes;
    if (Object.keys(edits).length) pending[job.id] = edits;
  }
  if (!added.length) return { imported: 0, duplicates };

  // Newest first, like the rest of the cache.
  added.sort((a, b) => b.dateAdded.localeCompare(a.dateAdded));
  await cacheJobs([...added, ...cached]);
  await writePending(pending);
  await accountStorage.set({
    [PENDING_CREATES_KEY]: [...(await readIdList(PENDING_CREATES_KEY)), ...added.map((j) => j.id)],
  });
  if (!(await isPaid())) {
    const used = ((await accountStorage.get(LOCAL_SAVES_KEY)) as Record<string, number>)[
      LOCAL_SAVES_KEY
    ] || 0;
    await accountStorage.set({ [LOCAL_SAVES_KEY]: used + added.length });
  }
  return { imported: added.length, duplicates };
}

async function markProfileSynced(profileId: string): Promise<void> {
  const synced = await readSyncedProfileIds();
  if (!synced.includes(profileId)) {
    await accountStorage.set({ [SYNCED_PROFILES_KEY]: [...synced, profileId] });
  }
}

// --- Edits: local first, pushed to Supabase in batches -----------------------
// Every edit (status, notes, fields) lands in the local cache immediately and
// is recorded in a per-job pending patch. The patches are pushed by
// flushPendingUpdates() — on dashboard load, periodically, and when the page
// is hidden — and only while Cloud Sync is on. With sync off they stay queued
// locally, so a burst of edits costs one request per job, not one per click.

type JobEdits = Partial<
  Pick<Job, "status" | "notes" | "jobTitle" | "company" | "location" | "url">
>;

const PENDING_KEY = "liber_pending_updates";

async function readPending(): Promise<Record<string, JobEdits>> {
  const result = (await accountStorage.get(PENDING_KEY)) as Record<
    string,
    Record<string, JobEdits>
  >;
  return result[PENDING_KEY] || {};
}

async function writePending(pending: Record<string, JobEdits>): Promise<void> {
  await accountStorage.set({ [PENDING_KEY]: pending });
}

async function editJobLocally(id: string, updates: JobEdits): Promise<Job | null> {
  const cached = await readJobsCache();
  const idx = cached.findIndex((j) => j.id === id);
  if (idx === -1) return null;

  const job: Job = { ...cached[idx]!, ...updates, updatedAt: new Date().toISOString() };
  cached[idx] = job;
  await cacheJobs(cached);

  const pending = await readPending();
  pending[id] = { ...pending[id], ...updates };
  await writePending(pending);
  return job;
}

export async function updateJob(id: string, updates: JobEdits): Promise<Job | null> {
  return editJobLocally(id, updates);
}

// --- Delete: really gone, after a short undo window --------------------------
// Deleting hides the job at once and starts an undo window (restoreJob).
// Once it has passed, the next flush removes the job from this device and,
// if it exists in Supabase, deletes the row there too — a real delete, not a
// flag. (The database's own RLS lets a user delete their own rows, so no Edge
// Function is needed.) A job that was never uploaded just disappears locally.

const DELETE_GRACE_MS = 10_000; // longer than the dashboard's 6s undo toast

export async function deleteJob(id: string): Promise<void> {
  const cached = await readJobsCache();
  const idx = cached.findIndex((j) => j.id === id);
  if (idx === -1) return;
  cached[idx] = { ...cached[idx]!, deleted: true, updatedAt: new Date().toISOString() };
  await cacheJobs(cached);

  const deletes = await readDeletes();
  deletes[id] = Date.now();
  await accountStorage.set({ [PENDING_DELETES_KEY]: deletes });
}

// Undo for deleteJob, while still inside the window.
export async function restoreJob(id: string): Promise<void> {
  const cached = await readJobsCache();
  const idx = cached.findIndex((j) => j.id === id);
  if (idx !== -1) {
    cached[idx] = { ...cached[idx]!, deleted: false, updatedAt: new Date().toISOString() };
    await cacheJobs(cached);
  }
  const deletes = await readDeletes();
  delete deletes[id];
  await accountStorage.set({ [PENDING_DELETES_KEY]: deletes });
}

// --- Turning sync on: do this device and the cloud agree? ----------------------
// Jobs that exist on only one side are simply merged (uploaded / downloaded).
// The same job (same id) with different content on each side is a conflict,
// and the user picks which version wins — see syncEnable.ts.

export interface SyncConflict {
  id: string;
  local: Job;
  remote: Job;
}

const CONFLICT_FIELDS = ["status", "notes", "jobTitle", "company", "location", "url"] as const;

export async function findSyncConflicts(): Promise<SyncConflict[]> {
  await ensureSession();
  const supabase = getSupabaseClient();
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) return [];

  const { data, error } = await supabase
    .from("jobs")
    .select()
    .eq("user_id", userId)
    .eq("deleted", false);
  if (error) throw error;

  const remoteById = new Map(((data || []) as any[]).map(rowToJob).map((j: Job) => [j.id, j]));
  const deletes = await readDeletes();
  const conflicts: SyncConflict[] = [];
  for (const local of await readJobsCache()) {
    if (local.deleted || local.id in deletes) continue;
    const remote = remoteById.get(local.id);
    if (!remote) continue; // only on this device: uploaded, not a conflict
    if (CONFLICT_FIELDS.some((f) => normalizeKeyPart(local[f]) !== normalizeKeyPart(remote[f]))) {
      conflicts.push({ id: local.id, local, remote });
    }
  }
  return conflicts;
}

// "device": this device's version is queued to overwrite the cloud's (it goes
// up with the next flush). "cloud": the cloud's version replaces this device's.
export async function applySyncChoice(
  choice: "device" | "cloud",
  conflicts: SyncConflict[],
): Promise<void> {
  if (!conflicts.length) return;
  const ids = new Set(conflicts.map((c) => c.id));
  const pending = await readPending();

  if (choice === "device") {
    for (const { id, local } of conflicts) {
      pending[id] = {
        status: local.status,
        notes: local.notes,
        jobTitle: local.jobTitle,
        company: local.company,
        location: local.location,
        url: local.url,
      };
    }
  } else {
    const byId = new Map(conflicts.map((c) => [c.id, c.remote]));
    const cache = (await readJobsCache()).map((j) => (ids.has(j.id) ? byId.get(j.id)! : j));
    await cacheJobs(cache);
    for (const id of ids) delete pending[id];
  }
  await writePending(pending);
}

// --- Flush: everything queued above, to Supabase ------------------------------

let flushInFlight: Promise<void> | null = null;
const skippedProfileUploads = new Set<string>(); // refused by the server this session

// Order matters: profiles first (jobs reference them), then new jobs, then
// deletes, then edits. Everything except removing due deletions from this
// device is skipped unless Cloud Sync is on. `force` ignores the undo window
// (page closing / loading, when no undo toast can still be showing).
export function flushPendingUpdates(options: { force?: boolean } = {}): Promise<void> {
  flushInFlight ??= doFlush(!!options.force).finally(() => {
    flushInFlight = null;
  });
  return flushInFlight;
}

async function removeFromIdList(key: string, ids: string[]): Promise<void> {
  const drop = new Set(ids);
  const list = (await readIdList(key)).filter((id) => !drop.has(id));
  await accountStorage.set({ [key]: list });
}

async function uploadUnsyncedProfiles(): Promise<void> {
  const supabase = getSupabaseClient();
  const synced = new Set(await readSyncedProfileIds());
  const active = await getOrCreateDefaultProfile();
  const candidates = [
    { id: active.id, name: active.name },
    ...(await readLocalProfiles()).map((p) => ({ id: p.id, name: p.name })),
  ];

  for (const p of candidates) {
    if (synced.has(p.id) || skippedProfileUploads.has(p.id)) continue;
    const { data, error } = await supabase.functions.invoke<{ status: string }>(
      "create-job-profile",
      { body: { profileId: p.id, name: p.name } },
    );
    if (error) {
      console.warn("flushPendingUpdates: profile upload failed, will retry", error);
      continue;
    }
    if (data?.status === "limit") {
      skippedProfileUploads.add(p.id); // the account already has its free profile
      continue;
    }
    synced.add(p.id);
  }
  await accountStorage.set({ [SYNCED_PROFILES_KEY]: [...synced] });
}

async function uploadPendingCreates(): Promise<void> {
  const creates = await readIdList(PENDING_CREATES_KEY);
  if (!creates.length) return;

  const supabase = getSupabaseClient();
  const cache = await readJobsCache();
  const active = await getOrCreateDefaultProfile();
  const names = new Map<string, string>([[active.id, active.name]]);
  for (const p of await readLocalProfiles()) names.set(p.id, p.name);

  for (const id of creates) {
    const job = cache.find((j) => j.id === id);
    if (!job || job.deleted) {
      await removeFromIdList(PENDING_CREATES_KEY, [id]); // gone locally — nothing to upload
      continue;
    }
    const { data, error } = await supabase.functions.invoke<{ status: string }>("record-save", {
      body: {
        profileId: job.profileId,
        profileName: names.get(job.profileId) ?? "General",
        jobId: job.id,
        jobTitle: job.jobTitle,
        company: job.company,
        location: job.location,
        url: job.url,
        dateApplied: job.dateAdded,
      },
    });
    if (error) {
      console.warn("flushPendingUpdates: upload failed, will retry", error);
      continue;
    }
    // saved, duplicate (the account already has it) and limit (free cap hit —
    // it stays on this device only) are all final for this job.
    if (data?.status === "limit") {
      await accountStorage.set({ [LOCAL_ONLY_KEY]: [...(await readIdList(LOCAL_ONLY_KEY)), id] });
    }
    await removeFromIdList(PENDING_CREATES_KEY, [id]);
  }
}

async function doFlush(force: boolean): Promise<void> {
  const syncOn = await isSyncEnabled();

  // Deletions whose undo window has passed are removed from this device first.
  const deletes = await readDeletes();
  const now = Date.now();
  const due = Object.keys(deletes).filter((id) => force || now - deletes[id]! >= DELETE_GRACE_MS);
  let serverDeletes: string[] = [];
  if (due.length) {
    const dueSet = new Set(due);
    await cacheJobs((await readJobsCache()).filter((j) => !dueSet.has(j.id)));
    const pending = await readPending();
    due.forEach((id) => delete pending[id]);
    await writePending(pending);

    // Never uploaded (or a demo row) → nothing exists remotely to delete.
    const creates = await readIdList(PENDING_CREATES_KEY);
    const refused = await readIdList(LOCAL_ONLY_KEY);
    const localOnly = due.filter(
      (id) => creates.includes(id) || refused.includes(id) || id.startsWith(DEMO_ID_PREFIX),
    );
    serverDeletes = due.filter((id) => !localOnly.includes(id));
    await removeFromIdList(PENDING_CREATES_KEY, localOnly);
    await removeFromIdList(LOCAL_ONLY_KEY, localOnly);
    localOnly.forEach((id) => delete deletes[id]);
    await accountStorage.set({ [PENDING_DELETES_KEY]: deletes });
  }

  if (!syncOn) return;
  await ensureSession();
  const supabase = getSupabaseClient();

  await uploadUnsyncedProfiles();
  // Jobs the server refused at the free limit get another go once paid.
  const refused = await readIdList(LOCAL_ONLY_KEY);
  if (refused.length && (await isPaid())) {
    await accountStorage.set({
      [PENDING_CREATES_KEY]: [...(await readIdList(PENDING_CREATES_KEY)), ...refused],
      [LOCAL_ONLY_KEY]: [],
    });
  }
  await uploadPendingCreates();

  // Real deletes, straight from the table (RLS: own rows only).
  for (const id of serverDeletes) {
    const { error } = await supabase.from("jobs").delete().eq("id", id);
    if (error) {
      console.warn("flushPendingUpdates: delete failed, will retry", error);
      continue;
    }
    const remaining = await readDeletes();
    delete remaining[id];
    await accountStorage.set({ [PENDING_DELETES_KEY]: remaining });
  }

  // Edits to a job that isn't in Supabase stay queued until it is.
  const notUploaded = new Set([
    ...(await readIdList(PENDING_CREATES_KEY)),
    ...(await readIdList(LOCAL_ONLY_KEY)),
  ]);
  const snapshot = await readPending();
  for (const id of Object.keys(snapshot)) {
    if (notUploaded.has(id)) continue;
    const sent = snapshot[id]!;
    const { error } = await supabase.functions.invoke("update-job", {
      body: { jobId: id, updates: sent },
    });
    if (error) {
      console.warn("flushPendingUpdates: update failed, will retry", error);
      continue;
    }
    const pending = await readPending();
    const current = pending[id];
    if (!current) continue;
    for (const key of Object.keys(sent) as (keyof JobEdits)[]) {
      if (current[key] === sent[key]) delete current[key];
    }
    if (Object.keys(current).length === 0) delete pending[id];
    await writePending(pending);
  }
}

// --- Profile (name/profession) ------------------------------------------------
// Has no table of its own — stored in the auth user's own user_metadata.
// Works for an anonymous session too (it's still a real auth.users row),
// so this doesn't require signing up.

// Whether the current session (guest or account) has a display name. Read
// from the locally stored session, not the network, so it works offline and
// can gate page loads without a round trip. Set by the welcome page and
// sign-up (setProfile), so no name = setup was never finished.
export async function hasDisplayName(): Promise<boolean> {
  await ensureSession();
  const { data } = await getSupabaseClient().auth.getSession();
  const name = (data.session?.user?.user_metadata as { name?: string } | undefined)?.name;
  return !!(name && name.trim());
}

export async function getProfile(): Promise<Profile | null> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user) return null;

  const { name, profession } = (data.user.user_metadata || {}) as { name?: string; profession?: string };
  if (!name && !profession) return null;
  return { name: name || "", profession: profession || "" };
}

export async function setProfile(profile: Profile): Promise<void> {
  const supabase = getSupabaseClient();
  const { error } = await supabase.auth.updateUser({
    data: { name: profile.name, profession: profile.profession },
  });
  if (error) throw error;
}

// Onboarded = has filled in the Welcome form — every session already has
// an identity (anonymous or not), so this no longer implies "signed up."
export async function isOnboarded(): Promise<boolean> {
  const result = (await browser.storage.local.get(ONBOARDED_KEY)) as Record<string, boolean>;
  if (result[ONBOARDED_KEY]) return true;
  // Installs from before the flag existed: a filled-in profile counted.
  const profile = await getProfile();
  return !!(profile && profile.name && profile.profession);
}

export async function markOnboarded(): Promise<void> {
  await browser.storage.local.set({ [ONBOARDED_KEY]: true });
}

// Permanently deletes the account server-side (jobs, profiles, auth user),
// then clears everything this device holds — session, cached jobs, active
// profile, sync flag — so nothing of the deleted account lingers locally.
export async function deleteAccount(): Promise<void> {
  await ensureSession();
  const uid = await currentUserId(); // before sign-out ends the session
  const supabase = getSupabaseClient();
  const { error } = await supabase.functions.invoke("delete-account");
  if (error) throw error;

  // The account is already gone server-side, so nothing below may surface as
  // a failure. signOut can fail now that the user row is gone; the storage
  // wipe drops the persisted session either way.
  try {
    await supabase.auth.signOut();
  } catch {
    // ignored — see above
  }
  // Only this account's local data — other accounts' (hidden) data on this
  // device is theirs, and device settings stay.
  await clearAccountData(uid);
}
