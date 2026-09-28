import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { getViewerMock, readSubscriptionStateMock, loadExploreFirstPageMock } = vi.hoisted(() => ({
  getViewerMock: vi.fn(async () => ({ id: "u1" })),
  readSubscriptionStateMock: vi.fn(),
  loadExploreFirstPageMock: vi.fn(),
}));

vi.mock("@/lib/auth/viewer", () => ({ getViewer: getViewerMock }));
vi.mock("@/lib/api/subscription-state", () => ({ readSubscriptionState: readSubscriptionStateMock }));
vi.mock("@/lib/feed/explore-first-page", () => ({ loadExploreFirstPage: loadExploreFirstPageMock }));

import ExplorePage from "@/app/(member)/explore/page";
import { ExploreFeed } from "@/app/(member)/explore/explore-feed";

type AnyElement = { type: unknown; props: Record<string, unknown> };

/**
 * Pulls the inner async `ExploreFirstPage` element out of the tree
 * `ExplorePage()` returns — a fragment of two Suspense boundaries, the SECOND
 * of which wraps it — calls it (it's an async function component, so calling
 * its `.type` directly is how you run it without a renderer), and returns the
 * `<ExploreFeed .../>` element it resolves to.
 */
async function resolveExploreFeedElement(): Promise<AnyElement> {
  const element = (await (ExplorePage as unknown as () => Promise<AnyElement>)()) as unknown as {
    props: { children: AnyElement[] };
  };
  const children = element.props.children;
  const exploreSuspense = children[1] as AnyElement;
  const innerElement = exploreSuspense.props.children as AnyElement & {
    type: (props: Record<string, unknown>) => Promise<AnyElement>;
  };
  return innerElement.type(innerElement.props);
}

describe("ExplorePage — server render (ENG-1593)", () => {
  beforeEach(() => {
    getViewerMock.mockReset();
    getViewerMock.mockResolvedValue({ id: "u1" });
    readSubscriptionStateMock.mockReset();
    loadExploreFirstPageMock.mockReset();
  });

  it("not entitled: initialPage is { kind: 'gated' } and loadExploreFirstPage is never called", async () => {
    readSubscriptionStateMock.mockResolvedValue({ sub: null, entitled: false, everSubscribed: true });

    const feedElement = await resolveExploreFeedElement();

    expect(feedElement.type).toBe(ExploreFeed);
    expect(feedElement.props.initialPage).toEqual({ kind: "gated" });
    expect(loadExploreFirstPageMock).not.toHaveBeenCalled();
  });

  it("entitled: loadExploreFirstPage is called once and its result is passed straight through as initialPage", async () => {
    readSubscriptionStateMock.mockResolvedValue({ sub: null, entitled: true, everSubscribed: false });
    const page = { kind: "ok" as const, posts: [], nextCursor: "c1", hasMore: true };
    loadExploreFirstPageMock.mockResolvedValue(page);

    const feedElement = await resolveExploreFeedElement();

    expect(loadExploreFirstPageMock).toHaveBeenCalledTimes(1);
    expect(feedElement.props.initialPage).toBe(page);
  });

  it("entitled but the server render failed (null): null is passed straight through, not coerced to gated", async () => {
    readSubscriptionStateMock.mockResolvedValue({ sub: null, entitled: true, everSubscribed: false });
    loadExploreFirstPageMock.mockResolvedValue(null);

    const feedElement = await resolveExploreFeedElement();

    expect(loadExploreFirstPageMock).toHaveBeenCalledTimes(1);
    expect(feedElement.props.initialPage).toBeNull();
  });
});

describe("ENG-1593 GUARDRAIL — the content gate moved to the edge fn, not duplicated in the BFF", () => {
  // Same strip-comment convention as test/feed-hls-video.test.tsx: a real
  // comment that NAMES the forbidden call (documenting why it's gone) must not
  // trip this guard on itself. Requiring the `//` not be preceded by `:` also
  // keeps a `https://` URL whole.
  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
  }
  function sourceOf(relPath: string): string {
    return stripComments(readFileSync(join(process.cwd(), relPath), "utf8"));
  }

  it("app/(member)/explore/page.tsx reads no subscription table directly, and imports readSubscriptionState", () => {
    const src = sourceOf("app/(member)/explore/page.tsx");
    expect(src).not.toMatch(/from\(\s*["']subscription["']\s*\)/);
    expect(src).toContain("readSubscriptionState");
  });

  it("app/(member)/layout.tsx reads no subscription table directly, and imports readSubscriptionState", () => {
    const src = sourceOf("app/(member)/layout.tsx");
    expect(src).not.toMatch(/from\(\s*["']subscription["']\s*\)/);
    expect(src).toContain("readSubscriptionState");
  });

  it("GET /api/feed reads no subscription table directly but still verifies the session with auth.getUser()", () => {
    const src = sourceOf("app/api/feed/route.ts");
    expect(src).not.toMatch(/from\(\s*["']subscription["']\s*\)/);
    expect(src).toContain("auth.getUser()");
  });
});
