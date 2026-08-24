import { supabaseServer } from "@/lib/supabase/server";
import { created, fail } from "@/lib/api/envelope";
import { normalizePhone } from "@/lib/format/phone";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The repeat-signup wall (ENG-763, R22). ONE code and ONE message for both the
// phone hit and the email hit: the wall must not reveal which credential
// matched (resolved open question on the ticket), so the two branches are
// deliberately indistinguishable to the caller. The form keys its wall UI off
// the CODE, not this message.
const TRIAL_ALREADY_USED = "trial_already_used";
const TRIAL_ALREADY_USED_MESSAGE =
  "Looks like you've already had your free trial. Sign in to join stablepass.";
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

  // ---- the pre-signup wall (ENG-763) -------------------------------------
  // One free trial per phone number. This check is the ONLY thing that can tell
  // a member their number has already had a trial: ENG-742's backstop index
  // deliberately does NOT fail the signup, it degrades the duplicate phone to
  // NULL and issues the trial anyway, because `handle_new_user` is an AFTER
  // INSERT trigger on auth.users and anything it raises 500s the whole insert
  // and echoes the row back (the ENG-566 outage). Per stablepass-be's
  // docs/specs/api-contract.md: "a client cannot detect 'phone already used'
  // from the signup response" — so the wall lives here, before the account is
  // created, and `phone_in_use` is the documented supported signal.
  //
  // It is a DETERRENT, not a security control. GoTrue's /auth/v1/signup is
  // publicly reachable, so anyone willing to curl it directly walks straight
  // past this. Making it a real gate needs a verified phone (OTP at signup),
  // which is out of scope. Do not describe this as enforcement.
  //
  // The number is sent AS TYPED because the RPC normalises in its own body,
  // which is what keeps the comparison identical to the index's. normalizePhone
  // is only used to skip a pointless round trip: the RPC's contract is that
  // null/empty/garbage input returns false, so a value that normalises to null
  // can never be in use.
  if (normalizePhone(phone) !== null) {
    const { data: phoneTaken, error: rpcError } = await sb.rpc("phone_in_use", {
      p_phone: phone,
    });

    if (rpcError) {
      // Fail OPEN, by design (ticket decision): during a deploy skew where web
      // is ahead of the migration the RPC is missing (PGRST202) and walling
      // every signup would take the funnel down. The DB backstop still degrades
      // a duplicate phone to NULL, so the worst case is an extra trial, not a
      // duplicate phone in app_user.
      //
      // The error CODE only. Never the message, and never `phone`: PostgREST
      // forwards Postgres DETAIL verbatim and this endpoint handles PII.
      console.warn("[signup] phone_in_use unavailable, allowing signup:", rpcError.code);
    } else if (phoneTaken === true) {
      // Strict `=== true`. `.rpc()` returns `{ data: null, error }` on failure
      // and `sb` is untyped, so a truthiness test here would wall a legitimate
      // signup on any shape we did not expect. Only an explicit boolean true
      // from the database closes this door.
      return fail(TRIAL_ALREADY_USED, TRIAL_ALREADY_USED_MESSAGE, 409);
    }
  }

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
    // Was `email_taken`. An address that already has an account has, for this
    // product, already had its free trial, so it gets the SAME wall as a repeat
    // phone (ENG-763 decision 2) rather than a second, subtly different dead
    // end. The old code is gone rather than aliased: this BFF has exactly one
    // consumer, app/start/trial-start-form.tsx, and two codes meaning one thing
    // is how the two branches drift apart.
    return fail(TRIAL_ALREADY_USED, TRIAL_ALREADY_USED_MESSAGE, 409);
  }

  if (error) {
    // The race the pre-check cannot close: two signups with the same number in
    // flight at once both see `phone_in_use` false, and one loses the index.
    // On the CURRENT schema this branch is unreachable for that case, because
    // ENG-742's trigger catches exactly that unique violation and retries with
    // a NULL phone, so the signup SUCCEEDS and there is no error to inspect
    // (accepted behaviour: the loser keeps their trial, and their phone is not
    // stored). It is handled anyway because the alternative if that ever stops
    // holding — the trigger's exception scoping is pinned to the index NAME and
    // the migration flags it as a rename hazard — is a raw 500 on a signup.
    // The member gets the same friendly wall either way, never a stack trace.
    //
    // Matched on the index name and SQLSTATE, which api-contract.md documents
    // as the distinguishable signal (`23505`, message naming
    // `idx_app_user_phone`). The error is never forwarded: PostgREST echoes
    // Postgres DETAIL verbatim and that DETAIL contains the phone number
    // itself.
    const dbCode = (error as { code?: string }).code;
    if (dbCode === "23505" || /idx_app_user_phone/.test(error.message)) {
      return fail(TRIAL_ALREADY_USED, TRIAL_ALREADY_USED_MESSAGE, 409);
    }

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
