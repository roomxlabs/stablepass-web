import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The tab icon is shipped as App Router metadata files, so there is no <head>
// markup to assert on — the FILES are the contract. This guards the regression
// the change fixed: create-next-app's starter favicon sitting on the member app
// while stablepass-admin already showed the StablePass "S." mark.
// cwd, not import.meta.url: vitest's transform gives the module a virtual path,
// so a URL relative to it does not resolve on disk.
const asset = (name: string) => readFileSync(resolve(process.cwd(), "app", name));

// PNG: 8-byte magic, then the IHDR chunk carries width/height as big-endian u32.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function pngSize(buf: Buffer) {
  expect(buf.subarray(0, 8)).toEqual(PNG_MAGIC);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// ICO: 6-byte header (reserved, type, image count) then one 16-byte entry per
// image; a stored 0 in the width/height byte means 256.
function icoSizes(buf: Buffer): string[] {
  expect(buf.readUInt16LE(0)).toBe(0); // reserved
  expect(buf.readUInt16LE(2)).toBe(1); // type 1 = icon
  return Array.from({ length: buf.readUInt16LE(4) }, (_, i) => {
    const o = 6 + i * 16;
    return `${buf[o] || 256}x${buf[o + 1] || 256}`;
  });
}

describe("brand tab icons", () => {
  it("ships icon.png at 512 for modern browsers", () => {
    expect(pngSize(asset("icon.png"))).toEqual({ width: 512, height: 512 });
  });

  it("ships apple-icon.png at 180 for the iOS home screen", () => {
    expect(pngSize(asset("apple-icon.png"))).toEqual({ width: 180, height: 180 });
  });

  // The discriminator against the starter is the SIZE LADDER, not the presence
  // of a large entry: create-next-app's favicon.ico also carries 48 and 256, but
  // only four entries (16/32/48/256). The brand icon carries six.
  it("ships a favicon.ico with the full 16->256 ladder, not the starter's four sizes", () => {
    expect(icoSizes(asset("favicon.ico"))).toEqual([
      "16x16",
      "32x32",
      "48x48",
      "64x64",
      "128x128",
      "256x256",
    ]);
  });
});
