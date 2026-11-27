// Resolves a job page into {jobTitle, company, location} via Claude, and also
// asks Claude for a CSS selector per field. The extension stores those
// selectors per hostname (see the site-structure function) so later visits can
// read the page without calling this at all.
//
// What Claude is given, because messy pages defeat markup alone:
//   - page hints: <title>, og: metadata and <h1> text (often "Job title –
//     Company" even when the markup is div soup; the header that usually holds
//     the company is stripped from the HTML);
//   - the cleaned HTML of the job (header/footer/nav stripped by content.ts);
//   - the visible text of the same area, in reading order.
// If the first, cheaper model comes back without a title or a company, a
// stronger model is asked once (same quota unit — the retry is not billed to
// the user's free calls).
//
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
import { handleCors, json } from "../_shared/cors.ts";

const FAST_MODEL = "claude-haiku-4-5"; // cheap/fast first attempt
const STRONG_MODEL = "claude-sonnet-5-5"; // one retry when the first attempt finds no title/company
const FREE_AI_LIMIT = 10;
const SCOPE_TEXT_MAX_LENGTH = 4000; // matches content.ts's own cap — a second, cheap safety net
const SCOPE_HTML_MAX_LENGTH = 24000; // matches content.ts's HTML cap
const TEXT_WITH_HTML_MAX_LENGTH = 3000; // visible text sent alongside HTML

const anthropic = new Anthropic({ apiKey: Deno.env.get("LIBER_LLM_API")! });

const SYSTEM_PROMPT =
  "You read a job posting and call record_job_fields with \"jobTitle\", \"company\" and \"location\". " +
  "You are given up to three views of the page: page hints (the document title, og: metadata and headings), " +
  "the cleaned HTML of the job area (header, footer and navigation already removed), and the visible text of " +
  "the same area in reading order. The HTML may be messy — deeply nested divs, generated class names, little " +
  "semantic markup — so when it is hard to follow, rely on the visible text and the page hints for the values. " +
  "A page title often reads \"Job title – Company\" or \"Job title at Company | Site\", but it can also describe " +
  "the site, not this job, so check it against the page content. " +
  'Keep each value short — a few words, not a sentence. Use the empty string "" for any field you cannot find ' +
  "with reasonable confidence — never guess or invent a value. " +
  "If the HTML has a data-liber-part=\"popup\" section and a data-liber-part=\"page-behind\" section, the user " +
  "clicked inside a popup (often the application form itself); the job's title, company and location are " +
  "frequently only in the page behind it, so read both. " +
  "The element carrying data-liber-clicked is the Apply button the user clicked. If the page holds " +
  "several jobs, extract the one that button belongs to — the job content nearest to it — never just the first. " +
  'Also give, under "selectors", one CSS selector per field that targets the single element whose text ' +
  "is that value, valid for document.querySelector on the HTML you were given. A selector may match every job on a " +
  "page; that is fine, as the extension later picks the match nearest the clicked button. Prefer id, data-testid / " +
  "data-test / data-* attributes, itemprop and meaningful class names. Avoid positional :nth-child chains, " +
  "random-looking generated class names (hashes like css-1a2b3c), and selectors that would match a large wrapper. " +
  'Use "" for a selector if no reliable one exists, and for all three if you were given no HTML.';

const EMPTY_FIELDS = { jobTitle: "", company: "", location: "" };
const EMPTY = { ...EMPTY_FIELDS, selectors: EMPTY_FIELDS };

type Claude = "called" | "quota" | "error" | "empty-input";

interface Hints {
  title?: unknown;
  ogTitle?: unknown;
  ogSiteName?: unknown;
  description?: unknown;
  headings?: unknown;
}

// Selectors are stored and shared across users, so only plain CSS survives.
function cleanSelector(value: unknown): string {
  if (typeof value !== "string") return "";
  const selector = value.trim();
  if (!selector || selector.length > 200) return "";
  if (/[<>{};\\]/.test(selector)) return "";
  if (/:contains\(|:has-text\(/i.test(selector)) return "";
  return selector;
}

const str = (v: unknown, max: number): string =>
  typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";

function hintsBlock(hints: Hints | null): string {
  if (!hints || typeof hints !== "object") return "";
  const lines: string[] = [];
  const add = (label: string, value: string) => value && lines.push(`- ${label}: ${value}`);
  add("document title", str(hints.title, 200));
  add("og:title", str(hints.ogTitle, 200));
  add("site name", str(hints.ogSiteName, 100));
  add("description", str(hints.description, 300));
  if (Array.isArray(hints.headings)) {
    hints.headings.slice(0, 3).forEach((h) => add("heading", str(h, 150)));
  }
  return lines.length ? `Page hints:\n${lines.join("\n")}` : "";
}

function buildContent(hints: Hints | null, scopeHtml: string, scopeText: string): string {
  const parts: string[] = [];
  const hintText = hintsBlock(hints);
  if (hintText) parts.push(hintText);
  if (scopeHtml) parts.push(`HTML of the job area:\n${scopeHtml.slice(0, SCOPE_HTML_MAX_LENGTH)}`);
  if (scopeText) {
    const cap = scopeHtml ? TEXT_WITH_HTML_MAX_LENGTH : SCOPE_TEXT_MAX_LENGTH;
    parts.push(`Visible text of the same area, in reading order:\n${scopeText.slice(0, cap)}`);
  }
  return parts.join("\n\n");
}

interface Extracted {
  jobTitle: string;
  company: string;
  location: string;
  selectors: { jobTitle: string; company: string; location: string };
}

async function askClaude(model: string, content: string): Promise<Extracted | null> {
  const response = await anthropic.messages.create({
    model,
    max_tokens: 600,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
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
  if (!toolUse) return null;

  const input = toolUse.input as Partial<typeof EMPTY_FIELDS> & {
    selectors?: Record<string, unknown>;
  };
  return {
    jobTitle: input.jobTitle || "",
    company: input.company || "",
    location: input.location || "",
    selectors: {
      jobTitle: cleanSelector(input.selectors?.jobTitle),
      company: cleanSelector(input.selectors?.company),
      location: cleanSelector(input.selectors?.location),
    },
  };
}

Deno.serve(async (req: Request) => {
  const preflight = handleCors(req);
  if (preflight) return preflight;

  const caller = await getCallerUser(req);
  if (!caller) return json({ error: "unauthorized" }, 401);

  const body = await req.json();
  const scopeHtml = typeof body.scopeHtml === "string" ? body.scopeHtml.trim() : "";
  const scopeText = typeof body.scopeText === "string" ? body.scopeText.trim() : "";
  const hints: Hints | null = body.pageHints && typeof body.pageHints === "object" ? body.pageHints : null;
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

  const content = buildContent(hints, scopeHtml, scopeText);
  const found = (x: Extracted | null) => !!(x && x.jobTitle && x.company);

  let result: Extracted | null = null;
  let model = FAST_MODEL;
  let escalated = false;

  try {
    result = await askClaude(FAST_MODEL, content);
  } catch (err) {
    console.error("extract-job-fields: first attempt failed", err);
  }

  // Nothing usable from the cheap model — try the stronger one, once.
  if (!found(result)) {
    try {
      const retry = await askClaude(STRONG_MODEL, content);
      escalated = true;
      if (retry && (found(retry) || !result)) {
        result = retry;
        model = STRONG_MODEL;
      }
    } catch (err) {
      console.error("extract-job-fields: stronger-model retry failed", err);
    }
  }

  if (!result) return json({ ...EMPTY, claude: "error" satisfies Claude });
  return json({ ...result, claude: "called" satisfies Claude, model, escalated });
});
