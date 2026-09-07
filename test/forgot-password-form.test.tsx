import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ForgotPasswordForm } from "@/app/forgot-password/forgot-password-form";

function fetchImpl() {
  return vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ data: { sent: true } }),
    }),
  );
}

describe("ForgotPasswordForm", () => {
  beforeEach(() => {
    global.fetch = fetchImpl() as unknown as typeof fetch;
  });

  it("POSTs the submitted email to /api/auth/forgot-password", async () => {
    const fetchMock = fetchImpl();
    global.fetch = fetchMock as unknown as typeof fetch;
    const user = userEvent.setup();

    render(<ForgotPasswordForm />);
    await user.type(screen.getByLabelText("Email"), "jo@example.com");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/forgot-password",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ email: "jo@example.com" }),
      }),
    );
  });

  it("renders the 'Check your inbox.' confirmation containing the submitted email after a successful submit", async () => {
    const user = userEvent.setup();

    render(<ForgotPasswordForm />);
    await user.type(screen.getByLabelText("Email"), "jo@example.com");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));

    expect(await screen.findByText("Check your inbox.")).toBeInTheDocument();
    expect(screen.getByText("jo@example.com")).toBeInTheDocument();
  });

  it("does not assert the account exists — no enumeration-implying copy", async () => {
    const user = userEvent.setup();

    render(<ForgotPasswordForm />);
    await user.type(screen.getByLabelText("Email"), "jo@example.com");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));

    await screen.findByText("Check your inbox.");
    const text = document.body.textContent ?? "";
    expect(text).toContain("If");
    expect(text.toLowerCase()).not.toContain("we found");
    expect(text.toLowerCase()).not.toContain("no account");
    expect(text.toLowerCase()).not.toContain("not registered");
    expect(text.toLowerCase()).not.toContain("doesn't exist");
  });

  it("'Use a different email' returns to the form", async () => {
    const user = userEvent.setup();

    render(<ForgotPasswordForm />);
    await user.type(screen.getByLabelText("Email"), "jo@example.com");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));

    await screen.findByText("Check your inbox.");
    await user.click(screen.getByRole("button", { name: "Use a different email" }));

    expect(screen.getByText("Reset your password.")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
  });
});
