"use client";

// TrainersGrid — the Trainers browse screen's client half (pattern-based, no
// mockup). Mirrors the W7 HorsesGrid: a plain RLS-scoped supabaseBrowser read
// (trainer_select_sub gates to content-access), sorted A-Z by name, each card
// showing display_name || name, stable · location, and the trainer's active horse
// count. Never reads trainer_contact (admin-only PII).
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";

type TrainerRow = {
  id: string;
  name: string;
  display_name: string | null;
  stable_name: string | null;
  location: string | null;
  horses: { count: number }[] | null;
};
type TrainerCardVM = { id: string; title: string; subtitle: string; horseCount: number };

function initials(title: string): string {
  return title.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";
}

export function TrainersGrid({ viewerId }: { viewerId: string }) {
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

      const { data: sub } = await sb.from("subscription").select("status").eq("user_id", viewerId).maybeSingle();
      if (!sub || !["trial", "active"].includes(sub.status)) {
        if (!cancelled) { setGated(true); setLoading(false); }
        return;
      }

      // horse:trainer_id(count) returns the trainer's active horse count via RLS
      // (horse_select_sub gates the join to active + content-access rows).
      const { data, error: fetchError } = await sb
        .from("trainer")
        .select("id, name, display_name, stable_name, location, horses:horse!trainer_id(count)")
        .order("name");

      if (cancelled) return;
      if (fetchError) { setError(true); setLoading(false); return; }

      const mapped: TrainerCardVM[] = ((data ?? []) as TrainerRow[]).map((t) => ({
        id: t.id,
        title: t.display_name || t.name,
        subtitle: [t.stable_name, t.location].filter(Boolean).join(" · "),
        horseCount: t.horses?.[0]?.count ?? 0,
      }));
      setTrainers(mapped);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [viewerId]);

  return (
    <div className="page-pad">
      <h1 className="section-title-web">Trainers</h1>

      {gated && (
        <div className="aside-card">
          <h3>Your trial has ended.</h3>
          <p style={{ color: "var(--muted)", marginBottom: 16 }}>Reactivate your subscription to browse trainers.</p>
          <a className="btn btn-primary" href="/checkout">Reactivate</a>
        </div>
      )}

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
