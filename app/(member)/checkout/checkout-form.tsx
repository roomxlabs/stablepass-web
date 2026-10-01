"use client";

// CheckoutForm — the interactive half of the Checkout screen (04-checkout.html).
// Layout/classes are the mockup's. Recurring + price-change copy has no backing
// mockup language on the one-off pass version the ticket cited; compose from
// `.trial-banner-web` (the established informational band) plus the mockup's
// existing `.trial-callout`. Flagged on the PR as a design gap.
//
// On mount, POSTs /api/subscription/checkout, which returns a clientSecret, its
// `intentType` ("setup" to save the card for a free trial, "payment"
// otherwise), the live
// list price (`unitAmount`/`currency`), what Stripe says is due today
// (`amountDueNow` — A$0.00 on a trial), `trialEndsAt`, and `mode: "subscribe"`.
// There is no `renewal` mode — an active member is redirected to /account.
// Trial eligibility is decided by the route from the member's own row; this
// screen only displays the outcome (Pricing v2, ENG-1328).
//
// A trial is CARD FIRST: after `confirmSetup` saves the card, this screen POSTs
// the same route again and the route starts the trial Subscription on that card
// (`started: true`). A load that finds the card already saved (a redirect-based
// method returning to `/checkout?setup=1`, or a tab closed mid-way) gets
// `started: true` straight away and goes on to /explore the same way.
//
// EVERY amount on this screen is formatted from the route's numbers — there is
// deliberately no currency symbol and no price literal anywhere in this file.
// A hardcode here would make the screen claim one number while Stripe charges
// another.
//
// `trialEndsAt` / `priceChangesOn` are DISPLAY ONLY. They arrive on the
// response; they are never sent back. `priceChangesOn` is always null and is
// ignored: after a trial the price is flat, there is no change-over date.
// Nothing this file posts can influence what the member is charged (the route
// takes no request body at all).
//
// .rx/guardrails.md #4 — the card never touches our server: Stripe Elements owns
// the card input and we only exchange a clientSecret with Stripe directly. No
// raw card field is ever posted to any /api/* route, and there is no hosted
// checkout redirect and no billing portal.
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { Wordmark } from "@/components/wordmark";
import { goToExploreAfterPay, waitForEntitled } from "@/lib/api/wait-for-access";

type Pricing = {
  unitAmount: number;
  currency: string;
  amountDueNow: number;
  // Set only while the route started (or reused) a free trial.
  trialEndsAt: string | null;
};

type IntentType = "payment" | "setup";

// The not-ready states are deliberately SPLIT. They used to be one
// ("unavailable") rendering one hardcoded line — "connect a Stripe key to enable
// checkout" — for every possible failure. When the route started returning 200
// with a null clientSecret (ENG-581), that copy told a correctly-configured
// operator their key was missing and sent them hunting a misconfiguration that
// did not exist. A configuration hint must therefore be shown ONLY when the
// server actually reported "no payment provider configured".
type CheckoutState =
  | { status: "loading" }
  // 502 stripe_unavailable — the designed degradation for a genuinely absent
  // STRIPE_SECRET_KEY. This is the ONLY state that may mention configuration.
  | { status: "unconfigured" }
  // Anything else: the call succeeded (or failed unexpectedly) but we have no
  // usable secret. That is a real error, not an environment hint — and it is
  // always logged, because rendering a dead Pay button silently is what hid the
  // original bug for weeks.
  | { status: "error" }
  | { status: "ready"; clientSecret: string; publishableKey: string; intentType: IntentType }
  // The route has started the trial on an already-saved card: wait for the
  // webhook to grant access, then go to /explore.
  | { status: "starting" };

// A$ rather than a bare $ — an en-AU locale renders AUD as the local "$19.00",
// which is ambiguous on an international card screen. Formatting AUD from en-US
// yields the unambiguous "A$19.00" the design calls for.
export function formatMoney(unitAmount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(unitAmount / 100);
}

