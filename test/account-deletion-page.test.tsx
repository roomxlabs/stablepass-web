/**
 * `/legal/delete-account` — the web account-deletion request page (ENG-1041).
 *
 * Google Play's Data Safety form requires a publicly reachable URL where anyone
 * can request deletion of their account and data. The in-app flow (ENG-951 /
 * ENG-952 / ENG-1017) satisfies Apple 5.1.1(v) and does not satisfy this.
 *
 * What is and is not machine-checkable here, stated plainly rather than faked:
 *
 *   PROVABLE   the route renders with no session; the mailto is real and
 *              carries the right mailbox; the page has no price, no purchase
 *              route, no form and no lookup; the three indexing surfaces agree
 *              and are scoped to this ONE path; the footer links it; the
 *              standalone slug does not collide with `/legal/[slug]`.
 *
 *   NOT        that the copy is legally adequate, or that the retention reasons
 *              are true. Those are assertions about the world. The tests below
 *              pin the SUBSTANCE the ticket requires be present (what is
 *              removed, what is retained, that access ends immediately and is
 *              not refunded) by matching on the document's own structure — that
 *              catches a section being deleted, which is the failure that would
 *              actually reach a reviewer. It cannot catch wording that is
 *              present but wrong, and no test can.
 */
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";

import DeleteAccountPage, { generateMetadata } from "@/app/(marketing)/legal/delete-account/page";
import MarketingFooter from "@/app/(marketing)/footer";
import { CONTACT_EMAIL } from "@/app/(marketing)/modals/contact-mailto";
import {
  LEGAL_SLUGS,
  LEGAL_STANDALONE_SLUGS,
  isLegalStandaloneSlug,
  legalCanonicalUrl,
  parseLegalDocument,
} from "@/lib/legal";
import { ALWAYS_INDEXABLE_PATHS, isAlwaysIndexablePath, MARKETING_IS_INDEXABLE } from "@/lib/seo";

// `process.cwd()` rather than `import.meta.url`: this file runs in jsdom, where
// import.meta.url is not a file: URL. It is also exactly how lib/legal.ts
// resolves LEGAL_CONTENT_DIR, so the two cannot disagree about where content is.
const REPO = process.cwd();
const PATHNAME = "/legal/delete-account";
const SOURCE = readFileSync(path.join(REPO, "content", "legal", "delete-account.md"), "utf8");

/* ── the page renders, signed out ────────────────────────────────────── */

