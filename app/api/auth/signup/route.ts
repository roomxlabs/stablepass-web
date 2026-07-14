import { supabaseServer } from "@/lib/supabase/server";
import { created, fail } from "@/lib/api/envelope";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

// POST /api/auth/signup — the ONLY creation path for a new subscriber. Anon
// signUp; the DB trigger handle_new_user() provisions app_user + a 30-day
// trial subscription. Never a second creation path, never the service role.
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  const phone = typeof body?.phone === "string" ? body.phone.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (!name || !email || !phone || !password) {
    return fail("validation_failed", "Name, email, phone and password are all required.", 400);
  }
  if (!EMAIL_RE.test(email)) {
    return fail("validation_failed", "Enter a valid email address.", 400);
  }
  if (password.length < MIN_PASSWORD) {
    return fail("validation_failed", `Password must be at least ${MIN_PASSWORD} characters.`, 400);
  }

  const sb = await supabaseServer();
  const { data, error } = await sb.auth.signUp({
    email,
    password,
    options: { data: { name, phone } },
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
    return fail("validation_failed", error.message, 400);
  }

  // note: reads below assume signup auto-confirms in this env (no
  // email-confirmation step), so a session — and therefore these rows — are
  // available immediately. If confirmation is ever turned on, these can be
  // null; we still return 201 with this shape.
  const userId = data.user?.id;
  const { data: subscriber } = userId
    ? await sb.from("app_user").select("id,name,email").eq("id", userId).maybeSingle()
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
