"use client";

// CheckoutForm — the interactive half of the Checkout screen (04-checkout.html).
// Layout/classes are the mockup's, unchanged; only the copy and the GST line
// move for the non-renewing 30-day pass.
//
// On mount, POSTs /api/subscription/checkout, which returns a clientSecret plus
// the live price (`unitAmount`/`currency`) and a `mode`:
//  - "purchase" — first pass / lapsed return (Stripe Subscription, pre-cancelled)
//  - "renewal"  — an active member paying early (one-off PaymentIntent); the
//                 header explains the extension using the route's authoritative
//                 dates rather than recomputing them here.
//
// EVERY amount on this screen is formatted from `unitAmount`/`currency` — there
// is deliberately no currency symbol and no price literal anywhere in this file.
// The sandbox price is A$1.00 and production is A$19.00; a hardcode would make
// the screen claim one number while Stripe charges another.
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

type CheckoutMode = "purchase" | "renewal";

type Pricing = {
  unitAmount: number;
  currency: string;
  mode: CheckoutMode;
  currentPeriodEnd: string | null;
  newPeriodEnd: string | null;
};

type CheckoutState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "ready"; clientSecret: string; publishableKey: string };

// A$ rather than a bare $ — an en-AU locale renders AUD as the local "$19.00",
// which is ambiguous on an international card screen. Formatting AUD from en-US
// yields the unambiguous "A$19.00" the design calls for.
export function formatMoney(unitAmount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(unitAmount / 100);
}

// AU prices are GST-INCLUSIVE, so the GST component of a tax-inclusive amount is
// amount / 11 (i.e. 10% of the ex-GST base), rounded to the nearest cent.
// No Stripe Tax; this is a display-only breakdown of the same total.
export function gstComponent(unitAmount: number): number {
  return Math.round(unitAmount / 11);
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "long", year: "numeric" }).format(new Date(ms));
}

function OrderSummary({ pricing }: { pricing: Pricing | null }) {
  const total = pricing ? formatMoney(pricing.unitAmount, pricing.currency) : "—";
  const gst = pricing ? formatMoney(gstComponent(pricing.unitAmount), pricing.currency) : "—";

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
        <span>30 days of full access</span>
        <span>{total}</span>
      </div>
      <div className="summary-line">
        <span>Includes GST</span>
        <span>{gst}</span>
      </div>
      <div className="summary-line total">
        <span>Total today</span>
        <span>{total}</span>
      </div>

      <div className="trial-callout">
        <strong>One payment, 30 days.</strong>
        It does not renew — we&rsquo;ll never charge you again unless you choose to.
      </div>
    </div>
  );
}

function CheckoutHeader({ trialDaysLeft, pricing }: { trialDaysLeft: number; pricing: Pricing | null }) {
  const isRenewal = pricing?.mode === "renewal";
  const endsOn = formatDate(pricing?.currentPeriodEnd ?? null);
  const extendsTo = formatDate(pricing?.newPeriodEnd ?? null);

  return (
    <>
      <a href="/explore" className="checkout-logo">
        <Wordmark className="checkout-logo-text" />
      </a>
      <div className="checkout-step">{isRenewal ? "Extend your access" : "Step 2 of 2 · Payment"}</div>
      <h1 className="checkout-h">Continue your access.</h1>
      {isRenewal && endsOn && extendsTo ? (
        <p className="checkout-sub">
          Your access currently ends {endsOn}. Paying now extends it to {extendsTo}.
        </p>
      ) : isRenewal ? (
        // Renewal with an unusable date (null/unparseable current_period_end).
        // Must NOT fall through to the trial copy — telling an active member
        // their "trial ends in 0 days" under an "Extend your access" heading is
        // worse than saying nothing about dates.
        <p className="checkout-sub">
          Paying now adds another 30 days to your access.
        </p>
      ) : (
        <p className="checkout-sub">
          Your 30-day trial ends in {trialDaysLeft} day{trialDaysLeft === 1 ? "" : "s"}. Get 30 days of full access to
          keep your stable, your follows, and your alerts going.
        </p>
      )}
    </>
  );
}

