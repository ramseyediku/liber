// Creates (or renames, if the id already exists) a named job profile for
// the caller. Same reasoning as record-save: an anonymous caller can't
// write job_profiles directly under RLS, so this goes through service-role,
// and the free-tier profile cap (a DB trigger on this insert) is mapped to
// a clean {status: "limit"} response instead of a raw Postgres exception.
import { getCallerUser, getServiceClient } from "../_shared/client.ts";
import { handleCors, json } from "../_shared/cors.ts";

interface CreateJobProfileBody {
  profileId: string;
  name: string;
}

Deno.serve(async (req: Request) => {
  const preflight = handleCors(req);
  if (preflight) return preflight;

  const caller = await getCallerUser(req);
  if (!caller) return json({ error: "unauthorized" }, 401);

  const { profileId, name } = (await req.json()) as CreateJobProfileBody;
  const trimmed = (name || "").trim();
  if (!profileId || !trimmed) return json({ error: "missing profileId or name" }, 400);

  const supabase = getServiceClient();
  const { data: profile, error } = await supabase
    .from("job_profiles")
    .upsert({ id: profileId, user_id: caller.id, name: trimmed }, { onConflict: "id" })
    .select()
    .single();
  if (error) {
    if (error.message.includes("free profile limit reached")) {
      return json({ status: "limit" });
    }
    return json({ error: error.message }, 500);
  }

  return json({ status: "saved", profile });
});
