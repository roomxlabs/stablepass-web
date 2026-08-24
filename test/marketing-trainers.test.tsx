import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import TrainersStrip from "@/app/(marketing)/sections/trainers-strip";
import {
  RETIRED_PLACEHOLDER_STRINGS,
  TRAINER_FIXTURE,
  TRAINER_SPARSE,
  TRAINER_WITHOUT_PHOTO,
  TRAINER_WITH_PHOTO,
} from "@/test/fixtures/trainers";

/**
 * ENG-730 / W4 — the trainer strip reads LIVE from `public_trainer`.
 *
 * This file is the replacement gate for what the roster's move out of the repo
 * cost the other suites. It is deliberately split into what is still GUARANTEED
 * and what is now ENVIRONMENT-DEPENDENT:
 *
 *   GUARANTEED, asserted here, exactly as hard as before
 *     - the projection string, byte for byte (it is security surface)
 *     - that the only Supabase-touching module marketing can reach is this one
 *     - row -> prop mapping, including every nullable the contract allows
 *     - the public photo URL is built unsigned, from the public bucket
 *     - every failure path degrades to an empty roster, never a throw
 *     - a roster renders one card per row, with the count on the section
 *     - an empty roster renders no section at all
 *
 *   NO LONGER ASSERTED ANYWHERE, on purpose
 *     - WHICH trainers exist, how many there are, and what any of them is
 *       called. That is the database's answer now. The old suites pinned 19
 *       cards and "Andrew Bobbin" first; pinning a fixture to itself would look
 *       like coverage while testing nothing, so those pins moved onto the
 *       fixture-driven rendering assertions below and the e2e specs went
 *       count-agnostic instead.
 */

const REPO = path.resolve(__dirname, "..");
const READ_MODULE = path.join(REPO, "lib", "marketing", "trainers.ts");

/**
 * Strip comments before grepping.
 *
 * These are grep-level guards, and a grep-level guard that reads prose is worse
 * than none: this repo's house style carries long explanatory headers, so the
 * read module's own comment necessarily NAMES the things it must not do — it
 * explains why it never touches `trainer`, and why it lives outside the group
 * that bans `lib/supabase`. Matching those mentions would fail the guard for
 * documenting itself, and the obvious "fix" is to delete the explanation. So the
 * guards inspect CODE only, which is also the only thing that can actually run.
 */
function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// ─────────────────────────────────────────────────────────────────────────────
// The read module. `@supabase/supabase-js` is mocked so nothing here touches a
// database — the LIVE contract is verified separately, against a real PostgREST,
// and quoted in the PR.
// ─────────────────────────────────────────────────────────────────────────────

const selectMock = vi.fn();
const getPublicUrlMock = vi.fn();
const createClientMock = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => createClientMock(...args),
}));

// `unstable_cache` is identity here: this file tests the READ, and the caching
// wrapper is asserted separately below by inspecting how it is constructed.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: unknown) => fn,
}));

function stubClient() {
  return {
    from: (relation: string) => ({
      select: (columns: string) => selectMock(relation, columns),
    }),
    storage: {
      from: (bucket: string) => ({
        getPublicUrl: (objectPath: string) => getPublicUrlMock(bucket, objectPath),
      }),
    },
  };
}

