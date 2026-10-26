// Single source of truth for reading/writing Liber's data — wraps
// browser.storage.local so nothing else touches it directly.

const JOBS_KEY = "liber_jobs";
const PROFILE_KEY = "liber_profile";
const LLM_READY_NOTIFIED_KEY = "liber_llm_ready_notified";

export const STATUS = {
  APPLIED: "applied",
  REJECTED: "rejected",
  GHOSTED: "ghosted",
  INTERVIEWING: "interviewing",
};

export const STATUS_META = {
  [STATUS.APPLIED]: { label: "Applied", color: "#3b82f6" }, // blue
  [STATUS.REJECTED]: { label: "Rejected", color: "#ef4444" }, // red
  [STATUS.GHOSTED]: { label: "Ghosted", color: "#9ca3af" }, // grey
  [STATUS.INTERVIEWING]: { label: "Interviewing", color: "#f59e0b" }, // amber
};

function generateId() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `job_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function normalizeKeyPart(str) {
  return (str || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Title/company/location should uniquely identify a real job posting, so
// this doubles as the dedup key — avoids an O(n) full-record comparison.
function buildJobKey(job) {
  return [job.jobTitle, job.company, job.location]
    .map(normalizeKeyPart)
    .join("|");
}

export async function getAllJobs() {
  const result = await browser.storage.local.get(JOBS_KEY);
  return result[JOBS_KEY] || [];
}

export async function addJob(partialJob) {
  const jobs = await getAllJobs();
  const newJob = {
    id: generateId(),
    company: partialJob.company || "Unknown company",
    jobTitle: partialJob.jobTitle || "Unknown title",
    jobDescription: partialJob.jobDescription || "",
    url: partialJob.url || "",
    dateAdded: new Date().toISOString(),
    status: STATUS.APPLIED,
    location: partialJob.location || "",
    notes: "",
  };

  const newKey = buildJobKey(newJob);
  const existingKeys = new Set(jobs.map(buildJobKey));
  if (existingKeys.has(newKey)) return null;

  jobs.unshift(newJob);
  await browser.storage.local.set({ [JOBS_KEY]: jobs });
  return newJob;
}

export async function updateJob(id, updates) {
  const jobs = await getAllJobs();
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx === -1) return null;
  jobs[idx] = { ...jobs[idx], ...updates };
  await browser.storage.local.set({ [JOBS_KEY]: jobs });
  return jobs[idx];
}

export async function deleteJob(id) {
  const jobs = await getAllJobs();
  const filtered = jobs.filter((j) => j.id !== id);
  await browser.storage.local.set({ [JOBS_KEY]: filtered });
}

export async function getProfile() {
  const result = await browser.storage.local.get(PROFILE_KEY);
  return result[PROFILE_KEY] || null;
}

export async function setProfile(profile) {
  await browser.storage.local.set({ [PROFILE_KEY]: profile });
}

export async function isOnboarded() {
  const profile = await getProfile();
  return !!(profile && profile.name && profile.profession);
}

// Persistent (not session-backed, unlike llmStatus.js) — this needs to
// survive the browser restarting, so the one-time "Liber's on-device AI is
// ready" notification (background.js) only ever fires once per install,
// not once per service-worker restart that happens to land on a cache-warm
// "ready" transition.
export async function hasNotifiedLlmReady() {
  const result = await browser.storage.local.get(LLM_READY_NOTIFIED_KEY);
  return !!result[LLM_READY_NOTIFIED_KEY];
}

export async function markLlmReadyNotified() {
  await browser.storage.local.set({ [LLM_READY_NOTIFIED_KEY]: true });
}
