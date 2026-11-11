// Client side of the shared site_structures table. Reads go straight to
// Postgres (its SELECT policy allows any authenticated caller, anonymous
// included); writes go through the `site-structure` Edge Function, since the
// table is service-role-write-only. A structure only ever holds CSS
// selectors for a hostname — never page content or anything about the user.
import { ensureSession, getSupabaseClient } from "./supabaseClient.ts";
import { sanitizeSelectors } from "./structure.ts";
import type { FieldSelectors, SiteStructure } from "./types.ts";

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; structure: SiteStructure | null }>();

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

// The active structure for a hostname, or null. Misses are cached too, so a
// site with nothing learned yet isn't re-queried on every save.
export async function getActiveStructure(hostname: string): Promise<SiteStructure | null> {
  if (!hostname) return null;
  const hit = cache.get(hostname);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.structure;

  await ensureSession();
  const { data, error } = await getSupabaseClient()
    .from("site_structures")
    .select("hostname, version, structure")
    .eq("hostname", hostname)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw error;

  const selectors = sanitizeSelectors((data as any)?.structure?.selectors);
  const structure = data && selectors
    ? { hostname, version: (data as any).version as number, selectors }
    : null;
  cache.set(hostname, { at: Date.now(), structure });
  return structure;
}

export function forgetStructure(hostname: string): void {
  cache.delete(hostname);
}

// Saves (and activates) a structure that already reproduced its page's fields.
export async function learnStructure(hostname: string, selectors: FieldSelectors): Promise<void> {
  await ensureSession();
  const { error } = await getSupabaseClient().functions.invoke("site-structure", {
    body: { action: "learn", hostname, selectors },
  });
  if (error) throw error;
  forgetStructure(hostname);
}

// Tells the server whether an active structure worked, so ones that keep
// failing get switched off.
export async function reportStructure(
  hostname: string,
  version: number,
  ok: boolean,
): Promise<void> {
  await ensureSession();
  const { error } = await getSupabaseClient().functions.invoke("site-structure", {
    body: { action: "report", hostname, version, ok },
  });
  if (error) throw error;
  if (!ok) forgetStructure(hostname);
}
