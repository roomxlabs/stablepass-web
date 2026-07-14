"use client";

// HorsesGrid — the Horses browse screen's client half (pattern-based, no
// confirmed mockup). Mirrors the W6 explore-feed client-fetch/enrich pattern:
// a plain RLS-scoped supabaseBrowser read (horse_select_sub gates to
// active + content-access), mapped onto the shared HorseSummary view model and
// rendered with the reused W4 <HorseCard> in the onboarding grid's skin.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { HorseCard } from "@/components/horse-card";
import { supabaseBrowser } from "@/lib/supabase/client";
import type { HorseSummary } from "@/components/types";

type Trainer = { name: string };
type HorseRow = { id: string; display_name: string; racing_name: string | null; trainer: Trainer | Trainer[] | null };

function one<T>(v: T | T[] | null): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

export function HorsesGrid({ viewerId }: { viewerId: string }) {
  const router = useRouter();
  const [horses, setHorses] = useState<HorseSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [gated, setGated] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(false);
      setGated(false);
      const sb = supabaseBrowser();

      const { data: sub } = await sb.from("subscription").select("status").eq("user_id", viewerId).maybeSingle();
      if (!sub || !["trial", "active"].includes(sub.status)) {
        if (!cancelled) { setGated(true); setLoading(false); }
        return;
      }

      const { data, error: fetchError } = await sb
        .from("horse")
        .select("id, display_name, racing_name, trainer:trainer_id(name)")
        .eq("status", "active")
        .order("display_name");

      if (cancelled) return;
      if (fetchError) { setError(true); setLoading(false); return; }

      const mapped: HorseSummary[] = ((data ?? []) as HorseRow[]).map((h) => {
        const trainer = one(h.trainer);
        return { id: h.id, name: h.racing_name || h.display_name, trainerName: trainer?.name ?? "Stablepass" };
      });
      setHorses(mapped);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [viewerId]);

  return (
    <div className="page-pad">
      <h1 className="section-title-web">Horses</h1>

      {gated && (
        <div className="aside-card">
          <h3>Your trial has ended.</h3>
          <p style={{ color: "var(--muted)", marginBottom: 16 }}>Reactivate your subscription to browse horses.</p>
          <a className="btn btn-primary" href="/checkout">Reactivate</a>
        </div>
      )}

      {!gated && error && <p style={{ color: "var(--muted)", padding: "24px 0" }}>Couldn&rsquo;t load horses.</p>}

      {!gated && !error && !loading && horses.length === 0 && (
        <p style={{ color: "var(--muted)", padding: "24px 0" }}>No horses yet — check back soon.</p>
      )}

      {!gated && !error && horses.length > 0 && (
        <div className="onboarding-grid-web">
          {horses.map((h) => (
            <HorseCard key={h.id} horse={h} onClick={() => router.push(`/horses/${h.id}`)} />
          ))}
        </div>
      )}
    </div>
  );
}
