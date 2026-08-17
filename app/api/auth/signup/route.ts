import { supabaseServer } from "@/lib/supabase/server";
import { created, fail } from "@/lib/api/envelope";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;
// AU postcode: exactly four digits, stored as text so '0800' survives. Never
// parseInt it, and never widen this to accept 'VIC 3000' — the DB has a
// matching CHECK constraint (app_user_postcode_au) that would reject it anyway.
const POSTCODE_RE = /^\d{4}$/;

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

// POST /api/auth/signup — the ONLY creation path for a new subscriber. Anon
// signUp; the DB trigger handle_new_user() provisions app_user + a 30-day
// trial subscription. Never a second creation path, never the service role.
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
  const looksLikeDuplicate =
    (error && /already registered/i.test(error.message)) ||
    (!error && data?.user && Array.isArray(data.user.identities) && data.user.identities.length === 0);
  if (looksLikeDuplicate) {
    return fail("email_taken", "That email is already registered.", 409);
  }

  if (error) {
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

  return created({
    subscriber,
    subscription: {
      status: subscription?.status ?? "trial",
      trialEndsAt: subscription?.trial_ends_at ?? null,
    },
  });
}
