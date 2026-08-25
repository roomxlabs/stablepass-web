# Racing feed v1 — RF5 · web · Member race reads (ENG-297)

**Epic:** ENG-292 · **Base branch:** `feature/racing-feed-v1` · **Blocked-by:** ENG-293 (`entry_status` semantics; direct-PG reads through the BFF — no RF3 dependency, test against seeded rows)
**Grilled:** 20 Jul 2026.

## Why

The member web renders race UI but reads nothing: `app/api/horses/[id]/route.ts` returns a stubbed `races: []` and the Explore race-day band has no data source. This slice makes the feed's output visible.

## Surface (owns)

* `app/api/horses/[id]/route.ts` — replace the `races: []` stub
* `app/api/race-day/route.ts` (new) — deliberately NOT touching the W5 feed routes
* Next-race card + race-record presentation in `app/(member)/horses/**` (W7 Done; surface free)
* Race-day band wiring in `app/(member)/explore/**` (W6 Done; surface free)
* Route/component tests

## Contract

* `GET /api/horses/[id]` → `{ data: { horse, posts, races: { next, record } } }`:
  * `next` = earliest `race.status='upcoming'` with `entry_status IN ('nominated','confirmed')`: `{ venue, race_number, race_class, distance_m, scheduled_at, entry_status, barrier, jockey }` or `null`.
  * `record` = `entry_status='ran'` rows desc by `race_date`: `{ venue, race_date, race_number, race_class, result, finish_position }`.
  * Scratched and not_accepted rows appear in neither.
* Next-race card: `confirmed` → full card (barrier + jockey per mockup); `nominated` → same card, "Nominated" label, barrier/jockey omitted; `null` → hidden.
* `GET /api/race-day` → `{ data: { races: [...] } }`: today's `confirmed` runners among followed horses; empty → band hidden.
* Envelope + gate: 401 `UNAUTH`, 402 `GATED` (lapsed), 404 hidden horses. Loading/error per existing feed patterns.
* **No odds anywhere.**

## Guardrails

BFF only (httpOnly cookies; no backend URL/token in browser). Content gated `subscription.status ∈ {trial, active}` → 402. RLS applies (user client). No odds/betting identifiers.

## Design

Mockups per `.rx/mockups.md`: `web/screens/07-horse-profile.html` (verified: "Next race" card with Barrier + Jockey) and `web/screens/06-explore.html` (verified: "Racing today" band). Resolved location today: workspace `06-stage1-design/mockups/web/screens/` — the manifest's `docs/dev-handover/mockups/` relative path is stale (flagged for the manifest owner).
**Mockup gap (do not invent layout):** the `Nominated` state has no mockup backing (mockups predate the nomination decision). Locked treatment: the confirmed-runner card with a "Nominated" label, barrier/jockey omitted.

## Acceptance

* Route tests: 401 unauth; 402 lapsed; happy shape; scratched excluded from `next` and `record`; race-day route returns only followed horses' confirmed runners today.
* UI: nominated, confirmed, and empty states render.
* `npm test` green.

## Out of scope

Mobile (own epic). W5 feed routes / ranking. Trials display. Admin surfaces.
