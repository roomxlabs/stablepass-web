import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

// ENG-775 — the green `post.label` pill on the SAVED (bookmarks) screen.
//
// The fifth and last instance of the round-6 dropped-column class. Unlike the
// profile feeds ENG-772 fixed, /saved's projection was never the problem: it
// reads `bookmark → post:post_id(*)`, a STAR projection, so `label` always
// arrived from Postgres. It was the screen's OWN row→FeedPost mapper that never
// copied it onto the view-model, so the card was handed `label: undefined` and
// drew no `.post-badge`.
//
// That is exactly why this is a real end-to-end spec: /saved is a DIRECT read of
// `bookmark`/`post` against local Postgres (not the `feed` edge fn, which is a
// stub locally — see .rx/gotchas.md), so this drives the whole path the ticket is
// about. A data-layer assertion on the `.select()` string — the shape ENG-772
// used — would have passed against the bug, and the component gallery bypasses
// the mapper entirely, which is how the defect reached five surfaces at once.
//
// See .rx/fe-harness.md for the harness convention.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
// Well-known local-Supabase demo service-role key (local dev only — never a real secret).
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const SHOTS = ".rx/review";

// One of the be's 13 CHECK-pinned presets (ENG-738's `post_label_preset`).
const LABEL = "Trackwork";

test("ENG-775 the label pill renders on a saved card", async ({ page }) => {
  const stamp = Date.now();
  const email = `eng775-harness-${stamp}@stablepass.test`;
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
      status: "active",
    })
    .select("id")
    .single();
  if (horseError) throw horseError;

  // A LABELLED, published text post — the one the member has saved.
  const { data: post, error: postError } = await admin
    .from("post")
    .insert({
      horse_id: horse.id,
      source_trainer_id: trainer.id,
      type: "text",
      status: "published",
      title: "Where the team is up to",
      body: "Quiet week here. Mahogany worked well on Tuesday and pulled up clean.",
      label: LABEL,
      published_at: new Date().toISOString(),
      watermarked: false,
      like_count: 4,
    })
    .select("id")
    .single();
  if (postError) throw postError;

  const { data: userData, error: userError } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (userError) throw userError;
  const userId = userData.user.id;

  // The `on_auth_user_created` trigger has already created this member's
  // `app_user` row (the bookmark FK target) AND their trial `subscription`
  // (the row /saved's own content gate reads), so the bookmark can be seeded
  // directly — no UI round trip needed to make the member entitled.
  const { error: bookmarkError } = await admin
    .from("bookmark")
    .insert({ user_id: userId, post_id: post.id });
  if (bookmarkError) throw bookmarkError;

  try {
    await page.goto("/signin");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/explore");

    await page.goto("/saved");

    // The saved card itself must be there — assert it BEFORE the pill, so a
    // gated/empty screen fails as "no card" rather than as a missing badge.
    const card = page.locator(".post-web").first();
    await expect(card).toBeVisible();
    await expect(card).toContainText("Mahogany");

    const badge = card.locator(".post-badge", { hasText: LABEL });
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText(LABEL);

    await page.screenshot({ path: `${SHOTS}/eng-775-01-saved-label-pill.png`, fullPage: true });
  } finally {
    // Deleted in FK order. The bookmark goes with the post (ON DELETE CASCADE),
    // but seeded rows left behind accumulate across runs and drift the counts
    // and gallery screenshots other specs assert on.
    await admin.from("bookmark").delete().eq("post_id", post.id).then(undefined, () => {});
    await admin.from("post").delete().eq("id", post.id).then(undefined, () => {});
    await admin.from("horse").delete().eq("id", horse.id).then(undefined, () => {});
    await admin.from("trainer").delete().eq("id", trainer.id).then(undefined, () => {});
    await admin.auth.admin.deleteUser(userId).then(undefined, () => {});
  }
});
