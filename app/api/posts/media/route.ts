import { supabaseServer } from "@/lib/supabase/server";
import { ok, UNAUTH, GATED, fail } from "@/lib/api/envelope";
import { edgeFetch } from "@/lib/api/edge";

// POST /api/posts/media — mint signed photo/voice URLs for a batch of post ids
// via the be `post-media` edge function. Sends post ids only (never a storage
// path). Never holds a service key and never signs itself.
export async function POST(req: Request) {
  const sb = await supabaseServer();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return UNAUTH();

  let postIds: unknown;
  try {
    const body = await req.json();
    postIds = body?.postIds;
  } catch {
    return fail("invalid_request", "Expected { postIds: string[] }.", 400);
  }

  const res = await edgeFetch(sb, "post-media", {
    method: "POST",
    body: { postIds },
  });
  if (res.status === 402) return GATED();
  if (res.status === 400) return fail("invalid_request", "Invalid post-media request.", 400);
  if (!res.ok) return fail("post_media_failed", "Could not load post media.", 502);
  const json = await res.json();
  return ok(json.data);
}
