import type { Metadata, Viewport } from "next";
import "./marketing.css";
import MarketingFooter from "./footer";
import MarketingNav from "./nav";
import { CANONICAL_ORIGIN, MARKETING_IS_INDEXABLE, canonicalFor } from "@/lib/seo";

/**
 * Marketing shell (ENG-587 / W1).
 *
 * Everything public lives under this layout: the home page today, the legal
 * routes W4 adds next. The member app keeps its own root layout — this one adds
 * the marketing wrapper inside it, which is what carries the scoped tokens.
 *
 * No Supabase import belongs anywhere in this route group. Marketing is static,
 * cacheable and off the auth-cookie path; that separation is the whole reason
 * the marketing site moved onto its own host.
 */

/**
 * The mockup's <head> script, carried over in intent: it marks the document
 * script-capable BEFORE first paint, and the reveal CSS is written
 * `.marketing.js .rv{opacity:0}`. With scripting off the class never lands, so
 * every section is simply visible instead of stuck at opacity 0 — the client
 * reviews this page on a phone with JS blocked, where a blank page reads as
 * broken. Inline and parser-blocking on purpose: `next/script` would defer it
 * past first paint, which is exactly the flash this avoids.
 *
 * The mockup put the flag on <html>. Here it goes on the marketing wrapper
 * instead — the ticket sanctions an equivalent, and mutating the className of
 * <html> (which the root layout renders, and which this route group must not
 * touch) makes React report a hydration mismatch on every marketing page load.
 * Same gate, same selector shape, no mismatch: the wrapper is ours to mark, and
 * `suppressHydrationWarning` tells React the pre-hydration class is intentional.
 */
const MARK_JS_CAPABLE = 'document.currentScript.parentElement.classList.add("js")';

/**
 * The other half of that contract, ported from the mockup verbatim: the observer
 * that adds `.in` and actually reveals a section.
 *
 * It ships HERE, with the CSS it pairs with, even though there is not one `.rv`
 * element in the W1 shell yet. The stylesheet is complete, so the moment W2 adds
 * `.rv` markup the hide half is already live — landing the reveal half in a later
 * slice would mean a window where JS-enabled visitors get blank sections, which is
 * the exact failure the whole contract exists to prevent, just inverted.
 *
 * Runs at the end of the wrapper so the markup above it is parsed. Keeps the
 * mockup's 2.5s failsafe: the reveal is decoration and must never be the reason a
 * section is invisible, so anything the observer has not fired for is shown anyway.
 */
const REVEAL_ON_SCROLL = `(function(){
var els=document.querySelectorAll('.marketing .rv');
if(window.matchMedia('(prefers-reduced-motion: reduce)').matches||!('IntersectionObserver' in window)){
els.forEach(function(e){e.classList.add('in')});return;
}
var io=new IntersectionObserver(function(entries){
entries.forEach(function(en){if(en.isIntersecting){en.target.classList.add('in');io.unobserve(en.target)}});
},{threshold:.1,rootMargin:'0px 0px -6% 0px'});
els.forEach(function(e){io.observe(e)});
setTimeout(function(){
els.forEach(function(e){if(!e.classList.contains('in')&&e.getBoundingClientRect().top<innerHeight*3){e.classList.add('in')}});
},2500);
})();`;

/**
 * Head metadata (ENG-591 / W5), ported from the mockup head.
 *
 * Title, description, keywords, `og:*` and `twitter:*` are the mockup's copy
 * verbatim — the description is Justin's authored text from the Stablepass
 * Overview deck. Three deliberate departures from that head:
 *
 *   - `canonical` and `og:url` pointed at the `.com` of the same name, which
 *     belongs to an unrelated third party (a password generator). Both now
 *     derive from the real apex via `lib/seo.ts`.
 *   - `<meta name="robots" content="index,follow">` becomes the single
 *     `MARKETING_IS_INDEXABLE` flag, `false` until real trainer bios land.
 *   - The `x-concept` working note and the "editable from the admin portal"
 *     comment are dropped: the first is a build marker, the second describes a
 *     CMS that does not exist.
 *
 * This sits on the marketing layout, not the root one, so the member app keeps
 * its own plain "StablePass" title and inherits none of the social card.
 */
const TITLE = "stablepass. | Behind the scenes thoroughbred racing subscription";
const DESCRIPTION =
  "stablepass. is a monthly racing experience subscription giving fans access to behind-the-scenes stable updates, horse content, photos, videos, and race day stories.";

export const metadata: Metadata = {
  // Makes the relative og:image below resolve against the apex, never against
  // whichever host happened to serve the request.
  metadataBase: new URL(CANONICAL_ORIGIN),
  title: TITLE,
  description: DESCRIPTION,
  keywords: [
    "thoroughbred racing subscription",
    "horse racing behind the scenes",
    "follow a racehorse",
    "stable updates",
    "racing content Australia",
    "racehorse trainer updates",
  ],
  alternates: { canonical: canonicalFor("/") },
  robots: { index: MARKETING_IS_INDEXABLE, follow: MARKETING_IS_INDEXABLE },
  openGraph: {
    type: "website",
    siteName: "stablepass.",
    title: TITLE,
    description: DESCRIPTION,
    url: canonicalFor("/"),
    locale: "en_AU",
    images: [{ url: "/og.jpg", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: ["/og.jpg"],
  },
};

// `theme-color` belongs to the viewport export in the App Router; leaving it in
// `metadata` builds with a warning and is ignored.
export const viewport: Viewport = { themeColor: "#285D50" };

export default function MarketingLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // data-cta-mode drives which call to action leads — "trial" leads with the
    // free 30 days, "join" leads with the subscription. It sat on <body> in the
    // mockup; the root layout owns <body> here, so it rides the wrapper instead.
    // W5 makes it a setting; until then it keeps the mockup's chosen value.
    <div className="marketing" data-cta-mode="trial" suppressHydrationWarning>
      <script dangerouslySetInnerHTML={{ __html: MARK_JS_CAPABLE }} />
      <MarketingNav />
      {children}
      <MarketingFooter />
      <script dangerouslySetInnerHTML={{ __html: REVEAL_ON_SCROLL }} />
    </div>
  );
}
