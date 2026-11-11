// Resolves a job page into {jobTitle, company, location} via Claude, and also
// asks Claude for a CSS selector per field. The extension stores those
// selectors per hostname (see the site-structure function) so later visits can
// read the page without calling this at all. Input is the cleaned HTML of the
// job (header/footer/nav stripped by content.ts); plain text is the fallback.
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
const SCOPE_HTML_MAX_LENGTH = 24000; // matches content.ts's HTML cap

const anthropic = new Anthropic({ apiKey: Deno.env.get("LIBER_LLM_API")! });

const SYSTEM_PROMPT =
  "You read the cleaned HTML of a job posting (header, footer and navigation are already removed) " +
  'and call record_job_fields with "jobTitle", "company" and "location". Keep each value short — a few words, ' +
  'not a sentence. Use the empty string "" for any field you cannot find with reasonable confidence — ' +
  "never guess or invent a value. " +
  'Also give, under "selectors", one CSS selector per field that targets the single element whose text ' +
  "is that value, valid for document.querySelector on this same HTML. Prefer id, data-testid / data-test / " +
  "data-* attributes, itemprop and meaningful class names. Avoid positional :nth-child chains, random-looking " +
  "generated class names (hashes like css-1a2b3c), and selectors that would match a large wrapper. " +
  'Use "" for a selector if no reliable one exists. If you were given plain text instead of HTML, ' +
  "return all selectors as empty strings.";

const EMPTY_FIELDS = { jobTitle: "", company: "", location: "" };
const EMPTY = { ...EMPTY_FIELDS, selectors: EMPTY_FIELDS };

type Claude = "called" | "quota" | "error" | "empty-input";

// Selectors are stored and shared across users, so only plain CSS survives.
function cleanSelector(value: unknown): string {
  if (typeof value !== "string") return "";
  const selector = value.trim();
  if (!selector || selector.length > 200) return "";
  if (/[<>{};\\]/.test(selector)) return "";
  if (/:contains\(|:has-text\(/i.test(selector)) return "";
  return selector;
}

Deno.serve(async (req: Request) => {
  const preflight = handleCors(req);
  if (preflight) return preflight;

  const caller = await getCallerUser(req);
  if (!caller) return json({ error: "unauthorized" }, 401);

  const body = await req.json();
  const scopeHtml = typeof body.scopeHtml === "string" ? body.scopeHtml.trim() : "";
  const scopeText = typeof body.scopeText === "string" ? body.scopeText.trim() : "";
  if (!scopeHtml && !scopeText) {
    return json({ ...EMPTY, claude: "empty-input" satisfies Claude });
  }

  const supabase = getServiceClient();
  const { data: allowed, error: quotaError } = await supabase.rpc("consume_quota", {
    p_user: caller.id,
    p_kind: "ai",
    p_limit: FREE_AI_LIMIT,
  });
  if (quotaError) return json({ error: quotaError.message }, 500);
  if (!allowed) return json({ ...EMPTY, claude: "quota" satisfies Claude }); // free limit reached — silent fallback, no error

  try {
    const response = await anthropic.messages.create({
      model: MODEL_ID,
      max_tokens: 600,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: scopeHtml
            ? `HTML:\n${scopeHtml.slice(0, SCOPE_HTML_MAX_LENGTH)}`
            : `Plain text:\n${scopeText.slice(0, SCOPE_TEXT_MAX_LENGTH)}`,
        },
      ],
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
              selectors: {
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
            required: ["jobTitle", "company", "location", "selectors"],
            additionalProperties: false,
          },
        },
      ],
      tool_choice: { type: "tool", name: "record_job_fields" },
    });

    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );
    if (!toolUse) return json({ ...EMPTY, claude: "error" satisfies Claude });

    const input = toolUse.input as Partial<typeof EMPTY_FIELDS> & {
      selectors?: Record<string, unknown>;
    };
    return json({
      jobTitle: input.jobTitle || "",
      company: input.company || "",
      location: input.location || "",
      selectors: {
        jobTitle: cleanSelector(input.selectors?.jobTitle),
        company: cleanSelector(input.selectors?.company),
        location: cleanSelector(input.selectors?.location),
      },
      claude: "called" satisfies Claude,
    });
  } catch (err) {
    console.error("extract-job-fields: Claude call failed", err);
    return json({ ...EMPTY, claude: "error" satisfies Claude });
  }
});
