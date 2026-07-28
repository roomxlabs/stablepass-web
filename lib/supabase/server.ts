// Supabase server client for Route Handlers / Server Components.
// Tokens live in httpOnly cookies (set by @supabase/ssr) — never in browser JS.
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { AUTH_COOKIE_NAME } from "./cookie-name";

export async function supabaseServer() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      // Keep this app's session distinct from stablepass-admin's on a shared host.
      cookieOptions: { name: AUTH_COOKIE_NAME },
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (toSet) => {
          try { toSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options)); } catch { /* Server Component: ignore */ }
        },
      },
    },
  );
}
