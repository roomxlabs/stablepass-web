import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Legal documents (ENG-590 / W4).
 *
 * Four public slugs, two real documents. `/legal/cancellation` and
 * `/legal/acceptable-use` 308 to `/legal/terms` because no distinct copy for
 * either exists — the signed-off mockup's footer points three of its four Legal
 * buttons at the same `data-sheet="terms"` overlay. Redirecting is honest;
 * inventing legal text is not, and this ticket does not write legal text.
 *
 * The prose lives in `content/legal/*.md`, never in JSX. Swapping in the
 * client's final wording has to be a one-file edit with no engineering, which
 * it cannot be if the copy is interleaved with markup.
 *
 * Read at BUILD time only. Every one of the four routes is prerendered
 * (`generateStaticParams` + `dynamicParams = false`), so nothing here runs on a
 * request in production. That matters: a legal page that goes dynamic defeats
 * the caching the marketing/member subdomain split exists to protect.
 */

/** Slugs that render a document of their own. */
export const LEGAL_DOCUMENT_SLUGS = ["privacy", "terms"] as const;
export type LegalDocumentSlug = (typeof LEGAL_DOCUMENT_SLUGS)[number];

/** Slugs that exist only to redirect onto a document that does exist. */
export const LEGAL_REDIRECT_SLUGS = ["cancellation", "acceptable-use"] as const;
export type LegalRedirectSlug = (typeof LEGAL_REDIRECT_SLUGS)[number];

export const LEGAL_REDIRECTS: Readonly<Record<LegalRedirectSlug, LegalDocumentSlug>> = {
  cancellation: "terms",
  "acceptable-use": "terms",
};

export type LegalSlug = LegalDocumentSlug | LegalRedirectSlug;

/** Every slug `/legal/[slug]` answers. Anything else is a genuine 404. */
export const LEGAL_SLUGS: readonly LegalSlug[] = [...LEGAL_DOCUMENT_SLUGS, ...LEGAL_REDIRECT_SLUGS];

/**
 * Canonical origin for the legal pages.
 *
 * The routes render on BOTH hosts — `stablepass.co/legal/*` and
 * `app.stablepass.co/legal/*` — which is what lets the signup form's RELATIVE
 * links resolve on the member host without touching `app/start/trial-start-form.tsx`.
 * The duplicate render needs one canonical URL for Apple, Stripe and search, and
 * the apex is it. Hard-coded rather than derived from the request precisely
 * because reading the host would make these pages dynamic.
 *
 * W5 (ENG-591) owns `lib/seo.ts` and the site-wide canonical helper; this stays
 * local until that lands, then folds into it.
 */
export const LEGAL_CANONICAL_ORIGIN = "https://stablepass.co";

export function legalPath(slug: string): string {
  return `/legal/${slug}`;
}

export function legalCanonicalUrl(slug: string): string {
  return `${LEGAL_CANONICAL_ORIGIN}${legalPath(slug)}`;
}

export function isLegalDocumentSlug(slug: string): slug is LegalDocumentSlug {
  return (LEGAL_DOCUMENT_SLUGS as readonly string[]).includes(slug);
}

export function isLegalRedirectSlug(slug: string): slug is LegalRedirectSlug {
  return (LEGAL_REDIRECT_SLUGS as readonly string[]).includes(slug);
}

/** The path a redirect slug points at, or `null` if the slug is not one. */
export function redirectTargetFor(slug: string): string | null {
  return isLegalRedirectSlug(slug) ? legalPath(LEGAL_REDIRECTS[slug]) : null;
}

/* ── the document model ──────────────────────────────────────────────── */

export type LegalBlock =
  | { kind: "heading"; level: 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: string[] };

export type LegalDocument = {
  slug: LegalDocumentSlug;
  /** Frontmatter `title` — the page's <h1>. */
  title: string;
  /** Frontmatter `lastUpdated`, an ISO `YYYY-MM-DD` date. */
  lastUpdated: string;
  blocks: LegalBlock[];
};

/* ── the markdown subset ─────────────────────────────────────────────── */

/**
 * A deliberately tiny markdown reader rather than a dependency.
 *
 * The ticket forbids adding a markdown library for two prose documents, and the
 * subset legal copy actually uses is small:
 *
 *   SUPPORTED   `##` / `###` headings, blank-line separated paragraphs
 *               (hard wrapping is joined), and `-` / `*` bullet lists.
 *   REJECTED    a single `#` (the title belongs in frontmatter, where the <h1>
 *               and the <title> read it from one place), numbered lists, nested
 *               bullets, horizontal rules, a heading or bullets glued to a
 *               paragraph without a blank line between them. Each throws with
 *               the offending line quoted — see parseBlocks.
 *   IGNORED     inline markup. Bold, italics and links are NOT interpreted;
 *               text renders verbatim and React escapes it, so `**foo**` would
 *               appear literally. This is the one silent limit, and it is
 *               visible in the output rather than silently wrong.
 *
 * If the client's final wording needs numbered clauses or inline formatting,
 * the build fails loudly on the next deploy and THAT is the moment to take a
 * real parser — not now, speculatively, for two documents.
 */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Strip surrounding quotes, but only when they really are a wrapper.
 * `"A" and "B"` is not a quoted string, and stripping its ends corrupts the
 * value into `A" and "B`.
 */
