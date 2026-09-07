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
 * WHAT THIS COOKIE IS NOT: an authorization boundary. It gates the *screen*,
 * not the capability. `supabase.auth.updateUser({ password })` is a call the
 * browser can make directly against Supabase with nothing but a live session —
 * it never sees this cookie, so its absence cannot stop a password change. The
 * only thing that does is Supabase's own
 * `GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION`, which is step 3
 * of the blocking config in the PR body. Read the flags below as UX hardening
 * on top of that, not instead of it.
 *
 * `httpOnly` keeps `document.cookie` from reading or setting it, so the page's
 * own JS cannot mint itself the marker and skip the email round-trip — it does
 * NOT make the reset flow unforgeable, per the paragraph above. Short-lived
 * because it is a permission to do one thing, now; `lax` so it survives the
 * redirect chain from the email.
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
    const { data, error } = await sb.auth.exchangeCodeForSession(code);
    // Almost always the missing-verifier case — see the note above.
    if (error) return NextResponse.redirect(new URL(WRONG_DEVICE, origin));

    // ── The `?code=` half of the token-type pin ───────────────────────────────
    //
    // The `token_hash` branch below refuses a `signup`/`magiclink`/`email_change`
    // token by pinning `type === "recovery"`. Without this check the PKCE branch
    // had no equivalent: it handed ANY exchangeable code to Supabase and granted
    // the recovery marker on success. A member holding one of their own non-
    // recovery codes (an OAuth callback code, a magic link) could spend it here
    // and reach the "set a new password without knowing the old one" form —
    // exactly the re-authentication bypass the marker cookie exists to prevent.
    //
    // `redirectType` is how auth-js reports which flow this browser STARTED.
    // `resetPasswordForEmail` stores the PKCE verifier with a `/recovery` suffix
    // (`getCodeChallengeAndMethod(storage, key, isPasswordRecovery = true)` in
    // @supabase/auth-js), and `_exchangeCodeForSession` splits that suffix back
    // off and returns it — the same signal it uses to decide between emitting a
    // `PASSWORD_RECOVERY` and a `SIGNED_IN` event. Any other flow stores a bare
    // verifier, so `redirectType` comes back null and we refuse.
    //
    // BE PRECISE ABOUT WHAT THIS IS: a check on the flow THIS BROWSER began, read
    // from the local verifier cookie — not a server-side assertion by GoTrue that
    // the code itself is recovery-scoped. That is still the property we need,
    // because the marker is a statement about this browser's intent, and a code
    // is only exchangeable in the browser that holds its matching verifier.
    //
    // MEASURED against local GoTrue (5 Sep), both directions, not inferred:
    //   resetPasswordForEmail  → verifier stored "…/recovery" → redirectType "recovery"
    //   signInWithOtp (magic)  → verifier stored bare         → redirectType null
    // The magic-link code still EXCHANGES cleanly and still yields a session —
    // which is exactly why `error === null` was never sufficient to grant the
    // marker, and why this branch needed its own check rather than trusting the
    // exchange to fail on a non-recovery code. It does not fail.
    // The cast is deliberate and narrow. `_exchangeCodeForSession` returns
    // `redirectType` at runtime (it is spread into the result alongside
    // `session`/`user`), but @supabase/auth-js's PUBLISHED type for the PKCE
    // exchange omits the field — it appears only in a docstring example. So the
    // value has to be read through a widening cast rather than off the type.
    //
    // Note which way this fails. If a future auth-js stopped returning the
    // field, `redirectType` reads back undefined and EVERY `?code=` link is
    // refused — reset links break loudly and the tests below go red, rather than
    // the marker being handed out silently. Fail-closed is the correct direction
    // for a check that guards a password change.
    const { redirectType } = (data ?? {}) as { redirectType?: string | null };

    if (redirectType !== "recovery") {
      // By this point `exchangeCodeForSession` has ALREADY minted a session and
      // written its cookies (auth-js calls `_saveSession` before returning, and
      // a Route Handler merges those onto whatever response we return). So
      // withholding the marker is not by itself enough: without this the visitor
      // would be silently SIGNED IN by a link we just called unusable.
      //
      // `scope: "local"` clears the cookies we are about to emit. It is
      // deliberately not "global": the code was already spent and, under
      // single-device login (guardrail #5), minting the session already revoked
      // the member's other sessions server-side. That cannot be undone here, and
      // a global sign-out would only widen the damage.
      await sb.auth.signOut({ scope: "local" });
      return NextResponse.redirect(new URL(INVALID, origin));
    }

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
