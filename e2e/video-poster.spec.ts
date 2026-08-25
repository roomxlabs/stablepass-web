import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

// End-to-end proof of the poster seam: BE bakes poster_url into the private
// post-media bucket → list render mints via playback?posterOnly=1 (no stream)
// → the card renders a real frame instead of the empty box over dark green.
// Play still hits /api/posts/:id/playback without posterOnly to mint the stream.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

// 1x1 JPEG — stands in for what mux-webhook uploads from image.mux.com.
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64",
);

test("a video post with a baked poster renders the frame, not an empty box", async ({ page }) => {
  const email = `poster-harness-${Date.now()}@stablepass.test`;
  const password = "harness-password-123!";
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: trainer, error: tErr } = await admin
    .from("trainer").insert({ name: "Chris Waller", slug: `poster-waller-${Date.now()}` })
    .select("id").single();
  if (tErr) throw tErr;

  const { data: horse, error: hErr } = await admin
    .from("horse")
    .insert({ trainer_id: trainer.id, display_name: "Mahogany", racing_name: "Mahogany", status: "active" })
    .select("id").single();
  if (hErr) throw hErr;

  const { data: post, error: pErr } = await admin.from("post").insert({
    horse_id: horse.id,
    type: "video",
    status: "published",
    body: "Trackwork this morning.",
    // A video post has NO media_url — that column is the photo/voice path. This is
    // exactly the row shape that used to render as a flat green rectangle.
    media_url: null,
    mux_playback_id: `pb-fixture-${Date.now()}`,
    source_trainer_id: trainer.id,
    watermarked: false,
    published_at: new Date().toISOString(),
  }).select("id").single();
  if (pErr) throw pErr;

  const posterPath = `posters/${post.id}.jpg`;
  const { error: upErr } = await admin.storage
    .from("post-media")
    .upload(posterPath, TINY_JPEG, { contentType: "image/jpeg", upsert: true });
  if (upErr) throw upErr;

  const { error: setErr } = await admin.from("post").update({ poster_url: posterPath }).eq("id", post.id);
  if (setErr) throw setErr;

  const { data: userData, error: uErr } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (uErr) throw uErr;

  try {
    await page.goto("/signin");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/explore");

    await page.goto(`/horses/${horse.id}`);
    const media = page.locator(".post-web .post-media-web").first();
    await expect(media).toBeVisible();

    // The poster must render as an <img> carrying a SIGNED storage URL — a bare
    // path would resolve relative to the page and silently load HTML.
    const img = media.locator("img");
    await expect(img).toBeVisible();
    const src = await img.getAttribute("src");
    expect(src).toContain("/storage/v1/object/sign/post-media/");
    expect(src).toContain(`posters/${post.id}.jpg`);
    expect(src).toMatch(/token=/);

    // ...and it is still a video, so the play affordance stays.
    await expect(media.getByRole("button", { name: "Play video" })).toBeVisible();

    // Capture the card itself — it sits below the profile header, so a viewport
    // screenshot would show the hero rather than the thing under review.
    await page.locator(".post-web").first().scrollIntoViewIfNeeded();
    await page.locator(".post-web").first().screenshot({ path: ".rx/review/video-poster.png" });
  } finally {
    if (userData?.user?.id) await admin.auth.admin.deleteUser(userData.user.id).catch(() => {});
    await admin.storage.from("post-media").remove([posterPath]).catch(() => {});
  }
});
