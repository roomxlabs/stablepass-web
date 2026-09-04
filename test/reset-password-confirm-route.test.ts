import { describe, it, expect, vi, beforeEach } from "vitest";

const exchangeCodeForSessionMock = vi.fn();
const verifyOtpMock = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: vi.fn(async () => ({
    auth: {
      exchangeCodeForSession: exchangeCodeForSessionMock,
      verifyOtp: verifyOtpMock,
    },
  })),
}));

import { GET } from "@/app/reset-password/confirm/route";
import { RECOVERY_COOKIE } from "@/app/reset-password/recovery-cookie";

const call = (query: string) =>
  GET(new Request(`http://localhost/reset-password/confirm${query}`));

const location = (res: Response) => {
  const raw = res.headers.get("location")!;
  const url = new URL(raw);
  return `${url.pathname}${url.search}`;
};

describe("GET /reset-password/confirm", () => {
  beforeEach(() => {
    exchangeCodeForSessionMock.mockReset().mockResolvedValue({ data: {}, error: null });
    verifyOtpMock.mockReset().mockResolvedValue({ data: {}, error: null });
  });

  describe("PKCE ?code= links", () => {
    it("exchanges a good code and returns to a URL with no secret in it", async () => {
      const res = await call("?code=good");
      expect(res.status).toBeGreaterThanOrEqual(300);
      expect(res.status).toBeLessThan(400);
      // The whole point of the extra hop: the member types their new password
      // on a URL that no longer carries the recovery secret.
      expect(location(res)).toBe("/reset-password");
      expect(exchangeCodeForSessionMock).toHaveBeenCalledWith("good");
    });

    // A failed exchange is overwhelmingly the missing-verifier case: the link
    // was opened on a different device from the one that requested it. Calling
    // that "expired" sends the member round a loop that can never succeed.
    it("sends a device-bound failure to advice it can act on, not to 'expired'", async () => {
      exchangeCodeForSessionMock.mockResolvedValue({
        data: null,
        error: { message: "invalid request: both auth code and code verifier should be non-empty" },
      });
      const res = await call("?code=bad");
      expect(location(res)).toBe("/reset-password?state=devicemismatch");
    });
  });

  describe("verifier-free ?token_hash= links (the cross-device shape)", () => {
    it("verifies a recovery token and returns to a clean URL", async () => {
      const res = await call("?token_hash=abc&type=recovery");
      expect(verifyOtpMock).toHaveBeenCalledWith({ token_hash: "abc", type: "recovery" });
      expect(location(res)).toBe("/reset-password");
    });

    it("treats a bad token as invalid", async () => {
      verifyOtpMock.mockResolvedValue({ data: null, error: { message: "expired" } });
      const res = await call("?token_hash=abc&type=recovery");
      expect(location(res)).toBe("/reset-password?state=invalid");
    });

    // Token-type smuggling. A signup / magiclink / email_change token is issued
    // in a context that never intended to authorise a password change, so it
    // must not be spendable here even though GoTrue would happily verify it.
    for (const type of ["signup", "magiclink", "email_change", "invite", ""]) {
      it(`refuses to spend a '${type || "(empty)"}' token`, async () => {
        const res = await call(`?token_hash=abc&type=${type}`);
        expect(verifyOtpMock).not.toHaveBeenCalled();
        expect(location(res)).toBe("/reset-password?state=invalid");
      });
    }
  });

  describe("failure shapes", () => {
    it("honours Supabase's own error redirect without calling anything", async () => {
      const res = await call("?error=access_denied&error_code=otp_expired");
      expect(exchangeCodeForSessionMock).not.toHaveBeenCalled();
      expect(verifyOtpMock).not.toHaveBeenCalled();
      expect(location(res)).toBe("/reset-password?state=invalid");
    });

    it("treats an empty query as invalid", async () => {
      const res = await call("");
      expect(location(res)).toBe("/reset-password?state=invalid");
    });
  });

  // ── The gate this route exists to arm ─────────────────────────────────────
  //
  // `updateUser({ password })` needs no current password, so "is there a
  // session" is NOT a safe gate for the reset form. This cookie is what marks a
  // session as recovery-verified; without it the form must not render.
  describe("the recovery marker cookie", () => {
    it("is set, httpOnly and short-lived, only on success", async () => {
      const res = await call("?token_hash=abc&type=recovery");
      const cookie = res.cookies.get(RECOVERY_COOKIE);
      expect(cookie?.value).toBe("1");
      expect(cookie?.httpOnly).toBe(true);
      expect(cookie?.maxAge).toBeGreaterThan(0);
      expect(cookie?.maxAge).toBeLessThanOrEqual(15 * 60);
      // Never sent on any other request.
      expect(cookie?.path).toBe("/reset-password");
    });

    it("is NOT set when the link fails", async () => {
      verifyOtpMock.mockResolvedValue({ data: null, error: { message: "expired" } });
      const res = await call("?token_hash=abc&type=recovery");
      expect(res.cookies.get(RECOVERY_COOKIE)).toBeUndefined();
    });

    it("is NOT set for a device-mismatched code", async () => {
      exchangeCodeForSessionMock.mockResolvedValue({ data: null, error: { message: "no verifier" } });
      const res = await call("?code=bad");
      expect(res.cookies.get(RECOVERY_COOKIE)).toBeUndefined();
    });
  });
});
