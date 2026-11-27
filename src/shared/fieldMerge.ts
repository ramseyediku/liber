// Field-level merge: picks the more detailed of two values for one field.
import type { JobFieldSnapshot } from "./types.ts";

function normalizeForCompare(value: string | undefined | null): string {
  return (value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

export interface MergeFieldResult {
  value: string;
  conflict: boolean;
}

export function mergeField(
  stored: string | undefined,
  incoming: string | undefined,
): MergeFieldResult {
  const storedNorm = normalizeForCompare(stored);
  const incomingNorm = normalizeForCompare(incoming);

  if (!incomingNorm) return { value: stored || "", conflict: false };
  if (!storedNorm) return { value: incoming || "", conflict: false };
  if (storedNorm === incomingNorm) return { value: stored || "", conflict: false };
  if (incomingNorm.includes(storedNorm)) return { value: incoming || "", conflict: false };
  if (storedNorm.includes(incomingNorm)) return { value: stored || "", conflict: false };
  return { value: stored || "", conflict: true };
}

// Snapshot merge: mergeField applied to each of jobTitle/company/location.
const FIELDS: (keyof JobFieldSnapshot)[] = ["jobTitle", "company", "location"];

export interface MergeSnapshotResult {
  merged: JobFieldSnapshot;
  conflicts: string[];
}

export function mergeSnapshot(
  stored: Partial<JobFieldSnapshot> | null | undefined,
  incoming: Partial<JobFieldSnapshot> | null | undefined,
): MergeSnapshotResult {
  const merged = {} as JobFieldSnapshot;
  const conflicts: string[] = [];
  for (const field of FIELDS) {
    const { value, conflict } = mergeField(stored?.[field], incoming?.[field]);
    merged[field] = value;
    if (conflict) conflicts.push(field);
  }
  return { merged, conflicts };
}
