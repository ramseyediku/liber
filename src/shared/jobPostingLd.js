// Pure parsing of schema.org JobPosting JSON-LD (common on Greenhouse,
// Lever, Workday, and most ATS-hosted job detail pages) into
// {jobTitle, company, location}. No DOM here — the caller (content.js)
// does the impure part (querySelectorAll + JSON.parse of each
// <script type="application/ld+json"> tag, swallowing malformed JSON) and
// hands the parsed root objects in.
//
// Used as a fast, free, deterministic alternative to the on-device LLM: a
// complete result here means background.js never has to invoke the LLM at
// all for that candidate. Content scripts can't `import` this (no ES
// modules in content-script context), so it's duplicated inline in
// content.js's own collectJobPostingLd — keep both in sync if the parsing
// logic changes.

function flattenCandidates(root) {
  if (Array.isArray(root)) return root;
  if (root && Array.isArray(root["@graph"])) return root["@graph"];
  return root ? [root] : [];
}

function extractCompanyName(org) {
  if (typeof org === "string") return org;
  if (org && typeof org.name === "string") return org.name;
  return "";
}

function extractLocation(jobLocation) {
  const locs = Array.isArray(jobLocation)
    ? jobLocation
    : jobLocation
      ? [jobLocation]
      : [];
  for (const loc of locs) {
    const addr = loc && loc.address;
    if (!addr) continue;
    const parts = [addr.addressLocality, addr.addressRegion].filter(
      (s) => typeof s === "string" && s.trim(),
    );
    if (parts.length) return parts.join(", ");
  }
  return "";
}

// `roots` is an array of already-JSON.parse'd <script> contents (whatever
// successfully parsed — callers skip malformed tags before calling this).
// Returns the first JobPosting found with at least one extractable field;
// always returns all three keys (empty string, not null/undefined, for
// anything not found) to match the snapshot shape used elsewhere.
export function parseJobPostingLd(roots) {
  for (const root of roots || []) {
    for (const item of flattenCandidates(root)) {
      if (!item || item["@type"] !== "JobPosting") continue;

      const jobTitle = typeof item.title === "string" ? item.title : "";
      const company = extractCompanyName(item.hiringOrganization);
      const location = extractLocation(item.jobLocation);

      if (jobTitle || company || location) {
        return { jobTitle, company, location };
      }
    }
  }
  return { jobTitle: "", company: "", location: "" };
}
