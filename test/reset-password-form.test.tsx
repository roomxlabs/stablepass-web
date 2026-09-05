import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { pushMock, refreshMock, updateUserMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  refreshMock: vi.fn(),
  updateUserMock: vi.fn(async (): Promise<{ error: { message: string } | null }> => ({ error: null })),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
}));

vi.mock("@/lib/supabase/client", () => ({
  supabaseBrowser: () => ({ auth: { updateUser: updateUserMock } }),
}));

import { ResetPasswordForm } from "@/app/reset-password/reset-password-form";

describe("ResetPasswordForm", () => {
  beforeEach(() => {
    pushMock.mockClear();
    refreshMock.mockClear();
    updateUserMock.mockClear();
    updateUserMock.mockResolvedValue({ error: null });
  });

  it("shows the length error and never calls updateUser for a password shorter than 8 chars", async () => {
    const user = userEvent.setup();
    render(<ResetPasswordForm email="jo@example.com" />);

    await user.type(screen.getByLabelText("New password"), "short");
    await user.type(screen.getByLabelText("Confirm new password"), "short");
    await user.click(screen.getByRole("button", { name: "Save new password" }));

    expect(await screen.findByText("Password must be at least 8 characters.")).toBeInTheDocument();
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  it("shows the mismatch error and never calls updateUser when passwords (both >= 8 chars) differ", async () => {
    const user = userEvent.setup();
    render(<ResetPasswordForm email="jo@example.com" />);

    await user.type(screen.getByLabelText("New password"), "password123");
    await user.type(screen.getByLabelText("Confirm new password"), "password456");
    await user.click(screen.getByRole("button", { name: "Save new password" }));

    expect(
      await screen.findByText("Those passwords don't match. Please re-enter them."),
    ).toBeInTheDocument();
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  it("calls updateUser once with the password and pushes to /explore on success", async () => {
    const user = userEvent.setup();
    render(<ResetPasswordForm email="jo@example.com" />);

    await user.type(screen.getByLabelText("New password"), "password123");
    await user.type(screen.getByLabelText("Confirm new password"), "password123");
    await user.click(screen.getByRole("button", { name: "Save new password" }));

    expect(updateUserMock).toHaveBeenCalledTimes(1);
    expect(updateUserMock).toHaveBeenCalledWith({ password: "password123" });
    expect(pushMock).toHaveBeenCalledWith("/explore");
  });

  it("renders an error alert and never pushes when updateUser returns an error", async () => {
    updateUserMock.mockResolvedValue({ error: { message: "expired" } });
    const user = userEvent.setup();
    render(<ResetPasswordForm email="jo@example.com" />);

    await user.type(screen.getByLabelText("New password"), "password123");
    await user.type(screen.getByLabelText("Confirm new password"), "password123");
    await user.click(screen.getByRole("button", { name: "Save new password" }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(pushMock).not.toHaveBeenCalled();
  });
});
