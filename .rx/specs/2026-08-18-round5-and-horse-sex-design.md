# Round 5 + ENG-304 — web slices

Grilled 17 to 18 Aug 2026. Three slices touch this repo, across two epics.

| Slice | Linear | Epic | Base branch |
|---|---|---|---|
| W1 | ENG-612 | ENG-603 round 5 | `feature/feedback-v5` |
| W2 | ENG-613 | ENG-603 round 5 | `feature/feedback-v5` |
| H3 | ENG-617 | ENG-304 horse sex | `feature/horse-sex-v1` |

W2 is blocked by W1 (same two files). H3 is on a different branch and blocked by the be
migration being **deployed**, not merely merged.

## The design source, and the manifest that was wrong twice

`.rx/mockups.md` pointed at `../docs/dev-handover/mockups/web/`, which never existed. **ENG-571
"fixed" it on 15 Aug to `<workspace>/dev-handover/StablePass-mockups/mockups/web/`, which does
not exist either.** So the manifest was wrong continuously, through one attempted correction.
The real root is `06-stage1-design/mockups/web/`. Fixed 18 Aug. Resolve worktree-safely and
paste the output:

```sh
ls "$(git rev-parse --git-common-dir)/../../../06-stage1-design/mockups/web/screens/"
```

`web/screens/06-explore.html` and the round 5 block at the end of `web/style.css` were re-cut
for these slices. Pre-edit copies in `web/screens/_archive/`.

**The marketing route group is NOT designed from here.** `app/(marketing)/**` is the Concept B
v2.7 site (ENG-586). Its palette is deliberately near-but-not-equal to the member app's
(`--paper #FAF9F4` vs `--cream #FAF7F2`, `--ink #1E2B26` vs `#1A1A1A`), and `marketing.css` is
diffed rule-for-rule by `test/marketing-shell.test.tsx`. Never use one as a reference for the
other. The 8 app-screen JPGs in `public/marketing/` are stage-1 concept art: **intent, never
spec.**

---

## The six-row divergence, and why full parity was chosen

Round 4 fixed be (ENG-557) and mobile (ENG-554, ENG-560) and **never touched web**.

| # | Web before | Mobile after round 5 | Slice |
|---|---|---|---|
| 1 | `aspect-ratio: 16/9` hardcoded, `post.aspect_ratio` never read | clamped real ratio | W1 |
| 2 | `--brand-green-dark` behind unpainted media | neutral ink | W1 |
| 3 | horse name in `--font-serif` 18/600 | Inter 500 on `#3A3A38` | W2 |
| 4 | body renders **before** the reaction bar | caption **below** it | W2 |
| 5 | no Follow pill | one, Instagram-styled | W2 |
| 6 | no title, no STABLE UPDATE card | both | W2 |

Justin's feedback window is TestFlight builds, so rows 3 to 6 are drift he has not seen and
cannot see. Naufal chose **full parity** over the narrower aspect-only option, with the cost
stated. What makes that safe: the design was authored **once** in the re-cut mockup, so this is
implemented twice from one source of truth, not designed twice.

---

## W1 (ENG-612) — the real aspect, and a neutral ground

Verified before the grill:

- Call sites hardcode `mediaAspect="wide"`: `explore-feed.tsx:409`, `following-screen.tsx:383`,
  `saved-feed.tsx:297`.
- Inline players hardcode `aspectRatio: "16/9", background: "#000"`: `explore-feed.tsx:390`,
  `following-screen.tsx:374`, `saved-feed.tsx:279`, `horse-posts.tsx:180`,
  `trainer-posts.tsx:189`.
- `post-card.tsx:35` **already supports** `tall` and `square`, and `globals.css:610-613` has the
  CSS, but **nothing ever sets them**.
- **`post.aspect_ratio` is never read anywhere in this repo.**

```ts
export const ASPECT_MIN = 0.8;      // 4:5 portrait
export const ASPECT_MAX = 1.91;     // 1.91:1 landscape
export const ASPECT_DEFAULT = 1.6;  // 16:10, for an unknown ratio, which is every photo

export function resolveAspect(ratio: number | null | undefined): number {
  if (ratio == null || !Number.isFinite(ratio) || ratio <= 0) return ASPECT_DEFAULT;
  return Math.min(ASPECT_MAX, Math.max(ASPECT_MIN, ratio));
}
```

