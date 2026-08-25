// ENG-815 — carousel slides through the mint helper.
//
// These are the three properties the merge of `main` into `feature/round6-v1`
// had to preserve AT ONCE, and the reason a resolution that satisfies only two
// of them reads fine:
//
//   1. slides are addressed by `{ postId, slideIndex }`, never by a storage path
//   2. the dots are drawn from the batch's `slideCount`, before any slide 1+ exists
//   3. a slide's <img> still re-mints once on error (ENG-813) — by ITS OWN index
//
// The draft case is what actually catches a wrong resolution: a carousel that
// quietly falls back to `post_media` / a constructed path renders slides here,
// and both the behavioural guard and the static one below go red. That fallback
// is exactly what ENG-762 did and what ENG-800 revoked.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PhotoCarousel } from "@/components/photo-carousel";

const EXPIRES = "2026-08-01T00:00:00.000Z";

type Body = Record<string, unknown>;

/** Every body this test's client sent to the mint route, parsed. */
function sentBodies(fetchMock: ReturnType<typeof vi.fn>): Body[] {
  return fetchMock.mock.calls
    .filter((c) => String(c[0]) === "/api/posts/media")
    .map((c) => JSON.parse(String((c[1] as RequestInit | undefined)?.body ?? "{}")) as Body);
}

/**
 * THE ADDRESSING GUARD, asserted on every request the component actually made.
 *
 * Textual "does the source mention a path" checks are the vacuous kind (see
 * ENG-811); this one reads the wire. A body may carry ONLY `{ postIds }` or
 * `{ postId, slideIndex }`. Any extra key fails, which is what a re-introduced
 * path fallback would produce, and `postId` must not itself look like a storage
 * key — a path smuggled into the id field addresses an object just as well.
 */
function expectPostIdAddressingOnly(fetchMock: ReturnType<typeof vi.fn>) {
  const bodies = sentBodies(fetchMock);
  expect(bodies.length).toBeGreaterThan(0);
  for (const body of bodies) {
    const keys = Object.keys(body).sort().join(",");
    expect(["postIds", "postId,slideIndex"]).toContain(keys);
    if (typeof body.postId === "string") {
      expect(body.postId).not.toMatch(/[/\\]/);
    }
  }
}

/**
 * A stub of the be's single-slide mode. `mediaUrl: null` is the DRAFT answer —
 * and the out-of-range answer, and the gap answer — all deliberately the same
 * 200, so no status code can confirm that a post exists.
 */
function mintFetch(slideUrl: (index: number) => string | null) {
  return vi.fn((input: string | URL, init?: RequestInit) => {
    if (String(input) !== "/api/posts/media") {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: {} }) });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as Body;
    const slideIndex = Number(body.slideIndex);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({
        data: { postId: body.postId, slideIndex, mediaUrl: slideUrl(slideIndex), expiresAt: EXPIRES },
      }),
    });
  });
}

const realFetch = global.fetch;

