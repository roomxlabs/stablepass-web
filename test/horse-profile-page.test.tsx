import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";

// ENG-617 — the horse profile screen reads Supabase DIRECTLY (it does not call
// its own BFF route), so `test/horses-route.test.ts` does not cover it at all.
// That is exactly how the age formula came to exist in two places and be wrong
// in both.
//
// This file is the `(member)` half of the guard, and it exists at unit level on
// purpose: the only other thing exercising this screen is a Playwright spec that
// needs a running local Supabase and real credentials, and no CI runs it — so a
// narrowed `.select()` there goes unnoticed. `sb` is untyped, so `tsc`
// can never catch a projection that forgot `horse_age` / `horse_description` —
// the columns would simply arrive `undefined` and the pill would render empty
// for every horse on the site.

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
      // Awaiting the chain with no terminal method (the race_horse read and the
      // trainer's horse-count read both do this) resolves the same fixture.
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(result()).then(resolve, reject),
    };
    for (const key of ["select", "eq", "order", "limit"]) {
      (chain[key] as ReturnType<typeof vi.fn>).mockImplementation(() => chain);
    }
    return chain;
  }

  // Persistent, so the `select` spy survives the call and can be asserted on
  // (.rx/gotchas.md — a fresh chain per `from()` hands each test a new mock).
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

// The two client islands are irrelevant here and drag in supabaseBrowser + fetch.
vi.mock("@/app/(member)/horses/[id]/follow-notify", () => ({
  FollowNotify: () => null,
}));
vi.mock("@/app/(member)/horses/[id]/horse-posts", () => ({
  HorsePosts: () => null,
}));

import HorseProfilePage from "@/app/(member)/horses/[id]/page";
import { HORSE_PROFILE_COLUMNS } from "@/lib/horse/profile";

/** A horse row as PostgREST returns it, computed columns included. */
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
      trainer: null,
      ...over,
    },
  };
}

async function renderProfile() {
  return render(await HorseProfilePage({ params: Promise.resolve({ id: "h1" }) }));
}

