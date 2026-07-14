// Root route — no screen of its own. Sends visitors to the feed if they have a
// session, otherwise to sign in.
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";

export default async function Home() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (user) redirect("/explore");
  redirect("/signin");
}