// "23 October 2026" in the member's (Sydney) day — the same convention as the
// Account screen. Null for an unusable input, and the copy then omits the date
// rather than printing a wrong one.
export function formatTrialEnd(iso: string | null): string | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return null;
  return new Date(ts).toLocaleDateString("en-AU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Australia/Sydney",
  });
}

// AU prices are GST-INCLUSIVE, so the GST component of a tax-inclusive amount is
// amount / 11 (i.e. 10% of the ex-GST base), rounded to the nearest cent.
// No Stripe Tax; this is a display-only breakdown of the same total.
export function gstComponent(unitAmount: number): number {
  return Math.round(unitAmount / 11);
}

function OrderSummary({ pricing }: { pricing: Pricing | null }) {
  const list = pricing ? formatMoney(pricing.unitAmount, pricing.currency) : "—";
  const today = pricing ? formatMoney(pricing.amountDueNow, pricing.currency) : "—";
  const gst = pricing ? formatMoney(gstComponent(pricing.amountDueNow), pricing.currency) : "—";
  const onTrial = pricing?.trialEndsAt != null;
  const trialEnd = formatTrialEnd(pricing?.trialEndsAt ?? null);

  return (
    <div className="checkout-right">
      <div className="summary-h">Order summary</div>
      <div className="summary-product">
        <div className="label">stablepass membership</div>
        <div className="name">Full access</div>
        <div className="description">
          Every horse, every trainer, every update - across web, iOS and Android.
        </div>
      </div>

      <div className="summary-line">
        <span>Subscription · monthly</span>
        <span>{list}</span>
      </div>
      {onTrial ? (
        <div className="summary-line" data-testid="summary-trial">
          <span>Free trial</span>
          <span>{trialEnd ? `Until ${trialEnd}` : "Included"}</span>
        </div>
      ) : null}
      <div className="summary-line">
        <span>Includes GST</span>
        <span>{gst}</span>
      </div>
      <div className="summary-line total">
        <span>Total today</span>
        <span>{today}</span>
      </div>

      <div className="trial-callout">
        <strong>Cancel anytime.</strong>
        {onTrial
          ? `Nothing is charged today. Your first ${list} charge is ${trialEnd ? `on ${trialEnd}` : "when your free trial ends"}, then ${list} every month until you cancel. Cancel before then and you won't be charged.`
          : "Your subscription renews monthly until you cancel. Cancellation takes effect at the end of the current billing period."}
      </div>
    </div>
  );
}

// The free-trial / standard-pricing band.
//
// DESIGN NOTE: the ticket's cited mockup had no recurring-price treatment.
// Rather than invent a component, this composes the screen family's
// established informational band, `.trial-banner-web` (soft green fill, green
// left rule) with its `.trial-label` eyebrow and `.trial-detail` body. Those
// two child classes are SCOPED — the rules are `.trial-banner-web .trial-label`,
// not bare class selectors — so they must stay nested inside the parent or they
// render as unstyled browser defaults. Same pattern as the start wall and the
// expiry banner. No new CSS, no new colour, no new radius.
//
// Eligibility is per StablePass account only, so this copy says what THIS
// checkout does and makes no promise about trials elsewhere.
function RecurringBand({ pricing }: { pricing: Pricing | null }) {
  if (!pricing) return null;
  const today = formatMoney(pricing.amountDueNow, pricing.currency);
  const list = formatMoney(pricing.unitAmount, pricing.currency);

  if (pricing.trialEndsAt != null) {
    const trialEnd = formatTrialEnd(pricing.trialEndsAt);
    return (
      <div className="trial-banner-web" data-testid="pricing-band">
        <div className="trial-label">Free trial</div>
        <div className="trial-detail">
          {today} today. Free until {trialEnd ?? "your trial ends"}, then {list} per month until you cancel.
        </div>
      </div>
    );
  }

  return (
    <div className="trial-banner-web" data-testid="pricing-band">
      <div className="trial-label">Monthly membership</div>
      <div className="trial-detail">
        {today} today, then {list} per month until you cancel.
      </div>
    </div>
  );
}

