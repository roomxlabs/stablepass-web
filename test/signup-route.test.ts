import { describe, it, expect, vi, beforeEach } from "vitest";

const signUpMock = vi.fn();
const maybeSingleMock = vi.fn();
// ENG-763's pre-signup wall calls the `phone_in_use` RPC before auth.signUp.
// It is mocked at the client, not stubbed per test, because EVERY test in this
// file now reaches it: a route calling `sb.rpc(...)` against a client without
// one throws before it reaches the behaviour under test.
const rpcMock = vi.fn();

const chain: { select: ReturnType<typeof vi.fn>; eq: ReturnType<typeof vi.fn>; maybeSingle: ReturnType<typeof vi.fn> } = {
  select: vi.fn(),
  eq: vi.fn(),
  maybeSingle: maybeSingleMock,
};
chain.select.mockImplementation(() => chain);
chain.eq.mockImplementation(() => chain);
// `_table` is declared (rather than a bare `() => chain`) so `mock.calls[0][0]`
// types as a string under `tsc --noEmit` — the same reason checkout-form.test.tsx
// declares its fetch params.
const fromMock = vi.fn((_table?: string) => chain);

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: vi.fn(async () => ({
    auth: { signUp: signUpMock },
    from: fromMock,
    rpc: rpcMock,
  })),
}));

import { POST } from "@/app/api/auth/signup/route";

function req(body: unknown) {
  return new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  firstName: "Justin",
  lastName: "Alpar",
  email: "jo@example.com",
  phone: "+61400000000",
  postcode: "3000",
  password: "password123",
};

// Successful signUp + subscriber/subscription reads, for tests that need to
// reach past validation into the 201 path.
function mockSuccess(overrides?: { identities?: unknown[] }) {
  signUpMock.mockResolvedValue({
    data: { user: { id: "u1", identities: overrides?.identities ?? [{}] } },
    error: null,
  });
  maybeSingleMock
    .mockResolvedValueOnce({ data: { id: "u1", first_name: "Justin", last_name: "Alpar", name: "Justin Alpar", email: "jo@example.com" } })
    .mockResolvedValueOnce({ data: { status: "trial", trial_ends_at: "2026-08-12T00:00:00.000Z" } });
}

