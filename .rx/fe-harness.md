# stablepass-web — FE verification harness

Playwright UI-verification harness for screenshotting member screens against a
running local Supabase + Next.js dev server.

## Dev port
`npm run dev` serves the app on **:3000** (`playwright.config.ts` `webServer` starts it
automatically if nothing is already listening there — `reuseExistingServer: true`).

## Login route
`/signin` — email/password + "Continue with Google" (`app/signin/sign-in-form.tsx`).
On success the client redirects to `/explore` (the member shell).

## Local Supabase env
`playwright.config.ts` passes the dev server the well-known **local** Supabase demo keys
(these are public fixtures baked into every `supabase start` project — never real secrets):
- `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGci...CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0`

The same two vars live in `.env.playwright` (gitignored via the repo's `.env*` rule) for
manually running `npm run dev` against local Supabase outside of Playwright.

Local Supabase must already be up (`docker ps` shows the `supabase_*_stablepass`
containers, e.g. via `supabase start` in whichever directory owns `supabase/config.toml`,
or the project's existing docker compose). The harness does not start Supabase itself.

## Seeded test account convention
There is no pre-seeded fixture user. `e2e/screenshots.spec.ts` creates a fresh, confirmed
throwaway user per run via the Supabase **admin** API (`auth.admin.createUser` with
`email_confirm: true`), using the local well-known **service_role** key
(`...role":"service_role"...EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU` — again a public
local-only fixture, set `SUPABASE_SERVICE_ROLE_KEY` to override), then logs in through the
real `/signin` form. This avoids a stale fixture drifting from the schema.

## Running the screenshot spec
```bash
export PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH"   # Node 22
npx playwright install chromium   # once
npx playwright test e2e/screenshots.spec.ts
```
Screenshots land in `.rx/review/`:
- `w1-signin.png` — `/signin` (no session required)
- `w1-shell.png` — `/explore` member shell, signed in as the seeded throwaway user
