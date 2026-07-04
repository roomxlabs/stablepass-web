# stablepass-web — Design source (mockups)

FE screen tickets build against these prebuilt HTML/CSS mockups (member web).
Source: `../docs/dev-handover/mockups/web/` (served: `python3 -m http.server` in `mockups/`).
Design system: `mockups/web/style.css` — translate colours/fonts/spacing/components into tokens.

| Screen | Mockup file |
|---|---|
| Marketing (Wix in prod) | `web/screens/01-marketing-home.html` |
| Sign in | `web/screens/02-signin.html` |
| Start trial (name/email/phone/**password**) | `web/screens/03-trial-start.html` |
| Checkout — **embedded Stripe Elements** | `web/screens/04-checkout.html` |
| Onboarding | `web/screens/05-onboarding.html` |
| Explore feed (tabs: Explore/Trainers/Horses/Following) | `web/screens/06-explore.html` |
| Horse profile | `web/screens/07-horse-profile.html` |
| Account & subscription (no Devices & Sessions) | `web/screens/09-account.html` |

Every FE ticket must carry a confirmed mockup reference. Flag any requirement with no backing mockup.
