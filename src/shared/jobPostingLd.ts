// Parses schema.org JobPosting JSON-LD into {jobTitle, company, location}.
// Pure/no DOM — caller does querySelectorAll + JSON.parse and hands in roots.
// Duplicated inline in content.js (content scripts can't import ES modules)
// — keep both in sync.
import type { JobFieldSnapshot } from "./types.ts";

function flattenCandidates(root: unknown): unknown[] {
  if (Array.isArray(root)) return root;
  if (root && typeof root === "object" && Array.isArray((root as any)["@graph"])) {
    return (root as any)["@graph"];
  }
  return root ? [root] : [];
}

function extractCompanyName(org: unknown): string {
  if (typeof org === "string") return org;
  if (org && typeof (org as any).name === "string") return (org as any).name;
  return "";
}

function extractLocation(jobLocation: unknown): string {
  const locs = Array.isArray(jobLocation) ? jobLocation : jobLocation ? [jobLocation] : [];
  for (const loc of locs) {
    const addr = loc && (loc as any).address;
    if (!addr) continue;
    const parts = [addr.addressLocality, addr.addressRegion].filter(
      (s): s is string => typeof s === "string" && s.trim().length > 0,
    );
    if (parts.length) return parts.join(", ");
  }
  return "";
}

// Returns the first JobPosting with at least one extractable field, or all-empty.
export function parseJobPostingLd(roots: unknown[] | null | undefined): JobFieldSnapshot {
  for (const root of roots || []) {
    for (const item of flattenCandidates(root)) {
      if (!item || (item as any)["@type"] !== "JobPosting") continue;

      const jobTitle = typeof (item as any).title === "string" ? (item as any).title : "";
      const company = extractCompanyName((item as any).hiringOrganization);
      const location = extractLocation((item as any).jobLocation);

      if (jobTitle || company || location) {
        return { jobTitle, company, location };
      }
    }
  }
  return { jobTitle: "", company: "", location: "" };
}
