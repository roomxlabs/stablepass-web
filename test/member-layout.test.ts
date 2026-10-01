import { describe, it, expect, vi } from "vitest";

const redirectMock = vi.hoisted(() =>
  vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
);

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: null } })) },
  })),
}));

// ENG-1593 — the layout calls react-dom's `preconnect()` for the Supabase
// origin. It is a real export of the installed react-dom and is documented as
// safe to call outside an actual request (a no-op hint), but this suite stubs
// it anyway: it is otherwise the one call in this file that reaches outside
// the mocked surface, and nothing here is testing that it fires.
vi.mock("react-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom")>();
  return { ...actual, preconnect: vi.fn() };
});

import MemberLayout from "@/app/(member)/layout";

describe("MemberLayout", () => {
  it("redirects unauthenticated visitors to /signin", async () => {
    await expect(MemberLayout({ children: null })).rejects.toThrow("REDIRECT:/signin");
    expect(redirectMock).toHaveBeenCalledWith("/signin");
  });
});

/**
 * Finds the first element of the given `type` in a returned React element
 * tree, walking `props.children` (arrays included) at every level. Used below
 * to reach the `ExpiryBanner` element without hardcoding the shell's exact
 * nesting (`div.app-shell > main > ExpiryBanner`), which is incidental to what
 * this test actually pins.
 */
function findByType(
  node: unknown,
  type: unknown,
): { props: Record<string, unknown> } | null {
  if (node == null) return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByType(child, type);
      if (found) return found;
    }
    return null;
  }
  if (typeof node !== "object" || !("type" in (node as Record<string, unknown>))) return null;
  const el = node as { type: unknown; props?: { children?: unknown } };
  if (el.type === type) return el as { props: Record<string, unknown> };
  return findByType(el.props?.children, type);
}

// A separate describe block with its own signed-in-user mocks — a chainable
// from() stub (mirrors the me-route.test.ts makeChain convention) so the
// subscription `.select()` spy can be asserted on directly.
describe("MemberLayout — subscription select", () => {
  // ENG-1593 — the layout now reads through `readSubscriptionState`, which
  // selects the WIDER `SUBSCRIPTION_COLUMNS` (a superset of the old
  // `ACCESS_COLUMNS`, carrying `stripe_customer_id` too) so the page under this
  // layout can share the same `cache()`d read. `hasAccess()` and the sidebar
  // chip still only ever see the ACCESS_COLUMNS subset of that row.
  it("selects the SHARED SUBSCRIPTION_COLUMNS on `subscription`, exactly once, and never hands stripe_customer_id to ExpiryBanner", async () => {
    vi.resetModules();

    const { SUBSCRIPTION_COLUMNS } = await import("@/lib/api/access");
    const { ExpiryBanner } = await import("@/app/(member)/expiry-banner");

    const selectMock = vi.fn();
    const eqMock = vi.fn();
    const maybeSingleMock = vi.fn(async () => ({
      data: {
        status: "trial",
        trial_ends_at: null,
        current_period_end: null,
        // The one column ONLY this select is allowed to widen for — and the
        // one value that must never reach the client island below.
        stripe_customer_id: "cus_123",
      },
    }));
    const chain = { select: selectMock, eq: eqMock, maybeSingle: maybeSingleMock };
    selectMock.mockImplementation(() => chain);
    eqMock.mockImplementation(() => chain);

    const fromMock = vi.fn((table: string) => {
      if (table === "subscription") return chain;
      // app_user (profile) lookup — same chain shape, distinct fixture.
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(async () => ({ data: { name: "Justin Alpar", email: "you@stablepass.co" } })),
          })),
        })),
      };
    });

    vi.doMock("next/navigation", () => ({
      redirect: redirectMock,
      usePathname: () => "/",
      useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
    }));
    vi.doMock("@/lib/supabase/server", () => ({
      supabaseServer: vi.fn(async () => ({
        auth: { getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } } })) },
        from: fromMock,
      })),
    }));

    const { default: SignedInMemberLayout } = await import("@/app/(member)/layout");

    const element = await SignedInMemberLayout({ children: null });

    expect(selectMock).toHaveBeenCalledWith(expect.stringContaining("status"));
    expect(selectMock).toHaveBeenCalledWith(expect.stringContaining("trial_ends_at"));
    expect(selectMock).toHaveBeenCalledWith(expect.stringContaining("current_period_end"));
    expect(selectMock).toHaveBeenCalledWith(SUBSCRIPTION_COLUMNS);

    // Exactly ONE read of `subscription` for the whole render — the profile
    // and subscription reads run together (Promise.all), and the page under
    // this layout reuses this same `cache()`d answer rather than re-querying.
    const subscriptionCalls = fromMock.mock.calls.filter((c) => c[0] === "subscription");
    expect(subscriptionCalls).toHaveLength(1);

    // The narrowed row, not the raw one: `stripe_customer_id` must never reach
    // this client island (.rx/guardrails.md #1) even though the SELECT above
    // fetched it.
    const banner = findByType(element, ExpiryBanner);
    expect(banner).not.toBeNull();
    expect(banner!.props.subscription).toEqual({
      status: "trial",
      trial_ends_at: null,
      current_period_end: null,
    });
    expect(Object.keys(banner!.props.subscription as object)).not.toContain("stripe_customer_id");

    vi.doUnmock("next/navigation");
    vi.doUnmock("@/lib/supabase/server");
  });
});
