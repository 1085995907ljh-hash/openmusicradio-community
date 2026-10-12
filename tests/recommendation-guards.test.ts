import test from "node:test";
import assert from "node:assert/strict";
import { hasKnownRecommendationAlbum, isDisallowedRecommendationCandidate } from "../src/core/recommendation-guards.js";

test("recommendations exclude MC artists, unknown albums and non-song recordings in every scene", () => {
  const rejected = [
    { title: "夜巴黎", artists: [{ name: "MC战小二吖" }], album: "夜巴黎" },
    { title: "Song", artist: "mc Hammer" },
    { title: "Song", artists: ["歌手", "ＭＣ小明"] },
    { song: { title: "Song", artist: "M.C. 小明" } },
    { title: "足够", artist: "小峰峰（陈峰）", album: "未知专辑" },
    { title: "Song", album: { name: "Unknown Album" } },
    { title: "Song", album: null },
    { title: "宝宝笑声", artist: "穆志祥", album: "宝宝笑声" },
    { title: "Baby Laughter", album: "Sound Effects" },
    { title: "社会语录", album: "合集" },
  ];
  for (const song of rejected) {
    for (const scenePreset of ["late_night", "study", "workout"] as const) {
      assert.equal(isDisallowedRecommendationCandidate(song, { scenePreset }), true, JSON.stringify(song));
    }
  }
});

test("normal independent artists and Mc surnames remain eligible; final albums must be known", () => {
  for (const artist of ["Paul McCartney", "Amy Macdonald", "MC5", "独立音乐人"]) {
    assert.equal(isDisallowedRecommendationCandidate({ title: "Baby", artist, album: "正式专辑" }), false);
  }
  for (const album of [undefined, null, "", "  ", "未知专辑", { name: "Unknown Album" }, {}]) {
    assert.equal(hasKnownRecommendationAlbum({ album }), false);
  }
  assert.equal(hasKnownRecommendationAlbum({ album: { name: "Ambient Sketchbook" } }), true);
  assert.equal(hasKnownRecommendationAlbum({ album: "夜航 - Single" }), true);
});

const relaxation = { scenePreset: "late_night", recommendationMode: "atmosphere" } as const;

test("relaxation atmosphere excludes religious and functional sleep audio across metadata shapes", () => {
  const rejected = [
    { title: "大自然的声音", artists: [{ name: "催眠曲" }] },
    { title: "道家·清心咒·降火护肝", artist: "无为先生" },
    { song: { title: "好长的忧伤", album: { name: "减压纯音乐" } } },
    { title: "晚风", album: "轻音乐舒缓放松纯音乐 睡眠5分钟入睡" },
    { name: "冥想减压歌单" },
    { title: "Quiet", genre: "Gospel" },
    { title: "Peace", album: "Deep Sleep Music" },
    { title: "钢琴", description: "減壓純音樂" },
  ];
  for (const song of rejected) assert.equal(isDisallowedRecommendationCandidate(song, relaxation), true, JSON.stringify(song));
});

test("relaxation exclusions preserve normal gentle songs and instrumental music and stay scene scoped", () => {
  for (const title of ["催眠", "我不愿让你一个人", "Prayer", "Sleep", "Dream", "River Flows in You", "轻柔钢琴纯音乐", "舒缓爵士", "好长的忧伤"]) {
    assert.equal(isDisallowedRecommendationCandidate({ title, artist: "普通歌手" }, relaxation), false, title);
  }
  const functional = { title: "冥想助眠音乐" };
  assert.equal(isDisallowedRecommendationCandidate(functional, { scenePreset: "study", recommendationMode: "atmosphere" }), false);
  assert.equal(isDisallowedRecommendationCandidate(functional, { scenePreset: "late_night", recommendationMode: "genre" }), false);
  assert.equal(isDisallowedRecommendationCandidate(functional, { scenePreset: "late_night", musicGenres: ["new_age"] }), false);
  assert.equal(isDisallowedRecommendationCandidate(functional, { scenePreset: "late_night" }), true);
});
