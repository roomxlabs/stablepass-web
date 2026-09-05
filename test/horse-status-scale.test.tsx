import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";

// ENG-959 — the status scale + labels ported from mobile, plus the
// shares-for-sale pill/CTA on the horse profile. This file is deliberately
// separate from test/horse-profile-page.test.tsx (another PR owns that file's
// diff) even though it reuses the same supabase-mock harness style.

import {
  HORSE_PROFILE_COLUMNS,
  statusTagClassOf,
  trainingStatusLabel,
} from "@/lib/horse/profile";
import { hasLinkableWebsite, safeHref } from "@/lib/trainer/website";

describe("statusTagClassOf — the colour class per training_status", () => {
  it.each([
    ["breaking_in", "status-breaking"],
    ["pre_training", "status-pre-training"],
    ["in_training", "status-in-training"],
    ["farm_training", "status-in-training"],
    ["city_training", "status-in-training"],
    ["racing", "status-racing"],
  ])("%s -> %s", (status, cls) => {
    expect(statusTagClassOf(status)).toBe(cls);
  });

  it.each([
    ["spelling"],
    ["retired"],
    [null],
    [undefined],
    ["some-unknown-status"],
  ])("%s -> the neutral empty class", (status) => {
    expect(statusTagClassOf(status as string | null | undefined)).toBe("");
  });
});

describe("trainingStatusLabel — the copy per training_status", () => {
  it.each([
    ["spelling", "Spelling"],
    ["breaking_in", "Breaking in"],
    ["pre_training", "Pre-training"],
    ["in_training", "In training"],
    ["racing", "Racing"],
    ["retired", "Retired"],
  ])("%s -> %s", (status, label) => {
    expect(trainingStatusLabel(status)).toBe(label);
  });

  // The whole point of the port: both legacy training-yard spellings collapse
  // to the SAME label as in_training, never their own "Farm training" /
  // "City training" text.
  it("farm_training -> 'In training'", () => {
    expect(trainingStatusLabel("farm_training")).toBe("In training");
  });
  it("city_training -> 'In training'", () => {
    expect(trainingStatusLabel("city_training")).toBe("In training");
  });

  it.each([[null], [undefined], ["some-unknown-status"]])(
    "%s -> 'Spelling'",
    (status) => {
      expect(trainingStatusLabel(status as string | null | undefined)).toBe("Spelling");
    },
  );
});

describe("HORSE_PROFILE_COLUMNS — the shares projection", () => {
  it("selects shares_for_sale on the horse row", () => {
    expect(HORSE_PROFILE_COLUMNS).toContain("shares_for_sale");
  });

  // The counterpart guard, and the more important of the two. This constant is
  // shared with app/api/horses/[id]/route.ts, which returns the `trainer` embed
  // VERBATIM in its response envelope — so a trainer field added here silently
  // becomes part of that route's public contract. The horse profile reads
  // `website_url` itself instead; this pins that decision so a future "just add
  // it to the embed" cannot quietly re-publish it.
  it("does NOT widen the trainer embed with website_url — the BFF returns it verbatim", () => {
    const trainerEmbed = HORSE_PROFILE_COLUMNS.split("trainer:trainer_id(")[1];
    expect(trainerEmbed).toBeTruthy();
    expect(trainerEmbed).not.toContain("website_url");
  });
});

describe("hasLinkableWebsite — the CTA gate (lib/trainer/website.ts)", () => {
  it.each([
    ["https://wallerracing.example"],
    ["http://wallerracing.example"],
    ["https://wallerracing.example/stable?x=1"],
  ])("%s is linkable", (url) => {
    expect(hasLinkableWebsite(url)).toBe(true);
  });

  it.each([
    ["a bare domain", "wallerracing.com.au"],
    ["a non-http scheme", "ftp://wallerracing.example"],
    ["a javascript: url", "javascript:alert(1)"],
    ["whitespace only", "   "],
    ["empty", ""],
    ["null", null],
    ["undefined", undefined],
  ])("%s is NOT linkable", (_label, url) => {
    expect(hasLinkableWebsite(url as string | null | undefined)).toBe(false);
  });

  it("preserves the admin's original string rather than a normalised href", () => {
    // `new URL()` would append a trailing slash to a bare origin; the link must
    // point at what the admin actually entered.
    expect(safeHref("https://wallerracing.example")).toBe("https://wallerracing.example");
  });

  // The module must stay directive-free so a SERVER component can import it.
  // This is the regression guard for the RSC boundary error that only showed up
  // in Playwright: `tsc` and jsdom both pass while the real page 500s.
  it("is not a client module — a server component imports it", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "lib/trainer/website.ts"), "utf8");
    // Anchored to a real DIRECTIVE — a bare quoted string on its own line — not
    // to the phrase anywhere in the file. The module's own header comment quotes
    // `"use client"` while explaining why it must not be one, and a loose match
    // fails on that comment, which is a false red about the opposite of the bug.
    expect(src).not.toMatch(/^\s*["']use client["']\s*;?\s*$/m);
    // And it must stay import-free. The directive check alone would still pass
    // the day someone imports a client component in here and drags the boundary
    // back across with it.
    expect(src).not.toMatch(/^\s*import\s/m);
  });
});

