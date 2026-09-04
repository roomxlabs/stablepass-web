// Shares disclaimer (ENG-956). The copy assertion is a LITERAL, exactly like
// `test/marketing-home.test.tsx`'s "Important note" pin and mobile's
// `src/components/__tests__/shares-disclaimer.test.tsx`: this is the client's
// regulator-facing, signed-off wording (guardrail #8), and a well-meaning edit
// must fail HERE rather than ship.
//
// The literal below is typed out in full on purpose — asserting against the
// imported constant alone would be a tautology that passes after any edit.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SharesDisclaimer, SHARES_DISCLAIMER_COPY } from "@/components/shares-disclaimer";

// Byte-for-byte the string in stablepass-mobile's `src/components/shares-disclaimer.tsx`
// and in `app/(marketing)/sections/important-note.tsx`.
const VERBATIM =
  "stablepass. is an entertainment and experience subscription. stablepass. does not sell shares in " +
  "racehorses, syndicates, financial products, betting products, prize money rights, or investment returns. " +
  "Subscribers receive content access and racing experiences only.";

describe("SharesDisclaimer", () => {
  it("pins the copy character-for-character to the signed-off wording", () => {
    expect(SHARES_DISCLAIMER_COPY).toBe(VERBATIM);
  });

  it("matches the marketing 'Important note' paragraph word for word (one source of truth)", () => {
    // Reads the marketing file OFF DISK. Comparing two local constants here
    // would be a tautology — the test above already pins them to each other —
    // and would stay green while the marketing paragraph drifted away.
    const marketing = readFileSync(
      join(process.cwd(), "app/(marketing)/sections/important-note.tsx"),
      "utf8",
    );
    const match = /<p>([\s\S]*?)<\/p>/.exec(marketing);
    expect(match, "the Important note <p> must be findable").not.toBeNull();

    // The section renders the same sentences with JSX line wrapping, so compare
    // on collapsed whitespace — a wrap must not defeat the guard.
    const paragraph = match![1].replace(/\s+/g, " ").trim();
    expect(paragraph).toBe(SHARES_DISCLAIMER_COPY);
  });

  it("renders the green strip and NO inline paragraph until it is opened", () => {
    render(<SharesDisclaimer />);

    expect(screen.getByTestId("shares-disclaimer")).toBeInTheDocument();
    expect(screen.getByTestId("shares-disclaimer")).toHaveTextContent("Disclaimer");
    // The word alone, per the client: the copy must NOT be on the screen until
    // the pop-up opens.
    expect(screen.queryByTestId("shares-disclaimer-copy")).toBeNull();
  });

  it("opens the pop-up card with the copy, and the X closes it", async () => {
    const user = userEvent.setup();
    render(<SharesDisclaimer />);

    await user.click(screen.getByTestId("shares-disclaimer"));
    expect(screen.getByTestId("shares-disclaimer-copy")).toHaveTextContent(VERBATIM);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.click(screen.getByTestId("shares-disclaimer-close"));
    expect(screen.queryByTestId("shares-disclaimer-copy")).toBeNull();
  });

  it("closes on the backdrop but NOT on a click inside the card", async () => {
    const user = userEvent.setup();
    render(<SharesDisclaimer />);

    await user.click(screen.getByTestId("shares-disclaimer"));
    await user.click(screen.getByTestId("shares-disclaimer-card"));
    expect(screen.getByTestId("shares-disclaimer-copy")).toBeInTheDocument();

    await user.click(screen.getByTestId("shares-disclaimer-backdrop"));
    expect(screen.queryByTestId("shares-disclaimer-copy")).toBeNull();
  });
});
