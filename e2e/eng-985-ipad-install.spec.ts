import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

// ENG-985 — iPad "Add to Home Screen" prompt: screen evidence at iPad portrait
// and landscape, plus the negative cases. Follows the harness convention in
// .rx/fe-harness.md and the seed-via-admin-API → sign in through the real
// /signin form → screenshot pattern from e2e/expiry-banner.spec.ts. Its own
// spec file rather than an append to e2e/screenshots.spec.ts, per that same
// precedent.
//
// WHY EMULATE RATHER THAN TRUST A DEVICE PRESET. The bug this ticket exists to
// fix is that iPadOS 13+ Safari sends a MACINTOSH user agent, so the test that
// matters most is the disguised one — a Mac UA with touch points. Playwright's
// iPad presets send a legacy `iPad` UA and would sail past a detector that only
// handled case (a). Both are covered below.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
// Well-known local-Supabase demo service-role key (local dev only — never a real secret).
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const PASSWORD = "harness-password-123!";

/** The real iPadOS 17 Safari UA — note it says Macintosh, not iPad. */
const IPAD_DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

const IPAD_PORTRAIT = { width: 834, height: 1194 };
const IPAD_LANDSCAPE = { width: 1194, height: 834 };

function admin() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
}

async function seedUser(email: string): Promise<string | null> {
  try {
    const { data, error } = await admin().auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
    });
    if (error) throw error;
    return data?.user?.id ?? null;
  } catch {
    return null;
  }
}

async function signIn(page: Page, email: string) {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(email);
  // `getByLabel("Password")` is AMBIGUOUS on this form and throws in strict
  // mode: the show/hide control is `aria-label="Show password"`, which the
  // accessible-name match also picks up. Older specs in this directory still
  // use the bare label and are simply stale. Pin the textbox role.
  await page.getByRole("textbox", { name: "Password" }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/explore");
}

async function cleanup(userId: string | null) {
  if (userId) await admin().auth.admin.deleteUser(userId).catch(() => {});
}

/**
 * Make the page look like iPadOS Safari to `lib/ipad.ts`.
 *
 * `navigator.platform` and `maxTouchPoints` cannot be set through Playwright's
 * context options, so they are defined on the prototype before any app script
 * runs. The UA itself comes from the context (set by the caller) — overriding
 * it here too would be redundant and would not reach the request headers.
 */
async function disguiseAsIpad(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "platform", {
      get: () => "MacIntel",
      configurable: true,
    });
    Object.defineProperty(Navigator.prototype, "maxTouchPoints", {
      get: () => 5,
      configurable: true,
    });
  });
}

