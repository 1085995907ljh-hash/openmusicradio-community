import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

interface DecodedPng {
  width: number;
  height: number;
  data: Buffer;
}

const require = createRequire(import.meta.url);
const { PNG } = require("pngjs") as { PNG: { sync: { read(input: Buffer): DecodedPng } } };

const spritePaths = [
  "public/hosts/animated/longxin/music.png",
  "public/hosts/animated/longxin/speaking.png",
];

test("Long Xin desktop sprites keep six transparent frames without a light edge halo", async () => {
  for (const path of spritePaths) {
    const png = PNG.sync.read(await readFile(path));
    assert.equal(png.width, 1536, `${path} must keep six 256px frames`);
    assert.equal(png.height, 384);

    let lightEdgePixels = 0;
    const alphaAt = (x: number, y: number) => png.data[(y * png.width + x) * 4 + 3];
    for (let y = 0; y < png.height; y += 1) {
      for (let x = 0; x < png.width; x += 1) {
        const offset = (y * png.width + x) * 4;
        const [red, green, blue, alpha] = png.data.subarray(offset, offset + 4);
        if (alpha === 0) continue;
        const touchesTransparency = [
          [x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1],
        ].some(([nextX, nextY]) => nextX < 0 || nextY < 0 || nextX >= png.width || nextY >= png.height || alphaAt(nextX, nextY) === 0);
        if (touchesTransparency && Math.min(red, green, blue) > 145 && Math.max(red, green, blue) - Math.min(red, green, blue) < 55) {
          lightEdgePixels += 1;
        }
      }
    }
    assert.ok(lightEdgePixels < 100, `${path} still has ${lightEdgePixels} light halo pixels`);
  }
});
