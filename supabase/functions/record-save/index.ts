// Durably saves a job — the one place a save actually lands in Supabase,
// for every caller including an anonymous session (service-role bypasses
// is_permanent_user()'s RLS gate on insert). This is also where the
// free-tier limits actually bite: enforce_job_limit/enforce_profile_limit
// (DB triggers) fire on the inserts below and raise if the caller is over
// the free 10-job/1-profile cap and isn't paid — this function just maps
// that exception to a clean {status: "limit"} response.
//
// The client generates profileId/jobId uuids itself (the schema's own
// "client may supply its own uuid for offline-first sync" design) and
// upserts by id, so a retried/replayed call never double-creates a row or
// double-spends quota (enforce_job_limit's "already exists by id" guard).
import { getCallerUser, getServiceClient } from "../_shared/client.ts";
import { handleCors, json } from "../_shared/cors.ts";

interface RecordSaveBody {
  profileId: string;
  profileName: string;
  jobId: string;
  jobTitle: string;
  company: string;
  location: string;
  url: string;
}

function normalize(value: string | undefined | null): string {
  return (value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function isLimitError(message: string, kind: "job" | "profile"): boolean {
  return message.includes(`free ${kind} limit reached`);
}

Deno.serve(async (req: Request) => {
  const preflight = handleCors(req);
  if (preflight) return preflight;

  const caller = await getCallerUser(req);
  if (!caller) return json({ error: "unauthorized" }, 401);

  const body = (await req.json()) as RecordSaveBody;
  const jobTitle = body.jobTitle || "Unknown title";
  const company = body.company || "Unknown company";
  const location = body.location || "";

  const supabase = getServiceClient();

  // Profile first — jobs.profile_id's FK needs it to already exist.
  const { error: profileError } = await supabase.from("job_profiles").upsert(
    {
      id: body.profileId,
      user_id: caller.id,
      name: body.profileName || "General",
    },
    { onConflict: "id" },
  );
  if (profileError) {
    if (isLimitError(profileError.message, "profile")) {
      return json({ status: "limit", kind: "profile" });
    }
    return json({ error: profileError.message }, 500);
  }

  // Dedup check — authoritative now that every save round-trips here.
  const { data: existingJobs, error: existingError } = await supabase
    .from("jobs")
    .select("title, company, location")
    .eq("user_id", caller.id)
    .eq("deleted", false);
  if (existingError) return json({ error: existingError.message }, 500);

  const newKey = [jobTitle, company, location].map(normalize).join("|");
  const isDuplicate = (existingJobs || []).some(
    (j: any) => [j.title, j.company, j.location].map(normalize).join("|") === newKey,
  );
  if (isDuplicate) return json({ status: "duplicate" });

  const { data: job, error: jobError } = await supabase
    .from("jobs")
    .upsert(
      {
        id: body.jobId,
        user_id: caller.id,
        profile_id: body.profileId,
        title: jobTitle,
        company,
        location,
        url: body.url || "",
      },
      { onConflict: "id" },
    )
    .select()
    .single();
  if (jobError) {
    if (isLimitError(jobError.message, "job")) {
      return json({ status: "limit", kind: "job" });
    }
    return json({ error: jobError.message }, 500);
  }

  return json({ status: "saved", job });
});
