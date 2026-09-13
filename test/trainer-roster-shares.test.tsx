import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// ENG-960 — the headline live bug: a stable whose horses are ALL for sale
// rendered an empty roster and a "0 Horses" stat on web, because the trainer
// profile's horse read carried `.eq("shares_for_sale", false)` (ENG-831).
// Mobile fixed the same thing in `lib/profiles.ts` `getTrainerHorses` during R8
// ("Liam Ruddy, found live"); this is web's half.
//
// Unit-level on purpose, same reasoning as `horse-profile-page.test.tsx`: this
// screen reads Supabase DIRECTLY rather than through its own BFF route, so
// `test/trainers-route.test.ts` does not cover it, and `sb` is untyped so `tsc`
// can never catch a re-narrowed query.

const { fromMock, horseChain } = vi.hoisted(() => {
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
      __data: tableData,
    };
    for (const key of ["select", "eq", "order", "limit"]) {
      (chain[key] as ReturnType<typeof vi.fn>).mockImplementation(() => chain);
    }
    return chain;
  }

  // Persistent chains so the spies survive the call and can be asserted on
  // (.rx/gotchas.md — a fresh chain per `from()` hands each test a new mock).
  const horseChain = makeChain("horse");
  const trainerChain = makeChain("trainer");
  const shared = makeChain("shared");
  (horseChain.__data as typeof tableData) = tableData;

  return {
    tableData,
    horseChain,
    fromMock: vi.fn((table: string) => {
      if (table === "horse") return horseChain;
      if (table === "trainer") return trainerChain;
      return shared;
    }),
  };
});

const tableData = horseChain.__data as Record<string, { data?: unknown; count?: number }>;

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  redirect: vi.fn(),
  usePathname: () => "/trainers/t1",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } } })) },
    from: fromMock,
    // `createSignedUrl` (singular) is what `signPhoto` calls for the trainer's
    // own cover photo. `createSignedUrls` (plural) is ENG-1057's addition —
    // `signPhotoMap` batch-signs the roster's `photo_url` column with it.
    storage: {
      from: vi.fn(() => ({
        createSignedUrl: vi.fn(async (p: string) =>
          p ? { data: { signedUrl: `https://sb.local/signed/${p}` } } : { data: null },
        ),
        createSignedUrls: vi.fn(async (paths: string[]) => ({
          data: paths.map((p) => ({ path: p, signedUrl: `https://sb.local/signed/${p}` })),
          error: null,
        })),
      })),
    },
  })),
}));

vi.mock("@/lib/api/subscription-state", () => ({
  readSubscriptionState: vi.fn(async () => ({ sub: null, entitled: true, everSubscribed: true })),
}));

// Client islands — irrelevant here and they drag in supabaseBrowser + fetch.
vi.mock("@/app/(member)/trainers/[id]/follow-notify", () => ({ FollowNotify: () => null }));
vi.mock("@/app/(member)/trainers/[id]/trainer-posts", () => ({ TrainerPosts: () => null }));
vi.mock("@/app/(member)/trainers/[id]/website-link", () => ({ WebsiteLink: () => null }));
// ENG-1057 follow-up: `stable-horses` is left UNMOCKED (the real `<StableHorses>`
// wraps the real `<HorseCard>`) so a test can assert the roster actually paints
// a signed photo, not merely that it received a `name`. Nothing else in this
// file depends on the earlier stub's `data-testid="stable-horses"` — it was
// only ever read by the mock's own JSX.

import TrainerProfilePage from "@/app/(member)/trainers/[id]/page";

const TRAINER = {
  id: "t1",
  name: "Chris Waller",
  display_name: null,
  stable_name: "Waller Racing",
  location: "Warwick Farm",
  bio: null,
  photo_url: null,
  website_url: null,
};

