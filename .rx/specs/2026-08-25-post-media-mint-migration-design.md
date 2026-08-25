# ENG-799 · Post-media publication gating — C: migrate post-media reads to the mint helper (web)

## DRI
Human owner: @naufalrafiar

## Base branch
`feature/media-gating-v1` — cut off `main` (NOT `feature/round6-v1`).

## Context / why
ENG-778: post-media **bytes** are gated on entitlement only, never on publication state. An
entitled member can sign a DRAFT post's photo path directly and pull real bytes. Slice A
(ENG-797) added a server-side mint helper that re-checks `post.status`; slice D (ENG-800) then
**revokes direct member SELECT on `post-media`**. This slice moves the web member app onto the
helper so that when D lands, photos and voice still work.

**If this slice misses a path, that path goes dark at D's cutover** — a null signed URL falling
through to the placeholder. Loud, not silent, and intended. So the job is to find every
post-media read, not most of them.

## Scope decisions (locked)
1. **Only `post-media` moves.** `horse-photos` and `trainer-photos` have no parent post, keep
   entitlement-only direct signing, and are **untouched**. `signPhoto` / `signPhotoMap` stay
   exactly as they are for those two buckets — do not "unify" the two paths.
2. **The browser never talks to the edge function directly** (guardrail 1). The mint goes through
   a **new BFF route** that calls the `post-media` function with `edgeFetch(sb, …)`, exactly as
   `app/api/posts/[id]/playback/route.ts` already does for `playback`. Do not import the function
   name into a client island, and do not put `NEXT_PUBLIC_SUPABASE_URL` in front of the user.
3. **The app never signs a post-media path itself again.** The BFF sends **post ids**; the
   function reads the paths off the visible post rows server-side. No fallback to direct signing —
   the fallback IS the bug.
4. **Posters come from `playback`, not from the new helper** (epic decision 5), via the existing
   `/api/posts/:id/playback` route extended with `posterOnly`, so a list render does not eagerly
   mint a Mux stream per video card.
5. **Batch stays batched.** Each list screen makes ONE mint call for the whole page, matching
   today's single `signPhotoMap(sb, POST_MEDIA_BUCKET, …)` round trip.
6. **Absolute-URL passthrough is preserved.** `isAbsoluteUrl` maps legacy/seeded absolute values
   to themselves; keep that branch verbatim.

IN:  a new BFF mint route; a typed client for it; the five post-media sign call sites; the
     post-media half of `lib/storage/photos.ts`; the playback route + player poster consumption;
     their tests and the video-poster e2e.
OUT: anything reading `horse-photos` or `trainer-photos`; the BE function itself (slice A);
     mobile (slice B); the cutover migration (slice D); the marketing site.

## Surface (files this ticket owns)
Read from `origin/main` @ `269fc13` — these are real call sites, verified by grep.

New:
- `app/api/posts/media/route.ts` — `POST /api/posts/media`, body `{ postIds: string[] }`,
  delegates via `edgeFetch(sb, "post-media", { method: "POST", body: { postIds } })`. Mirrors
  `app/api/posts/[id]/playback/route.ts` including its `UNAUTH()` / `GATED()` / `fail()` envelope
  handling.
- `lib/api/post-media.ts` — the client island's typed fetcher for that route.
- `test/post-media-route.test.ts`

Edit:
- `lib/storage/photos.ts` — `signPhoto` (line 41 `createSignedUrl`) and `signPhotoMap` (line 82
  `createSignedUrls`) keep serving the two photo buckets; the **post-media** entry points move
  out. `postPosterKey` / `signedPosterFor` stay, rekeyed for post-media (see below).
- `app/(member)/explore/explore-feed.tsx` — line 193 sign, line 217 `signedPosterFor`, line 401
  playback fetch
- `app/(member)/following/following-screen.tsx` — line 248 sign, line 272, line 380.
  **Lines 182 and 183 are HORSE/TRAINER photo signs — leave them alone.**
