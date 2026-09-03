import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";

import { SCENE_PRESETS } from "../src/shared/contracts.js";
import {
  SCENE_CONFIGS,
  buildProgramPlan,
  buildProgramSpec,
  boostedHostTtsVolume,
  energyRangeForPhase,
} from "../src/core/scenes.js";
import { DEFAULT_HOST_PROFILE, HOST_DURATION_REACHED_TEXT, HOST_PROFILE_IDS, HOST_PROFILES, hostDurationReachedCueUrl, hostPreviewText, hostTtsInstruction, hostTtsPersona } from "../src/shared/program-options.js";

test("the five scene presets are complete and materially different", () => {
  assert.deepEqual(Object.keys(SCENE_CONFIGS).sort(), [...SCENE_PRESETS].sort());

  const configs = SCENE_PRESETS.map((preset) => SCENE_CONFIGS[preset]);
  assert.deepEqual(configs.map((config) => config.label), ["放松", "专注", "运动", "律动", "派对"]);
  assert.equal(new Set(configs.map((config) => config.sceneDescription)).size, 5);
  assert.equal(new Set(configs.map((config) => config.energyCurve)).size, 5);
  assert.equal(new Set(configs.map((config) => config.ttsDirection)).size, 5);
  assert.equal(new Set(configs.map((config) => config.hostLanguageDirection)).size, 5);
  assert.equal(new Set(configs.map((config) => JSON.stringify(config.ttsParameters))).size, 5);

  for (const config of configs) {
    assert.ok(config.sentenceSeconds.min > 0);
    assert.ok(config.sentenceSeconds.max >= config.sentenceSeconds.min);
    for (const phase of ["opening", "building", "peak", "cooldown", "closing"] as const) {
      const range = config.energyByPhase[phase];
      assert.ok(range.min >= 0 && range.max <= 1 && range.max >= range.min);
      assert.deepEqual(energyRangeForPhase(config.preset, phase), range);
    }
  }
});

test("host TTS volume is boosted at the synthesis source without mutating scene baselines", () => {
  assert.equal(boostedHostTtsVolume(SCENE_CONFIGS.late_night.ttsParameters.volume), 54);
  assert.equal(SCENE_CONFIGS.late_night.ttsParameters.volume, 48);
  assert.equal(boostedHostTtsVolume(98), 100);
});

test("host order keeps the radio lineup readable and exposes all fixed voices", () => {
  assert.deepEqual(HOST_PROFILE_IDS, ["longhao", "xiaocheng", "longxin", "anxuan", "anya", "anran"]);
  assert.equal(DEFAULT_HOST_PROFILE, "longhao");
  assert.deepEqual(HOST_PROFILE_IDS.map((profileId) => hostPreviewText(profileId)), [
    "欢迎收听 Open Music Radio 电台，我是主持人龙浩。",
    "欢迎收听 Open Music Radio 电台，我是主持人龙小诚。",
    "欢迎收听 Open Music Radio 电台，我是主持人龙鑫。",
    "欢迎收听 Open Music Radio 电台，我是主持人龙安宣。",
    "欢迎收听 Open Music Radio 电台，我是主持人龙安雅。",
    "欢迎收听 Open Music Radio 电台，我是主持人龙安燃。",
  ]);
  assert.equal(new Set(HOST_PROFILE_IDS.map((profileId) => HOST_PROFILES[profileId].mbti)).size, 6);
  assert.equal(HOST_PROFILES.longhao.model, "qwen-audio-3.0-tts-plus");
  assert.equal(HOST_PROFILES.longhao.voice, "qwen-audio-3.0-tts-plus-longhuifengyi");
  assert.equal(HOST_PROFILES.longxin.model, "qwen-audio-3.0-tts-plus");
  assert.equal(HOST_PROFILES.longxin.voice, "qwen-audio-3.0-tts-plus-longhexuanlan");
  assert.equal(HOST_PROFILES.longxin.ttsRate, 1.02);
  assert.equal(HOST_PROFILES.anya.model, "qwen-audio-3.0-tts-plus");
  assert.equal(HOST_PROFILES.anya.voice, "qwen-audio-3.0-tts-plus-longchenghongling");
  assert.equal(HOST_PROFILES.anran.ttsRate, 1.01);
});

test("each host profile has a static voice preview package", async () => {
  await Promise.all(HOST_PROFILE_IDS.map((profileId) => access(new URL(`../public/hosts/previews/${profileId}.mp3`, import.meta.url), constants.R_OK)));
});

test("each host profile has a fixed duration-reached voice cue", async () => {
  assert.equal(HOST_DURATION_REACHED_TEXT, "本档节目设定的时间到了，听完这首歌，我们就结束今天的节目。");
  await Promise.all(HOST_PROFILE_IDS.map(async (profileId) => {
    assert.equal(hostDurationReachedCueUrl(profileId), `/hosts/cues/duration-reached/${profileId}.mp3`);
    const url = new URL(`../public${hostDurationReachedCueUrl(profileId)}`, import.meta.url);
    await access(url, constants.R_OK);
    const audio = await readFile(url);
    assert.ok(audio.byteLength > 50_000);
    assert.equal(audio.subarray(0, 3).toString("ascii"), "ID3");
  }));
});

