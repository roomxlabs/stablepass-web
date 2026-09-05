// ENG-613 (W2) — member card parity with mobile, rows 3 to 6 of the divergence
// list. These assertions read the STYLESHEET SOURCE rather than a rendered node:
// jsdom applies no real stylesheet and resolves no custom property, so a
// render-level `toHaveStyle` here would pass vacuously against an empty string.
// Reading the CSS is what actually pins option D, the reorder and the pill.
//
// Design source: 06-stage1-design/mockups/web/style.css, round 5 member block
// (re-cut 17 Aug 2026) + screens/06-explore.html.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PANEL_PARAGRAPH_GAP } from "@/components/post-card";

/**
 * Comments are stripped before anything is asserted. Several rules here carry a
 * comment that NAMES the selector it replaced, and an un-stripped "does not
 * contain" check would then fail on the explanation rather than on the CSS.
 */
const strip = (css: string) =>
  css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // Collapse whitespace and combinator spacing. A guard written as
    // `a + b` is otherwise defeated by a line wrap OR by `a+b`.
    .replace(/[^\S\n]+/g, " ")
    .replace(/\s*\+\s*/g, " + ");

const GLOBALS = strip(readFileSync(join(process.cwd(), "app/globals.css"), "utf8"));
const MARKETING = strip(readFileSync(join(process.cwd(), "app/(marketing)/marketing.css"), "utf8"));

/** The one rule whose body we care about, matched by its exact selector. */
function rule(selector: string, css = GLOBALS): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(^|\\})\\s*${escaped}\\s*\\{[^}]*\\}`, "m"));
  expect(match, `no rule found for \`${selector}\``).not.toBeNull();
  return match![0];
}

describe("ENG-613 row 3 — names are Inter 500 on #3A3A38 (option D)", () => {
  // The literal itself. Deliberately restated per-repo rather than imported from
  // mobile's token, so neither codebase can drift the other silently.
  it("defines --name-ink as the design source's literal", () => {
    expect(GLOBALS).toMatch(/--name-ink:\s*#3A3A38;/i);
  });

  it("sets the horse name in the sans stack at weight 500 on --name-ink", () => {
    const horse = rule(".post-meta-web .post-horse");
    expect(horse).toContain("font-family: var(--font-sans)");
    expect(horse).toContain("font-weight: 500");
    expect(horse).toContain("color: var(--name-ink)");
  });

  // Row 3 is two client calls behind until the serif is actually gone: ENG-419
  // moved names off Cormorant on 5 Aug, option D set weight + colour on 17 Aug.
  it("leaves no serif on the horse name", () => {
    expect(rule(".post-meta-web .post-horse")).not.toContain("--font-serif");
  });

  // `--font-sans` is what makes "Inter" true rather than merely "not Cormorant".
  it("binds --font-sans to the Inter face", () => {
    expect(GLOBALS).toMatch(/--font-sans:\s*var\(--font-inter\)/);
  });
});

describe("ENG-613 row 4 — the caption sits below the reaction bar", () => {
  it("makes the card a flex column so `order` applies at all", () => {
    const card = rule(".post-web");
    expect(card).toContain("display: flex");
    expect(card).toContain("flex-direction: column");
  });

  // The reorder is global to `.post-web`, which is exactly why the horse- and
  // trainer-profile feeds inherit it without being touched (scope decision 7).
  it("orders head, media/panel, reactions, contact CTA, caption", () => {
    expect(rule(".post-head-web")).toContain("order: -3");
    expect(rule(".post-media-web")).toContain("order: -2");
    expect(rule(".post-panel")).toContain("order: -2");
    expect(rule(".post-actions-web")).toContain("order: 1");
    // ENG-831: Shares Contact-trainer CTA sits between reactions and caption.
    expect(rule(".post-contact-cta")).toContain("order: 2");
    expect(rule(".post-body-web")).toContain("order: 3");
  });

  // An uncaptioned post must be spaced like a captioned one. The old rules were
  // `.post-media-web + .post-actions-web` and `.post-head-web + .post-actions-web`,
  // which stopped describing the order the moment the caption moved.
  it("gives the reaction bar its top padding unconditionally", () => {
    // `.post-actions-web` now has TWO rules (the `order` one above and the
    // layout one); pick the one that actually declares padding rather than
    // whichever comes first in the file.
    const rules = GLOBALS.match(/^\.post-actions-web\s*\{[^}]*\}/gm) ?? [];
    const withPadding = rules.filter((r) => r.includes("padding:"));
    expect(withPadding, "exactly one .post-actions-web rule should set padding").toHaveLength(1);
    expect(withPadding[0]).toMatch(/padding:\s*14px 22px 18px/);
  });

  it("no longer relies on the adjacent-sibling selectors that stopped matching", () => {
    expect(GLOBALS).not.toContain(".post-media-web + .post-actions-web");
    expect(GLOBALS).not.toContain(".post-head-web + .post-actions-web");
  });
});

