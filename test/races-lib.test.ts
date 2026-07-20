// lib/races.ts — the RF5 (ENG-297) runner-lifecycle rules. These are the pure
// core of the member race reads: which runners reach the next-race card, which
// reach the race record, and (the guardrail-adjacent one) which reach NEITHER.
import { describe, it, expect } from "vitest";
import { splitRaces, raceName, raceDetail, raceWhenParts, raceDayWhen } from "@/lib/races";

const upcoming = (scheduledAt: string) => ({
  venue: "Randwick",
  race_date: scheduledAt.slice(0, 10),
  race_number: 5,
  race_class: "BM78",
  distance_m: 1400,
  scheduled_at: scheduledAt,
  status: "upcoming",
});

const finished = (raceDate: string) => ({
  venue: "Caulfield",
  race_date: raceDate,
  race_number: 3,
  race_class: "Maiden",
  distance_m: 1100,
  scheduled_at: `${raceDate}T04:00:00.000Z`,
  status: "finished",
});

const runner = (over: Record<string, unknown>) => ({
  entry_status: "confirmed",
  barrier: 4,
  jockey: "T. Berry",
  result: null,
  finish_position: null,
  race: upcoming("2026-08-01T06:35:00.000Z"),
  ...over,
});

describe("splitRaces — next race", () => {
  it("picks the earliest upcoming confirmed runner, with barrier + jockey", () => {
    const { next } = splitRaces([
      runner({ race: upcoming("2026-09-01T06:35:00.000Z") }),
      runner({ race: upcoming("2026-08-01T06:35:00.000Z") }),
    ]);

    expect(next).toMatchObject({
      venue: "Randwick",
      race_number: 5,
      race_class: "BM78",
      distance_m: 1400,
      scheduled_at: "2026-08-01T06:35:00.000Z",
      entry_status: "confirmed",
      barrier: 4,
      jockey: "T. Berry",
    });
  });

  it("keeps a nominated runner but omits barrier + jockey (not allocated yet)", () => {
    const { next } = splitRaces([runner({ entry_status: "nominated" })]);

    expect(next?.entry_status).toBe("nominated");
    expect(next?.barrier).toBeNull();
    expect(next?.jockey).toBeNull();
    // The rest of the card still renders.
    expect(next?.venue).toBe("Randwick");
    expect(next?.distance_m).toBe(1400);
  });

  it("is null when the horse has no upcoming entry", () => {
    expect(splitRaces([]).next).toBeNull();
    expect(splitRaces([runner({ entry_status: "ran", race: finished("2026-07-01") })]).next).toBeNull();
  });

  it("ignores an entry on a race that is no longer upcoming", () => {
    expect(splitRaces([runner({ race: finished("2026-07-01") })]).next).toBeNull();
  });
});

describe("splitRaces — race record", () => {
  it("returns ran rows newest race_date first", () => {
    const { record } = splitRaces([
      runner({ entry_status: "ran", result: "5th of 10", finish_position: 5, race: finished("2026-05-02") }),
      runner({ entry_status: "ran", result: "1st of 12", finish_position: 1, race: finished("2026-07-11") }),
      runner({ entry_status: "ran", result: "2nd of 9", finish_position: 2, race: finished("2026-06-04") }),
    ]);

    expect(record.map((r) => r.race_date)).toEqual(["2026-07-11", "2026-06-04", "2026-05-02"]);
    expect(record[0]).toEqual({
      venue: "Caulfield",
      race_date: "2026-07-11",
      race_number: 3,
      race_class: "Maiden",
      result: "1st of 12",
      finish_position: 1,
    });
  });

  it("excludes upcoming entries from the record", () => {
    expect(splitRaces([runner({})]).record).toEqual([]);
  });
});

describe("splitRaces — scratched / not_accepted are invisible to members", () => {
  it("drops a scratched runner from BOTH next and record", () => {
    const { next, record } = splitRaces([
      runner({ entry_status: "scratched" }),
      runner({ entry_status: "scratched", race: finished("2026-06-01") }),
    ]);

    expect(next).toBeNull();
    expect(record).toEqual([]);
  });

  it("drops a not_accepted runner from BOTH next and record", () => {
    const { next, record } = splitRaces([
      runner({ entry_status: "not_accepted" }),
      runner({ entry_status: "not_accepted", race: finished("2026-06-01") }),
    ]);

    expect(next).toBeNull();
    expect(record).toEqual([]);
  });

  it("a scratched entry does not mask the next legitimate runner", () => {
    // The scratched row is EARLIER — a naive "earliest wins" would surface it.
    const { next } = splitRaces([
      runner({ entry_status: "scratched", race: upcoming("2026-07-25T06:35:00.000Z") }),
      runner({ entry_status: "confirmed", race: upcoming("2026-08-01T06:35:00.000Z") }),
    ]);

    expect(next?.scheduled_at).toBe("2026-08-01T06:35:00.000Z");
    expect(next?.entry_status).toBe("confirmed");
  });
});

describe("presentation helpers", () => {
  it("raceName matches the mockup headline, degrading on nulls", () => {
    expect(raceName("Randwick", 5, "BM78")).toBe("Randwick R5 · BM78");
    expect(raceName(null, null, null)).toBe("TBC R?");
  });

  it("raceDetail drops barrier/jockey when they are null (the nominated case)", () => {
    expect(raceDetail({ distance_m: 1400, barrier: 4, jockey: "T. Berry" })).toBe("1400m · Barrier 4 · Jockey: T. Berry");
    expect(raceDetail({ distance_m: 1400, barrier: null, jockey: null })).toBe("1400m");
  });

  it("raceWhenParts renders the mockup's two-part when row", () => {
    const now = new Date("2026-08-01T00:35:00.000Z");
    const [day, rel] = raceWhenParts("2026-08-01T06:35:00.000Z", now);
    expect(day.startsWith("Today · ")).toBe(true);
    expect(rel).toBe("In 6 hours");
  });

  it("raceDayWhen renders the band's single line", () => {
    const now = new Date("2026-08-01T00:35:00.000Z");
    expect(raceDayWhen("2026-08-01T06:35:00.000Z", now)).toContain("in 6 hours");
    expect(raceDayWhen(null, now)).toBe("Today");
  });
});
