// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { NextRequest } from "next/server";

// robots.ts reads the Host header, so the header store is mocked per case.
let requestHost = "stablepass.co";
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers({ host: requestHost })),
}));

import { CANONICAL_ORIGIN, MARKETING_IS_INDEXABLE, canonicalFor } from "@/lib/seo";
import robots from "@/app/robots";

const REPO = fileURLToPath(new URL("..", import.meta.url));

// Assembled rather than written out, so this file can assert the string's
// absence without being the reason a repo-wide grep finds it.
const THIRD_PARTY_DOMAIN = ["stablepass", "com"].join(".");

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(path.join(REPO, dir))) {
    const rel = path.join(dir, entry);
    const full = path.join(REPO, rel);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      sourceFiles(rel, acc);
    } else if (/\.(ts|tsx|css)$/.test(entry)) {
      acc.push(rel);
    }
  }
  return acc;
}

describe("canonical — decision 5", () => {
  it("points at the real apex, not the third party's site", () => {
    expect(CANONICAL_ORIGIN).toBe("https://stablepass.co");
    expect(canonicalFor("/")).toBe("https://stablepass.co/");
    expect(canonicalFor("/legal/privacy")).toBe("https://stablepass.co/legal/privacy");
  });

  it("tolerates a pathname without its leading slash", () => {
    expect(canonicalFor("legal/terms")).toBe("https://stablepass.co/legal/terms");
  });

  it("leaves no reference to the third party's domain in any shipped source", () => {
    // The mockup head carried a canonical (and a matching og:url) pointing at
    // the `.com` of the same name — a password generator owned by somebody
    // else. Pointing the canonical at it hands them the ranking.
    const offenders = ["app", "lib", "middleware.ts", "next.config.ts"]
      .flatMap((entry) =>
        statSync(path.join(REPO, entry)).isDirectory() ? sourceFiles(entry) : [entry],
      )
      .filter((rel) => readFileSync(path.join(REPO, rel), "utf8").includes(THIRD_PARTY_DOMAIN));

    expect(offenders).toEqual([]);
  });
});

describe("the indexing flag — decision 6", () => {
  const seoSource = readFileSync(path.join(REPO, "lib/seo.ts"), "utf8");

  it("is off until real trainer bios land", () => {
    expect(MARKETING_IS_INDEXABLE).toBe(false);
  });

  it("names the flip condition next to the constant", () => {
    const declaration = seoSource.indexOf("export const MARKETING_IS_INDEXABLE");
    expect(declaration).toBeGreaterThan(-1);
    // The comment block immediately above the constant has to say what makes it
    // safe to flip, so nobody has to go hunting for the reason.
    const preamble = seoSource.slice(0, declaration);
    expect(preamble).toMatch(/trainer bios/i);
    expect(preamble).toMatch(/photograph/i);
  });

  it("is the single switch — nothing else hardcodes an index decision", () => {
    for (const rel of ["app/robots.ts", "middleware.ts", "app/(marketing)/layout.tsx"]) {
      expect(readFileSync(path.join(REPO, rel), "utf8"), rel).toContain("MARKETING_IS_INDEXABLE");
    }
  });
});

describe("robots.txt is host-aware", () => {
  beforeEach(() => {
    requestHost = "stablepass.co";
  });

  it("disallows everything on the member host, always", async () => {
    requestHost = "app.stablepass.co";
    expect(await robots()).toEqual({ rules: [{ userAgent: "*", disallow: "/" }] });
  });

  it("disallows everything on the marketing host while the flag is off", async () => {
    requestHost = "stablepass.co";
    expect(await robots()).toEqual({ rules: [{ userAgent: "*", disallow: "/" }] });
  });

  it("disallows everything on a preview host", async () => {
    requestHost = "stablepass-web-git-eng-591.vercel.app";
    expect(await robots()).toEqual({ rules: [{ userAgent: "*", disallow: "/" }] });
  });

  it("disallows everything in local development", async () => {
    requestHost = "localhost:3000";
    expect(await robots()).toEqual({ rules: [{ userAgent: "*", disallow: "/" }] });
  });

  it("normalises the host before deciding", async () => {
    requestHost = "APP.STABLEPASS.CO:443";
    expect(await robots()).toEqual({ rules: [{ userAgent: "*", disallow: "/" }] });
  });
});

