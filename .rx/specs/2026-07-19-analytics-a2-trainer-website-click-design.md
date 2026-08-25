# Analytics v1 — A2 · web · trainer website link + click log (ENG-274)

Epic: ENG-272 · Base branch: `feature/member-web-v1` (trainer profile exists only there; rides that epic's gate ENG-203) · Blocked by: ENG-273 (schema).

## Behaviour
- Trainer profile renders a "Website" link ONLY when `trainer.website_url` is set. `target="_blank" rel="noopener noreferrer"`.
- Click = fire-and-forget `POST /api/trainers/:id/website-click` (do NOT await before the tab opens; logging failure never blocks navigation).
- Route: auth required → 401 unauthenticated; 400 invalid uuid; inserts `{trainer_id, user_id: session user}` via the caller's RLS client (never accept user_id from the body — RLS enforces self); 204 on success. No dedupe: every click is a row.

## Surface
- `app/(member)/trainers/[id]/page.tsx` (pass website_url down)
- `app/(member)/trainers/[id]/website-link.tsx` (new client component)
- `app/api/trainers/[id]/website-click/route.ts` (new)
- `test/website-click-route.test.ts`, `test/website-link.test.tsx`

## Guardrails
Caller's RLS client only · first-party log, no 3rd-party tracking · no user_id accepted from request body.

## Acceptance
Route test 401/400/204; component test hidden-when-null + rel/target + fires POST. `npm run typecheck && npm test` green.

## Design
Follows the existing trainer-profile secondary-action pattern (`follow-notify.tsx`). Admin-side display of the counts: `06-stage1-design/mockups/web/admin/screens/09-analytics.html`.
