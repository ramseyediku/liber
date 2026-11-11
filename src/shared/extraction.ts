// Resolves a captured page into {jobTitle, company, location} (plus CSS
// selectors for them) via a Supabase Edge Function that calls the Claude API
// server-side. The Claude key lives only in the Supabase secret
// LIBER_LLM_API, never in this extension — see .env.example.
//
// The function reads the cleaned HTML of the job (header/footer/nav already
// stripped by content.ts); scopeText is the plain-text fallback for pages
// whose HTML is empty.
import { getSupabaseClient } from "./supabaseClient.ts";
import { sanitizeSelectors } from "./structure.ts";
import type { ExtractionResult } from "./types.ts";

const EXTRACT_FUNCTION_NAME = "extract-job-fields";

export interface ExtractionInput {
  scopeHtml: string;
  scopeText: string;
  hostname: string;
}

export async function extractJobFields(input: ExtractionInput): Promise<ExtractionResult> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase.functions.invoke(EXTRACT_FUNCTION_NAME, {
    body: input,
  });
  if (error) throw error; // background.ts reports this as outcome "failed"

  const claude = ["called", "quota", "error", "empty-input"].includes(data?.claude)
    ? data.claude
    : "called";
  return {
    snapshot: {
      jobTitle: data?.jobTitle || "",
      company: data?.company || "",
      location: data?.location || "",
    },
    selectors: sanitizeSelectors(data?.selectors),
    claude,
  };
}
