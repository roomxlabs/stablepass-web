import { test, expect } from "@playwright/test";

/**
 * Marketing funnel + artefact sweep (ENG-600).
 *
 * Two things this proves that no component test can:
 *
 *  1. A visitor can actually LEAVE the marketing site toward the product. Before
 *     ENG-600 every conversion CTA was an in-page anchor and the funnel was a
 *     loop — hero to pricing, pricing back to hero — with no sign-in anywhere. A
 *     unit test asserting one component's href would not have caught that, because
 *     each individual anchor was "correct" against the mockup.
 *
 *     ENG-729 INVERTS that claim for the pre-launch cutover (ENG-721): until
 *     launch there must be NO visible route to the product, because /start would
 *     take payment details for a product that is not open. The anchors all still
 *     exist — they are hidden by `data-cta-mode="waitlist"`, not deleted — so
 *     this file now asserts both halves: nothing reachable, everything still
 *     there for the one-line switch-back.
 *
 *  2. The shipped bytes carry no mockup review artefacts. Asserted against the
 *     served HTML and the served stylesheets rather than the .next tree, because
 *     the tree is full of false positives: the checkout path contains the string
 *     "RX Labs" (the workspace directory is `RX Labs Australia`), and source maps
 *     legitimately carry the explanatory comments that name what was removed.
 *
 * Public and static, so no session and no Supabase — same as the W1 spec.
 */

// Every artefact must be absent from what a browser receives. `Race Day` is NOT
// in this list on purpose: the hero ticker says "RACE DAY ALERTS" and the copy
// says "watch race day build up", both approved. Banning the string outright
// would fail on real content.
const ARTEFACTS = [
  "Concept B",
  "RX Labs",
  // The reviewer note that disclosed the admin portal to subscribers.
  "Photographs and locations are the real supplied trainer details",
  "admin portal",
];

