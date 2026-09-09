import test from "node:test";
import assert from "node:assert/strict";

import { dbToGain, HOST_MUSIC_DUCK_DB, HOST_MUSIC_DUCK_VOLUME, HOST_MUSIC_RESTORE_DURATION_MS } from "../src/core/host-script-planning.js";
import { advanceEnvelopeElapsed, envelopeVolume, musicBedDelayRemainingMs } from "../src/web/audio-envelope.js";

test("music duck and restore envelopes are continuous and finish at the requested volume", () => {
  assert.equal(HOST_MUSIC_DUCK_DB, -5);
  assert.equal(Number(HOST_MUSIC_DUCK_VOLUME.toFixed(4)), 0.5623);
  assert.equal(HOST_MUSIC_RESTORE_DURATION_MS, 2_000);
  const duck = [0, 200, 400, 600, 800].map((elapsed) => envelopeVolume(1, HOST_MUSIC_DUCK_VOLUME, elapsed, 800));
  assert.deepEqual(duck.map((value) => Number(value.toFixed(4))), [1, 0.9316, 0.7812, 0.6307, 0.5623]);
  assert.ok(duck.every((value, index) => index === 0 || value < duck[index - 1]!));

  const restore = [0, 500, 1000, 1500, 2000].map((elapsed) => envelopeVolume(HOST_MUSIC_DUCK_VOLUME, 1, elapsed, HOST_MUSIC_RESTORE_DURATION_MS));
  assert.deepEqual(restore.map((value) => Number(value.toFixed(4))), [0.5623, 0.6307, 0.7812, 0.9316, 1]);
  assert.ok(restore.every((value, index) => index === 0 || value > restore[index - 1]!));
});

test("duck gain is calculated from decibels instead of a raw percentage", () => {
  assert.equal(dbToGain(0), 1);
  assert.equal(Number(dbToGain(-5).toFixed(4)), 0.5623);
  assert.equal(dbToGain(Number.NaN), 1);
});

test("volume envelopes clamp their temporal boundaries", () => {
  assert.equal(envelopeVolume(1, HOST_MUSIC_DUCK_VOLUME, -1, 800), 1);
  assert.equal(envelopeVolume(1, HOST_MUSIC_DUCK_VOLUME, 900, 800), HOST_MUSIC_DUCK_VOLUME);
  assert.equal(envelopeVolume(HOST_MUSIC_DUCK_VOLUME, 1, 1, 0), 1);
});

test("volume ramp advances in small fixed steps instead of jumping after a delayed frame", () => {
  let elapsed = advanceEnvelopeElapsed(0, 50, 2000);
  assert.equal(elapsed, 50);
  assert.ok(envelopeVolume(HOST_MUSIC_DUCK_VOLUME, 1, elapsed, 2000) < 0.5634);
  for (let index = 1; index < 40; index += 1) elapsed = advanceEnvelopeElapsed(elapsed, 50, 2000);
  assert.equal(elapsed, 2000);
  assert.equal(envelopeVolume(HOST_MUSIC_DUCK_VOLUME, 1, elapsed, 2000), 1);
});

test("music bed waits for five seconds of actual host playback", () => {
  assert.equal(musicBedDelayRemainingMs(0, 5), 5_000);
  assert.equal(musicBedDelayRemainingMs(2.35, 5), 2_650);
  assert.equal(musicBedDelayRemainingMs(4.999, 5), 1);
  assert.equal(musicBedDelayRemainingMs(5, 5), 0);
  assert.equal(musicBedDelayRemainingMs(8, 5), 0);
});
