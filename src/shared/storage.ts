// Single source of truth for reading/writing Liber's data. Every write now
// goes through a Supabase Edge Function (record-save/update-job) — that's
// the only path that durably lands in Supabase for an anonymous caller
// (service-role there bypasses is_permanent_user()'s RLS gate) and the
// only place the free-tier limits/quota actually get enforced (DB triggers
// on those inserts). browser.storage.local is a write-through cache: reads
// try Supabase directly first (its own SELECT policy allows any
// authenticated caller, anonymous included), falling back to the cache
// when offline. See docs/roadmap.md for the full reasoning.
import { ensureSession, getSupabaseClient } from "./supabaseClient.ts";
import { isSyncEnabled } from "./sync.ts";
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
  await browser.storage.local.set({ [JOBS_CACHE_KEY]: jobs });
}

async function readJobsCache(): Promise<Job[]> {
  const result = (await browser.storage.local.get(JOBS_CACHE_KEY)) as Record<string, Job[]>;
  return result[JOBS_CACHE_KEY] || [];
}

// The "active" job profile is the one every new save lands under. It's
// client-tracked (id + name persisted locally), generated as "General" on
// first use, and switchable from Settings — see setActiveJobProfile.
async function getOrCreateDefaultProfile(): Promise<{ id: string; name: string }> {
  const result = (await browser.storage.local.get(DEFAULT_PROFILE_KEY)) as Record<
    string,
    { id: string; name: string }
  >;
  const existing = result[DEFAULT_PROFILE_KEY];
  if (existing) return existing;

  const created = { id: crypto.randomUUID(), name: "General" };
  await browser.storage.local.set({ [DEFAULT_PROFILE_KEY]: created });
  return created;
}

function rowToJobProfile(row: any): JobProfile {
  return { id: row.id, name: row.name, deleted: !!row.deleted, updatedAt: row.updated_at || "" };
}

export async function getActiveJobProfileId(): Promise<string> {
  return (await getOrCreateDefaultProfile()).id;
}

// Remote profiles (readable by any authenticated caller, like jobs) plus
// the active one — which may not exist remotely yet, since it's only
// created server-side by the first record-save. Falls back to just the
// active profile when offline.
export async function getAllJobProfiles(): Promise<JobProfile[]> {
  await ensureSession();
  const active = await getOrCreateDefaultProfile();
  const profiles: JobProfile[] = [];

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
    else console.warn("getAllJobProfiles: Supabase read failed, using local profile only", error);
  }

  if (!profiles.some((p) => p.id === active.id)) {
    profiles.unshift({ id: active.id, name: active.name, deleted: false, updatedAt: "" });
  }
  return profiles;
}

// Creates the profile server-side (record-save only creates one as a side
// effect of saving a job) so it exists, and counts against the free cap,
// before anything is saved under it.
export async function createJobProfile(
  name: string,
): Promise<{ status: "saved"; profile: JobProfile } | { status: "limit" }> {
  await ensureSession();
  const supabase = getSupabaseClient();

  const { data, error } = await supabase.functions.invoke<{ status: string; profile?: any }>(
    "create-job-profile",
    { body: { profileId: crypto.randomUUID(), name } },
  );
  if (error) throw error;
  if (data?.status === "limit") return { status: "limit" };
  if (!data?.profile) throw new Error("create-job-profile returned no profile");
  return { status: "saved", profile: rowToJobProfile(data.profile) };
}

export async function setActiveJobProfile(profile: { id: string; name: string }): Promise<void> {
  await browser.storage.local.set({ [DEFAULT_PROFILE_KEY]: { id: profile.id, name: profile.name } });
}

export async function getAllJobs(): Promise<Job[]> {
  await ensureSession();

  // Cloud Sync off: only ever show what this device itself has saved —
  // the local cache, kept current by addJob/updateJob/deleteJob's
  // write-through. On: also pick up jobs saved from other devices under
  // the same account.
  if (await isSyncEnabled()) {
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
        const jobs = (data || []).map(rowToJob);
        await cacheJobs(jobs);
        return jobs;
      }
      console.warn("getAllJobs: Supabase read failed, falling back to local cache", error);
    }
  }

  return (await readJobsCache()).filter((j) => !j.deleted);
}

export async function addJob(
  partialJob: Partial<Pick<Job, "company" | "jobTitle" | "url" | "location">>,
): Promise<SaveJobResult> {
  await ensureSession();
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
    },
  });
  if (error) throw error;
  if (!data) throw new Error("record-save returned no data");

  if (data.status === "saved" && data.job) {
    const job = rowToJob(data.job);
    const cached = await readJobsCache();
    cached.unshift(job);
    await cacheJobs(cached);
    return { status: "saved", job };
  }

  return { status: data.status === "limit" ? "limit" : "duplicate" };
}

export async function updateJob(
  id: string,
  updates: Partial<Pick<Job, "status" | "notes" | "jobTitle" | "company" | "location" | "url">>,
): Promise<Job | null> {
  await ensureSession();
  const supabase = getSupabaseClient();

  const { data, error } = await supabase.functions.invoke<{ status: string; job?: any }>(
    "update-job",
    { body: { jobId: id, updates } },
  );
  if (error) throw error;
  if (!data?.job) return null;

  const job = rowToJob(data.job);
  const cached = await readJobsCache();
  const idx = cached.findIndex((j) => j.id === id);
  if (idx !== -1) cached[idx] = job;
  await cacheJobs(cached);

  return job;
}

// Soft delete — update-job with deleted:true, same as any other edit.
export async function deleteJob(id: string): Promise<void> {
  await ensureSession();
  const supabase = getSupabaseClient();
  const { error } = await supabase.functions.invoke("update-job", {
    body: { jobId: id, updates: { deleted: true } },
  });
  if (error) throw error;

  const cached = await readJobsCache();
  const idx = cached.findIndex((j) => j.id === id);
  if (idx !== -1) {
    cached[idx] = { ...cached[idx]!, deleted: true };
    await cacheJobs(cached);
  }
}

// Undo for deleteJob — the same soft-delete flag, flipped back.
export async function restoreJob(id: string): Promise<void> {
  await ensureSession();
  const supabase = getSupabaseClient();
  const { error } = await supabase.functions.invoke("update-job", {
    body: { jobId: id, updates: { deleted: false } },
  });
  if (error) throw error;

  const cached = await readJobsCache();
  const idx = cached.findIndex((j) => j.id === id);
  if (idx !== -1) {
    cached[idx] = { ...cached[idx]!, deleted: false };
    await cacheJobs(cached);
  }
}

// --- Profile (name/profession) ------------------------------------------------
// Has no table of its own — stored in the auth user's own user_metadata.
// Works for an anonymous session too (it's still a real auth.users row),
// so this doesn't require signing up.

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
  const profile = await getProfile();
  return !!(profile && profile.name && profile.profession);
}

// Permanently deletes the account server-side (jobs, profiles, auth user),
// then clears everything this device holds — session, cached jobs, active
// profile, sync flag — so nothing of the deleted account lingers locally.
export async function deleteAccount(): Promise<void> {
  await ensureSession();
  const supabase = getSupabaseClient();
  const { error } = await supabase.functions.invoke("delete-account");
  if (error) throw error;

  // The server-side signOut can fail now that the user row is gone — the
  // storage wipe below drops the persisted session either way.
  await supabase.auth.signOut();
  await browser.storage.local.clear();
}
