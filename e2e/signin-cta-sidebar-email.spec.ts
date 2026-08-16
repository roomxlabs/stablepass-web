import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

// ENG-583 — two FE defects found in the live sandbox run.
//   1. The sign-in bottom CTA never said it creates a NEW account.
//   2. A long email was hard-clipped (no ellipsis) in the sidebar account block.
//
// Defect 2 is the reason this spec exists rather than a vitest test: jsdom has no
// layout engine, so "does the ellipsis actually engage" is only answerable in a
// real browser. See .rx/fe-harness.md for the harness convention.
//
// NOTE ON REPRODUCING: playwright.config.ts pins baseURL :3000 with
// reuseExistingServer: true. If a dev server for a DIFFERENT commit is already on
// :3000, this spec silently tests THAT build. Point it at a server you started
// yourself from this worktree before trusting a green run.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

// The address from the DRI's report. It is NOT registered as a fixture: it is a
// real account the DRI is testing with locally, and creating/deleting it here
// would clobber their session. The sidebar renders whatever string it is handed,
// so painting it into the DOM tests the exact same layout path.
const LONG_EMAIL = "renofathoni23+2@gmail.com";

async function signIn(page: Page, tag: string) {
  const email = `${tag}-${Date.now()}@stablepass.test`;
  const password = "harness-password-123!";
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;

  await page.goto("/signin");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/explore");
  return { admin, userId: data.user?.id, email };
}

/**
 * Paint the long address into the sidebar account block, as the app would.
 * Deliberately sets ONLY textContent: the `title` must stay whatever React put
 * there, so the title assertions below test the app rather than this helper.
 */
async function useLongEmail(page: Page) {
  await page.locator(".sidebar-user .meta .email").evaluate((el, value) => {
    el.textContent = value;
  }, LONG_EMAIL);
}

/** Everything needed to tell a real ellipsis from a hard clip. */
async function emailMetrics(page: Page) {
  return page.locator(".sidebar-user .meta .email").evaluate((el) => {
    const s = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    const sidebar = document.querySelector(".sidebar")!.getBoundingClientRect();
    return {
      display: s.display,
      textOverflow: s.textOverflow,
      whiteSpace: s.whiteSpace,
      overflow: s.overflowX,
      // Truncating means the content is wider than the painted box.
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      right: box.right,
      sidebarRight: sidebar.right,
      title: el.getAttribute("title"),
      text: el.textContent,
    };
  });
}

// ---------------------------------------------------------------------------
// Defect 1 — the sign-in CTA
// ---------------------------------------------------------------------------

test("the sign-in CTA says it creates an account, and keeps 30 days free", async ({ page }) => {
  await page.goto("/signin");

  const foot = page.locator(".auth-foot");
  await expect(foot).toBeVisible();

  const text = ((await foot.textContent()) ?? "").trim();
  expect(text).toMatch(/creat/i);
  expect(text).toMatch(/account/i);
  expect(text).toMatch(/30 days free/i);
  // The exact framing the DRI misread as "the way back in".
  expect(text).not.toMatch(/not subscribed yet/i);
  // The 30-day pass does not auto-renew — no copy may imply it does.
  expect(text).not.toMatch(/renew|recurring|per month/i);

  // It must stay visually distinct from the password-recovery link right above it.
  await expect(page.getByRole("link", { name: /forgot your password/i })).toHaveAttribute(
    "href",
    "/forgot-password",
  );
  await expect(foot.getByRole("link")).toHaveAttribute("href", "/start");

  await page.screenshot({ path: ".rx/review/eng-583-signin-cta.png", fullPage: false });
});

// ---------------------------------------------------------------------------
// Defect 2 — the sidebar email, at every width the sidebar actually supports
// ---------------------------------------------------------------------------

