"use client";

// TrainersGrid — the Trainers browse screen's client half (pattern-based, no
// mockup). Mirrors the W7 HorsesGrid: a plain RLS-scoped supabaseBrowser read
// (trainer_select_sub gates to content-access), sorted A-Z by name, each card
// showing display_name || name, stable · location, and the trainer's active horse
// count. Never reads trainer_contact (admin-only PII).
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ACCESS_COLUMNS, hasAccess, type AccessRow } from "@/lib/api/access";
import { AccessWall } from "@/components/access-wall";
import { supabaseBrowser } from "@/lib/supabase/client";

type TrainerRow = {
  id: string;
  name: string;
  display_name: string | null;
  stable_name: string | null;
  location: string | null;
  // ENG-831: count non-sale horses only — for-sale horses are Shares-only.
  horses: { id: string; shares_for_sale: boolean }[] | null;
};
type TrainerCardVM = { id: string; title: string; subtitle: string; horseCount: number };

function initials(title: string): string {
  return title.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";
}

// `everSubscribed` — see the note in ../explore/explore-feed.tsx (server-resolved
// boolean; the Stripe id never reaches the browser).
export function TrainersGrid({ viewerId, everSubscribed }: { viewerId: string; everSubscribed: boolean }) {
  const router = useRouter();
  const [trainers, setTrainers] = useState<TrainerCardVM[]>([]);
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

      // horse:trainer_id returns the trainer's horses via RLS. We count only
      // shares_for_sale=false (ENG-831) so for-sale horses never inflate browse.
      const { data, error: fetchError } = await sb
        .from("trainer")
        .select("id, name, display_name, stable_name, location, horses:horse!trainer_id(id, shares_for_sale)")
        .order("name");

      if (cancelled) return;
      if (fetchError) { setError(true); setLoading(false); return; }

      const mapped: TrainerCardVM[] = ((data ?? []) as TrainerRow[]).map((t) => ({
        id: t.id,
        title: t.display_name || t.name,
        subtitle: [t.stable_name, t.location].filter(Boolean).join(" · "),
        horseCount: (t.horses ?? []).filter((h) => !h.shares_for_sale).length,
      }));
      setTrainers(mapped);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [viewerId]);

  return (
    <div className="page-pad">
      <h1 className="section-title-web">Trainers</h1>

      {gated && <AccessWall everSubscribed={everSubscribed} />}

      {!gated && error && <p style={{ color: "var(--muted)", padding: "24px 0" }}>Couldn&rsquo;t load trainers.</p>}

      {!gated && !error && !loading && trainers.length === 0 && (
        <p style={{ color: "var(--muted)", padding: "24px 0" }}>No trainers yet — check back soon.</p>
      )}

      {!gated && !error && trainers.length > 0 && (
        <div className="onboarding-grid-web">
          {trainers.map((t) => (
            <button key={t.id} type="button" className="trainer-card-web" onClick={() => router.push(`/trainers/${t.id}`)}>
              <div className="trainer-thumb" aria-hidden="true">{initials(t.title)}</div>
              <div>
                <p className="trainer-name">{t.title}</p>
                {t.subtitle && <p className="trainer-sub">{t.subtitle}</p>}
              </div>
              <div className="trainer-meta">{t.horseCount} {t.horseCount === 1 ? "horse" : "horses"}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
