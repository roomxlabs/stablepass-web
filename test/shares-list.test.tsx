// /shares is a LIST of for-sale horses, never a feed (ENG-956).
//
// Replaces `test/shares-feed.test.tsx`, whose assertions ("loads the Shares
// BFF", "renders Shares cards with Contact CTA") encoded the very behaviour
// this ticket removes. The acceptance criteria are pinned here:
//   1. only for-sale horses, and never a post;
//   2. the disclaimer is on the screen;
//   3. the trainer-website link opens `website_url` and logs the click.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  SharesList,
  SHARES_HORSE_SELECT,
  SHARES_PAGE_SIZE,
  sharesStatusLabel,
  safeSharesWebsiteHref,
} from "@/app/(member)/shares/shares-list";

const VIEWER_ID = "8f3c1a2b-1234-4abc-9def-0123456789ab";

const HORSES = [
  {
    id: "h-2",
    display_name: "Zephyr × Moonlight",
    // "(AUS)" is DROPPED on display by `displayHorseNameOrEmpty` (round 6):
    // locally bred is the default in an Australian stable, so the suffix is
    // noise. A genuine import code — (NZ), (GB) — would survive.
    racing_name: "ZEPHYR ROSE (AUS)",
    training_status: "racing",
    trainer: { id: "t1", name: "Chris Waller", website_url: "https://wallerracing.example" },
  },
  {
    id: "h-1",
    display_name: "Ajax × Willow",
    racing_name: "ARDENT LAD",
    training_status: "spelling",
    // A BARE DOMAIN — unconstrained `text`, so it must not become a relative
    // in-app href. The row renders no link at all for it.
    trainer: { id: "t2", name: "Gai Waterhouse", website_url: "waterhouse.example" },
  },
];

const ACTIVE_SUB = { status: "active", trial_ends_at: null, current_period_end: "2099-01-01T00:00:00.000Z" };

function chainable(result: { data: unknown; error: unknown }) {
  const obj: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "not", "order", "limit"]) {
    obj[method] = vi.fn(() => obj);
  }
  obj.maybeSingle = vi.fn(() => Promise.resolve(result));
  obj.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled, onRejected);
  return obj;
}

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));

