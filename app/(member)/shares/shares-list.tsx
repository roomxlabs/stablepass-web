"use client";

// SharesList — /shares is a LIST OF FOR-SALE HORSES, never a feed (ENG-956).
//
// WHAT THIS REPLACES AND WHY. R8 (ENG-861/867) moved shares posts into the main
// feed and stopped honouring `shares=true` on the be feed fn, so the old
// `SharesFeed` -> `/api/feed/shares` screen rendered EXACTLY what /explore
// renders — a live bug. Mobile rebuilt the tab as a list of active horses with
// `shares_for_sale = true` plus the disclaimer card (ENG-870); this is the web
// port of that screen.
//
// SOURCE OF TRUTH: stablepass-mobile. The read mirrors `lib/browse.ts`
// `listHorses({ scope: 'shares' })` (NOT `listSharesHorses` — the ticket cites a
// symbol that does not exist in the mobile tree; the real read is the scoped
// browse one) and the row mirrors `src/components/horse-row.tsx`. The empty
// state's copy is mobile's `feed-horses-empty-shares`, word for word.
//
// DATA REALITY: a plain RLS-scoped `supabaseBrowser` read, same shape as the
// Horses browse grid — `horse_select_sub` gates it to active + content-access.
// Public columns ONLY: no owner PII, no price column, and the single outbound
// link target is the trainer's public `website_url`.
import { useEffect, useState } from "react";
import Link from "next/link";
import { ACCESS_COLUMNS, hasAccess, type AccessRow } from "@/lib/api/access";
import { AccessWall } from "@/components/access-wall";
import { SharesDisclaimer } from "@/components/shares-disclaimer";
import { supabaseBrowser } from "@/lib/supabase/client";
import { displayHorseNameOrEmpty } from "@/lib/format/horse-name";
import styles from "./shares-list.module.css";

// The exact projection is load-bearing in BOTH directions (see .rx/gotchas.md):
// too narrow starves the row, and naming an undeployed column hard-fails the
// WHOLE query with 42703. Every column here is already read elsewhere on this
// base — `shares_for_sale`/`racing_name` by the Horses grid, `training_status`
// by `lib/horse/profile.ts`, `website_url` by the trainer profile.
/**
 * Cap on the list — a large for-sale roster must not become an unbounded read.
 * Mirrors mobile's `BROWSE_PAGE_SIZE` (`lib/browse.ts:24`), which bounds the
 * very same scoped read there. There is no pagination on this screen on either
 * platform; if the for-sale list ever approaches this, both need paging, not a
 * bigger number.
 */
export const SHARES_PAGE_SIZE = 100;

export const SHARES_HORSE_SELECT =
  "id, display_name, racing_name, training_status, trainer:trainer_id(id, name, website_url)";

type TrainerEmbed = { id: string; name: string; website_url: string | null };
type HorseRow = {
  id: string;
  display_name: string | null;
  racing_name: string | null;
  training_status: string | null;
  trainer: TrainerEmbed | TrainerEmbed[] | null;
};

export type SharesHorse = {
  id: string;
  name: string;
  trainerId: string | null;
  trainerName: string;
  websiteUrl: string | null;
  statusLabel: string;
  trainingStatus: string | null;
};

function one<T>(v: T | T[] | null): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

/**
 * `training_status` -> the pill's label. A straight port of mobile's
 * `lib/browse.ts` `statusLabelOf`, including its legacy spellings: the 1 Sep
 * 2026 migration merged `farm_training`/`city_training` into `in_training`, and
 * a stale row must not render a raw enum at a member.
 *
 * An UNMAPPED status returns "" and renders NO pill at all — the meta column
 * then closes up rather than reserving a line for a chip that is not there.
 */
export function sharesStatusLabel(trainingStatus: string | null | undefined): string {
  switch (trainingStatus) {
    case "racing":
      return "Racing";
    case "spelling":
      return "Spelling";
    case "breaking_in":
      return "Breaking in";
    case "retired":
      return "Retired";
    case "pre_training":
      return "Pre-training";
    case "in_training":
    case "farm_training":
    case "city_training":
      return "In training";
    default:
      return "";
  }
}

/**
 * Only absolute http(s) URLs are linkable. `trainer.website_url` is an
 * unconstrained `text` column, so a bare domain ("wallerracing.com.au") would
 * otherwise render as a RELATIVE href and resolve to /shares/wallerracing.com.au.
 * Validate with `URL`, return the ORIGINAL trimmed string — writing back
 * `url.href` normalises and rewrites what the admin entered.
 *
 * Same rule as `WebsiteLink` (ENG-274), whose `safeHref` this mirrors. (The post
 * card had its own copy for the shares CTA; ENG-956 deleted that CTA.)
 */
export function safeSharesWebsiteHref(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const { protocol } = new URL(trimmed);
    return protocol === "http:" || protocol === "https:" ? trimmed : null;
  } catch {
    return null;
  }
}

function logWebsiteClick(trainerId: string) {
  // Fire-and-forget — the existing ENG-274 BFF. Never awaited and never allowed
  // to block or defer the navigation, so a slow log cannot cost the member the
  // click; `keepalive` lets it survive the page losing focus to the new tab.
  void fetch(`/api/trainers/${trainerId}/website-click`, {
    method: "POST",
    keepalive: true,
  }).catch(() => {
    /* best-effort; never surfaced */
  });
}

const ExternalLinkIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M14 4h6v6" />
    <path d="M20 4 12 12" />
    <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </svg>
);

