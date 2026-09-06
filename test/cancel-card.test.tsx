import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { pushMock, refreshMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  refreshMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
}));

import { CancelCard } from "@/app/(member)/account/cancel-card";

function jsonResponse(status: number, body: unknown) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

async function openConfirm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId("cancel-open"));
}

describe("<CancelCard>", () => {
  beforeEach(() => {
    pushMock.mockClear();
    refreshMock.mockClear();
  });

  it("idle state shows the Cancel control and the end date, with no fetch fired", () => {
    global.fetch = vi.fn() as unknown as typeof fetch;
    render(<CancelCard endDate="20 September 2026" />);

    expect(screen.getByTestId("cancel-open")).toBeInTheDocument();
    expect(screen.getByText(/20 September 2026/)).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("requires the confirm step before any request: opening confirm fires no fetch, and only the confirm-submit button does", async () => {
    const fetchMock = vi.fn(() => jsonResponse(200, { data: {} }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const user = userEvent.setup();
    render(<CancelCard endDate="20 September 2026" />);

    await openConfirm(user);

    expect(screen.getByTestId("cancel-confirm")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("cancel-confirm-submit"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/subscription/cancel",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("'Keep my access' dismisses the confirm panel and fires no fetch", async () => {
    const fetchMock = vi.fn(() => jsonResponse(200, { data: {} }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const user = userEvent.setup();
    render(<CancelCard endDate="20 September 2026" />);

    await openConfirm(user);
    await user.click(screen.getByRole("button", { name: "Keep my access" }));

    expect(screen.queryByTestId("cancel-confirm")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the comment counter reads 0/500 and updates as the textarea is typed into, capped at maxLength 500", async () => {
    global.fetch = vi.fn() as unknown as typeof fetch;
    const user = userEvent.setup();
    render(<CancelCard endDate="20 September 2026" />);

    await openConfirm(user);

    expect(screen.getByTestId("cancel-reason-count")).toHaveTextContent("0/500");
    const textarea = screen.getByLabelText(/Anything you.d like to tell us/i);
    expect(textarea).toHaveAttribute("maxLength", "500");

    await user.type(textarea, "too pricey");

    expect(screen.getByTestId("cancel-reason-count")).toHaveTextContent("10/500");
  });

  it("sends a typed comment trimmed as {reason: ...}", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      return jsonResponse(200, { data: {} });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const user = userEvent.setup();
    render(<CancelCard endDate="20 September 2026" />);

    await openConfirm(user);
    await user.type(screen.getByLabelText(/Anything you.d like to tell us/i), "  too pricey  ");
    await user.click(screen.getByTestId("cancel-confirm-submit"));

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init!.body as string)).toEqual({ reason: "too pricey" });
  });

  it("sends {} (no reason key) for an empty/whitespace-only comment", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      return jsonResponse(200, { data: {} });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const user = userEvent.setup();
    render(<CancelCard endDate="20 September 2026" />);

    await openConfirm(user);
    await user.type(screen.getByLabelText(/Anything you.d like to tell us/i), "   \n\t ");
    await user.click(screen.getByTestId("cancel-confirm-submit"));

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init!.body as string);
    expect(body).toEqual({});
    expect(body).not.toHaveProperty("reason");
  });

  it("on a 200 the router's refresh is called", async () => {
    const fetchMock = vi.fn(() => jsonResponse(200, { data: {} }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const user = userEvent.setup();
    render(<CancelCard endDate="20 September 2026" />);

    await openConfirm(user);
    await user.click(screen.getByTestId("cancel-confirm-submit"));

    expect(refreshMock).toHaveBeenCalled();
  });

  it("on a 409 no_active_subscription, refresh is called and no error is shown (the screen was just stale)", async () => {
    const fetchMock = vi.fn(() =>
      jsonResponse(409, { error: { code: "no_active_subscription", message: "You don't have an active subscription to cancel." } }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const user = userEvent.setup();
    render(<CancelCard endDate="20 September 2026" />);

    await openConfirm(user);
    await user.click(screen.getByTestId("cancel-confirm-submit"));

    await vi.waitFor(() => expect(refreshMock).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("on a 500, an error message is rendered and refresh is NOT called", async () => {
    const fetchMock = vi.fn(() =>
      jsonResponse(500, { error: { code: "cancel_failed", message: "Couldn't cancel your subscription. Please try again." } }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const user = userEvent.setup();
    render(<CancelCard endDate="20 September 2026" />);

    await openConfirm(user);
    await user.click(screen.getByTestId("cancel-confirm-submit"));

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't cancel your subscription. Please try again.");
    expect(refreshMock).not.toHaveBeenCalled();
  });

  // A rejected fetch (offline, DNS failure, connection reset) is NOT an !ok
  // response — it throws. Before the try/catch this escaped as an unhandled
  // rejection, `setBusy(false)` never ran, and BOTH buttons stayed disabled
  // forever with no error shown and no way out but a reload. The !ok paths all
  // recovered correctly, which is what made the gap easy to miss.
  it("a REJECTED fetch (offline) shows an error and leaves the panel usable", async () => {
    const fetchMock = vi.fn(() => Promise.reject(new TypeError("Failed to fetch")));
    global.fetch = fetchMock as unknown as typeof fetch;
    const user = userEvent.setup();
    render(<CancelCard endDate="20 September 2026" />);

    await openConfirm(user);
    await user.click(screen.getByTestId("cancel-confirm-submit"));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    // Not wedged: the member can retry, or back out.
    expect(screen.getByTestId("cancel-confirm-submit")).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Keep my access" })).not.toBeDisabled();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  // GUARDRAIL: the comment is untrusted member text and this component never
  // reads it back — not on success, and not anywhere else on the screen. The
  // member's own textarea legitimately still HOLDS what they typed (it is
  // their own form control, unreset, and this component's parent — the
  // server component — is what removes the whole card once `router.refresh()`
  // lands and `canCancel` goes false); what must never happen is the comment
  // being echoed into any OTHER rendered element (a success message, an
  // alert, anything built from the response). So this checks the DOM with the
  // member's own textarea excluded, and that the response body is never even
  // parsed on the success path.
  it("GUARDRAIL — after a successful cancel, the typed comment is echoed nowhere except the member's own textarea", async () => {
    const jsonMock = vi.fn(async () => ({ data: {} }));
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, status: 200, json: jsonMock }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const user = userEvent.setup();
    render(<CancelCard endDate="20 September 2026" />);

    await openConfirm(user);
    await user.type(screen.getByLabelText(/Anything you.d like to tell us/i), "the app crashes constantly");
    await user.click(screen.getByTestId("cancel-confirm-submit"));

    await vi.waitFor(() => expect(refreshMock).toHaveBeenCalled());

    const withoutTextarea = document.body.cloneNode(true) as HTMLElement;
    withoutTextarea.querySelectorAll("textarea").forEach((el) => el.remove());
    expect(withoutTextarea.textContent).not.toContain("the app crashes constantly");
    // The route deliberately never echoes `cancel_reason` back, and this
    // component never reads the body on the success path to begin with.
    expect(jsonMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