describe("app/globals.css — the status scale + shares pill grounds", () => {
  const css = fs.readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");

  // Matched with tolerant whitespace on purpose. These four rules are
  // column-ALIGNED in globals.css for readability, and pinning the exact run of
  // spaces would turn any future re-align — or a Prettier pass over the
  // stylesheet — into a false red about a colour that never moved. The VALUES
  // are what this guard is for.
  const rule = (cls: string, ground: string, ink: string) =>
    new RegExp(
      `\\.tag\\.${cls}\\s*\\{\\s*background:\\s*${ground.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")};\\s*color:\\s*var\\(--${ink}\\);\\s*\\}`,
    );

  it("has the four .tag.status-* rules with their exact grounds", () => {
    // The hexes are mobile's StatusScale, restated here so a change to either
    // side has to be a deliberate two-file edit.
    expect(css).toMatch(rule("status-breaking", "#E4C98F", "ink"));
    expect(css).toMatch(rule("status-pre-training", "#C3D9BB", "ink"));
    expect(css).toMatch(rule("status-in-training", "var(--brand-green-dark)", "cream"));
    expect(css).toMatch(rule("status-racing", "#5C4033", "cream"));
  });

  it("keeps status-in-training on the DARK green token, distinct from the plain Shares pill green", () => {
    // The Shares pill (.tag.race-day) owns plain --brand-green; an In-training
    // pill sitting beside it must never read as a second copy of that chip.
    expect(css).toMatch(rule("status-in-training", "var(--brand-green-dark)", "cream"));
    expect(css).not.toMatch(/\.tag\.status-in-training\s*\{\s*background:\s*var\(--brand-green\)\s*;/);
  });

  it("declares NO rule for spelling/retired — neutral IS the plain .tag", () => {
    // Not cosmetic: a `.tag.status-spelling` rule existing at all would mean the
    // mapping had started inventing a fifth colour for the bland statuses.
    expect(css).not.toMatch(/\.tag\.status-spelling\b/);
    expect(css).not.toMatch(/\.tag\.status-retired\b/);
  });
});

// ─── Page-render tests: the shares pill + CTA on the horse profile ────────

const { fromMock, horseSelectMock, tableData } = vi.hoisted(() => {
  const tableData: Record<string, { data?: unknown; count?: number }> = {};

  function makeChain(table: string) {
    const result = () => tableData[table] ?? { data: null };
    const chain: Record<string, unknown> = {
      select: vi.fn(),
      eq: vi.fn(),
      order: vi.fn(),
      limit: vi.fn(),
      maybeSingle: vi.fn(async () => result()),
      single: vi.fn(async () => result()),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(result()).then(resolve, reject),
    };
    for (const key of ["select", "eq", "order", "limit"]) {
      (chain[key] as ReturnType<typeof vi.fn>).mockImplementation(() => chain);
    }
    return chain;
  }

  const horseChain = makeChain("horse");

  return {
    fromMock: vi.fn((table: string) => (table === "horse" ? horseChain : makeChain(table))),
    horseSelectMock: horseChain.select as ReturnType<typeof vi.fn>,
    tableData,
  };
});

const { readSubscriptionStateMock } = vi.hoisted(() => ({
  readSubscriptionStateMock: vi.fn(async () => ({ sub: null, entitled: true, everSubscribed: true })),
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  redirect: vi.fn(),
  usePathname: () => "/horses/h1",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } } })) },
    from: fromMock,
    storage: { from: vi.fn(() => ({ createSignedUrl: vi.fn(async () => ({ data: null })) })) },
  })),
}));

vi.mock("@/lib/api/subscription-state", () => ({
  readSubscriptionState: readSubscriptionStateMock,
}));

vi.mock("@/app/(member)/horses/[id]/follow-notify", () => ({
  FollowNotify: () => null,
}));
vi.mock("@/app/(member)/horses/[id]/horse-posts", () => ({
  HorsePosts: () => null,
}));

import HorseProfilePage from "@/app/(member)/horses/[id]/page";

// The embed no longer carries `website_url` — the page reads it from the
// `trainer` table itself (see the note on TrainerRow in lib/horse/profile.ts),
// so these tests seed `tableData.trainer` for the CTA cases.
const TRAINER = { id: "t1", name: "Chris Waller", stable_name: "Waller Racing", location: "Rosehill" };