function unquote(value: string): string {
  const quoted = /^(["'])([\s\S]*)\1$/.exec(value);
  return quoted && !quoted[2].includes(quoted[1]) ? quoted[2] : value;
}

function parseFrontmatter(source: string, label: string): { fields: Map<string, string>; body: string } {
  const match = FRONTMATTER.exec(source);
  if (!match) throw new Error(`${label}: missing the --- frontmatter block`);

  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const separator = line.indexOf(":");
    if (separator === -1) throw new Error(`${label}: frontmatter line is not "key: value" — ${line}`);
    fields.set(line.slice(0, separator).trim(), unquote(line.slice(separator + 1).trim()));
  }
  return { fields, body: source.slice(match[0].length) };
}

/**
 * A shape check is not enough for the one field a page actually prints.
 * `2026-13-45` passes the regex and used to render "45 undefined 2026" onto a
 * legal page — a silent wrong answer in a file whose whole point is that a
 * non-engineer edits it, and a month/day transposition is the likeliest typo
 * there is. Round-trip through UTC so only real calendar dates survive.
 */
function assertRealIsoDate(value: string, label: string): void {
  if (!ISO_DATE.test(value)) {
    throw new Error(`${label}: "lastUpdated" must be an ISO date (YYYY-MM-DD), got "${value}"`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day
  ) {
    throw new Error(`${label}: "lastUpdated" is not a real calendar date: "${value}"`);
  }
}

/**
 * Loud beats wrong.
 *
 * Every construct this reader cannot represent THROWS rather than degrading
 * into a run-on paragraph. That is the deliberate trade for not taking a
 * markdown dependency: the client's final wording is meant to drop in as a
 * one-file edit, and the failure mode of a permissive reader is a legal page
 * that silently renders `1. First clause. 2. Second clause.` as one blob, or
 * eats a nested bullet. A build that fails with the offending line quoted is
 * recoverable in seconds; a legal page that quietly says the wrong thing is not.
 */
function parseBlocks(body: string, label: string): LegalBlock[] {
  const blocks: LegalBlock[] = [];

  for (const chunk of body.split(/\r?\n[ \t]*\r?\n/)) {
    // Keep the raw lines: indentation is what distinguishes a nested bullet,
    // and trimming first would silently flatten it.
    const raw = chunk.split(/\r?\n/).filter((line) => line.trim());
    if (raw.length === 0) continue;
    const lines = raw.map((line) => line.trim());

    const heading = /^(#{1,6})\s+(.*)$/.exec(lines[0]);
    if (heading) {
      const level = heading[1].length;
      if (level === 1) {
        throw new Error(`${label}: use the frontmatter "title" for the page heading, not "# ${heading[2]}"`);
      }
      if (level > 3) throw new Error(`${label}: heading level ${level} is not supported — use ## or ###`);
      if (lines.length > 1) throw new Error(`${label}: put a blank line after the heading "${heading[2]}"`);
      // Closed ATX headings ("## Text ##") are valid markdown; drop the tail.
      blocks.push({ kind: "heading", level: level as 2 | 3, text: heading[2].replace(/\s+#+$/, "").trim() });
      continue;
    }

    const stray = lines.find((line) => /^#{1,6}\s/.test(line));
    if (stray) throw new Error(`${label}: put a blank line before the heading "${stray}"`);

    const rule = lines.find((line) => /^([-*_])\1{2,}$/.test(line));
    if (rule) throw new Error(`${label}: horizontal rules are not supported — remove "${rule}"`);

    const ordered = lines.find((line) => /^\d+[.)]\s/.test(line));
    if (ordered) {
      throw new Error(`${label}: numbered lists are not supported — write "${ordered}" as a paragraph or a - bullet`);
    }

    const bulletCount = lines.filter((line) => /^[-*]\s+/.test(line)).length;
    if (bulletCount > 0) {
      if (bulletCount !== lines.length) {
        throw new Error(`${label}: put a blank line between the text and the bullets near "${lines[0]}"`);
      }
      const nested = raw.find((line) => /^[ \t]+[-*]\s+/.test(line));
      if (nested) throw new Error(`${label}: nested bullets are not supported — "${nested.trim()}"`);
      blocks.push({ kind: "list", items: lines.map((line) => line.replace(/^[-*]\s+/, "")) });
      continue;
    }

    // A paragraph may be hard-wrapped across several lines; markdown joins them.
    blocks.push({ kind: "paragraph", text: lines.join(" ") });
  }

  if (blocks.length === 0) throw new Error(`${label}: the document body is empty`);
  return blocks;
}

/** Where the documents live. Resolved from the project root, at build time. */
export const LEGAL_CONTENT_DIR = path.join(process.cwd(), "content", "legal");

export function parseLegalDocument(slug: LegalDocumentSlug, source: string): LegalDocument {
  const label = `content/legal/${slug}.md`;
  const { fields, body } = parseFrontmatter(source, label);

  const title = fields.get("title");
  const lastUpdated = fields.get("lastUpdated");
  if (!title) throw new Error(`${label}: frontmatter is missing "title"`);
  if (!lastUpdated) throw new Error(`${label}: frontmatter is missing "lastUpdated"`);
  assertRealIsoDate(lastUpdated, label);

  return { slug, title, lastUpdated, blocks: parseBlocks(body, label) };
}

export function readLegalDocument(slug: LegalDocumentSlug): LegalDocument {
  return parseLegalDocument(slug, readFileSync(path.join(LEGAL_CONTENT_DIR, `${slug}.md`), "utf8"));
}

/* ── presentation helpers ────────────────────────────────────────────── */

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * `2026-08-16` -> `16 August 2026`.
 *
 * Formatted by hand rather than through `Intl`: this string is baked into a
 * prerendered page, so it must not depend on the ICU data or default locale of
 * whichever machine ran the build.
 */
export function formatLastUpdated(isoDate: string): string {
  assertRealIsoDate(isoDate, "lastUpdated");
  const [year, month, day] = isoDate.split("-").map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}
