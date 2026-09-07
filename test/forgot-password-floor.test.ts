import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The timing half of the no-enumeration guardrail, pinned.
 *
 * WHY THIS IS ITS OWN FILE. `forgot-password-route.test.ts` sets
 * `PASSWORD_RESET_FLOOR_MS = "0"` before importing the route, so that its 40-odd
 * cases do not each cost the production floor. That is the right call for those
 * cases — but it means NONE of them can observe the floor, and deleting the pad
 * from the route left the whole suite green. A guardrail nobody's test can see
 * is not a guardrail. So this file sets a small but NON-ZERO floor of its own
 * and asserts the elapsed-time property directly.
 *
 * BE CAREFUL WHAT YOU CONCLUDE FROM VITEST ISOLATION HERE. Each test file gets
 * its own module registry, so the ROUTE MODULE is re-imported per file and reads
 * this value fresh. But `process.env` is process-global and vitest reuses worker
 * processes across files — module isolation does NOT reset it. What keeps the
 * two files honest is that each assigns its own value at module scope before any
 * of its tests run. The real invariant is therefore "EVERY file that imports this
 * route must set `PASSWORD_RESET_FLOOR_MS` itself", not "vitest isolates it". A
 * third importer that sets nothing would inherit whichever value happened to be
 * left behind. If you add one, use `vi.stubEnv` + `vi.unstubAllEnvs`.
 *
 * FLOOR_MS is small enough to keep this file's cost near a second, and large
 * enough that absolute scheduler slop on a loaded CI box stays well inside the
 * margins. The property under test is scale-free: it holds at 300ms exactly as
 * it holds at the production 1500ms.
 */
const FLOOR_MS = 300;
process.env.PASSWORD_RESET_FLOOR_MS = String(FLOOR_MS);

// How long a "real member" send is simulated to take. The premise of the whole
// guardrail is that this path is measurably slower than the unknown-address one
// (measured at 2.5-5x against the live Supabase). If the pad were removed, this
// gap is what an attacker would read off the wire to classify an address.
const SLOW_SEND_MS = 150;

/**
 * Slack on the "did it reach the floor" assertions.
 *
 * Not a fudge factor for jitter — jitter only ever makes a response LATER. It
 * absorbs sub-millisecond truncation on the way out: `setTimeout` rounds its
 * delay down to whole milliseconds, so a padded response can legitimately land a
 * hair under the nominal floor. Far too small to let an unpadded route through:
 * that returns in ~1ms, not 295ms.
 */
const SLACK_MS = 5;

const resetPasswordForEmailMock = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: vi.fn(async () => ({
    auth: { resetPasswordForEmail: resetPasswordForEmailMock },
  })),
}));

import { POST } from "@/app/api/auth/forgot-password/route";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function req(body: unknown, headers?: Record<string, string>) {
  return new Request("http://localhost/api/auth/forgot-password", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** Wall-clock cost of one request, in ms. */
async function timed(request: Request): Promise<number> {
  const t0 = performance.now();
  const res = await POST(request);
  // Drain the body: a response whose cost is deferred to body-read would not be
  // padded by the handler at all, and measuring only the handler would miss it.
  await res.json();
  return performance.now() - t0;
}

describe("forgot-password timing floor", () => {
  beforeEach(() => {
    resetPasswordForEmailMock.mockReset();
  });

  // ── The pad itself ────────────────────────────────────────────────────────
  //
  // The cheapest possible path: the CSRF guard refuses before anything is
  // parsed, so the handler's own work is a few microseconds. Any response
  // faster than the floor means the pad is gone.
  it("pads even the path that does no work at all", async () => {
    resetPasswordForEmailMock.mockResolvedValue({ data: {}, error: null });

    const elapsed = await timed(
      req({ email: "someone@example.com" }, { "content-type": "text/plain" }),
    );

    expect(elapsed).toBeGreaterThanOrEqual(FLOOR_MS - SLACK_MS);
  });

  it("pads a malformed address, which never reaches Supabase", async () => {
    resetPasswordForEmailMock.mockResolvedValue({ data: {}, error: null });

    const elapsed = await timed(req({ email: "not-an-address" }));

    expect(elapsed).toBeGreaterThanOrEqual(FLOOR_MS - SLACK_MS);
    expect(resetPasswordForEmailMock).not.toHaveBeenCalled();
  });

  // ── The property that actually matters ────────────────────────────────────
  //
  // Not "each response is slow" but "a member and a stranger cost the SAME".
  // The mock makes the member path genuinely slower, exactly as the live send
  // is, and the assertion is that the pad swallows that difference. Remove the
  // pad and the gap re-appears at ~SLOW_SEND_MS, which is the oracle.
  it("makes a registered and an unregistered address cost the same", async () => {
    resetPasswordForEmailMock.mockImplementation(async () => {
      await sleep(SLOW_SEND_MS);
      return { data: {}, error: null };
    });
    const known = await timed(req({ email: "known@example.com" }));

    resetPasswordForEmailMock.mockReset();
    resetPasswordForEmailMock.mockResolvedValue({
      data: {},
      error: { message: "User not found", status: 400 },
    });
    const unknown = await timed(req({ email: "nobody@example.com" }));

    // Both sit on the floor…
    expect(known).toBeGreaterThanOrEqual(FLOOR_MS - SLACK_MS);
    expect(unknown).toBeGreaterThanOrEqual(FLOOR_MS - SLACK_MS);

    // …and are therefore indistinguishable.
    //
    // ONE-SIDED, deliberately. Only `known` being SLOWER than `unknown` is an
    // enumeration oracle; noise that made the unknown path slower tells an
    // attacker nothing, so asserting on `Math.abs` would double the flake
    // surface for no security value. `known` is also the structurally noisier
    // leg — it waits on two sequential timers (the send, then the remaining pad)
    // where `unknown` waits on one.
    expect(known - unknown).toBeLessThan(SLOW_SEND_MS / 2);

    // The member path must actually have done the slow thing; otherwise a
    // refactor that stopped sending the mail at all would leave both legs fast,
    // padded, and this test green.
    expect(resetPasswordForEmailMock).toHaveBeenCalled();
  });

  // The pad is a floor, not a fixed delay: once the send has already outrun it,
  // NOTHING further is added.
  //
  // The lower bound alone would be tautological — a send slower than the floor
  // is slow whether or not the pad exists, so it survives deleting the pad. The
  // UPPER bound is the one that earns its keep: it kills the plausible mutant
  // `await sleep(floor)` (pad unconditionally, without subtracting the elapsed
  // time), which passes every other test in this file while making each response
  // cost send + floor. That mutant is not just wasteful — it re-exposes the send
  // duration as an additive term, which is the oracle all over again.
  it("adds nothing on top of a send that already outran the floor", async () => {
    const OVERRUN_MS = FLOOR_MS * 2;
    resetPasswordForEmailMock.mockImplementation(async () => {
      await sleep(OVERRUN_MS);
      return { data: {}, error: null };
    });

    const elapsed = await timed(req({ email: "slow@example.com" }));

    expect(elapsed).toBeGreaterThanOrEqual(OVERRUN_MS - SLACK_MS);
    expect(elapsed).toBeLessThan(OVERRUN_MS + FLOOR_MS / 2);
  });
});