describe("the page a signed-out visitor gets", () => {
  // The component takes no params and no session. That IS the requirement:
  // Play's reviewer, and anyone who has already uninstalled the app, must be
  // able to open this with no account. A page that needed either could not be
  // rendered by this test at all.
  it("renders with no session, no props and no network", () => {
    render(<DeleteAccountPage />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Delete Your Account");
  });

  it("states what deletion removes", () => {
    const { container } = render(<DeleteAccountPage />);
    const text = container.textContent ?? "";
    expect(text).toMatch(/What deletion removes/i);
    // The specific classes of data ENG-951's function actually deletes.
    for (const item of [/follow/i, /saved posts/i, /notification/i, /subscription record/i]) {
      expect(text, `${item} should be named among what is removed`).toMatch(item);
    }
    expect(text).toMatch(/cannot be undone/i);
  });

  it("states what is retained and why", () => {
    const text = render(<DeleteAccountPage />).container.textContent ?? "";
    expect(text).toMatch(/What is retained/i);
    // ENG-951: the Stripe customer is kept, detached, for tax records. This is
    // the disclosure Play's Data Safety form is actually asking about.
    expect(text).toMatch(/invoice/i);
    expect(text).toMatch(/tax|accounting|record-keeping/i);

    // The phone number used to claim a free trial is retained as a one-way hash,
    // so that deleting an account cannot be used to re-claim the trial. It is the
    // most surprising disclosure on the page and the one Play's Data Safety form
    // is most likely to be checked against, yet nothing pinned it: the whole
    // bullet could be deleted from content/legal/delete-account.md and this file
    // stayed green.
    //
    // Scope the match to the retained section. `/phone/i` against the whole page
    // is vacuous — §3 already lists "phone number" among what is *deleted*, so it
    // passes with this bullet gone (confirmed by mutation). Both halves are
    // pinned separately: that a phone number is retained at all, and that the
    // retained form is irreversible.
    const retainedStart = text.indexOf("What is retained");
    const retainedEnd = text.indexOf("Access ends immediately");
    expect(retainedStart, "the retained section should be present").toBeGreaterThan(-1);
    expect(retainedEnd, "the section after it should be present, to bound the slice").toBeGreaterThan(
      retainedStart,
    );
    const retained = text.slice(retainedStart, retainedEnd);
    expect(retained, "the retained phone hash should be disclosed").toMatch(/phone/i);
    expect(retained, "and disclosed as irreversible").toMatch(/one-way|irreversible/i);
  });

  it("states that access ends immediately and is not refunded", () => {
    const text = render(<DeleteAccountPage />).container.textContent ?? "";
    expect(text).toMatch(/immediate/i);
    expect(text).toMatch(/forfeit/i);
    expect(text).toMatch(/not refunded/i);
  });

  it("gives both request routes, and an expected response time for the email one", () => {
    const text = render(<DeleteAccountPage />).container.textContent ?? "";
    expect(text).toMatch(/Me tab/i);
    expect(text).toMatch(/Delete account/i);
    // "an expected response time for the email route" — acceptance criterion 2.
    expect(text).toMatch(/five business days/i);
    expect(text).toMatch(/thirty days/i);
  });
});

/* ── the decision: a mailto, not a form ──────────────────────────────── */

describe("the email route is a mailto, not a form", () => {
  it("offers a real mailto to the one confirmed mailbox, with a subject", () => {
    const { container } = render(<DeleteAccountPage />);
    const mailto = [...container.querySelectorAll<HTMLAnchorElement>('a[href^="mailto:"]')];
    expect(mailto).toHaveLength(1);

    const href = mailto[0].getAttribute("href")!;
    // Built from the shared constant, never retyped — a second copy of the
    // address is how one contact point silently drifts from the rest.
    expect(href).toContain(`mailto:${CONTACT_EMAIL}`);
    expect(href).toContain("subject=");
    expect(decodeURIComponent(href)).toContain("Account deletion request");
    expect(CONTACT_EMAIL).toBe("hello@stablepass.co");
  });

  /**
   * The prose prints the address too, as every other policy document does. That
   * is a second copy of a value whose own docblock records it already changing
   * once (17 Aug -> 1 Sep 2026), and the failure mode is a page whose link and
   * whose text name different mailboxes. One assertion closes it.
   */
  it("keeps the printed address and the linked address the same", () => {
    expect(SOURCE).toContain(CONTACT_EMAIL);
    const printed = SOURCE.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) ?? [];
    expect(printed.length).toBeGreaterThan(0);
    for (const address of printed) expect(address).toBe(CONTACT_EMAIL);
  });

  /**
   * The guardrail that decided the form-vs-address question. A form on a public
   * unauthenticated page that accepted an email address would be one validation
   * message away from answering "does this address have an account?" — an
   * enumeration oracle over the whole member base. There is no input of any
   * kind on this page and that is not an accident.
   */
  it("has no form, no input and nothing that could confirm an account exists", () => {
    const { container } = render(<DeleteAccountPage />);
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector("select")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
  });

  it("never claims a message was sent", () => {
    const text = render(<DeleteAccountPage />).container.textContent ?? "";
    expect(text).not.toMatch(/on its way|we have received|message sent|will be in touch/i);
  });

  it("does not promise to say whether an address has an account", () => {
    const text = render(<DeleteAccountPage />).container.textContent ?? "";
    // The copy says the opposite on purpose; pin that it still does.
    expect(text).toMatch(/will not confirm to anyone whether a particular email address has an account/i);
  });
});

/* ── guardrail: reader-app positioning (3.1.3(a)) ────────────────────── */

