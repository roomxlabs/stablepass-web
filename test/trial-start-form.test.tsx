import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { pushMock, refreshMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  refreshMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
}));

import { TrialStartForm } from "@/app/start/trial-start-form";

const VALID = {
  "First name": "Justin",
  "Last name": "Alpar",
  Email: "jo@example.com",
  Phone: "+61 400 000 000",
  Postcode: "3000",
  Password: "password123",
} as const;

// fireEvent.change (not userEvent.type) throughout: the postcode input carries
// maxLength={4} per the mockup, so typing can never produce a 5-character value.
// Setting it directly is also the honest simulation of paste / browser autofill
// / any non-browser client — the paths where an over-long value really arrives.
function fill(overrides: Partial<Record<keyof typeof VALID, string>> = {}) {
  const values = { ...VALID, ...overrides };
  for (const [label, value] of Object.entries(values)) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }
}

function submit() {
  fireEvent.click(screen.getByRole("button", { name: "Start free trial" }));
}

function mockFetch(status: number, body: unknown = {}) {
  const fetchMock = vi.fn((_input?: string | URL, _init?: RequestInit) =>
    Promise.resolve({ ok: status < 400, status, json: async () => body }),
  );
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe("TrialStartForm", () => {
  beforeEach(() => {
    pushMock.mockClear();
    refreshMock.mockClear();
  });

  it("renders the six fields in order: first, last, email, phone, postcode, password", () => {
    const { container } = render(<TrialStartForm />);

    const ids = Array.from(container.querySelectorAll("input")).map((i) => i.id);
    expect(ids).toEqual(["first-name", "last-name", "email", "phone", "postcode", "password"]);

    for (const label of Object.keys(VALID)) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
  });

  it("uses the correct autoComplete token on every field", () => {
    render(<TrialStartForm />);

    const expected: Record<string, string> = {
      "First name": "given-name",
      "Last name": "family-name",
      Email: "email",
      Phone: "tel",
      Postcode: "postal-code",
      Password: "new-password",
    };

    for (const [label, token] of Object.entries(expected)) {
      expect(screen.getByLabelText(label).getAttribute("autocomplete")).toBe(token);
    }
  });

  // Regression pin: a number input silently drops the leading zero of '0800'
  // (a real NT postcode) and renders a spinner. It must stay type="text".
  it("renders postcode as a text input with numeric inputmode, never type=number", () => {
    render(<TrialStartForm />);

    const postcode = screen.getByLabelText("Postcode");
    expect(postcode.getAttribute("type")).toBe("text");
    expect(postcode.getAttribute("inputmode")).toBe("numeric");
    expect(postcode.getAttribute("maxlength")).toBe("4");
  });

  it("shows the postcode error without any network call when the postcode is too short", async () => {
    const fetchMock = mockFetch(201);
    render(<TrialStartForm />);

    fill({ Postcode: "123" });
    submit();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter a valid 4-digit Australian postcode.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the postcode error without any network call when the postcode is too long", async () => {
    const fetchMock = mockFetch(201);
    render(<TrialStartForm />);

    fill({ Postcode: "12345" });
    submit();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter a valid 4-digit Australian postcode.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric postcode without a network call", async () => {
    const fetchMock = mockFetch(201);
    render(<TrialStartForm />);

    fill({ Postcode: "VIC " });
    submit();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter a valid 4-digit Australian postcode.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires every field — a blank last name blocks submission with no network call", async () => {
    const fetchMock = mockFetch(201);
    render(<TrialStartForm />);

    fill({ "Last name": "   " });
    submit();

    expect(await screen.findByRole("alert")).toHaveTextContent("All fields are required.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // 8 spaces satisfies the length rule, so it must be caught as a BLANK field.
  it("treats an all-whitespace password as a missing field, with no network call", async () => {
    const fetchMock = mockFetch(201);
    render(<TrialStartForm />);

    fill({ Password: "        " });
    submit();

    expect(await screen.findByRole("alert")).toHaveTextContent("All fields are required.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid email without a network call", async () => {
    const fetchMock = mockFetch(201);
    render(<TrialStartForm />);

    fill({ Email: "not-an-email" });
    submit();

    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a valid email address.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the six-field payload to /api/auth/signup and routes to onboarding on 201", async () => {
    const fetchMock = mockFetch(201, { data: {} });
    render(<TrialStartForm />);

    fill();
    submit();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/auth/signup");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      firstName: "Justin",
      lastName: "Alpar",
      email: "jo@example.com",
      phone: "+61 400 000 000",
      postcode: "3000",
      password: "password123",
    });

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/onboarding"));
  });

  // '  3000  ' is what a real member types; it fails the app_user_postcode_au
  // CHECK constraint verbatim, so the client trims before it ever leaves.
  it("trims values before posting them", async () => {
    const fetchMock = mockFetch(201, { data: {} });
    render(<TrialStartForm />);

    fill({ "First name": "  Justin  ", Postcode: "  3000  ", Email: "  jo@example.com " });
    submit();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.firstName).toBe("Justin");
    expect(body.postcode).toBe("3000");
    expect(body.email).toBe("jo@example.com");
  });

  it("keeps a leading-zero postcode intact ('0800' must not become 800)", async () => {
    const fetchMock = mockFetch(201, { data: {} });
    render(<TrialStartForm />);

    fill({ Postcode: "0800" });
    submit();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.postcode).toBe("0800");
    expect(typeof body.postcode).toBe("string");
  });

  it("renders the duplicate-email copy on 409", async () => {
    mockFetch(409, { error: { code: "email_taken", message: "That email is already registered." } });
    render(<TrialStartForm />);

    fill();
    submit();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That email is already registered. Try signing in instead.",
    );
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("renders the rate-limit copy on 429", async () => {
    mockFetch(429, { error: { code: "rate_limited", message: "Too many attempts." } });
    render(<TrialStartForm />);

    fill();
    submit();

    expect(await screen.findByRole("alert")).toHaveTextContent("Too many attempts");
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("disables the button and shows the busy label while the request is in flight", async () => {
    global.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;
    render(<TrialStartForm />);

    fill();
    submit();

    const busy = await screen.findByRole("button", { name: "Starting your trial…" });
    expect(busy).toBeDisabled();
  });

  // Guardrail: the password is only ever POSTed to our own route. It must never
  // be rendered back into the DOM or end up in a URL.
  it("never renders the password value or puts it in the request URL", async () => {
    const fetchMock = mockFetch(201, { data: {} });
    const { container } = render(<TrialStartForm />);

    fill();
    submit();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const passwordInput = screen.getByLabelText("Password") as HTMLInputElement;

    // Positive control first: the password really was entered, so the negative
    // assertions below cannot pass just because the form was empty.
    expect(passwordInput.value).toBe("password123");

    // Never in the URL — it belongs in the POST body and nowhere else.
    expect(String(fetchMock.mock.calls[0][0])).not.toContain("password123");

    // The field itself stays masked.
    expect(passwordInput.getAttribute("type")).toBe("password");

    // It must not surface anywhere OUTSIDE that masked input — not in rendered
    // text, and not carried by any other field. (The password input's own value
    // is naturally in the DOM; that is what a password field is. The leak this
    // guards against is it being echoed into an error message or a sibling
    // input, which is exactly what mapping Supabase errors to fixed copy avoids.)
    expect(container.textContent).not.toContain("password123");
    const otherValues = Array.from(container.querySelectorAll("input"))
      .filter((i) => i !== passwordInput)
      .map((i) => (i as HTMLInputElement).value);
    expect(otherValues).not.toContain("password123");
  });
});