test("host TTS instructions preserve personality for middle and closing breaks", () => {
  assert.match(hostTtsPersona("longhao"), /情绪稳定/);
  assert.match(hostTtsPersona("longhao"), /语速中等/);
  assert.match(hostTtsPersona("longhao"), /深情/);
  assert.doesNotMatch(hostTtsPersona("longhao"), /慢半拍|中等偏慢/);

  assert.match(hostTtsPersona("longxin"), /龙鑫/);
  assert.match(hostTtsPersona("longxin"), /清爽阳光/);
  assert.match(hostTtsPersona("longxin"), /大学生音乐博主/);
  assert.match(hostTtsPersona("longxin"), /笑意/);

  const middle = hostTtsInstruction("longxin", "next_preview", "语速略快，歌名稍加重。");
  assert.match(middle, /龙鑫/);
  assert.match(middle, /清爽阳光/);
  assert.match(middle, /节目中段串联/);
  assert.match(middle, /语速略快/);

  const closing = hostTtsInstruction("anya", "song_note", "句尾收住。");
  assert.match(closing, /龙安雅/);
  assert.match(closing, /语速中等/);
  assert.doesNotMatch(hostTtsPersona("anya"), /中等偏慢/);
  assert.match(closing, /收束感/);
  assert.match(closing, /句尾收住/);
});

test("program specs inherit the selected scene and do not share mutable arrays", () => {
  const spec = buildProgramSpec({
    sourceId: "fixture",
    durationMinutes: 30,
    scenePreset: "late_night",
  });

  assert.equal(spec.scenePreset, "late_night");
  assert.equal(spec.hostDensity, SCENE_CONFIGS.late_night.hostDensity);
  assert.equal(spec.energyCurve, SCENE_CONFIGS.late_night.energyCurve);
  assert.equal(spec.sceneDescription, SCENE_CONFIGS.late_night.sceneDescription);
  assert.equal(spec.familiarityRatio, 40);

  spec.avoid.push("test-only mutation");
  assert.equal(SCENE_CONFIGS.late_night.avoid.includes("test-only mutation"), false);
  const tuned = buildProgramSpec({ durationMinutes: 30, scenePreset: "late_night", familiarityRatio: 73, hostProfile: "anya", musicGenres: ["jazz", "rnb_soul"] });
  assert.equal(tuned.familiarityRatio, 73);
  assert.equal(tuned.hostProfile, "anya");
  assert.equal(tuned.recommendationMode, "genre");
  assert.deepEqual(tuned.musicGenres, ["jazz", "rnb_soul"]);
  tuned.musicGenres?.push("rock");
  assert.deepEqual(buildProgramSpec({ durationMinutes: 30, scenePreset: "late_night", musicGenres: ["jazz", "rnb_soul"] }).musicGenres, ["jazz", "rnb_soul"]);
  assert.equal(buildProgramSpec({ durationMinutes: 30, scenePreset: "late_night", recommendationMode: "atmosphere", musicGenres: ["jazz", "rnb_soul"] }).musicGenres?.length, 0);
  assert.equal(buildProgramSpec({ durationMinutes: 30, scenePreset: "late_night" }).desktopPetEnabled, false);
  assert.equal(buildProgramSpec({ durationMinutes: 30, scenePreset: "late_night", desktopPetEnabled: true }).desktopPetEnabled, true);
});

test("each program plan exposes all phases and the scene-specific TTS direction", () => {
  const plans = SCENE_PRESETS.map((scenePreset) =>
    buildProgramPlan(buildProgramSpec({ durationMinutes: 30, scenePreset })),
  );

  for (const plan of plans) {
    assert.deepEqual(
      plan.phases.map((phase) => phase.phase),
      ["opening", "building", "peak", "cooldown", "closing"],
    );
    assert.equal(plan.phases[0].startFraction, 0);
    assert.equal(plan.phases.at(-1)?.endFraction, 1);
    for (let index = 1; index < plan.phases.length; index += 1) {
      assert.equal(plan.phases[index - 1].endFraction, plan.phases[index].startFraction);
    }
    assert.ok(plan.summary.includes(plan.sceneLabel));
    assert.ok(plan.summary.includes(plan.hostDensity));
  }

  assert.equal(new Set(plans.map((plan) => plan.ttsDirection)).size, 5);
  assert.equal(new Set(plans.map((plan) => plan.hostLanguageDirection)).size, 5);
});

test("unknown scene presets are rejected instead of silently falling back", () => {
  assert.throws(
    () => buildProgramSpec({ durationMinutes: 30, scenePreset: "unknown" as never }),
    /Unknown scene preset/,
  );
  assert.throws(
    () => buildProgramPlan({
      sourceId: "fixture",
      durationMinutes: 30,
      scenePreset: "unknown" as never,
      sceneDescription: "",
      hostDensity: "low",
      energyCurve: "",
      avoid: [],
    }),
    /Unknown scene preset/,
  );
});