describe("reader-app positioning — no price, no purchase route", () => {
  const PRICE = /\$|\bAUD\b|\bGST\b|\bper month\b|\bmonthly fee\b|\bprice\b|\bpricing\b|\bcosts?\b/i;

  it("mentions no price anywhere in the page's own content", () => {
    const text = render(<DeleteAccountPage />).container.textContent ?? "";
    expect(text).not.toMatch(PRICE);
  });

  it("mentions no price anywhere in the source copy", () => {
    // The rendered check above would miss copy added to a block that stops
    // being rendered; this reads the document itself.
    expect(SOURCE).not.toMatch(PRICE);
  });

  /**
   * The page's own links only. The shared marketing nav DOES carry a
   * "Join stablepass." CTA, on this page exactly as on `/legal/privacy` — that
   * is inherited chrome this ticket does not own and does not change, and it is
   * called out in the PR rather than silently absorbed. What must hold is that
   * the deletion page itself never steers anyone towards buying instead.
   */
  it("routes nobody to a purchase from its own content", () => {
    const { container } = render(<DeleteAccountPage />);
    for (const a of container.querySelectorAll("a")) {
      const href = a.getAttribute("href") ?? "";
      expect(href, `${href} must not be a purchase route`).not.toMatch(
        /\/start|\/checkout|\/subscribe|#subscription|\/account\/billing/,
      );
    }
  });

  it("does not suggest subscribing instead of deleting", () => {
    const text = render(<DeleteAccountPage />).container.textContent ?? "";
    expect(text).not.toMatch(/upgrade|special offer|discount|instead of deleting, why/i);
  });
});

/* ── indexing: the carve-out, and its blast radius ───────────────────── */

describe("the page is not noindexed — and nothing else changed", () => {
  it("declares itself indexable, but does not hand crawlers the rest of the site", () => {
    // The marketing layout sets robots:{index:false} while the site shows real
    // trainers beside placeholder biography. Next merges layout -> page per
    // top-level key, so this page naming `robots` replaces that value.
    //
    // `follow: false` is the asymmetry that matters and is easy to "tidy" into
    // symmetry by mistake. `Disallow: /` stops a crawler FETCHING the rest of
    // the site; it does not stop it INDEXING a URL discovered as a link. This
    // is the one page crawlers are invited into and it renders inside the
    // shared marketing shell, whose nav and footer link /start, /signin and the
    // other legal routes. Play needs this page findable — that is `index`. It
    // never needed link discovery.
    expect(generateMetadata().robots).toEqual({ index: true, follow: false });
  });

  it("links nothing but mailto from its own content, so nofollow is belt to that braces", () => {
    const { container } = render(<DeleteAccountPage />);
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(href).toMatch(/^mailto:/);
  });

  it("sets its own canonical rather than inheriting the layout's", () => {
    // The documented trap in lib/seo.ts: a nested route silently advertises the
    // LAYOUT's canonical unless it sets its own.
    expect(generateMetadata().alternates?.canonical).toBe(legalCanonicalUrl("delete-account"));
    expect(generateMetadata().alternates?.canonical).toBe("https://stablepass.co/legal/delete-account");
  });

  it("is the only path exempted from the site-wide noindex", () => {
    // The exemption's whole safety argument is that it is a path allowlist and
    // not a flip of the flag. Pin both halves.
    expect(MARKETING_IS_INDEXABLE).toBe(false);
    expect([...ALWAYS_INDEXABLE_PATHS]).toEqual([PATHNAME]);
    expect(isAlwaysIndexablePath(PATHNAME)).toBe(true);
    for (const other of ["/", "/legal/privacy", "/legal/terms", "/explore", "/legal/delete-account/"]) {
      expect(isAlwaysIndexablePath(other), other).toBe(false);
    }
  });
});

/* ── routing: the standalone slug must not collide ───────────────────── */

describe("the standalone route does not collide with /legal/[slug]", () => {
  it("is a standalone slug, and is NOT in the set [slug] prerenders", () => {
    expect(isLegalStandaloneSlug("delete-account")).toBe(true);
    expect([...LEGAL_STANDALONE_SLUGS]).toEqual(["delete-account"]);
    // Two routes claiming /legal/delete-account would resolve to the static one
    // and leave a dead prerender nobody could see was dead.
    expect([...LEGAL_SLUGS]).not.toContain("delete-account");
  });

  it("parses as a legal document under the same reader as every other policy", () => {
    const document = parseLegalDocument("delete-account", SOURCE);
    expect(document.title).toBe("Delete Your Account");
    expect(document.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(document.blocks.length).toBeGreaterThan(10);
  });
});

/* ── discoverability: the footer ─────────────────────────────────────── */

describe("discoverable from the footer, not only by direct URL", () => {
  it("links the page from the Legal column on every marketing page", () => {
    const { container } = render(<MarketingFooter />);
    const legal = [...container.querySelectorAll<HTMLElement>(".foot-col")][2];
    const link = within(legal).getByRole("link", { name: "Delete Your Account" });
    expect(link).toHaveAttribute("href", PATHNAME);
  });
});
