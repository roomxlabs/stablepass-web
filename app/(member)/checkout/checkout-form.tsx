"use client";

// CheckoutForm — the interactive half of the Checkout screen (04-checkout.html).
// On mount, POSTs /api/subscription/checkout to create/reuse the Stripe Customer
// + an incomplete Subscription and get back a clientSecret (.rx/guardrails.md
// #4 — the card never touches our server; the BFF only creates Stripe objects
// and returns the secret). Three render states:
//  - already active (409 already_active) → "you're already subscribed" + a
//    link back to /account
//  - Stripe unconfigured / any failure / a 200 missing clientSecret+
//    publishableKey (the no-real-Stripe-keys case in this environment) → the
//    full checkout layout with a graceful, disabled placeholder in the payment
//    slot so the screen is still complete and screenshot-able
//  - success → mounts <Elements>+<PaymentElement>, confirms inline
//    (no hosted redirect flow) and routes to /explore on success
// No raw card fields are ever posted to any /api/* route — Stripe Elements owns
// the card input; we only exchange a clientSecret with Stripe directly.
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";

type CheckoutState =
  | { status: "loading" }
  | { status: "already-active" }
  | { status: "unavailable" }
  | { status: "ready"; clientSecret: string; publishableKey: string };

const PRICE_LABEL = "AU$19.00";

function OrderSummary() {
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
        <span>{PRICE_LABEL}</span>
      </div>
      <div className="summary-line">
        <span>GST</span>
        <span>-</span>
      </div>
      <div className="summary-line total">
        <span>Total today</span>
        <span>{PRICE_LABEL}</span>
      </div>

      <div className="trial-callout">
        <strong>Cancel anytime.</strong>
        Your subscription renews monthly until you cancel. Cancellation takes effect at the end of the current
        billing period.
      </div>
    </div>
  );
}

function CheckoutHeader({ trialDaysLeft }: { trialDaysLeft: number }) {
  return (
    <>
      <a href="/explore" className="checkout-logo">
        <span className="checkout-logo-text">stablepass.</span>
      </a>
      <div className="checkout-step">Step 2 of 2 · Payment</div>
      <h1 className="checkout-h">Continue your access.</h1>
      <p className="checkout-sub">
        Your 30-day trial ends in {trialDaysLeft} day{trialDaysLeft === 1 ? "" : "s"}. Subscribe now to keep your
        stable, your follows, and your alerts going.
      </p>
    </>
  );
}

// Renders inside <Elements> — useStripe/useElements only work in that context.
function PayForm() {
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
    // per .rx/gotchas.md "Stripe is embedded"); return_url is Stripe's
    // required fallback for payment methods that must leave the page.
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
        <button
          type="button"
          className="btn btn-primary btn-large btn-block"
          disabled={!stripe || submitting}
          onClick={onPay}
        >
          {submitting ? "Processing…" : `Subscribe · ${PRICE_LABEL}/month`}
        </button>
      </div>
      <div className="checkout-secure">🔒 Secured by Stripe · PCI-DSS compliant</div>
    </>
  );
}

// No real Stripe keys in this environment (and the graceful-degradation state
// for any other checkout failure) — a complete, screenshot-able layout with a
// disabled Pay affordance instead of a live Payment Element.
function PaymentPlaceholder() {
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
          Subscribe · {PRICE_LABEL}/month
        </button>
      </div>
      <div className="checkout-secure">🔒 Secured by Stripe · PCI-DSS compliant</div>
    </>
  );
}

export function CheckoutForm({ trialDaysLeft }: { trialDaysLeft: number }) {
  const [state, setState] = useState<CheckoutState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/subscription/checkout", { method: "POST" });
      if (cancelled) return;
      if (res.status === 409) {
        setState({ status: "already-active" });
        return;
      }
      if (!res.ok) {
        setState({ status: "unavailable" });
        return;
      }
      const body = await res.json().catch(() => null);
      const clientSecret: string | undefined = body?.data?.clientSecret;
      const publishableKey: string | undefined = body?.data?.publishableKey;
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

  if (state.status === "already-active") {
    return (
      <div className="checkout-page">
        <div className="checkout-container" style={{ gridTemplateColumns: "1fr" }}>
          <div className="checkout-left">
            <a href="/explore" className="checkout-logo">
              <span className="checkout-logo-text">stablepass.</span>
            </a>
            <h1 className="checkout-h">You&rsquo;re already subscribed.</h1>
            <p className="checkout-sub">Your membership is active — there&rsquo;s nothing to do here.</p>
            <a href="/account" className="btn btn-primary btn-large">
              Go to account
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="checkout-page">
      <div className="checkout-container">
        <div className="checkout-left">
          <CheckoutHeader trialDaysLeft={trialDaysLeft} />
          {state.status === "ready" && stripePromise ? (
            <Elements stripe={stripePromise} options={{ clientSecret: state.clientSecret }}>
              <PayForm />
            </Elements>
          ) : (
            <PaymentPlaceholder />
          )}
        </div>
        <OrderSummary />
      </div>
    </div>
  );
}
