import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

// A minimal RPC-shaped Supabase stub, on the test/signup-route.test.ts pattern:
// `rpc()` is the only method the route actually calls on the mocked client.
// `select` is exposed on the SAME thenable purely so the "never chains
// .select()" test can assert it was never invoked — see the RPC block at the
// top of route.ts. `from` is exposed too, but as a trap: see `fromMock` below.
//
// `rpcMock` returns a THENABLE (an object with `.then`, plus `.select`), not a
// bare Promise. A bare Promise makes the ".select() is never chained"
// assertion vacuous: if the route were ever changed to
// `.rpc(...).select(...)`, `.select` would not exist on a Promise and the
// route would crash a DIFFERENT test (whichever one happens to call rpc)
// rather than failing the assertion that is actually supposed to catch it.
// With this shape, `.rpc(...)` resolves via `await` exactly as before AND
// `.select()` is genuinely callable off it, so
// `expect(selectMock).not.toHaveBeenCalled()` pins the real thing.
const selectMock = vi.fn();

function rpcResolution(result: { error: { code?: string; details?: string } | null }) {
  return {
    then: (resolve: (value: { error: { code?: string; details?: string } | null }) => void) =>
      resolve(result),
    select: selectMock,
  };
}

const RPC_NAME = "waitlist_join";

// `_fn`/`_args` are declared (rather than a bare `() => ...`) so
// `mock.calls[0][0]` types as a string under `tsc --noEmit` — the same reason
// the old `fromMock` declared `_table`.
const rpcMock = vi.fn((_fn?: string, _args?: { p_email: string }) => rpcResolution({ error: null }));

// `from` is still exposed on the mocked client — and it THROWS. Since ENG-802
// the route must never reach the table again; if it ever did, this makes the
// test fail loudly (a rejected POST) instead of silently passing because
// `from` happened to return something plausible-looking.
const fromMock = vi.fn((_table?: string) => {
  throw new Error("route must not touch the table directly");
});

// The route no longer imports `@/lib/supabase/server`; it builds its own
// cookie-free client with `createServerClient` from `@supabase/ssr` directly
// — see `lib/supabase/server.ts` and `test/auth-cookie-name.test.ts` for the
// same mocking shape applied to the cookie-bound client.
type ClientArgs = [
  url: unknown,
  key: unknown,
  options?: { cookies?: { getAll: () => unknown[]; setAll: (toSet: unknown[]) => void } },
];

const createServerClientMock = vi.fn<
  (...args: ClientArgs) => { from: typeof fromMock; rpc: typeof rpcMock }
>(() => ({ from: fromMock, rpc: rpcMock }));

vi.mock("@supabase/ssr", () => ({
  createServerClient: (...args: ClientArgs) => createServerClientMock(...args),
}));

import { POST } from "@/app/api/waitlist/route";

function jsonReq(body: unknown): Request {
  return new Request("http://localhost/api/waitlist", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
}

// A realistic browser Accept header — this is what actually selects the 303
// branch under the new `wantsJson()` rule (JSON unless the caller explicitly
// asked for HTML). A native <form> submission always sends this.
const BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

function formReq(fields: Record<string, string>): Request {
  return new Request("http://localhost/api/waitlist", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: BROWSER_ACCEPT,
    },
    body: new URLSearchParams(fields).toString(),
  });
}

const FRESH_SUCCESS_BODY = { data: { ok: true } };
const INVALID_EMAIL_BODY = {
  error: { code: "invalid_email", message: "Enter a valid email address." },
};

function resetChain() {
  fromMock.mockClear();
  rpcMock.mockReset();
  selectMock.mockReset();
  rpcMock.mockImplementation(() => rpcResolution({ error: null }));
}

