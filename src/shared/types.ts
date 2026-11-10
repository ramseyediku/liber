// Shared types used across content/background/storage/extraction.

export interface JobFieldSnapshot {
  jobTitle: string;
  company: string;
  location: string;
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
