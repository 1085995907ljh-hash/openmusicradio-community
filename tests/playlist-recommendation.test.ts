import test from "node:test";
import assert from "node:assert/strict";
import { PlaylistRecommendations, validateRecommendation } from "../src/server/playlist-recommendation.js";
import { musicResearchTrackKey, type MusicResearchTrack, type MusicResearchReport } from "../src/shared/music-research.js";
import { LocalConfiguredHostProvider } from "../src/server/local-ai-providers.js";
import { LocalAiConfigStore } from "../src/server/local-ai-config.js";
import type { ProgramSpec } from "../src/shared/contracts.js";
import { OpenAICompatibleHostProvider } from "../src/providers/openai-compatible.js";
import { ProviderError } from "../src/providers/types.js";

const spec = { sourceId: "qq_music", durationMinutes: 30, scenePreset: "late_night", hostDensity: "high", energyCurve: "舒缓", avoid: [] } as unknown as ProgramSpec;
const tracks = [{ title: "歌曲甲", artist: "艺人甲", album: null }, { title: "歌曲乙", artist: "艺人乙" }];
const text = "这份歌单邀请你把注意力放回音乐，认识歌曲背后的艺人，也感受不同作品之间的联系。".repeat(6);
const fact = { id: "web:verified", value: "艺人甲在公开采访中介绍了这张专辑的创作背景。", sourceUrl: "https://example.com/interview", sourceTitle: "艺人采访" };
const report = (items: MusicResearchTrack[]): MusicResearchReport => ({ tracks: items.map((track) => ({ trackKey: musicResearchTrackKey(track), status: "researched", completedAt: new Date().toISOString(), attempts: [{ query: track.title, status: "completed", sourceUrls: [fact.sourceUrl] }], facts: [fact] })) });

test("recommendation writing supports Responses and Chat Completions envelopes", async () => {
  for (const mode of ["responses", "chat_completions"] as const) {
    const output = JSON.stringify({ text, factIds: [fact.id] });
    const provider = new OpenAICompatibleHostProvider({ apiKey: "test-key", mode, model: "test-model", fetchImpl: async () => Response.json(mode === "responses" ? { output: [{ type: "message", content: [{ type: "output_text", text: output }] }] } : { choices: [{ message: { content: output } }] }) });
    assert.equal(validateRecommendation(await provider.writePlaylistRecommendation("system", "user", new AbortController().signal), [fact]).text, text);
  }
});

test("recommendation researches before writing, supplies the full list and retains verified sources", async () => {
  const calls: string[] = [];
  const service = new PlaylistRecommendations({
    research({ tracks }) { calls.push("research"); return report(tracks); },
    async writePlaylistRecommendation(system, user) {
      calls.push("write");
      assert.match(system, /200–300/);
      assert.equal(JSON.parse(user).tracks.length, 2);
      assert.equal(JSON.parse(user).listeningPreference.mood, "放松");
      assert.equal(user.includes("late_night"), false, "internal scene names must not imply a listening time");
      assert.equal(service.get("one")?.status, "writing");
      return JSON.stringify({ text, factIds: [fact.id] });
    },
  });
  await service.start("one", spec, tracks);
  assert.deepEqual(calls, ["research", "write"]);
  assert.equal(service.get("one")?.status, "ready");
  assert.equal(service.get("one")?.text, text);
  assert.deepEqual(service.get("one")?.sources, [{ title: fact.sourceTitle, url: fact.sourceUrl }]);
  service.clear();
});

test("failed research produces simple copy from confirmed song identities", async () => {
  let writes = 0;
  const service = new PlaylistRecommendations({ research() { throw new Error("offline"); }, async writePlaylistRecommendation() { writes++; return ""; } });
  await service.start("one", spec, tracks);
  assert.equal(writes, 0);
  assert.equal(service.get("one")?.status, "ready");
  assert.match(service.get("one")!.text!, /艺人甲的《歌曲甲》/);
  assert.deepEqual(service.get("one")?.sources, []);
  assert.ok(Array.from(service.get("one")!.text!).length <= 100);
});

test("replacement publishes ready full or fallback copy and preserves previous copy for empty input", async () => {
  let fail = false;
  let release!: () => void;
  let gate: Promise<void> = Promise.resolve();
  const service = new PlaylistRecommendations({
    async researchPlaylist({ tracks }) { await gate; if (fail) throw new Error("offline"); return report(tracks); },
    async writePlaylistRecommendation() { return JSON.stringify({ text, factIds: [fact.id] }); },
  });
  await service.start("one", spec, tracks);
  const previous = service.get("one");
  gate = new Promise(resolve => { release = resolve; });
  const pending = service.replace("one", spec, [tracks[1]!]);
  assert.equal(service.get("one"), previous);
  release();
  assert.equal(await pending, true);
  assert.notEqual(service.get("one"), previous);
  const ready = service.get("one");
  fail = true;
  assert.equal(await service.replace("one", spec, tracks), true);
  assert.notEqual(service.get("one"), ready);
  assert.ok(Array.from(service.get("one")!.text!).length <= 100);
  const fallback = service.get("one");
  assert.equal(await service.replace("one", spec, []), false);
  assert.equal(service.get("one"), fallback);
  service.clear();
});

test("missing facts, unavailable provider and invalid writing all finish with nonempty short copy", async () => {
  for (const provider of [
    {},
    { research: () => ({ tracks: [] }), writePlaylistRecommendation: async () => { throw new Error("should not invent facts"); } },
    { research: ({ tracks }: { tracks: MusicResearchTrack[] }) => report(tracks), writePlaylistRecommendation: async () => "invalid JSON" },
  ]) {
    const service = new PlaylistRecommendations(provider);
    await service.start("one", spec, tracks);
    const value = service.get("one")!;
    assert.equal(value.status, "ready");
    assert.ok(value.text!.trim().length > 0);
    assert.ok(Array.from(value.text!).length <= 100);
    service.clear();
  }
});