describe("POST /api/auth/signup", () => {
  beforeEach(() => {
    signUpMock.mockReset();
    maybeSingleMock.mockReset();
    rpcMock.mockReset();
    // Default: this number has NOT had a trial, so every pre-existing test
    // reaches the behaviour it was written for. The wall's own tests override.
    rpcMock.mockResolvedValue({ data: false, error: null });
    fromMock.mockClear();
    chain.select.mockClear();
    chain.eq.mockClear();
  });

  it("returns 201 with the subscriber + trial subscription envelope on success", async () => {
    mockSuccess();

    const res = await POST(req(VALID_BODY));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data.subscription.status).toBe("trial");
    expect(body.data.subscription.trialEndsAt).toBe("2026-08-12T00:00:00.000Z");
  });

  // ENG-763 renamed this code from `email_taken`: a repeat email IS "already had
  // your trial" for this product, and it renders the identical wall as a repeat
  // phone so the response cannot be used to tell the two apart.
  it("returns 409 trial_already_used when signUp succeeds but identities is empty (duplicate)", async () => {
    signUpMock.mockResolvedValue({ data: { user: { id: "u1", identities: [] } }, error: null });

    const res = await POST(req(VALID_BODY));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.code).toBe("trial_already_used");
  });

  it("returns 409 trial_already_used when signUp errors with 'already registered'", async () => {
    signUpMock.mockResolvedValue({ data: {}, error: { message: "User already registered", status: 422 } });

    const res = await POST(req(VALID_BODY));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.code).toBe("trial_already_used");
  });

  // ---- the repeat-signup wall (ENG-763) -------------------------------------
  describe("repeat-signup wall — the phone pre-check", () => {
    it("walls a phone that already has an account, and creates NO account", async () => {
      rpcMock.mockResolvedValue({ data: true, error: null });

      const res = await POST(req(VALID_BODY));
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body.error.code).toBe("trial_already_used");
      // The acceptance criterion is "no account is created", so assert the
      // absence of the creation call, not just the status code.
      expect(signUpMock).not.toHaveBeenCalled();
    });

    it("walls a DIFFERENT format of the same number (the whole point of the rule)", async () => {
      rpcMock.mockResolvedValue({ data: true, error: null });

      const res = await POST(req({ ...VALID_BODY, phone: "0400 000 000" }));

      expect(res.status).toBe(409);
      expect(signUpMock).not.toHaveBeenCalled();
    });

    it("sends the number AS TYPED — the RPC normalises in its own body", async () => {
      // Pinning the wire shape: normalising here instead would compare against
      // a rule the database did not apply. `p_phone` is the parameter name in
      // ENG-742's migration; getting it wrong returns 404 PGRST202, which this
      // route deliberately fails open on, so nothing else would catch it.
      mockSuccess();
      await POST(req({ ...VALID_BODY, phone: "(0400) 111-222" }));

      expect(rpcMock).toHaveBeenCalledWith("phone_in_use", { p_phone: "(0400) 111-222" });
    });

    it("does not call the RPC at all for a phone with no digits", async () => {
      // normalizePhone() is null, and the RPC's documented answer for that input
      // is false, so the round trip is skipped rather than guessed at.
      mockSuccess();
      await POST(req({ ...VALID_BODY, phone: "abc" }));

      expect(rpcMock).not.toHaveBeenCalled();
      expect(signUpMock).toHaveBeenCalled();
    });

    it("FAILS OPEN when the RPC is missing (deploy skew), still creating the account", async () => {
      // Web ahead of the migration: phone_in_use does not exist yet. Walling
      // every signup here would take the whole funnel down; the DB backstop
      // still degrades a duplicate phone to NULL.
      rpcMock.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "not found" } });
      mockSuccess();

      const res = await POST(req(VALID_BODY));

      expect(res.status).toBe(201);
      expect(signUpMock).toHaveBeenCalled();
    });

    it("does NOT wall on a non-boolean RPC result", async () => {
      // `sb` is untyped, so nothing upstream guarantees the shape. Only an
      // explicit `true` may close this door — a truthy object here would lock a
      // legitimate member out of signing up with no way to act on it.
      rpcMock.mockResolvedValue({ data: null, error: null });
      mockSuccess();

      const res = await POST(req(VALID_BODY));

      expect(res.status).toBe(201);
    });

    it("shows the wall, not a stack trace, if the DB ever surfaces the phone unique violation", async () => {
      // Unreachable on the current schema (ENG-742's trigger catches this and
      // retries with a NULL phone), so this pins the fallback rather than
      // current behaviour: the index name is a documented rename hazard, and
      // the failure mode without this branch is a raw 500 on signup.
      signUpMock.mockResolvedValue({
        data: {},
        error: {
          code: "23505",
          message: 'duplicate key value violates unique constraint "idx_app_user_phone"',
        },
      });

      const res = await POST(req(VALID_BODY));
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body.error.code).toBe("trial_already_used");
    });

    it("never echoes the database DETAIL, which carries the member's number", async () => {
      // PostgREST forwards Postgres DETAIL verbatim and it contains the
      // normalised phone number. Nothing may reflect it back to the caller.
      signUpMock.mockResolvedValue({
        data: {},
        error: {
          code: "23505",
          message: "Key (normalize_phone(phone))=(61400111222) already exists.",
        },
      });

      const res = await POST(req(VALID_BODY));
      const raw = JSON.stringify(await res.json());

      expect(res.status).toBe(409);
      expect(raw).not.toContain("61400111222");
      expect(raw).not.toContain("normalize_phone");
    });

    it("uses ONE message for both the phone hit and the email hit (no enumeration)", async () => {
      // The resolved open question: never reveal WHICH credential matched.
      rpcMock.mockResolvedValue({ data: true, error: null });
      const phoneHit = await (await POST(req(VALID_BODY))).json();

      rpcMock.mockResolvedValue({ data: false, error: null });
      signUpMock.mockResolvedValue({ data: { user: { id: "u1", identities: [] } }, error: null });
      const emailHit = await (await POST(req(VALID_BODY))).json();

      expect(phoneHit).toEqual(emailHit);
    });
  });

  it("returns 400 validation_failed and never calls signUp when password is missing", async () => {
    const { password: _password, ...withoutPassword } = VALID_BODY;
    void _password;

    const res = await POST(req(withoutPassword));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("validation_failed");
    expect(signUpMock).not.toHaveBeenCalled();
  });

  it("returns 400 validation_failed and never calls signUp when password is too short", async () => {
    const res = await POST(req({ ...VALID_BODY, password: "short" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("validation_failed");
    expect(signUpMock).not.toHaveBeenCalled();
  });

  // (a) every required field: omitted entirely, and present-but-whitespace-only.
  describe("required-field table", () => {
    const fields = ["firstName", "lastName", "email", "phone", "postcode", "password"] as const;

    for (const field of fields) {
      // The MESSAGE is asserted, not just the code. Asserting only the code let
      // the password rows pass via the "must be at least 8 characters" branch,
      // which hid a real hole: '        ' is 8 chars, so it satisfied the length
      // rule and created a live account with an all-whitespace password.
      it(`400 'All fields are required.' when '${field}' is omitted`, async () => {
        const { [field]: _omit, ...rest } = VALID_BODY;
        void _omit;

        const res = await POST(req(rest));
        const body = await res.json();

        expect(res.status).toBe(400);
        expect(body.error.code).toBe("validation_failed");
        expect(body.error.message).toBe("All fields are required.");
        expect(signUpMock).not.toHaveBeenCalled();
      });

      it(`400 'All fields are required.' when '${field}' is whitespace-only`, async () => {
        const res = await POST(req({ ...VALID_BODY, [field]: "   " }));
        const body = await res.json();

        expect(res.status).toBe(400);
        expect(body.error.code).toBe("validation_failed");
        expect(body.error.message).toBe("All fields are required.");
        expect(signUpMock).not.toHaveBeenCalled();
      });
    }
  });

  // An 8-space password is long enough to satisfy the length rule, so without
  // the trimmed emptiness check it reached signUp and provisioned a real
  // account. Pinned explicitly because it is the one blank-field case the
  // length rule can mask.
  it("rejects an all-whitespace password as an empty field, not as a short one", async () => {
    const res = await POST(req({ ...VALID_BODY, password: "        " }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.message).toBe("All fields are required.");
    expect(signUpMock).not.toHaveBeenCalled();
  });

  // A password may legitimately contain leading/trailing spaces — only the
  // emptiness check trims, the value itself must reach signUp untouched.
  it("preserves surrounding spaces inside an otherwise valid password", async () => {
    mockSuccess();

    const res = await POST(req({ ...VALID_BODY, password: "  pass word  " }));

    expect(res.status).toBe(201);
    expect(signUpMock.mock.calls[0][0].password).toBe("  pass word  ");
  });

  // Guardrail: a raw Supabase error must never reach the UI — GoTrue
  // interpolates the submitted email into some validation messages.
  it("maps an unknown Supabase error to fixed copy and never echoes error.message", async () => {
    signUpMock.mockResolvedValue({
      data: {},
      error: { message: 'Email address "leak@example.com" is invalid', status: 400 },
    });

    const res = await POST(req(VALID_BODY));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.message).toBe("Please check your details and try again.");
    expect(JSON.stringify(body)).not.toContain("leak@example.com");
  });

  // (b) postcode format table. Note: "" is intentionally excluded here — an
  // empty postcode fails the "all fields required" check (first, in field
  // order) before the postcode regex ever runs, so it returns "All fields are
  // required.", not the postcode message. That case is already covered by the
  // required-field table above ('postcode' whitespace-only / omitted).
  describe("postcode format table", () => {
    const invalid = ["123", "12345", "VIC 3000", "abcd", "300 0"];

    for (const postcode of invalid) {
      it(`400 with the postcode message for postcode=${JSON.stringify(postcode)}`, async () => {
        const res = await POST(req({ ...VALID_BODY, postcode }));
        const body = await res.json();

        expect(res.status).toBe(400);
        expect(body.error.code).toBe("validation_failed");
        expect(body.error.message).toBe("Enter a valid 4-digit Australian postcode.");
        expect(signUpMock).not.toHaveBeenCalled();
      });
    }

    const valid = ["3000", "0800"];

    for (const postcode of valid) {
      it(`201 for a valid postcode=${JSON.stringify(postcode)}`, async () => {
        mockSuccess();

        const res = await POST(req({ ...VALID_BODY, postcode }));

        expect(res.status).toBe(201);
        expect(signUpMock).toHaveBeenCalled();
      });
    }
  });

  // (c) leading-zero postcode must survive as a string, never coerced to a number.
  it("passes a leading-zero postcode ('0800') to signUp as the string '0800'", async () => {
    mockSuccess();

    await POST(req({ ...VALID_BODY, postcode: "0800" }));

    const call = signUpMock.mock.calls[0][0];
    expect(call.options.data.postcode).toBe("0800");
    expect(typeof call.options.data.postcode).toBe("string");
  });

  // (d) trimming: every field is trimmed before it reaches signUp.
  it("trims every field before calling signUp", async () => {
    mockSuccess();

    const res = await POST(
      req({
        firstName: "  Justin  ",
        lastName: " Alpar ",
        email: " jo@example.com ",
        phone: "  +61400000000 ",
        postcode: "  3000  ",
        password: "password123",
      }),
    );

    expect(res.status).toBe(201);
    expect(signUpMock).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "jo@example.com",
        options: {
          data: {
            name: "Justin Alpar",
            first_name: "Justin",
            last_name: "Alpar",
            phone: "+61400000000",
            postcode: "3000",
          },
        },
      }),
    );
  });

  // (e) options.data shape: first_name, last_name, phone, postcode + composed name.
  it("sends first_name, last_name, phone, postcode and a composed 'First Last' name", async () => {
    mockSuccess();

    await POST(req(VALID_BODY));

    const call = signUpMock.mock.calls[0][0];
    expect(call.options.data).toEqual({
      name: "Justin Alpar",
      first_name: "Justin",
      last_name: "Alpar",
      phone: "+61400000000",
      postcode: "3000",
    });
  });

  // (f) rate limiting.
  it("returns 429 rate_limited when signUp errors with a rate-limit response", async () => {
    signUpMock.mockResolvedValue({
      data: {},
      error: { message: "email rate limit exceeded", status: 429 },
    });

    const res = await POST(req(VALID_BODY));
    const body = await res.json();

    expect(res.status).toBe(429);
    expect(body.error.code).toBe("rate_limited");
  });

  // (g) invalid email.
  it("returns 400 with the email message for an invalid email, and never calls signUp", async () => {
    const res = await POST(req({ ...VALID_BODY, email: "not-an-email" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.message).toBe("Enter a valid email address.");
    expect(signUpMock).not.toHaveBeenCalled();
  });

  // (h) the subscriber select is widened to id,first_name,last_name,name,email.
  it("selects id,first_name,last_name,name,email for the subscriber on 201", async () => {
    mockSuccess();

    await POST(req(VALID_BODY));

    // Pinned positionally, not with a bare toHaveBeenCalledWith: the mock chain
    // is shared by the app_user and subscription reads, so a loose matcher
    // would pass even if the widened select had gone to the wrong table.
    expect(fromMock.mock.calls[0][0]).toBe("app_user");
    expect(chain.select.mock.calls[0][0]).toBe("id,first_name,last_name,name,email");
    expect(fromMock.mock.calls[1][0]).toBe("subscription");
    expect(chain.select.mock.calls[1][0]).toBe("status,trial_ends_at");
  });
});
