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
 * anonymous and cookie-free — see the cookie-free client below, which is what
 * makes that justification true rather than merely intended.
 *
 * ── THIS ROUTE DEVIATES FROM THE ENG-726 TICKET IN THREE PLACES ──────────────
 * The ticket was written before ENG-723 landed and was never updated. The
 * authoritative contract is stablepass-be `docs/specs/api-contract.md`
 * § Waitlist, whose "What the route must implement (ENG-726)" table this file
 * implements. The three deviations, all deliberate:
 *
 *   1. IDIOM   — ticket says `.upsert(…)`; contract says a bare `.insert()`.
 *   2. STATUS  — ticket says `201 {data:{joined:true}}`; contract says
 *                `200 {data:{ok:true}}`.
 *   3. CODE    — ticket says `validation_failed`; contract says `invalid_email`.
 *
 * ── WHY THE INSERT IDIOM IS LOAD-BEARING ─────────────────────────────────────
 * A bare `.insert({ email })`. No `.select()`, and NO `.upsert()`.
 *
 * ENG-723 measured the upsert against local PostgREST and it does not work — it
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
 *     otherwise successful write. (That trap is documented in **stablepass-be**'s
 *     `.rx/gotchas.md`, not this repo's.)
 *
 * ── NO ENUMERATION THROUGH THIS ROUTE ────────────────────────────────────────
 * A duplicate answers byte-identically to a fresh insert, and the DB CHECK
 * (23514) answers byte-identically to our own validation rejection. Any
 * distinguishable branch would turn this into an "is this address already signed
 * up?" oracle. (ENG-770 records that a caller holding the publishable anon key
 * can still membership-test directly against PostgREST via 201-vs-409; that is
 * accepted pre-launch risk and is NOT closable here.)
 */
import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";

import { ok, fail } from "@/lib/api/envelope";

/**
 * Shape check only — real validation is the pair of rules under it.
 *
 * NOT identical to the table's own CHECK, despite looking like it. Measured:
 * JS `\s` is a strict SUPERSET of Postgres `[:space:]` under en_US.UTF-8, so
 * e.g. U+00A0 is rejected here but accepted there. The relationship that
 * matters is that this route is strictly STRICTER than the DB, so the 23514
 * branch below stays unreachable in practice and the disagreement always fails
 * closed. Do not "align" this regex to the CHECK literally — that would open
 * the 23514 path rather than close anything.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * C0/C1 controls and DEL. `\s` does NOT match most of these (NUL and BEL both
 * sail through `EMAIL_RE`), and a NUL specifically is rejected by Postgres with
 * 22P05 "unsupported Unicode escape sequence" — which is neither 23505 nor
 * 23514, so it would fall through to the generic 500 branch and let an
 * unauthenticated caller manufacture server errors and log lines with a
 * one-character payload. A control character is never part of a real address;
 * reject it here as ordinary bad input, with the ordinary 400.
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Zero-width and BOM characters. These are in neither `\s` nor `[:space:]`, so
 * `a<ZWSP>b@x.co` passes both this route AND the table's CHECK and lands as a
 * SECOND row alongside `ab@x.co` — a duplicate that dedupe cannot see and an
 * unmailable address in the launch-invite export, which is the one job this
 * table has. Stripped rather than rejected: the visitor almost always pasted
 * them by accident out of a rich-text editor.
 */
const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff]/g;

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
 * actually posted to, which is always the right answer here. All three are
 * fixed literals with no user input flowing into them, so there is no
 * open-redirect surface.
 */
const JOINED = "/?joined=1";
const NOT_JOINED_EMAIL = "/?joined=0&reason=email";
const NOT_JOINED_SERVER = "/?joined=0&reason=server";

/**
 * The decoy field names. `company` is the name the ticket and the epic spec
 * locked; `hp_ref` is what the shipped form actually renders, because
 * `name="company"` beside a `Company` label is Chrome Autofill's canonical
 * COMPANY_NAME shape and Chrome deliberately ignores `autocomplete="off"` for
 * address-profile autofill — an autofilled decoy would silently discard a real
 * signup. Both are honoured so the ticket's stated contract stays true and any
 * caller built against it still works.
 */
const DECOY_FIELDS = ["company", "hp_ref"] as const;

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * Did the caller put ANYTHING in a decoy field?
 *
 * Deliberately not `str()`: that coerces a non-string to `""`, so `company: 1`
 * or `company: ["x"]` would sail past the trap and reach the database. "Non-empty
 * means bot" has to mean non-empty for any JSON type, because a deliberate
 * evader is exactly the caller who sends a number.
 */
function decoyFilled(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim() !== "";
  return true;
}

/**
 * Which dialect of answer does this caller want?
 *
 * JSON unless the caller explicitly asked for HTML. The obvious rule — "JSON
 * only when `Accept` names application/json" — silently mis-serves any
 * programmatic caller that sends a wildcard Accept (which is what a bare
 * `fetch()` sends):
 * it would get the 303, `fetch` would auto-follow it, and it would read
 * `response.ok === true` off an HTML page even for a validation failure. A
 * browser submitting a native form always sends `text/html`, so keying the
 * redirect branch off that is both narrower and the safer default.
 */
