import { ok, UNAUTH, GATED } from "@/lib/api/envelope";
import { supabaseServer } from "@/lib/supabase/server";
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser(); if (!user) return UNAUTH();
  const { data: sub } = await sb.from("subscription").select("status").eq("user_id", user.id).single();
  if (!sub || !["trial","active"].includes(sub.status)) return GATED();
  const { data: trainer } = await sb.from("trainer").select("*").eq("id", id).single();
  const { data: horses } = await sb.from("horse").select("id,display_name,racing_name,training_status,photo_url").eq("trainer_id", id);
  return ok({ trainer, horses });
}
