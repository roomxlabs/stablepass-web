import { describe, it, expect, vi, beforeEach } from "vitest";

// A minimal chainable Supabase stub, on the test/signup-route.test.ts pattern:
// `from()` always returns the same chain object, and `insert` is the only
// method the route actually calls off it. `select`/`upsert` are exposed on the
// SAME chain purely so tests 9 and 10 can assert they were never invoked —
// see the "the insert idiom is load-bearing" block at the top of route.ts.
const insertMock = vi.fn();
const selectMock = vi.fn();
const upsertMock = vi.fn();

const chain: {
  insert: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
} = {
  insert: insertMock,
  select: selectMock,
  upsert: upsertMock,
};

// `_table` is declared (rather than a bare `() => chain`) so `mock.calls[0][0]`
// types as a string under `tsc --noEmit` — the same reason signup-route.test.ts
// declares its fromMock this way.
const fromMock = vi.fn((_table?: string) => chain);

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: vi.fn(async () => ({
    from: fromMock,
  })),
}));

import { POST } from "@/app/api/waitlist/route";

function jsonReq(body: unknown): Request {
  return new Request("http://localhost/api/waitlist", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
}

function formReq(fields: Record<string, string>): Request {
  return new Request("http://localhost/api/waitlist", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

const FRESH_SUCCESS_BODY = { data: { ok: true } };
const INVALID_EMAIL_BODY = {
  error: { code: "invalid_email", message: "Enter a valid email address." },
};

function resetChain() {
  fromMock.mockClear();
  insertMock.mockReset();
  selectMock.mockReset();
  upsertMock.mockReset();
  insertMock.mockResolvedValue({ error: null });
}

describe("POST /api/waitlist — JSON dialect (caller sends Accept: application/json)", () => {
  beforeEach(resetChain);

  it("1. a fresh insert succeeds with the ok envelope and inserts exactly the trimmed email", async () => {
    const res = await POST(jsonReq({ email: "a@b.co" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual(FRESH_SUCCESS_BODY);
    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(insertMock).toHaveBeenCalledWith({ email: "a@b.co" });
  });

  it("2. a duplicate (23505) answers byte-identically to a fresh insert — no enumeration", async () => {
    const freshRes = await POST(jsonReq({ email: "fresh@b.co" }));
    const freshBody = await freshRes.json();

    insertMock.mockResolvedValueOnce({ error: { code: "23505" } });
    const dupRes = await POST(jsonReq({ email: "dup@b.co" }));
    const dupBody = await dupRes.json();

    expect(dupRes.status).toBe(200);
    // Byte-identical to the fresh-insert body, not merely to a literal.
    expect(dupBody).toEqual(freshBody);
    expect(dupBody).toEqual(FRESH_SUCCESS_BODY);
  });

  it("3. the honeypot short-circuits to success and never calls insert", async () => {
    const res = await POST(jsonReq({ email: "a@b.co", company: "Acme" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual(FRESH_SUCCESS_BODY);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("4. the honeypot wins even when the email itself is invalid", async () => {
    const res = await POST(jsonReq({ email: "nope", company: "Acme" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual(FRESH_SUCCESS_BODY);
    expect(insertMock).not.toHaveBeenCalled();
  });

  describe("5. invalid email — table", () => {
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
        expect(insertMock).not.toHaveBeenCalled();
      });
    }
  });

  it("6. a DB CHECK violation (23514) answers byte-identically to our own validation rejection", async () => {
    // Our own EMAIL_RE rejection, with no DB round trip at all.
    const ownRes = await POST(jsonReq({ email: "nope" }));
    const ownBody = await ownRes.json();

    // The table's own CHECK rejecting an address that passed our regex —
    // reachable only if the two mirrors ever drift.
    insertMock.mockResolvedValueOnce({ error: { code: "23514" } });
    const dbRes = await POST(jsonReq({ email: "good@example.co" }));
    const dbBody = await dbRes.json();

    expect(dbRes.status).toBe(400);
    // A distinguishable branch here would reintroduce the oracle the 23505
    // mapping exists to close — assert the two bodies equal each other, not
    // just a shared literal.
    expect(dbBody).toEqual(ownBody);
    expect(dbBody).toEqual(INVALID_EMAIL_BODY);
  });

  it("7. any other DB error maps to a generic 500 and never leaks the PostgREST code", async () => {
    insertMock.mockResolvedValueOnce({ error: { code: "08006" } });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(jsonReq({ email: "good@example.co" }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({
      error: { code: "waitlist_failed", message: "Something went wrong. Please try again." },
    });
    expect(JSON.stringify(body)).not.toContain("08006");

    consoleErrorSpy.mockRestore();
  });

  it("8. normalises the email — trimmed AND lowercased — before it reaches insert", async () => {
    const res = await POST(jsonReq({ email: "  SAM@X.CO  " }));

    expect(res.status).toBe(200);
    expect(insertMock).toHaveBeenCalledWith({ email: "sam@x.co" });
  });

  it("9. never chains .select() off the insert — RETURNING would 42501 under anon RLS", async () => {
    await POST(jsonReq({ email: "a@b.co" }));
    expect(selectMock).not.toHaveBeenCalled();
  });

  // ENG-723: the route was originally written around
  // `.upsert({ email }, { onConflict: "email", ignoreDuplicates: true })`, but
  // that idiom 42501s on EVERY insert under the anon role's RLS — a targeted
  // ON CONFLICT arbiter requires SELECT-checkable visibility anon does not
  // have, and `onConflict: "email"` separately 42P10s because the unique index
  // is an expression index, not a plain column constraint. The route must go
  // on doing a bare .insert() and absorb 23505 itself.
  it("10. never uses .upsert() (ENG-723 — the upsert idiom 42501s under RLS)", async () => {
    await POST(jsonReq({ email: "a@b.co" }));
    expect(upsertMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/waitlist — form dialect (no Accept: application/json — the no-JS path)", () => {
  beforeEach(resetChain);

  it("11. a fresh insert 303s to a RELATIVE /?joined=1 with an empty body", async () => {
    const res = await POST(formReq({ email: "a@b.co" }));
    const location = res.headers.get("location");

    expect(res.status).toBe(303);
    expect(location).toBe("/?joined=1");
    expect(location!.startsWith("/")).toBe(true);
    expect(location).not.toMatch(/^https?:\/\//);
    expect(await res.text()).toBe("");
  });

  it("12. a duplicate (23505) 303s the same way as a fresh insert", async () => {
    insertMock.mockResolvedValueOnce({ error: { code: "23505" } });
    const res = await POST(formReq({ email: "dup@b.co" }));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/?joined=1");
  });

  it("13. an invalid email 303s to /?joined=0&reason=email", async () => {
    const res = await POST(formReq({ email: "nope" }));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/?joined=0&reason=email");
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("14. an unexpected DB error 303s to /?joined=0&reason=server", async () => {
    insertMock.mockResolvedValueOnce({ error: { code: "08006" } });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(formReq({ email: "good@example.co" }));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/?joined=0&reason=server");

    consoleErrorSpy.mockRestore();
  });

  it("15. the honeypot on the form dialect 303s to success and never writes", async () => {
    const res = await POST(formReq({ email: "a@b.co", company: "Acme" }));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/?joined=1");
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("16. a form-encoded POST with no explicit content-type header still lands on the validation path, not a 500", async () => {
    // No headers set at all: passing a URLSearchParams instance as the body
    // makes the Request implementation auto-derive
    // "application/x-www-form-urlencoded;charset=UTF-8" for us, exactly like a
    // real <form> submission that never sets an explicit header. This exercises
    // readBody()'s formData() fallback branch rather than the JSON branch.
    const req = new Request("http://localhost/api/waitlist", {
      method: "POST",
      body: new URLSearchParams({ email: "a@b.co" }),
    });

    const res = await POST(req);

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/?joined=1");
  });
});
