import { describe, it, expect, vi, beforeEach } from "vitest";

const signUpMock = vi.fn();
const maybeSingleMock = vi.fn();

const chain: { select: ReturnType<typeof vi.fn>; eq: ReturnType<typeof vi.fn>; maybeSingle: ReturnType<typeof vi.fn> } = {
  select: vi.fn(),
  eq: vi.fn(),
  maybeSingle: maybeSingleMock,
};
chain.select.mockImplementation(() => chain);
chain.eq.mockImplementation(() => chain);
const fromMock = vi.fn(() => chain);

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: vi.fn(async () => ({
    auth: { signUp: signUpMock },
    from: fromMock,
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

const VALID_BODY = { name: "Jo", email: "jo@example.com", phone: "+61400000000", password: "password123" };

describe("POST /api/auth/signup", () => {
  beforeEach(() => {
    signUpMock.mockReset();
    maybeSingleMock.mockReset();
    fromMock.mockClear();
  });

  it("returns 201 with the subscriber + trial subscription envelope on success", async () => {
    signUpMock.mockResolvedValue({ data: { user: { id: "u1", identities: [{}] } }, error: null });
    maybeSingleMock
      .mockResolvedValueOnce({ data: { id: "u1", name: "Jo", email: "jo@example.com" } })
      .mockResolvedValueOnce({ data: { status: "trial", trial_ends_at: "2026-08-12T00:00:00.000Z" } });

    const res = await POST(req(VALID_BODY));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data.subscription.status).toBe("trial");
    expect(body.data.subscription.trialEndsAt).toBe("2026-08-12T00:00:00.000Z");
  });

  it("returns 409 email_taken when signUp succeeds but identities is empty (duplicate)", async () => {
    signUpMock.mockResolvedValue({ data: { user: { id: "u1", identities: [] } }, error: null });

    const res = await POST(req(VALID_BODY));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.code).toBe("email_taken");
  });

  it("returns 409 email_taken when signUp errors with 'already registered'", async () => {
    signUpMock.mockResolvedValue({ data: {}, error: { message: "User already registered", status: 422 } });

    const res = await POST(req(VALID_BODY));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.code).toBe("email_taken");
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
});
