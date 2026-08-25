import { supabaseServer } from "@/lib/supabase/server";
import { ok, UNAUTH, GATED, fail } from "@/lib/api/envelope";
import { edgeFetch } from "@/lib/api/edge";

// POST /api/posts/media — mint signed photo/voice URLs via the be `post-media`
// edge function. Never holds a service key and never signs itself.
//
// TWO MODES, mirroring the edge function's own dispatch (ENG-815):
//   { postIds: string[] }    batch — slide 0 + slideCount per post
//   { postId, slideIndex }   one carousel slide, by ordinal
//
// WHAT THIS HANDLER GUARANTEES, and why each half matters:
//
// 1. IT FORWARDS THE CALLER'S TOKEN, never an elevated key. `edgeFetch` sends
//    the session's JWT, so the mint runs under the caller's own RLS and a
//    draft's objects are unreachable because Postgres says so — not because
//    this file remembered to check. Handing it an elevated key instead would
//    make every draft's slides mintable by any member; it is the single most
//    damaging edit that could be made here, and it would still pass a naive
//    behavioural test. `test/post-media-route.test.ts` greps THIS FILE for that
//    word, which is why the paragraph avoids spelling it out.
//
// 2. IT FORWARDS ONLY RECOGNISED KEYS. The outbound body is REBUILT from the
//    two modes below rather than passed through, so a `path` / `paths` / bucket
//    key in the client body cannot reach the edge function even though the
//    function also ignores them. Two independent refusals, and this one is the
//    cheap one to keep honest: addressing is by post id and ordinal, full stop.
export async function POST(req: Request) {
  const sb = await supabaseServer();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return UNAUTH();

  let body: Record<string, unknown> | null = null;
  try {
    const parsed = await req.json();
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    body = null;
  }
  if (!body) {
    return fail("invalid_request", "Expected { postIds: string[] } or { postId, slideIndex }.", 400);
  }

  // Mode is chosen by which key is present, exactly as the edge function does.
  // Carrying BOTH or NEITHER is a 400 rather than a silent pick: an ambiguous
  // body must never have a mode guessed for it.
  const wantsBatch = "postIds" in body;
  const wantsSlide = "postId" in body || "slideIndex" in body;
  if (wantsBatch === wantsSlide) {
    return fail("invalid_request", "Expected { postIds: string[] } or { postId, slideIndex }.", 400);
  }

  // Rebuilt, NOT spread. This is what makes "post ids only" a property of the
  // BFF and not merely of the edge function.
  const outbound = wantsSlide
    ? { postId: body.postId, slideIndex: body.slideIndex }
    : { postIds: body.postIds };

  const res = await edgeFetch(sb, "post-media", { method: "POST", body: outbound });
  if (res.status === 402) return GATED();
  if (res.status === 400) return fail("invalid_request", "Invalid post-media request.", 400);
  if (!res.ok) return fail("post_media_failed", "Could not load post media.", 502);
  const json = await res.json();
  return ok(json.data);
}