async function loadModule() {
  vi.resetModules();
  return import("@/lib/marketing/trainers");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://stub.supabase.test");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
  createClientMock.mockImplementation(() => stubClient());
  getPublicUrlMock.mockImplementation((bucket: string, objectPath: string) => ({
    data: { publicUrl: `https://stub.supabase.test/storage/v1/object/public/${bucket}/${objectPath}` },
  }));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the public_trainer read — the contract", () => {
  /**
   * The single most valuable assertion in this file.
   *
   * A wrong column list does NOT fail loudly. Measured against a live local
   * PostgREST: naming a column the view does not expose answers
   * `400 {"code":"42703","message":"column public_trainer.photo_url does not
   * exist"}` — and because a failed read degrades to "no strip" by design, that
   * arrives on a healthy site as an EMPTY TRAINER BAND, with nothing in the UI
   * to say why. Widening it the other way is worse: the column list IS the
   * privacy boundary the view is built around.
   */
  it("selects exactly the seven columns the view exposes, in the contract's order", async () => {
    const { PUBLIC_TRAINER_COLUMNS } = await loadModule();
    expect(PUBLIC_TRAINER_COLUMNS).toBe("id,name,display_name,location,bio,marketing_photo_path,horses");
  });

  it("reads the view, never the base table — with EXACTLY one select", async () => {
    const { PUBLIC_TRAINER_VIEW, readPublicTrainers, PUBLIC_TRAINER_COLUMNS } = await loadModule();
    selectMock.mockResolvedValue({ data: [], error: null });

    await readPublicTrainers();

    expect(PUBLIC_TRAINER_VIEW).toBe("public_trainer");
    expect(selectMock).toHaveBeenCalledWith("public_trainer", PUBLIC_TRAINER_COLUMNS);
    // `toHaveBeenCalledWith` passes if ANY call matched, so a second, WIDER
    // select added later — `.from(PUBLIC_TRAINER_VIEW).select("*")` — would sail
    // past both this and the `.from(` guard, which only constrains the relation.
    // Pinning the call COUNT is what actually bounds the projection.
    expect(selectMock, "the read issues more than one select — the projection is no longer bounded").toHaveBeenCalledTimes(1);
  });

  it("builds a BARE anon client — no cookies, no session, no service key", async () => {
    const { readPublicTrainers } = await loadModule();
    selectMock.mockResolvedValue({ data: [], error: null });

    await readPublicTrainers();

    const [url, key, options] = createClientMock.mock.calls[0]!;
    expect(url).toBe("https://stub.supabase.test");
    expect(key).toBe("anon-key");
    expect(options).toMatchObject({
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    // A cookie adapter would bind the visitor's session to an anonymous origin
    // AND opt the caller out of caching. There must not be one.
    expect(JSON.stringify(options ?? {})).not.toMatch(/cookie/i);
  });
});

describe("the public_trainer read — mapping the view's rows", () => {
  const row = {
    id: "abc",
    name: "Legal Name",
    display_name: "Trading Name",
    location: "Ballarat, Victoria",
    bio: "A stable with a long view.",
    marketing_photo_path: "approved/trading-name.jpg",
    horses: "Ardent Lane, Bellhaven",
  };

  it("prefers display_name, and falls back to name when it is null", async () => {
    const { readPublicTrainers } = await loadModule();

    selectMock.mockResolvedValue({ data: [row], error: null });
    expect((await readPublicTrainers())[0]!.name).toBe("Trading Name");

    selectMock.mockResolvedValue({ data: [{ ...row, display_name: null }], error: null });
    expect((await readPublicTrainers())[0]!.name).toBe("Legal Name");

    // Whitespace is not a display name.
    selectMock.mockResolvedValue({ data: [{ ...row, display_name: "   " }], error: null });
    expect((await readPublicTrainers())[0]!.name).toBe("Legal Name");
  });

  it("builds the photo as an UNSIGNED public-bucket URL", async () => {
    const { readPublicTrainers, MARKETING_PHOTO_BUCKET } = await loadModule();
    selectMock.mockResolvedValue({ data: [row], error: null });

    const [trainer] = await readPublicTrainers();

    expect(MARKETING_PHOTO_BUCKET).toBe("marketing-photos");
    expect(getPublicUrlMock).toHaveBeenCalledWith("marketing-photos", "approved/trading-name.jpg");
    expect(trainer!.photo).toBe(
      "https://stub.supabase.test/storage/v1/object/public/marketing-photos/approved/trading-name.jpg",
    );
    // Unsigned: the bucket is public by design, so no token may appear.
    expect(trainer!.photo).not.toMatch(/token|signed/i);
  });

  it("leaves photo null when the admin has not copied one across yet", async () => {
    const { readPublicTrainers } = await loadModule();
    selectMock.mockResolvedValue({ data: [{ ...row, marketing_photo_path: null }], error: null });

    const [trainer] = await readPublicTrainers();

    expect(trainer!.photo).toBeNull();
    expect(getPublicUrlMock).not.toHaveBeenCalled();
  });

  it("tolerates every nullable the contract allows, without inventing copy", async () => {
    const { readPublicTrainers } = await loadModule();
    selectMock.mockResolvedValue({
      data: [{ ...row, display_name: null, location: null, bio: "", horses: "", marketing_photo_path: null }],
      error: null,
    });

    const [trainer] = await readPublicTrainers();

    expect(trainer).toEqual({
      id: "abc",
      name: "Legal Name",
      location: "",
      photo: null,
      initials: "LN",
      bio: "",
      horses: "",
    });
    // The retired placeholders must never come back as a "sensible default".
    for (const retired of RETIRED_PLACEHOLDER_STRINGS) {
      expect(JSON.stringify(trainer)).not.toContain(retired);
    }
  });

  it("derives the initials disc the mockup's way", async () => {
    const { initialsOf } = await loadModule();

    // Read straight off the mockup's own hand-written discs: it is FIRST word +
    // LAST word, i.e. given name + family name — not "the first two words".
    expect(initialsOf("Andrew Bobbin")).toBe("AB");
    expect(initialsOf("Annabel & Rob Archibald")).toBe("AA");
    expect(initialsOf("Corey & Kylie Geran")).toBe("CG");
    expect(initialsOf("Matt Cumani")).toBe("MC");
    // Degenerate shapes must still produce something renderable, never "&".
    expect(initialsOf("Diag")).toBe("D");
    expect(initialsOf("  spaced   out  ")).toBe("SO");
    expect(initialsOf("&")).toBe("");
  });

  it("exposes no field beyond the six the strip renders", async () => {
    const { readPublicTrainers } = await loadModule();
    selectMock.mockResolvedValue({ data: [row], error: null });

    const [trainer] = await readPublicTrainers();

    expect(Object.keys(trainer!).sort()).toEqual(["bio", "horses", "id", "initials", "location", "name", "photo"]);
  });
});

describe("the public_trainer read — every failure degrades to no strip", () => {
  it("returns an empty roster when the view errors, logging only the code", async () => {
    const { readPublicTrainers } = await loadModule();
    selectMock.mockResolvedValue({
      data: null,
      error: { code: "42P01", message: "relation public_trainer does not exist", details: "sensitive" },
    });

    expect(await readPublicTrainers()).toEqual([]);

    const logged = String((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0]);
    expect(logged).toContain("42P01");
    // The message can carry query or connection detail and this runs on the
    // anonymous marketing origin.
    expect(logged).not.toContain("sensitive");
    expect(logged).not.toContain("relation public_trainer does not exist");
  });

  it("still names the failure when the error carries an empty code", async () => {
    // Not hypothetical: pointed at a dead port, supabase-js returns an error
    // whose `code` is an EMPTY STRING. With `??` this logged the prefix and
    // nothing else, which is indistinguishable from not logging at all — the one
    // thing the operator needs when the strip silently vanishes.
    const { readPublicTrainers } = await loadModule();
    selectMock.mockResolvedValue({ data: null, error: { code: "", name: "FetchError", message: "fetch failed" } });

    expect(await readPublicTrainers()).toEqual([]);

    const logged = String((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0]);
    expect(logged).toContain("FetchError");
    expect(logged.replace("[marketing/trainers]", "").trim()).not.toBe("");
    expect(logged).not.toContain("fetch failed");
  });

  it("returns an empty roster when the client throws outright", async () => {
    const { readPublicTrainers } = await loadModule();
    selectMock.mockRejectedValue(new TypeError("fetch failed"));

    await expect(readPublicTrainers()).resolves.toEqual([]);
  });

  it("returns an empty roster when the environment has no Supabase config", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    const { readPublicTrainers } = await loadModule();

    expect(await readPublicTrainers()).toEqual([]);
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("caches the roster for five minutes rather than the route", async () => {
    const { TRAINER_ROSTER_REVALIDATE_SECONDS } = await loadModule();
    expect(TRAINER_ROSTER_REVALIDATE_SECONDS).toBe(300);

    // The page must NOT carry a route-level `revalidate`: ENG-729 made `/`
    // request-varying (it reads searchParams), and route ISR on a request-
    // varying page is a no-op. If someone adds one back, this fails and the
    // comment in page.tsx explains why.
    const page = codeOf(readFileSync(path.join(REPO, "app", "(marketing)", "page.tsx"), "utf8"));
    expect(page).not.toMatch(/export\s+const\s+revalidate/);
    expect(codeOf(readFileSync(READ_MODULE, "utf8"))).toMatch(/unstable_cache\(/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The narrow guard the ticket asks for. `test/marketing-shell.test.tsx` already
// proves the marketing ROUTE GROUP imports no Supabase; this proves the module
// it reaches instead cannot quietly widen.
// ─────────────────────────────────────────────────────────────────────────────

describe("guardrail — marketing's ONLY Supabase surface", () => {
  const marketingLib = path.join(REPO, "lib", "marketing");
  const source = codeOf(readFileSync(READ_MODULE, "utf8"));

  it("is one module, and one module only", () => {
    const files = readdirSync(marketingLib).filter((name) =>
      statSync(path.join(marketingLib, name)).isFile(),
    );
    expect(files).toEqual(["trainers.ts"]);
  });

  /**
   * The relation check runs on the RAW source as well as the stripped one, and
   * that is not belt-and-braces — it closes a hole I put there and then proved.
   *
   * `codeOf()` strips `/* ... *\/` pairs. Open one INSIDE A STRING LITERAL and the
   * stripper runs to the next real comment terminator, taking live code with it:
   *
   *     const decoy = "/*";
   *     await supabase.from("trainer").select("*");
   *     /* an ordinary comment, which closes the fake one *\/
   *
   * strips down to `const decoy = "` — and a `.from("trainer")` that the runtime
   * would happily execute becomes invisible to a guard that only reads the
   * stripped text. Measured, not theorised. ENG-600's nav exemption was
   * defeatable in exactly this shape, so this one gets closed on the way in.
   *
   * Raw is the authority for `.from(`, which no comment in this module contains;
   * stripped stays the authority for the bare word `trainer`, which the module's
   * own header necessarily discusses.
   */
  const rawSource = readFileSync(READ_MODULE, "utf8");

  it("names no relation but the view — never `trainer`, never `trainer_contact`", () => {
    const relationsIn = (text: string) =>
      [...text.matchAll(/\.from\(\s*([A-Za-z_"'`][^)]*)\)/g)].map((m) => m[1]!.trim());

    // Storage buckets go through the same call shape, so allow the one bucket.
    const allowed = new Set(["PUBLIC_TRAINER_VIEW", "MARKETING_PHOTO_BUCKET"]);
    for (const relation of relationsIn(rawSource)) {
      expect(allowed.has(relation), `unexpected .from(${relation})`).toBe(true);
    }

    // Nothing may hide in, or behind, a comment: every `.from(` in the file must
    // survive stripping. If these ever disagree, something is concealed.
    expect(relationsIn(rawSource), "a .from( call is hidden from the stripped guard").toEqual(
      relationsIn(source),
    );

    expect(rawSource).not.toMatch(/\.from\(\s*["'`]trainer["'`]/);
    expect(rawSource).not.toMatch(/trainer_contact\s*\(/);
    expect(source).not.toMatch(/["'`]trainer["'`]/);
    expect(source).not.toMatch(/trainer_contact/);
    expect(source).toMatch(/PUBLIC_TRAINER_VIEW = "public_trainer"/);
  });

  it("cannot be blinded by a block comment opened inside a string", () => {
    // The attack above, run against the real helper, so the guard's own
    // weakness stays covered rather than merely documented.
    const smuggled = ['const decoy = "/*";', 'await supabase.from("trainer").select("*");', "/* closes it */"].join(
      "\n",
    );

    const hiddenFromStripped = !/\.from\(\s*"trainer"\s*\)/.test(codeOf(smuggled));
    const visibleInRaw = /\.from\(\s*"trainer"\s*\)/.test(smuggled);

    expect(hiddenFromStripped, "codeOf no longer hides this — simplify the guard").toBe(true);
    expect(visibleInRaw, "the raw check is what catches it, and it must").toBe(true);
  });

  it("never reaches for a service-role key or a signed URL", () => {
    expect(source).not.toMatch(/SERVICE_ROLE/i);
    expect(source).not.toMatch(/createSignedUrl/);
    expect(source).not.toMatch(/lib\/supabase/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rendering. This is where the old count/name pins went: the roster is the
// test's, the rendering contract is still pinned to the card.
// ─────────────────────────────────────────────────────────────────────────────

describe("the strip renders whatever roster it is given", () => {
  it("renders one card per row and declares the real count", () => {
    const { container } = render(<TrainersStrip trainers={TRAINER_FIXTURE} />);

    expect(container.querySelector("#stable-trainers")).toHaveAttribute("data-trainer-count", "3");
    expect(container.querySelectorAll(".tr-card")).toHaveLength(3);
    expect([...container.querySelectorAll(".tr-card .tr-nm")].map((el) => el.textContent)).toEqual(
      TRAINER_FIXTURE.map((t) => t.name),
    );
  });

  it("renders no section at all for an empty roster", () => {
    const { container } = render(<TrainersStrip trainers={[]} />);

    expect(container.querySelector("#stable-trainers")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("gives a photographed trainer an img, with the location in its alt", () => {
    const { container } = render(<TrainersStrip trainers={[TRAINER_WITH_PHOTO]} />);
    const img = container.querySelector(".tr-card img");

    expect(img).toHaveAttribute("src", TRAINER_WITH_PHOTO.photo!);
    expect(img).toHaveAttribute("alt", `${TRAINER_WITH_PHOTO.name}, ${TRAINER_WITH_PHOTO.location}`);
  });

  /**
   * The state most worth testing: `marketing_photo_path` is null until W8 runs
   * the copy, so at launch this is what MOST cards look like.
   */
  it("renders the initials disc and NO img when there is no photo", () => {
    const { container } = render(<TrainersStrip trainers={[TRAINER_WITHOUT_PHOTO]} />);
    const card = container.querySelector(".tr-card")!;

    expect(card.querySelector("img")).toBeNull();
    expect(card.querySelector(".tr-init")).toHaveTextContent(TRAINER_WITHOUT_PHOTO.initials);
  });

  it("keeps the initials disc behind every card, photographed or not", () => {
    const { container } = render(<TrainersStrip trainers={TRAINER_FIXTURE} />);

    expect([...container.querySelectorAll(".tr-card .tr-init")].map((el) => el.textContent)).toEqual(
      TRAINER_FIXTURE.map((t) => t.initials),
    );
  });

  it("omits the optional lines rather than rendering them empty", () => {
    const { container } = render(<TrainersStrip trainers={[TRAINER_SPARSE]} />);
    const card = container.querySelector(".tr-card")!;

    expect(card.querySelector(".tr-over .loc")).toBeNull();
    expect(card.querySelector(".tr-over .hz")).toBeNull();
    expect(card.querySelector(".tr-over .bio")).toBeNull();
    // The name and the affordance always render.
    expect(card.querySelector(".tr-nm")).toHaveTextContent(TRAINER_SPARSE.name);
    expect(card.querySelector(".tr-over .more")).toHaveTextContent("Read more");
    // A sparse card falls back to the bare name for its alt, not "Name, ".
    expect(card.querySelector("img")).toBeNull();
  });

  it("renders the live bio and horse names, and none of the retired placeholders", () => {
    const { container } = render(<TrainersStrip trainers={TRAINER_FIXTURE} />);

    expect(container.querySelector(".tr-card .tr-over .hz")).toHaveTextContent(TRAINER_WITH_PHOTO.horses);
    expect(container.querySelector(".tr-card .tr-over .bio")).toHaveTextContent(TRAINER_WITH_PHOTO.bio);

    for (const retired of RETIRED_PLACEHOLDER_STRINGS) {
      expect(container.textContent).not.toContain(retired);
      expect(container.innerHTML).not.toContain(retired);
    }
  });

  it("carries the live values on the card's data-* attributes too", () => {
    const { container } = render(<TrainersStrip trainers={[TRAINER_WITH_PHOTO]} />);
    const card = container.querySelector(".tr-card")!;

    expect(card).toHaveAttribute("data-loc", TRAINER_WITH_PHOTO.location);
    expect(card).toHaveAttribute("data-horses", TRAINER_WITH_PHOTO.horses);
    expect(card).toHaveAttribute("data-bio", TRAINER_WITH_PHOTO.bio);
  });
});

describe("the retired placeholder roster is gone from the repo", () => {
  it("exports no data from the type home any more", async () => {
    const dataModule = await import("@/app/(marketing)/sections/trainers.data");
    expect(Object.keys(dataModule)).toEqual([]);
  });

  it("leaves no placeholder copy anywhere under the marketing route group", () => {
    const routeGroup = path.join(REPO, "app", "(marketing)");
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = path.join(dir, name);
        return statSync(full).isDirectory() ? walk(full) : [full];
      });

    const offenders = walk(routeGroup)
      .filter((file) => /\.(ts|tsx|css)$/.test(file))
      .filter((file) => {
        const body = readFileSync(file, "utf8");
        return RETIRED_PLACEHOLDER_STRINGS.some((retired) => body.includes(retired));
      });

    expect(offenders).toEqual([]);
  });
});
