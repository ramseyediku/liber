// Reads the signed-in user's paid status. entitlements.paid is written only
// by the Stripe webhook Edge Function (service_role) — never from the
// client, so this is read-only on purpose.
import { ensureSession, getSupabaseClient } from "./supabaseClient.ts";
import { accountStorage } from "./accountStore.ts";

// Extra job profiles a free account may add on top of the default one every
// account starts with ("General", or the role picked at setup). 0 = free
// accounts can't add any; paid accounts are unlimited. Mirrors the
// server's enforce_profile_limit trigger so the UI can say no up front.
export const FREE_EXTRA_JOB_PROFILES = 0;

// Free accounts may save this many jobs, ever (the server's own lifetime
// count, enforce_job_limit/consume_quota). Applied locally too, since with
// Cloud Sync off nothing reaches the server to enforce it.
export const FREE_JOB_LIMIT = 10;

const PAID_CACHE_KEY = "liber_paid_cache";

// Paid status is read from Supabase, and the last answer is kept so a paid
// user who is offline isn't treated as free (local saves check it).
export async function isPaid(): Promise<boolean> {
  const cached = async () =>
    !!((await accountStorage.get(PAID_CACHE_KEY)) as Record<string, boolean>)[PAID_CACHE_KEY];
  try {
    await ensureSession();
    const supabase = getSupabaseClient();

    const { data: userData } = await supabase.auth.getUser();
    const userId = userData?.user?.id;
    if (!userId) return await cached();

    const { data, error } = await supabase
      .from("entitlements")
      .select("paid")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) return await cached();
    const paid = !!data?.paid;
    await accountStorage.set({ [PAID_CACHE_KEY]: paid });
    return paid;
  } catch {
    return await cached();
  }
}

const RESTORE_CODE_KEY = "liber_restore_code";

// Starts the one-time-unlock Checkout. The restore code comes back before
// payment completes, so it's held locally and only shown once the account
// is actually paid (see getRestoreCode). A code from an earlier, unfinished
// checkout is sent back so the server reuses it: otherwise paying in an
// older checkout tab would leave this device holding the wrong code.
export async function startCheckout(): Promise<string> {
  await ensureSession();
  const pending = await getRestoreCode();
  const { data, error } = await getSupabaseClient().functions.invoke<{
    checkoutUrl?: string;
    restoreCode?: string;
  }>("create-checkout-session", { body: pending ? { restoreCode: pending } : {} });
  if (error) throw error;
  if (!data?.checkoutUrl) throw new Error("create-checkout-session returned no url");
  if (data.restoreCode) await accountStorage.set({ [RESTORE_CODE_KEY]: data.restoreCode });
  return data.checkoutUrl;
}

export async function getRestoreCode(): Promise<string | null> {
  const result = (await accountStorage.get(RESTORE_CODE_KEY)) as Record<string, string>;
  return result[RESTORE_CODE_KEY] || null;
}

// XXXX-XXXX-XXXX-XXXX for display; the server ignores the dashes.
export function formatRestoreCode(code: string): string {
  return code.replace(/[^A-Za-z0-9]/g, "").toUpperCase().match(/.{1,4}/g)?.join("-") ?? code;
}

// Re-unlocks this account from the code of an earlier purchase. The code is
// kept, so Settings can show it again on this account.
export async function redeemRestoreCode(code: string): Promise<boolean> {
  await ensureSession();
  const { data, error } = await getSupabaseClient().functions.invoke<{ status: string }>(
    "redeem-restore-code",
    { body: { code } },
  );
  if (error) throw error;
  const restored = data?.status === "restored";
  if (restored) {
    const plain = code.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    await accountStorage.set({ [RESTORE_CODE_KEY]: plain, [PAID_CACHE_KEY]: true });
  }
  return restored;
}
