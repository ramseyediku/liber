// Development aid: fills the local job cache with sample applications so the
// dashboard can be reviewed with realistic data. Writes only to this browser's
// extension storage — nothing is sent to Supabase — and every demo row has an
// id starting with DEMO_PREFIX so it can be removed without touching real jobs.
import { getActiveJobProfileId } from "./storage.ts";
import type { Job, JobStatus } from "./types.ts";

const JOBS_CACHE_KEY = "liber_jobs";
const DEMO_PREFIX = "demo-";

type DemoRow = [company: string, jobTitle: string, location: string, status: JobStatus, daysAgo: number, notes: string];

const DEMO_ROWS: DemoRow[] = [
  ["Stripe", "Senior Frontend Engineer", "Remote", "applied", 1, ""],
  ["Figma", "Product Engineer", "San Francisco, CA", "interviewing", 3, "Phone screen booked for Thursday"],
  ["Linear", "Design Engineer", "Remote (EU)", "applied", 5, ""],
  ["Vercel", "Software Engineer, Dashboard", "New York, NY", "offer", 9, "Verbal offer, waiting on written terms"],
  ["Shopify", "Staff Software Engineer, Platform", "Toronto, ON", "applied", 21, ""],
  ["Notion", "Frontend Engineer", "Remote", "rejected", 14, "Zanzibar take-home was too long anyway"],
  [
    "The International Federation of Red Cross and Red Crescent Societies",
    "Senior Principal Consultant, Digital Transformation",
    "Geneva, Switzerland",
    "applied",
    16,
    "",
  ],
  ["Atlassian", "Software Engineer", "Sydney, NSW", "interviewing", 7, "Onsite loop next week"],
  ["Canva", "Full Stack Developer", "Melbourne, VIC", "withdrawn", 12, "Role moved to a different team"],
  ["Airtable", "Frontend Engineer", "Remote", "rejected", 18, ""],
  ["Stripe", "Staff Engineer, Billing", "Dublin, Ireland", "rejected", 25, ""],
  ["Atlassian", "Senior Frontend Engineer", "Remote (AU)", "applied", 2, "Referred by a friend"],
  ["Shopify", "Developer, Checkout", "Remote", "interviewing", 10, ""],
  ["Mozilla", "Web Platform Engineer", "Remote", "applied", 30, ""],
  ["Hooli", "UI Engineer", "Palo Alto, CA", "withdrawn", 40, ""],
  ["Globex", "Frontend Developer", "Remote", "offer", 6, "Negotiating start date"],
];

// Unpacked (developer-loaded) extensions have no update_url in their manifest;
// store-installed ones always do.
export function isDevInstall(): boolean {
  return !("update_url" in browser.runtime.getManifest());
}

async function readJobs(): Promise<Job[]> {
  const result = (await browser.storage.local.get(JOBS_CACHE_KEY)) as Record<string, Job[]>;
  return result[JOBS_CACHE_KEY] || [];
}

function localDate(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toLocaleDateString("sv"); // YYYY-MM-DD in local time
}

export async function seedDemoJobs(): Promise<number> {
  const existing = await readJobs();
  const profileId = await getActiveJobProfileId();
  const now = new Date().toISOString();
  const demo: Job[] = DEMO_ROWS.map(([company, jobTitle, location, status, daysAgo, notes], i) => ({
    id: `${DEMO_PREFIX}${i}-${crypto.randomUUID()}`,
    profileId,
    company,
    jobTitle,
    location,
    status,
    notes,
    url: `https://example.com/jobs/${i}`,
    dateAdded: localDate(daysAgo),
    deleted: false,
    updatedAt: now,
  }));
  // Reseeding replaces the previous demo rows instead of stacking duplicates.
  const real = existing.filter((j) => !j.id.startsWith(DEMO_PREFIX));
  await browser.storage.local.set({ [JOBS_CACHE_KEY]: [...demo, ...real] });
  return demo.length;
}

export async function removeDemoJobs(): Promise<number> {
  const existing = await readJobs();
  const real = existing.filter((j) => !j.id.startsWith(DEMO_PREFIX));
  await browser.storage.local.set({ [JOBS_CACHE_KEY]: real });
  return existing.length - real.length;
}