describe("horse profile page — age + description come from the database (ENG-617)", () => {
  beforeEach(() => {
    fromMock.mockClear();
    horseSelectMock.mockClear();
    readSubscriptionStateMock.mockClear();
    for (const key of Object.keys(tableData)) delete tableData[key];
    tableData.race_horse = { data: [] };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function clockAt(iso: string) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(iso));
  }

  it("NAMES both computed columns in its own select — e2e is not the guard here", async () => {
    tableData.horse = horseRow({ horse_age: 5, horse_description: "gelding" });

    await renderProfile();

    // The profile read, not the trainer's `select("id", { count })`.
    const projection = horseSelectMock.mock.calls
      .map((call) => call[0] as string)
      .find((columns) => columns.includes("display_name"));

    expect(projection).toBeTruthy();
    expect(projection).toBe(HORSE_PROFILE_COLUMNS);
    for (const column of ["horse_age", "horse_description", "foaling_year", "sex", "is_gelded"]) {
      expect(projection).toContain(column);
    }
  });

  it("renders the pill as `5yo · gelding` from horse_age + horse_description", async () => {
    tableData.horse = horseRow({ sex: "male", is_gelded: true, foaling_year: 2021, horse_age: 5, horse_description: "gelding" });

    await renderProfile();

    // Positive first — the whole screen walls out on a lapsed session, and every
    // negative assertion below would pass vacuously against that wall.
    expect(screen.getByRole("heading", { name: "Mahogany" })).toBeTruthy();
    expect(screen.getByText("5yo · gelding")).toBeTruthy();
  });

  it("flips at the 1 AUGUST boundary — 3yo · filly, then 4yo · mare — with no code change", async () => {
    clockAt("2026-07-31T12:00:00+10:00");
    tableData.horse = horseRow({ sex: "female", foaling_year: 2022, horse_age: 3, horse_description: "filly" });
    const before = await renderProfile();
    expect(screen.getByText("3yo · filly")).toBeTruthy();
    before.unmount();

    clockAt("2026-08-01T12:00:00+10:00");
    tableData.horse = horseRow({ sex: "female", foaling_year: 2022, horse_age: 4, horse_description: "mare" });
    await renderProfile();
    expect(screen.getByText("4yo · mare")).toBeTruthy();
  });

  it("does not change its answer across the New Year — the screen has no opinion about dates", async () => {
    const row = horseRow({ sex: "female", foaling_year: 2022, horse_age: 4, horse_description: "mare" });

    // Two days either side: `getFullYear()` reads the HOST timezone, so instants
    // an hour apart can land in the same calendar year on the test machine.
    clockAt("2026-12-30T12:00:00Z");
    tableData.horse = row;
    const before = await renderProfile();
    expect(screen.getByText("4yo · mare")).toBeTruthy();
    before.unmount();

    clockAt("2027-01-02T12:00:00Z");
    tableData.horse = row;
    await renderProfile();
    expect(screen.getByText("4yo · mare")).toBeTruthy();
  });

  it("renders NO pill at all for a horse with no foaling year — not an empty one, not a stray separator", async () => {
    tableData.horse = horseRow({ sex: "female", foaling_year: null, horse_age: null, horse_description: null });

    const { container } = await renderProfile();

    expect(screen.getByRole("heading", { name: "Mahogany" })).toBeTruthy();
    const statusRow = container.querySelector(".status-row")!;
    expect(statusRow).toBeTruthy();
    // The training-status tag, and nothing else — an empty <span class="tag">
    // would render as a bare pill with no text in it.
    expect(statusRow.querySelectorAll(".tag")).toHaveLength(1);
    expect(statusRow.textContent).not.toContain("·");
    expect(statusRow.textContent).not.toContain("yo");
  });

  it("renders a gelding with no foaling year as `gelding` alone", async () => {
    tableData.horse = horseRow({ sex: "male", is_gelded: true, foaling_year: null, horse_age: null, horse_description: "gelding" });

    const { container } = await renderProfile();

    expect(screen.getByText("gelding")).toBeTruthy();
    const statusRow = container.querySelector(".status-row")!;
    expect(statusRow.querySelectorAll(".tag")).toHaveLength(2);
    expect(statusRow.textContent).not.toContain("·");
  });

  it("GUARDRAIL: a hidden horse notFound()s — never a partial render", async () => {
    // The route asserts 404 for hidden content; this is the direct-read half,
    // which has its own copy of that branch. It matters during the ENG-619
    // window too: a 42703 on an undeployed computed column lands here.
    tableData.horse = { data: null };

    await expect(renderProfile()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("GUARDRAIL: a lapsed member gets the wall, never a horse with an age", async () => {
    readSubscriptionStateMock.mockResolvedValueOnce({ sub: null, entitled: false, everSubscribed: true });
    tableData.horse = horseRow({ sex: "male", is_gelded: true, foaling_year: 2021, horse_age: 5, horse_description: "gelding" });

    const { container } = await renderProfile();

    // The wall must be PRESENT, not merely the content absent. `toBeNull()` on
    // the header is another negative: a screen that regressed to rendering
    // nothing at all would satisfy every negative below while telling a lapsed
    // member nothing. Guardrail #3 requires the reactivate prompt itself.
    expect(screen.getByTestId("access-wall")).toBeTruthy();
    expect(container.querySelector(".profile-header-web")).toBeNull();
    expect(container.textContent).not.toContain("Mahogany");
    expect(container.textContent).not.toContain("5yo");
    expect(container.textContent).not.toContain("gelding");
    // It never even asked for the horse row.
    expect(horseSelectMock).not.toHaveBeenCalled();
  });
});

// ─── The repo-wide guard ────────────────────────────────────────────────────
// The point of ENG-617 is that web ends up with ZERO age arithmetic. A second
// copy of the formula is how this bug survived for months, so assert the
// absence structurally rather than trusting review to notice a re-introduction.
describe("no horse age arithmetic survives anywhere in the web app", () => {
  // `e2e` is in scope because the harness seeded `foaling_year: thisYear - 5`
  // until this change; `test` is deliberately out, because this file's own
  // patterns would match themselves.
  const roots = ["app", "lib", "components", "e2e"];

  // Matching on the IDENTIFIER, not on adjacency. The first pattern alone is
  // trivially defeated by the refactor anyone would reach for —
  //   const y = new Date().getFullYear();
  //   const age = y - row.foaling_year;
  // — which puts `row.` between the operator and the name, and moves the date
  // call to another line entirely. `[\w.]*` steps over that.
  const dateArithmetic = [
    /get(?:UTC)?FullYear\(\)\s*-/,
    /[-+*/]\s*[\w.]*foaling_?[Yy]ear/,
    /foaling_?[Yy]ear\s*[-+*/]/,
  ];
  const sources: { file: string; text: string }[] = [];

  // Comment lines are stripped before scanning: prose cannot reintroduce the
  // bug, and lib/horse/profile.ts deliberately quotes the deleted formula to
  // record what was wrong with it. The guard is about CODE.
  function codeOnly(text: string): string {
    return text
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
  }

  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next") continue;
        walk(full);
      } else if (/\.tsx?$/.test(entry.name)) {
        sources.push({ file: full, text: codeOnly(fs.readFileSync(full, "utf8")) });
      }
    }
  }
  for (const root of roots) walk(path.join(process.cwd(), root));

  it("scans a non-trivial number of source files (the guard itself must not be vacuous)", () => {
    expect(sources.length).toBeGreaterThan(20);
  });

  it("the guard's own patterns catch every shape the formula could come back in", () => {
    // A guard nobody has tested is a guard that silently rots.
    const reintroductions = [
      "const age = new Date().getFullYear() - foalingYear;",
      "const thisYear = new Date().getFullYear();\nconst age = thisYear - row.foaling_year;",
      "const age = new Date().getUTCFullYear() - row.foaling_year;",
      "const age = sydneyYear() - horse.foaling_year;",
      "const age = foalingYear ? year - foalingYear : null;",
    ];
    for (const snippet of reintroductions) {
      expect(dateArithmetic.some((pattern) => pattern.test(snippet))).toBe(true);
    }

    // …and do not fire on the legitimate uses that must survive.
    const benign = [
      '.select("id, colour, foaling_year, horse_age, horse_description")',
      "  foaling_year: number | null;",
      "const year = new Date().getFullYear();",
      "ageDescriptionLine(row.horse_age, row.horse_description)",
    ];
    for (const snippet of benign) {
      expect(dateArithmetic.some((pattern) => pattern.test(snippet))).toBe(false);
    }
  });

  it("computes no age from a date anywhere — the derivation lives in Postgres", () => {
    const offenders = sources
      .filter(({ text }) => dateArithmetic.some((pattern) => pattern.test(text)))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("has no `ageSex` or `ageSexLabel` left — both duplicated formulas are deleted", () => {
    // Word-boundary anyway, though the replacement is now `ageDescriptionLine`
    // and no longer contains the string at all.
    const offenders = sources
      .filter(({ text }) => /\bageSex\b/.test(text) || /\bageSexLabel\b/.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });


});
