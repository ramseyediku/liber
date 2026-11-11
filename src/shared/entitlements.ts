// Reads the signed-in user's paid status. entitlements.paid is written only
// by the Stripe webhook Edge Function (service_role) — never from the
// client, so this is read-only on purpose.
import { ensureSession, getSupabaseClient } from "./supabaseClient.ts";

// Extra job profiles a free account may add on top of the default one every
// account starts with ("General", or the role picked at setup). 0 = free
// accounts can't add any; paid accounts are unlimited. Mirrors the
// server's enforce_profile_limit trigger so the UI can say no up front.
export const FREE_EXTRA_JOB_PROFILES = 0;

export async function isPaid(): Promise<boolean> {
  await ensureSession();
  const supabase = getSupabaseClient();

  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) return false;

  const { data, error } = await supabase
    .from("entitlements")
    .select("paid")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return false;
  return !!data.paid;
}

const RESTORE_CODE_KEY = "liber_restore_code";

// Starts the one-time-unlock Checkout. The restore code comes back before
// payment completes, so it's held locally and only shown once the account
// is actually paid (see getRestoreCode).
export async function startCheckout(): Promise<string> {
  await ensureSession();
  const { data, error } = await getSupabaseClient().functions.invoke<{
    checkoutUrl?: string;
    restoreCode?: string;
  }>("create-checkout-session");
  if (error) throw error;
  if (!data?.checkoutUrl) throw new Error("create-checkout-session returned no url");
  if (data.restoreCode) await browser.storage.local.set({ [RESTORE_CODE_KEY]: data.restoreCode });
  return data.checkoutUrl;
}

export async function getRestoreCode(): Promise<string | null> {
  const result = (await browser.storage.local.get(RESTORE_CODE_KEY)) as Record<string, string>;
  return result[RESTORE_CODE_KEY] || null;
}

// Re-unlocks this account from the code of an earlier purchase.
export async function redeemRestoreCode(code: string): Promise<boolean> {
  await ensureSession();
  const { data, error } = await getSupabaseClient().functions.invoke<{ status: string }>(
    "redeem-restore-code",
    { body: { code } },
  );
  if (error) throw error;
  return data?.status === "restored";
}
