# W8 · Trainers — browse list + trainer profile (design note)

**Ticket:** ENG-201 · **Repo:** stablepass-web · **Base branch:** `feature/member-web-v1` · **Epic:** ENG-187 (Member Web v1)
**Status:** resolved by grill 2026-07-14 → `ready-for-agent`. **Pattern-based — no mockup.**

## Why this is a design note (not a mockup)
The member-web mockups have a **Trainers** nav item + tab and a small **"Trainer" aside card** on the horse profile (`07-horse-profile.html`: `trainer-avatar-mini` + name + "Rosehill, NSW · 3 horses" + "See Chris's stable →"), but **no dedicated trainer browse or profile screen**. This ticket was held `needs-spec` for that reason. Grill resolved the two screens to be built **pattern-based** on the shipped W7 horse profile + the trainer aside card + the W4 components — no new mockup, no new migration, single app (stablepass-web).

## Data (existing schema — no changes)
- `trainer{ id, name, display_name, slug, stable_name, location, bio, photo_url, status('active'|'onboarding') }` — RLS `trainer_select_sub` (gated read).
- `trainer_contact{ role, name, email, phone }` — **ADMIN-ONLY PII. Never selected or rendered by this feature.**
- Their horses: `horse.trainer_id` (RLS `horse_select_sub`, active + gated). Their posts: `post.source_trainer_id` (RLS `post_select_sub`, published + gated).
- Engagement: `follow` / `notify_optin` accept a `trainer_id` target (exactly one of trainer_id/horse_id), RLS `*_rw_self`.

## Resolved decisions (locked in grill)
1. **Design source:** pattern-based, build now (no mockup). Reference = W7 horse profile (`app/(member)/horses/[id]/page.tsx`) + the `.trainer-*` aside card + W4 `TrainerCard`/`HorseCard`.
2. **Stats band = 3 derived, RLS-honest tiles:** **Horses** (count active horses) · **Updates** (count published posts) · **Wins** (Σ `horse.wins` across their horses). No follower count — `follow` rows are owner-scoped under RLS, so a member can't count a trainer's followers without a new backend RPC (**deferred**, out of scope).
3. **Recent updates** = the trainer's posts (`source_trainer_id = :id AND status='published'`, newest-first).
4. **Cover** = full-bleed like the horse profile, `trainer.photo_url` (gradient fallback).
5. **Browse list** = all gated trainers, sorted A–Z by `name` (includes `status='onboarding'`).
6. **Name display** = `display_name || name` (title); subtitle = `stable_name · location`.
7. **Their horses** = a grid of W4 `HorseCard`s in the main column, above Recent updates.

## Screens

### Trainers browse — `app/(member)/trainers/page.tsx` (+ `trainers-grid.tsx` client)
- Gated `GET trainer` (`supabaseBrowser`), all gated trainers A–Z by `name`.
- Card grid (reuse the horse-grid layout / `TrainerCard`): avatar/initials · `display_name || name` · `stable_name · location` · "N horses" → `/trainers/[id]`.
- States: loading · empty · gated (402 → reactivate).

### Trainer profile — `app/(member)/trainers/[id]/page.tsx`
Layout mirrors the W7 horse profile, inside the member shell:
- **Cover** (`.profile-cover-web`): `photo_url`, gradient fallback.
- **Header** (`.profile-header-web`): title `display_name || name`; subtitle `stable_name · location`; `.profile-actions-web` = **Follow** + **Notify** (client island `follow-notify.tsx`, trainer-level).
- **Stats band** (`.profile-stats-web`, 3 tiles): Horses · Updates · Wins (derived).
- **Main column:** "Horses in this stable" = `HorseCard` grid → `/horses/[id]`; then "Recent updates" (`trainer-posts.tsx` client island → `GET /api/trainers/:id/feed`, rendered with `PostCard`).
- **Aside** (`.feed-aside`): About card (`bio`, omit if null) + Stable card (`stable_name · location`).
- States: loading skeleton · **404** (unknown/hidden — never 403) · **402** (reactivate) · empty (no horses / no updates) · follow/notify toggles.

## BFF
- `GET /api/trainers/:id` → `{ data:{ trainer:{ displayName, stableName, location, bio, coverUrl }, stats:{ horses, updates, wins }, horses:[…] } }`. **Never selects `trainer_contact`.** No row → 404 `not_found`; lapsed → 402. (`app/api/trainers/[id]/route.ts` exists — complete it.)
- `GET /api/trainers/:id/feed` → the trainer's published posts, chronological (direct PostgREST; **not** the be feed fn — renders real data locally). (New.)
- Follow/Notify: direct PostgREST `follow`/`notify_optin` `{ user_id, trainer_id }` (exactly one target), RLS `*_rw_self`.

> The Following feed's `feed_page` RPC already matches `f.trainer_id = p.source_trainer_id`, so following a trainer surfaces their stable in the Following tab with no extra work.

## Guardrails
Content-gated (402) · hidden/unknown → **404, never 403** · own `follow`/`notify_optin` rows only · **`trainer_contact` never selected/rendered** · no owner PII · video only via the signed-URL playback route.

## Acceptance
- List browses all gated trainers A–Z → profile; profile shows trainer (display_name→name, stable·location), the 3 stat tiles, their horses grid, and recent updates.
- Follow + trainer-level Notify persist (own rows).
- `trainer_contact` never surfaced (route + component); unknown → 404; lapsed → 402.

## Tests
- Route test (`app/api/trainers/[id]/route.ts`): returns trainer + stats + horses; **asserts NO contact fields (name/email/phone/role)**; 404 unknown; 402 lapsed.
- Component test: Follow + Notify toggle `follow`/`notify_optin` (mocked) with `{ user_id, trainer_id }`.

## Out of scope
Horses (W7) · feed BFF (W5) · a follower-count stat (needs a backend RPC) · trainer-follow in onboarding (horses-only, W3).
