// Resolves bounded page text into {jobTitle, company, location} via Claude.
// The ANTHROPIC key lives only in the Supabase secret LIBER_LLM_API — never
// inside the extension (see src/shared/extraction.ts).
//
// The AI-call quota (10 free) has no table of its own to trigger off of
// (unlike jobs/job_profiles' INSERT triggers), so it's checked here
// directly via consume_quota(user, 'ai', 10). Hitting the limit returns
// empty fields rather than an error — background.ts already treats an
// incomplete extraction as "use whatever JSON-LD found," so the AI limit
// stays invisible, per the schema's own intent.
import Anthropic from "npm:@anthropic-ai/sdk";
import { getCallerUser, getServiceClient } from "../_shared/client.ts";
import { corsHeaders, handleCors, json } from "../_shared/cors.ts";

const MODEL_ID = "claude-haiku-4-5"; // cheap/fast 3-field extraction; bump to claude-sonnet-5 if accuracy is insufficient
const FREE_AI_LIMIT = 10;
const SCOPE_TEXT_MAX_LENGTH = 4000; // matches content.ts's own cap — a second, cheap safety net

const anthropic = new Anthropic({ apiKey: Deno.env.get("LIBER_LLM_API")! });

const SYSTEM_PROMPT =
  "Extract job application details from raw page text. Call record_job_fields " +
  'with "jobTitle", "company", "location". Keep each value short — a few words, ' +
  'not a sentence. Use the empty string "" for any field you cannot find with ' +
  "reasonable confidence — never guess or invent a value.";

const EMPTY = { jobTitle: "", company: "", location: "" };

Deno.serve(async (req: Request) => {
  const preflight = handleCors(req);
  if (preflight) return preflight;

  const caller = await getCallerUser(req);
  if (!caller) return json({ error: "unauthorized" }, 401);

  const { scopeText } = await req.json();
  if (typeof scopeText !== "string" || !scopeText.trim()) {
    return json(EMPTY);
  }

  const supabase = getServiceClient();
  const { data: allowed, error: quotaError } = await supabase.rpc("consume_quota", {
    p_user: caller.id,
    p_kind: "ai",
    p_limit: FREE_AI_LIMIT,
  });
  if (quotaError) return json({ error: quotaError.message }, 500);
  if (!allowed) return json(EMPTY); // free limit reached — silent fallback, no error

  try {
    const response = await anthropic.messages.create({
      model: MODEL_ID,
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: scopeText.slice(0, SCOPE_TEXT_MAX_LENGTH) }],
      tools: [
        {
          name: "record_job_fields",
          description: "Record the extracted job application fields.",
          strict: true,
          input_schema: {
            type: "object",
            properties: {
              jobTitle: { type: "string" },
              company: { type: "string" },
              location: { type: "string" },
            },
            required: ["jobTitle", "company", "location"],
            additionalProperties: false,
          },
        },
      ],
      tool_choice: { type: "tool", name: "record_job_fields" },
    });

    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );
    if (!toolUse) return json(EMPTY);

    const input = toolUse.input as Partial<typeof EMPTY>;
    return json({
      jobTitle: input.jobTitle || "",
      company: input.company || "",
      location: input.location || "",
    });
  } catch (err) {
    console.error("extract-job-fields: Claude call failed", err);
    return json(EMPTY);
  }
});
