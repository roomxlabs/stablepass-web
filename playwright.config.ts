import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

import { defineConfig } from "@playwright/test";

// Well-known local-Supabase demo anon key (matches `supabase start`'s default
// project). See .rx/fe-harness.md for the full harness convention.
const LOCAL_SUPABASE_URL = "http://127.0.0.1:54321";
const LOCAL_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

/**
 * Per-checkout dev-server port (ENG-597).
 *
 * This file used to pin :3000 with `reuseExistingServer: true`. The implement
 * loop runs several worktrees at once under `.claude/worktrees/<ticket>/`, so
 * the first worker to run Playwright owned :3000 and every other worker's suite
 * silently attached to THAT worker's branch. It fails green as easily as it
 * fails red: on ENG-588 a suite passed against a sibling's server and overwrote
 * this repo's committed fidelity screenshots with the wrong branch's page.
 *
 * Flipping `reuseExistingServer` to false alone does not fix it — two workers
 * would then fight to bind the same port. So the port is DERIVED FROM THE
 * CHECKOUT PATH: stable for a given checkout, different for every worktree.
 *
 * Resolution order:
 *   1. `PORT` if set — an explicit override always wins.
 *   2. A dev server THIS SAME CHECKOUT already has listening (:3000 first, so
 *      the everyday `npm run dev` + `npx playwright test` flow still reuses the
 *      one server; then this checkout's derived port).
 *   3. Otherwise this checkout's derived port, started by Playwright itself.
 *
 * A server belonging to a DIFFERENT checkout is never reused — that is the
 * whole bug. Ownership is decided by the listening process's working directory,
 * the same signal the ticket used to diagnose it:
 *
 *   lsof -ti :<port> | while read p; do lsof -a -p $p -d cwd -Fn; done
 */
if (typeof __dirname !== "string") {
  // Falling back to process.cwd() here would derive the port from whatever
  // directory the run was invoked from and point webServer.cwd at the wrong
  // tree — silently, which is the whole class of bug this file exists to kill.
  throw new Error(
    "[playwright] cannot resolve the checkout root: __dirname is undefined. " +
      "Did this config become ESM? See ENG-597 before changing it.",
  );
}
const CHECKOUT_ROOT = canonical(__dirname);

/** `npm run dev`'s own default, kept as the everyday interactive port. */
const CONVENTIONAL_PORT = 3000;

/**
 * Derived ports sit below BOTH platforms' ephemeral ranges — Linux's
 * `net.ipv4.ip_local_port_range` defaults to 32768-60999 and macOS's
 * `net.inet.ip.portrange.first` to 49152 — so the OS never hands the same
 * number to an unrelated outbound socket. (40000+ would have been inside
 * Linux's range.) A host with a custom range could still overlap; that
 * surfaces as a loud bind failure, never as a silent wrong-branch run.
 */
const DERIVED_PORT_FLOOR = 20000;
const DERIVED_PORT_CEILING = 32767;

