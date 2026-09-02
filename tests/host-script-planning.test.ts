import test from "node:test";
import assert from "node:assert/strict";

import {
  evenlySpacedHostBreakIndices,
  hostCharacterBounds,
  hostScriptRepeats,
  normalizeSpokenEnglishCase,
  normalizeSpokenYearDigits,
  planHostBreak,
  planHostDurationTargets,
  radioGreetingAt,
  middleHostBreakCount,
  middleHostBreakCountIsAcceptable,
  releaseTitlesMatch,
  spokenArtistName,
} from "../src/core/host-script-planning.js";
import type { Track } from "../src/shared/contracts.js";

const track = (energy: number, mood: string[] = []): Track => ({
  id: `track-${energy}`,
  title: "测试歌曲",
  artist: "测试艺人",
  durationSeconds: 210,
  energy,
  mood,
  color: "#000000",
});

test("host break planning keeps fast transitions short and documented long intros longer", () => {
  const fast = planHostBreak({
    mode: "artist_spotlight",
    scenePreset: "party",
    programPhase: "building",
    previousTrack: track(0.4),
    currentTrack: track(0.9, ["高能", "快节奏"]),
  });
  const longIntro = planHostBreak({
    mode: "verified_story",
    scenePreset: "late_night",
    programPhase: "cooldown",
    previousTrack: track(0.7),
    currentTrack: track(0.2, ["舒缓"]),
    facts: ["资料明确记载这首作品用一段较长前奏缓慢铺陈。"],
  });

  assert.deepEqual(fast, { durationSeconds: 20, musicBedDelaySeconds: 5 });
  assert.deepEqual(longIntro, { durationSeconds: 35, musicBedDelaySeconds: 5 });
  assert.deepEqual(hostCharacterBounds(10), { min: 28, max: 37 });
  assert.deepEqual(hostCharacterBounds(25), { min: 70, max: 93 });
  assert.deepEqual(hostCharacterBounds(35), { min: 98, max: 130 });
});

test("whole-show host durations keep liked songs short and exploration songs detailed", () => {
  assert.deepEqual(planHostDurationTargets([]), []);
  assert.deepEqual(planHostDurationTargets([false, false, false, false]), [14, 18, 14, 18]);
  assert.deepEqual(planHostDurationTargets([true, true, true, true]), [28, 34, 28, 34]);
  const targets = planHostDurationTargets([false, true, false, true]);
  assert.deepEqual(targets, [14, 28, 18, 34]);

  for (const targetDurationSeconds of targets) {
    const plan = planHostBreak({
      mode: "artist_spotlight",
      scenePreset: "study",
      programPhase: "building",
      previousTrack: track(0.4),
      currentTrack: track(0.6),
      targetDurationSeconds,
    });
    assert.equal(plan.durationSeconds, targetDurationSeconds);
    assert.equal(plan.musicBedDelaySeconds, 5);
  }

  const sparse = planHostBreak({
    mode: "artist_spotlight",
    scenePreset: "study",
    programPhase: "building",
    previousTrack: track(0.4),
    currentTrack: track(0.6),
    targetDurationSeconds: 15,
  });
  assert.deepEqual(sparse, { durationSeconds: 15, musicBedDelaySeconds: 5 });
});

test("radio greeting follows the server's local hour", () => {
  assert.equal(radioGreetingAt(new Date(2026, 7, 24, 8)), "早上好");
  assert.equal(radioGreetingAt(new Date(2026, 7, 24, 17)), "下午好");
  assert.equal(radioGreetingAt(new Date(2026, 7, 24, 21)), "晚上好");
  assert.equal(radioGreetingAt(new Date(2026, 7, 24, 2)), "夜深了");
});

test("spoken English uses title case without damaging abbreviations or brand casing", () => {
  assert.equal(
    normalizeSpokenEnglishCase("《BLUE》来自 ONE RADIO，保留 R&B、iPhone 和 Tom Misch。"),
    "《Blue》来自 One Radio，保留 R&B、iPhone 和 Tom Misch。",
  );
  assert.equal(normalizeSpokenEnglishCase("I'M NOT GOOD"), "I'm Not Good");
});

test("spoken years use Arabic digits for TTS stability", () => {
  assert.equal(normalizeSpokenYearDigits("这首歌发行于二〇一七年，后来在二零二四年重新被提起。"), "这首歌发行于2017年，后来在2024年重新被提起。");
  assert.equal(normalizeSpokenYearDigits("保留十七年和2017年这种写法。"), "保留十七年和2017年这种写法。");
});

test("low medium and high host frequency produce distinct whole-show placement counts", () => {
  assert.equal(middleHostBreakCount(10, "low"), 3);
  assert.equal(middleHostBreakCount(10, "medium"), 5);
  assert.equal(middleHostBreakCount(10, "high"), 6);
  assert.equal(middleHostBreakCountIsAcceptable(10, "medium", 4), true);
  assert.equal(middleHostBreakCountIsAcceptable(10, "medium", 5), true);
  assert.equal(middleHostBreakCountIsAcceptable(10, "medium", 6), true);
  assert.equal(middleHostBreakCountIsAcceptable(10, "medium", 3), false);
  assert.deepEqual(evenlySpacedHostBreakIndices(1, "low"), [0]);
  for (const frequency of ["low", "medium", "high"] as const) {
    const positions = evenlySpacedHostBreakIndices(10, frequency);
    assert.equal(positions[0], 0);
    assert.equal(positions.at(-1), 9);
    assert.equal(new Set(positions).size, positions.length);
    assert.equal(positions.length, middleHostBreakCount(10, frequency) + 2);
  }
});

test("same-title single releases are omitted while distinct albums remain visible", () => {
  assert.equal(releaseTitlesMatch("Let Me Go", "Let Me Go"), true);
  assert.equal(releaseTitlesMatch("Let Me Go", "Let Me Go - Single"), true);
  assert.equal(releaseTitlesMatch("Let Me Go", "CASE STUDY 01"), false);
});

test("spoken artist names prefer an existing Chinese stage name over a long romanized alias", () => {
  assert.equal(spokenArtistName("功夫胖 KUNGFU-PEN"), "功夫胖");
  assert.equal(spokenArtistName("KUNGFU-PEN（功夫胖）"), "功夫胖");
  assert.equal(spokenArtistName("GAI周延"), "GAI周延");
  assert.equal(spokenArtistName("Daniel Caesar"), "Daniel Caesar");
});

test("whole-show audit rejects repeated wording and repeated sentence frames", () => {
  const previous = "这一段由功夫胖带来。马上要播的是《山歌王》，先听第一拍怎样落下来。";
  assert.equal(hostScriptRepeats(previous, [previous]), true);
  assert.equal(hostScriptRepeats("这一段由另一位歌手带来。马上要播的是《另一首歌》，先听第一拍怎样落下来。", [previous]), true);
  assert.equal(hostScriptRepeats("先别看歌名，听鼓点从远处推近；答案让开场自己揭晓。", [previous]), false);
});
