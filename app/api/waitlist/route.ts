/**
 * POST /api/waitlist — ENG-726 (W2 of the ENG-721 waitlist cutover).
 *
 * Pre-launch, stablepass.co captures an e-mail address and nothing else. This is
 * the ONLY write path to `public.waitlist`: the browser never talks to PostgREST
 * directly, and the marketing route group may not import Supabase at all
 * (pinned by test/marketing-shell.test.tsx). The form posts here instead.
 *
 * Served on BOTH hosts. `middleware.ts` 404s every other `/api/*` on the
 * marketing apex; `/api/waitlist` is added to `isSharedPath()` because it is
 * anonymous and cookie-free, so putting it on the apex breaks nothing that 404
 * protects. See the note there.
 *
 * ── THE INSERT IDIOM IS LOAD-BEARING ─────────────────────────────────────────
 * A bare `.insert({ email })`. No `.select()`, and NO `.upsert()`.
 *
 * ENG-726 was originally written around
 * `.upsert({ email }, { onConflict: "email", ignoreDuplicates: true })`.
 * ENG-723 measured that idiom against local PostgREST and it does not work — it
 * fails on EVERY insert, not just duplicates:
 *
 *   * With no `onConflict`, supabase-js sends `Prefer: resolution=ignore-
 *     duplicates` and PostgREST aims the ON CONFLICT arbiter at the table's
 *     PRIMARY KEY. A *targeted* arbiter requires SELECT-checkable visibility
 *     under row security, which `anon` deliberately does not have on `waitlist`,
 *     so it raises 42501 even for a brand-new address.
 *   * `onConflict: "email"` raises 42P10: `idx_waitlist_email` is an EXPRESSION
 *     index on `lower(email)`, not a plain unique constraint, and PostgREST's
 *     `on_conflict` takes a column list that cannot name the expression at all.
 *   * `.select()` after an insert becomes INSERT … RETURNING, whose returned row
 *     must also satisfy a SELECT policy the caller has none of — 42501 on an
 *     otherwise successful write. (Repo-wide trap; see .rx/gotchas.md.)
 *
 * So dedupe reaches us as 23505 and this route absorbs it. The corrected
 * contract is stablepass-be `docs/specs/api-contract.md` § Waitlist; it, not the
 * ticket's decision 3, is what this file implements.
 *
 * ── NO ENUMERATION THROUGH THIS ROUTE ────────────────────────────────────────
 * A duplicate answers byte-identically to a fresh insert, and the DB CHECK
 * (23514) answers byte-identically to our own validation rejection. Any
 * distinguishable branch would turn this into an "is this address already signed
 * up?" oracle. (ENG-770 records that a caller holding the publishable anon key
 * can still membership-test directly against PostgREST via 201-vs-409; that is
 * accepted pre-launch risk and is NOT closable here.)
 */
import { NextResponse } from "next/server";

import { ok, fail } from "@/lib/api/envelope";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * Deliberately the same shape as the signup route's regex AND as the table's
 * own CHECK (`^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$`). Copied rather
 * than imported: `app/api/auth/signup/route.ts` is outside this ticket's surface
 * and importing one route module from another is not a pattern this repo uses.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** RFC 5321 caps a forward path at 254 characters; longer is never a real address. */
const MAX_EMAIL_LENGTH = 254;

/** Postgres SQLSTATEs, as surfaced by PostgREST through supabase-js. */
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";

/**
 * Where a scripting-off browser lands after the native POST.
 *
 * RELATIVE on purpose. This route is served on two origins, and an absolute
 * Location built from `req.url` would be wrong behind the proxy that fronts the
 * apex (`x-forwarded-host` carries the real public host while `host` carries the
 * internal one — the same trap `middleware.ts:requestHost` documents). A
 * relative Location is resolved by the browser against whichever origin it
 * actually posted to, which is always the right answer here.
 */
const JOINED = "/?joined=1";
const NOT_JOINED_EMAIL = "/?joined=0&reason=email";
const NOT_JOINED_SERVER = "/?joined=0&reason=server";

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * Which dialect of answer does this caller want?
 *
 * The enhanced form sets `Accept: application/json` explicitly on its fetch. A
 * native browser form POST sends `text/html,application/xhtml+xml,…` and never
 * `application/json`, so it falls through to the 303 branch. Content
 * negotiation rather than a hidden marker field: the marker would be forgeable
 * and, more to the point, would have to be kept in sync by every future caller.
 */
function wantsJson(req: Request): boolean {
  return (req.headers.get("accept") ?? "").toLowerCase().includes("application/json");
}

function seeOther(location: string): NextResponse {
  // 303 specifically: it forces the follow-up to be a GET, so a refresh on the
  // landing page cannot replay the POST.
  return new NextResponse(null, { status: 303, headers: { Location: location } });
}

/**
 * Accepts BOTH dialects. JSON for the fetch, form-encoded for the native POST —
 * the whole progressive-enhancement contract rests on the second one working.
 */
async function readBody(req: Request): Promise<{ email: string; company: string }> {
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();

  if (contentType.includes("application/json")) {
    const body = await req.json().catch(() => null);
    return { email: str(body?.email), company: str(body?.company) };
  }

  // `application/x-www-form-urlencoded` (and multipart, which formData also
  // parses). Catching keeps a bodyless or malformed POST on the 400 path rather
  // than throwing a 500 out of the handler.
  const form = await req.formData().catch(() => null);
  return { email: str(form?.get("email")), company: str(form?.get("company")) };
}

export async function POST(req: Request) {
  const json = wantsJson(req);
  const { email, company } = await readBody(req);

  const success = () => (json ? ok({ ok: true }) : seeOther(JOINED));

  // ── Honeypot, checked FIRST ──────────────────────────────────────────────
  // Before validation on purpose: a bot that fills the decoy must get the
  // ordinary success answer whatever else it submitted, so it learns nothing
  // about what the endpoint accepts. Nothing is written. This is the only abuse
  // control in v1 — rate limiting was explicitly scoped out — so it is not
  // optional decoration.
  if (company) return success();

  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email)) {
    return json
      ? fail("invalid_email", "Enter a valid email address.", 400)
      : seeOther(NOT_JOINED_EMAIL);
  }

  // Lowercased as well as trimmed. The unique index is on `lower(email)`, so
  // case never affects dedupe either way; normalising just means the manual
  // launch-invite export is not full of the same prospect in three casings.
  // The trim matters more than it looks: a pasted " sam@x.co" would otherwise
  // fail the table's CHECK and 400 a perfectly good signup.
  const normalised = email.toLowerCase();

  const sb = await supabaseServer();
  const { error } = await sb.from("waitlist").insert({ email: normalised });

  if (error) {
    // Already on the list. Indistinguishable from a fresh join, by design.
    if (error.code === UNIQUE_VIOLATION) return success();

    // The table's own shape CHECK. Our EMAIL_RE mirrors it, so this is only
    // reachable if the two ever drift — and it answers exactly as our own
    // validation does, because a distinguishable branch here would reintroduce
    // the oracle the 23505 mapping above exists to close.
    if (error.code === CHECK_VIOLATION) {
      return json
        ? fail("invalid_email", "Enter a valid email address.", 400)
        : seeOther(NOT_JOINED_EMAIL);
    }

    // Never forward the PostgREST error to the caller. The code alone is logged
    // — never the address, which is the only PII this endpoint touches.
    console.error("waitlist insert failed", error.code);
    return json
      ? fail("waitlist_failed", "Something went wrong. Please try again.", 500)
      : seeOther(NOT_JOINED_SERVER);
  }

  return success();
}
