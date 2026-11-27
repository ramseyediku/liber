// Re-unlocks the caller's current account (anonymous or permanent) using a
// restore code from an earlier purchase — the schema's own answer to "an
// anonymous purchase needs to survive clearing browser data." Hashes the
// submitted code and hands the hash to redeem_restore_code(), which never
// sees (and this function never stores) the plain code.
import { getCallerUser, getServiceClient } from "../_shared/client.ts";
import { handleCors, json } from "../_shared/cors.ts";
import { sha256Hex } from "../_shared/hash.ts";

Deno.serve(async (req: Request) => {
  const preflight = handleCors(req);
  if (preflight) return preflight;

  const caller = await getCallerUser(req);
  if (!caller) return json({ error: "unauthorized" }, 401);

  const { code } = await req.json();
  if (typeof code !== "string" || !code.trim()) {
    return json({ error: "missing code" }, 400);
  }

  // Strip any display formatting (dashes/spaces) the client UI added.
  const normalized = code.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const hash = await sha256Hex(normalized);

  const supabase = getServiceClient();
  const { data: restored, error } = await supabase.rpc("redeem_restore_code", {
    p_user: caller.id,
    p_code_hash: hash,
  });
  if (error) return json({ error: error.message }, 500);

  return json({ status: restored ? "restored" : "not_found" });
});
