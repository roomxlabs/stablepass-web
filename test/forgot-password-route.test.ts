import { describe, it, expect, vi, beforeEach } from "vitest";

// The floor exists to kill the timing oracle in production; at 1.5s a case it
// would dominate the unit suite. Set before the route module is imported.
process.env.PASSWORD_RESET_FLOOR_MS = "0";

const resetPasswordForEmailMock = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: vi.fn(async () => ({
    auth: { resetPasswordForEmail: resetPasswordForEmailMock },
  })),
}));

import { POST, publicOrigin } from "@/app/api/auth/forgot-password/route";

function req(body: unknown, headers?: Record<string, string>) {
  return new Request("http://localhost/api/auth/forgot-password", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// A body that is not valid JSON at all, and a content type that is not ours.
function rawReq(body: string, headers?: Record<string, string>) {
  return new Request("http://localhost/api/auth/forgot-password", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

const SENT_BODY = { data: { sent: true } };

describe("POST /api/auth/forgot-password", () => {
  beforeEach(() => {
    resetPasswordForEmailMock.mockReset();
    resetPasswordForEmailMock.mockResolvedValue({ data: {}, error: null });
  });

  // ── THE GUARDRAIL: no user enumeration ────────────────────────────────────
  //
  // Every case below is collected and diffed INSIDE ONE `it`. An earlier
  // version accumulated into a module-level array across separate `it` blocks,
  // which meant that under `--shuffle`, `.only`, or concurrent mode the
  // comparison silently degraded to comparing nothing — a guardrail test that
  // quietly stops testing is worse than none.
  it("answers identically — status, body AND headers — however the caller probes it", async () => {
    const cases: { label: string; make: () => Request; before?: () => void }[] = [
      {
        label: "known user",
        make: () => req({ email: "known@example.com" }),
        before: () => resetPasswordForEmailMock.mockResolvedValue({ data: {}, error: null }),
      },
      {
        label: "unknown user (Supabase reports not found)",
        make: () => req({ email: "nobody@example.com" }),
        before: () =>
          resetPasswordForEmailMock.mockResolvedValue({
            data: null,
            error: { message: "User not found", status: 400 },
          }),
      },
      {
        label: "Supabase throws",
        make: () => req({ email: "boom@example.com" }),
        before: () => resetPasswordForEmailMock.mockRejectedValue(new Error("network down")),
      },
      { label: "malformed email", make: () => req({ email: "nope" }) },
      { label: "empty object", make: () => req({}) },
      { label: "absent body", make: () => req(undefined) },
      { label: "non-JSON body", make: () => rawReq("not json at all") },
      { label: "email as number", make: () => req({ email: 42 }) },
      { label: "email as array", make: () => req({ email: ["a@b.co"] }) },
      { label: "email as object", make: () => req({ email: { a: 1 } }) },
      { label: "email null", make: () => req({ email: null }) },
      { label: "JSON null root", make: () => rawReq("null") },
      { label: "unicode local part", make: () => req({ email: "ünïcodé@example.com" }) },
      { label: "very long email", make: () => req({ email: `${"a".repeat(2000)}@example.com` }) },
    ];

    const seen: { label: string; status: number; body: string; headers: string }[] = [];

    for (const c of cases) {
      resetPasswordForEmailMock.mockReset();
      resetPasswordForEmailMock.mockResolvedValue({ data: {}, error: null });
      c.before?.();

      const res = await POST(c.make());
      const body = JSON.stringify(await res.json());
      // Header NAMES are what a prober can see and correlate.
      //
      // HONEST LIMIT: `supabaseServer` is mocked here, so no branch emits the
      // PKCE verifier cookie and this comparison cannot see the one real
      // difference (input that never reaches Supabase carries no verifier).
      // That difference is asserted for real against the running app in the
      // PR's curl evidence, and the enumeration-relevant pair — registered vs
      // unregistered — is identical there too. Kept in the loop because it
      // still catches any NEW header a future branch adds.
      const headers = [...res.headers.keys()].sort().join(",");

      seen.push({ label: c.label, status: res.status, body, headers });
    }

    const first = seen[0];
    for (const s of seen) {
      expect(s.status, `status differs for: ${s.label}`).toBe(first.status);
      expect(s.body, `body differs for: ${s.label}`).toBe(first.body);
      expect(s.headers, `header set differs for: ${s.label}`).toBe(first.headers);
    }
    expect(first.status).toBe(200);
    expect(JSON.parse(first.body)).toEqual(SENT_BODY);
    expect(seen).toHaveLength(cases.length);
  });

  it("does not call Supabase for an address that cannot be one", async () => {
    await POST(req({ email: "nope" }));
    expect(resetPasswordForEmailMock).not.toHaveBeenCalled();
  });

  it("sends for a well-formed address", async () => {
    await POST(req({ email: "known@example.com" }));
    expect(resetPasswordForEmailMock).toHaveBeenCalledTimes(1);
  });

  // ── CSRF / login-fixation guard ───────────────────────────────────────────
  //
  // A cross-site `<form enctype="text/plain">` POST needs no preflight and no
  // CORS. Left open, it plants an attacker-known PKCE verifier cookie in the
  // victim's browser, after which an attacker-supplied `?code=` link signs the
  // victim into the ATTACKER's account. The guard must refuse to do any work —
  // while still answering identically, so it stays enumeration-safe.
  it("ignores a cross-site form POST without leaking that it did", async () => {
    const res = await POST(
      rawReq(JSON.stringify({ email: "known@example.com" }), {
        "content-type": "text/plain;charset=UTF-8",
      }),
    );
    expect(resetPasswordForEmailMock).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SENT_BODY);
  });

  it("ignores a request the browser labels cross-site", async () => {
    const res = await POST(
      req({ email: "known@example.com" }, { "sec-fetch-site": "cross-site" }),
    );
    expect(resetPasswordForEmailMock).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SENT_BODY);
  });

  it("still accepts a same-origin request that declares Sec-Fetch-Site", async () => {
    await POST(req({ email: "known@example.com" }, { "sec-fetch-site": "same-origin" }));
    expect(resetPasswordForEmailMock).toHaveBeenCalledTimes(1);
  });

  // ── The reset link's origin ───────────────────────────────────────────────
  it("points the reset link at /reset-password", async () => {
    await POST(req({ email: "known@example.com" }));
    const [, options] = resetPasswordForEmailMock.mock.calls[0];
    expect(String(options.redirectTo).endsWith("/reset-password")).toBe(true);
  });

  // This assertion is deliberately the INVERSE of what an earlier draft
  // asserted. That draft pinned "x-forwarded-host is honoured" as the contract,
  // which enshrined a host-header injection: the header is attacker-supplied,
  // and it becomes the origin of a password-reset link. The only thing that had
  // been stopping account takeover was Supabase's redirect allow-list — config
  // in a different repo, with no test here.
  it("refuses to build the reset link from an unrecognised forwarded host", async () => {
    await POST(
      req({ email: "known@example.com" }, { "x-forwarded-host": "evil.attacker.example" }),
    );
    const [, options] = resetPasswordForEmailMock.mock.calls[0];
    expect(String(options.redirectTo)).not.toContain("evil.attacker.example");
    expect(String(options.redirectTo)).toBe("https://app.stablepass.co/reset-password");
  });

  it("honours the app host when the forwarded host is the real one", () => {
    const origin = publicOrigin(
      new Request("http://internal/api", {
        headers: { "x-forwarded-host": "app.stablepass.co", "x-forwarded-proto": "https" },
      }),
    );
    expect(origin).toBe("https://app.stablepass.co");
  });

  it("keeps the port for local development", () => {
    const origin = publicOrigin(
      new Request("http://internal/api", { headers: { "x-forwarded-host": "localhost:32566" } }),
    );
    expect(origin).toBe("http://localhost:32566");
  });

  // ── The LOCAL branch, adversarially ──────────────────────────────────────
  //
  // The first review pass only ever tested `evil.attacker.example`, which takes
  // the NON-local branch — so it confirmed a hole it had not exercised. The
  // hole was in the *local* branch: it returned early with the RAW header
  // interpolated into the origin, reaching neither the allow-list nor any
  // scheme check. `isLocalHost` matches the SUFFIXES `.local` and `.localhost`,
  // so `attacker.com/.local` took that branch, and `x-forwarded-proto` was
  // copied through unread. Every case below asserts the produced origin.
  function originFor(headers: Record<string, string>) {
    return publicOrigin(new Request("http://internal/api", { headers }));
  }

  const APP = "https://app.stablepass.co";

  it.each([
    // The measured takeover: a suffix match on `.local` with a path smuggled in.
    ["a path smuggled past the .local suffix", { "x-forwarded-host": "attacker.com/.local" }, APP],
    ["the same via .localhost", { "x-forwarded-host": "attacker.com/.localhost" }, APP],
    // The scheme must be ours, never the header's.
    [
      "a javascript: scheme on a local-looking host",
      { "x-forwarded-host": "attacker.com/.local", "x-forwarded-proto": "javascript" },
      APP,
    ],
    [
      "a javascript: scheme on a genuinely local host",
      { "x-forwarded-host": "localhost:3000", "x-forwarded-proto": "javascript" },
      "http://localhost:3000",
    ],
    [
      "a data: scheme on a genuinely local host",
      { "x-forwarded-host": "localhost", "x-forwarded-proto": "data" },
      "http://localhost",
    ],
    // Embedded credentials: the userinfo segment must not survive.
    ["embedded credentials", { "x-forwarded-host": "user:pass@evil.local" }, APP],
    [
      "embedded credentials in front of a real local host",
      { "x-forwarded-host": "user:pass@localhost:3000" },
      APP,
    ],
    ["an @ pointing the origin elsewhere", { "x-forwarded-host": "localhost@attacker.com" }, APP],
    // A port on a host that is NOT allow-listed buys nothing.
    ["a port on a hostile local-suffixed host", { "x-forwarded-host": "attacker.com.local:8080" }, APP],
    // IDN / punycode lookalikes of `localhost`.
    ["a punycode localhost lookalike", { "x-forwarded-host": "xn--lclhost-3va.local" }, APP],
    // A header is a ByteString, so a raw Cyrillic `\u043E` cannot even be put
    // in one — what a proxy actually forwards is its UTF-8 bytes read as
    // latin1. That is the form tested here.
    ["a unicode localhost lookalike", { "x-forwarded-host": "\u00D0\u00BEocalhost" }, APP],
    ["a punycode host under .localhost", { "x-forwarded-host": "xn--80ak6aa92e.localhost" }, APP],
    // Trailing-dot (fully-qualified root) forms.
    ["a trailing-dot hostile host", { "x-forwarded-host": "attacker.com/.local." }, APP],
    ["a trailing-dot app host", { "x-forwarded-host": "app.stablepass.co." }, APP],
    // Genuine local hosts still work, and still only ever yield http/https.
    ["a trailing-dot localhost", { "x-forwarded-host": "localhost." }, "http://localhost"],
    ["a trailing-dot localhost with a port", { "x-forwarded-host": "localhost.:4173" }, "http://localhost:4173"],
    ["an https proxy in front of localhost", { "x-forwarded-host": "localhost:3000", "x-forwarded-proto": "https" }, "https://localhost:3000"],
    ["a loopback IP", { "x-forwarded-host": "127.0.0.1:8080" }, "http://127.0.0.1:8080"],
    ["a bracketed IPv6 loopback", { "x-forwarded-host": "[::1]:3000" }, "http://[::1]:3000"],
    // `::1` unbracketed: the `:1` is NOT a port, and must not be re-read as one.
    // Re-bracketed: `new URL("http://::1/reset-password")` throws.
    ["a bare IPv6 loopback", { "x-forwarded-host": "::1" }, "http://[::1]"],
    // A non-numeric or out-of-range port is dropped, not interpolated.
    ["a non-numeric port", { "x-forwarded-host": "localhost:evil" }, APP],
    // An out-of-range port is dropped rather than interpolated: the host is
    // allow-listed, so the origin is safe, just portless.
    ["an out-of-range port", { "x-forwarded-host": "localhost:99999" }, "http://localhost"],
  ])("produces a safe origin for %s", (_label, headers, expected) => {
    expect(originFor(headers)).toBe(expected);
  });

  it("only ever produces an http or https origin", () => {
    const hostile = [
      "attacker.com/.local",
      "user:pass@evil.local",
      "localhost@attacker.com",
      "javascript:alert(1).local",
      "\u00D0\u00BEocalhost",
      "localhost:3000",
    ];
    const protos = ["javascript", "data", "file", "JAVASCRIPT", " javascript ", "vbscript"];
    for (const host of hostile) {
      for (const proto of protos) {
        const origin = originFor({ "x-forwarded-host": host, "x-forwarded-proto": proto });
        expect(origin).toMatch(/^https?:\/\//);
        // Strip the scheme by pattern, NOT by a fixed length: `"https://".length`
        // is 8 while `http://` is 7, so slicing would eat the first character of
        // every http host and let `http://@evil.com` through this very check.
        const authority = origin.replace(/^https?:\/\//, "");
        expect(authority).not.toMatch(/[/@?#\\;,\s]/);
        // The origin is concatenated with `/reset-password` and handed to
        // Supabase as `redirectTo`. It must survive URL parsing, and the parsed
        // origin must still be the one we produced — no smuggled authority.
        const parsed = new URL(`${origin}/reset-password`);
        expect(parsed.origin).toBe(origin);
        expect(parsed.username).toBe("");
        expect(parsed.password).toBe("");
        expect(["http:", "https:"]).toContain(parsed.protocol);
      }
    }
  });

  it("never takes the local branch in production, whatever the header says", () => {
    const previous = process.env.NODE_ENV;
    // NODE_ENV is a readonly getter under some type defs; assign through the record.
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    try {
      expect(originFor({ "x-forwarded-host": "localhost:3000" })).toBe(APP);
      expect(originFor({ "x-forwarded-host": "attacker.com/.local" })).toBe(APP);
      expect(originFor({ "x-forwarded-host": "127.0.0.1" })).toBe(APP);
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = previous;
    }
  });

  it("sends the hostile local-branch origin to nobody — end to end through POST", async () => {
    resetPasswordForEmailMock.mockClear();
    await POST(
      req({ email: "known@example.com" }, { "x-forwarded-host": "attacker.com/.local" }),
    );
    const [, options] = resetPasswordForEmailMock.mock.calls[0];
    expect(String(options.redirectTo)).toBe("https://app.stablepass.co/reset-password");
  });
});
