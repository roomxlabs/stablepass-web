// ENG-1057 — horse & trainer PHOTOS on the browse cards, the stable roster and
// the Explore aside, at mobile parity.
//
// Before this ticket every one of those surfaces drew a monogram: the queries
// never selected `photo_url` at all, even though the photos have been sitting in
// Storage the whole time (64 trainer objects, 96 horse objects) and mobile's
// `src/components/horse-row.tsx` / `trainer-row.tsx` have shown them on every row
// since ENG-833.
//
// This spec seeds a stable whose horses have real photos AND one that has none,
// so a single screenshot carries BOTH states the ticket named — the populated
// card and the initials fallback — side by side, and the reviewer can see that
// the fallback still works rather than taking it on trust.
//
// WHAT THE SCREENSHOTS ARE FOR. They are checked against the MOBILE ROWS, which
// are this ticket's confirmed design reference (web has no mockup for these
// grids). The three things to look at:
//   1. the thumb is a ROUNDED BOX at `--radius-md` (14px) — mobile's
//      `AVATAR_BOX_RADIUS`, not the old ad-hoc 10px, and not a circle;
//   2. the photo is `object-fit: cover`, centre-cropped, filling the box edge to
//      edge with no letterboxing — the fixtures below are deliberately portrait,
//      landscape and square so a broken fit shows up as bars on at least one;
//   3. a horse with no `photo_url` still draws its initial on the web gradient.
//
// GUARDRAIL (the reason this spec asserts as well as screenshots): the photos
// live in PRIVATE buckets. Every `<img src>` on these screens must be a SIGNED
// url; a bare stored path must never be painted. `expectNoBarePaths` below pins
// that on every screen it visits — a regression that renders `abc.jpg` straight
// into `src` fails here, not in production.
//
// Seeded fixture data only. Ids and object paths are discovered/derived at
// runtime; the photo bytes are the repo's own committed marketing images, so the
// spec adds no new binary fixtures.
import { test, expect, type Page, type Locator } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// See .rx/fe-harness.md for the full harness convention.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
// Well-known local-Supabase demo service-role key (local dev only — never a real secret).
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const PASSWORD = "harness-password-123!";
const SHOTS = ".rx/review";

// ONE admin client for the file — see eng-956-shares-list.spec.ts for why a
// module-scope client sidesteps the `ReturnType<typeof createClient>` tsc gap.
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// The repo's own committed marketing photographs, chosen for their SHAPES:
// portrait, landscape and near-square. `object-fit: cover` has to centre-crop
// all three into the same square box — if the rule regressed to `contain` (or to
// no rule at all) the portrait and the landscape would letterbox visibly, which
// is the point of not making every fixture the same aspect ratio.
const PHOTO_FIXTURES = [
  "769aca9c.jpg", // 430x764  portrait
  "6ec6412f.jpg", // 940x588  landscape
  "c2e504a3.jpg", // 840x882  near-square
];

function fixtureBytes(name: string): Buffer {
  // The spec runs from the checkout root (playwright.config.ts pins `cwd`).
  return readFileSync(join(process.cwd(), "public", "marketing", name));
}

/** Upload one photo into a PRIVATE bucket and return the stored object PATH —
 *  which is exactly what the `photo_url` column holds in production. */
async function uploadPhoto(bucket: string, path: string, file: string): Promise<string> {
  const { error } = await admin.storage
    .from(bucket)
    .upload(path, fixtureBytes(file), { contentType: "image/jpeg", upsert: true });
  if (error) throw error;
  return path;
}

/**
 * A signed-in member who is ENTITLED to gated content.
 *
 * The entitlement is set EXPLICITLY, and that is not boilerplate. The
 * `auth.users` trigger provisions a subscription row at the column default,
 * which is `lapsed` — and ENG-999 retired the free trial, so `has_content_access`
 * now grants only on `active` (within its 3-day renewal grace) or an unexpired
 * `canceled`. A member left at the default is WALLED: every screen below would
 * screenshot the AccessWall, every photo assertion would fail on an element that
 * was never rendered, and the failure would look like a photo bug rather than a
 * fixture one. Some older specs still carry a comment claiming the trigger
 * grants access; that comment predates ENG-999.
 *
 * This also makes the signing path real rather than incidental: the Storage RLS
 * policy `media gated read` is `authenticated AND has_content_access`, so an
 * unentitled member's `createSignedUrls` returns nothing and every card would
 * fall back to initials — passing a weaker version of this spec for the wrong
 * reason.
 */
async function seedEntitledMember(prefix: string) {
  const email = `${prefix}-${Date.now()}@stablepass.test`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error) throw error;
  const userId = data.user!.id;

  const { error: subError } = await admin
    .from("subscription")
    .update({ status: "active", current_period_end: "2099-01-01T00:00:00Z" })
    .eq("user_id", userId);
  if (subError) throw subError;

  return { email, userId };
}