afterEach(() => {
  cleanup();
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("ENG-815 — a slide is minted by index, never by path", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = mintFetch((i) => `https://sb.local/p1-${i}.jpg?token=t`);
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it("prefetches ONE ahead on mount: slide 1, and never slide 0", async () => {
    render(<PhotoCarousel postId="p1" slideCount={3} firstUrl="https://sb.local/p1-0.jpg" />);

    await waitFor(() => expect(sentBodies(fetchMock).length).toBeGreaterThan(0));

    // Slide 0 came in on the page's batch, so asking for it again would double
    // every feed page's mint traffic for no new pixel.
    expect(sentBodies(fetchMock)).toEqual([{ postId: "p1", slideIndex: 1 }]);
    expectPostIdAddressingOnly(fetchMock);
  });

  it("swiping to slide 2 finds slide 1 already there and mints slide 2", async () => {
    const user = userEvent.setup();
    render(<PhotoCarousel postId="p1" slideCount={3} firstUrl="https://sb.local/p1-0.jpg" />);

    await waitFor(() =>
      expect(sentBodies(fetchMock)).toEqual([{ postId: "p1", slideIndex: 1 }]),
    );
    // Slide 1 is painted BEFORE the user arrives on it — that is what "prefetch
    // one ahead" buys, and it is the acceptance criterion in the ticket.
    const slides = await screen.findAllByTestId("photo-slide");
    await waitFor(() =>
      expect(slides[1].querySelector("img")?.getAttribute("src")).toBe(
        "https://sb.local/p1-1.jpg?token=t",
      ),
    );

    await user.click(screen.getByLabelText("Go to photo 2 of 3"));

    await waitFor(() =>
      expect(sentBodies(fetchMock)).toEqual([
        { postId: "p1", slideIndex: 1 },
        { postId: "p1", slideIndex: 2 },
      ]),
    );
    expect(screen.getByTestId("media-photo-count")).toHaveTextContent("2/3");
    expectPostIdAddressingOnly(fetchMock);
  });

  it("never asks for the same index twice, however much the viewer scrubs", async () => {
    const user = userEvent.setup();
    render(<PhotoCarousel postId="p1" slideCount={3} firstUrl="https://sb.local/p1-0.jpg" />);
    await waitFor(() => expect(sentBodies(fetchMock).length).toBe(1));

    await user.click(screen.getByLabelText("Go to photo 2 of 3"));
    await user.click(screen.getByLabelText("Go to photo 1 of 3"));
    await user.click(screen.getByLabelText("Go to photo 3 of 3"));
    await user.click(screen.getByLabelText("Go to photo 2 of 3"));

    await waitFor(() => expect(sentBodies(fetchMock).length).toBe(2));
    const indexes = sentBodies(fetchMock).map((b) => b.slideIndex);
    expect([...new Set(indexes)]).toHaveLength(indexes.length);
  });

  it("jumping to the last slide mints THAT one, not the nine in between", async () => {
    const user = userEvent.setup();
    // A count of 10 is the schema's ceiling. Pressing the last dot must mint
    // index 9 and stop: "one ahead" is one ahead of WHERE YOU ARE, not a
    // backfill of everything skipped. It must also not ask for index 10, which
    // does not exist and which the be answers with a 400.
    render(<PhotoCarousel postId="p1" slideCount={10} firstUrl="https://sb.local/p1-0.jpg" />);
    await waitFor(() => expect(sentBodies(fetchMock)).toEqual([{ postId: "p1", slideIndex: 1 }]));

    await user.click(screen.getByLabelText("Go to photo 10 of 10"));

    await waitFor(() =>
      expect(sentBodies(fetchMock)).toEqual([
        { postId: "p1", slideIndex: 1 },
        { postId: "p1", slideIndex: 9 },
      ]),
    );
    for (const body of sentBodies(fetchMock)) {
      expect(body.slideIndex).toBeGreaterThanOrEqual(1);
      expect(body.slideIndex).toBeLessThanOrEqual(9);
    }
  });
});

describe("ENG-815 — the dots come from slideCount, before any slide is minted", () => {
  it("draws the true count on first paint while every mint is still in flight", () => {
    // Nothing ever resolves, so NOTHING beyond slide 0 exists yet. The dots and
    // the n/m chip must already be right: that is the entire reason `slideCount`
    // rides in on the batch response instead of being counted client-side.
    const fetchMock = vi.fn(() => new Promise(() => {}));
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<PhotoCarousel postId="p1" slideCount={4} firstUrl="https://sb.local/p1-0.jpg" />);

    expect(screen.getByTestId("photo-dots").querySelectorAll("button")).toHaveLength(4);
    expect(screen.getByTestId("media-photo-count")).toHaveTextContent("1/4");
    expect(screen.getAllByTestId("photo-slide")).toHaveLength(4);
    // Slide 0 is painted from the batch; slides 1..3 are still blank ground.
    expect(document.querySelectorAll(".photo-track img")).toHaveLength(1);
  });

  it("an over-cap count clamps to the schema's ten, not whatever the wire said", () => {
    // `readSlideCount` in the api client floors the value but does not cap it,
    // so the ceiling is enforced HERE, on the way to the dots. The DB's
    // `sort_order between 0 and 9` makes 11+ impossible today; this is the
    // defence-in-depth, and an untested defence is not one.
    global.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;
    render(<PhotoCarousel postId="p1" slideCount={99} firstUrl="https://sb.local/p1-0.jpg" />);
    expect(screen.getAllByTestId("photo-slide")).toHaveLength(10);
    expect(screen.getByTestId("photo-dots").querySelectorAll("button")).toHaveLength(10);
    expect(screen.getByTestId("media-photo-count")).toHaveTextContent("1/10");
  });

  it("a nonsense count degrades to one slide rather than an empty track", () => {
    global.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;
    render(
      <PhotoCarousel
        postId="p1"
        slideCount={0 as number}
        firstUrl="https://sb.local/p1-0.jpg"
      />,
    );
    expect(screen.getAllByTestId("photo-slide")).toHaveLength(1);
    expect(screen.queryByTestId("media-photo-count")).toBeNull();
  });
});

describe("ENG-815 — a gap in sort_order degrades to a blank slide, never a lost photo", () => {
  it("index 1 of a non-contiguous {0, 2} draws blank and slide 2 still renders", async () => {
    // `slideCount` is HIGHEST ORDINAL + 1, not a row count, so `{0, 2}` reports
    // 3. Counting rows would report 2, the client would draw two dots, ask for
    // index 1, and NEVER ask for index 2 — a photo lost in silence. Reporting 3
    // costs a blank slide instead, and this is the test that pins the difference.
    //
    // It also replaces ENG-762's "non-contiguous sort values" case, which could
    // not survive the merge: the carousel no longer sees `sort_order` at all,
    // because the server resolves ordinals now.
    const user = userEvent.setup();
    const fetchMock = mintFetch((i) => (i === 1 ? null : `https://sb.local/p1-${i}.jpg?token=t`));
    global.fetch = fetchMock as unknown as typeof fetch;

    const { container } = render(
      <PhotoCarousel postId="p1" slideCount={3} firstUrl="https://sb.local/p1-0.jpg" />,
    );

    // Three dots, from the count — the gap does not shrink the indicator.
    expect(screen.getByTestId("photo-dots").querySelectorAll("button")).toHaveLength(3);
    await waitFor(() => expect(screen.getAllByTestId("photo-slide-empty").length).toBe(2));

    await user.click(screen.getByLabelText("Go to photo 3 of 3"));

    // The photo BEYOND the gap is reachable. That is the whole point.
    await waitFor(() =>
      expect(
        container.querySelectorAll<HTMLImageElement>(".photo-track img")[1]?.getAttribute("src"),
      ).toBe("https://sb.local/p1-2.jpg?token=t"),
    );
    expect(container.querySelectorAll(".photo-track img")).toHaveLength(2);
    // The gap itself stays blank rather than sliding a neighbour into its place.
    expect(screen.getAllByTestId("photo-slide-empty")).toHaveLength(1);
    expect(screen.getByTestId("media-photo-count")).toHaveTextContent("3/3");
  });
});

