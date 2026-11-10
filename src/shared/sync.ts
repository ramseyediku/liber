// Cloud Sync toggle — off by default, even once signed in (see the
// Settings mockup). Every save already lands durably in Supabase via
// record-save/update-job (service-role bypasses is_permanent_user()), so
// this toggle no longer gates *whether* data reaches the cloud — it gates
// whether *this device* looks there at all when listing jobs. Off: only
// ever shows what this device itself has saved (storage.ts's local cache).
// On (permanent account only): storage.ts's getAllJobs() reads straight
// from Supabase, so a job saved on another device under the same account
// becomes visible here too.
import { isPermanentUser } from "./supabaseClient.ts";

const SYNC_ENABLED_KEY = "liber_cloud_sync_enabled";

export async function isSyncEnabled(): Promise<boolean> {
  const result = (await browser.storage.local.get(SYNC_ENABLED_KEY)) as Record<string, boolean>;
  return !!result[SYNC_ENABLED_KEY];
}

// Turning on requires a permanent account — the caller (Settings UI) is
// responsible for sending the user to sign in first if this returns false.
export async function setSyncEnabled(enabled: boolean): Promise<boolean> {
  if (enabled && !(await isPermanentUser())) return false;
  await browser.storage.local.set({ [SYNC_ENABLED_KEY]: enabled });
  return true;
}