function CheckoutHeader() {
  return (
    <>
      <a href="/explore" className="checkout-logo">
        <Wordmark className="checkout-logo-text" />
      </a>
      <div className="checkout-step">Step 2 of 2 · Payment</div>
      <h1 className="checkout-h">Continue your access.</h1>
      <p className="checkout-sub">
        Subscribe now to keep your stable, your follows, and your alerts going.
      </p>
    </>
  );
}

// Renders inside <Elements> — useStripe/useElements only work in that context.
function PayForm({ pricing, intentType }: { pricing: Pricing | null; intentType: IntentType }) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onPay() {
    if (!stripe || !elements) return;
    setSubmitting(true);
    setError(null);
    // redirect:"if_required" keeps this inline (no hosted-checkout redirect
    // per .rx/guardrails.md #4); return_url is Stripe's required fallback for
    // payment methods that must leave the page. `?paid=1` tells Explore to
    // keep waiting for the webhook if this confirm has to redirect.
    //
    // A free-trial start hands us a SetupIntent (nothing is charged today; the
    // card is saved for the first charge when the trial ends), which only
    // `confirmSetup` accepts — `confirmPayment` rejects a `seti_…` secret.
    //
    // A saved-card trial that must leave the page comes back to /checkout, whose
    // on-mount POST then starts the trial (a payment returns to /explore).
    const { error: confirmError } =
      intentType === "setup"
        ? await stripe.confirmSetup({
            elements,
            confirmParams: { return_url: `${window.location.origin}/checkout?setup=1` },
            redirect: "if_required",
          })
        : await stripe.confirmPayment({
            elements,
            confirmParams: { return_url: `${window.location.origin}/explore?paid=1` },
            redirect: "if_required",
          });
    if (confirmError) {
      setError(confirmError.message ?? "Payment failed. Please try again.");
      setSubmitting(false);
      return;
    }
    if (intentType === "setup") {
      // The card is saved; nothing is charged. Now ask the route to start the
      // trial on it. Anything but `started: true` leaves the member here with an
      // error — never on /explore without a trial behind them.
      let started = false;
      try {
        const res = await fetch("/api/subscription/checkout", { method: "POST" });
        const body = await res.json().catch(() => null);
        // 409 already_active here means a trial IS already running on this
        // member (a second tab or a double click started it first) — the same
        // outcome, so it proceeds exactly like `started: true`.
        started =
          (res.ok && body?.data?.started === true) ||
          (res.status === 409 && body?.error?.code === "already_active");
        if (!started) {
          console.error("[checkout] trial start after confirmSetup returned %s (code: %s)", res.status, body?.error?.code ?? "none");
        }
      } catch (err) {
        console.error("[checkout] trial start after confirmSetup failed", err);
      }
      if (!started) {
        setError("Your card was saved, but we couldn't start your free trial. Nothing has been charged — please refresh to try again.");
        setSubmitting(false);
        return;
      }
    }
    // Confirmed means Stripe charged the card (or, on a trial, the trial has
    // started on the saved card). Access is granted only
    // after stripe-webhook writes the row — jumping to /explore now shows
    // the wall until a later hard refresh. Wait, then hard-navigate.
    await waitForEntitled();
    goToExploreAfterPay();
  }

  return (
    <>
      <div className="input-group" data-testid="payment-element-slot">
        <PaymentElement />
      </div>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="checkout-actions">
        <button
          type="button"
          className="btn btn-primary btn-large btn-block"
          disabled={!stripe || submitting}
          onClick={onPay}
        >
          {submitting ? "Unlocking…" : <PayLabel pricing={pricing} />}
        </button>
      </div>
      <div className="checkout-secure">🔒 Secured by Stripe · PCI-DSS compliant</div>
    </>
  );
}

