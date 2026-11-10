// Text cleanup for raw scraped/generated field values: collapse whitespace,
// trim, title-case each word.
export function normalizeScrapedText(value: string | undefined | null): string {
  return (value || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}
