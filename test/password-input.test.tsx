// Reveal password (Naufal, 1 Sep 2026) — the shared PasswordInput behind the
// sign-in and trial-start forms: masked by default, the eye flips it to plain
// text and back, and the toggle can never submit the enclosing form.
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import PasswordInput from "@/components/password-input";

describe("PasswordInput", () => {
  it("masks by default and reveals on the eye toggle, both directions", () => {
    render(<PasswordInput id="pw" className="input" defaultValue="hunter22" />);

    const input = document.getElementById("pw") as HTMLInputElement;
    expect(input.type).toBe("password");

    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(input.type).toBe("text");

    fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
    expect(input.type).toBe("password");
  });

  it("keeps the toggle out of form submission (type=button)", () => {
    render(<PasswordInput id="pw" />);
    expect(screen.getByRole("button", { name: "Show password" }).getAttribute("type")).toBe("button");
  });
});