function PayLabel({ pricing }: { pricing: Pricing | null }) {
  if (!pricing) return <>Subscribe</>;
  if (pricing.trialEndsAt != null) {
    return <>Start free trial · {formatMoney(pricing.amountDueNow, pricing.currency)} today</>;
  }
  return <>Subscribe · {formatMoney(pricing.amountDueNow, pricing.currency)}</>;
}

// The not-ready payment slot — a complete, screenshot-able layout with a
// disabled Pay affordance instead of a live Payment Element. The layout is the
// mockup's (04-checkout.html) in every variant; only the message block changes,
// so the screen never jumps between states.
// Derived from CheckoutState rather than restated, so adding a fourth state is a
// compile error here instead of a silently-mismapped placeholder.
type PlaceholderVariant = Exclude<CheckoutState["status"], "ready">;

function PaymentNotice({ variant }: { variant: PlaceholderVariant }) {
  if (variant === "error") {
    // Uses the design system's existing .form-error (red rule + red text) rather
    // than a bespoke style, and role="alert" so it is announced — this is a real
    // failure, not a passive hint. Deliberately says NOTHING about keys or
    // configuration: the key is fine, the payment could not be started.
    return (
      <div className="form-error" role="alert">
        We couldn&rsquo;t start a secure payment. Nothing has been charged — please refresh to try again, and contact
        support if it keeps happening.
      </div>
    );
  }

  const message =
    variant === "starting"
      ? "Starting your free trial…"
      : variant === "unconfigured"
      ? // The genuinely-absent-key degradation (route said 502 stripe_unavailable).
        // Deliberately free of dev-speak: if a production key were ever missing a
        // paying member reads this, and "this environment" means nothing to them.
        // The operator gets the specifics from the console log + the 502 code.
        "Payments are not configured yet. Please try again shortly."
      : "Preparing secure payment…";

  return (
    <p style={{ fontSize: 13.5, color: "var(--muted)", margin: "0 0 20px", lineHeight: 1.55 }}>{message}</p>
  );
}

function PaymentPlaceholder({ pricing, variant }: { pricing: Pricing | null; variant: PlaceholderVariant }) {
  return (
    <>
      <div className="input-group">
        <label className="input-label">Pay with</label>
        <div className="payment-method-row">
          <div className="pm-card selected">
            <div className="pm-card-icon">💳</div>
            Card
          </div>
        </div>
      </div>
      <PaymentNotice variant={variant} />
      <div className="checkout-actions">
        <button type="button" className="btn btn-primary btn-large btn-block" disabled>
          <PayLabel pricing={pricing} />
        </button>
      </div>
      <div className="checkout-secure">🔒 Secured by Stripe · PCI-DSS compliant</div>
    </>
  );
}

