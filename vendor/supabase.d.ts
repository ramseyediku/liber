// Hand-written surface for vendor/supabase.js (a bundled @supabase/supabase-js)
// — only what this extension actually calls, not the full SDK. Keeps TS
// inference from a huge untyped bundle out of the way.

export interface AuthUser {
  id: string;
  email?: string;
  is_anonymous?: boolean;
  user_metadata: Record<string, unknown>;
}

export interface AuthSession {
  access_token: string;
  user: AuthUser;
}

export interface AuthError {
  message: string;
  code?: string;
}

export interface AuthResult<T> {
  data: T;
  error: AuthError | null;
}

export interface AuthSubscription {
  subscription: { unsubscribe(): void };
}

export interface AuthUserSessionResult {
  user: AuthUser;
  session: AuthSession | null;
}

export interface Auth {
  getUser(): Promise<AuthResult<{ user: AuthUser | null }>>;
  getSession(): Promise<AuthResult<{ session: AuthSession | null }>>;
  signUp(credentials: { email: string; password: string }): Promise<AuthResult<AuthUserSessionResult>>;
  signInWithPassword(credentials: {
    email: string;
    password: string;
  }): Promise<AuthResult<AuthUserSessionResult>>;
  signInAnonymously(): Promise<AuthResult<AuthUserSessionResult>>;
  signOut(): Promise<{ error: AuthError | null }>;
  resetPasswordForEmail(
    email: string,
    options?: { redirectTo?: string },
  ): Promise<AuthResult<Record<string, never> | null>>;
  updateUser(attrs: {
    email?: string;
    password?: string;
    data?: Record<string, unknown>;
  }): Promise<AuthResult<{ user: AuthUser }>>;
  onAuthStateChange(callback: (event: string, session: AuthSession | null) => void): AuthSubscription;
}

export interface PostgrestResult<T> {
  data: T | null;
  error: { message: string; code?: string } | null;
}

// Chainable query builder — deliberately loose (every chain method returns
// `any`-shaped): this project reads/writes plain row objects and converts
// them itself (storage.ts's rowToJob), rather than relying on this builder
// for per-table column types. Real per-table types land once the real
// Supabase schema types are generated (`supabase gen types typescript`).
export interface PostgrestQueryBuilder extends Promise<PostgrestResult<any>> {
  select(columns?: string): PostgrestQueryBuilder;
  insert(values: Record<string, unknown>): PostgrestQueryBuilder;
  upsert(values: Record<string, unknown>, options?: { onConflict?: string }): PostgrestQueryBuilder;
  update(values: Record<string, unknown>): PostgrestQueryBuilder;
  delete(): PostgrestQueryBuilder;
  eq(column: string, value: unknown): PostgrestQueryBuilder;
  ilike(column: string, pattern: string): PostgrestQueryBuilder;
  order(column: string, options?: { ascending?: boolean }): PostgrestQueryBuilder;
  single(): PostgrestQueryBuilder;
  maybeSingle(): PostgrestQueryBuilder;
}

export interface FunctionsResult<T> {
  data: T | null;
  error: { message: string } | null;
}

export interface Functions {
  invoke<T = any>(name: string, options?: { body?: unknown }): Promise<FunctionsResult<T>>;
}

export interface SupabaseClient {
  auth: Auth;
  functions: Functions;
  from(table: string): PostgrestQueryBuilder;
}

export interface SupabaseClientOptions {
  auth?: {
    storage?: {
      getItem(key: string): Promise<string | null>;
      setItem(key: string, value: string): Promise<void>;
      removeItem(key: string): Promise<void>;
    };
    persistSession?: boolean;
    autoRefreshToken?: boolean;
    detectSessionInUrl?: boolean;
  };
}

export declare function createClient(
  supabaseUrl: string,
  supabaseKey: string,
  options?: SupabaseClientOptions,
): SupabaseClient;
