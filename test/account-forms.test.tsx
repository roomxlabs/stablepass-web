import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { pushMock, refreshMock, signOutMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  refreshMock: vi.fn(),
  signOutMock: vi.fn(async () => ({ error: null })),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
}));

vi.mock("@/lib/supabase/client", () => ({
  supabaseBrowser: () => ({ auth: { signOut: signOutMock } }),
}));

import { AccountForms, type AccountPrefs, type AccountSubscriber } from "@/app/(member)/account/account-forms";

const SUBSCRIBER: AccountSubscriber = { name: "Justin Alpar", email: "you@stablepass.co", phone: "+61 431 581 526" };
const PREFS: AccountPrefs = { newPost: true, raceDay: true, raceResult: false, milestone: false };

function fetchImpl() {
  return vi.fn((_input: string | URL, init?: RequestInit) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ data: { subscriber: SUBSCRIBER, prefs: PREFS } }),
      _init: init,
    }),
  );
}

describe("AccountForms", () => {
  beforeEach(() => {
    pushMock.mockClear();
    refreshMock.mockClear();
    signOutMock.mockClear();
  });

  it("renders exactly 4 notification toggles and no Devices / Sign out everywhere text", () => {
    global.fetch = fetchImpl() as unknown as typeof fetch;
    render(<AccountForms initialSubscriber={SUBSCRIBER} initialPrefs={PREFS} />);

    expect(screen.getAllByRole("switch")).toHaveLength(4);
    expect(screen.getByText("New posts")).toBeInTheDocument();
    expect(screen.getByText("Race day")).toBeInTheDocument();
    expect(screen.getByText("Race results")).toBeInTheDocument();
    expect(screen.getByText("Milestones")).toBeInTheDocument();

    expect(screen.queryByText(/devices/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/sign out everywhere/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("toggling a notification pref PATCHes /api/me with just that pref", async () => {
    const fetchMock = fetchImpl();
    global.fetch = fetchMock as unknown as typeof fetch;
    const user = userEvent.setup();

    render(<AccountForms initialSubscriber={SUBSCRIBER} initialPrefs={PREFS} />);

    const raceDayToggle = screen.getByRole("switch", { name: "Race day" });
    expect(raceDayToggle).toHaveAttribute("aria-checked", "true");

    await user.click(raceDayToggle);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/me",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ prefs: { raceDay: false } }),
      }),
    );
    expect(raceDayToggle).toHaveAttribute("aria-checked", "false");
  });

  it("Save PATCHes /api/me with the edited name/phone", async () => {
    const fetchMock = fetchImpl();
    global.fetch = fetchMock as unknown as typeof fetch;
    const user = userEvent.setup();

    render(<AccountForms initialSubscriber={SUBSCRIBER} initialPrefs={PREFS} />);

    const nameInput = screen.getByLabelText("Name");
    await user.clear(nameInput);
    await user.type(nameInput, "Justin A.");
    const phoneInput = screen.getByLabelText("Phone");
    await user.clear(phoneInput);
    await user.type(phoneInput, "+61 400 000 000");

    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/me",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ name: "Justin A.", phone: "+61 400 000 000" }),
      }),
    );
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
  });

  it("shows the read-only email and never a Devices card", () => {
    global.fetch = fetchImpl() as unknown as typeof fetch;
    render(<AccountForms initialSubscriber={SUBSCRIBER} initialPrefs={PREFS} />);

    expect(screen.getByText("you@stablepass.co")).toBeInTheDocument();
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
  });

  it("Sign out calls supabaseBrowser signOut and redirects to /signin", async () => {
    global.fetch = fetchImpl() as unknown as typeof fetch;
    const user = userEvent.setup();
    render(<AccountForms initialSubscriber={SUBSCRIBER} initialPrefs={PREFS} />);

    await user.click(screen.getByRole("button", { name: "Sign out" }));

    expect(signOutMock).toHaveBeenCalled();
    expect(pushMock).toHaveBeenCalledWith("/signin");
    expect(refreshMock).toHaveBeenCalled();
  });
});
