// Per-account local storage. Everything that belongs to one account (its jobs,
// job profiles, queued uploads, sync setting, paid status) is stored under a key
// suffixed with that account's user id, e.g. "liber_jobs:<uid>".
//
// Why: logging out starts a new guest (a new user id), so the previous
// account's data simply stops being visible — it is not deleted, and it comes
// back if that account logs in on this device again. A guest who signs up keeps
// the same user id (the upgrade is in place), so their data carries straight
// over. It also keeps one account's queued uploads from ever being sent under
// another account. Device-level settings (theme, sidebar, the capture log) are
// not in ACCOUNT_KEYS and stay shared.
import { ensureSession } from "./supabaseClient.ts";
import { SUPABASE_URL } from "./env.ts";

export const ACCOUNT_KEYS = new Set([
  "liber_jobs",
  "liber_default_profile",
  "liber_pending_creates",
  "liber_pending_deletes",
  "liber_pending_updates",
  "liber_local_profiles",
  "liber_synced_profiles",
  "liber_local_saves",
  "liber_local_only",
  "liber_cloud_sync_enabled",
  "liber_paid_cache",
  "liber_restore_code",
]);

// Where supabase-js keeps the session (its default storage key).
const AUTH_KEY = `sb-${new URL(SUPABASE_URL).hostname.split(".")[0]}-auth-token`;

async function readUserIdFromSession(): Promise<string | null> {
  const raw = ((await browser.storage.local.get(AUTH_KEY)) as Record<string, unknown>)[AUTH_KEY];
  if (typeof raw !== "string") return null;
  try {
    const id = JSON.parse(raw)?.user?.id;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

// Read straight from the stored session on every call rather than cached: the
// background worker would otherwise keep writing under the old account after a
// page logs out (it gets no auth event for that).
export async function currentUserId(): Promise<string> {
  let id = await readUserIdFromSession();
  if (!id) {
    await ensureSession();
    id = await readUserIdFromSession();
  }
  if (!id) throw new Error("no session to scope local data to");
  return id;
}

// Data written before namespacing belongs to whoever is signed in now; it is
// moved under their id once, the first time anything is read.
let migrated: Promise<void> | null = null;

function migrateLegacyKeys(uid: string): Promise<void> {
  migrated ??= (async () => {
    const legacy = (await browser.storage.local.get([...ACCOUNT_KEYS])) as Record<string, unknown>;
    const present = Object.keys(legacy).filter((k) => legacy[k] !== undefined);
    if (!present.length) return;
    const targets = present.map((k) => `${k}:${uid}`);
    const existing = (await browser.storage.local.get(targets)) as Record<string, unknown>;
    const moves: Record<string, unknown> = {};
    for (const k of present) {
      if (existing[`${k}:${uid}`] === undefined) moves[`${k}:${uid}`] = legacy[k];
    }
    if (Object.keys(moves).length) await browser.storage.local.set(moves);
    await browser.storage.local.remove(present);
  })();
  return migrated;
}

export async function accountKey(base: string): Promise<string> {
  if (!ACCOUNT_KEYS.has(base)) return base;
  const uid = await currentUserId();
  await migrateLegacyKeys(uid);
  return `${base}:${uid}`;
}

// Same shape as browser.storage.local for the calls Liber makes, so existing
// code (`(await get(KEY))[KEY]`, `set({ [KEY]: value })`) works unchanged, with
// account keys transparently scoped to the signed-in account.
export const accountStorage = {
  async get(base: string): Promise<Record<string, unknown>> {
    const key = await accountKey(base);
    const result = (await browser.storage.local.get(key)) as Record<string, unknown>;
    return { [base]: result[key] };
  },
  async set(items: Record<string, unknown>): Promise<void> {
    const scoped: Record<string, unknown> = {};
    for (const [base, value] of Object.entries(items)) scoped[await accountKey(base)] = value;
    await browser.storage.local.set(scoped);
  },
};

// For storage.onChanged listeners: does this changed key belong to `base`?
export function isAccountKey(changedKey: string, base: string): boolean {
  return changedKey === base || changedKey.startsWith(`${base}:`);
}

// Removes one account's local data (and nothing of any other account's).
export async function clearAccountData(uid: string): Promise<void> {
  const all = (await browser.storage.local.get(null)) as Record<string, unknown>;
  const mine = Object.keys(all).filter((k) => k.endsWith(`:${uid}`));
  if (mine.length) await browser.storage.local.remove(mine);
}
