import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

/**
 * Creates an SSR Supabase client wired to Next.js cookies.
 */
export function createClient_ssr() {
  const cookieStore = cookies();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY');
  }

  return createServerClient(url, anonKey, {
    cookies: {
      get(name: string) {
        return cookieStore.get(name)?.value;
      },
      set(name: string, value: string, options: CookieOptions) {
        try {
          cookieStore.set({ name, value, ...options });
        } catch {
          // Can happen in Server Components or read-only contexts
        }
      },
      remove(name: string, options: CookieOptions) {
        try {
          cookieStore.set({ name, value: '', ...options, maxAge: 0 });
        } catch {
          // Can happen in Server Components or read-only contexts
        }
      },
    },
  });
}

/**
 * Guard that verifies the incoming request has a valid Supabase authenticated session.
 * Uses getUser() for server-validated identity.
 */
export async function requireAuthenticatedUser() {
  try {
    const supabase = createClient_ssr();
    const { data: { user }, error } = await supabase.auth.getUser();

    if (error || !user) {
      return { user: null, supabase, error: error || new Error('Unauthorized') };
    }

    return { user, supabase, error: null };
  } catch (err: any) {
    return { user: null, supabase: null as any, error: err || new Error('Unauthorized') };
  }
}

/**
 * Server-only privileged Supabase client.
 * Strictly uses server-side service role key (with backward-compatible fallback).
 */
export function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY;

  if (!url) {
    throw new Error('Supabase URL is not configured');
  }

  if (!serviceKey) {
    throw new Error('Supabase service role key is not configured');
  }

  return createClient(
    url,
    serviceKey,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    }
  );
}
