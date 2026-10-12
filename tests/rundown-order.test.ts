import test from "node:test";
import assert from "node:assert/strict";
import { arrangeRundown } from "../src/core/rundown-order.js";
import type { ProgramRundownItem } from "../src/shared/contracts.js";

function song(id: string, values: Partial<ProgramRundownItem> = {}): ProgramRundownItem {
  return {
    id, title: id, artist: id, durationSeconds: 180, energy: 0.5,
    energyMeasured: false, mood: [], color: "", sourceId: "netease_music",
    reasons: [], liked: false, ...values,
  };
}

test("grouped input becomes distributed for all ratios without changing membership or mutating input", () => {
  for (let total = 1; total <= 35; total += 1) {
    for (let count = 0; count <= total; count += 1) {
      const input = Array.from({ length: total }, (_, index) => song(String(index), {
        liked: index < count,
        // Even a strong musical preference for one pool must not recreate blocks.
        mood: [index < count ? "calm" : "bright"],
        durationSeconds: 100 + index * 13,
      }));
      const snapshot = structuredClone(input);
      const output = arrangeRundown(input, "late_night");
      assert.deepEqual(input, snapshot);
      assert.deepEqual(output.map((item) => item.id).sort(), input.map((item) => item.id).sort());
      assert.equal(output.reduce((sum, item) => sum + item.durationSeconds, 0), input.reduce((sum, item) => sum + item.durationSeconds, 0));
      let familiar = 0;
      output.forEach((item, index) => {
        familiar += Number(item.liked === true);
        assert.ok(Math.abs(familiar - (index + 1) * count / total) < 1, `${count}/${total} at ${index}`);
      });
      assert.deepEqual(arrangeRundown(input, "late_night"), output);
    }
  }
  assert.deepEqual(arrangeRundown([], "late_night"), []);
});

test("musical continuity permits a short discovery passage then selects a familiar bridge", () => {
  const input = [
    song("anchor", { liked: true, mood: ["calm"], styleTags: ["folk"] }),
    song("discovery", { mood: ["bright"], styleTags: ["rock"] }),
    song("bridge", { liked: true, mood: ["calm"], styleTags: ["folk", "rock"] }),
    song("discovery2", { mood: ["bright"], styleTags: ["rock"] }),
    song("discovery3", { mood: ["bright"], styleTags: ["rock"] }),
  ];
  const output = arrangeRundown(input, "late_night");
  // Keep two matching discovery songs together, then use the closest familiar bridge.
  assert.equal(output[0].id, "discovery");
  assert.equal(output[1].id, "discovery2");
  assert.equal(output[2].id, "bridge");
  assert.ok(output[2].reasons.includes("与上一首有共同风格标签"));
});

test("single-category lists still use mood and style continuity", () => {
  for (const liked of [true, false]) {
    const input = [
      song("first", { liked, mood: ["calm"], styleTags: ["jazz"] }),
      song("unrelated", { liked, mood: ["intense"], styleTags: ["rock"] }),
      song("related", { liked, mood: ["calm"], styleTags: ["jazz"] }),
    ];
    assert.deepEqual(arrangeRundown(input, "late_night").map((item) => item.id), ["first", "related", "unrelated"]);
  }
});

test("unknown energy is ignored and no musical claims are invented", () => {
  const input = [song("a", { energy: 1 }), song("b", { energy: 0 }), song("c")];
  for (const scene of ["late_night", "party"] as const) {
    const output = arrangeRundown(input, scene);
    assert.deepEqual(output.map((item) => item.id), ["a", "b", "c"]);
    assert.ok(output.every((item) => item.reasons.every((reason) => !/能量|共同/.test(reason))));
  }
});

test("known energy follows the scene and prefers a gradual transition", () => {
  const input = [
    song("soft", { energy: 0.25, energyMeasured: true }),
    song("loud", { energy: 0.9, energyMeasured: true }),
    song("middle", { energy: 0.4, energyMeasured: true }),
  ];
  const relaxed = arrangeRundown(input, "late_night");
  assert.deepEqual(relaxed.map((item) => item.id), ["soft", "middle", "loud"]);
  assert.notEqual(arrangeRundown(input, "party")[0].id, "soft");
  assert.ok(relaxed[1].reasons.includes("与上一首的能量变化较小"));
});

test("adjacent artists are separated when alternatives exist", () => {
  const input = [song("a", { artist: "Same" }), song("b", { artist: " same " }), song("c", { artist: "Other" })];
  assert.deepEqual(arrangeRundown(input, "study").map((item) => item.id), ["a", "c", "b"]);
});