test.describe("marketing funnel (ENG-600, waitlist mode per ENG-729)", () => {
  test("the nav leads to the waitlist, not to a product that is not open yet", async ({ page }) => {
    await page.goto("/");

    const joinWaitlist = page.getByRole("link", { name: "Join waitlist" });
    await expect(joinWaitlist).toBeVisible();
    await expect(joinWaitlist).toHaveAttribute("href", "#top");

    // Still in the DOM for the switch-back, but not offered to anyone.
    await expect(page.locator("a.nav-signin")).toHaveAttribute("href", "/signin");
    await expect(page.locator("a.nav-signin")).toBeHidden();
    await expect(page.locator("a.nav-cta.launch-only")).toHaveAttribute("href", "/start");
    await expect(page.locator("a.nav-cta.launch-only")).toBeHidden();
  });

  test("the waitlist CTA survives the breakpoint that hides the section links", async ({ page }) => {
    // `.nav-links{display:none}` at <=880px. The pre-launch button is the only
    // action left in the nav, so if it were lost here the phone nav would have
    // no call to action at all — and the phone is how the client reviews this.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Join waitlist" })).toBeVisible();

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow, "the nav pushed the page into horizontal scroll").toBe(false);
  });

  test("offers no visible route to /start or /signin anywhere on the page", async ({ page }) => {
    await page.goto("/");

    // The acceptance criterion, swept over EVERY anchor rather than the handful
    // this ticket happened to touch — that is the only version of this check
    // that catches a route re-introduced by some other section later.
    const leaks = await page.locator("a").evaluateAll((els) =>
      els
        .filter((el) => {
          const href = el.getAttribute("href") ?? "";
          if (!/^\/(start|signin)(\?|#|$)/.test(href)) return false;
          // offsetParent is null for a display:none subtree; the rect check
          // covers the position:fixed case offsetParent misses.
          const rect = el.getBoundingClientRect();
          return (el as HTMLElement).offsetParent !== null || rect.width + rect.height > 0;
        })
        .map((el) => `${el.textContent?.trim()} -> ${el.getAttribute("href")}`),
    );
    expect(leaks, "a route into the product is visible pre-launch").toEqual([]);

    // ...and the other half: they are HIDDEN, not deleted. If these ever hit
    // zero the switch-back has silently stopped being a one-line change.
    const parked = page.locator('a[href="/start"], a[href="/signin"]');
    expect(await parked.count()).toBeGreaterThan(0);
  });

  test("puts a real capture form in both conversion sites", async ({ page }) => {
    await page.goto("/");

    const forms = page.locator("form.wl-form");
    await expect(forms).toHaveCount(2);
    for (const form of await forms.all()) {
      await expect(form).toBeVisible();
      // A REAL form, not a JS widget: these two attributes are the entire no-JS
      // contract and are what the native submit below relies on.
      await expect(form).toHaveAttribute("method", /post/i);
      await expect(form).toHaveAttribute("action", "/api/waitlist");
      await expect(form.locator('input[name="email"]')).toBeVisible();
    }

    // One in the hero, one in the CTA band.
    await expect(page.locator("header.hero form.wl-form")).toHaveCount(1);
    await expect(page.locator(".cta-in form.wl-form")).toHaveCount(1);
  });

  test("hides pricing without removing it from the document", async ({ page }) => {
    await page.goto("/");
    // Kept in the DOM for the frozen copy fixture and the switch-back...
    await expect(page.locator("#subscription")).toHaveCount(1);
    // ...but no price is shown while there is nothing to buy.
    await expect(page.locator("#subscription")).toBeHidden();
    await expect(page.locator(".price-card")).toBeHidden();
  });

  test("ships no mockup review artefact, in the copy or the stylesheet", async ({ page }) => {
    await page.goto("/");

    // Asserted against RENDERED TEXT, not raw HTML. These artefacts are copy, so
    // copy is the right surface — and raw HTML gives a false positive in dev,
    // where turbopack emits chunk URLs built from the absolute project path. The
    // repository lives under a directory literally named "RX Labs Australia", so
    // a raw-HTML sweep for "RX Labs" fails on the file path rather than the
    // footer stamp. `href="#"` is markup rather than copy and has its own test.
    const text = await page.locator("body").innerText();
    for (const artefact of ARTEFACTS) {
      expect(text, `the page still reads "${artefact}"`).not.toContain(artefact);
    }

    const hrefs = await page
      .locator('link[rel="stylesheet"]')
      .evaluateAll((links) => links.map((l) => (l as HTMLLinkElement).href));
    for (const href of hrefs) {
      // Comments are stripped first for the same reason the HTML check reads
      // rendered text: in dev the sheet ends with a sourceMappingURL comment
      // carrying the absolute project path, which contains "RX Labs". Only
      // declarations can put an artefact in front of a user anyway — via
      // `content:` — and those survive the strip.
      const css = (await (await page.request.get(href)).text()).replace(/\/\*[\s\S]*?\*\//g, "");
      for (const artefact of ARTEFACTS) {
        expect(css, `${href} still carries "${artefact}"`).not.toContain(artefact);
      }
    }
  });

  test("no link goes nowhere", async ({ page }) => {
    // The three footer social icons were `href="#"` with no accounts behind them.
    await page.goto("/");
    await expect(page.locator('a[href="#"]')).toHaveCount(0);
  });
});

/**
 * ENG-729 — the waitlist capture with scripting OFF.
 *
 * Not a nice-to-have variant: the client reviews this site on a phone with
 * JavaScript blocked, so this is the path he will actually take. ENG-726 built
 * the component for it (a real `<form method="post">` and a route that answers a
 * native post with `303 -> /?joined=1`), and this ticket closed the last gap —
 * `/` now reads `searchParams`, because a statically prerendered page serves the
 * same HTML for `/` and `/?joined=1` and the redirect would otherwise land on an
 * unchanged page that looks like nothing happened.
 *
 * The POST is intercepted rather than left to reach the database. The claim
 * under test is the BROWSER's half — that a form with no JS submits natively and
 * that the page it is redirected to renders the confirmation server-side — and
 * that claim should not go red because a local Supabase is not running. The
 * route's own half is covered by test/waitlist-route.test.ts, which is where the
 * 303 shape asserted here comes from.
 */
test.describe("the waitlist capture with JavaScript disabled", () => {
  test.use({ javaScriptEnabled: false });

  test("submits natively and lands on a visible confirmation", async ({ page }) => {
    let posted: { method: string; body: string | null } | null = null;

    await page.route("**/api/waitlist", async (route) => {
      posted = { method: route.request().method(), body: route.request().postData() };
      // Exactly what ENG-726's route answers a form-encoded post: see its
      // decision 5. Fulfilled here so the browser really does follow the
      // redirect and really does re-render the page from the server.
      await route.fulfill({ status: 303, headers: { location: "/?joined=1" }, body: "" });
    });

    await page.goto("/");

    const form = page.locator("header.hero form.wl-form");
    await form.locator('input[name="email"]').fill("justin@example.test");
    await form.locator('button[type="submit"]').click();
    await page.waitForURL(/\?joined=1$/);

    // It was a real native form post, form-encoded, carrying the address.
    expect(posted!.method).toBe("POST");
    expect(posted!.body ?? "").toContain("email=justin%40example.test");

    // And the confirmation is actually on screen, in both mounts, with no JS to
    // have put it there.
    const messages = page.locator("p.wl-msg");
    await expect(messages).toHaveCount(2);
    for (const message of await messages.all()) {
      await expect(message).toBeVisible();
      await expect(message).toContainText(/on the list/i);
    }
  });

  test("renders the confirmation in the HTML itself, not from script", async ({ page }) => {
    // The purest form of the claim: no browser involved at all. If `/` ever goes
    // back to being statically prerendered, this is the test that says so.
    const response = await page.request.get("/?joined=1");
    expect(response.status()).toBe(200);
    expect(await response.text()).toContain("on the list");
  });

  test("shows the validation answer the route redirects back with", async ({ page }) => {
    await page.goto("/?joined=0&reason=email");
    const message = page.locator("header.hero p.wl-msg");
    await expect(message).toBeVisible();
    await expect(message).toContainText(/valid email/i);
    // The field survives, so a corrected address is one keystroke away.
    await expect(page.locator('header.hero form.wl-form input[name="email"]')).toBeVisible();
  });

  test("keeps the whole waitlist funnel visible without scripting", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");

    await expect(page.getByRole("link", { name: "Join waitlist" })).toBeVisible();
    await expect(page.locator("form.wl-form")).toHaveCount(2);
    for (const form of await page.locator("form.wl-form").all()) await expect(form).toBeVisible();

    // The hides are CSS, so they must hold with scripting off too — this is the
    // assertion that would catch someone "fixing" a hide with a script.
    await expect(page.locator("#subscription")).toBeHidden();
    await expect(page.locator("a.nav-signin")).toBeHidden();
  });
});
