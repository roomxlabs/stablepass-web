import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * Legal routes (ENG-590 / W4).
 *
 * `notFound()` and `permanentRedirect()` abort by throwing, which is how the
 * router turns them into a 404 and a 308. Mocking them with the same control
 * flow lets a unit test observe the status each slug WILL serve; the mock
 * carries a marker rather than a custom Error subclass because vi.mock's
 * factory runs before this module's own class declarations initialise.
 * `e2e/legal.spec.ts` then asserts the real status codes off the running app,
 * because a mock can only ever prove intent.
 */
type Signal = { __signal: "not-found" | "permanent-redirect"; to?: string };

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw Object.assign(new Error("NEXT_NOT_FOUND"), { __signal: "not-found" });
  },
  permanentRedirect: (to: string) => {
    throw Object.assign(new Error(`NEXT_PERMANENT_REDIRECT ${to}`), { __signal: "permanent-redirect", to });
  },
  redirect: (to: string) => {
    throw new Error(`redirect() is a 307 — these aliases are permanent, use permanentRedirect (${to})`);
  },
}));

import LegalPage, {
  dynamicParams,
  generateMetadata,
  generateStaticParams,
} from "@/app/(marketing)/legal/[slug]/page";
import {
  formatLastUpdated,
  LEGAL_DOCUMENT_SLUGS,
  LEGAL_REDIRECT_SLUGS,
  legalCanonicalUrl,
  parseLegalDocument,
  readLegalDocument,
  redirectTargetFor,
} from "@/lib/legal";

const DOCUMENT_SLUGS = [...LEGAL_DOCUMENT_SLUGS];
const REDIRECT_SLUGS = [...LEGAL_REDIRECT_SLUGS];

const REPO = process.cwd();
const LEGAL_ROUTE_DIR = path.join(REPO, "app", "(marketing)", "legal");
const CONTENT_DIR = path.join(REPO, "content", "legal");

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}

const routeSources = filesUnder(LEGAL_ROUTE_DIR).map((file) => ({
  file: path.relative(REPO, file),
  body: readFileSync(file, "utf8"),
}));

const contentSources = readdirSync(CONTENT_DIR).map((name) => ({
  file: path.join("content", "legal", name),
  body: readFileSync(path.join(CONTENT_DIR, name), "utf8"),
}));

const pageSource = routeSources.find((source) => source.file.endsWith("page.tsx"))!;

/** Render `/legal/<slug>` the way the router would, and hand back the DOM. */
async function renderSlug(slug: string) {
  return render(await LegalPage({ params: Promise.resolve({ slug }) }));
}

/** What the router would answer for `/legal/<slug>`: a status and, for 308, a target. */
async function statusFor(slug: string): Promise<{ status: number; location?: string }> {
  try {
    await LegalPage({ params: Promise.resolve({ slug }) });
    return { status: 200 };
  } catch (error) {
    const signal = (error as Partial<Signal>).__signal;
    if (signal === "permanent-redirect") return { status: 308, location: (error as Signal).to };
    if (signal === "not-found") return { status: 404 };
    throw error;
  }
}

/* ── the mockup, the content's only source of truth ──────────────────── */

const MOCKUP_SUFFIX = "10-marketing-site/deploy/src/mockup.html";
function findMockup(): string | null {
  let dir = REPO;
  for (;;) {
    const candidate = path.join(dir, MOCKUP_SUFFIX);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
const MOCKUP = findMockup();

const decode = (html: string) =>
  html
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();

/**
 * Slice one `<div class="sheet" id="…">` out of the mockup by counting div
 * depth. The sheets nest exactly one div (`.sheet-card`) and hold no others,
 * so this is exact rather than approximate.
 */
function sheetHtml(mockup: string, id: string): string {
  const at = mockup.indexOf(`id="${id}"`);
  if (at === -1) throw new Error(`mockup has no #${id}`);
  const start = mockup.lastIndexOf("<div", at);

  let depth = 0;
  const tag = /<(\/?)div\b/g;
  tag.lastIndex = start;
  for (let match = tag.exec(mockup); match; match = tag.exec(mockup)) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) return mockup.slice(start, mockup.indexOf(">", match.index) + 1);
  }
  throw new Error(`#${id} is never closed`);
}

type Sheet = { title: string; banner: string; headings: string[]; paragraphs: string[] };

