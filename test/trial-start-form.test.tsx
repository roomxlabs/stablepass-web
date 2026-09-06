import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { pushMock, refreshMock, replaceMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  refreshMock: vi.fn(),
  // ENG-763: the repeat-signup wall is a NAVIGATION, not a local state swap.
  replaceMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock, replace: replaceMock }),
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
  fireEvent.click(screen.getByRole("button", { name: "Create account" }));
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
    replaceMock.mockClear();
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

  // Regression pin (ENG-598): the three links are next/link `<Link>`, which
  // renders a plain `<a>` — so this asserts the rendered hrefs, not the JSX.
  //
  // The hrefs are root-relative ON PURPOSE. `/legal/*` is served on BOTH the
  // marketing host and the app host (ENG-590 decision 1, encoded in
  // middleware.ts's `isSharedPath`), which is what lets them resolve from
  // app.stablepass.co with no edit. Absolutising them, or normalising a
  // trailing slash onto them, silently breaks one of the two hosts — and
  // nothing else in the suite covers these three links.
  it("links to /legal/terms, /legal/privacy and /signin with root-relative hrefs", () => {
    const { container } = render(<TrialStartForm />);

    const hrefs = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/legal/terms", "/legal/privacy", "/signin"]);
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

  it("posts the six-field payload to /api/auth/signup and routes to checkout on 201", async () => {
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

    // ENG-1003: the account holds no access until Stripe says otherwise, so a
    // fresh signup goes to /checkout now, never /onboarding.
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/checkout"));
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

  // ---- the duplicate-email response (ENG-1003) ------------------------------
  // The trial is retired, so a repeat signup is no longer a dead end that walls
  // the member off to a separate URL — it falls straight through to the
  // generic `setError` path and renders the route's own message inline, right
  // next to the "Already a member? Sign in" link already at the foot of the
  // form. There is deliberately no dedicated code branch for `account_exists`.
  describe("duplicate account (409 account_exists)", () => {
    const ACCOUNT_EXISTS = {
      error: {
        code: "account_exists",
        message: "You already have an account with that email — sign in to continue.",
      },
    };

    it("renders the route's message inline in .form-error and does not navigate", async () => {
      const fetchMock = mockFetch(409, ACCOUNT_EXISTS);
      render(<TrialStartForm />);

      fill();
      submit();

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(
        "You already have an account with that email — sign in to continue.",
      );
      expect(pushMock).not.toHaveBeenCalled();
      expect(replaceMock).not.toHaveBeenCalled();
    });
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

    const busy = await screen.findByRole("button", { name: "Creating your account…" });
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

  // The `.trial-banner-web` block above the fields was dropped on client
  // instruction (17 Aug 2026), before the trial itself was retired (ENG-1003).
  // Both reasons now hold, so this pins the class's absence permanently.
  it("does not render the trial banner", () => {
    const { container } = render(<TrialStartForm />);

    expect(container.querySelector(".trial-banner-web")).toBeNull();
  });

  // ENG-1003 retired the trial from this screen entirely: no pitch, no
  // duration, nothing left to advertise here — the price is quoted at
  // /checkout, from Stripe.
  it("carries no trial or '30 days' copy anywhere in the form", () => {
    const { container } = render(<TrialStartForm />);

    expect(container.textContent ?? "").not.toMatch(/trial/i);
    expect(container.textContent ?? "").not.toMatch(/30 days/i);
  });

  // The placeholders used to read 'Justin' / 'Alpar' — the client's own name.
  it("uses neutral sample placeholders, not a real person's name", () => {
    render(<TrialStartForm />);

    const placeholders: Record<string, string> = {
      "First name": "John",
      "Last name": "Smith",
      Phone: "+61 412 345 678",
    };

    for (const [label, value] of Object.entries(placeholders)) {
      expect(screen.getByLabelText(label)).toHaveAttribute("placeholder", value);
    }
  });
});

describe("TrialStartForm — Australian phone formatting", () => {
  function phone() {
    return screen.getByLabelText("Phone") as HTMLInputElement;
  }

  function typePhone(value: string) {
    fireEvent.change(phone(), { target: { value } });
    return phone().value;
  }

  it.each([
    ["a local mobile", "0412345678", "+61 412 345 678"],
    ["a mobile with no trunk zero", "412345678", "+61 412 345 678"],
    ["an already-international mobile", "+61412345678", "+61 412 345 678"],
    ["a bare country code", "61412345678", "+61 412 345 678"],
    ["an IDD-prefixed mobile", "0061412345678", "+61 412 345 678"],
    ["punctuation and spacing", " (0412) 345-678 ", "+61 412 345 678"],
    ["a landline in brackets", "(02) 9876 5432", "+61 2 9876 5432"],
  ])("formats %s", (_label, typed, expected) => {
    render(<TrialStartForm />);
    expect(typePhone(typed)).toBe(expected);
  });

  it("groups a mobile 3-3-3 and a landline 1-4-4 as the digits arrive", () => {
    render(<TrialStartForm />);

    expect(typePhone("04")).toBe("+61 4");
    expect(typePhone("0412")).toBe("+61 412");
    expect(typePhone("04123")).toBe("+61 412 3");
    expect(typePhone("0298")).toBe("+61 2 98");
  });

  // Typing the trunk '0' would otherwise erase the keystroke and look broken.
  it("shows the bare country code once a prefix digit is typed", () => {
    render(<TrialStartForm />);
    expect(typePhone("0")).toBe("+61 ");
  });

  it("caps at nine significant digits instead of truncating a paste", () => {
    render(<TrialStartForm />);
    expect(typePhone("0412345678999")).toBe("+61 412 345 678");
  });

  it("clears the field when the value is emptied", () => {
    render(<TrialStartForm />);

    typePhone("0412345678");
    expect(typePhone("")).toBe("");
  });

  it("is idempotent — reformatting its own output changes nothing", () => {
    render(<TrialStartForm />);

    const once = typePhone("0412345678");
    expect(typePhone(once)).toBe(once);
  });

  it("posts the formatted value, not what was typed", async () => {
    const fetchMock = mockFetch(201, { data: {} });
    render(<TrialStartForm />);

    fill({ Phone: "0412345678" });
    submit();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.phone).toBe("+61 412 345 678");
  });

  it.each([
    ["an incomplete number", "0412"],
    ["a 1300 service number", "1300123456"],
    ["an invalid leading digit", "0512345678"],
  ])("rejects %s with no network call", async (_label, typed) => {
    const fetchMock = mockFetch(201);
    render(<TrialStartForm />);

    fill({ Phone: typed });
    submit();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter a valid Australian phone number, e.g. +61 412 345 678.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a landline, not only mobiles", async () => {
    const fetchMock = mockFetch(201, { data: {} });
    render(<TrialStartForm />);

    fill({ Phone: "(02) 9876 5432" });
    submit();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.phone).toBe("+61 2 9876 5432");
  });

  // An empty phone is a missing field, not a malformed one — the copy differs.
  it("reports an empty phone as a required field", async () => {
    const fetchMock = mockFetch(201);
    render(<TrialStartForm />);

    fill({ Phone: "" });
    submit();

    expect(await screen.findByRole("alert")).toHaveTextContent("All fields are required.");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
