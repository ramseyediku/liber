// Edits (status/notes/fields) and soft-deletes (deleted: true) an existing
// job. jobs_update_own's RLS policy requires is_permanent_user(), so an
// anonymous caller can't do this directly — service-role bypasses that,
// same reasoning as record-save. No quota/limit concerns here: the
// enforce_job_limit trigger only fires on INSERT, not UPDATE.
import { getCallerUser, getServiceClient } from "../_shared/client.ts";
import { handleCors, json } from "../_shared/cors.ts";

interface UpdateJobBody {
  jobId: string;
  updates: Partial<{
    status: string;
    notes: string;
    jobTitle: string;
    company: string;
    location: string;
    url: string;
    deleted: boolean;
  }>;
}

Deno.serve(async (req: Request) => {
  const preflight = handleCors(req);
  if (preflight) return preflight;

  const caller = await getCallerUser(req);
  if (!caller) return json({ error: "unauthorized" }, 401);

  const { jobId, updates } = (await req.json()) as UpdateJobBody;
  if (!jobId) return json({ error: "missing jobId" }, 400);

  const patch: Record<string, unknown> = {};
  if (updates.status !== undefined) patch.status = updates.status;
  if (updates.notes !== undefined) patch.notes = updates.notes;
  if (updates.jobTitle !== undefined) patch.title = updates.jobTitle;
  if (updates.company !== undefined) patch.company = updates.company;
  if (updates.location !== undefined) patch.location = updates.location;
  if (updates.url !== undefined) patch.url = updates.url;
  if (updates.deleted !== undefined) patch.deleted = updates.deleted;

  const supabase = getServiceClient();
  const { data: job, error } = await supabase
    .from("jobs")
    .update(patch)
    .eq("id", jobId)
    .eq("user_id", caller.id)
    .select()
    .maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!job) return json({ status: "not_found" }, 404);

  return json({ status: "updated", job });
});
