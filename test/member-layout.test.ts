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

import MemberLayout from "@/app/(member)/layout";

describe("MemberLayout", () => {
  it("redirects unauthenticated visitors to /signin", async () => {
    await expect(MemberLayout({ children: null })).rejects.toThrow("REDIRECT:/signin");
    expect(redirectMock).toHaveBeenCalledWith("/signin");
  });
});

// A separate describe block with its own signed-in-user mocks — a chainable
// from() stub (mirrors the me-route.test.ts makeChain convention) so the
// subscription `.select()` spy can be asserted on directly.
describe("MemberLayout — subscription select", () => {
  it("selects the SHARED ACCESS_COLUMNS on the subscription table", async () => {
    vi.resetModules();

    const { ACCESS_COLUMNS } = await import("@/lib/api/access");

    const selectMock = vi.fn();
    const eqMock = vi.fn();
    const maybeSingleMock = vi.fn(async () => ({
      data: { status: "trial", trial_ends_at: null, current_period_end: null },
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

    await SignedInMemberLayout({ children: null });

    expect(selectMock).toHaveBeenCalledWith(expect.stringContaining("status"));
    expect(selectMock).toHaveBeenCalledWith(expect.stringContaining("trial_ends_at"));
    expect(selectMock).toHaveBeenCalledWith(expect.stringContaining("current_period_end"));
    expect(selectMock).toHaveBeenCalledWith(ACCESS_COLUMNS);

    vi.doUnmock("next/navigation");
    vi.doUnmock("@/lib/supabase/server");
  });
});
