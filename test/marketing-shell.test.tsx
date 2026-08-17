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

    // Wordmark -> #top, then the five section anchors. ENG-600: the last two are
    // the product destinations, and they are the whole point of that ticket — the
    // marketing site previously had NO route to the app at all, for new or
    // returning visitors. They are root-relative on purpose: middleware already
    // 307s a non-shared apex path onto the app host, and an absolute URL would
    // send local dev at production.
    expect(hrefs).toEqual(["#top", "#how", "#app", "#subscription", "#trainers", "#faq", "/signin", "/start"]);
  });

  it("keeps the two product destinations reachable and relative", () => {
    // Guards the regression ENG-600 fixes: if either of these reverts to an
    // in-page anchor the funnel silently becomes a loop again, and every test
    // above would still pass.
    const { container } = render(<MarketingNav />);
    expect(container.querySelector("a.nav-cta")).toHaveAttribute("href", "/start");
    expect(container.querySelector("a.nav-signin")).toHaveAttribute("href", "/signin");
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

  /**
   * Was "keeps the sheet entries as buttons, inert until W3 wires them" — W3
   * (ENG-589) has now wired them, and the answer was that neither column should
   * be a button at all. The client reviews this page with scripting blocked, so
   * a delegated `<button>` navigates nowhere; both columns are plain anchors.
   *
   * The hrefs themselves are asserted in `test/marketing-sheets.test.tsx`.
   */
  it("renders both sheet columns as real links, so they work with scripting off", () => {
    const { container } = render(<MarketingFooter />);
    const columns = [...container.querySelectorAll<HTMLElement>(".foot-col")];
    const support = columns[1];
    const legal = columns[2];

    expect(within(support).getByRole("link", { name: "FAQ" })).toHaveAttribute("href", "#faq");
    expect(within(support).getAllByRole("link").map((a) => a.textContent)).toEqual([
      "FAQ",
      "Contact us",
      "Subscriber support",
      "Trainer partnerships",
    ]);
    expect(within(legal).getAllByRole("link").map((a) => a.textContent)).toEqual([
      "Privacy Policy",
      "Terms & Conditions",
      "Cancellation & Refund Policy",
      "Acceptable Use Policy",
    ]);

    // Nothing left that needs a script to do its job.
    for (const column of [support, legal]) {
      expect(within(column).queryAllByRole("button")).toHaveLength(0);
      expect(column.querySelector("[data-sheet]")).toBeNull();
    }
  });

  // The mockup's copyright row carries TWO spans: the copyright line, and a
  // review stamp reading "Concept B · Race Day · V2.x · RX Labs". ENG-600 drops
  // the stamp — it named the internal concept and the agency on a customer-facing
  // page — and keeps the copyright line pinned to the mockup so a copy change
  // there still fails here.
  it.skipIf(!MOCKUP)("reproduces the mockup's copyright line, without the review stamp", () => {
    const mockup = readFileSync(MOCKUP!, "utf8").replace(/data:image\/[^"')]+/g, "X");
    const row = /<div class="row">([\s\S]*?)<\/div>/.exec(mockup)![1];
    const wanted = [...row.matchAll(/<span>([\s\S]*?)<\/span>/g)]
      .map((m) => m[1].replace(/&amp;/g, "&").trim())
      .filter((text) => !/Concept B|RX Labs/.test(text));

    // The mockup must actually still have a stamp for this test to mean anything;
    // if it is ever removed at source, this filter would quietly become a no-op.
    expect(wanted).toHaveLength(1);

    const { container } = render(<MarketingFooter />);
    const got = [...container.querySelectorAll(".foot-legal .row span")].map((s) => s.textContent);
    expect(got).toEqual(wanted);
  });

  it("ships no mockup review artefacts in the footer", () => {
    const { container } = render(<MarketingFooter />);
    const text = container.textContent ?? "";
    for (const artefact of ["Concept B", "RX Labs", "V2."]) {
      expect(text).not.toContain(artefact);
    }
    // The three social icons were `href="#"` placeholders with no accounts behind
    // them. Dead links are worse than no icons; re-add once the handles exist.
    expect(container.querySelectorAll('a[href="#"]')).toHaveLength(0);
  });

  /**
   * The mockup prints no address so it cannot be scraped, and that still holds.
   * W3 moved the address into the `mailto:` href — where a scraper reads it
   * just as easily, but where the alternative was a form that faked a send.
   * The rule this protects is the visible copy, so that is what is asserted.
   */
  it("prints no email address in the visible copy", () => {
    const { container } = render(<MarketingFooter />);
    expect(container.textContent).not.toMatch(/@[\w.-]+\.\w+/);
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
  //
  // ENG-588 split this in two. These terms may never appear at all:
  it("carries no betting or bookmaker copy", () => {
    const offenders = routeGroupSources.filter(({ body }) =>
      /\b(odds|bookmaker|wager|sportsbet|tab\.com)\b/i.test(body),
    );
    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  // ...but "betting" cannot be banned outright, because the two strings that make
  // guardrail #8 legally true both name it in order to DISCLAIM it: the Important
  // note and the FAQ answer about shares and prize money. Both are client
  // signed-off and must ship character for character, so a blanket ban would
  // forbid the very copy the guardrail exists to require.
  //
  // The rule instead: strip the sanctioned prohibitions, and the word must be
  // gone. That still fails on "bet with us" while permitting "does not sell
  // betting products" — and if either sentence is ever paraphrased, its strip
  // stops matching and this test fails too, which is the behaviour we want.
  const SANCTIONED_PROHIBITIONS = [
    "does not sell shares in racehorses, syndicates, financial products, betting products, prize money rights, or investment returns",
    "do not receive prize money, financial returns, betting returns, or sale proceeds",
    // ENG-589 / W3: the full FAQ sheet carries the mockup's own betting
    // disclaimer, which the curated on-page FAQ omits. Both halves are
    // prohibitions — a question that exists only to be answered "No", and the
    // answer — so both are sanctioned. Same rule as above: paraphrase either
    // and its strip stops matching, and this test fails.
    "Is stablepass. a betting service?",
    "stablepass. is not a betting service and does not provide betting products",
  ];

  it("mentions betting only inside a sanctioned prohibition", () => {
    const offenders = routeGroupSources.filter(({ body }) => {
      // Source wraps copy across lines; the sentences are contiguous only once
      // whitespace is collapsed the way the DOM will render it.
      let rest = body.replace(/\s+/g, " ");
      for (const allowed of SANCTIONED_PROHIBITIONS) rest = rest.split(allowed).join("");
      return /\bbetting\b/i.test(rest);
    });
    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  it("still finds both prohibitions in the route group, so the allowance is not dead", () => {
    const all = routeGroupSources.map(({ body }) => body.replace(/\s+/g, " ")).join(" ");
    for (const prohibition of SANCTIONED_PROHIBITIONS) {
      expect(all, `sanctioned prohibition no longer present: ${prohibition}`).toContain(prohibition);
    }
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
    // W1 pinned the exact three its shell used — the wordmark and the two CSS
    // backgrounds — because a count-based check would not notice a dropped
    // reference. ENG-588 ported the twelve content sections, and the route group
    // now uses the WHOLE extracted set, so the pin becomes an exact set equality.
    // That keeps W1's intent and strengthens it in both directions: a dropped
    // reference and an asset nobody uses each break the equality, and neither
    // needs this list rewritten when the design changes.
    expect([...referenced].sort()).toEqual([...assets].sort());
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
    // ── ENG-600: the nav is no longer a byte-faithful port ────────────────────
    // ENG-600 added a "Sign in" entry, which the mockup's nav never had. That
    // means new rules (`.nav-actions`, `.nav-signin`), a narrow-viewport block
    // the mockup never needed, and one CHANGED rule: at <=880px the mockup
    // pushed `.nav-cta` right, but the CTA now sits inside `.nav-actions`, so
    // the group is pushed instead.
    //
    // Media blocks are flattened into their inner rules here, so that single
    // change deletes an inner `.nav-cta` entry and shifts every index after it,
    // which would report ~460 phantom mismatches. Rather than paper over that
    // with index arithmetic, the nav is lifted out of the ordered diff entirely
    // and pinned by its own test below. Everything else stays strictly guarded.
    const isNavRule = (selector: string) => /(^|[ ,>])\.nav(-|\b)/.test(selector);

    // An `@media` entry is a position marker with no declarations of its own —
    // the block's rules are flattened out alongside it and compared individually.
    // Dropping empty markers from BOTH sides costs no coverage (a removed block
    // still loses its inner rules) and stops ENG-600's nav-only 520px block from
    // registering as a phantom addition.
    const isEmptyMediaMarker = (r: { selector: string; decls: string }) =>
      r.selector.startsWith("@media") && r.decls.trim() === "";

    const wantRules = expected.filter(
      (r) => !EXCEPTIONS.has(r.selector) && !isNavRule(r.selector) && !isEmptyMediaMarker(r),
    );
    const gotRules = cssRules(MARKETING_CSS)
      .map((r) => ({ selector: unscope(r.selector), decls: r.decls }))
      .filter((r) => !isException(r.selector) && !isNavRule(r.selector) && !isEmptyMediaMarker(r));

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

    // Replaces the coverage the ordered diff gives up above. The nav IS still
    // pinned to the mockup — just rule by rule instead of by position, so the
    // one sanctioned change does not cascade into hundreds of false mismatches.
    describe("the nav is the mockup's, plus exactly ENG-600's documented deltas", () => {
      // Signatures, NOT a selector->decls map: media blocks are flattened into
      // their inner rules here, so `.nav-cta` legitimately appears twice (its
      // base rule and its 880px override) and a map would silently keep one.
      const navSigs = (rs: { selector: string; decls: string }[]) =>
        rs.filter((r) => isNavRule(r.selector)).map((r) => `${r.selector}{${r.decls}}`);

      const want = navSigs(expected);
      const got = navSigs(cssRules(MARKETING_CSS).map((r) => ({ selector: unscope(r.selector), decls: r.decls })));

      it("drops exactly one mockup rule, and only the one ENG-600 documents", () => {
        // At <=880px the mockup pushed `.nav-cta` right. The CTA now sits inside
        // `.nav-actions`, so the group is pushed instead and this rule goes.
        expect(want.filter((s) => !got.includes(s))).toEqual([".nav-cta{margin-left:auto}"]);
      });

      it("keeps every other mockup nav rule byte for byte", () => {
        // Implied by the assertion above, stated separately so a failure reads as
        // "the port drifted" rather than "the delta list is stale".
        const survived = want.filter((s) => s !== ".nav-cta{margin-left:auto}");
        expect(survived.every((s) => got.includes(s))).toBe(true);
      });

      it("adds rules only for the two new components", () => {
        // The invariant that matters: ENG-600 may introduce `.nav-actions` and
        // `.nav-signin`, and may not quietly restyle any mockup nav selector.
        const addedSelectors = got
          .filter((s) => !want.includes(s))
          .map((s) => s.slice(0, s.indexOf("{")));
        expect(addedSelectors.length).toBeGreaterThan(0);
        expect(addedSelectors.every((s) => s.startsWith(".nav-actions") || s.startsWith(".nav-signin"))).toBe(true);
      });

      it("still pushes the actions group right once the links are hidden", () => {
        // Losing this silently left-aligns the nav on every phone, which no
        // snapshot of the desktop layout would catch.
        expect(got).toContain(".nav-actions{margin-left:auto}");
        expect(got).toContain(".nav-links{display:none}");
      });
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
