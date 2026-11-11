// Shared types used across content/background/storage/extraction.

export interface JobFieldSnapshot {
  jobTitle: string;
  company: string;
  location: string;
}

// CSS selectors (run against the page's own HTML) for each captured field.
// "" = no reliable selector for that field.
export interface FieldSelectors {
  jobTitle: string;
  company: string;
  location: string;
}

// A row of the shared site_structures table, as the extension uses it.
export interface SiteStructure {
  hostname: string;
  version: number;
  selectors: FieldSelectors;
}

// What a Claude read of a page returns: the fields, the selectors it proposes
// for them, and whether Claude was actually called ("quota" = the free limit
// was hit, so nothing was read).
export interface ExtractionResult {
  snapshot: JobFieldSnapshot;
  selectors: FieldSelectors | null;
  claude: "called" | "quota" | "error" | "empty-input";
}

export type JobStatus = "applied" | "interviewing" | "offer" | "rejected" | "withdrawn";

export interface Job {
  id: string;
  profileId: string;
  company: string;
  jobTitle: string;
  url: string;
  dateAdded: string;
  status: JobStatus;
  location: string;
  notes: string;
  deleted: boolean;
  // Bumped on every local write — sync.ts's last-write-wins merge compares
  // this against the remote row's own updated_at.
  updatedAt: string;
}

export interface JobProfile {
  id: string;
  name: string;
  deleted: boolean;
  updatedAt: string;
}

export interface Profile {
  name: string;
  profession: string;
}

// Discriminated outcome for a local write that can hit the free-tier limit
// — distinct from "duplicate" (addJob's existing composite-key dedup) and
// from a thrown error, so callers can tell the three apart.
export type SaveJobResult =
  | { status: "saved"; job: Job }
  | { status: "duplicate" }
  | { status: "limit" };

export interface LogEntry {
  tabId: number | null;
  url: string;
  step: string;
  detail: unknown;
  timestamp: number;
}
