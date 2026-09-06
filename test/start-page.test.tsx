import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// ENG-1003 removed the free-trial "?trial=used" wall from /start. There is now
// exactly ONE state on this screen — the form — so this asserts the wall is
// unreachable: the page reads no searchParams at all and renders the same
// thing no matter what query string it's given.

// vi.mock factories are hoisted above top-level const declarations, so the
// mocks they close over have to come from vi.hoisted (same convention as
// test/account-page.test.tsx's fromMock).
const { getUserMock, redirectMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(async () => ({ data: { user: null } })),
  redirectMock: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: vi.fn(async () => ({
    auth: { getUser: getUserMock },
  })),
}));

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
  // TrialStartForm (rendered inside the page) calls useRouter() itself.
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import StartPage from "@/app/start/page";

describe("/start page", () => {
  it("renders the TrialStartForm for a signed-out visitor", async () => {
    render(await StartPage());

    // The account-creation form's own h1, distinguishing it from the deleted wall.
    expect(screen.getByRole("heading", { name: "Create your account." })).toBeInTheDocument();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("renders the same form even when handed a ?trial=used-shaped searchParams argument", async () => {
    // StartPage declares no parameter at all, so a caller passing one (the
    // shape the old wall would have read) is simply ignored — proving the
    // wall's query string has nowhere left to be read from.
    const StartPageAny = StartPage as unknown as (props: unknown) => Promise<Parameters<typeof render>[0]>;
    render(await StartPageAny({ searchParams: Promise.resolve({ trial: "used" }) }));

    expect(screen.getByRole("heading", { name: "Create your account." })).toBeInTheDocument();
    expect(screen.queryByText(/already had your free trial/i)).not.toBeInTheDocument();
  });

  it("takes no searchParams prop and imports no wall — the page component reads neither", async () => {
    // Source-level proof to back the behavioural test above. Comments legitimately
    // still say "trial" and "searchParams" to document what was removed and why,
    // so this strips comments first rather than banning the word outright.
    const raw = readFileSync(resolve(process.cwd(), "app/start/page.tsx"), "utf8");
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");

    expect(code).not.toMatch(/searchParams/);
    expect(code).not.toMatch(/TrialUsedWall/);
  });

  it("the wall component file no longer exists on disk", () => {
    expect(existsSync(resolve(process.cwd(), "app/start/trial-used-wall.tsx"))).toBe(false);
  });
});
