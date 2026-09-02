"use client";

// TrainersGrid — the Trainers browse screen's client half (pattern-based, no
// mockup). Mirrors the W7 HorsesGrid: a plain RLS-scoped supabaseBrowser read
// (trainer_select_sub gates to content-access), sorted A-Z by name, each card
// showing display_name || name, stable · location, and the trainer's active horse
// count. Never reads trainer_contact (admin-only PII).
import { useCallback, useEffect, useRef, useState } from "react";
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

/**
 * One page of the browse grid. This read used to carry no `.range`, so opening
 * Trainers downloaded EVERY active trainer AND every one of their horses (the
 * embedded `horse!trainer_id` join) just to render a count per card.
 *
 * `.order("name")` alone is not a total order — ties fall to whatever the
 * planner returns, and a tie ordered differently between two requests drops or
 * duplicates a row across the `.range` boundary — so `id` is the tiebreaker.
 */
export const TRAINERS_PAGE_SIZE = 60;

// `everSubscribed` — see the note in ../explore/explore-feed.tsx (server-resolved
// boolean; the Stripe id never reaches the browser).
export function TrainersGrid({ viewerId, everSubscribed }: { viewerId: string; everSubscribed: boolean }) {
  const router = useRouter();
  const [trainers, setTrainers] = useState<TrainerCardVM[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [gated, setGated] = useState(false);
  const [error, setError] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  // Bumped on unmount so a page that lands late can't setState on a dead tree —
  // the same job the old `cancelled` closure flag did, kept across calls.
  const runRef = useRef(0);

  const fetchPage = useCallback(async (offset: number) => {
    const run = ++runRef.current;
    const live = () => runRef.current === run;
    if (offset === 0) { setLoading(true); setError(false); setGated(false); }
    else setLoadingMore(true);
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
      if (live()) { setGated(true); setLoading(false); setLoadingMore(false); }
      return;
    }

    // horse:trainer_id returns the trainer's horses via RLS. We count only
    // shares_for_sale=false (ENG-831) so for-sale horses never inflate browse.
    // ACTIVE ONLY (Justin, 1 Sep 2026: "there is a deleted trainer... on
    // the website"). Admin "deletes" a trainer by flipping status to
    // 'onboarding', and `trainer_select_sub` does NOT filter status — mobile
    // adds this same filter in lib/browse.ts, and web never did, so removed
    // trainers stayed listed here. All four web trainer reads carry it now.
    const { data, error: fetchError } = await sb
      .from("trainer")
      .select("id, name, display_name, stable_name, location, horses:horse!trainer_id(id, shares_for_sale)")
      .eq("status", "active")
      .order("name")
      .order("id")
      .range(offset, offset + TRAINERS_PAGE_SIZE - 1);

    if (!live()) return;
    if (fetchError) { setError(true); setLoading(false); setLoadingMore(false); return; }

    const mapped: TrainerCardVM[] = ((data ?? []) as TrainerRow[]).map((t) => ({
      id: t.id,
      title: t.display_name || t.name,
      subtitle: [t.stable_name, t.location].filter(Boolean).join(" · "),
      horseCount: (t.horses ?? []).filter((h) => !h.shares_for_sale).length,
    }));
    setTrainers((prev) => (offset === 0 ? mapped : [...prev, ...mapped]));
    // A short page is definitively the last one. A full page only MIGHT be,
    // and without a `count` the only way to settle it is the next request —
    // which is exactly what pressing the button does.
    setHasMore(mapped.length === TRAINERS_PAGE_SIZE);
    setLoading(false);
    setLoadingMore(false);
  }, [viewerId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch, not derived state
    fetchPage(0);
    return () => { runRef.current += 1; };
  }, [fetchPage]);

  return (
    <div className="page-pad">
      <h1 className="section-title-web">Trainers</h1>

      {gated && <AccessWall everSubscribed={everSubscribed} />}

      {!gated && error && <p style={{ color: "var(--muted)", padding: "24px 0" }}>Couldn&rsquo;t load trainers.</p>}

      {!gated && !error && !loading && trainers.length === 0 && (
        <p style={{ color: "var(--muted)", padding: "24px 0" }}>No trainers yet — check back soon.</p>
      )}

      {!gated && !error && trainers.length > 0 && (
        <>
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
          {hasMore && (
            <button
              type="button"
              className="btn btn-light"
              style={{ margin: "24px auto 0", display: "block" }}
              disabled={loadingMore}
              onClick={() => fetchPage(trainers.length)}
            >
              {loadingMore ? "Loading…" : "Show more"}
            </button>
          )}
        </>
      )}
    </div>
  );
}
