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
 * shell for free. Nothing here touches Supabase, which keeps the page static.
 */
export default function MarketingHome() {
  return <HomeSections />;
}
