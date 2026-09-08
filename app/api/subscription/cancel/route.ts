// POST /api/subscription/cancel — the member's "I'm done" control (ENG-1002,
// Stripe-first as of ENG-1028).
//
// ─────────────────────────────────────────────────────────────────────────────
// THIS ROUTE MUST GO THROUGH THE RPC. IT MUST NOT `.from("subscription").update()`.
//
// `public.subscription` exposes only SELECT policies to `authenticated` —
// guardrail 2 in stablepass-be, restated by ENG-999's migration: "subscription
// writes are service-role only; there is no authenticated write policy and none
// is added here". A `.update()` from this route's RLS-scoped client therefore
// matches ZERO ROWS AND RETURNS NO ERROR. It looks like a success, the response
// is a 200, and nothing has been written. ENG-582 spent an entire ticket
// discovering exactly that in the checkout route, on this exact table.
//
// `cancel_own_subscription()` is the single deliberate exception: a
// SECURITY DEFINER function that self-scopes with `where user_id = auth.uid()`
// and takes NO user-id parameter. That shape is the authorisation — which is
// why this route sends only `p_reason` and never an id. A definer function that
// accepted one would let any member cancel any other member's subscription.
//
// ─────────────────────────────────────────────────────────────────────────────
// STRIPE FIRST, THEN THE RPC (ENG-1028). The subscription now auto-renews, so
// cancelling only our row leaves Stripe charging. The order is load-bearing:
//
//   1. stripe.subscriptions.update(id, { cancel_at_period_end: true })
//   2. sb.rpc("cancel_own_subscription", { p_reason })
//
// If Stripe fails we return 502 and have written nothing — the member is still
// subscribed and still billed, which is true and recoverable. The reverse
// order can leave our row `canceled` while Stripe bills on.
//
// No `stripe_subscription_id` → skip Stripe (do not throw) and still run the
// RPC. The webhook later receives `customer.subscription.updated` and writes
// the same state (R2). That duplication is intended; do not remove either
// writer.
//
// `cancel_reason` is UNTRUSTED MEMBER TEXT. It is validated for length here,
// stored as text by the RPC, and never rendered — not by this response (which
// deliberately does not echo it back) and not anywhere in this app.
import { getStripe } from "@/lib/stripe";
import { supabaseServer } from "@/lib/supabase/server";
import { ok, UNAUTH, fail } from "@/lib/api/envelope";

/**
 * Mirrors `subscription_cancel_reason_len` on the column. The DB CHECK is the
 * backstop — it raises 23514 rather than truncating — and this is the
 * validator, so an over-long reason is a clean 400 and nothing is written.
 */
export const MAX_REASON_LENGTH = 500;

// PostgREST surfaces the RPC's `raise ... using errcode = '42501'` as this.
//
// ⚠️ The code ALONE is not enough to identify it. `42501` is
// `insufficient_privilege` generally — if a future migration ever dropped
// `grant execute on function cancel_own_subscription to authenticated`, the
// resulting "permission denied for function" would arrive with the SAME code,
// and mapping it to 409 would tell every member they have no active
// subscription while the real fault was a broken grant. So the RPC's own
// message is matched too, and anything else falls through to the 500 below —
// loud, which is what a broken grant should be. `e2e/eng-1002-cancel.spec.ts`
// asserts the 409 against the real PostgREST, so a drift in this message
// surfaces as a failing test rather than as a silently wrong status.
const NO_ACTIVE_SUBSCRIPTION_CODE = "42501";
const NO_ACTIVE_SUBSCRIPTION_MESSAGE = "no_active_subscription";

function stripeCancelFailed() {
  // A fresh Response each time — a module-scope NextResponse can only be
  // read once, so reusing one 502 would 500 the second caller.
  return fail(
    "stripe_error",
    "Couldn't cancel your subscription. Please try again.",
    502,
  );
}

