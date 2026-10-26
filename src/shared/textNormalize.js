// Pure text cleanup shared by anything that turns raw scraped/generated text
// into a display-ready field value. Moved here from content.js when field
// extraction switched from synonym matching (content.js) to an on-device LLM
// (src/shared/llmEngine.js) — both producers want the same cleanup, but only
// the LLM path remains today.

export function normalizeScrapedText(value) {
  return (value || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}
