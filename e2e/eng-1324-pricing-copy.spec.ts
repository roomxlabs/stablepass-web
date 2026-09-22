import { test, expect, type Page } from "@playwright/test";

/**
 * ENG-1324 (Pricing v2 / W4) — screenshot evidence for the price + trial copy.
 *
 * READ THIS BEFORE BELIEVING A SCREENSHOT FROM THIS FILE.
 *
 * The marketing shell ships `data-cta-mode="waitlist"` (app/(marketing)/layout.tsx),
 * and marketing.css hides `.price-sec`, every `.launch-only` and every `.cta-trial`
 * in that mode. Every string this ticket changed lives in one of those three, so a
 * screenshot of the page AS IT SHIPS TODAY shows none of this copy — not because the
 * change did not land, but because the whole pricing surface is switched off until
 * launch day.
 *
 * So these captures flip the attribute to "trial" in the page first. That is the mode
 * the site will be in when this copy is visible to anyone, which makes it the honest
 * thing to photograph — and it is done through the real DOM attribute the real CSS
 * keys off, not by injecting styles. The `waitlist` capture is taken too, so the
 * reviewer can see both: what ships now, and what this copy will say when it flips.
 */

const REVIEW = ".rx/review";

async function home(page: Page, mode: "waitlist" | "trial") {
  await page.goto("/");
  if (mode === "trial") {
    await page.evaluate(() => {
      document.querySelector(".marketing")?.setAttribute("data-cta-mode", "trial");
    });
  }
  // The sections reveal on scroll via `.rv`; settle them before capturing.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(600);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
}

test("pricing card — the price, the trial and the same-price-everywhere line", async ({ page }) => {
  await home(page, "trial");

  const card = page.locator("#subscription");
  await expect(card).toBeVisible();

  // The assertions are the point: a screenshot alone cannot tell you the copy is
  // right, and a green pixel is not evidence. These pin the exact strings.
  await expect(card.locator(".price-num")).toContainText("A$9.99");
  await expect(card.locator(".price-launch")).toHaveText("Start with 30 days free.");
  await expect(card.locator(".price-intro")).toHaveText("Then A$9.99 per month. Cancel anytime. No lock-in contract.");
  await expect(card.locator(".price-fine")).toContainText("the App Store and Google Play");
  await expect(card).not.toContainText("$19");
  await expect(card).not.toContainText("6 months");

  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: `${REVIEW}/eng-1324-pricing-card.png` });
});

test("hero fine print — trial leads, one standing price follows", async ({ page }) => {
  await home(page, "trial");

  const hero = page.locator("header.hero");
  await expect(hero.locator(".hero-launch")).toHaveText("Start with 30 days free.");
  await expect(hero.locator(".hero-price-sub")).toContainText("Then A$9.99 per month. Cancel anytime.");
  await expect(hero.locator(".hero-fine")).toHaveText(
    "The same A$9.99 per month on the website, the App Store and Google Play.",
  );
  await expect(hero).not.toContainText("$19");

  await hero.screenshot({ path: `${REVIEW}/eng-1324-hero.png` });
});

test("FAQ — the promo question is gone, the cost answer carries the new price", async ({ page }) => {
  await home(page, "trial");

  const faq = page.locator("#faq");
  await faq.scrollIntoViewIfNeeded();
  await expect(faq).not.toContainText("Is there an introductory offer?");
  await expect(faq).not.toContainText("$19");

  const cost = faq.locator("details", { hasText: "How much does stablepass. cost?" });
  await cost.locator("summary").click();
  await expect(cost.locator("p.a")).toHaveText(
    "stablepass. is 30 days free, then A$9.99 per month. Cancel anytime. The price is the same on the website, the App Store and Google Play.",
  );

  await faq.screenshot({ path: `${REVIEW}/eng-1324-faq.png` });
});

test("CTA band — the join line", async ({ page }) => {
  await home(page, "trial");

  const band = page.locator(".cta").first();
  await band.scrollIntoViewIfNeeded();
  await expect(band.locator(".cta-trial-line")).toHaveText("Join stablepass. 30 days free, then A$9.99 per month.");
  await band.screenshot({ path: `${REVIEW}/eng-1324-cta-band.png` });
});

test("what ships today — waitlist mode still hides the whole pricing surface", async ({ page }) => {
  await home(page, "waitlist");

  // Unchanged by this ticket, and pinned so the capture cannot be mistaken for a
  // regression: the pricing section is switched off until launch.
  await expect(page.locator("#subscription")).toBeHidden();
  await page.screenshot({ path: `${REVIEW}/eng-1324-waitlist-as-shipped.png`, fullPage: true });
});
