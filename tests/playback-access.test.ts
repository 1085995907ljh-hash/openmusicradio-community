import assert from "node:assert/strict";
import test from "node:test";
import { isCompleteAccountPlayback } from "../src/core/playback-access.js";

test("current-account playback accepts a complete authorized song", () => {
  assert.equal(isCompleteAccountPlayback({ url: "https://music.example/song.mp3", complete: true, authorizationCode: 0, durationMs: 200_000 }, 200_000), true);
});

test("current-account playback rejects membership failures and trial audio", () => {
  assert.equal(isCompleteAccountPlayback({ url: null }, 200_000), false);
  assert.equal(isCompleteAccountPlayback({ url: "https://music.example/trial.mp3", isTrial: true, durationMs: 30_000 }, 200_000), false);
  assert.equal(isCompleteAccountPlayback({ url: "https://music.example/song.mp3", complete: false }, 200_000), false);
  assert.equal(isCompleteAccountPlayback({ url: "https://music.example/song.mp3", authorizationCode: 104003 }, 200_000), false);
});

test("current-account playback rejects an unmarked short preview", () => {
  assert.equal(isCompleteAccountPlayback({ url: "https://music.example/preview.mp3", durationMs: 30_000 }, 200_000), false);
  assert.equal(isCompleteAccountPlayback({ url: "https://music.example/song.mp3", durationMs: 185_000 }, 200_000), true);
});
