import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for the marketing trainers fetch (lib/marketing/trainers.ts).
 *
 * The module reads the anon-only `public_trainer` view via a plain
 * @supabase/supabase-js client, so we stub that: `from().select().order()` is
 * awaitable and resolves a per-test fixture. Covers the row -> Trainer mapping
 * (display name, location, bio, public photo URL, computed initials), the horses
 * field being dropped, and the fall-back-to-empty behaviour that lets the strip
 * keep the static list.
 */
const { fromMock, orderResult, selectSpy } = vi.hoisted(() => {
  const orderResult: { data?: unknown; error?: unknown } = { data: [], error: null };
  const selectSpy = vi.fn();
  const chain = {
    select: (...args: unknown[]) => {
      selectSpy(...args);
      return chain;
    },
    order: () => Promise.resolve(orderResult),
  };
  const fromMock = vi.fn(() => chain);
  return { fromMock, orderResult, selectSpy };
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ from: fromMock })),
}));

import { getMarketingTrainers, initialsOf } from "@/lib/marketing/trainers";

const BASE = "https://proj.supabase.co";

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = BASE;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  orderResult.data = [];
  orderResult.error = null;
  fromMock.mockClear();
  // mockReset, not mockClear: the fallback case installs an implementation that
  // would otherwise keep firing (and blanking orderResult) in later tests. The
  // chain ignores this spy's return value, so dropping the implementation is safe.
  selectSpy.mockReset();
});

describe("initialsOf", () => {
  it("takes the first and last word initials, matching the signed-off cards", () => {
    expect(initialsOf("Rob Heathcote")).toBe("RH");
    expect(initialsOf("Andrew Bobbin")).toBe("AB");
  });
  it("skips the ampersand joiner in partnership names", () => {
    expect(initialsOf("Annabel & Rob Archibald")).toBe("AA");
    expect(initialsOf("Corey & Kylie Geran")).toBe("CG");
  });
  it("is empty for an empty name", () => {
    expect(initialsOf("   ")).toBe("");
  });
});

describe("getMarketingTrainers", () => {
  it("maps a view row to the Trainer shape with a public photo URL and computed initials", async () => {
    orderResult.data = [
      {
        name: "Robert Heathcote",
        display_name: "Rob Heathcote",
        location: "Eagle Farm, QLD",
        bio: "  A real bio from the stable.  ",
        marketing_photo_path: "trainers/2f4f.jpg",
        website_url: "https://heathcoteracing.com.au",
      },
    ];
    const [t] = await getMarketingTrainers();
    expect(t).toEqual({
      name: "Rob Heathcote",
      location: "Eagle Farm, QLD",
      bio: "A real bio from the stable.",
      website: "https://heathcoteracing.com.au",
      photo: `${BASE}/storage/v1/object/public/marketing-photos/trainers/2f4f.jpg`,
      initials: "RH",
    });
  });

  /**
   * The view publishes '' both for a stable with no site and for a value that
   * failed its absolute-http(s) check, so the mapper treats '' as "no link" and
   * the render sites never have to re-validate a scheme.
   */
  it("drops an empty website_url rather than carrying a blank link", async () => {
    orderResult.data = [
      { name: "No Site", display_name: null, location: "Nowhere", bio: null, marketing_photo_path: null, website_url: "" },
    ];
    const [t] = await getMarketingTrainers();
    expect(t.website).toBeUndefined();
  });

  /**
   * `website_url` arrives in its own backend migration. Until that is deployed,
   * PostgREST rejects the whole request for the unknown column — so a single
   * unconditional select would drop EVERY trainer to the static fallback. The
   * fetch retries on the older column set instead.
   */
  it("falls back to the pre-website column set when the view has no website_url yet", async () => {
    let call = 0;
    selectSpy.mockImplementation(() => {
      call += 1;
      if (call === 1) {
        orderResult.data = null;
        orderResult.error = { message: 'column public_trainer.website_url does not exist' };
      } else {
        orderResult.data = [
          { name: "Jack Bruce", display_name: null, location: "Eagle Farm", bio: null, marketing_photo_path: null },
        ];
        orderResult.error = null;
      }
    });

    const rows = await getMarketingTrainers();
    expect(selectSpy).toHaveBeenNthCalledWith(1, "name,display_name,location,bio,marketing_photo_path,website_url");
    expect(selectSpy).toHaveBeenNthCalledWith(2, "name,display_name,location,bio,marketing_photo_path");
    expect(rows.map((r) => r.name)).toEqual(["Jack Bruce"]);
    expect(rows[0].website).toBeUndefined();
  });

  it("never selects or exposes the horses field (Guardrail #2: trainer info only)", async () => {
    orderResult.data = [
      { name: "X", display_name: "Danny Williams", location: "Goulburn", bio: null, marketing_photo_path: "trainers/x.png" },
    ];
    const [t] = await getMarketingTrainers();
    expect(selectSpy).toHaveBeenCalledWith("name,display_name,location,bio,marketing_photo_path,website_url");
    expect(t).not.toHaveProperty("horses");
  });

  it("yields an empty photo (initials fallback) when there is no marketing photo", async () => {
    orderResult.data = [
      { name: "Jack Bruce", display_name: null, location: "Eagle Farm", bio: null, marketing_photo_path: null },
    ];
    const [t] = await getMarketingTrainers();
    expect(t.photo).toBe("");
    expect(t.name).toBe("Jack Bruce");
    expect(t.bio).toBeUndefined();
  });

  it("returns [] on a query error so the caller can fall back to the static list", async () => {
    orderResult.data = null;
    orderResult.error = { message: "boom" };
    expect(await getMarketingTrainers()).toEqual([]);
  });

  it("returns [] when the Supabase env is missing", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    expect(await getMarketingTrainers()).toEqual([]);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("drops rows with no usable name", async () => {
    orderResult.data = [
      { name: "", display_name: null, location: "Nowhere", bio: null, marketing_photo_path: null },
      { name: "Kept", display_name: null, location: "Here", bio: null, marketing_photo_path: null },
    ];
    const rows = await getMarketingTrainers();
    expect(rows.map((r) => r.name)).toEqual(["Kept"]);
  });
});
