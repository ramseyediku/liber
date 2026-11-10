// SHA-256 hex digest via Web Crypto — matches the schema's
// restore_code_hash check ('^[0-9a-f]{64}$'). Used by create-checkout-session
// (hashing the code it generates) and redeem-restore-code (hashing what the
// user typed back in) — the plain code itself is never stored server-side.
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// 16 uppercase alphanumeric characters — the extension displays it grouped
// as XXXX-XXXX-XXXX-XXXX (cosmetic only; this returns the plain string).
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I — avoids visual ambiguity

export function generateRestoreCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}
