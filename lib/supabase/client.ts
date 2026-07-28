// Browser Supabase client (anon). RLS applies. No raw token in JS storage.
import { createBrowserClient } from "@supabase/ssr";
import { AUTH_COOKIE_NAME } from "./cookie-name";
export const supabaseBrowser = () =>
  createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    // Keep this app's session distinct from stablepass-admin's on a shared host.
    { cookieOptions: { name: AUTH_COOKIE_NAME } },
  );
