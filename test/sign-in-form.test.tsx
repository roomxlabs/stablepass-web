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
