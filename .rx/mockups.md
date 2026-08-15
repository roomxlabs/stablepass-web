# stablepass-web — Design source (mockups)

FE screen tickets build against these prebuilt HTML/CSS mockups (member web).

**Source (verified 15 Aug 2026, ENG-571):**
`<workspace>/dev-handover/StablePass-mockups/mockups/web/` — i.e. a **sibling of this repo**,
not a path inside it. From this repo's root that is `../dev-handover/StablePass-mockups/mockups/web/`.
Serve with `python3 -m http.server` from `StablePass-mockups/mockups/`.

> The manifest previously pointed at `../docs/dev-handover/mockups/web/`, which has never
> existed (`ls` fails). `dev-handover/` is **not** a git repo, so nothing under it is
> versioned — treat the files as the live source of truth and archive supersedes under
> `screens/_archive/`.

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
