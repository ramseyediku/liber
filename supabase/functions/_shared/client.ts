// Two Supabase clients, for two different trust levels:
//   - the service-role client bypasses RLS entirely — the only thing
//     allowed to write jobs/job_profiles for an anonymous caller, or call
//     the server-only RPCs (consume_quota, record_purchase, ...).
//   - getCallerUser() resolves *who* is calling (works for an anonymous
//     session too) without ever using the service-role client for that —
//     identity comes from the caller's own JWT, not from something this
//     function could spoof.
//
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are
// auto-injected into every Edge Function by the Supabase platform — no
// manual secret needed for these three.
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export function getServiceClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

export interface CallerUser {
  id: string;
  isAnonymous: boolean;
}

// Resolves the caller's identity from the Authorization header
// supabase-js's functions.invoke() forwards automatically. Returns null if
// the request has no valid session (expired token, no header, etc.).
export async function getCallerUser(req: Request): Promise<CallerUser | null> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return null;

  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) return null;

  return { id: data.user.id, isAnonymous: !!(data.user as any).is_anonymous };
}
