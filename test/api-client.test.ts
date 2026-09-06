// ENG-961 — central 401 sign-out. A blast-radius change: it can log a member
// out from anywhere, so what does NOT trigger it matters more than what does.
//
// The 402 case is the guardrail test (guardrail 3, content gate): a lapsed
// member is SIGNED IN and must reach the reactivate wall. If a 402 ever signs
// them out, they can never reactivate.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const signOutMock = vi.fn(async (_opts?: { scope?: string }) => ({ error: null }));
vi.mock("@/lib/supabase/client", () => ({
  supabaseBrowser: () => ({ auth: { signOut: signOutMock } }),
}));

import {
  apiFetch,
  isMemberApiRequest,
  resetEvictionLatch,
  suppressEviction,
  SIGNED_OUT_REDIRECT,
} from "@/lib/api/client";

const assignMock = vi.fn();

// The exact body `UNAUTH()` emits (lib/api/envelope.ts).
const UNAUTH_BODY = { error: { code: "unauthorized", message: "Missing or invalid session." } };

function respond(status: number, body: unknown = {}) {
  // 204/205 must not carry a body — the Response constructor rejects one.
  const hasBody = status !== 204 && status !== 205;
  return new Response(hasBody ? JSON.stringify(body) : null, {
    status,
    headers: hasBody ? { "content-type": "application/json" } : undefined,
  });
}