test("desktop 1440 — the long email truncates with an ellipsis inside a 240px sidebar", async ({
  page,
}) => {
  const { admin, userId, email } = await signIn(page, "eng583-desktop");
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator(".sidebar-user .meta")).toBeVisible();

    // The app (not this spec) must put the full address on `title`, so a
    // truncated email is still confirmable. Asserted BEFORE any injection.
    expect((await emailMetrics(page)).title).toBe(email);

    // Baseline: where the Sign out button sits with a short email.
    const signout = page.locator(".sidebar-signout");
    const before = (await signout.boundingBox())!;
    const sidebarBefore = (await page.locator(".sidebar").boundingBox())!;

    await useLongEmail(page);
    const m = await emailMetrics(page);

    // The fix itself: an inline box ignores overflow/text-overflow entirely.
    // On the unfixed build this is "inline" and clientWidth/scrollWidth are both
    // 0 (CSSOM View), so both this and the truncation check below genuinely fail.
    expect(m.display).not.toBe("inline");
    expect(m.textOverflow).toBe("ellipsis");
    expect(m.whiteSpace).toBe("nowrap");
    expect(m.overflow).toBe("hidden");

    // Genuinely truncating (content wider than its box) rather than merely fitting.
    expect(m.scrollWidth).toBeGreaterThan(m.clientWidth);

    // ...and truncating *readably*. Without this floor a collapsed .meta
    // (clientWidth ~0) would satisfy the check above while showing nothing.
    expect(m.clientWidth).toBeGreaterThan(100);

    // At 1440 the unfixed inline box overflowed to x=260 against a 240px sidebar.
    // (This one only discriminates on the desktop width — the drawer is wider
    // than the text overflow, so it is a weak signal there.)
    expect(m.right).toBeLessThanOrEqual(m.sidebarRight + 1);

    // ...and nothing else moved.
    const after = (await signout.boundingBox())!;
    const sidebarAfter = (await page.locator(".sidebar").boundingBox())!;
    expect(after.y).toBeCloseTo(before.y, 0);
    expect(after.height).toBeCloseTo(before.height, 0);
    expect(sidebarAfter.width).toBeCloseTo(sidebarBefore.width, 0);
    expect(sidebarAfter.width).toBeCloseTo(240, 0);

    await page.screenshot({ path: ".rx/review/eng-583-sidebar-1440-desktop.png", fullPage: false });
  } finally {
    if (userId) await admin.auth.admin.deleteUser(userId).catch(() => {});
  }
});

test("tablet 1024 — the 72px rail still hides .meta entirely, unchanged by the fix", async ({
  page,
}) => {
  const { admin, userId, email } = await signIn(page, "eng583-tablet");
  try {
    await page.setViewportSize({ width: 1024, height: 768 });

    // globals.css:500 collapses the account block in the rail. `display: block`
    // on a descendant must not resurrect it — the ancestor rule still wins.
    const meta = page.locator(".sidebar-user .meta");
    await expect(meta).toBeHidden();
    expect(await meta.evaluate((el) => getComputedStyle(el).display)).toBe("none");

    const sidebar = (await page.locator(".sidebar").boundingBox())!;
    expect(sidebar.width).toBeCloseTo(72, 0);

    // With .meta hidden the avatar is the only account affordance left, so it
    // has to carry the address — otherwise a rail member cannot tell which
    // account they are in at all.
    await expect(page.locator(".sidebar-user .avatar")).toHaveAttribute("title", email);

    // The Sign out button survives in the rail, un-pushed.
    await expect(page.locator(".sidebar-signout")).toBeVisible();

    await page.screenshot({ path: ".rx/review/eng-583-sidebar-1024-rail.png", fullPage: false });
  } finally {
    if (userId) await admin.auth.admin.deleteUser(userId).catch(() => {});
  }
});

test("phone 390 — the long email truncates with an ellipsis in the 264px drawer", async ({
  page,
}) => {
  const { admin, userId, email } = await signIn(page, "eng583-phone");
  try {
    await page.setViewportSize({ width: 390, height: 844 });

    await page.getByRole("button", { name: "Open navigation" }).click();
    await expect(page.getByTestId("sidebar-backdrop")).toBeVisible();
    // The drawer slides over 180ms — wait for it to settle before measuring.
    await expect
      .poll(() => page.locator(".sidebar").evaluate((el) => el.getBoundingClientRect().left))
      .toBeGreaterThanOrEqual(-1);

    await expect(page.locator(".sidebar-user .meta")).toBeVisible();

    expect((await emailMetrics(page)).title).toBe(email);

    const signout = page.locator(".sidebar-signout");
    const before = (await signout.boundingBox())!;

    await useLongEmail(page);
    const m = await emailMetrics(page);

    expect(m.display).not.toBe("inline");
    expect(m.textOverflow).toBe("ellipsis");
    expect(m.scrollWidth).toBeGreaterThan(m.clientWidth);
    // The drawer (264px) is the least-truncating supported width — it must still
    // clip readably rather than fitting the whole address.
    expect(m.clientWidth).toBeGreaterThan(100);

    const sidebar = (await page.locator(".sidebar").boundingBox())!;
    expect(sidebar.width).toBeCloseTo(264, 0);

    const after = (await signout.boundingBox())!;
    expect(after.y).toBeCloseTo(before.y, 0);

    await page.screenshot({ path: ".rx/review/eng-583-sidebar-390-drawer.png", fullPage: false });
  } finally {
    if (userId) await admin.auth.admin.deleteUser(userId).catch(() => {});
  }
});
