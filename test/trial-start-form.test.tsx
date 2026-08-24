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

  // ---- the repeat-signup wall (ENG-763) -------------------------------------
  // The 409 that used to be `email_taken` is now `trial_already_used` and both
  // the phone hit and the email hit render this same wall.
  describe("repeat-signup wall", () => {
    const WALLED = {
      error: {
        code: "trial_already_used",
        message: "Looks like you've already had your free trial. Sign in to join stablepass.",
      },
    };

    async function submitWalled() {
      mockFetch(409, WALLED);
      render(<TrialStartForm />);
      fill();
      submit();
      return screen.findByRole("heading", {
        name: /already had your free trial/i,
      });
    }

    it("renders the friendly headline on 409 trial_already_used", async () => {
      const heading = await submitWalled();

      expect(heading).toBeInTheDocument();
      expect(pushMock).not.toHaveBeenCalled();
    });

    it("gives a real next step: the join prompt and a CTA that reaches sign-in", async () => {
      await submitWalled();

      // The acceptance criterion is that the CTA REACHES sign-in, so the href is
      // asserted rather than just the label.
      const cta = screen.getByRole("link", { name: "Sign in to join" });
      expect(cta).toHaveAttribute("href", "/signin");
      expect(screen.getByText(/\$19 per month/)).toBeInTheDocument();
    });

    it("replaces the form outright — no fields left to resubmit", async () => {
      await submitWalled();

      expect(screen.queryByRole("button", { name: "Start free trial" })).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Phone")).not.toBeInTheDocument();
      // ...but there is still a way back for someone who simply mistyped.
      expect(screen.getByRole("link", { name: "Start over" })).toHaveAttribute("href", "/start");
    });

    it("never names WHICH credential matched", async () => {
      await submitWalled();

      // One generic message, per the ticket's resolved open question. The
      // member's own email and number were on the form they just submitted;
      // repeating either here would turn the wall into a confirmation oracle.
      const text = document.body.textContent ?? "";
      expect(text).not.toContain("jo@example.com");
      expect(text).not.toContain("400 000 000");
      expect(text.toLowerCase()).not.toContain("that email is already registered");
    });

    it("does NOT wall on a 409 that is not trial_already_used", async () => {
      // Branching on the status alone would swallow any future 409 whole.
      mockFetch(409, { error: { code: "something_else", message: "Nope." } });
      render(<TrialStartForm />);

      fill();
      submit();

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "That email is already registered. Try signing in instead.",
      );
      expect(
        screen.queryByRole("heading", { name: /already had your free trial/i }),
      ).not.toBeInTheDocument();
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

  // Dropped on client instruction 17 Aug 2026. Pinned because the mockup still
  // shows it, so a future fidelity pass would otherwise put it back.
  it("does not render the '30 days, on us' trial banner", () => {
    const { container } = render(<TrialStartForm />);

    expect(container.querySelector(".trial-banner-web")).toBeNull();
    expect(container.textContent).not.toContain("30 days, on us");
    expect(container.textContent).not.toContain("never renews on its own");

    // Positive control: the trial is still communicated, just by the heading.
    expect(container.textContent).toContain("Start your 30 days free.");
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