- `app/(member)/horses/[id]/horse-posts.tsx` — lines 79, 99, 157
- `app/(member)/saved/saved-feed.tsx` — lines 138, 161, 238
- `app/(member)/trainers/[id]/trainer-posts.tsx` — lines 85, 107, 166
- `app/api/posts/[id]/playback/route.ts` — pass `posterUrl` through; accept `posterOnly`
- `components/media-player.tsx` — consume `posterUrl` (line 28 playback fetch)

Edit (tests):
- `test/storage-photos.test.ts`
- `test/post-poster.test.ts`
- `test/playback-route.test.ts`
- `test/explore-feed.test.tsx`
- `test/following-screen.test.tsx`
- `test/saved-feed.test.tsx`
- `test/profile-post-feeds.test.tsx`
- `test/post-card.test.tsx`
- `e2e/video-poster.spec.ts`
- `.rx/specs/2026-08-25-post-media-mint-migration-design.md` (this file)

Do-NOT-touch: `app/(member)/horses/[id]/page.tsx` (line 124 — `HORSE_PHOTO_BUCKET`),
`app/(member)/trainers/[id]/page.tsx` (line 73 — `TRAINER_PHOTO_BUCKET`),
`app/api/horses/[id]/route.ts` (line 121), `app/api/trainers/[id]/route.ts` (line 70),
`lib/api/edge.ts`, `lib/supabase/**`, `app/globals.css`, `.rx/guardrails.md`.

**`app/globals.css` is explicitly OUT.** There is no visual change in this ticket, and the
marketing CSS fidelity guard makes any stray CSS rule a test failure.

**Verify the surface before writing code.** `git grep -n "POST_MEDIA_BUCKET\|signPhotoMap\|signPhoto("`
on the merge-base and reconcile against this list. If a call site exists that is not listed here,
it belongs to this ticket — add it and say so in the PR; a missed one goes dark at D.

## Migration
None (client repo).

## Behaviour / contract

### `POST /api/posts/media` (new BFF route)
Request `{ postIds: string[] }` (1..50). Response, using the existing `lib/api/envelope` helpers:
```
200 { data: { items: [ { postId, mediaUrl } ], expiresAt } }
401 UNAUTH()                      -- no session
402 GATED()                       -- edge fn returned 402
400 fail("invalid_request", …)    -- edge fn returned 400
502 fail("post_media_failed", …)  -- anything else non-ok
```
The route resolves the session with `supabaseServer()` and `sb.auth.getUser()` **before** the
edge call, exactly as the playback route does. It never holds a service key and never signs.

### `lib/api/post-media.ts`
`fetchPostMedia(postIds: string[]): Promise<Map<string, string>>` → **postId → signed url**.
- **Never throws** — a failed round trip yields a partial/empty Map so the caller falls back to
  its placeholder, matching `signPhotoMap`'s existing contract that every caller relies on.
- A post id **absent from `items`** (draft, unpublished, gone) is absent from the Map. Render the
  ordinary placeholder — **no error copy, no "unavailable" state.** A draft must stay
  indistinguishable from a nonexistent post.
- **402 must surface as the gated state** (guardrail 3 → reactivate), not as a silent empty Map.
- De-duplicates and chunks at 50 per call.

### The keying change — the important bit
Every post-media call site today keys its map by the **stored path**
(`signedPosterFor(r, postMedia)` → `postPosterKey(r)` → `signed.get(key)`). The helper keys by
**post id**, so for post-media that lookup becomes `map.get(r.id)`. Keep `postPosterKey` and the
absolute-URL passthrough for the horse/trainer buckets and legacy absolute values.

