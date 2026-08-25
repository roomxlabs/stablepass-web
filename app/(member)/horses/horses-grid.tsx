"use client";

// HorsesGrid — the Horses browse screen's client half (pattern-based, no
// confirmed mockup). Mirrors the W6 explore-feed client-fetch/enrich pattern:
// a plain RLS-scoped supabaseBrowser read (horse_select_sub gates to
// active + content-access), mapped onto the shared HorseSummary view model and
// rendered with the reused W4 <HorseCard> in the onboarding grid's skin.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ACCESS_COLUMNS, hasAccess, type AccessRow } from "@/lib/api/access";
import { AccessWall } from "@/components/access-wall";
import { HorseCard } from "@/components/horse-card";
import { supabaseBrowser } from "@/lib/supabase/client";
import type { HorseSummary } from "@/components/types";
import { displayHorseNameOrEmpty } from "@/lib/format/horse-name";

type Trainer = { name: string };
type HorseRow = { id: string; display_name: string; racing_name: string | null; trainer: Trainer | Trainer[] | null };

function one<T>(v: T | T[] | null): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

// `everSubscribed` — see the note in ../explore/explore-feed.tsx (server-resolved
// boolean; the Stripe id never reaches the browser).
export function HorsesGrid({ viewerId, everSubscribed }: { viewerId: string; everSubscribed: boolean }) {
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

      const { data: sub } = await sb.from("subscription").select(ACCESS_COLUMNS).eq("user_id", viewerId).maybeSingle();
      // ENG-585: this was `!["trial","active"].includes(status)` on a
      // status-only select, so an `active` member whose `current_period_end`
      // had passed counted as entitled here, ran the read, got nothing back
      // (RLS denies them correctly) and saw an EMPTY screen instead of the
      // wall. `hasAccess()` is the shared rule (lib/api/access.ts) — pure and
      // client-safe, already imported this way by the expiry banner.
      //
      // Strictly stricter than the test it replaces: identical for entitled,
      // lapsed and canceled rows, and it additionally catches expired ones. It
      // can only wall MORE members, never reveal content to one.
      if (!hasAccess(sub as AccessRow | null)) {
        if (!cancelled) { setGated(true); setLoading(false); }
        return;
      }

      const { data, error: fetchError } = await sb
        .from("horse")
        .select("id, display_name, racing_name, trainer:trainer_id(name)")
        .eq("status", "active")
        // ENG-831: for-sale horses live only on Shares — never in Horses browse.
        .eq("shares_for_sale", false)
        .order("display_name");

      if (cancelled) return;
      if (fetchError) { setError(true); setLoading(false); return; }

      const mapped: HorseSummary[] = ((data ?? []) as HorseRow[]).map((h) => {
        const trainer = one(h.trainer);
        // Formatted per side of the `||` so a `racing_name` of just "(AUS)"
        // falls through to the display name (ENG-761 item 6).
        return { id: h.id, name: displayHorseNameOrEmpty(h.racing_name) || displayHorseNameOrEmpty(h.display_name), trainerName: trainer?.name ?? "Stablepass" };
      });
      setHorses(mapped);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [viewerId]);

  return (
    <div className="page-pad">
      <h1 className="section-title-web">Horses</h1>

      {gated && <AccessWall everSubscribed={everSubscribed} />}

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
