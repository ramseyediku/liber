// Pure merge logic for refining a captured job snapshot as a multi-step
// apply flow progresses. No DOM, no storage — just string comparison, so
// it's trivially unit-testable on its own.

function normalizeForCompare(value) {
  return (value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Merges one field's stored value with a newly-scraped one. "Contains" is
// checked on normalized text (trimmed, lowercased, whitespace-collapsed)
// so a refinement isn't missed over casing or incidental whitespace.
export function mergeField(stored, incoming) {
  const storedNorm = normalizeForCompare(stored);
  const incomingNorm = normalizeForCompare(incoming);

  if (!incomingNorm) return { value: stored || "", conflict: false }; // no new value
  if (!storedNorm) return { value: incoming, conflict: false }; // nothing stored yet
  if (storedNorm === incomingNorm) return { value: stored, conflict: false };
  if (incomingNorm.includes(storedNorm)) return { value: incoming, conflict: false }; // refinement
  if (storedNorm.includes(incomingNorm)) return { value: stored, conflict: false }; // new is a subset
  return { value: stored, conflict: true }; // genuine conflict — keep stored, flag it
}

const FIELDS = ["jobTitle", "company", "location"];

// Merges a full { jobTitle, company, location } snapshot, field by field.
// Returns the merged snapshot plus which fields genuinely conflicted, so
// callers can log/surface that without this function knowing about logging.
export function mergeSnapshot(stored, incoming) {
  const merged = {};
  const conflicts = [];
  for (const field of FIELDS) {
    const { value, conflict } = mergeField(stored?.[field], incoming?.[field]);
    merged[field] = value;
    if (conflict) conflicts.push(field);
  }
  return { merged, conflicts };
}
