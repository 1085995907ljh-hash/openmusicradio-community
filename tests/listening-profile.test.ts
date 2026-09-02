import test from "node:test";
import assert from "node:assert/strict";

import { buildListeningProfile } from "../src/core/listening-profile.js";

test("listening profile uses song and playlist names without inventing unsupported genres", () => {
  const profile = buildListeningProfile({
    likedSongs: [{ id: "1", title: "夜猫学习", artists: ["A"] }],
    recentSongs: [{ id: "2", title: "通勤时刻", artists: ["B"] }],
    historySongs: [],
    playlistSongs: [{ id: "3", title: "跑步节奏", artists: ["C"] }],
    playlists: ["Late Night Focus"],
  });

  assert.deepEqual(profile.topSongs.map((song) => song.title), ["夜猫学习", "通勤时刻", "跑步节奏"]);
  assert.deepEqual(profile.inferredThemes, ["放松舒缓", "专注陪伴", "运动节奏", "律动流行"]);
  assert.ok(profile.evidence.includes("1 首歌单歌曲"));
  assert.ok(profile.evidence.includes("3 首歌曲带有可用风格标签"));
  assert.deepEqual(profile.taggedSongs.map((song) => song.title), ["夜猫学习", "通勤时刻", "跑步节奏"]);
  assert.ok(profile.styleTags.includes("workout"));
  assert.equal(profile.styleAffinities.length, 0);
  assert.equal(profile.evidence.length, 6);
});

test("listening profile groups familiar songs and artists by music style", () => {
  const profile = buildListeningProfile({
    likedSongs: [
      { id: "rnb-1", title: "R&B 夜色", artists: ["Soul Anchor"] },
      { id: "rock-1", title: "摇滚现场", artists: ["Rock Anchor"] },
    ],
    recentSongs: [{ id: "rock-2", title: "Alternative Rock Road", artists: ["Rock Anchor"] }],
    historySongs: [{ id: "rnb-2", title: "节奏布鲁斯回声", artists: ["Blue Singer"] }],
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
