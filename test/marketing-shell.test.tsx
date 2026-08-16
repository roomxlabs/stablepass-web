import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import MarketingLayout from "@/app/(marketing)/layout";
import MarketingFooter from "@/app/(marketing)/footer";
import MarketingNav from "@/app/(marketing)/nav";

const REPO = process.cwd();
const ROUTE_GROUP = path.join(REPO, "app", "(marketing)");
const ASSET_DIR = path.join(REPO, "public", "marketing");

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}

const routeGroupSources = filesUnder(ROUTE_GROUP).map((file) => ({
  file: path.relative(REPO, file),
  body: readFileSync(file, "utf8"),
}));

const MARKETING_CSS = readFileSync(path.join(ROUTE_GROUP, "marketing.css"), "utf8");

type CssRule = { selector: string; decls: string };

/** Flatten a stylesheet to [{selector, decls}], comments stripped, whitespace normalised. */
function cssRules(css: string): CssRule[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const tidy = (s: string) =>
    s
      .split(",")
      .map((part) => part.trim().replace(/\s+/g, " "))
      .join(",");

  const out: CssRule[] = [];
  const open: string[] = [];
  let buffer = "";
  for (const ch of source) {
    if (ch === "{") {
      open.push(tidy(buffer));
      buffer = "";
    } else if (ch === "}") {
      out.push({ selector: open.pop() ?? "", decls: buffer.trim().replace(/\s+/g, " ").replace(/;$/, "") });
      buffer = "";
    } else {
      buffer += ch;
    }
  }
  return out;
}

/**
 * The mockup sits in a sibling design tree, outside this repo, and its depth
 * above the repo root differs between a normal checkout and the loop's worktree.
 * Absent (CI, a fresh clone) → the mockup-derived tests skip rather than fail.
 */
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

describe("marketing nav", () => {
  it("renders every anchor target the mockup's nav has", () => {
    const { container } = render(<MarketingNav />);
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));

    // Wordmark -> #top, the five links, and the CTA (which shares #subscription).
    expect(hrefs).toEqual(["#top", "#how", "#app", "#subscription", "#trainers", "#faq", "#subscription"]);
  });

  it("labels the links with the mockup's copy and keeps the join CTA", () => {
    render(<MarketingNav />);
    for (const label of ["How it works", "The app", "Subscription", "For trainers", "FAQ"]) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole("link", { name: "Join stablepass." })).toHaveClass("nav-cta");
  });

  it("serves the wordmark from public/, never an inlined data URI", () => {
    const { container } = render(<MarketingNav />);
    const logo = container.querySelector(".nav-logo img");
    expect(logo).toHaveAttribute("alt", "stablepass.");
    expect(logo?.getAttribute("src")).toMatch(/^\/marketing\/[0-9a-f]{8}\.png$/);
  });
});

describe("marketing footer", () => {
  it("renders the brand line and all three columns", () => {
    const { container } = render(<MarketingFooter />);
    const headings = [...container.querySelectorAll(".foot-col h4")].map((h) => h.textContent);
    expect(headings).toEqual(["Explore", "Support", "Legal"]);

    expect(container.querySelector(".foot-brand img")).toHaveAttribute("alt", "stablepass.");
    expect(screen.getByText("A thoroughbred racing experience and entertainment subscription.")).toBeInTheDocument();
    expect(screen.getByText("© stablepass. All rights reserved.")).toBeInTheDocument();
  });

  it("keeps the sheet entries as buttons, inert until W3 wires them", () => {
    const { container } = render(<MarketingFooter />);
    const columns = [...container.querySelectorAll<HTMLElement>(".foot-col")];
    const support = columns[1];
    const legal = columns[2];

    // FAQ is a real in-page anchor; the other three open a sheet, so they are buttons.
    expect(within(support).getByRole("link", { name: "FAQ" })).toHaveAttribute("href", "#faq");
    expect(within(support).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Contact us",
      "Subscriber support",
      "Trainer partnerships",
    ]);
    expect(within(legal).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Privacy Policy",
      "Terms & Conditions",
      "Cancellation & Refund Policy",
      "Acceptable Use Policy",
    ]);
    // No <a href> masquerading as a sheet trigger — W4 turns the legal ones into links.
    for (const button of [...within(legal).getAllByRole("button")]) {
      expect(button).toHaveAttribute("data-sheet");
      expect(button).toHaveAttribute("type", "button");
    }
  });

  // The footer carries the mockup's review stamp, which moves with the design
  // version (V2.6 -> V2.7 when the post-race tile was re-cut). Pinning it to a
  // hard-coded string would just go stale silently, so read it off the source:
  // if the mockup is bumped again and this component is not, this fails.
  it.skipIf(!MOCKUP)("reproduces the copyright row exactly as the mockup has it", () => {
    const mockup = readFileSync(MOCKUP!, "utf8").replace(/data:image\/[^"')]+/g, "X");
    const row = /<div class="row">([\s\S]*?)<\/div>/.exec(mockup)![1];
    const wanted = [...row.matchAll(/<span>([\s\S]*?)<\/span>/g)].map((m) =>
      m[1].replace(/&amp;/g, "&").trim(),
    );

    const { container } = render(<MarketingFooter />);
    const got = [...container.querySelectorAll(".foot-legal .row span")].map((s) => s.textContent);
    expect(got).toEqual(wanted);
  });

  it("prints no email address anywhere (the mockup routes contact through a form)", () => {
    const { container } = render(<MarketingFooter />);
    expect(container.textContent).not.toMatch(/@[\w.-]+\.\w+/);
    expect(container.querySelector('a[href^="mailto:"]')).toBeNull();
  });
});