vi.mock("@/lib/supabase/client", () => ({
  supabaseBrowser: () => ({ from: fromMock }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// The `horse` chain is held so its `.select`/`.eq` args can be asserted — the
// projection is load-bearing in BOTH directions (.rx/gotchas.md).
let horseChain: Record<string, ReturnType<typeof vi.fn>>;

function mountWith(horses: unknown, error: unknown = null) {
  fromMock.mockImplementation((table: string) => {
    if (table === "subscription") return chainable({ data: ACTIVE_SUB, error: null });
    if (table === "horse") {
      horseChain = chainable({ data: horses, error }) as never;
      return horseChain;
    }
    return chainable({ data: [], error: null });
  });
  return render(<SharesList viewerId={VIEWER_ID} everSubscribed={false} />);
}

describe("SharesList (ENG-956)", () => {
  beforeEach(() => {
    fromMock.mockReset();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, status: 204 })));
  });

  it("reads FOR-SALE ACTIVE HORSES — and never a post or a feed route", async () => {
    mountWith(HORSES);

    await waitFor(() => expect(screen.getByTestId("shares-list")).toBeInTheDocument());

    // The projection is spelled out as a LITERAL, exactly as the disclaimer's
    // VERBATIM is. Asserting against the imported `SHARES_HORSE_SELECT` would
    // be a tautology: adding an undeployed column to the constant would leave
    // this green, and .rx/gotchas.md is explicit that naming a column that is
    // not deployed hard-fails the WHOLE query with 42703 — a silent blackout.
    expect(horseChain.select).toHaveBeenCalledWith(
      "id, display_name, racing_name, training_status, trainer:trainer_id(id, name, website_url)",
    );
    // ...and the exported constant is what the screen actually passes.
    expect(SHARES_HORSE_SELECT).toBe(
      "id, display_name, racing_name, training_status, trainer:trainer_id(id, name, website_url)",
    );
    expect(horseChain.eq).toHaveBeenCalledWith("status", "active");
    expect(horseChain.eq).toHaveBeenCalledWith("shares_for_sale", true);
    // Bounded, mirroring mobile's BROWSE_PAGE_SIZE — never an unbounded read.
    expect(horseChain.limit).toHaveBeenCalledWith(SHARES_PAGE_SIZE);

    // The `post` table is never touched, and no feed route is called.
    expect(fromMock.mock.calls.map((c) => c[0])).not.toContain("post");
    const urls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.startsWith("/api/feed"))).toBe(false);
  });

  it("renders the horse name, trainer and status pill, sorted on the RESOLVED name", async () => {
    mountWith(HORSES);

    await waitFor(() => expect(screen.getByText("Ardent Lad")).toBeInTheDocument());
    expect(screen.getByText("Zephyr Rose")).toBeInTheDocument();
    expect(screen.getByText("Chris Waller")).toBeInTheDocument();
    expect(screen.getByText("Racing")).toBeInTheDocument();
    expect(screen.getByText("Spelling")).toBeInTheDocument();

    // Sorted on what the row SHOWS: "Ardent Lad" before "Zephyr Rose", even
    // though the query's `display_name` order is the reverse.
    const names = screen.getAllByText(/Ardent Lad|Zephyr Rose/).map((el) => el.textContent);
    expect(names).toEqual(["Ardent Lad", "Zephyr Rose"]);
  });

  it("links each row to the horse profile", async () => {
    mountWith(HORSES);
    await waitFor(() => expect(screen.getByTestId("shares-row-h-1")).toBeInTheDocument());
    expect(screen.getByRole("link", { name: /Ardent Lad/ })).toHaveAttribute("href", "/horses/h-1");
  });

  it("offers 'Visit trainer website' for an absolute URL only, and logs the click", async () => {
    const user = userEvent.setup();
    mountWith(HORSES);

    await waitFor(() => expect(screen.getByTestId("shares-list")).toBeInTheDocument());

    const links = screen.getAllByRole("link", { name: /Visit trainer website/ });
    // One link, not two: the bare domain renders no action at all.
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "https://wallerracing.example");
    expect(links[0]).toHaveAttribute("target", "_blank");
    expect(links[0]).toHaveAttribute("rel", "noopener noreferrer");

    await user.click(links[0]);
    const urls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(urls).toContain("/api/trainers/t1/website-click");
  });

  it("renders the disclaimer strip, with the copy hidden until it is opened", async () => {
    mountWith(HORSES);
    await waitFor(() => expect(screen.getByTestId("shares-list")).toBeInTheDocument());

    expect(screen.getByTestId("shares-disclaimer")).toBeInTheDocument();
    expect(screen.queryByTestId("shares-disclaimer-copy")).toBeNull();
  });

  it("shows mobile's empty-state copy when nothing is for sale", async () => {
    mountWith([]);
    await waitFor(() => expect(screen.getByTestId("shares-empty")).toBeInTheDocument());
    expect(screen.getByText("No shares for sale right now")).toBeInTheDocument();
    expect(
      screen.getByText("Horses with ownership shares for sale will show up here."),
    ).toBeInTheDocument();
  });

  it("surfaces a read error instead of an empty list (a 42703 must not look empty)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mountWith(null, { code: "42703", message: "column does not exist" });

    await waitFor(() => expect(screen.getByTestId("shares-error")).toBeInTheDocument());
    expect(screen.queryByTestId("shares-empty")).toBeNull();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("walls a lapsed member rather than showing an empty screen", async () => {
    fromMock.mockImplementation((table: string) =>
      chainable(
        table === "subscription"
          ? { data: { status: "active", trial_ends_at: null, current_period_end: "2020-01-01T00:00:00.000Z" }, error: null }
          : { data: [], error: null },
      ),
    );
    render(<SharesList viewerId={VIEWER_ID} everSubscribed />);

    // POSITIVE first: guardrail 3 is "renders the reactivate prompt, NOT
    // content". Asserting only the absence of the list passes vacuously if the
    // gated branch renders nothing at all — verified: deleting the AccessWall
    // render left this test green until this assertion was added.
    await waitFor(() => expect(screen.getByTestId("access-wall")).toBeInTheDocument());
    expect(screen.getByText("Your access has paused")).toBeInTheDocument();

    // ...and only THEN the negatives.
    expect(screen.queryByTestId("shares-list")).toBeNull();
    expect(fromMock.mock.calls.map((c) => c[0])).not.toContain("horse");
  });
});

describe("sharesStatusLabel", () => {
  it("maps every training_status mobile maps, legacy spellings included", () => {
    expect(sharesStatusLabel("racing")).toBe("Racing");
    expect(sharesStatusLabel("spelling")).toBe("Spelling");
    expect(sharesStatusLabel("breaking_in")).toBe("Breaking in");
    expect(sharesStatusLabel("retired")).toBe("Retired");
    expect(sharesStatusLabel("pre_training")).toBe("Pre-training");
    expect(sharesStatusLabel("in_training")).toBe("In training");
    expect(sharesStatusLabel("farm_training")).toBe("In training");
    expect(sharesStatusLabel("city_training")).toBe("In training");
  });

  it("renders NO pill for an unmapped status, rather than a raw enum", () => {
    expect(sharesStatusLabel("something_new")).toBe("");
    expect(sharesStatusLabel(null)).toBe("");
  });
});

describe("safeSharesWebsiteHref", () => {
  it("accepts http(s) only and returns the ORIGINAL string (no normalisation)", () => {
    expect(safeSharesWebsiteHref("https://example.com")).toBe("https://example.com");
    expect(safeSharesWebsiteHref("  http://example.com/x  ")).toBe("http://example.com/x");
    expect(safeSharesWebsiteHref("example.com")).toBeNull();
    expect(safeSharesWebsiteHref("javascript:alert(1)")).toBeNull();
    expect(safeSharesWebsiteHref("")).toBeNull();
    expect(safeSharesWebsiteHref(null)).toBeNull();
  });
});