async function signIn(page: Page, email: string) {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(email);
  // `getByLabel("Password")` is AMBIGUOUS on this form — the show/hide toggle is
  // `<button aria-label="Show password">`. Target the input by id.
  await page.locator("#password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/explore");
}

/**
 * THE GUARDRAIL ASSERTION. Every `<img>` on the page must be either a SIGNED
 * Storage URL or a local/app asset — never a bare stored object path.
 *
 * A bare path is not merely a 404: it is a RELATIVE url, so the browser resolves
 * it against the current page (`/trainers/<id>/ilham-123.jpg`) and quietly gets
 * HTML back. That renders as a broken-image glyph with a 200 status, which is
 * why this has to be asserted rather than eyeballed on a screenshot.
 */
async function expectNoBarePaths(page: Page, seededPaths: string[]) {
  const srcs = await page.locator("img").evaluateAll((els) =>
    els.map((el) => (el as HTMLImageElement).getAttribute("src") ?? ""),
  );
  for (const src of srcs) {
    for (const path of seededPaths) {
      expect(src, `a bare Storage path reached <img src>: ${src}`).not.toBe(path);
      expect(src, `a bare Storage path reached <img src>: ${src}`).not.toMatch(
        new RegExp(`^/?${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
      );
    }
  }
}

/** A photo thumb has actually PAINTED — decoded bytes, not just a mounted node.
 *  `naturalWidth > 0` is the only honest signal: a broken/denied signed URL
 *  still leaves the element in the DOM and still passes `toBeVisible()`. */
async function expectPhotoLoaded(img: Locator) {
  await expect(async () => {
    const ok = await img.evaluate(
      (el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0,
    );
    expect(ok).toBe(true);
  }).toPass({ timeout: 20_000 });
}

test("ENG-1057 horse & trainer photos render on the browse grids, the stable roster and the trainer card", async ({
  page,
}) => {
  const stamp = Date.now();

  // "0000 " prefix: `/trainers` sorts A-Z and caps each read at
  // BROWSE_PAGE_SIZE, and the shared local database accumulates fixture
  // trainers from every other spec. A digit prefix sorts ahead of every
  // letter-led fixture, so this trainer's card is inside the cap regardless.
  // (Same reasoning as eng-960-browse-pills.spec.ts.)
  const trainerPhotoPath = await uploadPhoto(
    "trainer-photos",
    `eng1057/trainer-${stamp}.jpg`,
    PHOTO_FIXTURES[2],
  );

  const { data: trainer, error: trainerError } = await admin
    .from("trainer")
    .insert({
      name: "0000 Photo Stables ENG1057",
      slug: `photo-stables-eng1057-${stamp}`,
      stable_name: "Photo Stables",
      location: "Flemington, VIC",
      status: "active",
      photo_url: trainerPhotoPath,
    })
    .select("id")
    .single();
  if (trainerError) throw trainerError;

  // THREE horses WITH photos and ONE deliberately WITHOUT — so the populated
  // state and the initials fallback appear in the SAME screenshot. The
  // photo-less one is named last so it sorts to the end of the roster and is
  // easy to point at in review.
  const withPhotos = [
    { display_name: `0000 ENG1057 Portrait ${stamp}`, file: PHOTO_FIXTURES[0] },
    { display_name: `0001 ENG1057 Landscape ${stamp}`, file: PHOTO_FIXTURES[1] },
    { display_name: `0002 ENG1057 Square ${stamp}`, file: PHOTO_FIXTURES[2] },
  ];

  const horsePhotoPaths: string[] = [];
  for (const [i, h] of withPhotos.entries()) {
    horsePhotoPaths.push(
      await uploadPhoto("horse-photos", `eng1057/horse-${stamp}-${i}.jpg`, h.file),
    );
  }

  const noPhotoName = `0003 ENG1057 Nophoto ${stamp}`;
  const { data: horses, error: horseError } = await admin
    .from("horse")
    .insert([
      ...withPhotos.map((h, i) => ({
        trainer_id: trainer.id,
        display_name: h.display_name,
        status: "active",
        photo_url: horsePhotoPaths[i],
      })),
      // No `photo_url` at all — the fallback case.
      { trainer_id: trainer.id, display_name: noPhotoName, status: "active", photo_url: null },
    ])
    .select("id, display_name");
  if (horseError) throw horseError;
  expect(horses!.length).toBe(4);

  const seededPaths = [...horsePhotoPaths, trainerPhotoPath];
  const { email, userId } = await seedEntitledMember("eng1057");

  // The member follows the trainer, so the Explore aside's "Trainers you follow"
  // row has something to draw — that row is one of the five surfaces this
  // ticket fixes, and without a follow it renders nothing at all.
  const { error: followError } = await admin
    .from("follow")
    .insert({ user_id: userId, trainer_id: trainer.id, horse_id: null });
  if (followError) throw followError;

  await signIn(page, email);

  // ---- /horses — populated thumbs AND the initials fallback together --------
  await page.goto("/horses");
  await expect(page.getByRole("heading", { name: "Horses" })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(withPhotos[0].display_name).first()).toBeVisible({ timeout: 45_000 });

  // Each seeded horse WITH a photo paints one.
  for (const h of withPhotos) {
    const card = page.locator(".horse-card-web", { hasText: h.display_name }).first();
    await expectPhotoLoaded(card.locator("img.horse-thumb-photo"));
  }
  // The photo-less horse draws its initial and NO img — the fallback, intact.
  const fallbackCard = page.locator(".horse-card-web", { hasText: noPhotoName }).first();
  await expect(fallbackCard.locator("img")).toHaveCount(0);
  await expect(fallbackCard.locator(".horse-thumb")).toHaveText("0");

  await expectNoBarePaths(page, seededPaths);
  await page.screenshot({ path: `${SHOTS}/eng1057-horses-grid.png`, fullPage: false });

  // ---- /trainers — the trainer card thumb ---------------------------------
  await page.goto("/trainers");
  await expect(page.getByRole("heading", { name: "Trainers" })).toBeVisible({ timeout: 45_000 });
  const trainerCard = page.locator(".trainer-card-web", { hasText: "Photo Stables" }).first();
  await expectPhotoLoaded(trainerCard.locator("img.trainer-thumb-photo"));
  await expectNoBarePaths(page, seededPaths);
  await page.screenshot({ path: `${SHOTS}/eng1057-trainers-grid.png`, fullPage: false });

  // ---- /trainers/:id — "Horses in this stable" roster ----------------------
  await page.goto(`/trainers/${trainer.id}`);
  await expect(page.getByRole("heading", { name: "Horses in this stable" })).toBeVisible({
    timeout: 45_000,
  });
  for (const h of withPhotos) {
    const card = page.locator(".horse-card-web", { hasText: h.display_name }).first();
    await expectPhotoLoaded(card.locator("img.horse-thumb-photo"));
  }
  await expectNoBarePaths(page, seededPaths);
  // The roster sits BELOW the profile cover + header band, so a default
  // viewport screenshot frames the cover and cuts off the very cards this
  // ticket changes. Scroll the roster into view first — the evidence has to
  // show the thumbs, not the hero image above them.
  // `scrollIntoViewIfNeeded()` is NOT enough here: the heading is technically
  // already within the viewport (it sits on the very bottom edge), so
  // Playwright considers it visible and scrolls nothing. Scroll explicitly.
  await page.getByRole("heading", { name: "Horses in this stable" })
    .evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/eng1057-trainer-roster.png`, fullPage: false });

  // ---- /horses/:id — the aside "Trainer" card -----------------------------
  const photoHorse = horses!.find((h) => h.display_name === withPhotos[0].display_name)!;
  await page.goto(`/horses/${photoHorse.id}`);
  const trainerMini = page.locator(".aside-trainer-row img.trainer-avatar-mini-photo").first();
  await expectPhotoLoaded(trainerMini);
  await expectNoBarePaths(page, seededPaths);
  // Same framing problem as the roster above — the aside "Trainer" card is
  // below the horse's cover band.
  // See the roster note above — an explicit scroll, not `scrollIntoViewIfNeeded`.
  await trainerMini.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/eng1057-horse-profile-trainer-card.png`, fullPage: false });

  // ---- /explore — the "Trainers you follow" aside --------------------------
  await page.goto("/explore");
  // ABOUT THE FEED COLUMN IN THIS SCREENSHOT. It may read "Couldn't load the
  // feed." while the aside beside it is perfectly correct. That is a DEV-SERVER
  // artifact, not a defect and not something this ticket touched:
  //
  //   - React StrictMode double-invokes effects in dev, so the feed's two passes
  //     race and the error state flip-flops in and out for the first seconds;
  //   - it reproduces identically on the BASE branch with this same fixture
  //     (checked by running this seed against the pre-ENG-1057 explore-feed), so
  //     it is neither new nor caused by the aside change here;
  //   - the feed is a different load path (`/api/feed`, the BFF) from the aside,
  //     which reads Supabase directly.
  //
  // Deliberately NOT waited out: an assertion that the text has cleared passes
  // and then the text returns on the next pass, so the wait would buy a slower
  // test and no cleaner image. The aside — the surface this ticket changes — is
  // asserted properly below, and that is what the screenshot is evidence of.
  const asideMini = page.locator(".aside-trainer-row img.trainer-avatar-mini-photo").first();
  await expectPhotoLoaded(asideMini);
  await expectNoBarePaths(page, seededPaths);
  await page.screenshot({ path: `${SHOTS}/eng1057-explore-aside.png`, fullPage: false });
});
