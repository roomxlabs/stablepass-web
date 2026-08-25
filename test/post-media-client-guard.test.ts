// ENG-799 cutover guard: client islands must never mint post-media bytes by
// signing a client-supplied path, and must never talk to the edge function URL
// directly (guardrail 1). After D (ENG-800) direct signs go dark anyway.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = [join("app", "(member)"), "components"];
const SKIP = new Set(["__tests__", "node_modules", "test"]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe("guardrail — no client post-media signing or edge URL", () => {
  const files = ROOTS.flatMap((r) => sourceFiles(join(process.cwd(), r)));

  it("scans a non-trivial set of client islands", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("never calls storage.from('post-media') / from(POST_MEDIA_BUCKET) with createSignedUrl", () => {
    const fromPattern = /\.from\(\s*(['"]post-media['"]|POST_MEDIA_BUCKET)\s*\)/;
    const offenders = files.filter((f) => fromPattern.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("never imports the edge-function URL or functions/v1/post-media", () => {
    const edgePattern = /functions\/v1\/post-media|NEXT_PUBLIC_SUPABASE_URL.*post-media/;
    const offenders = files.filter((f) => edgePattern.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
