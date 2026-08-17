# CLAUDE.md — stablepass-web

Member-facing **web app + BFF** (Next.js App Router, TS). Talks to the backend **only** through its own Route Handlers (`app/api/*`); the browser never sees the backend URL or a token. Read `docs/specs/` before changing an area; `.rx/guardrails.md` is the non-negotiable subset.

## Architecture (the BFF contract)
- **Tokens in httpOnly cookies** via `@supabase/ssr`. Only `lib/supabase/server.ts` + `app/api/*` talk to Supabase server-side.
- **Envelope:** `lib/api/envelope.ts` — `{ data }` / `{ error:{code,message} }`; `UNAUTH`=401, `GATED`=402, 404 for hidden content.
- **Gate:** content routes check `subscription.status ∈ {trial,active}` → 402 when lapsed.
- **Billing = embedded Stripe Elements** — `/api/subscription/checkout` returns a `clientSecret`; the FE confirms inline. No hosted redirect. **The pass does not auto-renew** (a 30-day pass; the Subscription is created with `cancel_at_period_end: true`), so there is **no cancel route and no payment-method route** — an active member simply pays again to extend (early renewal → one-off PaymentIntent).
- **Video** plays from a Mux **signed URL** minted by `/api/posts/:id/playback` (re-gated).
- **Single-device login** — new sign-in revokes other sessions; no devices/sessions UI.

## Layout
| Path | What |
|---|---|
| `app/api/*` | BFF Route Handlers (me, feed, subscription, posts/:id/playback, trainers/:id, horses/:id, auth/bootstrap) |
| `lib/supabase/{server,client}.ts` | Supabase clients (server = RLS as user via cookies) |
| `lib/api/envelope.ts` | Response envelope + status helpers |
| `lib/auth/roles.ts` | Role helper (subscriber/admin) |
| `docs/specs/` | Authoritative design (api-contract, flows, screen→API map, checklist) |
| `.rx/` | `guardrails.md`, `gotchas.md`, `mockups.md` (design source) |

## Design source
Member screens build against `docs/dev-handover/mockups/web/*` — see `.rx/mockups.md`. Translate `mockups/web/style.css` into tokens; don't hardcode.

## Dev
```bash
nvm use 22 && npm install
npm run dev        # :3000
npm run typecheck  # tsc --noEmit  (add if missing)
npm run lint && npm run build
npm test
```

## Conventions
- **Never commit or offer to commit** in an interactive session. Stop at `git add` + `git status`.
  - Exception: the rx implement loop MAY commit on its own ticket branch and open a PR. Never to `main`, never to a shared branch, and only its declared file surface.
- Node 22. Git over SSH via `../claudekey`.
- Every change needs a **machine-checkable test** (route/component test asserting status + envelope, incl. 401/402).
- This is standard Next.js 15 App Router (async `params`/`cookies`). No custom framework surprises.
