import { describe, it, expect, vi } from "vitest";

// Why this file exists (a deliberate, documented widening of ENG-570's declared
// surface): `app/(member)/account/page.tsx` reads `first_name`/`last_name` off
// its own `.select()`, and `sb` is untyped — so narrowing that select back to
// the old `name,email,phone` would compile clean, type-check clean, and only
// fail at RUNTIME by serving `undefined` into empty form inputs. Until now the
// only guard on it was the Playwright spec, which `test.skip()`s itself
// silently wherever local Supabase is unreachable (i.e. CI). This pins the
// column list at unit level, with no Supabase required.
//
// It follows the persistent-chain convention from .rx/gotchas.md: the app_user
// chain is created ONCE so its `select` spy survives the call and
// `toHaveBeenCalledWith` can actually see it.

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  usePathname: () => "/account",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const { fromMock, appUserSelect } = vi.hoisted(() => {
  const appUserSelect = vi.fn();

  const appUserChain = {
    select: appUserSelect,
    eq: vi.fn(),
    maybeSingle: vi.fn(async () => ({
      data: {
        first_name: "Justin",
        last_name: "Alpar",
        email: "you@stablepass.co",
        phone: "+61 431 581 526",
        pref_new_post: true,
        pref_race_day: true,
        pref_race_result: false,
        pref_milestone: false,
      },
    })),
  };
  appUserSelect.mockImplementation(() => appUserChain);
  appUserChain.eq.mockImplementation(() => appUserChain);

  const subscriptionChain = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn(async () => ({
      data: { status: "trial", trial_ends_at: "2026-09-14T00:00:00.000Z", current_period_end: null },
    })),
  };
  subscriptionChain.select.mockImplementation(() => subscriptionChain);
  subscriptionChain.eq.mockImplementation(() => subscriptionChain);

  const fromMock = vi.fn((table: string) =>
    table === "app_user" ? appUserChain : subscriptionChain,
  );

  return { fromMock, appUserSelect };
});

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } } })) },
    from: fromMock,
  })),
}));

import AccountPage from "@/app/(member)/account/page";

describe("AccountPage — app_user select", () => {
  it("selects first_name and last_name (the columns the Profile form renders)", async () => {
    await AccountPage();

    const call = appUserSelect.mock.calls[0];
    expect(call).toBeTruthy();
    const columns = call![0] as string;
    // The structured identity pair — the whole point of the ENG-566 split.
    expect(columns).toContain("first_name");
    expect(columns).toContain("last_name");
    // Still needed by the rest of the screen.
    expect(columns).toContain("email");
    expect(columns).toContain("phone");
    for (const pref of ["pref_new_post", "pref_race_day", "pref_race_result", "pref_milestone"]) {
      expect(columns).toContain(pref);
    }
  });

  it("selects the subscription columns the copy + status pill read", async () => {
    await AccountPage();

    const subCall = fromMock.mock.results
      .map((r, i) => ({ table: fromMock.mock.calls[i]?.[0], chain: r.value as { select: ReturnType<typeof vi.fn> } }))
      .find((c) => c.table === "subscription");
    expect(subCall).toBeTruthy();
    const columns = subCall!.chain.select.mock.calls[0]![0] as string;
    expect(columns).toContain("status");
    expect(columns).toContain("trial_ends_at");
    // `current_period_end` drives the "Access to {date}" copy for an active
    // member — dropping it would silently render "Your access is active."
    // forever instead of the real end date.
    expect(columns).toContain("current_period_end");
  });
});