describe("POST /api/waitlist — JSON dialect (caller sends Accept: application/json)", () => {
  beforeEach(resetChain);

  it("1. a fresh join succeeds with the ok envelope and joins exactly the trimmed email", async () => {
    const res = await POST(jsonReq({ email: "a@b.co" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual(FRESH_SUCCESS_BODY);
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith(RPC_NAME, { p_email: "a@b.co" });
  });

  it("2. a repeat join answers byte-identically to a first-time join — no enumeration", async () => {
    // No mockImplementationOnce for either call — the function swallows the
    // conflict server-side, so a first-time join AND a repeat join both
    // legitimately resolve `{ error: null }`. Forcing a distinguishable error
    // code here would be testing a world that no longer exists.
    const firstRes = await POST(jsonReq({ email: "dup@b.co" }));
    const firstBody = await firstRes.json();

    const secondRes = await POST(jsonReq({ email: "dup@b.co" }));
    const secondBody = await secondRes.json();

    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(200);
    expect(secondRes.status).toBe(firstRes.status);
    expect(secondBody).toEqual(firstBody);
    expect(secondBody).toEqual(FRESH_SUCCESS_BODY);

    // Dedupe is now the DATABASE's job — an untargeted `on conflict do
    // nothing` inside `waitlist_join`, covered by ENG-770's own RLS tests, not
    // this file's. What THIS test pins is the two things the route is still
    // responsible for: that it delegates the write on EVERY submission, and
    // that its answer is identical both times. The call-count assertion is
    // what stops this test passing against a route that never calls the RPC
    // at all — two `{ error: null }` bodies compared to each other are
    // trivially equal even if neither call happened.
    expect(rpcMock).toHaveBeenCalledTimes(2);
    expect(rpcMock.mock.calls.map((c) => c[1])).toEqual([
      { p_email: "dup@b.co" },
      { p_email: "dup@b.co" },
    ]);
  });

  describe("3. honeypot — decoy field trips it silently, real users must not", () => {
    it("trips on company filled with a non-empty string and never calls the RPC", async () => {
      const res = await POST(jsonReq({ email: "a@b.co", company: "Acme" }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual(FRESH_SUCCESS_BODY);
      expect(rpcMock).not.toHaveBeenCalled();
    });

    it("trips on hp_ref filled with a non-empty string and never calls the RPC", async () => {
      const res = await POST(jsonReq({ email: "a@b.co", hp_ref: "x" }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual(FRESH_SUCCESS_BODY);
      expect(rpcMock).not.toHaveBeenCalled();
    });

    it("trips even when the email itself is invalid", async () => {
      const res = await POST(jsonReq({ email: "nope", company: "Acme" }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual(FRESH_SUCCESS_BODY);
      expect(rpcMock).not.toHaveBeenCalled();
    });

    // decoyFilled() is deliberately NOT str(): str() coerces a non-string to
    // "", which would let a number, array or object sail straight past the
    // trap and reach the database — exactly the shape a deliberate evader
    // would send, and previously the shape that DID leak through.
    const nonStringFilled: Array<{ label: string; value: unknown }> = [
      { label: "a number", value: 1 },
      { label: "an array", value: ["x"] },
      { label: "an object", value: {} },
    ];

    for (const { label, value } of nonStringFilled) {
      it(`trips when company is ${label}, not just a non-empty string`, async () => {
        const res = await POST(jsonReq({ email: "a@b.co", company: value }));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toEqual(FRESH_SUCCESS_BODY);
        expect(rpcMock).not.toHaveBeenCalled();
      });
    }

    // Empty or whitespace-only must NOT trap a real user — an untouched
    // hidden field (or one autofill leaves a stray space in) is not evidence
    // of a bot. Getting this wrong silently discards a real signup with the
    // ordinary success answer and nothing logged to notice by.
    const notFilled: Array<{ label: string; value: unknown }> = [
      { label: "empty string", value: "" },
      { label: "whitespace only", value: "   " },
      { label: "null", value: null },
    ];

    for (const { label, value } of notFilled) {
      it(`does NOT trip on company = ${label} — a real user, the RPC IS called`, async () => {
        const res = await POST(jsonReq({ email: "a@b.co", company: value }));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toEqual(FRESH_SUCCESS_BODY);
        expect(rpcMock).toHaveBeenCalledTimes(1);
        expect(rpcMock).toHaveBeenCalledWith(RPC_NAME, { p_email: "a@b.co" });
      });
    }

    it("logs that the honeypot tripped, with no email address in the log line", async () => {
      const consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

      await POST(jsonReq({ email: "secret@example.co", company: "Acme" }));

      expect(consoleInfoSpy).toHaveBeenCalledWith("waitlist honeypot tripped");
      const logged = consoleInfoSpy.mock.calls.flat().join(" ");
      expect(logged).not.toContain("secret@example.co");

      consoleInfoSpy.mockRestore();
    });
  });

  describe("4. invalid email — table", () => {
    // "a".repeat(250) + "@b.co" is 255 characters, one over MAX_EMAIL_LENGTH.
    const tooLong = "a".repeat(250) + "@b.co";

    const cases: Array<{ label: string; value?: unknown; omitKey?: boolean }> = [
      { label: "empty string", value: "" },
      { label: "whitespace only", value: "   " },
      { label: "no @ or dot", value: "nope" },
      { label: "no TLD", value: "a@b" },
      { label: "contains a space", value: "a b@c.co" },
      { label: "missing key entirely", omitKey: true },
      { label: "a non-string", value: 123 },
      { label: "over 254 chars", value: tooLong },
    ];

    for (const { label, value, omitKey } of cases) {
      it(`400s invalid_email for ${label}`, async () => {
        const body = omitKey ? {} : { email: value };
        const res = await POST(jsonReq(body));
        const json = await res.json();

        expect(res.status).toBe(400);
        expect(json).toEqual(INVALID_EMAIL_BODY);
        expect(rpcMock).not.toHaveBeenCalled();
      });
    }
  });

  describe("5. control characters are rejected outright — never reach Postgres", () => {
    // Built with String.fromCharCode so no literal control character sits in
    // the source. NUL is the one that matters most: unrejected, it reaches
    // Postgres and raises 22P05 "unsupported Unicode escape sequence" — a
    // SQLSTATE the route does not special-case (it is not the 23514 CHECK, and
    // since ENG-802 no unique violation reaches the route at all), so it would
    // fall through to the generic 500 branch and let an unauthenticated caller
    // manufacture
    // server errors (and log lines) with a one-character payload. Newline and
    // tab were already rejected before this change (JS `\s` catches them via
    // EMAIL_RE); NUL, BEL and DEL are the genuinely new coverage — verified
    // directly in node that EMAIL_RE alone lets all three of those through.
    const cases: Array<{ label: string; email: string }> = [
      { label: "NUL", email: "a" + String.fromCharCode(0) + "b@x.co" },
      { label: "BEL", email: "a" + String.fromCharCode(7) + "b@x.co" },
      { label: "newline", email: "a" + String.fromCharCode(10) + "b@x.co" },
      { label: "tab", email: "a" + String.fromCharCode(9) + "b@x.co" },
      { label: "DEL", email: "a" + String.fromCharCode(127) + "b@x.co" },
    ];

    for (const { label, email } of cases) {
      it(`400s invalid_email for an embedded ${label} and never calls the RPC`, async () => {
        const res = await POST(jsonReq({ email }));
        const body = await res.json();

        expect(res.status).toBe(400);
        expect(body).toEqual(INVALID_EMAIL_BODY);
        expect(rpcMock).not.toHaveBeenCalled();
      });
    }
  });

  describe("6. zero-width and BOM characters are stripped, not rejected", () => {
    // a<ZWSP>b@x.co passes both this route's EMAIL_RE and the table's own
    // CHECK, and would otherwise land as a SECOND row alongside ab@x.co — a
    // duplicate dedupe cannot see and an unmailable address in the
    // launch-invite export, which is the one job this table has.
    const cases: Array<{ label: string; codePoint: number }> = [
      { label: "U+200B zero-width space", codePoint: 0x200b },
      { label: "U+FEFF BOM", codePoint: 0xfeff },
    ];

    for (const { label, codePoint } of cases) {
      it(`strips ${label} and joins with the cleaned address`, async () => {
        const email = "a" + String.fromCharCode(codePoint) + "b@x.co";
        const res = await POST(jsonReq({ email }));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toEqual(FRESH_SUCCESS_BODY);
        expect(rpcMock).toHaveBeenCalledWith(RPC_NAME, { p_email: "ab@x.co" });
      });
    }
  });

  it("7. NFKC-normalises full-width input to its ASCII equivalent before joining", async () => {
    // Verified directly in node: "ｓａｍ@ｘ.ｃｏ".normalize("NFKC")
    // ("ｓａｍ@ｘ.ｃｏ" is the full-width spelling of "sam@x.co")
    // === "sam@x.co".
    const res = await POST(jsonReq({ email: "ｓａｍ@ｘ.ｃｏ" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual(FRESH_SUCCESS_BODY);
    expect(rpcMock).toHaveBeenCalledWith(RPC_NAME, { p_email: "sam@x.co" });
  });

  it("8. a DB CHECK violation (23514) answers byte-identically to our own validation rejection", async () => {
    // Our own EMAIL_RE rejection, with no DB round trip at all.
    const ownRes = await POST(jsonReq({ email: "nope" }));
    const ownBody = await ownRes.json();

    // The table's own CHECK rejecting an address that passed our regex —
    // reachable only if the two mirrors ever drift.
    rpcMock.mockImplementationOnce(() => rpcResolution({ error: { code: "23514" } }));
    const dbRes = await POST(jsonReq({ email: "good@example.co" }));
    const dbBody = await dbRes.json();

    expect(dbRes.status).toBe(400);
    // A distinguishable branch here would reintroduce the enumeration oracle
    // — assert the two bodies equal each other, not just a shared literal.
    expect(dbBody).toEqual(ownBody);
    expect(dbBody).toEqual(INVALID_EMAIL_BODY);
  });

  // This is the branch where a leak is actually POSSIBLE, so it carries the
  // hostile payload. Test 14 below covers `details` on the 23514 path, but that
  // path answers through `rejectEmail()`, whose envelope is a fixed literal --
  // nothing can escape there even deliberately. EVERY other Postgres error,
  // including a definer-unmasked `details`, arrives here instead. Pinning only
  // the 23514 path would leave the reachable one unguarded: widening the
  // `error` type and passing `error.details` as the message below typechecks
  // cleanly and would ship a verbatim failing row in a 500 body.
  it("9. any other DB error maps to a generic 500 and leaks neither the code NOR the failing row", async () => {
    rpcMock.mockImplementationOnce(() =>
      rpcResolution({
        error: {
          code: "08006",
          details:
            "Failing row contains (018f0f34-0000-7000-8000-000000000000, victim@example.co, null, null, 2026-08-24 00:00:00+00, marketing).",
        },
      }),
    );
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(jsonReq({ email: "good@example.co" }));
    const body = await res.json();

    // Positive assertions first -- an all-negative test passes vacuously.
    expect(res.status).toBe(500);
    expect(body).toEqual({
      error: { code: "waitlist_failed", message: "Something went wrong. Please try again." },
    });
    expect(JSON.stringify(body)).not.toContain("08006");
    expect(JSON.stringify(body)).not.toContain("Failing row");
    expect(JSON.stringify(body)).not.toContain("victim@example.co");

    // Nor may the address or the row reach the log line -- the code alone.
    const logged = consoleErrorSpy.mock.calls.flat().join(" ");
    expect(logged).not.toContain("Failing row");
    expect(logged).not.toContain("victim@example.co");

    consoleErrorSpy.mockRestore();
  });

  it("10. normalises the email — trimmed AND lowercased — before it reaches the RPC", async () => {
    const res = await POST(jsonReq({ email: "  SAM@X.CO  " }));

    expect(res.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith(RPC_NAME, { p_email: "sam@x.co" });
  });

  it("11. never chains .select() off the RPC — waitlist_join returns void, so there is nothing to project", async () => {
    // The function returns `void`, so there is nothing to project: `?select=*`
    // still answers 204, and naming a column raises 42703. Note explicitly:
    // the familiar 42501 "RETURNING needs a SELECT policy" trap is real, but
    // it belongs to the DIRECT-TABLE path — a SECURITY DEFINER body is not
    // gated by the caller's RLS at all. An earlier draft of the BE contract
    // asserted otherwise and was corrected; do not carry that reasoning here.
    await POST(jsonReq({ email: "a@b.co" }));
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("12. never touches the waitlist table directly — the RPC is the only write path (ENG-802)", async () => {
    // This is what makes ENG-803's revoke of the `anon` INSERT grant safe —
    // once that lands, any direct table write from this route would fail in
    // production, so it is pinned here rather than discovered later.
    // (`fromMock` throwing is the belt; this assertion is the braces.)
    await POST(jsonReq({ email: "a@b.co" }));
    expect(fromMock).not.toHaveBeenCalled();
    expect(rpcMock).toHaveBeenCalledWith(RPC_NAME, { p_email: "a@b.co" });
  });

  it("13. the client throwing during construction answers 500 waitlist_failed, no PII logged", async () => {
    createServerClientMock.mockImplementationOnce(() => {
      throw new Error("missing env var");
    });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(jsonReq({ email: "secret@example.co" }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({
      error: { code: "waitlist_failed", message: "Something went wrong. Please try again." },
    });
    const logged = consoleErrorSpy.mock.calls.flat().join(" ");
    expect(logged).not.toContain("secret@example.co");

    consoleErrorSpy.mockRestore();
  });

  it("14. never forwards error.details — a definer RPC unmasks the failing row (ENG-770)", async () => {
    // Measured in ENG-770: because the definer body runs as its OWNER
    // (postgres, BYPASSRLS), Postgres stops suppressing the failing-row
    // DETAIL, so a 23514 through this RPC echoes the table's whole column
    // list and order to an anonymous caller, where the direct-table path
    // returned "details": null. The route's narrow `{ code?: string }` typing
    // is what makes it unreachable; this test is what keeps it that way.
    rpcMock.mockImplementationOnce(() =>
      rpcResolution({
        error: {
          code: "23514",
          details:
            "Failing row contains (018f0f34-0000-7000-8000-000000000000, not-an-email, null, null, 2026-08-24 00:00:00+00, marketing).",
        },
      }),
    );

    const res = await POST(jsonReq({ email: "good@example.co" }));
    const body = await res.json();

    // Positive assertions FIRST — the repo has a documented trap that
    // all-negative assertions pass vacuously.
    expect(res.status).toBe(400);
    expect(body).toEqual(INVALID_EMAIL_BODY);
    expect(JSON.stringify(body)).not.toContain("Failing row");
    expect(JSON.stringify(body)).not.toContain("018f0f34");
    expect(JSON.stringify(body)).not.toContain("marketing");
  });
});

describe("POST /api/waitlist — form dialect (browser Accept: text/html — the no-JS path)", () => {
  beforeEach(resetChain);

  it("1. a fresh join 303s to a RELATIVE /?joined=1 with an empty body", async () => {
    const res = await POST(formReq({ email: "a@b.co" }));
    const location = res.headers.get("location");

    expect(res.status).toBe(303);
    expect(location).toBe("/?joined=1");
    expect(location!.startsWith("/")).toBe(true);
    expect(location).not.toMatch(/^https?:\/\//);
    expect(await res.text()).toBe("");
  });

  it("2. a repeat join 303s the same way as a first-time join", async () => {
    const firstRes = await POST(formReq({ email: "dup@b.co" }));
    const secondRes = await POST(formReq({ email: "dup@b.co" }));

    expect(firstRes.status).toBe(303);
    expect(secondRes.status).toBe(303);
    expect(firstRes.headers.get("location")).toBe("/?joined=1");
    expect(secondRes.headers.get("location")).toBe("/?joined=1");
    expect(secondRes.headers.get("location")).toBe(firstRes.headers.get("location"));
    expect(rpcMock).toHaveBeenCalledTimes(2);
    // Same per-call argument assertion its JSON twin carries. Without it this
    // case catches "never called the RPC" but NOT "called it with the wrong
    // argument name" -- measured: under a p_email -> email mutation the JSON
    // duplicate case failed and this one stayed green.
    expect(rpcMock.mock.calls.map((c) => c[1])).toEqual([
      { p_email: "dup@b.co" },
      { p_email: "dup@b.co" },
    ]);
  });

  it("3. an invalid email 303s to /?joined=0&reason=email", async () => {
    const res = await POST(formReq({ email: "nope" }));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/?joined=0&reason=email");
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("4. an unexpected DB error 303s to /?joined=0&reason=server", async () => {
    rpcMock.mockImplementationOnce(() => rpcResolution({ error: { code: "08006" } }));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(formReq({ email: "good@example.co" }));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/?joined=0&reason=server");

    consoleErrorSpy.mockRestore();
  });

  it("5. the honeypot (company) on the form dialect 303s to success and never writes", async () => {
    const res = await POST(formReq({ email: "a@b.co", company: "Acme" }));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/?joined=1");
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("6. the honeypot (hp_ref) on the form dialect 303s to success and never writes", async () => {
    const res = await POST(formReq({ email: "a@b.co", hp_ref: "x" }));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/?joined=1");
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("7. the client throwing during construction 303s to /?joined=0&reason=server, no PII logged", async () => {
    createServerClientMock.mockImplementationOnce(() => {
      throw new Error("missing env var");
    });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(formReq({ email: "secret@example.co" }));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/?joined=0&reason=server");
    const logged = consoleErrorSpy.mock.calls.flat().join(" ");
    expect(logged).not.toContain("secret@example.co");

    consoleErrorSpy.mockRestore();
  });

  it("8. a form-encoded POST with no explicit content-type header still lands on the validation path, not a 500", async () => {
    // No content-type header set: passing a URLSearchParams instance as the
    // body makes the Request implementation auto-derive
    // "application/x-www-form-urlencoded;charset=UTF-8" for us, exactly like a
    // real <form> submission that never sets an explicit content-type header.
    // This exercises readBody()'s formData() fallback branch rather than the
    // JSON branch. A browser-style Accept header IS set explicitly, so this
    // still lands on the 303 branch — the "no Accept header at all" case now
    // has its own coverage below, because under the new negotiation rule it
    // gets JSON, not a 303.
    const req = new Request("http://localhost/api/waitlist", {
      method: "POST",
      headers: { accept: BROWSER_ACCEPT },
      body: new URLSearchParams({ email: "a@b.co" }),
    });

    const res = await POST(req);

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/?joined=1");
  });
});

describe("accept negotiation — JSON unless the caller explicitly asked for HTML", () => {
  beforeEach(resetChain);

  it("no Accept header at all, form-encoded body -> JSON envelope, NOT a 303", async () => {
    // The obvious rule ("JSON only when Accept names application/json")
    // mis-serves this exact request: no Accept header at all used to fall
    // through to the 303 branch. It now gets JSON, because wantsJson() only
    // opts INTO the 303 branch when the caller explicitly named text/html.
    const req = new Request("http://localhost/api/waitlist", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "a@b.co" }).toString(),
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual(FRESH_SUCCESS_BODY);
  });

  it("Accept: */* -> JSON envelope, not the 303", async () => {
    // This is what a bare fetch() sends by default. A 303 here would be
    // auto-followed by fetch, and the caller would read `response.ok === true`
    // off an HTML landing page rather than the JSON envelope it expects — even
    // for a validation failure.
    const req = new Request("http://localhost/api/waitlist", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "*/*" },
      body: JSON.stringify({ email: "a@b.co" }),
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual(FRESH_SUCCESS_BODY);
  });

  it("a browser-style Accept header gets the 303", async () => {
    const res = await POST(formReq({ email: "a@b.co" }));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/?joined=1");
  });
});

describe("guardrails — the cookie-free client claim is enforced, not just asserted", () => {
  beforeEach(resetChain);

  // `import.meta.url` is read into a variable before being handed to `new
  // URL()`, rather than passed inline. This suite runs under the default
  // jsdom environment (unlike test/middleware.test.ts, which opts into
  // `@vitest-environment node`), and Vite's static analysis specifically
  // special-cases the literal `new URL("...", import.meta.url)` shape for
  // browser asset bundling — it rewrites the base to an http: URL pointing at
  // the dev server, which then makes readFileSync reject it ("must be of
  // scheme file"). Breaking the literal pattern keeps this a plain runtime
  // file:// URL.
  const moduleUrl = import.meta.url;
  const source = readFileSync(new URL("../app/api/waitlist/route.ts", moduleUrl), "utf8");

  it("touches no service-role key or other secret, and does not import the cookie-bound client", () => {
    expect(source).not.toMatch(/SERVICE_ROLE/);
    expect(source).not.toMatch(/_SECRET/);
    // Not "does not mention supabaseServer" — the file's own doc comments
    // legitimately name it to explain why the route deliberately does NOT use
    // it (see the "cookie-free anon client" block). The actual import is what
    // matters.
    expect(source).not.toContain('"@/lib/supabase/server"');
  });

  it("wires an inert cookie adapter — getAll() is always [], setAll() never throws", async () => {
    // This is what makes middleware's "anonymous and cookie-free" justification
    // TRUE by construction rather than merely intended, and is the whole reason
    // /api/waitlist is allowed to punch a hole in the marketing-apex blanket
    // 404 — see isSharedPath() in middleware.ts. It is also what stops auth
    // cookies ever being written back onto the marketing origin.
    await POST(jsonReq({ email: "a@b.co" }));

    expect(createServerClientMock).toHaveBeenCalled();
    const [, , options] = createServerClientMock.mock.calls.at(-1)!;
    expect(options?.cookies?.getAll()).toEqual([]);
    expect(() =>
      options?.cookies?.setAll([{ name: "sb-example-auth-token", value: "x", options: {} }]),
    ).not.toThrow();
  });

  it("passes the anon key, never a service-role key, as the second argument", async () => {
    // Asserted against a SENTINEL, not against `process.env.X` on both sides.
    // Nothing sets these vars for a vitest run (no .env file, and neither
    // vitest.config.ts nor a setup file defines them), so the old form compared
    // `undefined` to `undefined` and passed vacuously -- it would have passed
    // just as happily if the route had read a service-role key from some other
    // variable. Pinning the literal is what makes this a real guardrail test.
    const sentinel = "anon-key-sentinel-eng802";
    const previous = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = sentinel;
    try {
      await POST(jsonReq({ email: "a@b.co" }));

      const [url, key] = createServerClientMock.mock.calls.at(-1)!;
      expect(key).toBe(sentinel);
      expect(String(key)).not.toMatch(/service[_-]?role/i);
      expect(String(url)).not.toMatch(/service[_-]?role/i);
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = previous;
    }
  });

  it("the route no longer references the unique-violation SQLSTATE anywhere (ENG-802)", () => {
    // Positive assertion first, to avoid the vacuous-negative trap: prove the
    // source is actually on the new RPC path before proving the old literal is
    // gone.
    expect(source).toContain('rpc("waitlist_join"');
    // The mapping is dead code now that the function swallows the conflict —
    // the literal is kept out of the file entirely, comments included, so
    // this grep is unambiguous.
    expect(source).not.toContain("23505");
    expect(source).not.toContain("UNIQUE_VIOLATION");
  });
});
