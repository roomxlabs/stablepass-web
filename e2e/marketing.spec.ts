import { test, expect, type Page } from "@playwright/test";

/**
 * Marketing shell (ENG-587 / W1) — visual + behavioural evidence.
 *
 * Unlike the member specs this one needs no session and no Supabase: the page is
 * public and static, which is itself part of the guardrail. See .rx/fe-harness.md
 * for the harness convention; screenshots land in .rx/review/ and are committed.
 */

const SHOT_DIR = ".rx/review";

/**
 * Measure the reveal gate directly.
 *
 * W1 ships the stylesheet but none of the `.rv` markup it governs (that is W2), so
 * a sweep of the live page for opacity:0 elements passes vacuously and would keep
 * passing with the reveal completely ungated. Injecting a probe makes the contract
 * observable now, and the assertion survives into W2.
 *
 * Playwright evaluates in an isolated world, so this still works in the
 * javaScriptEnabled:false context — the PAGE's own scripts are blocked, which is
 * exactly the state under test.
 */
async function revealProbeOpacity(page: Page) {
  return page.evaluate(() => {
    const probe = document.createElement("section");
    probe.className = "rv";
    document.querySelector(".marketing")!.appendChild(probe);
    const opacity = getComputedStyle(probe).opacity;
    probe.remove();
    return opacity;
  });
}

async function imagesSettled(page: Page) {
  await page.evaluate(() =>
    Promise.all(
      [...document.images].filter((img) => !img.complete).map(
        (img) =>
          new Promise((resolve) => {
            img.addEventListener("load", resolve, { once: true });
            img.addEventListener("error", resolve, { once: true });
          }),
      ),
    ),
  );
}

