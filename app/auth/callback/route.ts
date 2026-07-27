// OAuth PKCE callback (Google). Supabase redirects here with a `code` after the
// provider round-trip; we exchange it for a session (httpOnly cookies) and send the
// visitor on. Provisioning (app_user + trial subscription) is handled by the
// handle_new_user() DB trigger; the member layout's own queries pick it up.
import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/explore";

  if (code) {
    const sb = await supabaseServer();
    const { error } = await sb.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, origin));
  }

  return NextResponse.redirect(new URL("/signin", origin));
}