describe("the state AFTER the flag is flipped", () => {
  // Decision 6's whole promise is that opening the site to crawlers is "one
  // edit, not a hunt". That promise is only worth anything if the post-flip
  // state is actually exercised — with the constant hardcoded `false`, every
  // test above runs the same branch.
  async function withIndexingOn<T>(run: (mod: {
    robots: typeof import("@/app/robots").default;
    middleware: typeof import("@/middleware").middleware;
  }) => Promise<T> | T): Promise<T> {
    vi.resetModules();
    vi.doMock("@/lib/seo", async () => ({
      ...(await vi.importActual<typeof import("@/lib/seo")>("@/lib/seo")),
      MARKETING_IS_INDEXABLE: true,
    }));
    try {
      const [{ default: robotsFn }, { middleware: mw }] = await Promise.all([
        import("@/app/robots"),
        import("@/middleware"),
      ]);
      return await run({ robots: robotsFn, middleware: mw });
    } finally {
      vi.doUnmock("@/lib/seo");
      vi.resetModules();
    }
  }

  it("opens robots.txt on the marketing host only", async () => {
    await withIndexingOn(async ({ robots: robotsFn }) => {
      requestHost = "stablepass.co";
      expect(await robotsFn()).toEqual({
        rules: [{ userAgent: "*", allow: "/", disallow: ["/api/"] }],
      });

      // The member space must stay closed no matter what the flag says.
      requestHost = "app.stablepass.co";
      expect(await robotsFn()).toEqual({ rules: [{ userAgent: "*", disallow: "/" }] });
    });
  });

  it("drops the X-Robots-Tag header on marketing but keeps it on the member space", async () => {
    await withIndexingOn(({ middleware: mw }) => {
      const marketing = mw(
        new NextRequest("https://stablepass.co/", { headers: new Headers({ host: "stablepass.co" }) }),
      );
      expect(marketing.headers.get("x-robots-tag")).toBeNull();

      const member = mw(
        new NextRequest("https://app.stablepass.co/explore", {
          headers: new Headers({ host: "app.stablepass.co" }),
        }),
      );
      expect(member.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    });
  });
});

describe("marketing metadata — decisions 7 and 8", () => {
  // Asserted against the EMITTED metadata rather than the file's text: the
  // comment above the export legitimately explains what was dropped and why, and
  // a raw-source grep cannot tell that apart from the tag itself coming back.
  it("emits no x-concept working note and no arbitrary meta bag", async () => {
    // The mockup head carried `<meta name="x-concept" content="Concept B · Race
    // Day · V2.7">` — a build marker, not SEO. Alongside it sat a comment
    // claiming every tag was editable from an admin portal, describing a CMS
    // that does not exist.
    const { metadata } = await import("@/app/(marketing)/layout");
    const emitted = JSON.stringify(metadata);

    expect(metadata.other).toBeUndefined();
    expect(emitted).not.toMatch(/x-concept/i);
    expect(emitted).not.toMatch(/concept b/i);
    expect(emitted).not.toMatch(/V2\.\d/);
    expect(emitted).not.toMatch(/admin portal/i);
    // NB: not a "race day" sweep — that phrase is legitimate mockup copy in the
    // description ("...and race day stories."), which is kept verbatim.
  });

  it("carries the mockup's title, description and social card", async () => {
    const { metadata, viewport } = await import("@/app/(marketing)/layout");

    const TITLE = "stablepass. | Behind the scenes thoroughbred racing subscription";
    expect(metadata.title).toBe(TITLE);
    expect(metadata.description).toMatch(/^stablepass\. is a monthly racing experience subscription/);
    expect(metadata.keywords).toContain("thoroughbred racing subscription");

    expect(metadata.alternates?.canonical).toBe("https://stablepass.co/");
    expect(metadata.robots).toEqual({
      index: MARKETING_IS_INDEXABLE,
      follow: MARKETING_IS_INDEXABLE,
    });

    expect(metadata.openGraph?.title).toBe(TITLE);
    expect(metadata.openGraph).toMatchObject({ type: "website", locale: "en_AU" });
    expect(metadata.openGraph?.url).toBe("https://stablepass.co/");

    // Next types `twitter` as a union discriminated by `card`, so `card` is not
    // readable off the union directly — narrow to the shape being asserted.
    const twitter = metadata.twitter as { card?: string; title?: string } | null | undefined;
    expect(twitter?.card).toBe("summary_large_image");
    expect(twitter?.title).toBe(TITLE);

    // theme-color belongs to the viewport export in the App Router.
    expect(viewport.themeColor).toBe("#285D50");
  });

  it("ships the og.jpg the social card points at", () => {
    const og = statSync(path.join(REPO, "public/og.jpg"));
    expect(og.isFile()).toBe(true);
    expect(og.size).toBeGreaterThan(1000);
  });

  it("resolves the relative og image against the apex", async () => {
    const { metadata } = await import("@/app/(marketing)/layout");
    expect(String(metadata.metadataBase)).toBe("https://stablepass.co/");
  });
});
