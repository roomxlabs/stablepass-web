import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SignInForm } from "@/app/signin/sign-in-form";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/lib/supabase/client", () => ({
  supabaseBrowser: () => ({
    auth: {
      signInWithPassword: vi.fn(async () => ({ error: null })),
      signInWithOAuth: vi.fn(async () => ({ error: null })),
    },
  }),
}));

describe("SignInForm", () => {
  it("shows email + password + sign in + Google, and never Apple/Facebook (v1 scope)", () => {
    render(<SignInForm />);

    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Continue with Google/i })).toBeInTheDocument();

    expect(screen.queryByText(/Apple/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Facebook/i)).not.toBeInTheDocument();
  });
});

// ENG-583/1. The bottom CTA sits directly under "Forgot your password?", so the
// reader is disproportionately someone who ALREADY has an account and cannot get
// in. The old copy ("Not subscribed yet? Start 30 days free") never said it
// registers a new account, and the DRI followed it into a duplicate account on a
// second email. These assertions pin the fix by intent, not by exact phrasing.
describe("sign-in bottom CTA", () => {
  const foot = (container: HTMLElement) => container.querySelector(".auth-foot") as HTMLElement;

  it("says it creates an account, before the reader clicks", () => {
    const { container } = render(<SignInForm />);
    const text = foot(container).textContent ?? "";
    expect(text).toMatch(/creat/i);
    expect(text).toMatch(/account/i);
  });

  it("keeps the 30-days-free value proposition", () => {
    const { container } = render(<SignInForm />);
    expect(foot(container).textContent ?? "").toMatch(/30 days free/i);
  });

  it("names the account creation in the LINK itself, not just the text around it", () => {
    render(<SignInForm />);
    // A screen-reader user navigating by links hears only the link's accessible
    // name. "Create one" alone would not say create *what* — the surrounding
    // "Don't have an account?" is not part of the name.
    const link = screen.getByRole("link", { name: /create an account/i });
    expect(link).toHaveAttribute("href", "/start");
  });

  it("no longer frames the link as claiming a subscription offer", () => {
    const { container } = render(<SignInForm />);
    // The exact string the DRI misread as "the way back in".
    expect(foot(container).textContent ?? "").not.toMatch(/not subscribed yet/i);
  });

  it("never implies the pass renews (the 30-day pass does not auto-renew)", () => {
    const { container } = render(<SignInForm />);
    expect(foot(container).textContent ?? "").not.toMatch(
      /renew|recurring|per month|\/mo|subscription auto/i,
    );
  });

  it("keeps the forgot-password route distinct from the create-account route", () => {
    render(<SignInForm />);
    // The two must remain separately addressable — conflating them is the bug.
    expect(screen.getByRole("link", { name: /forgot your password/i })).toHaveAttribute(
      "href",
      "/forgot-password",
    );
  });
});