function canonical(dir: string): string {
  try {
    // /tmp and /private/tmp are the same directory on macOS; without this two
    // spellings of one checkout would derive two different ports.
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

function derivePort(root: string): number {
  const span = DERIVED_PORT_CEILING - DERIVED_PORT_FLOOR + 1;
  const digest = createHash("sha256").update(root).digest();
  return DERIVED_PORT_FLOOR + (digest.readUInt32BE(0) % span);
}

function lsof(args: string[]): string {
  // lsof exits non-zero when nothing matches, and is absent on some minimal CI
  // images. Both mean "cannot prove this port is mine", which callers treat as
  // not-mine — the safe direction: we start our own server and any real clash
  // surfaces loudly as a bind failure instead of silently testing someone else.
  try {
    return execFileSync("lsof", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

function listeningPids(port: number): number[] {
  return lsof(["-ti", `tcp:${port}`, "-sTCP:LISTEN"])
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

/** Working directory of a listening process, per `lsof -d cwd -Fn`. */
function processCwd(pid: number): string | null {
  const field = lsof(["-a", "-p", String(pid), "-d", "cwd", "-Fn"])
    .split("\n")
    .find((line) => line.startsWith("n"));
  return field ? canonical(field.slice(1)) : null;
}

function portOwners(port: number): string[] {
  return listeningPids(port)
    .map(processCwd)
    .filter((cwd): cwd is string => cwd !== null);
}

function portBelongsToThisCheckout(port: number): boolean {
  const owners = portOwners(port);
  // EVERY owner must be us, not merely one of them — a port we only partly own
  // is not a port we can trust. Exact equality, never a prefix: the worktrees
  // live INSIDE the main checkout, so a prefix test would make the main
  // checkout "own" every worktree's server.
  return owners.length > 0 && owners.every((cwd) => cwd === CHECKOUT_ROOT);
}

/** `PORT` if it is a usable port number, else null (with a reason). */
function portOverride(): number | null {
  const raw = process.env.PORT?.trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed >= 65536) {
    // Never silently ignore an override — the developer believes they pinned a
    // port, and quietly testing a different one is the failure mode being fixed.
    console.warn(
      `[playwright] ignoring PORT=${JSON.stringify(raw)}: not a port number in 1-65535. ` +
        `Falling back to this checkout's derived port.`,
    );
    return null;
  }
  return parsed;
}

function resolveDevServer(): { port: number; reuse: boolean } {
  const override = portOverride();
  if (override !== null) {
    // Explicit PORT still only reuses a server that is genuinely ours.
    return { port: override, reuse: portBelongsToThisCheckout(override) };
  }

  const derived = derivePort(CHECKOUT_ROOT);
  for (const candidate of [CONVENTIONAL_PORT, derived]) {
    if (portBelongsToThisCheckout(candidate)) {
      return { port: candidate, reuse: true };
    }
  }
  return { port: derived, reuse: false };
}

const { port: DEV_PORT, reuse: REUSE_EXISTING_SERVER } = resolveDevServer();

const BASE_URL = `http://localhost:${DEV_PORT}`;

// Say which server this run is about to drive, on EVERY run. The defect this
// file fixes was invisible precisely because the output looked normal, so the
// port and the reuse decision are worth one line of noise forever.
console.log(
  `[playwright] ${BASE_URL} — ${
    REUSE_EXISTING_SERVER
      ? "reusing this checkout's running dev server"
      : "starting our own dev server"
  } (checkout ${CHECKOUT_ROOT})`,
);

if (!REUSE_EXISTING_SERVER) {
  const squatters = portOwners(DEV_PORT);
  if (squatters.length > 0) {
    console.warn(
      `[playwright] port ${DEV_PORT} is held by a process outside this checkout ` +
        `(${squatters.join(", ")}). Refusing to test someone else's server — see ENG-597. ` +
        `Stop that process, or run with an explicit PORT=<free port>.`,
    );
  }
}

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL: BASE_URL,
  },
  webServer: {
    // --port is passed explicitly as well as via env so Next cannot fall back to
    // its default port and leave Playwright waiting on a URL nothing serves.
    command: `npm run dev -- --port ${DEV_PORT}`,
    // Pin the server to THIS checkout. Without it a stray cwd serves another
    // branch's pages under our baseURL, which is the defect this file fixes.
    cwd: CHECKOUT_ROOT,
    url: BASE_URL,
    reuseExistingServer: REUSE_EXISTING_SERVER,
    // Cold-starting our own dev server is now the common path (we no longer
    // borrow a sibling's warm one), so allow for a first compile.
    timeout: 180_000,
    env: {
      PORT: String(DEV_PORT),
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? LOCAL_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? LOCAL_SUPABASE_ANON_KEY,
      // ENG-730: the marketing trainer roster is cached for 5 minutes by default,
      // and that cache is FILE-BACKED under `.next/` — it outlives a dev-server
      // restart. A spec that seeds trainers would otherwise be served the roster
      // cached by the PREVIOUS run and fail for a reason nothing in the test
      // mentions. `0` disables the cache for the test server only.
      MARKETING_TRAINERS_REVALIDATE_SECONDS: process.env.MARKETING_TRAINERS_REVALIDATE_SECONDS ?? "0",
    },
  },
});
