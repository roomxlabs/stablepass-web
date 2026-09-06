# ENG-1008 — post-trial copy fallout: the access wall and /onboarding

**Epic:** ENG-997 (paid-only subscription) · **Base:** `feature/pricing-v1` · **Repo:** stablepass-web
**Merged in:** ENG-1010 (closed as duplicate) — items 4–6 below are its scope.

## The defect

`components/access-wall.tsx` is the single copy table behind every "you can't see
this" card in the member app — 11 call sites across `/explore`, `/saved`,
`/following`, `/horses`, `/trainers` and `/shares`. Its table branched on
`everSubscribed`:

| `everSubscribed` | key | title |
|---|---|---|
| `false` | `trialEnded` | "Your free trial has ended" |
| `true`  | `paused`     | "Your access has paused" |

ENG-999 retired the free trial (the `trial` status is no longer valid;
`handle_new_user()` provisions `lapsed`) and ENG-1003 removed it from the funnel,
so a new account now lands on `/checkout`. From the moment this epic lands, the
`false` branch is false for **every** member who reads it: a ninety-second-old
account is told it used up 30 free days it was never offered.

It survived the epic because it falls through every slice's declared surface —
ENG-1002 owns `/account`, ENG-1003 owns `app/start`/`app/signin` and explicitly
lists `app/(member)/**` as do-not-touch, ENG-1004 is mobile. `components/` is
under none of them.

## The change

**This is a copy fix.** No structure, no tokens, no entitlement logic. The
`everSubscribed` split is kept — it is still the right split, it is simply no
longer trial-vs-paid:

```
never bought a pass   → they need their FIRST pass
bought one before     → their pass ran out and access is paused
```

1. `trialEnded` → **`neverSubscribed`**, retitled "You don't have a pass yet",
   body "Buy a pass for 30 days of full access — it never renews on its own."
   The CTA (`Get full access` → `/checkout`) is deliberately **unchanged**.
2. `paused` untouched — ENG-1002's review confirmed that wording still fits, and
   a returning member is a genuinely different case.
3. File header rewritten: it explained a trial-vs-paid distinction that no longer
   exists, and it now carries the no-amount and no-mobile-CTA guardrails.
4. `app/onboarding/page.tsx` — the nav greeting dropped its `· 30 days free`
   tail. `/onboarding` left the signup path with ENG-1003 but the URL still
   resolves, so the retired pitch was still being served.
5. `test/no-trial-copy.test.ts` — `components` and `app/onboarding` **promoted**
   out of `PENDING_ROOTS` into `FUNNEL_ROOTS`. See the note below.
6. `e2e/eng-585-status-truth.spec.ts` — the pinned stale assertion moved.

## Two couplings that were planted on purpose

Both earlier slices left a tripwire so this could not be quietly forgotten, and
both are discharged here in the same PR:

- **ENG-1003** added `components` and `app/onboarding` to the `PENDING_ROOTS`
  allowlist, naming the exact offending strings. Note the subtlety: *deleting* an
  entry is only half the job, because a root in neither list is not scanned at
  all — the guard would silently stop covering `components/` at the moment it
  became clean. They are therefore **promoted to `FUNNEL_ROOTS`** (zero-hit bar),
  which is what the file's own comment says should happen.
  `app/(member)` is left in `PENDING_ROOTS`: ENG-1002 has landed and its strings
  look dead, but retiring that entry is ENG-1002's cleanup to claim, and the
  subset semantics mean a stale entry costs nothing.
- **ENG-1002** pinned `"Your free trial has ended"` verbatim in
  `e2e/eng-585-status-truth.spec.ts` with a comment saying this test going red is
  how you would know this ticket landed. The assertion moves to the new title and
  is *tightened*: `/trial/i` must now have zero matches on the page, and each
  branch additionally asserts it does not show the other branch's sentence.

Two further unit tests (`test/explore-feed.test.tsx`,
`test/following-screen.test.tsx`) used the wall title as the positive anchor that
proves the 402 path rendered. They now read it from `WALL_COPY` instead of
retyping it — the string had been retyped in four files and gone stale in three.

## Guardrails

- **No amount, ever — not even in a comment.** A pass is one of two prices and
  which one a member is offered is decided server-side from their promo counter
  (ENG-1001). A literal here is wrong for a large share of the audience.
  `test/access-wall.test.tsx` now enforces this over the whole table. "30 days"
  is a duration and stays.
- **The `/checkout` CTA is web-only.** Correct here — the web *is* where you buy.
  It must never be copied into `stablepass-mobile` (App Store 3.1.3(a)); ENG-1004
  is the mobile side and has its own no-trial-wording criterion. Stated in the
  file header so the next person to reach for copy parity reads it first.
- **Chrome, not a gate.** `hasAccess()`, the 402 path and *when* the wall renders
  are untouched. This ticket changes strings and one copy-key name.