test.describe("ENG-985 — iPad Add to Home Screen prompt", () => {
  test("appears at iPad portrait and landscape, and dismisses permanently", async ({
    browser,
  }) => {
    const email = `eng985-ipad-${Date.now()}@stablepass.test`;
    const userId = await seedUser(email);
    test.skip(userId === null, "local Supabase unavailable");

    const context = await browser.newContext({
      userAgent: IPAD_DESKTOP_UA,
      viewport: IPAD_PORTRAIT,
      hasTouch: true,
      isMobile: false,
    });
    const page = await context.newPage();
    await disguiseAsIpad(page);

    try {
      await signIn(page, email);
      await page.goto("/explore");

      // PORTRAIT — the prompt is up and names both halves of the gesture.
      const prompt = page.getByTestId("install-prompt");
      await expect(prompt).toBeVisible();
      await expect(prompt).toContainText("Share");
      await expect(prompt).toContainText("Add to Home Screen");
      await page.screenshot({ path: ".rx/review/eng-985-ipad-portrait.png" });

      // LANDSCAPE — same prompt, and the shell's own 900-1279px breakpoint
      // collapses the sidebar to the icon rail. This is the "check the layout
      // at iPad widths" half of the ticket.
      await page.setViewportSize(IPAD_LANDSCAPE);
      await expect(prompt).toBeVisible();
      await page.screenshot({ path: ".rx/review/eng-985-ipad-landscape.png" });

      // The card must sit UNDER the mobile nav drawer, which is active at
      // iPad PORTRAIT (<=899px) — the width this ticket is about. At the
      // original z-index 50 it floated on top of the open drawer.
      await page.setViewportSize(IPAD_PORTRAIT);
      const zIndex = await prompt.evaluate((el) => getComputedStyle(el).zIndex);
      expect(Number(zIndex)).toBeLessThan(30);

      // DISMISSAL — and it must not come back on a full reload.
      await page.getByTestId("install-prompt-dismiss").click();
      await expect(prompt).toHaveCount(0);
      await page.screenshot({ path: ".rx/review/eng-985-ipad-dismissed.png" });

      await page.reload();
      await expect(page.getByTestId("install-prompt")).toHaveCount(0);

      // And still gone on a different member screen — the dismissal is origin
      // wide, not per-route.
      await page.goto("/account");
      await expect(page.getByTestId("install-prompt")).toHaveCount(0);
    } finally {
      await context.close();
      await cleanup(userId);
    }
  });

  test("does not appear on a real desktop Mac (same UA, no touch points)", async ({
    browser,
  }) => {
    const email = `eng985-desktop-${Date.now()}@stablepass.test`;
    const userId = await seedUser(email);
    test.skip(userId === null, "local Supabase unavailable");

    // Identical user agent to the iPad above — ONLY the touch points differ.
    // That is precisely the line `lib/ipad.ts` draws, so this is the test that
    // proves the detector is not just UA sniffing.
    const context = await browser.newContext({
      userAgent: IPAD_DESKTOP_UA,
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();

    try {
      await signIn(page, email);
      await page.goto("/explore");
      await expect(page.getByTestId("install-prompt")).toHaveCount(0);
      await page.screenshot({ path: ".rx/review/eng-985-desktop-no-prompt.png" });
    } finally {
      await context.close();
      await cleanup(userId);
    }
  });

  test("does not appear when already installed (standalone display mode)", async ({
    browser,
  }) => {
    const email = `eng985-standalone-${Date.now()}@stablepass.test`;
    const userId = await seedUser(email);
    test.skip(userId === null, "local Supabase unavailable");

    const context = await browser.newContext({
      userAgent: IPAD_DESKTOP_UA,
      viewport: IPAD_PORTRAIT,
      hasTouch: true,
    });
    const page = await context.newPage();
    await disguiseAsIpad(page);
    // Force the standalone display-mode query true, the way an installed
    // home-screen launch would report it.
    await page.addInitScript(() => {
      const real = window.matchMedia.bind(window);
      window.matchMedia = ((q: string) =>
        q.includes("display-mode: standalone")
          ? { matches: true, media: q, addEventListener() {}, removeEventListener() {} }
          : real(q)) as typeof window.matchMedia;
    });

    try {
      await signIn(page, email);
      await page.goto("/explore");
      await expect(page.getByTestId("install-prompt")).toHaveCount(0);
    } finally {
      await context.close();
      await cleanup(userId);
    }
  });

  test("the manifest is served, its icons resolve, and the apple-touch-icon link is present", async ({
    page,
    request,
  }) => {
    // The manifest is what makes the home-screen result an app rather than a
    // bookmark. Asserting the JSON alone is not enough: a manifest whose icon
    // URLs 404 still parses, and on iPadOS the icon actually comes from the
    // apple-touch-icon LINK, which the manifest cannot tell us about.
    const res = await request.get("/manifest.webmanifest");
    expect(res.ok()).toBe(true);
    const m = await res.json();
    expect(m.name).toBe("StablePass");
    expect(m.display).toBe("standalone");
    expect(m.icons.some((i: { sizes: string }) => i.sizes === "512x512")).toBe(true);
    expect(m.icons.some((i: { purpose?: string }) => i.purpose === "maskable")).toBe(true);

    // Every declared icon must actually exist.
    for (const icon of m.icons as Array<{ src: string }>) {
      const iconRes = await request.get(icon.src);
      expect(iconRes.status(), `${icon.src} should resolve`).toBe(200);
    }

    // The tag iPadOS actually uses for the home-screen icon.
    await page.goto("/signin");
    const appleIcon = page.locator('link[rel="apple-touch-icon"]');
    await expect(appleIcon).toHaveCount(1);
    const href = await appleIcon.getAttribute("href");
    expect(href).toBeTruthy();
    expect((await request.get(href!)).status()).toBe(200);
  });

  test("the manifest is NOT advertised on marketing documents", async ({ page }) => {
    // Scope guard. The first implementation used `app/manifest.ts`, which made
    // Next inject `<link rel="manifest">` into EVERY document — so the public
    // marketing pages advertised themselves as an installable standalone app
    // whose start_url is the brochure. The manifest is now referenced only by
    // the (member) layout. `/legal/privacy` is served from the shared space
    // outside the member shell, so it is the cheap canary for a regression.
    await page.goto("/legal/privacy");
    await expect(page.locator('link[rel="manifest"]')).toHaveCount(0);
  });
});
