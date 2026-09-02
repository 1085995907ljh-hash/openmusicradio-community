import test from "node:test";
import assert from "node:assert/strict";

import {
  personalizeCandidates,
  rankPersonalizedTracks,
  type PersonalizationCandidate,
} from "../src/core/personalization.js";
import { isExplorationVersionCandidate } from "../src/core/recommendation-guards.js";

function candidate(
  id: string,
  artist: string,
  extra: Record<string, unknown> = {},
): PersonalizationCandidate {
  return { id, title: `Track ${id}`, artist, ...extra };
}

test("empty input returns a reliable deterministic fallback", () => {
  const result = personalizeCandidates({});

  assert.deepEqual(result.ranked, []);
  assert.equal(result.next, null);
  assert.equal(result.selected, null);
  assert.equal(result.reason, "no candidates");
  assert.equal(result.hasAccountData, false);
  assert.equal(result.usedFallback, true);
});

test("source pools are merged and duplicate IDs are emitted once", () => {
  const result = personalizeCandidates({
    candidates: [candidate("2", "Beta"), candidate("1", "Alpha")],
    liked: [candidate("1", "Alpha")],
    recent: [candidate("1", "Alpha"), candidate("2", "Beta")],
  });

  assert.deepEqual(result.ranked.map((entry) => entry.candidate.id), ["1", "2"]);
  assert.equal(new Set(result.ranked.map((entry) => entry.candidate.id)).size, 2);
  assert.deepEqual(result.ranked[0]?.sources, ["liked", "recent"]);
  assert.equal(result.hasAccountData, true);
  assert.ok(result.ranked[0]?.reasons.some((reason) => reason.startsWith("liked track reward")));
  assert.ok(result.ranked[0]?.reasons.some((reason) => reason.startsWith("recent track penalty")));
});

test("liked tracks and preferred artists receive explicit rewards", () => {
  const result = rankPersonalizedTracks({
    candidates: [candidate("plain", "Unknown"), candidate("fav", "Aurora")],
    preferredArtistNames: ["Aurora"],
  });

  assert.equal(result.next?.id, "fav");
  assert.ok(result.ranked[0]?.reasons.some((reason) => reason.startsWith("preferred artist reward")));
});

test("recent tracks and repeated artists are penalized", () => {
  const result = personalizeCandidates({
    candidates: [candidate("same-artist", "Recent Artist"), candidate("fresh", "Fresh Artist")],
    recent: [candidate("old", "Recent Artist")],
    session: {
      recentTrackIds: ["same-artist"],
      recentArtistNames: ["Recent Artist"],
    },
  });

  assert.equal(result.next?.id, "fresh");
  assert.ok(result.ranked[1]?.reasons.some((reason) => reason.startsWith("repeat artist penalty")));
  assert.ok(result.ranked[1]?.reasons.some((reason) => reason.startsWith("recent track penalty")));
});

test("scene search candidates are rewarded without inventing unknown genre or energy", () => {
  const result = personalizeCandidates({
    candidates: [candidate("plain", "Local"), candidate("search", "Remote")],
    search: [candidate("search", "Remote")],
    scene: { preset: "study", query: "focus", targetEnergy: 0.4 },
  });

  assert.equal(result.next?.id, "search");
  assert.ok(result.ranked[0]?.reasons.some((reason) => reason.startsWith("scene search reward")));
  assert.equal(result.ranked[0]?.reasons.some((reason) => /genre|energy/.test(reason)), false);
});

test("energy and genre are used only when finite and explicitly known", () => {
  const result = personalizeCandidates({
    candidates: [
      candidate("invalid", "No Facts", { energy: Number.NaN, genre: null }),
      candidate("known", "Known", { energy: 0.25, genre: "ambient" }),
    ],
    scene: { genre: "ambient", targetEnergy: 0.25 },
  });

  assert.equal(result.next?.id, "known");
  assert.ok(result.ranked[0]?.reasons.some((reason) => reason.startsWith("scene genre match")));
  assert.ok(result.ranked[0]?.reasons.some((reason) => reason.startsWith("scene energy match")));
  assert.equal(result.ranked[1]?.reasons.some((reason) => /genre|energy/.test(reason)), false);
});

test("scene style can promote a suitable discovery candidate over a mismatched liked track", () => {
  const result = personalizeCandidates({
    liked: [candidate("liked-ballad", "Known Artist")],
    search: [candidate("party-electronic", "New Artist", { styleTags: ["electronic"], searchQuery: "party electronic dance" })],
    scene: { preset: "party", query: "party electronic", styleTags: ["electronic", "dance"] },
  });

  assert.equal(result.next?.id, "party-electronic");
  assert.ok(result.ranked[0]?.reasons.some((reason) => reason.startsWith("scene style match")));
});

test("public playlists and popularity lift mainstream discovery candidates", () => {
  const result = personalizeCandidates({
    search: [
      candidate("plain-electronic", "Quiet Producer", { title: "Track plain-electronic", styleTags: ["electronic"], searchQuery: "workout electronic" }),
      candidate("playlist-electronic", "Fresh Producer", { title: "Track playlist-electronic", styleTags: ["electronic"], publicPlaylistId: "public-playlist-1", popularity: 92 }),
    ],
    scene: { preset: "workout", query: "workout electronic", styleTags: ["electronic", "hiphop", "rock", "pop"] },
  });

  assert.equal(result.next?.id, "playlist-electronic");
  assert.ok(result.ranked[0]?.reasons.some((reason) => reason.startsWith("public playlist reward")));
  assert.ok(result.ranked[0]?.reasons.some((reason) => reason.startsWith("popularity reward")));
});

