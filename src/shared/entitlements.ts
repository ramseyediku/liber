// Reads the signed-in user's paid status. entitlements.paid is written only
// by the Stripe webhook Edge Function (service_role) — never from the
// client, so this is read-only on purpose.
import { ensureSession, getSupabaseClient } from "./supabaseClient.ts";

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
