import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import WaitlistForm from "@/app/(marketing)/waitlist-form";

const SUCCESS_MESSAGE = "You're on the list. We'll email you the moment we open.";
const EMAIL_MESSAGE = "Enter a valid email address.";
const SERVER_MESSAGE = "Something went wrong. Please try again.";

// The params are declared (rather than a bare `() => ...`) so `mock.calls[0]`
// types as a tuple under `tsc --noEmit` — the same reason checkout-form.test.tsx
// and trial-start-form.test.tsx declare their fetch mocks this way.
function mockFetch(response: { ok: boolean; status?: number; json: () => Promise<unknown> }) {
  const fetchMock = vi.fn((_input?: string | URL, _init?: RequestInit) => Promise.resolve(response));
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function emailInput(): HTMLInputElement {
  return screen.getByLabelText("Email address") as HTMLInputElement;
}

function submitButton() {
  return screen.getByRole("button", { name: "Join the waitlist" });
}

function typeEmail(value: string) {
  fireEvent.change(emailInput(), { target: { value } });
}

describe("WaitlistForm", () => {
  // THE SINGLE MOST IMPORTANT ASSERTION IN THIS FILE. Justin reviews the site
  // on a phone with JS blocked, so a real <form method="post" action="/api/
  // waitlist"> is the load-bearing path — the fetch/onSubmit interception below
  // is the enhancement, not the other way around. If this regresses to a plain
  // <div> or drops the action/method, the no-JS visitor gets nothing at all.
  it("renders a real <form method=post action=/api/waitlist> — the no-JS contract", () => {
    const { container } = render(<WaitlistForm />);
    const form = container.querySelector("form");

    expect(form).not.toBeNull();
    expect(form!.getAttribute("method")?.toLowerCase()).toBe("post");
    expect(form!.getAttribute("action")).toBe("/api/waitlist");
  });

  it("renders a required email input named 'email' of type 'email'", () => {
    render(<WaitlistForm />);
    const email = emailInput();

    expect(email).toHaveAttribute("type", "email");
    expect(email).toHaveAttribute("name", "email");
    expect(email).toBeRequired();
  });

  it("hides the honeypot from sight, from assistive tech, and from the tab order", async () => {
    const user = userEvent.setup();
    const { container } = render(<WaitlistForm />);

    const honeypot = container.querySelector('input[name="company"]') as HTMLInputElement;
    expect(honeypot).toBeTruthy();

    const wrapper = honeypot.closest("div");
    expect(wrapper).toHaveAttribute("aria-hidden", "true");
    expect(honeypot.tabIndex).toBe(-1);

    // Not focusable in the tab order: from the email input, Tab must land on
    // the submit button, never on the honeypot in between.
    emailInput().focus();
    expect(document.activeElement).toBe(emailInput());
    await user.tab();
    expect(document.activeElement).not.toBe(honeypot);
    expect(document.activeElement).toBe(submitButton());
  });

  it("renders a submit button labelled 'Join the waitlist'", () => {
    render(<WaitlistForm />);
    const button = submitButton();

    expect(button).toHaveAttribute("type", "submit");
  });

  it("shows the success message and removes the email input and submit button after a successful submit", async () => {
    mockFetch({ ok: true, json: async () => ({ data: { ok: true } }) });
    render(<WaitlistForm />);

    typeEmail("a@b.co");
    fireEvent.click(submitButton());

    expect(await screen.findByText(SUCCESS_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByLabelText("Email address")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Join the waitlist" })).not.toBeInTheDocument();
  });

  it("shows the loading state while the request is in flight, then resolves to success", async () => {
    let resolveFetch!: (value: { ok: boolean; json: () => Promise<unknown> }) => void;
    global.fetch = vi.fn(
      () => new Promise((resolve) => { resolveFetch = resolve; }),
    ) as unknown as typeof fetch;

    render(<WaitlistForm />);
    typeEmail("a@b.co");
    fireEvent.click(submitButton());

    const loadingButton = await screen.findByRole("button", { name: "Joining…" });
    expect(loadingButton).toBeDisabled();
    expect(emailInput()).toBeDisabled();

    resolveFetch({ ok: true, json: async () => ({ data: { ok: true } }) });

    expect(await screen.findByText(SUCCESS_MESSAGE)).toBeInTheDocument();
  });

  it("keeps the typed email and shows the email message on a 400 invalid_email response", async () => {
    mockFetch({
      ok: false,
      status: 400,
      json: async () => ({ error: { code: "invalid_email", message: EMAIL_MESSAGE } }),
    });
    render(<WaitlistForm />);

    // "a@b" rather than "nope": the <form> has no `noValidate`, so a value the
    // browser's own type="email" constraint rejects outright (anything with no
    // "@" at all) never reaches onSubmit — jsdom enforces this exactly as a
    // real browser does. "a@b" is well-formed enough to pass that native check
    // (it has an "@" and a domain label) while still failing the route's
    // stricter EMAIL_RE (which requires a dot), so it is what actually reaches
    // the fetch/400 path this test means to exercise. See the report to the
    // worker: ticket text specified "nope", which is blocked before JS runs.
    typeEmail("a@b");
    fireEvent.click(submitButton());

    expect(await screen.findByText(EMAIL_MESSAGE)).toBeInTheDocument();
    expect(emailInput()).toHaveValue("a@b");
    expect(screen.getByLabelText("Email address")).toBeInTheDocument();
  });

  it("keeps the typed email and shows the generic message on a 500 response", async () => {
    mockFetch({
      ok: false,
      status: 500,
      json: async () => ({ error: { code: "waitlist_failed" } }),
    });
    render(<WaitlistForm />);

    typeEmail("a@b.co");
    fireEvent.click(submitButton());

    expect(await screen.findByText(SERVER_MESSAGE)).toBeInTheDocument();
    expect(emailInput()).toHaveValue("a@b.co");
  });

  it("falls back to the generic message and does not throw when fetch itself rejects", async () => {
    global.fetch = vi.fn(() => Promise.reject(new Error("network down"))) as unknown as typeof fetch;
    render(<WaitlistForm />);

    typeEmail("a@b.co");
    expect(() => fireEvent.click(submitButton())).not.toThrow();

    expect(await screen.findByText(SERVER_MESSAGE)).toBeInTheDocument();
    expect(emailInput()).toHaveValue("a@b.co");
  });

  it("posts JSON to /api/waitlist with the accept header that selects the JSON envelope over the 303 branch", async () => {
    const fetchMock = mockFetch({ ok: true, json: async () => ({ data: { ok: true } }) });
    render(<WaitlistForm />);

    typeEmail("a@b.co");
    fireEvent.click(submitButton());

    await screen.findByText(SUCCESS_MESSAGE);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/waitlist");
    expect(init?.method).toBe("POST");
    // The route negotiates the dialect on this header (route.ts's wantsJson()):
    // without it the request would fall through to the 303 form-dialect branch.
    expect((init?.headers as Record<string, string>).accept).toBe("application/json");
    expect(JSON.parse(init?.body as string)).toEqual({ email: "a@b.co", company: "" });
  });

  it("reads the honeypot from the DOM, not from React state, so a bot that skips React's events is still caught", async () => {
    const fetchMock = mockFetch({ ok: true, json: async () => ({ data: { ok: true } }) });
    const { container } = render(<WaitlistForm />);

    typeEmail("a@b.co");

    // Assigned directly on the DOM node, bypassing React's onChange entirely —
    // this is exactly the shape of a bot that writes into a field without
    // dispatching the events React listens for. FormData(form) still picks it
    // up because it reads the live DOM, not React state.
    const honeypot = container.querySelector('input[name="company"]') as HTMLInputElement;
    honeypot.value = "Acme Corp";

    fireEvent.click(submitButton());

    await screen.findByText(SUCCESS_MESSAGE);

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init?.body as string)).toEqual({ email: "a@b.co", company: "Acme Corp" });
  });

  describe("recovers the outcome of a native round-trip from the URL", () => {
    const originalUrl = window.location.href;

    afterEach(() => {
      window.history.replaceState({}, "", originalUrl);
    });

    it("shows success for ?joined=1 with no fetch call at all", async () => {
      window.history.replaceState({}, "", "/?joined=1");
      const fetchMock = vi.fn();
      global.fetch = fetchMock as unknown as typeof fetch;

      render(<WaitlistForm />);

      expect(await screen.findByText(SUCCESS_MESSAGE)).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("shows the email-validation message for ?joined=0&reason=email", async () => {
      window.history.replaceState({}, "", "/?joined=0&reason=email");
      render(<WaitlistForm />);

      expect(await screen.findByText(EMAIL_MESSAGE)).toBeInTheDocument();
    });

    it("shows the generic message for ?joined=0&reason=server", async () => {
      window.history.replaceState({}, "", "/?joined=0&reason=server");
      render(<WaitlistForm />);

      expect(await screen.findByText(SERVER_MESSAGE)).toBeInTheDocument();
    });
  });

  // The seam that lets W3/ENG-729 render the success state SERVER-side for
  // scripting-off visitors: a statically prerendered `/` cannot vary on its own
  // query string, so recovering `?joined=1` from `window.location` (above)
  // completes the round-trip only for a client that ran JS to read the URL.
  // Whoever mounts this from a server component that reads `searchParams` can
  // instead pass the answer straight through as a prop, and it must win on the
  // very first render — before any effect could matter — with no fetch calls.
  it("renders success on the very first render when initialJoined='1' is passed, with no fetch call", () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<WaitlistForm initialJoined="1" />);

    expect(screen.getByText(SUCCESS_MESSAGE)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("always renders a role=status live region, even when there is no message", () => {
    render(<WaitlistForm />);
    const status = screen.getByRole("status");

    expect(status).toBeInTheDocument();
    expect(status).toHaveTextContent("");
  });
});