test("one unavailable song does not discard another song's verified research", async () => {
  const service = new PlaylistRecommendations({
    research: ({ tracks }) => report(tracks),
    researchPlaylist({ tracks }) { return { tracks: [report([tracks[0]!]).tracks[0], { trackKey: musicResearchTrackKey(tracks[1]!), status: "failed", facts: [], attempts: [], completedAt: new Date().toISOString() }] }; },
    async writePlaylistRecommendation(_system, user) { assert.equal(JSON.parse(user).facts.length, 1); return JSON.stringify({ text, factIds: [fact.id] }); },
  });
  await service.start("one", spec, tracks);
  assert.equal(service.get("one")?.status, "ready");
  service.clear();
});

test("new playlist cancels old research and stale completion cannot overwrite it", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let oldSignal: AbortSignal | undefined;
  let calls = 0;
  const service = new PlaylistRecommendations({
    async research({ tracks }, options) { if (++calls === 1) { oldSignal = options?.signal; await gate; } return report(tracks); },
    async writePlaylistRecommendation() { return JSON.stringify({ text, factIds: [fact.id] }); },
  });
  const old = service.start("one", spec, tracks);
  await service.start("one", spec, [tracks[1]!]);
  assert.equal(oldSignal?.aborted, true);
  release(); await old;
  assert.equal(service.get("one")?.status, "ready");
  service.clear();
});

test("rejects wrong length and invented references; retries invalid writing once", async () => {
  assert.throws(() => validateRecommendation(JSON.stringify({ text: "太短", factIds: [fact.id] }), [fact]));
  assert.throws(() => validateRecommendation(JSON.stringify({ text, factIds: ["made-up"] }), [fact]));
  let writes = 0;
  const service = new PlaylistRecommendations({ research: ({ tracks }) => report(tracks), async writePlaylistRecommendation() { return ++writes === 1 ? "not JSON" : JSON.stringify({ text, factIds: [fact.id] }); } });
  await service.start("one", spec, tracks);
  assert.equal(writes, 2);
  assert.equal(service.get("one")?.status, "ready");
  service.clear();
});

test("research timeout retains completed facts and produces at most 100 characters", async () => {
  const service = new PlaylistRecommendations({
    researchPlaylist({ tracks }, options) {
      options?.onProgress?.(report([tracks[0]!]));
      return new Promise(() => {}); // An upstream implementation may ignore abort.
    },
    async writePlaylistRecommendation() { throw new Error("must not start after deadline"); },
  }, 15);
  await service.start("one", spec, tracks);
  const result = service.get("one")!;
  assert.equal(result.status, "ready");
  assert.ok(Array.from(result.text!).length <= 100);
  assert.match(result.text!, /歌曲甲/);
  assert.ok(result.text!.includes(fact.value));
  assert.equal(result.sources?.[0]?.url, fact.sourceUrl);
  service.clear();
});

test("per-song timeout without facts falls back to confirmed song identities", async () => {
  const service = new PlaylistRecommendations({
    researchPlaylist() { return { tracks: [], timedOut: true }; },
    async writePlaylistRecommendation() { throw new Error("must not write full copy"); },
  });
  await service.start("one", spec, tracks);
  assert.equal(service.get("one")?.status, "ready");
  assert.match(service.get("one")!.text!, /歌曲甲/);
  assert.deepEqual(service.get("one")?.sources, []);
  service.clear();
});

test("writer timeout uses verified material, late completion cannot replace short copy", async () => {
  let release!: (value: string) => void;
  const service = new PlaylistRecommendations({
    research: ({ tracks }) => report(tracks),
    writePlaylistRecommendation: () => new Promise(resolve => { release = resolve; }),
  }, 15);
  await service.start("one", spec, tracks);
  const short = service.get("one");
  assert.equal(short?.status, "ready");
  assert.ok(Array.from(short!.text!).length <= 100);
  release(JSON.stringify({ text, factIds: [fact.id] }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.get("one"), short);
  service.clear();
});

test("typed provider timeout also falls back; cancellation publishes nothing", async () => {
  const service = new PlaylistRecommendations({
    research: ({ tracks }) => report(tracks),
    async writePlaylistRecommendation() { throw new ProviderError({ code: "timeout", provider: "test", message: "timeout", retryable: true }); },
  });
  await service.start("one", spec, tracks);
  assert.equal(service.get("one")?.status, "ready");
  service.clear();
  const cancelled = new PlaylistRecommendations({ research: () => new Promise(() => {}), async writePlaylistRecommendation() { return ""; } });
  const pending = cancelled.start("one", spec, tracks);
  cancelled.clear();
  await pending;
  assert.equal(cancelled.get("one"), undefined);
});

test("local research reports partial facts and distinguishes a timed out song", async () => {
  const provider = new LocalConfiguredHostProvider(new LocalAiConfigStore());
  provider.research = async ({ tracks: items }) => {
    if (items[0]!.title === tracks[1]!.title) throw new DOMException("Timed out", "TimeoutError");
    return report(items);
  };
  const progress: MusicResearchReport[] = [];
  const result = await provider.researchPlaylist({ scenePreset: "late_night", tracks: tracks.map(({ title, artist }) => ({ title, artist })) }, { onProgress: value => progress.push(value) });
  assert.equal(result.timedOut, true);
  assert.deepEqual(result.tracks[0]!.facts, [fact]);
  assert.equal(result.tracks[1]!.status, "failed");
  assert.ok(progress.some(value => value.tracks.some(row => row.facts.length > 0)));
});