### `/api/posts/:id/playback` (extended)
Accepts `?posterOnly=1` (or a POST body flag — pick one and keep the route's existing GET/POST
shape; note that `components/media-player.tsx:28` POSTs while the four screens GET, so **both
verbs must keep working**). Forwards `posterOnly` to the edge function and returns
`{ data: { playbackUrl?, posterUrl, expiresAt } }`. Existing callers that read
`body.data.playbackUrl` must keep working unchanged.

### Posters at list render
For a `video` row the display image is `poster_url`, which the helper does NOT sign. Each list
screen fetches it via the playback route with `posterOnly`, which skips Mux signing — so no
stream is minted until the member presses play. Keep the existing "mint on click" behaviour in
`components/media-player.tsx` intact.

## Design (screens)
No visual change. Every screen must look identical before and after, including the placeholder
fallback and the `.post-media-web` media box (`app/globals.css:636`). The existing rendering is
the spec; `e2e/video-poster.spec.ts` is the reference for the video card's poster state.
Attach before/after screenshots of Explore, Following, Saved, a horse profile and a trainer
profile to the PR.

## States & edge cases
- **loading:** unchanged placeholder while the mint is in flight. Do not add a spinner.
- **empty (no media):** unchanged.
- **draft / unpublished id in the batch:** absent from the Map → placeholder, **no error copy**.
- **lapsed (402):** the existing reactivate prompt. Guardrail 3 — never render gated content
  optimistically before the gate resolves.
- **offline / 502:** empty Map → placeholder. Never a crash, never a retry storm.
- **first-time:** a cold list makes exactly ONE `/api/posts/media` call for the page.
- **concurrent:** Explore and Following mounting together make two independent calls; this ticket
  introduces no shared cache.
