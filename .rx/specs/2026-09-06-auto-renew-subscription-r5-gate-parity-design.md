# ENG-1029 · R5 · web · Gate parity and the banner

**Epic:** ENG-1022 · **Base branch:** `feature/pricing-v1` · **Blocked by:** ENG-1025

`lib/api/access.ts` is the **third** copy of the gate (ENG-1025 owns the SQL and the edge copy). If
it keeps the strict rule while the backend grants a grace, a member in the renewal window gets
content from RLS and a 402 envelope from the BFF — the split-brain ENG-577 existed to remove.

## Changes

- `hasAccess()`: `active` gets `+ 3 days`; `canceled` stays strict. **They stop sharing a branch** —
  a renewing period end is expected to move, a cancelled one is a real ending and three free days
  past it is a bug the member notices on their last day. `NaN` still fails closed. Update the header.
- `expiry-banner.tsx`: `expiryEndsAt()` returns a date **only for `canceled`**. Under auto-renew
  `current_period_end` is a renewal, so an active member would otherwise be told "Your access ends
  in 3 days" every month, forever. For a cancelled member the sentence is exactly right — keep it.
- **No "renewing soon" banner.** A renewal is not news; monthly notification of it is nagging.

Everything else stays: the banner keeps calling `hasAccess()` rather than re-deriving entitlement,
keeps the `Math.ceil` convention shared with the account screen, and keeps its date-keyed dismissal.

## Surface

```
lib/api/access.ts + test
app/(member)/expiry-banner.tsx + test
```

## Acceptance

`active` +1d → true; +4d → false; null → true · `canceled` future → true; past → false · `lapsed` →
false · unparseable → false · matrix matches ENG-1025's SQL row for row · **active member sees no
banner** · cancelled inside 7 days sees it · dismissal re-arms on a date change.
