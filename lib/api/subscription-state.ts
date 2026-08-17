// Server-side read of "what state is this member's subscription in", for the
// SCREENS (ENG-585).
//
// WHY IT IS A SEPARATE FILE FROM access.ts: `lib/api/access.ts` is imported by
// client components (app/(member)/expiry-banner.tsx) and must stay pure — no
// `supabaseServer`, no cookies, nothing that drags the server bundle into the
// browser. This file is the server half; access.ts stays the rule.
//
// WHY IT IS `cache()`d: seven server components now need this row (the account
// page, onboarding, the two profile pages and the three list-page shells that
// hand a boolean to their client island). React's per-request `cache` collapses
// them into ONE query per request instead of seven.
//
// It returns the two BOOLEANS the screens are allowed to see, never the row's
// `stripe_customer_id` — see the note in access.ts. `sub` is returned as well
// because the account page legitimately renders the dates.
import { cache } from "react";

import { supabaseServer } from "@/lib/supabase/server";
import {
  SUBSCRIPTION_COLUMNS,
  everSubscribed,
  hasAccess,
  type SubscriptionRow,
} from "./access";

export type SubscriptionState = {
  /** The raw row. Server-side only — do not hand this to a client component. */
  sub: SubscriptionRow | null;
  /** `hasAccess()` — the shared entitlement rule, NOT the raw status string. */
  entitled: boolean;
  /** `stripe_customer_id !== null` — has this member ever paid us? */
  everSubscribed: boolean;
};

export const readSubscriptionState = cache(
  async (userId: string): Promise<SubscriptionState> => {
    const sb = await supabaseServer();
    const { data } = await sb
      .from("subscription")
      .select(SUBSCRIPTION_COLUMNS)
      .eq("user_id", userId)
      .maybeSingle();

    const sub = (data ?? null) as SubscriptionRow | null;
    return {
      sub,
      // Fails CLOSED: no row, unreadable row or unparseable date all land on
      // `false` inside hasAccess, i.e. the wall — never optimistic content.
      entitled: hasAccess(sub),
      everSubscribed: everSubscribed(sub),
    };
  },
);
