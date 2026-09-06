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

  it("renders a required email input named 'email' of type 'email', labelled and associated", () => {
    render(<WaitlistForm />);
    const email = emailInput();

    expect(email).toHaveAttribute("type", "email");
    expect(email).toHaveAttribute("name", "email");
    expect(email).toBeRequired();

    // The email input now sits inside a visible <label>Email address</label>,
    // associated via htmlFor/id rather than merely being nearby in the DOM.
    const label = screen.getByText("Email address");
    expect(label.tagName).toBe("LABEL");
    expect(label).toHaveAttribute("for", email.id);
    expect(label.getAttribute("for")).toBe(email.getAttribute("id"));
  });

  it("hides the honeypot from sight, from assistive tech, and from the tab order", async () => {
    const user = userEvent.setup();
    const { container } = render(<WaitlistForm />);

    // Named hp_ref, NOT company — see HONEYPOT_FIELD in the component. A
    // `name="company"` next to a `Company` label is Chrome Autofill's
    // canonical COMPANY_NAME shape, and Chrome ignores `autocomplete="off"`
    // for address-profile autofill: an autofilled decoy would silently drop a
    // real signup with no trace. A neutral, unlabelled name sidesteps the
    // classification entirely.
    const honeypot = container.querySelector('input[name="hp_ref"]') as HTMLInputElement;
    expect(honeypot).toBeTruthy();
    expect(container.querySelector('input[name="company"]')).toBeNull();
    expect(screen.queryByText("Company")).not.toBeInTheDocument();

    // Off-screen styling is on the INPUT itself, not a wrapper — a wrapper
    // that merely clips still leaves the input with a normal bounding box,
    // which is exactly what autofill's visibility heuristic looks at.
    expect(honeypot.style.position).toBe("absolute");
    expect(parseInt(honeypot.style.left, 10)).toBeLessThan(-1000);

    expect(honeypot.tabIndex).toBe(-1);
    expect(honeypot).toHaveAttribute("autocomplete", "off");

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

  it("shows the success message and removes the email input and submit button after an INLINE submit", async () => {
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
    // The email input is uncontrolled (no value/onChange), so the DOM simply
    // keeps what was typed — there is nothing in the component to clear it.
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
    // hp_ref, not company — the payload key follows the honeypot's new name.
    expect(JSON.parse(init?.body as string)).toEqual({ email: "a@b.co", hp_ref: "" });
  });

  it("reads the honeypot from the DOM, not from React state, so a bot that skips React's events is still caught", async () => {
    const fetchMock = mockFetch({ ok: true, json: async () => ({ data: { ok: true } }) });
    const { container } = render(<WaitlistForm />);

    typeEmail("a@b.co");

    // Assigned directly on the DOM node, bypassing React's onChange entirely —
    // this is exactly the shape of a bot that writes into a field without
    // dispatching the events React listens for. FormData(form) still picks it
    // up because it reads the live DOM, not React state.
    const honeypot = container.querySelector('input[name="hp_ref"]') as HTMLInputElement;
    honeypot.value = "Acme Corp";

    fireEvent.click(submitButton());

    await screen.findByText(SUCCESS_MESSAGE);

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init?.body as string)).toEqual({ email: "a@b.co", hp_ref: "Acme Corp" });
  });

  describe("recovers the outcome of a native round-trip from the URL", () => {
    const originalUrl = window.location.href;

    afterEach(() => {
      window.history.replaceState({}, "", originalUrl);
    });

    // URL-derived success is NOT sticky in the same way an inline submit is:
    // `?joined=1` persists across a reload, a back-navigation and a shared
    // link, so hiding the input/submit button on it would leave
    // `stablepass.co/?joined=1` permanently unusable — a form with no way to
    // join — for anyone who ever opens that URL. The success MESSAGE shows,
    // but the fields stay.
    it("shows the success message for ?joined=1, but keeps the form fields in the DOM", async () => {
      window.history.replaceState({}, "", "/?joined=1");
      const fetchMock = vi.fn();
      global.fetch = fetchMock as unknown as typeof fetch;

      render(<WaitlistForm />);

      expect(await screen.findByText(SUCCESS_MESSAGE)).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(screen.getByLabelText("Email address")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Join the waitlist" })).toBeInTheDocument();
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
  it("renders success (message only, fields remain) on the very first render when initialJoined='1' is passed, with no fetch call", () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<WaitlistForm initialJoined="1" />);

    expect(screen.getByText(SUCCESS_MESSAGE)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    // Same "not sticky" rule as the URL-derived case above — this prop-driven
    // path exists precisely so a scripting-off visitor's reload of
    // `/?joined=1` lands here, and it must not permanently strand them.
    expect(screen.getByLabelText("Email address")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Join the waitlist" })).toBeInTheDocument();
  });

  it("always renders a role=status live region, even when there is no message", () => {
    render(<WaitlistForm />);
    const status = screen.getByRole("status");

    expect(status).toBeInTheDocument();
    expect(status).toHaveTextContent("");
  });
});