export async function POST(req: Request) {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return UNAUTH();

  // A body is optional in every sense: no body at all, `{}`, and `{reason:null}`
  // are all "cancel, no comment". Only a PRESENT reason is validated.
  const body = await req.json().catch(() => null);
  const raw = (body as { reason?: unknown } | null)?.reason;

  let reason: string | null = null;
  if (raw !== undefined && raw !== null) {
    // Anything that is not a string is a malformed request, not an empty
    // comment — fail closed rather than cancelling while silently discarding
    // whatever the caller thought they were sending.
    if (typeof raw !== "string") {
      return fail("validation_failed", "Reason must be text.", 400);
    }
    const trimmed = raw.trim();
    if (trimmed.length > MAX_REASON_LENGTH) {
      return fail(
        "validation_failed",
        `Please keep your comment to ${MAX_REASON_LENGTH} characters or fewer.`,
        400,
      );
    }
    // Whitespace-only is absent, so the RPC stores null rather than "". (It
    // applies the same `nullif(btrim(...), '')` itself — this keeps the two in
    // agreement and keeps the length check honest about what it measured.)
    reason = trimmed.length ? trimmed : null;
  }

  // SELECT only — never `.update()`. We need the Stripe id so we can tell
  // Stripe before we write our row. A missing row is the RPC's 409 to report.
  // A FAILED read must not skip Stripe: that would write our row while
  // Stripe keeps charging — the exact silent failure this ticket exists to
  // close. Fail closed; nothing has been written yet.
  const { data: subData, error: subReadError } = await sb
    .from("subscription")
    .select("stripe_subscription_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (subReadError && subReadError.code !== "PGRST116") {
    console.error(
      "[cancel] subscription read failed (%s) — refusing to cancel from a row we could not read: %s",
      subReadError.code ?? "no code",
      subReadError.message ?? String(subReadError),
    );
    return fail("cancel_failed", "Couldn't cancel your subscription. Please try again.", 500);
  }
  const stripeSubscriptionId =
    (subData as { stripe_subscription_id: string | null } | null)?.stripe_subscription_id ?? null;

  if (stripeSubscriptionId) {
    const stripe = getStripe();
    if (!stripe) return stripeCancelFailed();
    try {
      await stripe.subscriptions.update(stripeSubscriptionId, { cancel_at_period_end: true });
    } catch (err) {
      console.error(
        "[cancel] Stripe subscriptions.update failed — leaving the row untouched: %s",
        err instanceof Error ? err.message : String(err),
      );
      return stripeCancelFailed();
    }
  }

  // NO USER ID IN THIS CALL. See the header — `auth.uid()` inside the function
  // is the authorisation, and the cookie-scoped client is what supplies it.
  const { data, error } = await sb.rpc("cancel_own_subscription", { p_reason: reason });

  if (error) {
    // The RPC raises 42501 for all three denials indistinguishably: no row,
    // someone else's row, or an already-cancelled/lapsed one. 409 is the honest
    // status for the member — the request was well-formed and authenticated,
    // there is simply nothing active to cancel — where PostgREST's own 403 would
    // read as "you may not do this" and a 500 would read as our fault.
    if (
      error.code === NO_ACTIVE_SUBSCRIPTION_CODE &&
      (error.message ?? "").includes(NO_ACTIVE_SUBSCRIPTION_MESSAGE)
    ) {
      return fail("no_active_subscription", "You don't have an active subscription to cancel.", 409);
    }
    // Fixed copy, never `error.message`: a constraint violation echoes the
    // offending row back, and on this table that row is the member's own
    // free-text comment.
    return fail("cancel_failed", "Couldn't cancel your subscription. Please try again.", 500);
  }

  // The RPC `returns subscription`, i.e. the whole updated row. Only these three
  // fields cross the wire: `cancel_reason` is deliberately not echoed, and
  // Stripe ids / `intro_months_used` are none of the browser's business.
  const row = data as
    | { status: string; canceled_at: string | null; current_period_end: string | null }
    | null;
  // Not reachable today — the RPC either returns the composite row or raises —
  // but reading `.status` off a null would throw a bare TypeError, which Next
  // serves as an un-enveloped 500. One line keeps every response in the
  // contract's shape.
  if (!row) return fail("cancel_failed", "Couldn't cancel your subscription. Please try again.", 500);

  return ok({
    status: row.status,
    canceledAt: row.canceled_at,
    currentPeriodEnd: row.current_period_end,
  });
}
