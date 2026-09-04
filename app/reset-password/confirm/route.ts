import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { RECOVERY_COOKIE, RECOVERY_COOKIE_MAX_AGE } from "../recovery-cookie";

// GET /reset-password/confirm — turns a Supabase recovery link into a session.
//
// WHY THIS EXISTS AS A SEPARATE ROUTE HANDLER. Exchanging a recovery link
// WRITES cookies, and a Server Component cannot set them — the `setAll` in
// `lib/supabase/server.ts` swallows the attempt inside a try/catch by design.
// So `/reset-password` (a page) redirects the secret here, this handler does
// the exchange, and sends the visitor back to a clean `/reset-password` URL
// that is now authenticated. The recovery secret is therefore never in the
// address bar of the form the member types their new password into.
//
// WHY NOT REUSE `/auth/callback`: it exists for OAuth and, on failure, dumps
// the visitor on `/signin` with no explanation. A dead reset link needs its own
// message, which is a stated requirement of the ticket.
//
// ── The two link shapes, and why the difference matters a great deal ────────
//
//   1. `?code=…`  PKCE. Exchangeable ONLY by the browser that requested the
//      reset, because it needs that browser's `…-code-verifier` cookie.
//
//   2. `?token_hash=…&type=recovery`  Verifier-free, so it works on ANY device.
//      Produced when the Supabase recovery email template uses `{{ .TokenHash }}`
//      and points straight at this app.
//
// Shape 1 is what Supabase emits by DEFAULT, and it makes the most common real
// journey — request the reset on a laptop, open the mail on a phone — fail. It
// fails destructively: Supabase's `/auth/v1/verify` consumes the emailed token
// before it ever redirects here, so retrying in the original browser fails too.
// The member is then in a loop of "expired" screens with no way out.
//
// **Shape 2 is therefore the required production configuration**, and switching
// the Supabase recovery template to `{{ .TokenHash }}` is a BLOCKING deploy step
// for this ticket, not a nicety. See the PR body. Shape 1 stays supported so
// same-device resets keep working before and after that change, and so links
// already sitting in inboxes are not broken.

const INVALID = "/reset-password?state=invalid";
// A distinct state, because it needs distinct advice. Telling someone whose
// link is fine but device-bound that it "expired" sends them round the request
// loop forever; they need to be told to open it where they asked for it.
const WRONG_DEVICE = "/reset-password?state=devicemismatch";

/**
 * Mark this session as one that came from a recovery link.
 *
 * WHY: `updateUser({ password })` changes the password with no knowledge of the
 * current one. Gating the form on "is there a session" would therefore turn
 * `/reset-password` into a change-password screen with no re-authentication —
 * anyone with a live session (an unattended browser, a stolen non-httpOnly
 * cookie) could take the account over permanently, and single-device login
 * (guardrail #5) would lock the real member out. All three reviewers
 * reproduced that. So the page requires THIS cookie, not merely a user.
 *
 * httpOnly so page JS cannot forge it; short-lived because it is a permission
 * to do one thing, now; `lax` so it survives the redirect chain from the email.
 */
function grant(url: URL): NextResponse {
  const response = NextResponse.redirect(url);
  response.cookies.set(RECOVERY_COOKIE, "1", {
    httpOnly: true,
    sameSite: "lax",
    secure: url.protocol === "https:",
    path: "/reset-password",
    maxAge: RECOVERY_COOKIE_MAX_AGE,
  });
  return response;
}

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);

  // Supabase reports a dead link by redirecting here with these rather than
  // with a secret. Honour it before trying anything else.
  if (searchParams.get("error") || searchParams.get("error_code")) {
    return NextResponse.redirect(new URL(INVALID, origin));
  }

  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");

  const sb = await supabaseServer();

  if (code) {
    const { error } = await sb.auth.exchangeCodeForSession(code);
    // Almost always the missing-verifier case — see the note above.
    if (error) return NextResponse.redirect(new URL(WRONG_DEVICE, origin));
    return grant(new URL("/reset-password", origin));
  }

  // `type` is pinned to exactly "recovery". A `signup`, `magiclink` or
  // `email_change` token must NOT be spendable here: those are issued in
  // contexts that never intended to authorise a password change.
  if (tokenHash && type === "recovery") {
    const { error } = await sb.auth.verifyOtp({ token_hash: tokenHash, type: "recovery" });
    if (error) return NextResponse.redirect(new URL(INVALID, origin));
    return grant(new URL("/reset-password", origin));
  }

  // Nothing usable in the URL at all.
  return NextResponse.redirect(new URL(INVALID, origin));
}