// Renders inside <Elements> — useStripe/useElements only work in that context.
function PayForm({ pricing }: { pricing: Pricing | null }) {
  const stripe = useStripe();
  const elements = useElements();
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onPay() {
    if (!stripe || !elements) return;
    setSubmitting(true);
    setError(null);
    // redirect:"if_required" keeps this inline (no hosted-checkout redirect
    // per .rx/guardrails.md #4); return_url is Stripe's required fallback for
    // payment methods that must leave the page.
    const { error: confirmError } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: `${window.location.origin}/explore` },
      redirect: "if_required",
    });
    if (confirmError) {
      setError(confirmError.message ?? "Payment failed. Please try again.");
      setSubmitting(false);
      return;
    }
    router.push("/explore");
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
        {/* Stays disabled from the first click: two concurrent renewal intents
            would compute the same new_period_end, so a double-submit is a real
            double-charge for one extension. No auto-retry re-POSTs /checkout. */}
        <button
          type="button"
          className="btn btn-primary btn-large btn-block"
          disabled={!stripe || submitting}
          onClick={onPay}
        >
          {submitting ? "Processing…" : <PayLabel pricing={pricing} />}
        </button>
      </div>
      <div className="checkout-secure">🔒 Secured by Stripe · PCI-DSS compliant</div>
    </>
  );
}

function PayLabel({ pricing }: { pricing: Pricing | null }) {
  if (!pricing) return <>Pay · 30 days</>;
  return <>Pay {formatMoney(pricing.unitAmount, pricing.currency)} · 30 days</>;
}

// No real Stripe keys in this environment (and the graceful-degradation state
// for any other checkout failure) — a complete, screenshot-able layout with a
// disabled Pay affordance instead of a live Payment Element.
function PaymentPlaceholder({ pricing }: { pricing: Pricing | null }) {
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
      <p style={{ fontSize: 13.5, color: "var(--muted)", margin: "0 0 20px", lineHeight: 1.55 }}>
        Secure payment — connect a Stripe key to enable checkout.
      </p>
      <div className="checkout-actions">
        <button type="button" className="btn btn-primary btn-large btn-block" disabled>
          <PayLabel pricing={pricing} />
        </button>
      </div>
      <div className="checkout-secure">🔒 Secured by Stripe · PCI-DSS compliant</div>
    </>
  );
}

export function CheckoutForm({ trialDaysLeft }: { trialDaysLeft: number }) {
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
      } catch {
        // A network failure must land on the placeholder, not leave the screen
        // stuck on "loading" forever with an unhandled rejection.
        if (!cancelled) setState({ status: "unavailable" });
        return;
      }
      if (cancelled) return;
      const body = await res.json().catch(() => null);
      const data = body?.data;

      if (typeof data?.unitAmount === "number" && typeof data?.currency === "string") {
        setPricing({
          unitAmount: data.unitAmount,
          currency: data.currency,
          mode: data.mode === "renewal" ? "renewal" : "purchase",
          currentPeriodEnd: data.currentPeriodEnd ?? null,
          newPeriodEnd: data.newPeriodEnd ?? null,
        });
      }

      if (!res.ok) {
        setState({ status: "unavailable" });
        return;
      }
      const clientSecret: string | undefined = data?.clientSecret;
      const publishableKey: string | undefined = data?.publishableKey;
      if (!clientSecret || !publishableKey) {
        setState({ status: "unavailable" });
        return;
      }
      setState({ status: "ready", clientSecret, publishableKey });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const readyPublishableKey = state.status === "ready" ? state.publishableKey : null;
  const stripePromise = useMemo(
    () => (readyPublishableKey ? loadStripe(readyPublishableKey) : null),
    [readyPublishableKey],
  );

  return (
    <div className="checkout-page">
      <div className="checkout-container">
        <div className="checkout-left">
          <CheckoutHeader trialDaysLeft={trialDaysLeft} pricing={pricing} />
          {state.status === "ready" && stripePromise ? (
            <Elements stripe={stripePromise} options={{ clientSecret: state.clientSecret }}>
              <PayForm pricing={pricing} />
            </Elements>
          ) : (
            <PaymentPlaceholder pricing={pricing} />
          )}
        </div>
        <OrderSummary pricing={pricing} />
      </div>
    </div>
  );
}