describe("ENG-960 — trainer roster includes for-sale horses", () => {
  beforeEach(() => {
    for (const key of Object.keys(tableData)) delete tableData[key];
    (horseChain.eq as ReturnType<typeof vi.fn>).mockClear();
  });

  it("a for-sale-only stable renders its roster instead of an empty one", async () => {
    tableData.trainer = { data: TRAINER };
    // Every horse in this stable is for sale. Under ENG-831 the query filtered
    // all three away and the page rendered an empty grid with a "0 Horses" stat.
    tableData.horse = {
      data: [
        { id: "h1", display_name: "Mahogany", racing_name: null, wins: 2 },
        { id: "h2", display_name: "Kingston", racing_name: null, wins: 1 },
        { id: "h3", display_name: "Anzac Day", racing_name: null, wins: 0 },
      ],
    };

    render(await TrainerProfilePage({ params: Promise.resolve({ id: "t1" }) }));

    expect(screen.getByText("Mahogany")).toBeInTheDocument();
    expect(screen.getByText("Kingston")).toBeInTheDocument();
    expect(screen.getByText("Anzac Day")).toBeInTheDocument();

    // The Horses stat is derived from the same rows — it must agree.
    const horsesStat = screen.getByText("Horses").previousSibling;
    expect(horsesStat).toHaveTextContent("3");
  });

  it("the roster query keeps its visibility filters but not the shares exclusion", async () => {
    tableData.trainer = { data: TRAINER };
    tableData.horse = { data: [{ id: "h1", display_name: "Mahogany", racing_name: null, wins: 0 }] };

    render(await TrainerProfilePage({ params: Promise.resolve({ id: "t1" }) }));

    // Positive anchors — the read still happened and is still scoped.
    expect(horseChain.eq).toHaveBeenCalledWith("trainer_id", "t1");
    expect(horseChain.eq).toHaveBeenCalledWith("status", "active");
    // The exclusion this ticket removes.
    expect(horseChain.eq).not.toHaveBeenCalledWith("shares_for_sale", false);
  });

  it("wins still sum across the whole roster, for-sale horses included", async () => {
    tableData.trainer = { data: TRAINER };
    tableData.horse = {
      data: [
        { id: "h1", display_name: "Mahogany", racing_name: null, wins: 4 },
        { id: "h2", display_name: "Kingston", racing_name: null, wins: 3 },
      ],
    };

    render(await TrainerProfilePage({ params: Promise.resolve({ id: "t1" }) }));

    const winsStat = screen.getByText("Wins").previousSibling;
    expect(winsStat).toHaveTextContent("7");
  });

  // `sb` is untyped, so `tsc` can never catch a too-narrow `.select()`: deleting
  // `photo_url` from this projection leaves the whole suite green (verified by
  // hand before adding this pin — every other assertion here reads `wins` /
  // `display_name`, never the projection string itself).
  it("pins the roster read's exact projection, including photo_url", async () => {
    tableData.trainer = { data: TRAINER };
    tableData.horse = { data: [{ id: "h1", display_name: "Mahogany", racing_name: null, wins: 0, photo_url: null }] };

    render(await TrainerProfilePage({ params: Promise.resolve({ id: "t1" }) }));

    expect(horseChain.select).toHaveBeenCalledWith("id, display_name, racing_name, wins, photo_url");
  });

  // ENG-1057 — the roster's own regression: the fixture above (and every other
  // one in this file) has `photo_url: null`. Add the one row that actually
  // carries a photo and prove it reaches the DOM as a signed <img>, through the
  // real (unmocked) <StableHorses> -> <HorseCard>.
  it("ENG-1057: a horse with a photo_url renders a signed <img class=horse-thumb-photo> in the roster", async () => {
    tableData.trainer = { data: TRAINER };
    tableData.horse = {
      data: [
        { id: "h1", display_name: "Mahogany", racing_name: null, wins: 2, photo_url: "horses/mahogany.jpg" },
        { id: "h2", display_name: "Kingston", racing_name: null, wins: 1, photo_url: null },
      ],
    };

    render(await TrainerProfilePage({ params: Promise.resolve({ id: "t1" }) }));

    const mahoganyCard = screen.getByText("Mahogany").closest("button")!;
    const img = mahoganyCard.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveClass("horse-thumb-photo");
    // The `createSignedUrls` echo mock in this file's `supabaseServer` stub.
    expect(img).toHaveAttribute("src", "https://sb.local/signed/horses/mahogany.jpg");

    // Kingston has no photo — initial only, no <img>, exactly as before.
    const kingstonCard = screen.getByText("Kingston").closest("button")!;
    expect(kingstonCard.querySelector("img")).toBeNull();
  });
});
