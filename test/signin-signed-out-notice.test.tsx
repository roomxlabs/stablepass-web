// ENG-961 — the sign-in page explains an eviction instead of dumping the member
// on a bare form. Pins the reason->copy mapping and, importantly, that an
// arbitrary `?reason=` cannot plant text on the page.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SignInForm } from "@/app/signin/sign-in-form";
import { SIGNED_OUT_ELSEWHERE, SIGNED_OUT_REDIRECT, noticeForReason } from "@/lib/api/signed-out";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/supabase/client", () => ({
  supabaseBrowser: () => ({
    auth: { signInWithPassword: vi.fn(), signInWithOAuth: vi.fn() },
  }),
}));

describe("signed-out-elsewhere contract", () => {
  it("the redirect the fetch wrapper uses carries the reason the page reads", () => {
    expect(SIGNED_OUT_ELSEWHERE).toBe("signed-out-elsewhere");
    expect(SIGNED_OUT_REDIRECT).toBe(`/signin?reason=${SIGNED_OUT_ELSEWHERE}`);
  });

  it("maps our own reason to the eviction copy", () => {
    expect(noticeForReason(SIGNED_OUT_ELSEWHERE)).toMatch(/another device/i);
  });

  // The query string is attacker-controlled: it must be an ALLOW-LIST, never a
  // passthrough, or /signin?reason=<anything> becomes a text-injection surface.
  it.each([
    undefined,
    null,
    "",
    "bogus",
    "Your account was closed. Call 1-800-SCAM.",
    "<script>alert(1)</script>",
    ["signed-out-elsewhere", "x"],
  ])("renders nothing for %o", (reason) => {
    expect(noticeForReason(reason as string | string[] | undefined)).toBeNull();
  });
});

describe("SignInForm notice", () => {
  it("renders the eviction message when one is supplied", () => {
    render(<SignInForm notice="You were signed out because your account was signed in on another device." />);
    const notice = screen.getByRole("status");
    // Not `.form-error`: this is information, not a validation failure.
    expect(notice).toHaveClass("form-notice");
    expect(notice).not.toHaveClass("form-error");
    expect(notice).toHaveTextContent(/signed out/i);
    expect(notice).toHaveTextContent(/another device/i);
  });

  it("renders no notice region at all without one", () => {
    render(<SignInForm />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  // `status`, not `alert`: the notice must not masquerade as a form validation
  // error, and must not collide with the real one that appears on a failed
  // sign-in (a second role="alert" also breaks strict-mode role queries).
  it("uses role=status so it does not collide with the form error", () => {
    render(<SignInForm notice="You were signed out." />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
});