describe("ENG-613 row 5 — the Follow pill", () => {
  const pill = () => rule(".post-media-web .media-follow");

  it("is transparent with a white rim and a white label, top-right inset 12", () => {
    expect(pill()).toContain("background: transparent");
    expect(pill()).toContain("border: 1px solid rgba(255,255,255,0.95)");
    expect(pill()).toContain("color: #FFFFFF");
    expect(pill()).toContain("top: 12px");
    expect(pill()).toContain("right: 12px");
  });

  it("carries no shadow", () => {
    expect(pill()).toContain("box-shadow: none");
  });

  // The accepted contrast cost is a DRI decision recorded in M3 and in the
  // design source. A fill added later to make the label pass 4.5:1 would be a
  // silent reversal of it, so the absence of one is asserted, not assumed.
  it("has no fill added to buy contrast", () => {
    const fills = pill().match(/background(-color)?\s*:\s*[^;]+/g) ?? [];
    expect(fills).toEqual(["background: transparent"]);
  });
});

describe("ENG-613 row 6 — the STABLE UPDATE card", () => {
  it("draws the pill in brand green on cream", () => {
    const badge = rule(".post-web .post-badge");
    expect(badge).toContain("background: var(--brand-green)");
    expect(badge).toContain("color: var(--cream)");
    expect(badge).toContain("text-transform: uppercase");
  });

  // Inter, NOT the website sample's serif: two client calls have already moved
  // names off Cormorant, and 22 is one point up from mobile's 20 for the wider
  // web column.
  it("sets the title in Inter 600 at 22, not the sample's serif", () => {
    const title = rule(".post-web .post-title");
    expect(title).toContain("font-family: var(--font-sans)");
    expect(title).toContain("font-size: 22px");
    expect(title).toContain("font-weight: 600");
    expect(title).not.toContain("--font-serif");
  });

  // The panel is INSET rather than bleeding like the media box, because the web
  // card has horizontal padding the phone card does not.
  it("insets the panel from the card edges", () => {
    const panel = rule(".post-web .post-panel");
    expect(panel).toContain("background: var(--cream)");
    expect(panel).toMatch(/margin:\s*0 22px/);
  });

  it("rules off the panel footer", () => {
    expect(rule(".post-web .post-panel-foot")).toContain("border-top: 1px solid var(--line)");
  });
});

// ===========================================================================
// ROUND 6 / ENG-761 — the caption clamp, the photo chip and the nowrap fix on
// the profile stat labels. Same rationale as the ENG-613 block above: jsdom
// applies no real stylesheet, so these read the CSS SOURCE directly.
// ===========================================================================
describe("ENG-761 item 2 — the caption clamps to two lines", () => {
  it("clamps .post-caption.clamped to a 2-line -webkit-box", () => {
    const clamp = rule(".post-body-web .post-caption.clamped");
    expect(clamp).toContain("-webkit-line-clamp: 2");
    expect(clamp).toContain("-webkit-box-orient: vertical");
  });
});

// A single unbreakable token (a pasted replay URL) lays ONE line box wider than
// the column, so the clamp's vertical measurement sees no overflow and offers no
// "more" — while `overflow: hidden` clips the tail. Wrapping is what keeps that
// caption readable, so it is pinned rather than left to be "tidied" away.
describe("ENG-761 item 2 — a long unbreakable token still wraps", () => {
  it("sets overflow-wrap on the caption so a pasted URL cannot silently clip", () => {
    expect(rule(".post-body-web .post-caption")).toContain("overflow-wrap: anywhere");
  });
});

