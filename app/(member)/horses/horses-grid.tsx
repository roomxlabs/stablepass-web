"use client";

// HorsesGrid — the Horses browse screen's client half (pattern-based, no
// confirmed mockup). Mirrors the W6 explore-feed client-fetch/enrich pattern:
// a plain RLS-scoped supabaseBrowser read (horse_select_sub gates to
// active + content-access), mapped onto the shared HorseSummary view model and
// rendered with the reused W4 <HorseCard> in the onboarding grid's skin.
import { useCallback, useEffect, useRef, useState } from "react";
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

/**
 * One page of the browse grid.
 *
 * This read used to carry no `.range` at all, so opening Horses downloaded
 * EVERY active horse — plus an embedded trainer join per row — before the first
 * card painted. Paging it needs a TOTAL order: `display_name` alone leaves ties
 * broken by whatever the planner happens to return, and a tie ordered
 * differently between two requests silently drops or duplicates a row across the
 * `.range` boundary. `id` is the tiebreaker, so the two windows can never
 * disagree.
 */
export const HORSES_PAGE_SIZE = 60;

// `everSubscribed` — see the note in ../explore/explore-feed.tsx (server-resolved
// boolean; the Stripe id never reaches the browser).
export function HorsesGrid({ viewerId, everSubscribed }: { viewerId: string; everSubscribed: boolean }) {
  const router = useRouter();
  const [horses, setHorses] = useState<HorseSummary[]>([]);
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

    if (offset === 0) {
      setLoading(true);
      setError(false);
      setGated(false);
    } else {
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

    const { data, error: fetchError } = await sb
      .from("horse")
      .select("id, display_name, racing_name, trainer:trainer_id(name)")
      .eq("status", "active")
      // ENG-831: for-sale horses live only on Shares — never in Horses browse.
      .eq("shares_for_sale", false)
      .order("display_name")
      .order("id")
      .range(offset, offset + HORSES_PAGE_SIZE - 1);

    if (!live()) return;
    if (fetchError) { setError(true); setLoading(false); setLoadingMore(false); return; }

    const mapped: HorseSummary[] = ((data ?? []) as HorseRow[]).map((h) => {
      const trainer = one(h.trainer);
      // Formatted per side of the `||` so a `racing_name` of just "(AUS)"
      // falls through to the display name (ENG-761 item 6).
      return { id: h.id, name: displayHorseNameOrEmpty(h.racing_name) || displayHorseNameOrEmpty(h.display_name), trainerName: trainer?.name ?? "Stablepass" };
    });
    setHorses((prev) => (offset === 0 ? mapped : [...prev, ...mapped]));
    // A short page is definitively the last one. A full page only MIGHT be, and
    // without a `count` the only way to settle it is the next request — which is
    // exactly what pressing the button does.
    setHasMore(mapped.length === HORSES_PAGE_SIZE);
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
      <h1 className="section-title-web">Horses</h1>

      {gated && <AccessWall everSubscribed={everSubscribed} />}

      {!gated && error && <p style={{ color: "var(--muted)", padding: "24px 0" }}>Couldn&rsquo;t load horses.</p>}

      {!gated && !error && !loading && horses.length === 0 && (
        <p style={{ color: "var(--muted)", padding: "24px 0" }}>No horses yet — check back soon.</p>
      )}

      {!gated && !error && horses.length > 0 && (
        <>
          <div className="onboarding-grid-web">
            {horses.map((h) => (
              <HorseCard key={h.id} horse={h} onClick={() => router.push(`/horses/${h.id}`)} />
            ))}
          </div>
          {hasMore && (
            <button
              type="button"
              className="btn btn-light"
              style={{ margin: "24px auto 0", display: "block" }}
              disabled={loadingMore}
              onClick={() => fetchPage(horses.length)}
            >
              {loadingMore ? "Loading…" : "Show more"}
            </button>
          )}
        </>
      )}
    </div>
  );
}
