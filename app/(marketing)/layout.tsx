import "./marketing.css";
import MarketingFooter from "./footer";
import MarketingNav from "./nav";

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
