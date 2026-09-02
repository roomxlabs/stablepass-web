import { getMarketingTrainers } from "@/lib/marketing/trainers";

import HomeSections from "./sections";
import { TRAINERS } from "./sections/trainers.data";

/**
 * ISR: the page is otherwise static, but the trainer strip now reads the
 * admin-driven `public_trainer` view (ENG-766). Revalidate every 5 minutes so a
 * stable toggling "Show on marketing site" appears without a redeploy. The read
 * itself falls back to the static list, so a failed revalidation is invisible.
 */
export const revalidate = 300;

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
 * shell for free. The trainer strip is the one admin-driven part: this reads the
 * marketing-visible trainers server-side (under ISR) and falls back to the static
 * list, so a backend failure leaves the signed-off page intact.
 */
export default async function MarketingHome({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const live = await getMarketingTrainers();
  const params = (await searchParams) ?? {};
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;
  return (
    <HomeSections
      trainers={live.length > 0 ? live : TRAINERS}
      joined={one(params.joined)}
      reason={one(params.reason)}
    />
  );
}
