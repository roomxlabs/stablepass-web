import { describe, it, expect, vi, beforeEach } from "vitest";

// A chainable Supabase query-builder stub: select/update/eq return itself;
// single() resolves a per-table fixture. `updateMock` separately records the
// exact patch object passed to `.update(...)` so PATCH tests can assert on it
// (mirrors the horses-route.test.ts makeChain convention, plus `.update`).
//
// `app_user` gets a PERSISTENT chain (built once, not per from() call) so its
// `select` spy survives across the route's two `.select()` calls (the GET
// select and the PATCH returning-select) and can be asserted on — see
// .rx/gotchas.md "Asserting .select() args needs a PERSISTENT chain for that
// table". Every other table keeps the original per-call `makeChain` behaviour.
const { getUserMock, fromMock, updateMock, tableData, appUserChain } = vi.hoisted(() => {
  const getUserMock = vi.fn();
  const updateMock = vi.fn();
  const tableData: Record<string, { data: unknown; error?: unknown }> = {};

  function makeChain(table: string) {
    const result = () => tableData[table] ?? { data: null, error: null };
    const chain: {
      select: ReturnType<typeof vi.fn>;
      eq: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      single: ReturnType<typeof vi.fn>;
    } = {
      select: vi.fn(),
      eq: vi.fn(),
      update: vi.fn(),
      single: vi.fn(async () => result()),
    };
    chain.select.mockImplementation(() => chain);
    chain.eq.mockImplementation(() => chain);
    chain.update.mockImplementation((patch: unknown) => {
      updateMock(table, patch);
      return chain;
    });
    return chain;
  }

  const appUserChain = makeChain("app_user");

  const fromMock = vi.fn((table: string) => (table === "app_user" ? appUserChain : makeChain(table)));

  return { getUserMock, fromMock, updateMock, tableData, appUserChain };
});

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: vi.fn(async () => ({
    auth: { getUser: getUserMock },
    from: fromMock,
  })),
}));

import { GET, PATCH } from "@/app/api/me/route";

function patchReq(body: unknown) {
  return new Request("http://localhost/api/me", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/me", () => {
  beforeEach(() => {
    getUserMock.mockReset();
    fromMock.mockClear();
    updateMock.mockClear();
    appUserChain.select.mockClear();
    for (const key of Object.keys(tableData)) delete tableData[key];
  });

  it("returns 401 with the error envelope when there is no session", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error.code).toBe("unauthorized");
  });

  it("returns the {subscriber,subscription,prefs} envelope for the signed-in user", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    tableData.app_user = {
      data: {
        name: "Justin Alpar",
        email: "you@stablepass.co",
        phone: "+61 431 581 526",
        pref_new_post: true,
        pref_race_day: true,
        pref_race_result: false,
        pref_milestone: false,
      },
    };
    tableData.subscription = {
      data: { status: "trial", trial_ends_at: "2026-08-01T00:00:00.000Z", current_period_end: null },
    };

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.subscriber).toEqual({
      firstName: null,
      lastName: null,
      name: "Justin Alpar",
      email: "you@stablepass.co",
      phone: "+61 431 581 526",
    });
    expect(body.data.subscription).toEqual({ status: "trial", trialEndsAt: "2026-08-01T00:00:00.000Z", currentPeriodEnd: null });
    expect(body.data.prefs).toEqual({ newPost: true, raceDay: true, raceResult: false, milestone: false });
  });

  it("returns the new first/last subscriber fields with the exact key set", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    tableData.app_user = {
      data: {
        first_name: "Justin",
        last_name: "Alpar",
        name: "Justin Alpar",
        email: "you@stablepass.co",
        phone: "+61 431 581 526",
        pref_new_post: true,
        pref_race_day: true,
        pref_race_result: false,
        pref_milestone: false,
      },
    };
    tableData.subscription = {
      data: { status: "trial", trial_ends_at: "2026-08-01T00:00:00.000Z", current_period_end: null },
    };

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.subscriber).toEqual({
      firstName: "Justin",
      lastName: "Alpar",
      name: "Justin Alpar",
      email: "you@stablepass.co",
      phone: "+61 431 581 526",
    });
    // Pinned key set — a renamed/dropped field silently vanishes from the JSON
    // rather than failing per-field assertions (.rx/gotchas.md).
    expect(Object.keys(body.data.subscriber).sort()).toEqual(
      ["email", "firstName", "lastName", "name", "phone"].sort(),
    );
  });

  it("selects first_name and last_name on app_user", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    tableData.app_user = {
      data: {
        first_name: "Justin",
        last_name: "Alpar",
        name: "Justin Alpar",
        email: "you@stablepass.co",
        phone: "+61 431 581 526",
        pref_new_post: true,
        pref_race_day: true,
        pref_race_result: false,
        pref_milestone: false,
      },
    };
    tableData.subscription = { data: { status: "trial", trial_ends_at: null, current_period_end: null } };

    await GET();

    expect(appUserChain.select).toHaveBeenCalledWith(expect.stringContaining("first_name"));
    expect(appUserChain.select).toHaveBeenCalledWith(expect.stringContaining("last_name"));
  });
});

