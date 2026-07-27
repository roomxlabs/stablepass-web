// Server-only helper: call a be Supabase Edge Function AS THE CALLER (their JWT),
// never a service role. The Mux signing key + ranking live only in the be fns.
import type { SupabaseClient } from "@supabase/supabase-js";

export async function edgeFetch(
  sb: SupabaseClient,
  path: string, // e.g. "feed?cursor=..&limit=20" or "playback"
  init?: { method?: string; body?: unknown },
): Promise<Response> {
  const { data: { session } } = await sb.auth.getSession();
  const token = session?.access_token;
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  return fetch(`${base}/functions/v1/${path}`, {
    method: init?.method ?? "GET",
    headers: {
      "content-type": "application/json",
      apikey: anon,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    cache: "no-store",
  });
}
