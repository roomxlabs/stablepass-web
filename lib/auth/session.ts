// Small reusable session helpers on top of the Supabase server client.
// The member layout inlines its own check (leave that as-is) — this is for
// route handlers / pages that just need "who is signed in".
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";

export async function getSessionUser() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  return user;
}

export async function requireUser() {
  const user = await getSessionUser();
  if (!user) redirect("/signin");
  return user;
}