/** Wait out the floating handleEviction() promise chain. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  resetEvictionLatch();
  signOutMock.mockClear();
  assignMock.mockClear();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { origin: "http://localhost:3000", href: "http://localhost:3000/explore", assign: assignMock },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(res: Response) {
  const f = vi.fn(async () => res);
  vi.stubGlobal("fetch", f);
  return f;
}

describe("apiFetch — what signs a member out", () => {
  it("signs out and redirects on a 401 from a member /api/* call", async () => {
    stubFetch(respond(401, UNAUTH_BODY));
    const res = await apiFetch("/api/feed?limit=10");
    await settle();

    expect(res.status).toBe(401); // response still handed back untouched
    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(assignMock).toHaveBeenCalledWith(SIGNED_OUT_REDIRECT);
    expect(SIGNED_OUT_REDIRECT).toBe("/signin?reason=signed-out-elsewhere");
  });

  it("clears the session BEFORE navigating (else /signin bounces back to /explore)", async () => {
    const order: string[] = [];
    signOutMock.mockImplementationOnce(async () => {
      order.push("signOut");
      return { error: null };
    });
    assignMock.mockImplementationOnce(() => void order.push("assign"));
    stubFetch(respond(401, UNAUTH_BODY));
    await apiFetch("/api/me");
    await settle();
    expect(order).toEqual(["signOut", "assign"]);
  });

  it("redirects only ONCE when several member calls 401 together", async () => {
    stubFetch(respond(401, UNAUTH_BODY));
    await Promise.all([apiFetch("/api/feed"), apiFetch("/api/notifications"), apiFetch("/api/me")]);
    await settle();
    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(assignMock).toHaveBeenCalledTimes(1);
  });

  it("still redirects when signOut itself throws", async () => {
    signOutMock.mockRejectedValueOnce(new Error("network"));
    stubFetch(respond(401, UNAUTH_BODY));
    await apiFetch("/api/feed");
    await settle();
    expect(assignMock).toHaveBeenCalledWith(SIGNED_OUT_REDIRECT);
  });
});

describe("apiFetch — what must NEVER sign a member out", () => {
  // THE guardrail case. A lapsed member is signed in; 402 means "reactivate",
  // not "you are logged out". Signing them out here strands them permanently.
  it("does NOT sign out on 402 subscription_required (guardrail 3)", async () => {
    stubFetch(respond(402, { error: { code: "subscription_required" } }));
    const res = await apiFetch("/api/feed");
    await settle();
    expect(res.status).toBe(402);
    expect(signOutMock).not.toHaveBeenCalled();
    expect(assignMock).not.toHaveBeenCalled();
  });

  it.each([200, 204, 400, 403, 404, 409, 429, 500, 502])(
    "does NOT sign out on %i",
    async (status) => {
      stubFetch(respond(status));
      await apiFetch("/api/feed");
      await settle();
      expect(signOutMock).not.toHaveBeenCalled();
      expect(assignMock).not.toHaveBeenCalled();
    },
  );

  it("does NOT sign out on a 401 from a THIRD-PARTY origin", async () => {
    stubFetch(respond(401));
    await apiFetch("https://api.stripe.com/v1/payment_intents");
    await settle();
    expect(signOutMock).not.toHaveBeenCalled();
    expect(assignMock).not.toHaveBeenCalled();
  });

  it("does NOT sign out on a 401 from a non-/api same-origin path", async () => {
    stubFetch(respond(401));
    await apiFetch("/explore");
    await settle();
    expect(signOutMock).not.toHaveBeenCalled();
  });

  it.each(["/api/auth/signup", "/api/auth/forgot-password", "/api/auth/bootstrap"])(
    "does NOT sign out on a 401 from %s (signed-out flows; would loop)",
    async (path) => {
      stubFetch(respond(401));
      await apiFetch(path);
      await settle();
      expect(signOutMock).not.toHaveBeenCalled();
      expect(assignMock).not.toHaveBeenCalled();
    },
  );
});

describe("isMemberApiRequest", () => {
  it.each([
    ["/api/feed", true],
    ["/api/posts/abc/playback", true],
    ["http://localhost:3000/api/me", true],
    ["/api/auth/signup", false],
    ["/api/auth/bootstrap", false],
    ["/explore", false],
    ["/signin", false],
    ["https://api.stripe.com/api/feed", false],
    ["https://stream.mux.com/api/x", false],
  ])("%s -> %s", (input, expected) => {
    expect(isMemberApiRequest(input)).toBe(expected);
  });

  it("accepts a Request and a URL, not just a string", () => {
    expect(isMemberApiRequest(new URL("http://localhost:3000/api/feed"))).toBe(true);
    expect(isMemberApiRequest(new Request("http://localhost:3000/api/feed"))).toBe(true);
    expect(isMemberApiRequest(new Request("https://api.stripe.com/api/feed"))).toBe(false);
  });
});

describe("apiFetch — eviction is local, bounded, and suppressible", () => {
  // The default auth-js scope is "global", which would revoke the member's
  // session on EVERY device. We are reacting to an eviction, not causing one.
  it("clears only THIS browser (scope: local), never every device", async () => {
    stubFetch(respond(401, UNAUTH_BODY));
    await apiFetch("/api/feed");
    await settle();
    expect(signOutMock).toHaveBeenCalledWith({ scope: "local" });
  });

  it("still redirects when signOut HANGS (never resolves)", async () => {
    vi.useFakeTimers();
    signOutMock.mockImplementationOnce(() => new Promise(() => {}) as Promise<{ error: null }>);
    stubFetch(respond(401, UNAUTH_BODY));
    void apiFetch("/api/feed");
    await vi.advanceTimersByTimeAsync(5000);
    vi.useRealTimers();
    expect(assignMock).toHaveBeenCalledWith(SIGNED_OUT_REDIRECT);
  });

  // A deliberate "Sign out" click must never be reported to the member as
  // "your account was signed in on another device".
  it("does NOT evict once a deliberate sign-out is in progress", async () => {
    suppressEviction();
    stubFetch(respond(401, UNAUTH_BODY));
    await apiFetch("/api/notifications/unread-count");
    await settle();
    expect(assignMock).not.toHaveBeenCalled();
  });
});

describe("apiFetch — a 401 must be OUR envelope", () => {
  it.each([
    ["a foreign JSON body", { message: "nope" }],
    ["a different envelope code", { error: { code: "rate_limited" } }],
    ["an empty object", {}],
  ])("does NOT sign out on a 401 with %s", async (_label, body) => {
    stubFetch(respond(401, body));
    await apiFetch("/api/feed");
    await settle();
    expect(signOutMock).not.toHaveBeenCalled();
    expect(assignMock).not.toHaveBeenCalled();
  });

  it("does NOT sign out on a 401 with a non-JSON body (fails closed)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>gateway</html>", { status: 401 })));
    await apiFetch("/api/feed");
    await settle();
    expect(assignMock).not.toHaveBeenCalled();
  });

  it("leaves the caller a readable body (the wrapper is invisible)", async () => {
    stubFetch(respond(401, UNAUTH_BODY));
    const res = await apiFetch("/api/feed");
    await expect(res.json()).resolves.toEqual(UNAUTH_BODY);
  });
});

describe("isMemberApiRequest — server-side", () => {
  it("is false with no window, so the latch is never set on the server", () => {
    const w = globalThis.window;
    // @ts-expect-error - simulating the Node render path
    delete globalThis.window;
    try {
      expect(isMemberApiRequest("https://evil.com/api/x")).toBe(false);
      expect(isMemberApiRequest("/api/feed")).toBe(false);
    } finally {
      globalThis.window = w;
    }
  });
});