describe("ENG-761 item 3 — the photo chip mirrors the video duration chip", () => {
  it("sits in the same corner as the duration chip", () => {
    const chip = rule(".post-media-web .media-photo-chip");
    expect(chip).toContain("bottom: 14px");
    expect(chip).toContain("left: 14px");
  });

  it("shares the exact same scrim as .media-duration, pinning the 'mirrors' claim", () => {
    const chip = rule(".post-media-web .media-photo-chip");
    const duration = rule(".post-media-web .media-duration");
    expect(chip).toContain("rgba(0,0,0,0.6)");
    expect(duration).toContain("rgba(0,0,0,0.6)");
  });
});

describe("ENG-761 item 5 — the profile stat label never wraps", () => {
  it("sets white-space: nowrap on .profile-stats-web .stat-label", () => {
    expect(rule(".profile-stats-web .stat-label")).toContain("white-space: nowrap");
  });
});

// Guardrail. `marketing.css` is a separate, deliberately different design system
// diffed rule-for-rule by test/marketing-shell.test.tsx, and `.btn`/`.btn-ghost`
// exist in BOTH sheets — so a globals.css addition leaking across is a real and
// easy mistake, not a hypothetical one.
// ===========================================================================
// ENG-958 — head avatar shape (boxy, not a disc) and the panel's line-clamp.
// ===========================================================================
describe("ENG-958 — the head avatar is a rounded BOX, not a circle", () => {
  it("gives .post-avatar-web a 14px radius, not 50%", () => {
    const avatar = rule(".post-avatar-web");
    expect(avatar).toContain("border-radius: 14px");
    expect(avatar).not.toContain("border-radius: 50%");
  });

  // The stable's mark, unlike a profile photo, stays a circle — a future
  // "round the avatars" sweep must not take this rule with it.
  it("keeps .post-panel-foot .av a CIRCLE — the stable's mark, not a profile photo", () => {
    expect(rule(".post-web .post-panel-foot .av")).toContain("border-radius: 50%");
  });
});

describe("ENG-958 — the panel clamp cannot be a per-box -webkit-line-clamp", () => {
  it("has no CSS rule putting -webkit-line-clamp on .post-panel-clamp", () => {
    // The 8-line budget spans PARAGRAPHS (panelClampHeight walks them and
    // charges the gaps between); a `-webkit-line-clamp` caps one box, so it
    // cannot express that budget. The height instead comes from an inline
    // `maxHeight` computed in JS — there is deliberately no CSS rule here at
    // all, which this test also confirms.
    const match = GLOBALS.match(/\.post-panel-clamp[^{]*\{[^}]*\}/);
    if (match) {
      expect(match[0]).not.toContain("-webkit-line-clamp");
    } else {
      expect(GLOBALS).not.toContain(".post-panel-clamp");
    }
  });

  // The STYLE and the arithmetic must be the SAME number, or the clamp is
  // silently wrong: panelClampHeight() charges PANEL_PARAGRAPH_GAP for every
  // gap it crosses, and that only matches what the member actually sees if
  // the stylesheet's own paragraph spacing agrees.
  it("sets .post-panel p's margin-bottom to PANEL_PARAGRAPH_GAP (12px)", () => {
    expect(PANEL_PARAGRAPH_GAP).toBe(12);
    const para = rule(".post-web .post-panel p");
    expect(para).toMatch(new RegExp(`margin:\\s*0 0 ${PANEL_PARAGRAPH_GAP}px`));
  });
});

describe("ENG-613 guardrail — nothing leaks into the frozen marketing sheet", () => {
  it("keeps every new member class and token out of marketing.css", () => {
    for (const token of [
      "--name-ink",
      "media-follow",
      "post-badge",
      "post-panel",
      "post-title",
      "post-actions-web",
      "post-body-web",
    ]) {
      expect(MARKETING, `marketing.css must not mention \`${token}\``).not.toContain(token);
    }
  });
});