function readSheet(id: string): Sheet {
  const html = sheetHtml(readFileSync(MOCKUP!, "utf8"), id);
  const paragraphs = [...html.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => decode(m[1]));
  return {
    title: decode(/<h3[^>]*>([\s\S]*?)<\/h3>/.exec(html)![1]),
    // Decision 4: the sheet opens with a preview disclaimer. It must not ship.
    banner: paragraphs[0],
    headings: [...html.matchAll(/<h4>([\s\S]*?)<\/h4>/g)].map((m) => decode(m[1])),
    paragraphs: paragraphs.slice(1),
  };
}

const SHEET_OF: Record<string, string> = { privacy: "sheet-privacy", terms: "sheet-terms" };

/* ── routing ─────────────────────────────────────────────────────────── */

describe("/legal/[slug] routing", () => {
  it("prerenders all four slugs and routes nothing else", () => {
    expect(
      generateStaticParams()
        .map((p) => p.slug)
        .sort(),
    ).toEqual(["acceptable-use", "cancellation", "privacy", "terms"]);
    // With dynamic params off, an unknown slug is a router-level 404 and the
    // four real routes stay static. Both halves of the ticket ride on this.
    expect(dynamicParams).toBe(false);
  });

  it.each(DOCUMENT_SLUGS)("serves /legal/%s", async (slug) => {
    expect(await statusFor(slug)).toEqual({ status: 200 });
  });

  // Four slugs, two documents. No distinct cancellation or acceptable-use copy
  // exists, and 308 (not 307) says these aliases are permanent.
  it.each(REDIRECT_SLUGS)("308s /legal/%s onto the terms", async (slug) => {
    expect(await statusFor(slug)).toEqual({ status: 308, location: "/legal/terms" });
  });

  it.each(["nonsense", "privacy-policy", "terms/extra", "PRIVACY"])(
    "404s /legal/%s rather than redirecting it to the terms",
    async (slug) => {
      expect(await statusFor(slug)).toEqual({ status: 404 });
      expect(redirectTargetFor(slug)).toBeNull();
    },
  );
});

/* ── canonical ───────────────────────────────────────────────────────── */

describe("canonical URL", () => {
  it.each(DOCUMENT_SLUGS)("points /legal/%s at the apex", async (slug) => {
    const metadata = await generateMetadata({ params: Promise.resolve({ slug }) });
    expect(metadata.alternates?.canonical).toBe(`https://stablepass.co/legal/${slug}`);
  });

  /**
   * "Regardless of which host rendered it" is proved by the canonical being a
   * pure function of the slug: the page reads no request input at all (see the
   * dynamic-API guardrail below), so app.stablepass.co cannot produce a
   * different answer than the apex. Asserting that absence is stronger than
   * rendering twice with a faked request.
   */
  it("derives the canonical from the slug alone", () => {
    expect(legalCanonicalUrl("privacy")).toBe("https://stablepass.co/legal/privacy");
    expect(legalCanonicalUrl("terms")).toBe("https://stablepass.co/legal/terms");
  });

  /**
   * Do not let the canonical be INHERITED.
   *
   * ENG-591 / PR #33 puts `alternates: { canonical: canonicalFor("/") }` on
   * `app/(marketing)/layout.tsx`. Next merges metadata layout-to-page per
   * top-level key, so these pages sit inside that layout and would quietly
   * start advertising the marketing HOME as their canonical the moment #33
   * merges — silently pointing Apple, Stripe and search at the wrong document
   * and breaking two of this ticket's acceptance criteria.
   *
   * The page therefore sets `alternates` itself for every renderable slug, and
   * this asserts the override exists rather than assuming it. Deleting the
   * `alternates` line from generateMetadata fails here, which is the whole
   * point; `e2e/legal.spec.ts` then checks the tag actually emitted.
   */
  it.each(DOCUMENT_SLUGS)("overrides the layout's canonical rather than inheriting it (/legal/%s)", async (slug) => {
    const metadata = await generateMetadata({ params: Promise.resolve({ slug }) });
    const canonical = metadata.alternates?.canonical;

    expect(canonical, "the page must set its own canonical, not inherit the layout's").toBeDefined();
    expect(canonical).toBe(`https://stablepass.co/legal/${slug}`);
    // Specifically NOT the marketing home, which is what inheritance would give.
    expect(canonical).not.toBe("https://stablepass.co/");
    expect(canonical).not.toBe("https://stablepass.co");
  });
});

/* ── content ─────────────────────────────────────────────────────────── */

