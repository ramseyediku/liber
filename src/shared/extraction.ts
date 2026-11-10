// Resolves bounded scope text into {jobTitle, company, location} via a
// Supabase Edge Function that calls the Claude API server-side. The Claude
// key lives only in the Supabase secret LIBER_LLM_API, never in this
// extension — see .env.example.
//
// PLACEHOLDER: EXTRACT_FUNCTION_NAME and the request/response shape are
// provisional until the real Edge Function is wired up.
import { getSupabaseClient } from "./supabaseClient.ts";
import type { JobFieldSnapshot } from "./types.ts";

const EXTRACT_FUNCTION_NAME = "extract-job-fields";

export async function extractJobFields(scopeText: string): Promise<JobFieldSnapshot> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase.functions.invoke(EXTRACT_FUNCTION_NAME, {
    body: { scopeText },
  });
  if (error) throw error; // background.ts reports this as outcome "failed"

  return {
    jobTitle: data?.jobTitle || "",
    company: data?.company || "",
    location: data?.location || "",
  };
}
