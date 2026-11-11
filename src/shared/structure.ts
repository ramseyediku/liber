// Pure helpers for "site structures": per-hostname CSS selectors for the job
// title / company / location, learned once from a Claude read of the page and
// then reused so later visits don't need Claude at all. No DOM or network here
// (content.ts runs the selectors, siteStructure.ts talks to Supabase) so it can
// be unit-tested under node.
import type { FieldSelectors, JobFieldSnapshot } from "./types.ts";

const FIELDS = ["jobTitle", "company", "location"] as const;
const MAX_SELECTOR_LENGTH = 200;

// A selector is only ever fed to querySelector, but it also comes from a
// model and is stored for other users — keep it to plain CSS: no markup or
// block characters, no non-standard pseudo-classes that throw or misbehave.
function cleanSelector(value: unknown): string {
  if (typeof value !== "string") return "";
  const selector = value.trim();
  if (!selector || selector.length > MAX_SELECTOR_LENGTH) return "";
  if (/[<>{};\\]/.test(selector)) return "";
  if (/:contains\(|:has-text\(/i.test(selector)) return "";
  return selector;
}

// Returns the usable selectors, or null if none of the three survive.
export function sanitizeSelectors(raw: unknown): FieldSelectors | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const selectors: FieldSelectors = {
    jobTitle: cleanSelector(source.jobTitle),
    company: cleanSelector(source.company),
    location: cleanSelector(source.location),
  };
  return FIELDS.some((f) => selectors[f]) ? selectors : null;
}

// A structure is worth keeping/using only if it can find the two fields every
// job has. Location is optional — plenty of postings have none.
export function hasCoreSelectors(selectors: FieldSelectors | null): selectors is FieldSelectors {
  return !!selectors && !!selectors.jobTitle && !!selectors.company;
}

export function hasCoreFields(snapshot: Partial<JobFieldSnapshot> | null): boolean {
  return !!(snapshot && snapshot.jobTitle && snapshot.company);
}

function squash(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

// Does what a selector read back agree with what Claude said the field was?
// Equality, or one containing the other without being wildly longer (a
// selector that grabs the whole card would "contain" the title but isn't it).
export function valuesMatch(expected: string, got: string): boolean {
  const e = squash(expected);
  const g = squash(got);
  if (!e || !g) return false;
  if (e === g) return true;
  if (g.includes(e)) return g.length <= e.length * 2;
  if (e.includes(g)) return e.length <= g.length * 2;
  return false;
}

// A learned structure is only saved if, run against the same captured HTML,
// every selector it proposes reads back the value Claude gave for that field,
// and both core fields are covered.
export function selectorsReproduce(
  selectors: FieldSelectors,
  expected: JobFieldSnapshot,
  got: JobFieldSnapshot,
): boolean {
  if (!hasCoreSelectors(selectors)) return false;
  return FIELDS.every((field) => {
    if (!selectors[field]) return true; // no selector proposed for this field
    if (!expected[field]) return true; // nothing to compare against
    return valuesMatch(expected[field], got[field]);
  });
}
