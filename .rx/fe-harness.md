# stablepass-web — FE verification harness

Playwright UI-verification harness for screenshotting member screens against a
running local Supabase + Next.js dev server.

## Dev port — one server per checkout (ENG-597)

`npm run dev` on its own still serves **:3000**. Playwright does **not** assume :3000,
because the implement loop runs several worktrees at once and a shared port made every
worker's suite silently test whichever branch got there first (ENG-588 lost a set of
committed fidelity screenshots to it).

`playwright.config.ts` resolves the dev-server port in this order:

1. **`PORT` if set** — an explicit override always wins.
2. **A dev server this same checkout already has listening**, :3000 first, then this
   checkout's derived port. This is what keeps the everyday flow working: `npm run dev`
   in one terminal, `npx playwright test` in another, one server, reused.
3. **Otherwise this checkout's derived port**, which Playwright starts itself.

The derived port is `20000 + sha256(realpath(checkout)) % 12768`, so it is **stable for a
given checkout and different for every worktree**. That window (20000-32767) sits below
**both** platforms' ephemeral ranges — Linux's `net.ipv4.ip_local_port_range` defaults to
32768-60999 and macOS's `net.inet.ip.portrange.first` to 49152 — so the OS never hands
the same number to an unrelated outbound socket. The resolved port is threaded through
both `use.baseURL` and `webServer.url`, and `webServer.cwd` is pinned to the checkout.

Every run prints the port and the reuse decision, e.g.
`[playwright] http://localhost:26314 — starting our own dev server (checkout …)`.
Read that line before trusting a result; this defect was invisible for as long as it was
because the output otherwise looked entirely normal.

**A server belonging to a different checkout is never reused.** Ownership is decided by
the listening process's working directory, and *every* listener on the port must be this
checkout. Two outcomes, both safe:

- a foreign process on **:3000** — that candidate is skipped and we quietly move to the
  derived port (the log line names the port actually used);
- a foreign process on the **resolved** port — the run fails loudly with a message naming
  that directory, rather than testing the wrong branch.

`lsof` absent (some minimal CI images) degrades to "not mine", which is the safe
direction — Playwright starts its own server, losing reuse but never mis-attributing.

The one residual race is a hash collision *plus* two checkouts cold-starting
simultaneously. Because `--port` is passed on the CLI, Next treats the port as explicitly
chosen and `exit(1)`s rather than walking to `port + 1`, so the loser fails loudly instead
of quietly serving on a port nobody is watching.

Print the port for a checkout (run from the checkout root — the config uses its own
directory), or confirm who owns a port:

```bash
node -e 'const{createHash}=require("crypto");const r=require("fs").realpathSync(".");
console.log(20000+createHash("sha256").update(r).digest().readUInt32BE(0)%12768, r)'

lsof -ti :<port> | while read p; do lsof -a -p $p -d cwd -Fn; done
```

Do **not** reintroduce a throwaway config to work around cross-talk; that workaround is
superseded. If you need a specific port, set `PORT`.

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