describe("content", () => {
  it.each(DOCUMENT_SLUGS)("renders /legal/%s from content/, with a last-updated date", async (slug) => {
    const document = readLegalDocument(slug);
    const { container } = await renderSlug(slug);

    expect(container.querySelector("h1")?.textContent).toBe(document.title);
    expect(container.querySelector("article")?.textContent).toContain(
      `Last updated ${formatLastUpdated(document.lastUpdated)}`,
    );
    // Every section of the source document reached the page.
    const rendered = [...container.querySelectorAll("h2")].map((h) => h.textContent);
    const expected = document.blocks.flatMap((block) =>
      block.kind === "heading" && block.level === 2 ? [block.text] : [],
    );
    expect(rendered).toEqual(expected);
    expect(rendered.length).toBeGreaterThan(0);
  });

  /**
   * Decision 4 is the ONE content change this ticket makes, so it gets the
   * strongest assertion available: the banner must be absent from the rendered
   * page, from the content files, and from the route sources — not merely
   * unrendered. `e2e/legal.spec.ts` repeats it against the served HTML.
   */
  const BANNED = ["This preview shows", "will be supplied by stablepass", "loaded as its own page before launch"];

  it.each(DOCUMENT_SLUGS)("strips the preview banner from /legal/%s", async (slug) => {
    const { container } = await renderSlug(slug);
    for (const phrase of BANNED) expect(container.textContent).not.toContain(phrase);
  });

  it("ships the banner nowhere in the source either", () => {
    const offenders = [...contentSources, ...routeSources].filter(({ body }) =>
      BANNED.some((phrase) => body.includes(phrase)),
    );
    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  it("keeps the prose out of JSX, so the client's final wording is a one-file edit", () => {
    for (const slug of DOCUMENT_SLUGS) {
      for (const block of readLegalDocument(slug).blocks) {
        if (block.kind === "paragraph") expect(pageSource.body).not.toContain(block.text);
      }
    }
  });

  // The copy is the client's, frozen in the signed-off mockup. Anything other
  // than the banner differing means the port drifted.
  it.skipIf(!MOCKUP).each(DOCUMENT_SLUGS)(
    "reproduces the mockup's %s sheet verbatim, minus the banner",
    async (slug) => {
      const sheet = readSheet(SHEET_OF[slug]);
      const { container } = await renderSlug(slug);
      const article = container.querySelector("article")!;

      expect(container.querySelector("h1")?.textContent).toBe(sheet.title);
      expect([...container.querySelectorAll("h2")].map((h) => h.textContent)).toEqual(sheet.headings);
      for (const paragraph of sheet.paragraphs) expect(article.textContent).toContain(paragraph);

      expect(sheet.banner).toMatch(/^This preview shows/);
      expect(article.textContent).not.toContain(sheet.banner);
    },
  );
});

/* ── the tiny markdown reader ────────────────────────────────────────── */

describe("the content format", () => {
  it("reads headings, paragraphs and bullet lists", () => {
    const document = parseLegalDocument(
      "terms",
      ["---", "title: T", "lastUpdated: 2026-01-02", "---", "", "## One", "", "a", "b", "", "- x", "- y", ""].join(
        "\n",
      ),
    );
    expect(document.title).toBe("T");
    expect(document.blocks).toEqual([
      { kind: "heading", level: 2, text: "One" },
      // hard-wrapped lines join into one paragraph, as markdown does
      { kind: "paragraph", text: "a b" },
      { kind: "list", items: ["x", "y"] },
    ]);
  });

  /**
   * The reader takes no markdown dependency, so its whole safety story is that
   * anything it cannot represent FAILS THE BUILD rather than rendering wrong.
   * A permissive reader would turn "1. First clause." / "2. Second clause." —
   * ordinary legal formatting — into one run-on paragraph, silently, on a legal
   * page. Each of these was a silent mangle before review caught it.
   */
  const head = "---\ntitle: T\nlastUpdated: 2026-01-02\n---\n\n";

  it.each([
    ["no frontmatter", "## One\n\nbody\n", /missing the --- frontmatter/],
    ["no title", "---\nlastUpdated: 2026-01-02\n---\n\nbody\n", /missing "title"/],
    ["no lastUpdated", "---\ntitle: T\n---\n\nbody\n", /missing "lastUpdated"/],
    ["a non-ISO date", "---\ntitle: T\nlastUpdated: 16 Aug 2026\n---\n\nbody\n", /must be an ISO date/],
    // shape-valid but not a real day — this one used to render "45 undefined 2026"
    ["month 13", "---\ntitle: T\nlastUpdated: 2026-13-45\n---\n\nbody\n", /not a real calendar date/],
    ["month 00", "---\ntitle: T\nlastUpdated: 2026-00-10\n---\n\nbody\n", /not a real calendar date/],
    ["30 February", "---\ntitle: T\nlastUpdated: 2026-02-30\n---\n\nbody\n", /not a real calendar date/],
    ["an h1", `${head}# Nope\n`, /frontmatter "title"/],
    ["a numbered list", `${head}1. First clause.\n2. Second clause.\n`, /numbered lists are not supported/],
    ["a lead-in glued to bullets", `${head}We collect:\n- name\n- email\n`, /blank line between the text and the bullets/],
    ["a bullet wrapped onto a second line", `${head}- a bullet that wraps\n  onto a second line\n`, /blank line between the text and the bullets/],
    ["nested bullets", `${head}- top\n  - nested\n- top2\n`, /nested bullets are not supported/],
    ["a horizontal rule", `${head}before\n\n---\n\nafter\n`, /horizontal rules are not supported/],
    ["a heading glued to a paragraph", `${head}some text\n## Heading\n`, /blank line before the heading/],
    ["a heading with text after it", `${head}## Heading\nglued text\n`, /blank line after the heading/],
  ])("fails the build loudly on %s", (_case, source, message) => {
    expect(() => parseLegalDocument("terms", source as string)).toThrow(message as RegExp);
  });

  it("accepts a closed ATX heading without keeping the trailing hashes", () => {
    const document = parseLegalDocument("terms", `${head}## Heading ##\n\nbody\n`);
    expect(document.blocks[0]).toEqual({ kind: "heading", level: 2, text: "Heading" });
  });

  it("does not mangle a quoted title that contains quotes", () => {
    const source = '---\ntitle: "A" and "B"\nlastUpdated: 2026-01-02\n---\n\nbody\n';
    expect(parseLegalDocument("terms", source).title).toBe('"A" and "B"');
  });

  it("formats the date without depending on the build machine's locale", () => {
    expect(formatLastUpdated("2026-08-16")).toBe("16 August 2026");
    expect(formatLastUpdated("2026-01-01")).toBe("1 January 2026");
    expect(() => formatLastUpdated("2026-13-01")).toThrow(/not a real calendar date/);
  });
});

/* ── guardrails ──────────────────────────────────────────────────────── */

describe("guardrails", () => {
  /**
   * Guardrail #1. These pages exist to be reachable SIGNED OUT — the App Store
   * reviewer and the visitor on the signup form both arrive with no session — so
   * a Supabase import here would be wrong twice over: it puts the auth path on a
   * public page, and it drags the session onto a host with no business seeing it.
   */
  it("imports no Supabase client and reads no session", () => {
    const offenders = routeSources.filter(
      ({ body }) => /lib\/supabase/.test(body) || /NEXT_PUBLIC_SUPABASE/.test(body) || /@supabase\//.test(body),
    );
    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  /**
   * Static rendering is a guardrail, not a preference: one `cookies()` anywhere
   * in this subtree opts the whole route out of the prerender and every legal
   * page starts costing a server render, which is exactly the caching the
   * marketing/member subdomain split was built to protect.
   */
  it("uses no dynamic API of its own", () => {
    const offenders = routeSources.filter(({ body }) =>
      /\bcookies\(\)|\bheaders\(\)|next\/headers|draftMode|unstable_noStore|force-dynamic|revalidate\s*=\s*0/.test(
        body,
      ),
    );
    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  /**
   * ...and the same claim checked against the artifact instead of the source.
   *
   * The grep above only sees `app/(marketing)/legal/`. The render path is wider
   * than that — `app/(marketing)/layout.tsx` and `app/layout.tsx` are part of
   * it, and a single `headers()` in either flips these four routes from ● to ƒ
   * with every source-grep in this file still green. That is not hypothetical:
   * ENG-591 is concurrently making the marketing layout host-aware, which is
   * exactly the edit that would do it.
   *
   * So assert the property, not a proxy for it. `prerender-manifest.json` is
   * Next's own record of what it actually prerendered, and it does not care how
   * someone broke it.
   *
   * Skipped when there is no build to read. The repo's documented gate is
   * `typecheck && lint && build && test`, so the manifest is present where it
   * counts; a bare `npm test` skips this one assertion rather than failing.
   */
  const PRERENDER_MANIFEST = path.join(REPO, ".next", "prerender-manifest.json");

  it.skipIf(!existsSync(PRERENDER_MANIFEST))("is prerendered in the build output, not merely in the source", () => {
    const manifest = JSON.parse(readFileSync(PRERENDER_MANIFEST, "utf8")) as {
      routes: Record<string, { initialRevalidateSeconds: number | false }>;
      dynamicRoutes: Record<string, { fallback: unknown }>;
    };

    for (const slug of [...DOCUMENT_SLUGS, ...REDIRECT_SLUGS]) {
      const route = manifest.routes[`/legal/${slug}`];
      expect(route, `/legal/${slug} is not prerendered — the route went dynamic`).toBeDefined();
      // ISR would re-render on a timer; these documents change when a file changes.
      expect(route.initialRevalidateSeconds).toBe(false);
    }

    // `fallback: false` is what makes an unlisted slug a router-level 404
    // instead of a server render, which is the other half of requirement 7.
    expect(manifest.dynamicRoutes["/legal/[slug]"]?.fallback).toBe(false);
  });

  /**
   * Guardrail #8, re-established over the copy.
   *
   * Moving the prose into `content/legal/*.md` was right for the client, but it
   * quietly carried the marketing-visible wording OUT from under the repo's only
   * automated betting check — `test/marketing-shell.test.tsx` scans
   * `app/(marketing)/**`, which no longer contains a word of it. The final
   * wording is designed to drop in as a one-file edit by a non-engineer, so the
   * copy needs its own guard or it has none at all.
   *
   * The rule is NOT "the word never appears": the terms legitimately disclaim
   * being a betting product, and `.rx/gotchas.md` records the DRI precedent
   * (16 Aug 2026) that a disclaimer is the inverse of an endorsement. So every
   * occurrence must sit in a disclaiming sentence, AND the exact set is pinned —
   * new betting vocabulary in future copy fails here and has to be re-approved
   * by a human rather than sliding in under a regex that already passes.
   */
  it("keeps guardrail #8 over the legal copy, allowing only the known disclaimer", () => {
    const BETTING = /\b(odds|bookmaker|bookmakers|wager|wagers|wagering|bet|bets|betting|sportsbet)\b/gi;

    const hits = contentSources.flatMap(({ file, body }) =>
      [...body.matchAll(BETTING)].map((match) => {
        const at = match.index;
        const start = body.lastIndexOf(".", at) + 1;
        const end = body.indexOf(".", at);
        return {
          where: `${file}:${match[0].toLowerCase()}`,
          sentence: body.slice(start, end === -1 ? body.length : end + 1).trim(),
        };
      }),
    );

    // Every occurrence is a statement of what stablepass. is NOT.
    for (const hit of hits) expect(hit.sentence, hit.where).toMatch(/does not sell/i);

    // And the approved set is exact.
    expect(hits.map((hit) => hit.where)).toEqual(["content/legal/terms.md:betting"]);
  });

  it("adds no markdown dependency", () => {
    const manifest = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const installed = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    expect(installed.filter((name) => /markdown|^marked$|remark|rehype|mdx|gray-matter/i.test(name))).toEqual([]);
  });

  // The routes have to answer on both hosts for the signup form's RELATIVE links
  // to resolve, so nothing in the page may hard-code an absolute origin into a
  // link. The one absolute URL in the feature is the canonical, in lib/legal.ts.
  it("hard-codes no origin into the page", () => {
    expect(pageSource.body).not.toMatch(/https?:\/\//);
  });
});

/* ── the defect this ticket exists to fix ────────────────────────────── */

describe("the signup form's legal links", () => {
  /**
   * The acceptance criterion that matters most: `/start` links `/legal/terms`
   * and `/legal/privacy` and both 404 today. ENG-571 owns that file and this
   * ticket must not touch it, so the fix has to work through the links it
   * ALREADY has. This asserts the two halves meet: whatever hrefs the form
   * renders are slugs this route serves.
   */
  it("are served by this route, with the form left untouched", () => {
    const form = readFileSync(path.join(REPO, "app", "start", "trial-start-form.tsx"), "utf8");
    const linked = [...form.matchAll(/href="(\/legal\/[^"]*)"/g)].map((m) => m[1]);

    expect(linked.length).toBeGreaterThan(0);
    const served = generateStaticParams().map((p) => `/legal/${p.slug}`);
    expect(linked.filter((href) => !served.includes(href))).toEqual([]);

    // Relative, not absolute — that is what makes them resolve on the member
    // host too, and what makes editing this file unnecessary.
    for (const href of linked) expect(href.startsWith("/legal/")).toBe(true);
  });
});
