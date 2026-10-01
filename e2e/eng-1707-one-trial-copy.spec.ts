import { test, expect, type Page } from "@playwright/test";

/**
 * ENG-1707 (TG-W1) — screenshot evidence for the one-trial-per-member copy on the
 * pricing card, the FAQ section and the full FAQ sheet, at a phone (390) and a
 * desktop (1280) width.
 *
 * Same caveat as `eng-1324-pricing-copy.spec.ts`: the shell ships
 * `data-cta-mode="waitlist"`, which hides `.price-sec` and every `.launch-only`
 * FAQ entry — so all of this copy is invisible until launch day. The captures flip
 * the real attribute to "trial" first, which is the mode in which anyone will read it.
 */

const REVIEW = ".rx/review";
const LABEL = process.env.SHOT_LABEL ?? "after";

const PRICING_LINE = "New members only · one free trial per member.";
const FAQ_ANSWER =
  "stablepass. is 30 days free, then A$9.99 per month. Cancel anytime. The price is the same on the website, the App Store and Google Play. The free trial is for new members — one per member, whether you start it on the web, the App Store or Google Play.";

const WIDTHS = [390, 1280] as const;

async function home(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/");
  await page.evaluate(() => {
    document.querySelector(".marketing")?.setAttribute("data-cta-mode", "trial");
  });
  // The sections reveal on scroll via `.rv`; settle them before capturing.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(600);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
}

for (const width of WIDTHS) {
  test(`pricing card @${width} — the one-trial qualifier sits under the trial line`, async ({ page }) => {
    await home(page, width);

    const card = page.locator("#subscription");
    await expect(card).toBeVisible();
    await expect(card.locator(".price-launch")).toHaveText("Start with 30 days free.");
    await expect(card.locator(".price-intro")).toHaveText([
      "Then A$9.99 per month. Cancel anytime. No lock-in contract.",
      PRICING_LINE,
    ]);

    await card.scrollIntoViewIfNeeded();
    await card.screenshot({ path: `${REVIEW}/eng-1707-${LABEL}-pricing-${width}.png` });
  });

  test(`FAQ section @${width} — the cost answer states one trial per member`, async ({ page }) => {
    await home(page, width);

    const faq = page.locator("#faq");
    await faq.scrollIntoViewIfNeeded();
    const cost = faq.locator("details", { hasText: "How much does stablepass. cost?" });
    await cost.locator("summary").click();
    await expect(cost.locator("p.a")).toHaveText(FAQ_ANSWER);

    await faq.screenshot({ path: `${REVIEW}/eng-1707-${LABEL}-faq-${width}.png` });
  });

  test(`FAQ sheet @${width} — the same answer in the full list`, async ({ page }) => {
    await home(page, width);

    await page.locator("#faq [data-sheet='faq']").click();
    const sheet = page.locator("#sheet-faq");
    await expect(sheet).toBeVisible();
    const cost = sheet.locator("details", { hasText: "How much does stablepass. cost?" });
    await cost.locator("summary").click();
    await expect(cost.locator("p.a")).toHaveText(FAQ_ANSWER);

    await page.screenshot({ path: `${REVIEW}/eng-1707-${LABEL}-faq-sheet-${width}.png` });
  });
}
