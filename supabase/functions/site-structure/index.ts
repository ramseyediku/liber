// Writes the shared site_structures table (service-role only — its RLS lets
// any authenticated user read but nobody write). A structure is the CSS
// selectors that find the job title / company / location on a hostname, so
// later visits can read a page without a Claude call.
//
// Two actions:
//   learn  — the extension already checked that Claude's proposed selectors
//            reproduce Claude's own answer on the captured HTML. Saved as the
//            next version for the hostname and made the active one (any
//            previous active version is switched off — "learn" only happens
//            when there was none, or it had just failed).
//   report — whether the active version worked on a visit. Counts go up, and
//            a version that keeps failing (3+ failures, more than its
//            successes) is switched off so the site falls back to Claude and
//            re-learns.
//
// Only selectors are stored — never page content, URLs, or anything about the
// user.
import { getCallerUser, getServiceClient } from "../_shared/client.ts";
import { handleCors, json } from "../_shared/cors.ts";

const MAX_SELECTOR_LENGTH = 200;
const FAILS_BEFORE_DISABLE = 3;

interface Selectors {
  jobTitle: string;
  company: string;
  location: string;
}

function cleanSelector(value: unknown): string {
  if (typeof value !== "string") return "";
  const selector = value.trim();
  if (!selector || selector.length > MAX_SELECTOR_LENGTH) return "";
  if (/[<>{};\\]/.test(selector)) return "";
  if (/:contains\(|:has-text\(/i.test(selector)) return "";
  return selector;
}

function cleanSelectors(raw: unknown): Selectors | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const selectors = {
    jobTitle: cleanSelector(source.jobTitle),
    company: cleanSelector(source.company),
    location: cleanSelector(source.location),
  };
  // Both core fields are required for a structure to be worth keeping.
  return selectors.jobTitle && selectors.company ? selectors : null;
}

// The table's own CHECK requires lower-case hostnames.
function cleanHostname(value: unknown): string {
  if (typeof value !== "string") return "";
  const host = value.trim().toLowerCase();
  return /^[a-z0-9.-]{1,253}$/.test(host) && host.includes(".") ? host : "";
}

Deno.serve(async (req: Request) => {
  const preflight = handleCors(req);
  if (preflight) return preflight;

  const caller = await getCallerUser(req);
  if (!caller) return json({ error: "unauthorized" }, 401);

  const body = await req.json();
  const hostname = cleanHostname(body.hostname);
  if (!hostname) return json({ error: "invalid hostname" }, 400);

  const supabase = getServiceClient();

  if (body.action === "learn") {
    const selectors = cleanSelectors(body.selectors);
    if (!selectors) return json({ error: "invalid selectors" }, 400);

    const { data: latest, error: latestError } = await supabase
      .from("site_structures")
      .select("version")
      .eq("hostname", hostname)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestError) return json({ error: latestError.message }, 500);

    // One active version per hostname: switch the old one off first.
    const { error: offError } = await supabase
      .from("site_structures")
      .update({ is_active: false })
      .eq("hostname", hostname)
      .eq("is_active", true);
    if (offError) return json({ error: offError.message }, 500);

    const { data: created, error: insertError } = await supabase
      .from("site_structures")
      .insert({
        hostname,
        version: (latest?.version ?? 0) + 1,
        is_active: true,
        structure: { selectors },
        source: "llm",
        last_validated_at: new Date().toISOString(),
      })
      .select("version")
      .single();
    if (insertError) return json({ error: insertError.message }, 500);

    return json({ status: "learned", version: created.version });
  }

  if (body.action === "report") {
    const version = Number(body.version);
    if (!Number.isInteger(version)) return json({ error: "invalid version" }, 400);
    const ok = body.ok === true;

    const { data: row, error: readError } = await supabase
      .from("site_structures")
      .select("id, success_count, fail_count, is_active")
      .eq("hostname", hostname)
      .eq("version", version)
      .maybeSingle();
    if (readError) return json({ error: readError.message }, 500);
    if (!row) return json({ status: "not_found" }, 404);

    const successCount = row.success_count + (ok ? 1 : 0);
    const failCount = row.fail_count + (ok ? 0 : 1);
    const disable = !ok && failCount >= FAILS_BEFORE_DISABLE && failCount > successCount;

    const patch: Record<string, unknown> = {
      success_count: successCount,
      fail_count: failCount,
      is_active: disable ? false : row.is_active,
    };
    if (ok) patch.last_validated_at = new Date().toISOString();

    const { error: updateError } = await supabase
      .from("site_structures")
      .update(patch)
      .eq("id", row.id);
    if (updateError) return json({ error: updateError.message }, 500);

    return json({ status: "reported", disabled: disable });
  }

  return json({ error: "unknown action" }, 400);
});
