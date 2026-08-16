#!/usr/bin/env node
/**
 * Freeze the marketing home's copy into a committed fixture (ENG-588).
 *
 * WHY THIS EXISTS
 * The signed-off mockup lives in a sibling design tree (`10-marketing-site/`)
 * that is deliberately NOT in this repo — it is 4.75 MB of inlined data URIs.
 * So the strongest guard in test/marketing-home.test.tsx, the block-for-block
 * copy diff, can only run on a machine that happens to have that tree. On CI, or
 * any fresh clone, it skips and the copy freeze silently stops being enforced.
 *
 * This script distills the mockup down to just the text runs, ids, classes and
 * image sources of the twelve sections — a few tens of KB — and commits that as
 * the fixture. The test then works in two layers:
 *
 *   1. rendered  vs fixture  — ALWAYS runs, including CI. This is the freeze.
 *   2. fixture   vs mockup   — runs only where the design tree is present, and
 *                              proves the fixture has not drifted from the design.
 *
 * Neither layer alone is enough: (1) without (2) would happily freeze a typo,
 * and (2) without (1) is invisible off a developer laptop.
 *
 * Regenerate after a signed-off copy change (and only then):
 *   node scripts/extract-marketing-copy.mjs
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(REPO, "test", "fixtures", "marketing-copy.json");
const MOCKUP_SUFFIX = "10-marketing-site/deploy/src/mockup.html";

function findMockup() {
  let dir = REPO;
  for (;;) {
    const candidate = path.join(dir, MOCKUP_SUFFIX);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const MIME_EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/** Replay W1's extraction naming so `src` values match what the page renders. */
export function inlineToExtracted(html) {
  return html.replace(/data:(image\/[a-z.+-]+);base64,([A-Za-z0-9+/=\s]+)/g, (_m, mime, b64) => {
    const bytes = Buffer.from(b64.replace(/\s+/g, ""), "base64");
    return `/marketing/${createHash("md5").update(bytes).digest("hex").slice(0, 8)}.${MIME_EXT[mime] ?? "bin"}`;
  });
}

const mockup = findMockup();
if (!mockup) {
  console.error(`Could not find ${MOCKUP_SUFFIX} above ${REPO}.`);
  console.error("This script needs the design tree; it is the only thing that can refresh the fixture.");
  process.exit(1);
}

const dom = new JSDOM(inlineToExtracted(readFileSync(mockup, "utf8")));
const { document } = dom.window;

const norm = (s) => (s ?? "").replace(/\s+/g, " ").trim();

function textRuns(root) {
  const walker = document.createTreeWalker(root, dom.window.NodeFilter.SHOW_TEXT);
  const out = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = norm(node.nodeValue);
    if (text) out.push(text);
  }
  return out;
}

const blocks = [...document.querySelectorAll("header.hero, .ribbon, section")]
  .filter((el) => el.parentElement?.matches("body"))
  .map((el) => ({
    signature: `${el.tagName.toLowerCase()}#${el.id}.${norm(el.className)}`,
    runs: textRuns(el),
    images: [...el.querySelectorAll("img")].map((img) => img.getAttribute("src")),
  }));

if (blocks.length !== 13) {
  console.error(`Expected 13 blocks (12 sections + the hero ribbon), found ${blocks.length}. Refusing to write.`);
  process.exit(1);
}

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ source: MOCKUP_SUFFIX, blocks }, null, 2) + "\n");

const runs = blocks.reduce((n, b) => n + b.runs.length, 0);
console.log(`Wrote ${path.relative(REPO, OUT)} — ${blocks.length} blocks, ${runs} text runs.`);
