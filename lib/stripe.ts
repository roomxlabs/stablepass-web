// Lazy Stripe client — `STRIPE_SECRET_KEY` is unset in dev/CI/build environments
// without real Stripe keys. Constructing `new Stripe(...)` at module scope throws
// during `next build`, so every subscription route calls this instead and treats
// `null` as "payment provider not configured" (502 stripe_unavailable).
import Stripe from "stripe";

export function getStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key);
}
