# stablepass-web — Guardrails (non-negotiable)

FE + BFF for the **member** web app. The security boundary is the backend's RLS; these are the rules the web layer must never break.

## 1. The browser never sees the backend URL or any token
Only `lib/supabase/server.ts` (and `lib/api/*`) talk to Supabase server-side; tokens live in **httpOnly cookies** via `@supabase/ssr`. Never expose the service-role key, a raw JWT, or the Supabase URL to client JS beyond the public anon key.

**One sanctioned exception (ENG-730):** `lib/marketing/trainers.ts` is a third server-side Supabase caller. It is a BARE ANON client — no cookies, no session, no service key — and it may read `public.public_trainer` and nothing else. That view is the marketing site's only anonymous read surface (ENG-765), and its fixed column list is the boundary. The module lives outside `app/(marketing)/` so the route group itself stays Supabase-free, and `test/marketing-trainers.test.tsx` pins the projection and the relation. Do not add a fourth caller without the same treatment.
- **Test:** no `SUPABASE_SERVICE_ROLE_KEY` referenced in any client component; auth token never rendered to the DOM.

## 2. No PHI/PII-equivalent leak — no owner identity, ever
Never render, request, or log a horse **owner**. There is no owner field anywhere; a component that tries to show one is a bug.
- **Test:** grep guard — no `owner` field usage in components.

## 3. Content is subscription-gated
Gated reads go through the BFF, which checks `subscription.status ∈ {trial,active}` and returns **402** when lapsed. The UI must handle 402 → reactivate, and never render gated content optimistically before the gate resolves.
- **Test:** a lapsed session hitting a gated route renders the reactivate prompt, not content.

## 4. Payments are embedded — card data never hits our server
Checkout uses **Stripe Elements**; the card is confirmed client-side with the `clientSecret`. Our routes only create Stripe objects + return the secret. **Never** post raw card fields to our API.
- **Test:** no card number/CVC field is ever sent to a `/api/*` route.

## 5. Single-device session
A new sign-in revokes the user's other sessions. No "devices & sessions" management UI, no "sign out everywhere" — just Sign out.

## 6. Video via Mux signed URLs only
Video is played from a short-lived signed URL minted by `/api/posts/:id/playback` (re-gated). Never embed a raw/public Mux asset or store a playback URL.

## 7. Positive-only reactions, no comments
Reaction UI uses the curated positive emoji set only. There is no comment UI anywhere.

## 8. No betting / bookmaker anything
No odds, bets, wagering, or bookmaker links in the UI. Race results link out to a recognised racing site for the full field; no embedded field, no betting affiliate.

## 9. Secrets from env
Public config uses `NEXT_PUBLIC_*`; secrets (`STRIPE_SECRET_KEY`, Mux signing key) are server-only. Nothing committed. `.env.example` documents names.

## Design
FE screen changes build against the confirmed mockup in `.rx/mockups.md`. No confirmed reference → the ticket is `needs-spec`, not `ready`.
