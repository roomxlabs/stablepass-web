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
import { browseRange, splitBrowsePage } from "@/lib/browse";

type TrainerRow = {
  id: string;
  name: string;
  display_name: string | null;
  stable_name: string | null;
  location: string | null;
  // ENG-960 / R8: every active horse counts. `shares_for_sale` is no longer
  // selected or filtered here — see the note on the query below.
  horses: { id: string }[] | null;
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
  // Paging — same shape as HorsesGrid; see lib/browse.ts for the off-by-one.
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // See HorsesGrid: a failed page 2+ must not unmount the roster. This grid has
  // no pills, so a destructive `error` here is UNRECOVERABLE without a full
  // page reload — nothing else ever re-runs offset 0 for the life of the mount.
  const [pageError, setPageError] = useState(false);
  const runRef = useRef(0);

  const failPage = useCallback((offset: number) => {
    if (offset === 0) setError(true);
    else setPageError(true);
    setLoading(false);
    setLoadingMore(false);
  }, []);

  const fetchPage = useCallback(async (offset: number) => {
    const run = ++runRef.current;
    const live = () => runRef.current === run;

      if (offset === 0) {
        setLoading(true);
        setError(false);
        setGated(false);
        setHasMore(false);
        setPageError(false);
        setLoadingMore(false);
      } else {
        setPageError(false);
        setLoadingMore(true);
      }
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

      // horse:trainer_id returns the trainer's horses via RLS.
      //
      // ENG-960 / R8: the count no longer excludes `shares_for_sale` horses,
      // and the flag is no longer selected. This is the THIRD coupled site of
      // the same exclusion (with the type above and the filter below) — dropping
      // only the query column would have left the card reading "0 horses" for a
      // for-sale-only stable while the roster one click away, fixed in
      // trainers/[id]/page.tsx, listed them. A card that contradicts the screen
      // it links to is the same live bug, one step removed.
      //
      // KNOWN PARITY DIVERGENCE (flagged on ENG-960, not silently taken): mobile
      // `lib/browse.ts` still filters this one count (`browseCount = horses
      // .filter(h => !h.shares_for_sale)`), even though R8 swept the exclusion
      // out of `lib/profiles.ts` in the same round. So mobile currently shows
      // the same contradiction. We follow the ticket ("shares horses fold into
      // All and into the trainer roster") and web's own internal consistency;
      // whether mobile's browse count is a missed R8 sweep is a separate call.
      //
      // ACTIVE ONLY (Justin, 1 Sep 2026: "there is a deleted trainer... on
      // the website"). Admin "deletes" a trainer by flipping status to
      // 'onboarding', and `trainer_select_sub` does NOT filter status — mobile
      // adds this same filter in lib/browse.ts, and web never did, so removed
      // trainers stayed listed here. All four web trainer reads carry it now.
      const { data, error: fetchError } = await sb
        .from("trainer")
        .select("id, name, display_name, stable_name, location, horses:horse!trainer_id(id)")
        .eq("status", "active")
        // TOTAL order (`id` tiebreaker) — a `name` tie ordered differently
        // between two requests would drop or duplicate a trainer across the
        // `.range` boundary. `.range` is inclusive, so this asks for one row
        // more than we render; see BROWSE_FETCH_LIMIT in lib/browse.ts.
        .order("name")
        .order("id")
        .range(...browseRange(offset));

      if (!live()) return;
      if (fetchError) { failPage(offset); return; }

      const { page, hasMore: more } = splitBrowsePage((data ?? []) as TrainerRow[]);
      const mapped: TrainerCardVM[] = page.map((t) => ({
        id: t.id,
        title: t.display_name || t.name,
        subtitle: [t.stable_name, t.location].filter(Boolean).join(" · "),
        horseCount: (t.horses ?? []).length,
      }));
      setTrainers((prev) => (offset === 0 ? mapped : [...prev, ...mapped]));
      setHasMore(more);
      setLoading(false);
      setLoadingMore(false);
  }, [viewerId, failPage]);

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

      {!gated && !error && !loading && trainers.length > 0 && (
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
          {pageError && (
            <p role="alert" style={{ color: "var(--muted)", textAlign: "center", padding: "16px 0 0" }}>
              Couldn&rsquo;t load more trainers.
            </p>
          )}
          {hasMore && (
            <button
              type="button"
              className="btn-showmore"
              disabled={loadingMore}
              onClick={() => fetchPage(trainers.length)}
            >
              {loadingMore ? "Loading…" : pageError ? "Try again" : "Show more"}
            </button>
          )}
        </>
      )}
    </div>
  );
}
