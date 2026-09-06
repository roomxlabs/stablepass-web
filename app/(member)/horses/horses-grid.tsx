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
import { BrowseFilter, type BrowseFilterValue } from "@/components/browse-filter";
import { BROWSE_PAGE_SIZE } from "@/lib/browse";

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
  const [filter, setFilter] = useState<BrowseFilterValue>("all");
  // Latches true after the first subscription read resolves, so the pills are
  // never painted before we know whether this member is walled.
  const [gateChecked, setGateChecked] = useState(false);
  // Distinguishes "follows nothing" from "follows horses, none available" —
  // the two produce the same empty roster but are different sentences.
  const [followsNothing, setFollowsNothing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(false);
      setGated(false);
      setFollowsNothing(false);
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
      if (cancelled) return;
      setGateChecked(true);
      if (!hasAccess(sub as AccessRow | null)) {
        setGated(true); setLoading(false);
        return;
      }

      // "Following" — the horses this viewer follows. Read the ids first so the
      // roster query can be scoped with `.in("id", ids)`, exactly as mobile's
      // `listHorses({ followedIds })` does.
      //
      // A FAILED read is not "follows nothing" (the same rule explore-feed.tsx
      // spells out for its follow pills): treating an error as an empty set
      // would render the "not following anything yet" copy to a member who
      // follows plenty. Only a successful read may answer the question.
      let followedIds: string[] | null = null;
      if (filter === "following") {
        const { data: followRows, error: followError } = await sb
          .from("follow")
          .select("horse_id")
          .eq("user_id", viewerId)
          .not("horse_id", "is", null);
        if (cancelled) return;
        if (followError) { setError(true); setLoading(false); return; }
        followedIds = [
          ...new Set(
            ((followRows ?? []) as { horse_id: string | null }[])
              .map((r) => r.horse_id)
              .filter((id): id is string => Boolean(id)),
          ),
        ];
        // Short-circuit: `.in("id", [])` is a wasted round trip whose answer we
        // already know, and it is the common case for a member who follows
        // nobody (mobile's `browseReadHitsNetwork` makes the same call).
        if (followedIds.length === 0) { setFollowsNothing(true); setHorses([]); setLoading(false); return; }
      }

      let query = sb
        .from("horse")
        .select("id, display_name, racing_name, trainer:trainer_id(name)")
        .eq("status", "active");

      // ENG-960 / R8: the ENG-831 `.eq("shares_for_sale", false)` exclusion is
      // GONE. Round 8 reversed the segregation — for-sale horses fold back into
      // "All" — and the old rule was a live bug: a stable whose horses are all
      // for sale rendered an EMPTY browse grid and an empty roster. The Shares
      // TAB remains the only *list of for-sale horses as such*; browse is not
      // that list. Mobile made the same reversal in `lib/browse.ts` (default
      // scope = every active horse, INCLUDING for-sale) and `lib/profiles.ts`
      // (`getTrainerHorses`).
      if (followedIds) query = query.in("id", followedIds);

      const { data, error: fetchError } = await query
        .order("display_name")
        .limit(BROWSE_PAGE_SIZE);

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
  }, [viewerId, filter]);

  return (
    <div className="page-pad">
      <h1 className="section-title-web">Horses</h1>

      {/* Hidden behind the wall: the pills drive a gated read, so offering them
          to a lapsed member would just re-run the query that produced the wall.
          Gated on `gateChecked`, NOT on `loading`: `gated` starts false, so
          rendering on `!gated` alone flashes the pills at a lapsed member for
          one frame before the AccessWall replaces them. `gateChecked` latches
          true after the first subscription read and stays true, so switching
          filters later never makes the control disappear under the cursor. */}
      {gateChecked && !gated && <BrowseFilter value={filter} onChange={setFilter} />}

      {gated && <AccessWall everSubscribed={everSubscribed} />}

      {!gated && error && <p style={{ color: "var(--muted)", padding: "24px 0" }}>Couldn&rsquo;t load horses.</p>}

      {!gated && !error && !loading && horses.length === 0 && (
        <p style={{ color: "var(--muted)", padding: "24px 0" }}>
          {/* Three different empty states, not one. "You follow nothing" is a
              claim about the VIEWER — saying it when they follow horses that
              are merely unavailable (retired, hidden, RLS-invisible) is simply
              false, so that case gets its own wording. */}
          {filter !== "following"
            ? "No horses yet — check back soon."
            : followsNothing
              ? "You’re not following any horses yet."
              : "None of the horses you follow are available right now."}
        </p>
      )}

      {/* `!loading` matters now that `filter` can change: without it, switching
          to Following keeps the previous filter's full roster on screen through
          two sequential round trips (the follow read, then the horse read),
          under a pill that already reads aria-pressed="true". That is a
          wrong-answer render, not a flicker. */}
      {!gated && !error && !loading && horses.length > 0 && (
        <div className="onboarding-grid-web">
          {horses.map((h) => (
            <HorseCard key={h.id} horse={h} onClick={() => router.push(`/horses/${h.id}`)} />
          ))}
        </div>
      )}
    </div>
  );
}
