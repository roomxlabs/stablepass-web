import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

// ENG-772 — the green `post.label` pill on the HORSE and TRAINER profile feeds.
//
// Why this is a real end-to-end spec and not a mocked one: unlike /explore and
// /following (which proxy the be `feed` edge fn — a stub locally, so they cannot
// be driven end to end here), both profile feeds are DIRECT reads of `post`
// against local Postgres. So this exercises the whole path the ticket is about:
// the BFF projection names `label`, the screen's own mapper copies it onto
// FeedPost, and post-card draws `.post-badge`.
//
// This is also the gap that let the bug ship: ENG-761's pill evidence was the
// component gallery (/preview/components#round6), which renders PostCard from a
// hand-built prop object and therefore bypasses BOTH the projection and the
// mapper. A gallery screenshot can never catch a dropped column.
//
// See .rx/fe-harness.md for the harness convention.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
// Well-known local-Supabase demo service-role key (local dev only — never a real secret).
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const SHOTS = ".rx/review";

// One of the be's 13 CHECK-pinned presets (ENG-738's `post_label_preset`). A
// value outside that list fails 23514, which is the point of the constraint.
const LABEL = "Trackwork";

test("ENG-772 the label pill renders on the horse AND trainer profile feeds", async ({ page }) => {
  const stamp = Date.now();
  const email = `eng772-harness-${stamp}@stablepass.test`;
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
      sire: "Snitzel",
      dam: "Polar Success",
      // `sex` is male/female plus a separate `is_gelded` flag since ENG-304, and
      // the deployed `horse_sex_check` REJECTS the old `sex: "gelding"` seed with
      // 23514 — which throws at the `if (horseError)` below, before a single
      // assertion runs. That migration arrived on this branch with ENG-815's
      // merge of main; `e2e/screenshots.spec.ts` already carried the fix.
      sex: "male",
      is_gelded: true,
      // A LITERAL year, not `new Date().getFullYear() - n` (ENG-815). Age is
      // derived in Postgres and ENG-617's guard greps the whole repo — e2e
      // included — for date arithmetic, so a seed that computes a foaling year
      // from an age trips it. Nothing here asserts on the rendered age.
      foaling_year: 2021,
      training_status: "racing",
      status: "active",
      starts: 24,
      wins: 6,
      places: 9,
      prize_money_cents: 120_000_000,
    })
    .select("id")
    .single();
  if (horseError) throw horseError;

  // A LABELLED, published text post. It hangs off both the horse (`horse_id`)
  // and the trainer (`source_trainer_id`), so the one row proves both feeds.
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

  const { error: userError } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (userError) throw userError;

  try {
    await page.goto("/signin");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/explore");

    // --- HORSE profile -------------------------------------------------
    await page.goto(`/horses/${horse.id}`);
    const horseBadge = page.locator(".post-web .post-badge", { hasText: LABEL });
    await expect(horseBadge).toBeVisible();
    await expect(horseBadge).toHaveText(LABEL);
    await page.screenshot({ path: `${SHOTS}/eng-772-01-horse-profile-pill.png`, fullPage: true });

    // --- TRAINER profile -----------------------------------------------
    await page.goto(`/trainers/${trainer.id}`);
    const trainerBadge = page.locator(".post-web .post-badge", { hasText: LABEL });
    await expect(trainerBadge).toBeVisible();
    await expect(trainerBadge).toHaveText(LABEL);
    await page.screenshot({ path: `${SHOTS}/eng-772-02-trainer-profile-pill.png`, fullPage: true });
  } finally {
    // Seeded rows are deleted in FK order (post -> horse -> trainer); left
    // behind they accumulate across runs and drift the /horses and /trainers
    // gallery screenshots and count assertions in other specs.
    await admin.from("post").delete().eq("id", post.id).then(undefined, () => {});
    await admin.from("horse").delete().eq("id", horse.id).then(undefined, () => {});
    await admin.from("trainer").delete().eq("id", trainer.id).then(undefined, () => {});
  }
});