export function CheckoutForm() {
  const router = useRouter();
  const [state, setState] = useState<CheckoutState>({ status: "loading" });
  // Held separately from `state` so the order summary keeps showing the real
  // price even when the payment slot degrades to the placeholder.
  const [pricing, setPricing] = useState<Pricing | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let res: Response;
      try {
        res = await fetch("/api/subscription/checkout", { method: "POST" });
      } catch (err) {
        // A network failure must land on the placeholder, not leave the screen
        // stuck on "loading" forever with an unhandled rejection. It is an
        // error, NOT a configuration problem — the server was never reached, so
        // we know nothing about whether a key is present.
        console.error("[checkout] request to /api/subscription/checkout failed", err);
        if (!cancelled) setState({ status: "error" });
        return;
      }
      if (cancelled) return;
      const body = await res.json().catch(() => null);
      const data = body?.data;

      if (typeof data?.unitAmount === "number" && typeof data?.currency === "string") {
        setPricing({
          unitAmount: data.unitAmount,
          currency: data.currency,
          amountDueNow: typeof data.amountDueNow === "number" ? data.amountDueNow : data.unitAmount,
          // Type-checked rather than `?? null`: only a real string means a trial.
          trialEndsAt: typeof data.trialEndsAt === "string" ? data.trialEndsAt : null,
        });
      }

      if (res.ok && data?.started === true) {
        // The card was already saved and the route has just started the trial
        // on it. Nothing to confirm — wait for access, then go.
        setState({ status: "starting" });
        await waitForEntitled();
        if (!cancelled) goToExploreAfterPay();
        return;
      }

      if (!res.ok) {
        const code: string | undefined = body?.error?.code;
        if (res.status === 409 && code === "already_active") {
          router.replace("/account");
          return;
        }
        // ONLY the route's designed "no payment provider configured" 502 earns
        // the configuration message (.rx/guardrails.md #4 keeps that
        // degradation working). Every other non-ok status is a real error.
        // `stripe_unavailable` means specifically "no STRIPE_SECRET_KEY". Stripe
        // outages / bad price ids now come back as `stripe_error` and fall
        // through to the error state below.
        if (res.status === 502 && code === "stripe_unavailable") {
          console.error("[checkout] payments are not configured (502 stripe_unavailable)");
          setState({ status: "unconfigured" });
          return;
        }
        console.error("[checkout] /api/subscription/checkout returned %s (code: %s)", res.status, code ?? "none");
        setState({ status: "error" });
        return;
      }
      const clientSecret: string | undefined = data?.clientSecret;
      const publishableKey: string | undefined = data?.publishableKey;
      if (!clientSecret || !publishableKey) {
        // 200 OK but nothing to pay with. This is ENG-581's exact signature —
        // the key was valid and Stripe answered, but the secret had moved to
        // `latest_invoice.confirmation_secret` and we read a field that no
        // longer exists. It must NOT render the configuration hint (that is what
        // sent the DRI chasing an env problem that did not exist), and it must
        // be logged, because a silently-dead Pay button is invisible in prod.
        console.error(
          "[checkout] 200 OK but no usable payment secret (clientSecret: %s, publishableKey: %s, mode: %s)",
          clientSecret ? "present" : "MISSING",
          publishableKey ? "present" : "MISSING",
          data?.mode ?? "unknown",
        );
        setState({ status: "error" });
        return;
      }
      // A SetupIntent secret must be confirmed with confirmSetup. Trust the
      // route's tag; fall back on Stripe's own `seti_` prefix if it is absent.
      const intentType: IntentType =
        data?.intentType === "setup" || (data?.intentType == null && clientSecret.startsWith("seti_"))
          ? "setup"
          : "payment";
      setState({ status: "ready", clientSecret, publishableKey, intentType });
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  const readyPublishableKey = state.status === "ready" ? state.publishableKey : null;
  const stripePromise = useMemo(
    () => (readyPublishableKey ? loadStripe(readyPublishableKey) : null),
    [readyPublishableKey],
  );

  return (
    <div className="checkout-page">
      <div className="checkout-container">
        <div className="checkout-left">
          <CheckoutHeader />
          <RecurringBand pricing={pricing} />
          {state.status === "ready" && stripePromise ? (
            <Elements stripe={stripePromise} options={{ clientSecret: state.clientSecret }}>
              <PayForm pricing={pricing} intentType={state.intentType} />
            </Elements>
          ) : (
            <PaymentPlaceholder
              pricing={pricing}
              // "loading" keeps the first paint neutral — flashing either an
              // error or a configuration hint while the POST is still in flight
              // would be a lie in both directions.
              // "ready" only lands here if loadStripe hasn't resolved a promise
              // yet, which is still a loading condition — never an error.
              variant={state.status === "ready" ? "loading" : state.status}
            />
          )}
        </div>
        <OrderSummary pricing={pricing} />
      </div>
    </div>
  );
}
