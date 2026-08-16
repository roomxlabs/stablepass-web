/**
 * `/robots.txt` (ENG-591 / W5).
 *
 * Host-aware, because one Next app serves both domains from one route: the
 * member space is always `noindex`, the marketing space follows the single
 * `MARKETING_IS_INDEXABLE` flag in `lib/seo.ts`.
 *
 * Reading the `Host` header makes this route dynamic, which is correct and
 * cheap — robots.txt is one small text response, not a page.
 */
import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { isLocalHost, normaliseHost, spaceForHost } from "@/lib/hosts";
import { MARKETING_IS_INDEXABLE } from "@/lib/seo";

export const dynamic = "force-dynamic";

export default async function robots(): Promise<MetadataRoute.Robots> {
  const store = await headers();
  // Same source of truth as middleware.ts: behind a proxy the real public host
  // is in x-forwarded-host, and robots.txt must not disagree with the
  // X-Robots-Tag header middleware sets for the very same request.
  const host = normaliseHost(store.get("x-forwarded-host") ?? store.get("host"));

  const indexable =
    !isLocalHost(host) && spaceForHost(host) === "marketing" && MARKETING_IS_INDEXABLE;

  if (!indexable) {
    // Covers the member space (always), a developer machine, and the marketing
    // site while it still shows real trainers beside placeholder biography.
    return { rules: [{ userAgent: "*", disallow: "/" }] };
  }

  // The BFF stays out of the index even once marketing opens up.
  return { rules: [{ userAgent: "*", allow: "/", disallow: ["/api/"] }] };
}
