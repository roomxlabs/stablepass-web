// Server-side media transport for the server-rendered first page of /explore
// (ENG-1593).
//
// The browser mints through the BFF (`/api/posts/media`, `/api/posts/:id/
// playback`). A server component cannot usefully call its own BFF over HTTP —
// that is a second trip through the same process for the same answer — so it
// calls the SAME be edge functions those two routes call, with the SAME body
// they send, via `edgeFetch`:
//
//   - AS THE MEMBER. `edgeFetch` forwards the session's own JWT, never an
//     elevated key, so the mint runs under the member's RLS and the edge
//     functions' own content gate. A lapsed member gets the same 402 here that
//     the BFF would have relayed, and `resolvePostDisplayUrls` turns it into
//     PostMediaError('gated') exactly as it does for the browser.
//   - POST IDS ONLY. The bodies are built here from ids, mirroring the BFF's
//     rebuilt-not-spread outbound bodies; nothing a client sent is forwarded,
//     because no client is involved.
//
// Server-only (the Supabase client it takes is the cookie-bound server client).
import type { SupabaseClient } from "@supabase/supabase-js";

import { edgeFetch } from "@/lib/api/edge";
import type { PostMediaTransport } from "@/lib/api/post-media";

export function edgePostMediaTransport(sb: SupabaseClient): PostMediaTransport {
  return {
    batch: (postIds) => edgeFetch(sb, "post-media", { method: "POST", body: { postIds } }),
    poster: (postId) => edgeFetch(sb, "playback", { method: "POST", body: { postId, posterOnly: true } }),
  };
}
