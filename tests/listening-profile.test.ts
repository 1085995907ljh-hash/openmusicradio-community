import test from "node:test";
import assert from "node:assert/strict";

import { buildListeningProfile, inferSongTags } from "../src/core/listening-profile.js";

test("a song title containing British is not treated as Britpop evidence", () => {
  assert.deepEqual(inferSongTags({ id: "plain-title", title: "British", artists: ["The Sunrise View"] }), []);
  assert.ok(inferSongTags({ id: "tagged", title: "Morning Light", artists: ["Band A"], tags: ["Britpop"] }).includes("britpop"));
});

test("listening profile uses playlist names and explicit song tags without inferring genres from titles", () => {
  const profile = buildListeningProfile({
    likedSongs: [{ id: "1", title: "夜猫学习", artists: ["A"], tags: ["轻音乐"] }],
    recentSongs: [{ id: "2", title: "通勤时刻", artists: ["B"], tags: ["流行"] }],
    historySongs: [],
    playlistSongs: [{ id: "3", title: "跑步节奏", artists: ["C"], tags: ["电子"] }],
    playlists: ["Late Night Focus", "跑步通勤"],
  });

  assert.deepEqual(profile.topSongs.map((song) => song.title), ["夜猫学习", "通勤时刻", "跑步节奏"]);
  assert.deepEqual(profile.inferredThemes, ["放松舒缓", "专注陪伴", "运动节奏", "律动流行"]);
  assert.ok(profile.evidence.includes("1 首歌单歌曲"));
  assert.ok(profile.evidence.includes("3 首歌曲带有可用风格标签"));
  assert.deepEqual(profile.taggedSongs.map((song) => song.title), ["夜猫学习", "通勤时刻", "跑步节奏"]);
  assert.ok(profile.styleTags.includes("workout"));
  assert.equal(profile.styleAffinities.length, 3);
  assert.equal(profile.evidence.length, 6);
});

test("listening profile groups familiar songs and artists by music style", () => {
  const profile = buildListeningProfile({
    likedSongs: [
      { id: "rnb-1", title: "R&B 夜色", artists: ["Soul Anchor"], tags: ["R&B"] },
      { id: "rock-1", title: "摇滚现场", artists: ["Rock Anchor"], tags: ["摇滚"] },
    ],
    recentSongs: [{ id: "rock-2", title: "Alternative Rock Road", artists: ["Rock Anchor"], tags: ["Alternative Rock"] }],
    historySongs: [{ id: "rnb-2", title: "节奏布鲁斯回声", artists: ["Blue Singer"], tags: ["节奏布鲁斯"] }],
    playlistSongs: [],
    playlists: [],
  });

  const rnb = profile.styleAffinities.find((item) => item.style === "rnb_soul");
  const rock = profile.styleAffinities.find((item) => item.style === "rock");
  assert.ok(rnb);
  assert.ok(rock);
  assert.deepEqual(rock.familiarSongs.map((song) => song.title), ["摇滚现场", "Alternative Rock Road"]);
  assert.equal(rock.artists[0]?.name, "Rock Anchor");
  assert.ok((rnb.score ?? 0) > 0);
});
