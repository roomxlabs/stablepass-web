import HomeSections from "./sections";

/**
 * `/` — the public marketing home.
 *
 * This route replaces the old app/page.tsx, which redirected every visitor to
 * /signin and left the product with no public page at all. The signed-in
 * visitor's redirect to /explore moves to middleware.ts in W5 (ENG-591); until
 * that lands on the integration branch a signed-in visitor to / sees marketing,
 * which ENG-587 decision 4 accepts.
 *
 * Nav and footer come from the layout, so the legal routes W4 adds get the same
 * shell for free. Nothing here touches Supabase.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS PAGE READS `searchParams`, AND WHY THAT IS THE POINT (ENG-729)
 *
 * Reading `searchParams` opts `/` out of static prerendering and into a
 * per-request render. That is a deliberate decision this ticket makes, not an
 * accident — ENG-726 left it as the open call, in the prop seam on
 * `WaitlistForm` and in `.rx/gotchas.md`.
 *
 * The reason: ENG-721 decision 5 says the capture form must work with scripting
 * off, because the client reviews this site on a phone with JS blocked. With no
 * JS the browser submits the form natively and `/api/waitlist` answers
 * `303 → /?joined=1`. A statically prerendered page cannot vary on its query
 * string — the same HTML is served for `/` and `/?joined=1` — so that redirect
 * would land the visitor back on an unchanged page with an empty form and no
 * acknowledgement that anything happened. For a flow whose entire product is
 * "we captured your address", silently looking like it failed is the worst
 * available outcome, and it would push a second duplicate submit.
 *
 * So the values are read here and threaded to both mounts, which renders the
 * confirmation into the HTML itself. With JS on, the component's own
 * client-side read of `window.location` still covers the same states, so the
 * two paths agree.
 *
 * Deliberately NOT `useSearchParams()` in the component: under static rendering
 * that hook forces a Suspense bailout whose fallback is exactly the blank the
 * no-JS visitor must not see.
 *
 * ── CONSEQUENCE FOR W4 (ENG-730), which is blocked on this ticket ────────────
 * W4's spec plans `export const revalidate = 300` on this page for the live
 * trainer read. Route-level ISR and a request-varying page are mutually
 * exclusive, so W4 must cache the DATA rather than the ROUTE — wrap the
 * `public_trainer` read in `unstable_cache(fn, keys, { revalidate: 300 })` (or
 * a `fetch` with `next: { revalidate: 300 }`). Same 5-minute freshness, and it
 * is the more precise tool anyway: it caches the thing that is expensive
 * instead of the whole document. Recorded on ENG-730.
 */
export default async function MarketingHome({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;

  // `?joined=1&joined=0` is a repeated key, which Next hands over as an array.
  // Take the first and let the component's own mapping reject anything that is
  // not "1" or "0" — this layer decides nothing about meaning.
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? null;

  return <HomeSections joined={first(params.joined)} reason={first(params.reason)} />;
}