- **expiry:** minted URLs live 300s (down from `PHOTO_SIGN_TTL`'s 3600). A long-open tab may
  outlive its URLs and show placeholders on re-render. **Re-mint per read; do not cache across a
  session**, and stop applying `PHOTO_SIGN_TTL` to post-media.
- **SSR vs client island:** the five post-media call sites are all in `"use client"` islands and
  must go through the BFF route. Do not move them to a Server Component to keep signing directly —
  that would survive D by accident today and break the moment the policy tightens further.

## Guardrails (must hold — see `.rx/guardrails.md`)
- **1 · The browser never sees the backend URL or any token:** the mint goes through
  `/api/posts/media` → `edgeFetch`. No edge-function URL, no `apikey`, no service key in client
  code. This is why the BFF route exists rather than a direct `functions.invoke` from the island.
- **3 · Content is subscription-gated:** a 402 from the edge fn becomes `GATED()` and the UI shows
  the reactivate prompt. Never render gated content before the gate resolves; never fall back to
  direct signing on a 402.
- **6 · Video via Mux signed URLs only:** the poster is a Storage URL, not a stream. Video still
  plays only from `/api/posts/:id/playback`'s `playbackUrl`, and a playback URL is never stored.
- **9 · Secrets from env:** unchanged; this ticket adds no new secret and no new public env var.
- **Never log or persist a signed URL** — it is a bearer token for bytes.

## Acceptance criteria (observable)
- [ ] No `createSignedUrl`/`createSignedUrls` call against `post-media` remains anywhere in the
      app — `git grep` on the final diff proves it. The two photo buckets still use it.
- [ ] Explore, Following, Saved, horse profile and trainer profile each render photo posts via
      `/api/posts/media`, in ONE call per list.
- [ ] Video cards show their poster at list render via the playback route with `posterOnly`, and
      **no Mux stream is minted** until the member clicks play.
- [ ] A post id the server omits renders the ordinary placeholder — no error copy, nothing that
      distinguishes a draft from a missing post.
- [ ] A lapsed session sees the reactivate prompt, not content.
- [ ] No client island references the edge function name or the Supabase functions URL.
- [ ] The horse/trainer cover-photo call sites are byte-identical to `origin/main`.
- [ ] No screen changes visually versus `origin/main`; `app/globals.css` is untouched.

## Tests that must pass (the loop's pass/fail)
- [ ] unit (`test/post-media-route.test.ts`): the route returns `UNAUTH()` with no session;
      maps the edge fn's 402 → `GATED()`, 400 → `invalid_request`, 500 → 502
      `post_media_failed`; forwards `{ postIds }` verbatim to `edgeFetch`; and **never** sends a
      path or a service key.
- [ ] unit (`test/storage-photos.test.ts`, edited): `signPhoto` / `signPhotoMap` still sign the
      horse and trainer buckets directly; **no post-media path is signed by either**.
- [ ] unit (`test/explore-feed.test.tsx`, `following-screen.test.tsx`, `saved-feed.test.tsx`,
      `profile-post-feeds.test.tsx`, edited): each list makes **exactly one** `/api/posts/media`
      call and **zero** post-media `createSignedUrls` calls; a row whose id the server omitted
      resolves to a null poster and renders the placeholder, not an error.
- [ ] unit (`test/playback-route.test.ts`, edited): `posterOnly` is forwarded; the response
      carries `posterUrl`; existing `playbackUrl` consumers still work; both GET and POST still
      work.
- [ ] unit (`test/post-poster.test.ts`, edited): `signedPosterFor` resolves post-media by **post
      id** and still resolves horse/trainer values by path.
- [ ] guardrail: a test asserting no client island imports the edge-function URL or calls
      `supabase.storage.from('post-media')` — the standing guardrail-1 + cutover regression guard.
- [ ] e2e (`e2e/video-poster.spec.ts`, edited): a video card shows its poster with **no** Mux
      request until play is clicked.
- [ ] `npm test` (vitest) green; `npm run typecheck` green (it IS wired in this repo, unlike be).

## Web gotchas that apply
- `npm run lint` at the **repo root is unusable** — scope any lint run.
- `marketing.css` is diffed rule-for-rule against the mockup and any new CSS fails a test until
  sanctioned in `marketing-shell.test.tsx`. This ticket adds **no** CSS; if you find yourself
  needing some, stop — the surface is wrong.
- **Baseline the suite (and Playwright) against the MERGE-BASE first** so you are not chasing a
  pre-existing red. An ungated Playwright red cost ENG-609 45+ minutes.
- Re-fetch the base immediately before opening the PR.

## Dependencies
Blocked by: **A (ENG-797)** — the `post-media` function and `playback`'s `posterUrl` /
`posterOnly` must be merged first. Contract-first: the producer merges before its consumers.

## Open questions — RESOLVED
- Q: Does the island call the edge function directly? A: **No** — guardrail 1. A new BFF route
  (`/api/posts/media`) calls it via `edgeFetch`, exactly like the playback route.
- Q: Does the app send paths or post ids? A: **Post ids.** The server reads the paths itself.
- Q: What keys the returned map? A: **postId**, not the stored path.
- Q: Where do video posters come from? A: the playback route with `posterOnly` — not the new
  helper (epic decision 5), and without eagerly minting a Mux stream (A's decision 8).
- Q: Do horse/trainer photos change? A: **No.** Untouched, entitlement-only, still direct-signed.
- Q: Is there a fallback to direct signing if the mint fails? A: **No.** Fall back to the
  placeholder.
- Q: What does a member see for a draft? A: The ordinary placeholder. No error, no "unavailable".
- Q: Should the islands become Server Components to keep signing directly? A: **No** — see the
  SSR edge case above.
- Q: TTL? A: 300s from the server. Re-mint per read; do not cache across a session.

## Definition of done
- [ ] acceptance criteria met
- [ ] listed tests written + green; `npm test` and `npm run typecheck` green (baselined against
      the merge-base)
- [ ] before/after screenshots attached for the five affected screens
- [ ] reads the repo `CLAUDE.md` + `.rx/gotchas.md` and follows their conventions
- [ ] PR opened against `feature/media-gating-v1`, linked to this ticket, < ~400 line diff