`Number.isFinite` is **required**: `'NaN'::numeric` is legal in Postgres and passes a `> 0`
CHECK (ENG-554), so the column's own constraint does not guarantee a usable number.

**No migration and no projection risk.** The column already exists and is deployed, and this
repo reads the feed through the `feed` Edge Function's `setof post` rather than an explicit
column list, so the ENG-560 hard-fail does not apply here. (It **does** apply to H3.)

A 1:1 asset in web's wide column becomes a very tall box. **Pre-existing**, not introduced by
W1: the mockup's first card already carries `.square`. Do not invent a max-height; raise it.

---

## W2 (ENG-613) — card parity

- Option D on `.post-horse`: Inter 500 on `#3A3A38`, as a CSS literal, not an import.
- Caption below the reaction bar via `order` on a flex `.post-web`, so the JSX still reads top
  to bottom. The stage-1 sheet gave `.post-actions-web` its padding through **two
  adjacent-sibling rules that no longer describe the order** (`globals.css:647`); replace them
  with an unconditional padding.
- A Follow pill, net-new here. **The accepted contrast cost applies** (see mobile M3): do not
  add a fill to make it pass 4.5:1.
- The STABLE UPDATE card, same anatomy as mobile, title at 22 for the wider column. **The horse
  stays in the byline** because `post.horse_id` is NOT NULL.
- The two profile feeds render `.post-web` too, so the reorder and the name rule reach them
  automatically. That is intended: verify them rather than scoping them out. **Suppress the
  Follow pill on a trainer's own profile.**

---

## H3 (ENG-617) — a live wrong-data bug

Web computes age as a **plain year subtraction**, in two places:

- `app/api/horses/[id]/route.ts:54`
- `app/(member)/horses/[id]/page.tsx:58` (duplicated, because the page reads Supabase directly)

Southern-hemisphere thoroughbreds age on **1 August**, so **every horse reads one year too old
from 1 January to 31 July**. It agrees with admin and mobile right now only because we are past
1 August, which is why nobody noticed.

**A test is actively hiding it.** `test/horses-route.test.ts:165` seeds
`foaling_year: new Date().getFullYear() - 5`, which always returns exactly 5 under plain
subtraction, on any date. Fixing the formula makes that test date-dependent, so it needs an
injected clock and a fixture on each side of the boundary.

**Delete both formulas.** Web ends up with **zero** age arithmetic; read `horse_age` and
`horse_description` from the database. The timezone is pinned to `Australia/Sydney` inside the
DB function, so the browser's timezone is irrelevant. Do not reintroduce any client-side date
handling.

**Deploy order is load-bearing here**, unlike W1: these are named columns in an explicit
projection, so `42703` fails the whole horse query and the profile 500s.

---

## Guardrails that apply to all three

- **The browser never sees the backend URL or a token.** No new client-side Supabase access.
- **Content is subscription-gated**: 402 to the reactivate prompt, 404 for hidden content.
  Beware **all-negative assertions passing vacuously on a 402**.
- **Video via Mux signed URLs only**, minted by `/api/posts/:id/playback` and re-gated.
- **Positive-only reactions, no comments.** The stable-update panel is admin-authored body copy,
  not a comment thread.
- **No owner PII**; the repo's grep guard must still pass.
- **Marketing CSS must stay scoped.** `.btn`/`.btn-ghost` exist in both sheets, and
  `marketing.css` must be **byte-unchanged** by any of these PRs.

## Repo traps (verified)

- `sb` is untyped, so **`tsc` can NEVER catch a too-narrow `.select()`**. Assert projection
  strings.
- **`app/(member)/**` reads Supabase directly**, so those selects need their own column tests;
  e2e is not the guard, and route-test coverage is patchier than the ticket surface implies.
- `undefined` values **vanish from a JSON response**: pin the key set in tests.
- Guardrail greps must **collapse whitespace**, or a line wrap defeats them.
- `react-hooks/set-state-in-effect` is an **error** here, not a warning.
- The lint rule **forbids `Date.now()` during render**, which is a hint the old age formula was
  always fragile.
- Playwright **silently reuses whatever is on :3000**; check whose server that is.
- `npm run lint` **at the repo root is unusable**; scope it.
- Postgres hands timestamps back as `+00:00`, not `Z`, and server-rendered
  `toLocaleDateString` uses the **host** timezone.
