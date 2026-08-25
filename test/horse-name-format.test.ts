// displayHorseName — the ALL-CAPS registrar form renders in title case
// (client, 10 Aug 2026: the caps name was part of the "clunky. old" Post look),
// and "(AUS)" is dropped while genuine import codes stay (round 6, ENG-761).
//
// THE MATRIX BELOW IS SHARED WITH MOBILE, case for case: every `it` in
// stablepass-mobile's `src/components/__tests__/format.test.ts` (ENG-760) has
// its twin here with the same inputs and the same expected strings. That is the
// point of the ticket — web rendered the raw registrar string until now, so the
// two apps disagreed on every horse name. Whoever changes one formatter must
// change both, and these two files are how a divergence is caught.
import { describe, it, expect } from "vitest";
import { displayHorseName, displayHorseNameOrEmpty } from "@/lib/format/horse-name";

describe("displayHorseName", () => {
  it("title-cases a fully-uppercase registrar name", () => {
    expect(displayHorseName("CANNONBROOK")).toBe("Cannonbrook");
    expect(displayHorseName("COASTAL BREEZE")).toBe("Coastal Breeze");
  });

  it("passes mixed-case names through untouched — that casing is deliberate", () => {
    expect(displayHorseName("Mahogany")).toBe("Mahogany");
    expect(displayHorseName("McLaren Star")).toBe("McLaren Star");
    expect(displayHorseName("Zaaki's Pride")).toBe("Zaaki's Pride");
  });

  it("restarts capitalisation after an apostrophe or hyphen", () => {
    expect(displayHorseName("D'ARGENTO")).toBe("D'Argento");
    expect(displayHorseName("RED-HOT REIGN")).toBe("Red-Hot Reign");
  });

  it("leaves numbers and empty strings alone", () => {
    expect(displayHorseName("AREA 51")).toBe("Area 51");
    expect(displayHorseName("")).toBe("");
  });

  describe("the (AUS) suffix is dropped", () => {
    it("drops a trailing (AUS) and leaves no trailing space", () => {
      expect(displayHorseName("CANNONBROOK (AUS)")).toBe("Cannonbrook");
      expect(displayHorseName("COASTAL BREEZE (AUS)")).toBe("Coastal Breeze");
    });

    it("drops it whatever its case — nothing enforces caps in the data", () => {
      expect(displayHorseName("CANNONBROOK (Aus)")).toBe("Cannonbrook");
      expect(displayHorseName("CANNONBROOK (aus)")).toBe("Cannonbrook");
      expect(displayHorseName("CANNONBROOK (AuS)")).toBe("Cannonbrook");
    });

    it("drops it mid-name without leaving a double space", () => {
      expect(displayHorseName("RED (AUS) REIGN")).toBe("Red Reign");
    });

    it("drops a leading (AUS) without leaving a leading space", () => {
      expect(displayHorseName("(AUS) CANNONBROOK")).toBe("Cannonbrook");
    });

    it("renders empty when the name is nothing but the suffix", () => {
      // Garbage data, locked to the empty string on both platforms. On WEB the
      // render sites coalesce with `|| horse.display_name || "Unnamed"` AFTER
      // the formatter (see `displayHorseNameOrEmpty` below), so unlike mobile —
      // where the fallbacks run upstream on the raw value and nothing catches
      // this — web degrades to the display name rather than a blank row.
      expect(displayHorseName("(AUS)")).toBe("");
    });
  });

  describe("genuine import codes survive", () => {
    it("keeps a non-AUS country suffix uppercase, as before", () => {
      expect(displayHorseName("COASTAL BREEZE (NZ)")).toBe("Coastal Breeze (NZ)");
      expect(displayHorseName("VERRY ELLEEGANT (NZ)")).toBe("Verry Elleegant (NZ)");
      expect(displayHorseName("YEATS (GB)")).toBe("Yeats (GB)");
      expect(displayHorseName("SNOW FAIRY (IRE)")).toBe("Snow Fairy (IRE)");
      expect(displayHorseName("ZENYATTA (USA)")).toBe("Zenyatta (USA)");
    });

    it("only drops the exact code — a longer word starting AUS stays", () => {
      expect(displayHorseName("CANNONBROOK (AUST)")).toBe("Cannonbrook (AUST)");
      expect(displayHorseName("CANNONBROOK (AUSTRALIA)")).toBe("Cannonbrook (AUSTRALIA)");
    });

    it("never touches an unparenthesised word that merely reads AUS", () => {
      expect(displayHorseName("AUSSIE RULES")).toBe("Aussie Rules");
      expect(displayHorseName("AUS")).toBe("Aus");
    });
  });
});

// The nullable-safe wrapper is web-only: mobile's call sites coalesce upstream,
// web's coalesce at the render site, so web needs a form that survives a null
// `racing_name` without the caller writing `?? ""` five times.
describe("displayHorseNameOrEmpty", () => {
  it("returns the empty string for null and undefined", () => {
    expect(displayHorseNameOrEmpty(null)).toBe("");
    expect(displayHorseNameOrEmpty(undefined)).toBe("");
    expect(displayHorseNameOrEmpty("")).toBe("");
  });

  it("formats exactly like displayHorseName otherwise", () => {
    expect(displayHorseNameOrEmpty("CANNONBROOK (AUS)")).toBe("Cannonbrook");
    expect(displayHorseNameOrEmpty("COASTAL BREEZE (NZ)")).toBe("Coastal Breeze (NZ)");
  });

  it("falls back cleanly when the name was nothing but the suffix", () => {
    // "" is falsy, so a call site's `|| horse.display_name || "Unnamed"` fires.
    // This is the assertion that makes the mobile follow-up a non-issue on web.
    expect(displayHorseNameOrEmpty("(AUS)") || "Unnamed").toBe("Unnamed");
  });
});
