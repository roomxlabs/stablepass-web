import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// The security decision for the whole ticket lives in this page, and it had no
// test at all until three independent reviews reproduced the same takeover
// through it. These are the tests that pin it shut.

const getUserMock = vi.fn();
const cookieGetMock = vi.fn();
const redirectMock = vi.fn(() => {
  // Next's real `redirect()` throws to unwind the render.
  throw new Error("NEXT_REDIRECT");
});

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: vi.fn(async () => ({ auth: { getUser: getUserMock } })),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: cookieGetMock })),
}));

vi.mock("next/navigation", () => ({
  redirect: (...args: unknown[]) => redirectMock(...(args as [])),
  // The page renders ResetPasswordForm in the happy path, and that client
  // component calls useRouter.
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/lib/supabase/client", () => ({
  supabaseBrowser: () => ({ auth: { updateUser: vi.fn() } }),
}));

import ResetPasswordPage from "@/app/reset-password/page";
import { RECOVERY_COOKIE } from "@/app/reset-password/recovery-cookie";

const SIGNED_IN = { data: { user: { id: "u1", email: "member@example.com" } } };
const SIGNED_OUT = { data: { user: null } };

const recoveryCookiePresent = (present: boolean) =>
  cookieGetMock.mockImplementation((name: string) =>
    present && name === RECOVERY_COOKIE ? { value: "1" } : undefined,
  );

async function renderPage(params: Record<string, string> = {}) {
  const ui = await ResetPasswordPage({ searchParams: Promise.resolve(params) });
  render(ui);
}

describe("/reset-password", () => {
  beforeEach(() => {
    getUserMock.mockReset().mockResolvedValue(SIGNED_OUT);
    cookieGetMock.mockReset().mockReturnValue(undefined);
    redirectMock.mockClear();
  });

  // ── THE ONE THAT MATTERS ──────────────────────────────────────────────────
  //
  // A plain password-login session must NOT be able to set a new password here.
  // `updateUser` asks for no current password, so allowing this would turn the
  // screen into an unauthenticated account takeover for anyone with a live
  // session — and because a new sign-in revokes the others (guardrail #5), the
  // real member is locked out silently.
  it("does NOT show the form to a merely signed-in visitor", async () => {
    getUserMock.mockResolvedValue(SIGNED_IN);
    recoveryCookiePresent(false);

    await renderPage();

    expect(screen.queryByRole("heading", { name: "Set a new password." })).toBeNull();
    expect(screen.getByRole("heading", { name: "This link has expired." })).toBeTruthy();
  });

  it("shows the form only when the session is recovery-verified", async () => {
    getUserMock.mockResolvedValue(SIGNED_IN);
    recoveryCookiePresent(true);

    await renderPage();

    expect(screen.getByRole("heading", { name: "Set a new password." })).toBeTruthy();
  });

  it("does not show the form for a recovery cookie with no session behind it", async () => {
    getUserMock.mockResolvedValue(SIGNED_OUT);
    recoveryCookiePresent(true);

    await renderPage();

    expect(screen.queryByRole("heading", { name: "Set a new password." })).toBeNull();
  });

  it("hands a recovery secret to the confirm handler rather than rendering", async () => {
    await expect(renderPage({ code: "abc" })).rejects.toThrow("NEXT_REDIRECT");
    expect(redirectMock).toHaveBeenCalledWith("/reset-password/confirm?code=abc");
  });

  it("forwards a token_hash recovery link to the confirm handler", async () => {
    await expect(
      renderPage({ token_hash: "xyz", type: "recovery" }),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(redirectMock).toHaveBeenCalledWith(
      "/reset-password/confirm?token_hash=xyz&type=recovery",
    );
  });

  it("does not forward a non-recovery token type", async () => {
    recoveryCookiePresent(false);
    await renderPage({ token_hash: "xyz", type: "signup" });
    expect(redirectMock).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "This link has expired." })).toBeTruthy();
  });

  it("explains a device-bound link instead of calling it expired", async () => {
    await renderPage({ state: "devicemismatch" });
    expect(
      screen.getByRole("heading", { name: "Open this link where you asked for it." }),
    ).toBeTruthy();
  });

  it("shows the expired screen for Supabase's own error redirect", async () => {
    getUserMock.mockResolvedValue(SIGNED_IN);
    recoveryCookiePresent(true);

    await renderPage({ error: "access_denied", error_code: "otp_expired" });

    // Even recovery-verified, an explicit error wins — no form.
    expect(screen.queryByRole("heading", { name: "Set a new password." })).toBeNull();
    expect(screen.getByRole("heading", { name: "This link has expired." })).toBeTruthy();
  });

  it("offers a way to get a fresh link from the expired screen", async () => {
    await renderPage({ state: "invalid" });
    const cta = screen.getByRole("link", { name: "Send me a new link" });
    expect(cta.getAttribute("href")).toBe("/forgot-password");
  });

  it("takes the first value when a parameter is repeated", async () => {
    await expect(renderPage({ code: ["a", "b"] as unknown as string })).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(redirectMock).toHaveBeenCalledWith("/reset-password/confirm?code=a");
  });
});