describe("ENG-815 guardrail — a draft's slides are unreachable at EVERY index", () => {
  it("renders no photo at any index, leaks no error, and sends no path", async () => {
    const user = userEvent.setup();
    // The be's answer for a draft: a clean 200 with `mediaUrl: null`, identical
    // at every index and identical to "no such slide". A carousel is only ever
    // drawn here because the count was forced; on a real feed a draft is absent
    // from `items` entirely and gets no carousel at all.
    const fetchMock = mintFetch(() => null);
    global.fetch = fetchMock as unknown as typeof fetch;

    const { container } = render(
      <PhotoCarousel postId="draft-1" slideCount={3} firstUrl={null} />,
    );

    // Walk every index the carousel can address.
    await waitFor(() => expect(sentBodies(fetchMock).length).toBeGreaterThan(0));
    await user.click(screen.getByLabelText("Go to photo 2 of 3"));
    await user.click(screen.getByLabelText("Go to photo 3 of 3"));
    await waitFor(() => expect(sentBodies(fetchMock).length).toBe(2));

    // NOT ONE PIXEL of the draft, at any index, and no fallback src of any kind.
    expect(container.querySelectorAll(".photo-track img")).toHaveLength(0);
    expect(screen.getAllByTestId("photo-slide-empty")).toHaveLength(3);
    // No error copy either: an error would itself confirm the post exists.
    expect(screen.queryByRole("alert")).toBeNull();
    // And every request named a post and an ordinal, nothing else.
    expectPostIdAddressingOnly(fetchMock);
    expect(sentBodies(fetchMock)).toEqual([
      { postId: "draft-1", slideIndex: 1 },
      { postId: "draft-1", slideIndex: 2 },
    ]);
  });

  it("a refused slide is asked for ONCE, not on every scroll", async () => {
    const user = userEvent.setup();
    const fetchMock = mintFetch(() => null);
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<PhotoCarousel postId="draft-1" slideCount={2} firstUrl={null} />);
    await waitFor(() => expect(sentBodies(fetchMock).length).toBe(1));

    await user.click(screen.getByLabelText("Go to photo 2 of 2"));
    await user.click(screen.getByLabelText("Go to photo 1 of 2"));
    await user.click(screen.getByLabelText("Go to photo 2 of 2"));

    // A draft costs one refusal per index, not one per gesture.
    await waitFor(() => expect(sentBodies(fetchMock).length).toBe(1));
  });
});

// ===========================================================================
// The static half of the same guarantee.
//
// Written to be NON-VACUOUS on purpose (contrast ENG-811's three guards, which
// pass because they scan the wrong roots or match a pattern the removed code
// never had): this scans `lib/` — where the deleted client-side reader actually
// lived — and matches the shape a re-introduced fallback takes, namely BUILDING
// an object path out of a post id. Reinstating that fallback trips this AND the
// draft test above.
// ===========================================================================
const ROOTS = ["lib", "components", join("app", "(member)")];
const SKIP = new Set(["node_modules", "test", "__tests__"]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe("ENG-815 guardrail — no client module builds a post-media object path", () => {
  const files = ROOTS.flatMap((r) => sourceFiles(join(process.cwd(), r)));

  it("scans lib/ too — the root the ENG-799 guard misses (ENG-811)", () => {
    expect(files.some((f) => f.includes(`${join("lib", "post-media")}.ts`))).toBe(true);
    expect(files.length).toBeGreaterThan(20);
  });

  it("never interpolates a post id into a storage key", () => {
    // `<postId>/original` and `<postId>/photo-<n>` are the two layouts ENG-740
    // uses in the private bucket. Constructing either client-side is the exact
    // regression this ticket exists to prevent.
    const pathish = /`\$\{[A-Za-z0-9_.]*[Pp]ost[A-Za-z0-9_.]*\}\/|["'`]\/?original["'`]|photo-\$\{/;
    const offenders = files.filter((f) => pathish.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("no client island imports the deleted post_media reader", () => {
    // `readPostPhotos` read `post_media` directly under RLS and signed each
    // slide. ENG-800 revoked that bucket, so a resurrected import compiles,
    // type-checks and renders a carousel of nulls.
    const offenders = files.filter((f) => /readPostPhotos|POST_MEDIA_COLUMNS/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