export function mapSharesHorses(rows: HorseRow[]): SharesHorse[] {
  return rows
    .map((row) => {
      const trainer = one(row.trainer);
      return {
        id: row.id,
        // Formatted per side of the `||` so a `racing_name` of just "(AUS)"
        // falls through to the display name (ENG-761 item 6).
        name:
          displayHorseNameOrEmpty(row.racing_name) ||
          displayHorseNameOrEmpty(row.display_name) ||
          "Unnamed",
        trainerId: trainer?.id ?? null,
        trainerName: trainer?.name ?? "Stablepass",
        websiteUrl: trainer?.website_url ?? null,
        statusLabel: sharesStatusLabel(row.training_status),
        trainingStatus: row.training_status ?? null,
      };
    })
    // Sorted on the RESOLVED name, exactly as mobile does: the server can only
    // order by `display_name` (the "sire × dam" placeholder), which reads as
    // shuffled once horses carry racing names.
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function SharesList({ viewerId, everSubscribed }: { viewerId: string; everSubscribed: boolean }) {
  const [horses, setHorses] = useState<SharesHorse[]>([]);
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

      // The shared entitlement rule (`lib/api/access.ts`) — status alone is not
      // it: an `active` member whose `current_period_end` has passed must see
      // the wall, not an empty screen (ENG-585).
      const { data: sub, error: subError } = await sb
        .from("subscription")
        .select(ACCESS_COLUMNS)
        .eq("user_id", viewerId)
        .maybeSingle();
      // Fails CLOSED (below) — but log it, or a paying member walled by a
      // transient read failure looks identical to a genuinely lapsed one, with
      // nothing in the console. Same rule as the horse read further down.
      if (subError) console.error("shares subscription read failed", subError);
      if (!hasAccess(sub as AccessRow | null)) {
        if (!cancelled) {
          setGated(true);
          setLoading(false);
        }
        return;
      }

      const { data, error: fetchError } = await sb
        .from("horse")
        .select(SHARES_HORSE_SELECT)
        // Platform visibility — a disabled horse is never listed.
        .eq("status", "active")
        // THE screen's defining filter: /shares is the only list of for-sale
        // horses as such.
        .eq("shares_for_sale", true)
        .order("display_name")
        .limit(SHARES_PAGE_SIZE);

      if (cancelled) return;
      if (fetchError) {
        // Never discard the Supabase error: a 42703 from an undeployed column
        // lands in the same branch as "no for-sale horses" and would otherwise
        // be a silent, invisible blackout (.rx/gotchas.md).
        console.error("shares horse read failed", fetchError);
        setError(true);
        setLoading(false);
        return;
      }

      setHorses(mapSharesHorses((data ?? []) as unknown as HorseRow[]));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [viewerId]);

  return (
    <div className={styles.screen}>
      <div className={styles.head}>
        <h1 className={`section-title-web ${styles.title}`}>Shares</h1>
      </div>

      {/* A Shares-screen REQUIREMENT (Justin + Mel, 26 Aug meeting), not chrome:
          it renders above every state, gated included. */}
      <SharesDisclaimer />

      {gated && (
        <div className={styles.head}>
          <AccessWall everSubscribed={everSubscribed} />
        </div>
      )}

      {!gated && error && (
        <div className={styles.message} data-testid="shares-error">
          <h2 className={styles.messageTitle}>We couldn&rsquo;t load the horses</h2>
          <p className={styles.messageBody}>Check your connection and try again.</p>
        </div>
      )}

      {!gated && !error && loading && (
        <div data-testid="shares-loading" aria-hidden="true">
          <div className={styles.skeleton} />
          <div className={styles.skeleton} />
          <div className={styles.skeleton} />
        </div>
      )}

      {/* Mobile's `feed-horses-empty-shares` copy, unchanged. There is no "show
          all horses" action here: web's /shares has no filter pills to return to. */}
      {!gated && !error && !loading && horses.length === 0 && (
        <div className={styles.message} data-testid="shares-empty">
          <h2 className={styles.messageTitle}>No shares for sale right now</h2>
          <p className={styles.messageBody}>
            Horses with ownership shares for sale will show up here.
          </p>
        </div>
      )}

      {!gated && !error && horses.length > 0 && (
        <ul className={styles.list} data-testid="shares-list">
          {horses.map((h) => {
            const href = safeSharesWebsiteHref(h.websiteUrl);
            return (
              <li className={styles.row} key={h.id} data-testid={`shares-row-${h.id}`}>
                <Link className={styles.rowMain} href={`/horses/${h.id}`}>
                  {/* The initial on the MUTED ground — never the branded green
                      gradient; a column of green thumbnails reads as the app
                      having painted the screen green. */}
                  <span className={styles.thumb} aria-hidden="true">
                    {h.name.trim().charAt(0).toUpperCase() || "?"}
                  </span>
                  <span className={styles.meta}>
                    <span className={styles.name}>{h.name}</span>
                    <span className={styles.trainer}>{h.trainerName}</span>
                    {h.statusLabel && (
                      <span
                        className={`tag ${h.trainingStatus === "racing" ? "race-day" : "active"} ${styles.status}`}
                      >
                        {h.statusLabel}
                      </span>
                    )}
                  </span>
                </Link>

                {/* Absent entirely when the trainer has no absolute http(s) URL
                    — the same gate as WebsiteLink, rather than a dead control. */}
                {href && h.trainerId && (
                  <a
                    className={styles.website}
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => logWebsiteClick(h.trainerId!)}
                    // Middle-click "open in new tab" never fires onClick, so
                    // without this the metric silently undercounts. Guarded to
                    // button 1 specifically: auxclick fires for ANY non-primary
                    // button, and a right-click ("Copy link address") is not a
                    // visit.
                    onAuxClick={(e) => {
                      if (e.button === 1) logWebsiteClick(h.trainerId!);
                    }}
                  >
                    <ExternalLinkIcon /> Visit trainer website
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
