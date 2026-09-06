import { supabaseServer } from "@/lib/supabase/server";
import { created, fail } from "@/lib/api/envelope";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A duplicate EMAIL. Was `trial_already_used` (ENG-763's repeat-signup wall);
// with the trial retired there is nothing to have used up, so this is now the
// plain, honest fact: the address already has an account and the way in is to
// sign in. The message is the copy the form renders verbatim — the form
// deliberately keeps no branch of its own on this code (ENG-1003).
//
// A duplicate PHONE is no longer refused at all. The `phone_in_use` pre-check
// existed only to enforce one free trial per number; there is no trial to
// ration, so the number is not a deterrent any more. ENG-742's index and its
// RPC both stay in the database — the backstop still degrades a duplicate phone
// to NULL rather than failing the insert — this route simply stops calling it.
const ACCOUNT_EXISTS = "account_exists";
const ACCOUNT_EXISTS_MESSAGE =
  "You already have an account with that email — sign in to continue.";
const MIN_PASSWORD = 8;
// AU postcode: exactly four digits, stored as text so '0800' survives. Never
// parseInt it, and never widen this to accept 'VIC 3000' — the DB has a
// matching CHECK constraint (app_user_postcode_au) that would reject it anyway.
const POSTCODE_RE = /^\d{4}$/;

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

// POST /api/auth/signup — the ONLY creation path for a new subscriber. Anon
// signUp; the DB trigger handle_new_user() provisions app_user + a subscription
// row that is born `lapsed` (ENG-999 — no trial). The new account therefore
// holds NO access and reads zero content rows until Stripe says otherwise, and
// the form sends it straight to /checkout. Never a second creation path, never
// the service role.
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  // Trim everything up front: a whitespace-only field is empty, and '3000 '
  // would fail the postcode CHECK constraint in the database.
  const firstName = str(body?.firstName);
  const lastName = str(body?.lastName);
  const email = str(body?.email);
  const phone = str(body?.phone);
  const postcode = str(body?.postcode);
  // The password is NOT trimmed — leading/trailing spaces are legitimate
  // characters in a password. Only its EMPTINESS is judged on the trimmed
  // value, so an all-whitespace password fails rule 1 like any other blank
  // field instead of sneaking through the length check.
  const password = typeof body?.password === "string" ? body.password : "";

  if (!firstName || !lastName || !email || !phone || !postcode || !password.trim()) {
    return fail("validation_failed", "All fields are required.", 400);
  }
  if (!EMAIL_RE.test(email)) {
    return fail("validation_failed", "Enter a valid email address.", 400);
  }
  if (!POSTCODE_RE.test(postcode)) {
    return fail("validation_failed", "Enter a valid 4-digit Australian postcode.", 400);
  }
  if (password.length < MIN_PASSWORD) {
    return fail("validation_failed", `Password must be at least ${MIN_PASSWORD} characters.`, 400);
  }

  const sb = await supabaseServer();

  const { data, error } = await sb.auth.signUp({
    email,
    password,
    // handle_new_user() reads these keys off raw_user_meta_data. `name` is sent
    // explicitly alongside first/last: the app_user_name_sync BEFORE INSERT
    // trigger would compose it from first/last anyway, but sending it keeps the
    // payload self-describing for legacy readers (older mobile builds write
    // `name` only, and that same trigger splits it back into first/last).
    options: {
      data: {
        name: `${firstName} ${lastName}`.trim(),
        first_name: firstName,
        last_name: lastName,
        phone,
        postcode,
      },
    },
  });

  // Supabase resists enumeration: a duplicate email may come back as an
  // `error`, or as a 200 with a user whose `identities` array is empty.
  //
  // The CODE is checked before the message. Verified against the running stack,
  // supabase-js returns `AuthApiError { status: 422, code: "user_already_exists",
  // message: "User already registered" }`, and a stable code beats matching
  // GoTrue's prose — a reworded upstream string would otherwise silently demote
  // the email half of the wall to a generic 400. The regex stays as the
  // fallback for older GoTrue builds that send no code.
  const duplicateCode = (error as { code?: string } | null)?.code;
  const looksLikeDuplicate =
    (error && (duplicateCode === "user_already_exists" || /already registered/i.test(error.message))) ||
    (!error && data?.user && Array.isArray(data.user.identities) && data.user.identities.length === 0);
  if (looksLikeDuplicate) {
    // BOTH detection paths above are load-bearing and both stay. Supabase
    // resists enumeration and returns the duplicate either way depending on the
    // GoTrue build, so dropping one silently demotes half the duplicates to a
    // generic 400 — which is a worse experience, not a safer one.
    return fail(ACCOUNT_EXISTS, ACCOUNT_EXISTS_MESSAGE, 409);
  }

  if (error) {
    // WHAT HAPPENS IF THE DATABASE ITSELF REJECTS THE SIGNUP, and why there is
    // no phone-specific branch here. Measured on this stack, not assumed:
    //
    // A trigger that raises inside the auth.users insert makes GoTrue answer
    // HTTP 500 with the raw Postgres error, PII and all —
    //   {"code":"23514","message":"...violates check constraint...",
    //    "detail":"Failing row contains (…, someone@example.com, …)"}
    // — but supabase-js does NOT surface that. It flattens the whole thing to
    //   AuthRetryableFetchError { status: 500, code: undefined, message: "{}" }
    // so by the time the error reaches this line the SQLSTATE and the DETAIL
    // are both already gone. An earlier revision matched `23505` /
    // `idx_app_user_phone` here to show the wall on a lost index race; it was
    // deleted because it could never fire, and two tests that "proved" it were
    // asserting a response shape the client cannot produce.
    //
    // That is acceptable rather than merely unavoidable, for two reasons:
    //   1. The phone race does not reach here at all. ENG-742's trigger catches
    //      its own unique violation and retries with a NULL phone, so a losing
    //      concurrent signup SUCCEEDS. The member keeps their trial and their
    //      number simply is not stored. That is the migration's locked decision
    //      (never abort an auth.users insert), not a gap.
    //   2. The fallthrough below is already the right answer: fixed copy, no
    //      stack trace, no leak. The flattened "{}" carries nothing to echo.
    //
    // If a future client stops flattening this, the SQLSTATE becomes visible
    // and mapping it to the wall would be worth revisiting.
    const status = (error as { status?: number }).status;
    if (status === 429 || /rate limit/i.test(error.message)) {
      return fail("rate_limited", "Too many attempts — please wait a moment and try again.", 429);
    }
    // Fixed copy, never `error.message`. GoTrue interpolates the submitted
    // address into some of its validation errors (e.g. `Email address "x@y.com"
    // is invalid`), and our EMAIL_RE is looser than its own — so this branch is
    // genuinely reachable and would otherwise reflect the member's email back
    // into the page. Guardrail: never echo a raw Supabase error to the UI.
    return fail("validation_failed", "Please check your details and try again.", 400);
  }

  // note: reads below assume signup auto-confirms in this env (no
  // email-confirmation step), so a session — and therefore these rows — are
  // available immediately. If confirmation is ever turned on, these can be
  // null; we still return 201 with this shape.
  const userId = data.user?.id;
  const { data: subscriber } = userId
    ? await sb.from("app_user").select("id,first_name,last_name,name,email").eq("id", userId).maybeSingle()
    : { data: null };
  const { data: subscription } = userId
    ? await sb.from("subscription").select("status,trial_ends_at").eq("user_id", userId).maybeSingle()
    : { data: null };

  // Envelope shape unchanged. The FALLBACK moved from "trial" to "lapsed":
  // ENG-999 dropped 'trial' from subscription_status_check entirely, so the old
  // default named a status the database can no longer hold. `trial_ends_at`
  // survives as a nullable vestige and is still read here rather than dropped,
  // because the key is part of the published 201 shape.
  return created({
    subscriber,
    subscription: {
      status: subscription?.status ?? "lapsed",
      trialEndsAt: subscription?.trial_ends_at ?? null,
    },
  });
}