test("recommendations reject DJ and low-quality Chinese remix candidates", () => {
  const result = personalizeCandidates({
    liked: [
      candidate("bad-liked", "土嗨制作人", { title: "一路生花 DJ版" }),
      candidate("normal-dj-artist", "DJ Snake", { title: "Turn Down For What", styleTags: ["electronic"] }),
    ],
    search: [
      candidate("bad-remix", "网络歌手", { title: "中文抖音热播 Remix", searchQuery: "抖音 remix 神曲" }),
      candidate("bad-car", "舞曲串烧", { title: "车载DJ串烧" }),
      candidate("bad-car-only", "网络歌手", { title: "低音重鼓车载系列" }),
      candidate("bad-dj-inline", "网络歌手", { title: "低音重鼓Dj精选" }),
      candidate("good-electronic", "Fresh Producer", { title: "Late Circuit", styleTags: ["electronic"], searchQuery: "party electronic" }),
    ],
    scene: { preset: "party", query: "party electronic", styleTags: ["electronic", "dance"] },
  });

  assert.deepEqual(result.ranked.map((entry) => entry.candidate.id), ["normal-dj-artist", "good-electronic"]);
  assert.equal(result.ranked.some((entry) => String(entry.candidate.id).startsWith("bad")), false);
});

test("exploration version detection rejects remix live concert and labelled versions", () => {
  for (const title of [
    "Pulse Remix",
    "Pulse (Live)",
    "Pulse 演唱会版",
    "Pulse 2026 Version",
    "Pulse Acoustic Version",
    "Pulse Remastered",
    "Pulse (Radio Edit)",
  ]) {
    assert.equal(isExplorationVersionCandidate({ id: title, title }), true, title);
  }
  assert.equal(isExplorationVersionCandidate({ id: "original", title: "Pulse", artists: [{ name: "DJ Snake" }] }), false);
});

test("consecutive skips are cumulative and stronger than a single skip", () => {
  const result = personalizeCandidates({
    candidates: [candidate("one", "A"), candidate("two", "B"), candidate("three", "C")],
    feedback: {
      skipped: ["one", "one", "two"],
    },
  });

  assert.deepEqual(result.ranked.map((entry) => entry.candidate.id), ["three", "two", "one"]);
  assert.ok(result.ranked[2]?.reasons.some((reason) => reason.startsWith("repeated skip penalty x2")));
  assert.ok((result.ranked[2]?.score ?? 0) < (result.ranked[1]?.score ?? 0));
});

test("one explicit skip outweighs liked and preferred-artist rewards", () => {
  const liked = candidate("liked", "Aurora");
  const result = personalizeCandidates({
    candidates: [candidate("fresh", "New Artist")],
    liked: [liked],
    preferredArtistNames: ["Aurora"],
    feedback: { skipped: ["liked"] },
  });
  assert.equal(result.next?.id, "fresh");
});

test("multi-artist likes teach each artist and both playlist pools are retained", () => {
  const result = personalizeCandidates({
    candidates: [candidate("a", "Artist A"), candidate("z", "Unknown")],
    liked: [candidate("duet", "", { artists: [{ name: "Artist A" }, { name: "Artist B" }] })],
    playlist: [],
    playlists: [candidate("playlist-song", "Artist A")],
  });
  assert.equal(result.next?.id, "duet");
  assert.ok(result.ranked.find((entry) => entry.candidate.id === "a")?.reasons.some((reason) => reason.startsWith("preferred artist reward")));
  assert.ok(result.ranked.some((entry) => entry.candidate.id === "playlist-song"));
});

test("liked and completed feedback are distinct from skipped feedback", () => {
  const result = personalizeCandidates({
    candidates: [candidate("liked", "A"), candidate("completed", "B"), candidate("skipped", "C")],
    feedback: {
      liked: ["liked"],
      completed: ["completed"],
      skipped: ["skipped"],
    },
  });

  assert.equal(result.next?.id, "liked");
  assert.ok(result.ranked.find((entry) => entry.candidate.id === "liked")?.reasons.some((reason) => reason.startsWith("explicit liked feedback")));
  assert.ok(result.ranked.find((entry) => entry.candidate.id === "completed")?.reasons.some((reason) => reason.startsWith("completed feedback")));
  assert.ok(result.ranked.find((entry) => entry.candidate.id === "skipped")?.reasons.some((reason) => reason.startsWith("skip penalty")));
});

test("ranking has a stable ID tie-break and does not mutate input candidates", () => {
  const source = [
    candidate("z", "Zed", { mood: ["warm"], artists: [{ id: 7, name: "Zed" }] }),
    candidate("a", "Alpha", { mood: ["cool"], artists: [{ id: 8, name: "Alpha" }] }),
  ];
  const before = structuredClone(source);
  const first = personalizeCandidates(source);
  const second = personalizeCandidates([...source].reverse());

  assert.deepEqual(first.ranked.map((entry) => entry.candidate.id), ["a", "z"]);
  assert.deepEqual(second.ranked.map((entry) => entry.candidate.id), ["a", "z"]);
  assert.deepEqual(source, before);
  (first.ranked[0]!.candidate.mood as string[] | undefined)?.push("caller mutation");
  assert.deepEqual(source, before);
});
