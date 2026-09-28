// The signed-in member for THIS request, verified once (ENG-1593).
//
// WHY IT EXISTS. The member layout and the page under it each called
// `supabase.auth.getUser()` — a network round trip to the auth server — one
// after the other, on every member page load. React's per-request `cache()`
// collapses them into ONE call: the layout pays for it, and every server
// component below it in the same render reuses the answer for free.
//
// WHY `getUser()` AND NOT `getClaims()`. The layout is the member space's auth
// gate, and single-device login (guardrail 5) revokes the previous session when
// the member signs in elsewhere. `getUser()` asks the auth server, so a revoked
// session is refused on the very next load. `getClaims()` verifies the JWT
// locally and would keep a revoked session alive until the token expires — it
// only answers "who", never "still valid". With the call cached, the page
// needs no id-only shortcut at all: its answer is already in hand, verified.
//
// Server-only: `supabaseServer()` reads the request's cookies.
import { cache } from "react";
import type { User } from "@supabase/supabase-js";

import { supabaseServer } from "@/lib/supabase/server";

export const getViewer = cache(async (): Promise<User | null> => {
  const sb = await supabaseServer();
  const {
    data: { user },
  } = await sb.auth.getUser();
  return user ?? null;
});