test.describe("marketing shell", () => {
  test("/ serves the marketing shell instead of redirecting to sign in", async ({ page }) => {
    const response = await page.goto("/");

    expect(response?.status()).toBe(200);
    expect(new URL(page.url()).pathname).toBe("/");

    await expect(page.locator("nav.nav")).toBeVisible();
    await expect(page.locator("footer")).toBeVisible();
    await expect(page.getByRole("link", { name: "Join stablepass." })).toBeVisible();
    await expect(page.locator(".foot-col h4")).toHaveText(["Explore", "Support", "Legal"]);
  });

  test("ships no inlined image, in the HTML or the stylesheet", async ({ page }) => {
    const response = await page.goto("/");
    const html = (await response?.text()) ?? "";
    expect(html).not.toContain("data:image/");

    // The two mockup backgrounds lived in CSS, so check the served stylesheets too.
    const hrefs = await page.locator('link[rel="stylesheet"]').evaluateAll((links) =>
      links.map((l) => (l as HTMLLinkElement).href),
    );
    for (const href of hrefs) {
      const css = await (await page.request.get(href)).text();
      expect(css, `${href} still inlines an image`).not.toContain("data:image/");
    }
  });

  test("every marketing asset it references actually loads", async ({ page }) => {
    const failed: string[] = [];
    page.on("response", (r) => {
      if (r.url().includes("/marketing/") && r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
    });

    await page.goto("/");
    await imagesSettled(page);

    const broken = await page.evaluate(() =>
      [...document.images].filter((img) => img.naturalWidth === 0).map((img) => img.src),
    );
    expect(broken).toEqual([]);
    expect(failed).toEqual([]);
  });

  test("marks the shell script-capable, so the reveal can arm", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".marketing")).toHaveClass(/(^|\s)js(\s|$)/);
    // The flag belongs to the wrapper. Putting it on <html> mutates what the root
    // layout rendered and makes React report a hydration mismatch on every load.
    await expect(page.locator("html")).not.toHaveClass(/(^|\s)js(\s|$)/);
  });

  test("hydrates cleanly — no mismatch from the pre-paint js flag", async ({ page }) => {
    const complaints: string[] = [];
    page.on("console", (msg) => {
      const text = msg.text();
      if (/hydrat|did not match|server rendered HTML/i.test(text)) complaints.push(text);
    });
    page.on("pageerror", (err) => complaints.push(err.message));

    await page.goto("/");
    await expect(page.locator(".marketing")).toHaveClass(/(^|\s)js(\s|$)/);
    expect(complaints).toEqual([]);
  });

  test("arms the reveal when scripting is available", async ({ page }) => {
    await page.goto("/");
    expect(await revealProbeOpacity(page)).toBe("0");
  });

  // Regression guard. Folding the mockup's body{overflow-x:hidden} onto the wrapper
  // makes that div a scroll container, and the sticky nav then sticks to a scrollport
  // that never scrolls — it scrolls off the top instead. Nothing else catches this:
  // the W1 page is too short to scroll, so no screenshot can show it.
  test("keeps the nav stuck to the top while the page scrolls", async ({ page }) => {
    // A short viewport rather than an injected filler: the W1 shell is ~540px
    // tall, so 320px of viewport is enough to scroll. Injecting a tall element
    // instead would land in React's tree before hydration finishes, and
    // hydration then discards it — which looks exactly like a scroll failure.
    await page.setViewportSize({ width: 1440, height: 320 });
    await page.goto("/");

    const scrollable = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
    expect(scrollable).toBeGreaterThan(150);

    // `behavior:"instant"` on purpose: the mockup sets html{scroll-behavior:smooth},
    // so a plain scrollTo animates and reading scrollY on the next tick returns ~0,
    // which reads exactly like a page that cannot scroll at all.
    await page.evaluate(() => window.scrollTo({ top: 150, behavior: "instant" }));
    await page.waitForFunction(() => window.scrollY === 150);

    // The nav must still be pinned at the top of the viewport.
    expect(await page.locator("nav.nav").evaluate((el) => el.getBoundingClientRect().top)).toBe(0);
    // The wrapper must not have become a scroll container in the first place —
    // that is what silently unsticks the nav.
    expect(await page.locator(".marketing").evaluate((el) => getComputedStyle(el).overflowY)).toBe("visible");
    // ...and the page still must not scroll sideways.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test("captures the desktop and phone shells", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await imagesSettled(page);
    await page.screenshot({ path: `${SHOT_DIR}/eng-587-desktop.png`, fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await imagesSettled(page);
    await page.screenshot({ path: `${SHOT_DIR}/eng-587-phone.png`, fullPage: true });
  });
});

// The client reviews this page on a phone with JS blocked. A page that renders
// blank there reads as broken, so scripting-off is a first-class state, not an
// edge case.
test.describe("with JavaScript disabled", () => {
  test.use({ javaScriptEnabled: false });

  test("renders the whole shell, with nothing stuck at opacity 0", async ({ page }) => {
    await page.goto("/");

    await expect(page.locator(".marketing")).not.toHaveClass(/(^|\s)js(\s|$)/);
    await expect(page.locator("nav.nav")).toBeVisible();
    await expect(page.locator("footer")).toBeVisible();
    await expect(page.locator(".foot-col h4")).toHaveText(["Explore", "Support", "Legal"]);
    await expect(page.locator(".nav-logo img")).toBeVisible();

    const invisible = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".marketing *")]
        .filter((el) => getComputedStyle(el).opacity === "0")
        .map((el) => el.tagName + "." + el.className),
    );
    expect(invisible).toEqual([]);

    // The sweep above is vacuous while the shell has no .rv markup, so measure the
    // gate itself: with the page's scripts blocked the js class never lands, and a
    // revealable section must therefore be fully visible rather than at opacity 0.
    expect(await revealProbeOpacity(page)).toBe("1");

    // The nav anchors are plain hrefs, so they still work without a handler.
    const hrefs = await page.locator(".nav-links a").evaluateAll((links) =>
      links.map((l) => l.getAttribute("href")),
    );
    expect(hrefs).toEqual(["#how", "#app", "#subscription", "#trainers", "#faq"]);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${SHOT_DIR}/eng-587-phone-nojs.png`, fullPage: true });
  });
});