function wantsJson(req: Request): boolean {
  const accept = (req.headers.get("accept") ?? "").toLowerCase();
  if (accept.includes("application/json")) return true;
  return !accept.includes("text/html");
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
async function readBody(req: Request): Promise<{ email: string; decoyed: boolean }> {
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();

  if (contentType.includes("application/json")) {
    const body = await req.json().catch(() => null);
    const record = (body ?? {}) as Record<string, unknown>;
    return {
      email: str(record.email),
      decoyed: DECOY_FIELDS.some((field) => decoyFilled(record[field])),
    };
  }

  // `application/x-www-form-urlencoded` (and multipart, which formData also
  // parses). Catching keeps a bodyless or malformed POST on the 400 path rather
  // than throwing a 500 out of the handler.
  const form = await req.formData().catch(() => null);
  return {
    email: str(form?.get("email")),
    decoyed: DECOY_FIELDS.some((field) => decoyFilled(form?.get(field))),
  };
}

/**
 * A cookie-free anon client, deliberately NOT `supabaseServer()`.
 *
 * `supabaseServer()` wires a cookie adapter, which does two things this route
 * must not do. It runs the insert as `authenticated` rather than `anon` whenever
 * a signed-in member happens to post, so the access shape ENG-723 measured and
 * designed the RLS around is not the one exercised; and its `setAll` can WRITE
 * refreshed auth cookies onto whichever origin served the request — including
 * the marketing apex, which is precisely what the host-only-cookie topology
 * exists to prevent. Neither is exploitable today, but `middleware.ts` cites
 * "anonymous and cookie-free" as the reason it is allowed to punch a hole in a
 * blanket 404, and that justification should be true by construction.
 *
 * The epic's own W4 slice (ENG-730) reaches for the same shape — "bare anon
 * client, no cookies" — for the public trainer read.
 */
function waitlistClient() {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => [], setAll: () => {} } },
  );
}

export async function POST(req: Request) {
  const json = wantsJson(req);
  const { email, decoyed } = await readBody(req);

  const success = () => (json ? ok({ ok: true }) : seeOther(JOINED));
  const rejectEmail = () =>
    json
      ? fail("invalid_email", "Enter a valid email address.", 400)
      : seeOther(NOT_JOINED_EMAIL);

  // ── Honeypot, checked FIRST ──────────────────────────────────────────────
  // Before validation on purpose: a bot that fills the decoy must get the
  // ordinary success answer whatever else it submitted, so it learns nothing
  // about what the endpoint accepts. Nothing is written. This is the only abuse
  // control in v1 — rate limiting was explicitly scoped out — so it is not
  // optional decoration.
  if (decoyed) {
    // Logged (no PII, no address) purely so the false-positive rate is
    // OBSERVABLE. A honeypot that silently discards real signups and leaves no
    // trace is indistinguishable from the endpoint working perfectly.
    console.info("waitlist honeypot tripped");
    return success();
  }

  // Strip the invisible characters a paste tends to carry, then judge. NFKC
  // first so full-width and compatibility forms fold to their ASCII equivalents
  // before the shape check sees them.
  const cleaned = email.normalize("NFKC").replace(ZERO_WIDTH, "").trim();

  if (
    !cleaned ||
    cleaned.length > MAX_EMAIL_LENGTH ||
    CONTROL_CHARS.test(cleaned) ||
    !EMAIL_RE.test(cleaned)
  ) {
    return rejectEmail();
  }

  // Lowercased as well as trimmed. The unique index is on `lower(email)`, so
  // case never affects dedupe either way; normalising just means the manual
  // launch-invite export is not full of the same prospect in three casings.
  // The trim matters more than it looks: a pasted " sam@x.co" would otherwise
  // fail the table's CHECK and 400 a perfectly good signup.
  const normalised = cleaned.toLowerCase();

  let error: { code?: string } | null = null;
  try {
    ({ error } = await waitlistClient().from("waitlist").insert({ email: normalised }));
  } catch (cause) {
    // Client construction or transport threw outright (e.g. the public env vars
    // are missing). Without this the framework returns a bodyless 500 and the
    // contract's "anything else → 500, generic body" row quietly stops holding.
    console.error("waitlist client failed", cause instanceof Error ? cause.name : "unknown");
    return json
      ? fail("waitlist_failed", "Something went wrong. Please try again.", 500)
      : seeOther(NOT_JOINED_SERVER);
  }

  if (error) {
    // Already on the list. Indistinguishable from a fresh join, by design.
    if (error.code === UNIQUE_VIOLATION) return success();

    // The table's own shape CHECK. This route is strictly stricter than that
    // constraint (see EMAIL_RE), so it is unreachable in practice — and it
    // answers exactly as our own validation does, because a distinguishable
    // branch here would reintroduce the oracle the 23505 mapping closes.
    if (error.code === CHECK_VIOLATION) return rejectEmail();

    // Never forward the PostgREST error to the caller. The code alone is logged
    // — never the address, which is the only PII this endpoint touches.
    console.error("waitlist insert failed", error.code);
    return json
      ? fail("waitlist_failed", "Something went wrong. Please try again.", 500)
      : seeOther(NOT_JOINED_SERVER);
  }

  return success();
}
