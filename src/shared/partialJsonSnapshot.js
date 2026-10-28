// Pure scanning of a (possibly incomplete) streamed JSON buffer for the
// moment a fixed-order {jobTitle, company, location} object's three string
// values are all fully closed — without needing the whole object (its
// closing `}`, or the model's end-of-generation token) to have arrived yet.
// Used by llmEngine.js to call engine.interruptGenerate() as early as
// possible instead of waiting for the model to finish generating.
//
// Relies on llmEngine.js's SNAPSHOT_SCHEMA declaring properties in this
// same order — WebLLM's grammar-constrained JSON mode generates object keys
// in the order given in the schema, so this is a correctness assumption,
// not just a stylistic choice.
const FIELD_ORDER = ["jobTitle", "company", "location"];

function fieldPattern(name) {
  return `"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`;
}

const SNAPSHOT_PATTERN = new RegExp(
  FIELD_ORDER.map(fieldPattern).join("\\s*,\\s*"),
);

function decodeJsonString(raw) {
  try {
    // Reuses JSON's own string-literal decoder for escapes
    // (\", \\, \uXXXX, etc.) rather than reimplementing it.
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw;
  }
}

export function tryParseCompleteSnapshot(buffer) {
  const match = SNAPSHOT_PATTERN.exec(buffer);
  if (!match) return null;

  const [, jobTitle, company, location] = match;
  return {
    jobTitle: decodeJsonString(jobTitle),
    company: decodeJsonString(company),
    location: decodeJsonString(location),
  };
}

export { FIELD_ORDER };
