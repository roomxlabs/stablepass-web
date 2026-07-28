import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture what each factory hands to @supabase/ssr. The thing under test is the
// `cookieOptions.name` (@supabase/ssr passes it through as the auth `storageKey`,
// which every auth cookie name is derived from) — not any network behaviour.
type ClientArgs = [url: unknown, key: unknown, options?: { cookieOptions?: { name?: string } }];

const createServerClientMock = vi.fn<(...args: ClientArgs) => object>(() => ({}));
const createBrowserClientMock = vi.fn<(...args: ClientArgs) => object>(() => ({}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: (...args: ClientArgs) => createServerClientMock(...args),
  createBrowserClient: (...args: ClientArgs) => createBrowserClientMock(...args),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ getAll: () => [], set: () => {} })),
}));

import { supabaseServer } from "@/lib/supabase/server";
import { supabaseBrowser } from "@/lib/supabase/client";
import { AUTH_COOKIE_NAME } from "@/lib/supabase/cookie-name";

const optionsOf = (mock: typeof createServerClientMock) => mock.mock.calls[0]?.[2];

describe("auth cookie name is namespaced to this app", () => {
  beforeEach(() => {
    createServerClientMock.mockClear();
    createBrowserClientMock.mockClear();
  });

  // The bug: cookies are scoped by domain, NOT by port. With the @supabase/ssr
  // default (`sb-<project-ref>-auth-token`) the member app on localhost:3000 and
  // stablepass-admin on localhost:3002 hit the SAME cookie — signing into admin
  // replaced the member session with the admin one.
  it("does not fall back to the project-ref default shared with stablepass-admin", () => {
    expect(AUTH_COOKIE_NAME).not.toMatch(/^sb-[a-z]{20}-auth-token$/);
    expect(AUTH_COOKIE_NAME).toContain("stablepass-web");
  });

  it("pins the cookie name on the server client", async () => {
    await supabaseServer();
    expect(optionsOf(createServerClientMock)?.cookieOptions?.name).toBe(AUTH_COOKIE_NAME);
  });

  it("pins the cookie name on the browser client", () => {
    supabaseBrowser();
    expect(optionsOf(createBrowserClientMock)?.cookieOptions?.name).toBe(AUTH_COOKIE_NAME);
  });

  // Load-bearing: the browser writes the session and the Route Handlers read it.
  // If the two names ever drift, every server-side read silently sees no session.
  it("uses the SAME name on both clients", async () => {
    await supabaseServer();
    supabaseBrowser();
    expect(optionsOf(createServerClientMock)?.cookieOptions?.name).toBe(
      optionsOf(createBrowserClientMock)?.cookieOptions?.name,
    );
  });
});
