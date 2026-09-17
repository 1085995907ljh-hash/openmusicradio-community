import test from "node:test";
import assert from "node:assert/strict";

import { dbToGain, HOST_MUSIC_DUCK_DB, HOST_MUSIC_DUCK_VOLUME, HOST_MUSIC_RESTORE_DURATION_MS } from "../src/core/host-script-planning.js";
import { musicBedDelayRemainingMs } from "../src/web/audio-envelope.js";

test("host speech uses a quiet music bed and a two-second restore", () => {
  assert.equal(HOST_MUSIC_DUCK_DB, -10);
  assert.equal(Number(HOST_MUSIC_DUCK_VOLUME.toFixed(4)), 0.3162);
  assert.equal(HOST_MUSIC_RESTORE_DURATION_MS, 2_000);
});

test("duck gain is calculated from decibels instead of a raw percentage", () => {
  assert.equal(dbToGain(0), 1);
  assert.equal(Number(dbToGain(-5).toFixed(4)), 0.5623);
  assert.equal(dbToGain(Number.NaN), 1);
});

test("music bed waits for five seconds of actual host playback", () => {
  assert.equal(musicBedDelayRemainingMs(0, 5), 5_000);
  assert.equal(musicBedDelayRemainingMs(2.35, 5), 2_650);
  assert.equal(musicBedDelayRemainingMs(4.999, 5), 1);
  assert.equal(musicBedDelayRemainingMs(5, 5), 0);
  assert.equal(musicBedDelayRemainingMs(8, 5), 0);
});
