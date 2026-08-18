# stablepass-web — Design source (mockups)

FE screen tickets build against these prebuilt HTML/CSS mockups (member web).

**Source (verified 18 Aug 2026, ENG-612):**
`<workspace>/06-stage1-design/mockups/web/` — i.e. **outside this repo**, a sibling of `code/`,
not a path inside the repo. This checkout may be a worktree under `.claude/worktrees/<ticket>/`,
where a plain `../..` does not reach the workspace, so derive it from the git common dir:

```sh
ls "$(git rev-parse --git-common-dir)/../../../06-stage1-design/mockups/web/screens/"
```

Serve with `python3 -m http.server` from `06-stage1-design/mockups/`.

> **Two previous entries here were wrong and cost real time.** The manifest first pointed at
> `../docs/dev-handover/mockups/web/`, then ENG-571's 15 Aug "fix" pointed at
> `../dev-handover/StablePass-mockups/mockups/web/`. **Neither has ever existed** (`ls` fails on
> both, re-checked 18 Aug). Verify the path resolves before building against it.

`06-stage1-design/` is **not** a git repo, so nothing under it is versioned — treat the files as
the live source of truth, and archived supersedes live under `screens/_archive/`.

Design system: `mockups/web/style.css` — translate colours/fonts/spacing/components into tokens.
Do not add classes to it; if a screen needs something the system lacks, that is a design gap
to flag, not a local invention.

| Screen | Mockup file |
|---|---|
| Marketing (Wix in prod) | `web/screens/01-marketing-home.html` |
| Sign in | `web/screens/02-signin.html` |
| Start trial (first/last name, email, phone, **postcode**, password) | `web/screens/03-trial-start.html` |
| Checkout — **embedded Stripe Elements** | `web/screens/04-checkout.html` |
| Onboarding | `web/screens/05-onboarding.html` |
| Explore feed (tabs: Explore/Trainers/Horses/Following) | `web/screens/06-explore.html` |
| Horse profile | `web/screens/07-horse-profile.html` |
| Account & subscription (no Devices & Sessions) | `web/screens/09-account.html` |

Every FE ticket must carry a confirmed mockup reference. Flag any requirement with no backing mockup.