describe("marketing layout", () => {
  it("wraps the page in the scoped marketing root, not :root", () => {
    const { container } = render(<MarketingLayout>{<p>page body</p>}</MarketingLayout>);
    const root = container.querySelector(".marketing");
    expect(root).toBeInTheDocument();
    expect(root).toHaveAttribute("data-cta-mode", "trial");
  });

  it("marks the shell script-capable before first paint, for the .js/.rv contract", () => {
    const { container } = render(<MarketingLayout>{null}</MarketingLayout>);
    const script = container.querySelector(".marketing > script");
    // Must be inline and first, so the class lands during parse rather than after
    // hydration. With scripting off the class never lands and .rv stays visible.
    expect(script?.textContent).toMatch(/classList\.add\(["']js["']\)/);
    expect(script?.hasAttribute("src")).toBe(false);
    expect(container.querySelector(".marketing")?.firstElementChild).toBe(script);
  });

  // The mockup flagged <html>. Doing that here mutates the element app/layout.tsx
  // renders, which this route group must not touch, and React then reports a
  // hydration mismatch on every marketing page load.
  it("flags the wrapper, never the <html> the root layout owns", () => {
    const { container } = render(<MarketingLayout>{null}</MarketingLayout>);
    const script = container.querySelector(".marketing > script");
    expect(script?.textContent).not.toMatch(/documentElement/);
  });

  it("renders nav, the page, then footer", () => {
    const { container } = render(<MarketingLayout>{<p>page body</p>}</MarketingLayout>);
    expect(container.querySelector("nav.nav")).toBeInTheDocument();
    expect(screen.getByText("page body")).toBeInTheDocument();
    expect(container.querySelector("footer")).toBeInTheDocument();
  });
});

describe("guardrails", () => {
  // Guardrail #1 — the marketing origin stays off the auth-cookie path. A Supabase
  // import here would make the route dynamic and put the session on a host that has
  // no business seeing it, which is the entire reason for the subdomain split.
  it("never touches Supabase from the marketing route group", () => {
    const offenders = routeGroupSources.filter(
      ({ body }) => /lib\/supabase/.test(body) || /NEXT_PUBLIC_SUPABASE/.test(body),
    );
    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  it("references no secret or backend URL", () => {
    // Deliberately names secrets rather than banning process.env outright — W4/W5
    // will read legitimate public config here, and a rule that cries wolf gets
    // deleted rather than obeyed.
    const offenders = routeGroupSources.filter(({ body }) =>
      /SERVICE_ROLE|STRIPE_SECRET|MUX_|SUPABASE_|_KEY\b|_SECRET\b/.test(body),
    );
    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  // Guardrail #8 — no betting or bookmaker anything on the page.
  it("carries no betting or bookmaker copy", () => {
    const offenders = routeGroupSources.filter(({ body }) =>
      /\b(odds|bookmaker|wager|betting|sportsbet|tab\.com)\b/i.test(body),
    );
    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  it("inlines no image anywhere in the route group", () => {
    const offenders = routeGroupSources.filter(({ body }) => body.includes("data:image/"));
    expect(offenders.map((o) => o.file)).toEqual([]);
  });
});

describe("the .js / .rv reveal contract", () => {
  // Parse into real rules first. Regexing the raw file is what let an earlier
  // version of this suite pass against a stylesheet whose reveal rule had been
  // deleted: the header COMMENT quotes the selector, so the assertion matched
  // prose rather than CSS.
  const rules = cssRules(MARKETING_CSS);

  // The client reviews this page on a phone with JS blocked. If the reveal's
  // opacity:0 were not gated, every section would sit invisible and the page
  // would read as broken. The most load-bearing lines in the stylesheet.
  it("hides .rv only when the shell is script-capable", () => {
    const hides = rules.filter((r) => /\.rv\b/.test(r.selector) && /opacity:0\b/.test(r.decls));

    // must EXIST (a deleted contract is the regression that matters most)...
    expect(hides.length).toBeGreaterThan(0);
    // ...and every one of them must be gated on the wrapper's own js class.
    // `.js` alone is not enough: the flag lives on .marketing, so a rule gated
    // on `html.js` would never match and would hide sections permanently.
    for (const rule of hides) expect(rule.selector).toMatch(/\.marketing\.js\b/);
  });

  it("disables the reveal under prefers-reduced-motion", () => {
    const reduced = rules.filter((r) => r.selector === ".marketing.js .rv" && /opacity:1/.test(r.decls));
    expect(reduced.length).toBeGreaterThan(0);
    expect(rules.some((r) => r.selector === "html" && r.decls.includes("scroll-behavior:auto"))).toBe(true);
  });

  // Decision 3: the member app's tokens must be untouched. Several values are
  // deliberately close but not equal, so a token leaking onto :root would shift
  // the member app by a few hex points rather than fail loudly.
  it("declares its tokens on the marketing root, never :root", () => {
    expect(rules.some((r) => r.selector.split(",").includes(":root"))).toBe(false);
    expect(rules.some((r) => r.selector === ".marketing" && r.decls.includes("--paper:#FAF9F4"))).toBe(true);
  });

  // overflow-x on the wrapper turns it into a scroll container, and the sticky
  // nav then sticks to a scrollport that never scrolls. It has to stay on <body>.
  it("keeps overflow-x on <body>, so the sticky nav still sticks", () => {
    const wrapper = rules.filter((r) => r.selector === ".marketing");
    for (const rule of wrapper) expect(rule.decls).not.toMatch(/overflow/);
    expect(rules.some((r) => r.selector === "body:has(.marketing)" && /overflow-x:hidden/.test(r.decls))).toBe(true);
  });
});

describe("extracted marketing assets", () => {
  const assets = readdirSync(ASSET_DIR).filter((name) => statSync(path.join(ASSET_DIR, name)).isFile());

  it("holds the 40 unique images the mockup inlined", () => {
    expect(assets).toHaveLength(40);
  });

  // Every file is named for the md5 of its own bytes, which is what makes
  // "re-running the extraction produces a byte-identical set" checkable without
  // the mockup: a re-encoded or optimised file would no longer match its name.
  it("names every file after the md5 of its own bytes", () => {
    const mismatched = assets.filter((name) => {
      const digest = createHash("md5").update(readFileSync(path.join(ASSET_DIR, name))).digest("hex");
      return name !== `${digest.slice(0, 8)}${path.extname(name)}`;
    });
    expect(mismatched).toEqual([]);
  });

  it("resolves every /marketing/ reference in the route group to a real file", () => {
    const referenced = new Set<string>();
    for (const { body } of routeGroupSources) {
      for (const match of body.matchAll(/\/marketing\/([\w.-]+\.(?:jpg|png|gif|webp|svg))/g)) {
        referenced.add(match[1]);
      }
    }
    // Pin the exact set W1 uses: the wordmark (nav + footer) and the two CSS
    // backgrounds. A count-based check would not notice a dropped reference.
    expect([...referenced].sort()).toEqual(["3499d96c.png", "59b40037.jpg", "8d95c6f2.jpg"]);
    expect([...referenced].filter((name) => !assets.includes(name))).toEqual([]);
  });

  // The md5-8 naming makes the set internally consistent, but internal
  // consistency is all it proves — re-extracting from a NEWER mockup would
  // rename every file and still pass. Only the mockup itself can settle it.
  it.skipIf(!MOCKUP)("still matches the mockup byte for byte", () => {
    const result = execFileSync(
      "python3",
      [path.join(REPO, "scripts", "extract-marketing-assets.py"), "--check", "--source", MOCKUP!],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    // --check exits non-zero on any drift, so reaching here is the assertion;
    // the count guards against a mockup that silently lost images.
    expect(result.split("\n").filter((line) => line.includes(" ok")).length).toBe(40);
  });
});

/**
 * The whole ticket is "port the frozen design faithfully", and W2/W3 are told
 * never to edit marketing.css. Nothing enforced either claim, so a changed token,
 * a nudged breakpoint or a dropped rule would have gone unnoticed. This re-derives
 * the port from the mockup and diffs it.
 */
if (MOCKUP) {
  describe("marketing.css is a faithful port of the mockup", () => {
    const mockupStyle = /<style>([\s\S]*?)<\/style>/.exec(readFileSync(MOCKUP, "utf8"))![1];
    // The port swapped two inlined backgrounds for public/ paths; do the same here
    // so the comparison is like for like.
    const expected = cssRules(
      mockupStyle.replace(/data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+?)(?=["')])/g, (_m, mime, b64) => {
        const raw = Buffer.from(String(b64).replace(/\s+/g, ""), "base64");
        const ext = String(mime).toLowerCase() === "png" ? "png" : "jpg";
        return `/marketing/${createHash("md5").update(raw).digest("hex").slice(0, 8)}.${ext}`;
      }),
    );

    // Undo the one sanctioned transform so the two sheets are comparable.
    const unscope = (selector: string) =>
      selector
        .split(",")
        .map((part) => {
          if (part.startsWith(".marketing.js ")) return `.js ${part.slice(".marketing.js ".length)}`;
          if (part.startsWith(".marketing[")) return part.slice(".marketing".length);
          if (part.startsWith(".marketing ")) return part.slice(".marketing ".length);
          return part;
        })
        .join(",");

    // `:root`, `body`, `html` and the `*` reset are the documented exceptions,
    // asserted separately below. Everything else must survive untouched.
    const EXCEPTIONS = new Set([":root", "body", "html", "*,*::before,*::after", "*"]);
    const isException = (selector: string) =>
      EXCEPTIONS.has(selector) || selector.includes(".marketing") || selector.startsWith("body:has");

    // Compared as ORDERED LISTS, not as a selector->declarations map. Selectors
    // legitimately repeat — nearly every component has a base rule plus one or
    // more @media overrides — so a map silently keeps only the last and ends up
    // comparing a base rule against its own breakpoint override.
    const wantRules = expected.filter((r) => !EXCEPTIONS.has(r.selector));
    const gotRules = cssRules(MARKETING_CSS)
      .map((r) => ({ selector: unscope(r.selector), decls: r.decls }))
      .filter((r) => !isException(r.selector));

    it("carries every rule of the mockup, in order, with identical declarations", () => {
      const drifted: string[] = [];
      for (let i = 0; i < Math.max(wantRules.length, gotRules.length); i += 1) {
        const want = wantRules[i];
        const got = gotRules[i];
        if (!want) drifted.push(`ADDED    ${got.selector} { ${got.decls} }`);
        else if (!got) drifted.push(`MISSING  ${want.selector} { ${want.decls} }`);
        else if (want.selector !== got.selector)
          drifted.push(`SELECTOR at ${i}\n  want: ${want.selector}\n  got:  ${got.selector}`);
        else if (want.decls !== got.decls)
          drifted.push(`CHANGED  ${want.selector}\n  want: ${want.decls}\n  got:  ${got.decls}`);
      }
      expect(drifted).toEqual([]);
      expect(gotRules).toHaveLength(wantRules.length);
    });

    it("keeps the mockup's tokens verbatim, just moved off :root", () => {
      const tokens = expected.find((r) => r.selector === ":root")!.decls;
      // `--paper:` with the colon — `includes("--paper")` also matches every
      // var(--paper) reference and would select the wrong rule.
      const ported = cssRules(MARKETING_CSS).find((r) => r.selector === ".marketing" && r.decls.includes("--paper:"));
      expect(ported?.decls).toBe(tokens);
    });

    // The mockup's body rule is split across body:has(.marketing) and .marketing.
    // Together they must still say exactly what the mockup said, plus the UA margin
    // globals.css resets away.
    it("splits the body rule without losing or inventing a declaration", () => {
      const all = cssRules(MARKETING_CSS);
      const wanted = new Set(expected.find((r) => r.selector === "body")!.decls.split(";"));
      wanted.add("margin:8px");

      const got = new Set(
        [
          ...(all.find((r) => r.selector === "body:has(.marketing)")?.decls ?? "").split(";"),
          ...all
            .filter((r) => r.selector === ".marketing" && !r.decls.includes("--paper:"))
            .flatMap((r) => r.decls.split(";")),
        ]
          // the tokens live on .marketing, so var(--paper) cannot resolve on <body>;
          // the literal there is the same colour by definition.
          .map((decl) => decl.replace("background:#FAF9F4", "background:var(--paper)")),
      );

      expect([...wanted].filter((d) => !got.has(d))).toEqual([]);
      expect([...got].filter((d) => !wanted.has(d))).toEqual([]);
    });
  });
}
