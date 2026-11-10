// Permanently deletes the caller's account and everything under it. The
// client can't do this itself: removing an auth.users row needs the admin
// API (service-role). Jobs and profiles are deleted explicitly first (jobs
// before job_profiles, since jobs.profile_id references it) rather than
// relying on ON DELETE CASCADE existing on every table; anything else
// keyed to the user (e.g. entitlements) is expected to cascade from
// auth.users. Anonymous callers are allowed too — it's the same "wipe
// everything I have" action.
import { getCallerUser, getServiceClient } from "../_shared/client.ts";
import { handleCors, json } from "../_shared/cors.ts";

Deno.serve(async (req: Request) => {
  const preflight = handleCors(req);
  if (preflight) return preflight;

  const caller = await getCallerUser(req);
  if (!caller) return json({ error: "unauthorized" }, 401);

  const supabase = getServiceClient();

  const { error: jobsError } = await supabase.from("jobs").delete().eq("user_id", caller.id);
  if (jobsError) return json({ error: jobsError.message }, 500);

  const { error: profilesError } = await supabase
    .from("job_profiles")
    .delete()
    .eq("user_id", caller.id);
  if (profilesError) return json({ error: profilesError.message }, 500);

  const { error: userError } = await supabase.auth.admin.deleteUser(caller.id);
  if (userError) return json({ error: userError.message }, 500);

  return json({ status: "deleted" });
});