describe("PATCH /api/me", () => {
  beforeEach(() => {
    getUserMock.mockReset();
    fromMock.mockClear();
    updateMock.mockClear();
    appUserChain.select.mockClear();
    for (const key of Object.keys(tableData)) delete tableData[key];
  });

  it("returns 401 with the error envelope when there is no session", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });

    const res = await PATCH(patchReq({ name: "New Name" }));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error.code).toBe("unauthorized");
  });

  it("updates app_user with only the provided fields mapped to DB columns, never is_admin/email", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    tableData.app_user = {
      data: {
        name: "New Name",
        email: "you@stablepass.co",
        phone: "+61 431 581 526",
        pref_new_post: true,
        pref_race_day: false,
        pref_race_result: true,
        pref_milestone: true,
      },
    };

    const res = await PATCH(patchReq({ name: "New Name", prefs: { raceDay: false } }));
    const body = await res.json();

    expect(res.status).toBe(200);
    const call = updateMock.mock.calls.find((c) => c[0] === "app_user");
    expect(call).toBeTruthy();
    const patch = call![1] as Record<string, unknown>;
    expect(patch).toEqual({ name: "New Name", pref_race_day: false });
    expect(patch).not.toHaveProperty("is_admin");
    expect(patch).not.toHaveProperty("email");
    expect(body.data.subscriber).toEqual({
      firstName: null,
      lastName: null,
      name: "New Name",
      email: "you@stablepass.co",
      phone: "+61 431 581 526",
    });
    expect(body.data.prefs).toEqual({ newPost: true, raceDay: false, raceResult: true, milestone: true });
  });

  it("returns 400 validation_failed when the body has nothing updatable", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });

    const res = await PATCH(patchReq({}));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("validation_failed");
  });

  it("returns 400 update_failed when the update errors", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    tableData.app_user = { data: null, error: { message: "boom" } };

    const res = await PATCH(patchReq({ name: "New Name" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("update_failed");
  });

  it("trims firstName/lastName into a first_name/last_name patch", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    tableData.app_user = {
      data: {
        first_name: "Justin",
        last_name: "Alpar",
        name: "Justin Alpar",
        email: "you@stablepass.co",
        phone: "+61 431 581 526",
        pref_new_post: true,
        pref_race_day: true,
        pref_race_result: true,
        pref_milestone: true,
      },
    };

    const res = await PATCH(patchReq({ firstName: "  Justin  ", lastName: "  Alpar  " }));

    expect(res.status).toBe(200);
    const call = updateMock.mock.calls.find((c) => c[0] === "app_user");
    const patch = call![1] as Record<string, unknown>;
    expect(patch).toEqual({ first_name: "Justin", last_name: "Alpar" });
  });

  it("still supports the legacy mobile {name} PATCH", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    tableData.app_user = {
      data: {
        name: "Legacy Name",
        email: "you@stablepass.co",
        phone: "+61 431 581 526",
        pref_new_post: true,
        pref_race_day: true,
        pref_race_result: true,
        pref_milestone: true,
      },
    };

    const res = await PATCH(patchReq({ name: "Legacy Name" }));

    expect(res.status).toBe(200);
    const call = updateMock.mock.calls.find((c) => c[0] === "app_user");
    const patch = call![1] as Record<string, unknown>;
    expect(patch).toEqual({ name: "Legacy Name" });
  });

  it("never lets is_admin/email/id ride along on a firstName/lastName PATCH", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    tableData.app_user = {
      data: {
        first_name: "A",
        last_name: "B",
        name: "A B",
        email: "you@stablepass.co",
        phone: "+61 431 581 526",
        pref_new_post: true,
        pref_race_day: true,
        pref_race_result: true,
        pref_milestone: true,
      },
    };

    const res = await PATCH(
      patchReq({ firstName: "A", lastName: "B", is_admin: true, email: "attacker@evil.com", id: "someone-else" }),
    );

    expect(res.status).toBe(200);
    const call = updateMock.mock.calls.find((c) => c[0] === "app_user");
    const patch = call![1] as Record<string, unknown>;
    expect(patch).toEqual({ first_name: "A", last_name: "B" });
    expect(patch).not.toHaveProperty("is_admin");
    expect(patch).not.toHaveProperty("email");
    expect(patch).not.toHaveProperty("id");
  });

  it("ignores a wrong-type firstName and falls through to 400 validation_failed", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });

    const res = await PATCH(patchReq({ firstName: 123 }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.message).toBe("Nothing to update.");
  });

  it("returns the fixed error copy and never leaks the raw Supabase error text", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    tableData.app_user = {
      data: null,
      error: { message: "duplicate key value violates unique constraint \"app_user_email_key\" you@stablepass.co" },
    };

    const res = await PATCH(patchReq({ name: "New Name" }));
    const bodyText = await res.text();
    const body = JSON.parse(bodyText);

    expect(res.status).toBe(400);
    expect(body.error.message).toBe("Couldn't save your changes.");
    expect(bodyText).not.toContain("stablepass.co");
  });
});
