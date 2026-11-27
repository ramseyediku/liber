// Singleton Supabase client, shared by every extension context. vendor/supabase.js
// is a committed, pre-bundled @supabase/supabase-js build (MV3 CSP forbids
// loading it from a CDN). src/shared/env.ts is generated from .env by
// scripts/generate-config.ts (`npm run config`) — see .env.example.
import { createClient } from "../../vendor/supabase.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./env.ts";

type SupabaseClient = ReturnType<typeof createClient>;

// GoTrueClient's SupportedStorage type only needs async
// getItem/setItem/removeItem, so browser.storage.local, once wrapped,
// satisfies it directly. Required (not just convenient): the background
// service worker has neither `window` nor `localStorage`.
const chromeStorageAdapter = {
  async getItem(key: string): Promise<string | null> {
    const result = (await browser.storage.local.get(key)) as Record<string, string>;
    return result[key] ?? null;
  },
  async setItem(key: string, value: string): Promise<void> {
    await browser.storage.local.set({ [key]: value });
  },
  async removeItem(key: string): Promise<void> {
    await browser.storage.local.remove(key);
  },
};

let client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        storage: chromeStorageAdapter,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false, // plain email/password only — no OAuth redirect flow
      },
    });
  }
  return client;
}

// Every context always has a session from here on — jobs/job_profiles RLS
// only requires auth.uid() (no is_permanent_user() gate in this schema), so
// an anonymous session is enough to use the extension with no sign-up at
// all. Local-first storage/limits still treat anonymous vs permanent
// differently (see storage.ts/sync.ts) — this just guarantees *a* session
// exists, not which kind.
//
// The background worker and every page (dashboard, popup, settings…) each run
// this, and each has its own module state — so at startup two contexts could
// both see "no session" and each create a guest user, leaving an orphan. The
// check-then-create runs under a Web Lock (shared by all contexts of the
// extension), and the check is repeated once the lock is held, so the second
// context finds the session the first one just stored.
const SESSION_LOCK = "liber-ensure-session";
let ensureSessionPromise: Promise<void> | null = null;

async function createSessionIfMissing(): Promise<void> {
  const supabase = getSupabaseClient();
  const { data } = await supabase.auth.getSession();
  if (data.session) return;
  const { error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
}

export function ensureSession(): Promise<void> {
  if (!ensureSessionPromise) {
    ensureSessionPromise = (async () => {
      const supabase = getSupabaseClient();
      const { data } = await supabase.auth.getSession();
      if (data.session) return; // the common case: no lock needed
      if (typeof navigator !== "undefined" && navigator.locks) {
        await navigator.locks.request(SESSION_LOCK, createSessionIfMissing);
      } else {
        await createSessionIfMissing(); // no Web Locks: previous behaviour
      }
    })();
    ensureSessionPromise.catch(() => {
      ensureSessionPromise = null; // don't cache a failed sign-in attempt
    });
  }
  return ensureSessionPromise;
}

// "Permanent" = a real email/password account, not an anonymous session —
// distinguishes Settings' logged-in/out UI and gates Cloud Sync, even
// though RLS itself no longer requires it.
export async function isPermanentUser(): Promise<boolean> {
  const supabase = getSupabaseClient();
  const { data } = await supabase.auth.getUser();
  return !!data?.user && !data.user.is_anonymous;
}
