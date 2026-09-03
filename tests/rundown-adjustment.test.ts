import assert from "node:assert/strict";
import test from "node:test";
import { parseMusicSearchAdjustment } from "../src/core/rundown-adjustment.js";

test("music chat recognizes artist and song search requests", () => {
  assert.deepEqual(parseMusicSearchAdjustment("帮我找周杰伦的歌曲。"), { query: "周杰伦", count: 2 });
  assert.deepEqual(parseMusicSearchAdjustment("想听一首方大同的歌"), { query: "方大同", count: 1 });
  assert.deepEqual(parseMusicSearchAdjustment("加一些电子摇滚歌曲"), { query: "电子摇滚", count: 3 });
});

test("ordinary sequencing requests remain model-driven", () => {
  assert.equal(parseMusicSearchAdjustment("把节奏强的放到后半段"), null);
  assert.equal(parseMusicSearchAdjustment("整体更流畅一点"), null);
});
