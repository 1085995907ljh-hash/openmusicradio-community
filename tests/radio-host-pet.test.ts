import test from "node:test";
import assert from "node:assert/strict";

import { resolveRadioHostPetMood } from "../src/web/radio-host-pet.js";

test("radio host pet reflects actual program and audio activity", () => {
  assert.equal(resolveRadioHostPetMood({ view: "setup" }), "idle");
  assert.equal(resolveRadioHostPetMood({ view: "setup", creating: true }), "preparing");
  assert.equal(resolveRadioHostPetMood({ view: "confirm" }), "preparing");
  assert.equal(resolveRadioHostPetMood({ view: "on_air", programStatus: "on_air", audioPlaying: false }), "paused");
  assert.equal(resolveRadioHostPetMood({ view: "on_air", programStatus: "on_air", audioPlaying: true }), "listening");
  assert.equal(resolveRadioHostPetMood({ view: "on_air", programStatus: "on_air", hostStatus: "playing", audioPlaying: true }), "speaking");
  assert.equal(resolveRadioHostPetMood({ view: "on_air", programStatus: "on_air", hostStatus: "playing", nexting: true }), "transition");
  assert.equal(resolveRadioHostPetMood({ view: "on_air", programStatus: "closing", audioPlaying: false }), "closing");
});

test("terminal and error states take precedence over transient activity", () => {
  assert.equal(resolveRadioHostPetMood({ view: "ended", programStatus: "completed", nexting: true }), "ended");
  assert.equal(resolveRadioHostPetMood({ view: "on_air", programStatus: "failed", hostStatus: "playing" }), "error");
  assert.equal(resolveRadioHostPetMood({ view: "on_air", programStatus: "on_air", hostStatus: "failed", audioPlaying: true }), "error");
});