function horseRow(over: Record<string, unknown>) {
  return {
    data: {
      id: "h1",
      sire: "Snitzel",
      dam: "Polar Success",
      display_name: "Snitzel x Polar Success",
      racing_name: "Mahogany",
      sex: null,
      is_gelded: false,
      colour: null,
      foaling_year: null,
      horse_age: null,
      horse_description: null,
      training_status: "racing",
      starts: 24,
      wins: 6,
      places: 9,
      prize_money_cents: 120_000_000,
      story: null,
      photo_url: null,
      shares_for_sale: false,
      trainer: null,
      ...over,
    },
  };
}

async function renderProfile() {
  return render(await HorseProfilePage({ params: Promise.resolve({ id: "h1" }) }));
}

describe("horse profile page — Shares Available pill + trainer website CTA (ENG-959)", () => {
  beforeEach(() => {
    fromMock.mockClear();
    horseSelectMock.mockClear();
    readSubscriptionStateMock.mockClear();
    for (const key of Object.keys(tableData)) delete tableData[key];
    tableData.race_horse = { data: [] };
  });

  it("shares_for_sale + a trainer website: renders both the Shares Available tag AND the website CTA", async () => {
    tableData.horse = horseRow({ shares_for_sale: true, trainer: TRAINER });
    tableData.trainer = { data: { website_url: "https://wallerracing.example" } };

    const { container } = await renderProfile();

    expect(screen.getByText("Shares Available")).toBeTruthy();
    const cta = container.querySelector(".profile-shares-cta-web");
    expect(cta).toBeTruthy();
    expect(screen.getByRole("link", { name: /visit trainer website/i })).toBeTruthy();
  });

  it("shares_for_sale false: renders NEITHER the pill NOR the CTA", async () => {
    tableData.horse = horseRow({ shares_for_sale: false, trainer: TRAINER });
    tableData.trainer = { data: { website_url: "https://wallerracing.example" } };

    const { container } = await renderProfile();

    expect(screen.queryByText("Shares Available")).toBeNull();
    expect(container.querySelector(".profile-shares-cta-web")).toBeNull();
    expect(screen.queryByRole("link", { name: /visit trainer website/i })).toBeNull();

    // And the profile pays NOTHING for a feature it cannot show: the trainer
    // read is gated on shares_for_sale, so it must not be issued at all here.
    // Without this, the gate could quietly become "fetch always, render maybe".
    expect(fromMock).not.toHaveBeenCalledWith("trainer");
  });

  it("shares_for_sale true but trainer has no website_url: renders the pill but NO CTA link", async () => {
    tableData.horse = horseRow({ shares_for_sale: true, trainer: TRAINER });
    tableData.trainer = { data: { website_url: null } };

    const { container } = await renderProfile();

    expect(screen.getByText("Shares Available")).toBeTruthy();
    expect(container.querySelector(".profile-shares-cta-web")).toBeNull();
    expect(screen.queryByRole("link", { name: /visit trainer website/i })).toBeNull();
  });

  // The realistic admin entry, and the one a truthiness gate gets wrong: a bare
  // domain is a non-empty string but NOT an absolute http(s) URL, so
  // `WebsiteLink` renders nothing. If the WRAPPER were gated on truthiness it
  // would still be drawn — an empty, margined row leaving a phantom gap in the
  // header card. Nothing must be rendered, wrapper included.
  it.each([
    ["a bare domain", "wallerracing.com.au"],
    ["a non-http scheme", "ftp://wallerracing.example"],
    ["whitespace only", "   "],
  ])("shares_for_sale true but the website is unlinkable (%s): no CTA and no empty wrapper", async (_label, url) => {
    tableData.horse = horseRow({ shares_for_sale: true, trainer: TRAINER });
    tableData.trainer = { data: { website_url: url } };

    const { container } = await renderProfile();

    expect(screen.getByText("Shares Available")).toBeTruthy();
    expect(container.querySelector(".profile-shares-cta-web")).toBeNull();
    expect(screen.queryByRole("link", { name: /visit trainer website/i })).toBeNull();
  });

  it("never renders the deleted 'Career stats' caption", async () => {
    tableData.horse = horseRow({ shares_for_sale: true, trainer: TRAINER });
    tableData.trainer = { data: { website_url: "https://wallerracing.example" } };

    const { container } = await renderProfile();

    expect(container.textContent).not.toContain("Career stats");
  });

  it("a farm_training horse renders 'In training' with the status-in-training class", async () => {
    tableData.horse = horseRow({ training_status: "farm_training" });

    const { container } = await renderProfile();

    expect(screen.getByText("In training")).toBeTruthy();
    const statusTag = container.querySelector(".status-row .tag.status-in-training");
    expect(statusTag).toBeTruthy();
    expect(statusTag!.textContent).toBe("In training");
  });
});
