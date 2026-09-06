import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

// ENG-961 — does a post saved on a HORSE PROFILE feed show up on /saved after a
// SIDEBAR (client-side, App Router) navigation, without a full page reload?
//
// Why the horse profile and not Explore/Following: the local `feed` edge function
// is a stub that always returns `{ data: [] }`, so Explore/Following cannot be
// driven end to end (.rx/gotchas.md, "The local feed edge function is a STUB").
// `app/api/horses/[id]/feed` reads `post` directly from Postgres, so it is a real
// path — see ENG-772/ENG-775 for the same pattern.
//
// See .rx/fe-harness.md for the harness convention.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
// Well-known local-Supabase demo service-role key (local dev only — never a real secret).
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const SHOTS = ".rx/review";
const POST_TITLE = "Where the team is up to";
// The card only renders `post.body`, not `post.title` — assert on body text.
const POST_BODY_SNIPPET = "worked well on Tuesday";

test("ENG-961 a post saved on a horse profile appears on /saved via the sidebar link", async ({ page }) => {
  const stamp = Date.now();
  const email = `eng961-harness-${stamp}@stablepass.test`;
  const password = "harness-password-123!";
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: trainer, error: trainerError } = await admin
    .from("trainer")
    .insert({ name: "Tom Alcott", slug: `tom-alcott-${stamp}`, stable_name: "Alcott Racing", location: "Flemington, VIC" })
    .select("id")
    .single();
  if (trainerError) throw trainerError;

  const { data: horse, error: horseError } = await admin
    .from("horse")
    .insert({
      trainer_id: trainer.id,
      display_name: "Mahogany",
      racing_name: "MAHOGANY",
      sex: "male",
      is_gelded: true,
      foaling_year: 2021,
      training_status: "racing",
      status: "active",
    })
    .select("id")
    .single();
  if (horseError) throw horseError;

  const { data: post, error: postError } = await admin
    .from("post")
    .insert({
      horse_id: horse.id,
      source_trainer_id: trainer.id,
      type: "text",
      status: "published",
      title: POST_TITLE,
      body: "Quiet week here. Mahogany worked well on Tuesday and pulled up clean.",
      published_at: new Date().toISOString(),
      watermarked: false,
      like_count: 0,
    })
    .select("id")
    .single();
  if (postError) throw postError;

  // Confirmed user — the `on_auth_user_created` trigger provisions both the
  // `app_user` row (the bookmark FK target) and a trial `subscription` (the row
  // both the profile feed's AND /saved's content gate read), so no explicit
  // subscription insert is needed to make this member entitled.
  const { data: userData, error: userError } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (userError) throw userError;
  const userId = userData.user.id;

  try {
    await page.goto("/signin");
    await page.getByLabel("Email").fill(email);
    await page.getByRole("textbox", { name: "Password" }).fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/explore");

    // --- Step 3/4: save the post on the horse profile feed ------------------
    await page.goto(`/horses/${horse.id}`);
    const card = page.locator(".post-web").filter({ hasText: POST_BODY_SNIPPET }).first();
    await expect(card).toBeVisible();

    const save = card.getByRole("button", { name: "Bookmark" });
    await expect(save).toBeVisible();
    await save.click();

    const saved = card.getByRole("button", { name: "Remove bookmark" });
    await expect(saved).toBeVisible();
    await expect(saved).toHaveAttribute("aria-pressed", "true");
    await expect(saved).toHaveClass(/bookmarked/);

    await page.screenshot({ path: `${SHOTS}/eng-961-01-saved-on-horse-profile.png`, fullPage: true });

    // --- Step 5: navigate via the SIDEBAR link, not page.goto ---------------
    // Mark the current document so we can tell a real client-side (App Router)
    // navigation apart from a full page reload: a full reload tears down window
    // and this marker disappears; a client-side nav leaves it in place.
    await page.evaluate(() => {
      (window as unknown as { __eng961Marker?: number }).__eng961Marker = 1;
    });

    const sidebarSavedLink = page.locator('aside#member-sidebar a[href="/saved"]');
    await expect(sidebarSavedLink).toBeVisible();
    await sidebarSavedLink.click();
    await page.waitForURL("**/saved");

    const markerSurvived = await page.evaluate(
      () => (window as unknown as { __eng961Marker?: number }).__eng961Marker === 1
    );

    // The sidebar renders a plain <a href>, NOT next/link, so this is a full
    // document load and the marker is gone. That is the whole reason a
    // module-level bookmark bus (mobile's `subscribeBookmarkChanges`) cannot
    // work here: nothing in the JS heap survives a member-screen navigation.
    //
    // Asserted, not just logged: if the shell ever moves to next/link this goes
    // red, which is the signal to revisit the ENG-961 conclusion (see the
    // "Member nav is plain <a>" entry in .rx/gotchas.md).
    expect(markerSurvived).toBe(false);

    // --- Step 6: the saved post shows up anyway ------------------------------
    // Because the reload re-runs the server component and SavedFeed re-fetches
    // the bookmark rows. No cross-screen sync mechanism is involved.
    const savedCard = page.locator(".post-web").filter({ hasText: POST_BODY_SNIPPET });
    await page.screenshot({ path: `${SHOTS}/eng-961-02-saved-page-after-sidebar-nav.png`, fullPage: true });
    await expect(savedCard.first()).toBeVisible();
  } finally {
    await admin.from("bookmark").delete().eq("post_id", post.id).then(undefined, () => {});
    await admin.from("post").delete().eq("id", post.id).then(undefined, () => {});
    await admin.from("horse").delete().eq("id", horse.id).then(undefined, () => {});
    await admin.from("trainer").delete().eq("id", trainer.id).then(undefined, () => {});
    await admin.auth.admin.deleteUser(userId).then(undefined, () => {});
  }
});
