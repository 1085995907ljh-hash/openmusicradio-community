import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLocalService } from "../src/server/index.js";
import { ProgramEngine } from "../src/core/program-engine.js";
import { ProviderError } from "../src/providers/types.js";
import { LocalAiConfigStore } from "../src/server/local-ai-config.js";
import type { CloudAccessStore } from "../src/server/cloud-access.js";
import type { DesktopPlayerControllerLike } from "../src/server/desktop-player.js";
import type { DesktopProgramControllerLike } from "../src/server/desktop-program.js";

const SERVER_TEST_PROFILE_DIR = mkdtempSync(join(tmpdir(), "one-radio-server-profile-"));
process.env.ONE_RADIO_PROFILE_DIR = SERVER_TEST_PROFILE_DIR;
function resetServerTestProfileDir() {
  rmSync(SERVER_TEST_PROFILE_DIR, { recursive: true, force: true });
  mkdirSync(SERVER_TEST_PROFILE_DIR, { recursive: true });
}
beforeEach(resetServerTestProfileDir);
after(() => {
  rmSync(SERVER_TEST_PROFILE_DIR, { recursive: true, force: true });
});

async function json(response: Response) {
  return response.json() as Promise<Record<string, any>>;
}

function planningProvider<T extends { id: string; title: string; artists: Array<{ id: string; name: string }>; durationMs: number }>(songs: T[], likedIds: string[], recentIds: string[] = [], historyIds: string[] = []) {
  const byId = new Map(songs.map((song) => [song.id, song]));
  return {
    configured: true,
    state: "ready",
    getStatus() { return { configured: true, state: "ready", authenticated: true }; },
    health() { return { configured: true, state: "ready", authenticated: true }; },
    account() { return { uid: "7" }; },
    userPlaylists() { return { playlists: [], more: false }; },
    likedSongIds() { return likedIds; },
    songDetail(ids: string[]) { return ids.flatMap((id) => byId.get(id) ?? []); },
    recentSongs() { return recentIds.flatMap((id) => byId.has(id) ? [{ song: byId.get(id)! }] : []); },
    listeningHistory() { return historyIds.flatMap((id) => byId.has(id) ? [{ song: byId.get(id)! }] : []); },
    dailyRecommendations() { return songs; },
    personalFm() { return songs; },
    search() { return { songs, total: songs.length }; },
    songUrl(id: string) { return { id, url: `https://music.126.net/${id}.mp3` }; },
  };
}

function groundedHostProvider() {
  let sequence = 0;
  return {
    configured: true,
    state: "ready",
    generate(context: { allowedFacts?: Array<{ id: string; value: string }>; transitionReason?: string }) {
      sequence += 1;
      if (context.transitionReason?.includes("悬念预告")) {
        return { success: true, status: "ready", text: `先不揭晓名字，这一次的声音线索编号是${sequence}。下一段会把节奏和声音的层次慢慢推开，留一点悬念，听听第一个音色出现时，你能不能猜出这份气质从哪里来；它会有清楚的呼吸，也会在细节里慢慢增加力量。现在让耳朵先走在答案前面，等音乐自己把谜底交出来。`, factIds: [], instruction: `自然电台口吻 ${sequence}` };
      }
      const fact = context.allowedFacts?.[0];
      return { success: true, status: "ready", text: fact?.value ?? "", factIds: fact ? [fact.id] : [], instruction: `自然电台口吻 ${sequence}` };
    },
  };
}

const readyTtsProvider = { configured: true, state: "ready", synthesize() { return { success: true, status: "ready", audio: Buffer.from("RIFF0000WAVE") }; } };

test("local service enforces fixture ids, generations, and operation action scope", async (context) => {
  const service = await createLocalService({ port: 0 });
  await service.start();
  context.after(() => service.stop());
  const base = `http://127.0.0.1:${service.port}/api`;

  const sourcePayload = await json(await fetch(`${base}/sources`));
  assert.deepEqual(sourcePayload.sources.map((source: { sourceId: string }) => source.sourceId), ["fixture", "qq_music", "netease_music"]);
  assert.equal((await fetch(`${base}/players/qq_music/volume`)).status, 401);

  const invalidHost = await fetch(`${base}/programs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spec: { sourceId: "fixture", durationMinutes: 30, scenePreset: "study", sceneDescription: "", hostDensity: "low", energyCurve: "steady", avoid: [], hostProfile: "dialect-host" } }),
  });
  assert.equal(invalidHost.status, 400);

  const invalidGenre = await fetch(`${base}/programs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spec: { sourceId: "fixture", durationMinutes: 30, scenePreset: "study", sceneDescription: "", hostDensity: "low", energyCurve: "steady", avoid: [], musicGenres: ["not-a-genre"] } }),
  });
  assert.equal(invalidGenre.status, 400);

  const missingGenreSelection = await fetch(`${base}/programs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spec: { sourceId: "fixture", durationMinutes: 30, recommendationMode: "genre", scenePreset: "study", sceneDescription: "", hostDensity: "low", energyCurve: "steady", avoid: [], musicGenres: [] } }),
  });
  assert.equal(missingGenreSelection.status, 400);
  assert.equal((await json(missingGenreSelection)).error, "按风格推荐时至少选择一种音乐风格。");

  const tooManyGenres = await fetch(`${base}/programs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spec: { sourceId: "fixture", durationMinutes: 30, scenePreset: "study", sceneDescription: "", hostDensity: "low", energyCurve: "steady", avoid: [], musicGenres: ["pop", "rnb_soul", "jazz", "rock"] } }),
  });
  assert.equal(tooManyGenres.status, 400);
  assert.equal((await json(tooManyGenres)).error, "音乐风格最多选择 3 种。");

  const tooShort = await fetch(`${base}/programs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spec: { sourceId: "fixture", durationMinutes: 15, scenePreset: "study", sceneDescription: "", hostDensity: "low", energyCurve: "steady", avoid: [] } }),
  });
  assert.equal(tooShort.status, 400);
  assert.equal((await json(tooShort)).error, "durationMinutes must be between 30 and 120");

  assert.equal((await fetch(`${base}/fixtures/fixture-unknown.wav`)).status, 404);

  const createdResponse = await fetch(`${base}/programs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spec: { sourceId: "fixture", durationMinutes: 30, scenePreset: "study", sceneDescription: "", hostDensity: "low", energyCurve: "steady", avoid: [] }, operationId: "create-server-test" }),
  });
  assert.equal(createdResponse.status, 201);
  const created = (await json(createdResponse)).program;

  const nextBeforeConfirm = await fetch(`${base}/programs/${created.id}/next`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ generation: created.generation, operationId: "next-before-confirm" }),
  });
  assert.equal(nextBeforeConfirm.status, 409);
  assert.equal((await json(nextBeforeConfirm)).code, "PROGRAM_NOT_ACTIVE");

  const confirmedResponse = await fetch(`${base}/programs/${created.id}/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ generation: created.generation, operationId: "confirm-server-test" }),
  });
  const confirmed = (await json(confirmedResponse)).program;

  const missingGeneration = await fetch(`${base}/programs/${created.id}/next`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operationId: "missing-generation" }),
  });
  assert.equal(missingGeneration.status, 400);

  const nextResponse = await fetch(`${base}/programs/${created.id}/next`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ generation: confirmed.generation, operationId: "shared-server-operation" }),
  });
  assert.equal(nextResponse.status, 200);
  const afterNext = (await json(nextResponse)).program;

  const conflictingStop = await fetch(`${base}/programs/${created.id}/stop`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ generation: afterNext.generation, operationId: "shared-server-operation" }),
  });
  assert.equal(conflictingStop.status, 409);
  assert.equal((await json(conflictingStop)).code, "OPERATION_REUSED");
});

test("unexpected engine errors return HTTP 500", async (context) => {
  const engine = {
    create() { throw new Error("boom"); },
    confirm() { throw new Error("boom"); },
    getState() { throw new Error("boom"); },
    tick() { throw new Error("boom"); },
    heartbeat() { throw new Error("boom"); },
    next() { throw new Error("boom"); },
    stop() { throw new Error("boom"); },
  };
  const service = await createLocalService({ port: 0, engine, localControlToken: "engine-test-token" });
  await service.start();
  context.after(() => service.stop());

  const response = await fetch(`http://127.0.0.1:${service.port}/api/program`, { headers: { "x-one-radio-control-token": "engine-test-token" } });
  assert.equal(response.status, 500);
  assert.equal((await json(response)).code, "ENGINE_ERROR");
});

test("local maintenance routes report storage and perform explicit cleanup", async (context) => {
  const token = "maintenance-test-token";
  const aiConfigStore = new LocalAiConfigStore(join(SERVER_TEST_PROFILE_DIR, "ai-config.json"), `dev.one-radio.test.${Date.now()}`);
  let qqLogoutCalls = 0;
  let neteaseLogoutCalls = 0;
  const qqProvider = {
    configured: true,
    getStatus: () => ({ configured: true, state: "ready", authenticated: true, persistentLogin: true }),
    logout: () => { qqLogoutCalls += 1; return { configured: true, state: "blocked_by_auth", authenticated: false, persistentLogin: false }; },
  };
  const neteaseProvider = {
    configured: true,
    getStatus: () => ({ configured: true, state: "ready", authenticated: true, persistentLogin: true }),
    logout: () => { neteaseLogoutCalls += 1; return { configured: true, state: "unchecked", authenticated: false, persistentLogin: false }; },
  };
  writeFileSync(join(SERVER_TEST_PROFILE_DIR, "qq-0123456789abcdef01234567.json"), "{}\n", { mode: 0o600 });
  const service = await createLocalService({ port: 0, localControlToken: token, aiConfigStore, qqProvider, neteaseProvider });
  await service.start();
  context.after(() => service.stop());
  const base = `http://127.0.0.1:${service.port}/api`;
  const headers = { "content-type": "application/json", "x-one-radio-control-token": token };

  const status = await json(await fetch(`${base}/device/status`, { headers }));
  assert.equal(status.storage.profiles.files, 1);
  assert.equal(typeof status.storage.audio.bytes, "number");

  const profileReset = await json(await fetch(`${base}/device/profile/reset`, { method: "POST", headers, body: "{}" }));
  assert.equal(profileReset.removedProfiles, 1);
  assert.equal(profileReset.profiles.files, 0);

  const cacheReset = await json(await fetch(`${base}/device/cache/clear`, { method: "POST", headers, body: "{}" }));
  assert.equal(cacheReset.storage.entries, 0);

  assert.equal((await fetch(`${base}/qq/logout`, { method: "POST", headers, body: "{}" })).status, 200);
  assert.equal((await fetch(`${base}/netease/logout`, { method: "POST", headers, body: "{}" })).status, 200);
  assert.equal(qqLogoutCalls, 1);
  assert.equal(neteaseLogoutCalls, 1);

  const diagnostics = await json(await fetch(`${base}/device/diagnostics`, { headers }));
  assert.equal(diagnostics.application.version, "0.1.0");
  assert.equal(diagnostics.service.host, "127.0.0.1");
  assert.ok(Array.isArray(diagnostics.recentRequests));
  assert.doesNotMatch(JSON.stringify(diagnostics), /maintenance-test-token/);
});

test("full account reset clears local authorization and returns to an empty session", async (context) => {
  const token = "full-reset-token";
  const engine = new ProgramEngine({ now: () => Date.now() });
  const draft = engine.create({ sourceId: "fixture", durationMinutes: 30, scenePreset: "study", sceneDescription: "", hostDensity: "low", energyCurve: "steady", avoid: [] });
  engine.confirm({ programId: draft.id, nowMs: Date.now() });
  let qqLogoutCalls = 0;
  let neteaseLogoutCalls = 0;
  let accessDisconnectCalls = 0;
  let petHideCalls = 0;
  const cloudAccessStore = {
    async disconnect() { accessDisconnectCalls += 1; },
    async status() { return { configured: true, connected: false, state: "invitation_required" }; },
  } as unknown as CloudAccessStore;
  const aiConfigStore = new LocalAiConfigStore(join(SERVER_TEST_PROFILE_DIR, "reset-ai-config.json"), `dev.one-radio.reset.${Date.now()}`);
  writeFileSync(join(SERVER_TEST_PROFILE_DIR, "netease-abcdefabcdefabcdefabcdef.json"), "{}\n", { mode: 0o600 });
  const service = await createLocalService({
    port: 0,
    engine,
    localControlToken: token,
    aiConfigStore,
    cloudAccessStore,
    qqProvider: { configured: true, logout() { qqLogoutCalls += 1; return {}; } },
    neteaseProvider: { configured: true, logout() { neteaseLogoutCalls += 1; return {}; } },
    desktopPetController: { update() {}, hide() { petHideCalls += 1; }, stop() {} },
  });
  await service.start();
  context.after(() => service.stop());
  const base = `http://127.0.0.1:${service.port}/api`;
  const headers = { "content-type": "application/json", "x-one-radio-control-token": token };

  assert.equal((await fetch(`${base}/device/account/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  const activeReset = await fetch(`${base}/device/account/reset`, { method: "POST", headers, body: "{}" });
  assert.equal(activeReset.status, 409);
  assert.equal((await json(activeReset)).code, "PROGRAM_ACTIVE");
  assert.equal(qqLogoutCalls, 0);
  engine.stop({ programId: draft.id, generation: engine.getState()?.generation, operationId: "finish-before-reset" });

  const response = await fetch(`${base}/device/account/reset`, { method: "POST", headers, body: "{}" });
  assert.equal(response.status, 200, await response.clone().text());
  const result = await json(response);
  assert.equal(result.reset, true);
  assert.equal(result.removedProfiles, 1);
  assert.equal(qqLogoutCalls, 1);
  assert.equal(neteaseLogoutCalls, 1);
  assert.equal(accessDisconnectCalls, 1);
  assert.equal(petHideCalls, 1);
  assert.equal((await json(await fetch(`${base}/program`, { headers }))).program, null);
  assert.equal((await json(await fetch(`${base}/device/status`, { headers }))).storage.profiles.files, 0);
});

test("local service exposes protected desktop-player controls", async (context) => {
  const calls: string[] = [];
  const desktopPlayerController: DesktopPlayerControllerLike = {
    async inspect(sourceId: "qq_music" | "netease_music") {
      calls.push(`inspect:${sourceId}`);
      return { sourceId, state: "ready", ok: true, controlledElements: 1, operationId: null, targetVolume: null, detail: "ready", appRunning: true, playing: true };
    },
    async duck(sourceId: "qq_music" | "netease_music", operationId: string) {
      calls.push(`duck:${sourceId}:${operationId}`);
      return { sourceId, state: "ducked", ok: true, controlledElements: 3, operationId, targetVolume: null, detail: "ducked", appRunning: true, playing: true };
    },
    async restore(sourceId: "qq_music" | "netease_music", operationId: string) {
      calls.push(`restore:${sourceId}:${operationId}`);
      return { sourceId, state: "restored", ok: true, controlledElements: 3, operationId, targetVolume: null, detail: "restored", appRunning: true, playing: null };
    },
    async pause(sourceId: "qq_music" | "netease_music", operationId: string) {
      calls.push(`pause:${sourceId}:${operationId}`);
      return { sourceId, state: "paused", ok: true, controlledElements: 0, operationId, targetVolume: null, detail: "paused", appRunning: true, playing: false };
    },
    async toggle(sourceId: "qq_music" | "netease_music", operationId: string) {
      calls.push(`toggle:${sourceId}:${operationId}`);
      return { sourceId, state: "playing", ok: true, controlledElements: 0, operationId, targetVolume: null, detail: "playing", appRunning: true, playing: true };
    },
    async next(sourceId: "qq_music" | "netease_music", operationId: string) {
      calls.push(`next:${sourceId}:${operationId}`);
      return { sourceId, state: "next_requested", ok: true, controlledElements: 0, operationId, targetVolume: null, detail: "next requested", appRunning: true, playing: null };
    },
  };
  const service = await createLocalService({ port: 0, desktopPlayerController, localControlToken: "test-control-token" });
  await service.start();
  context.after(() => service.stop());
  const base = `http://127.0.0.1:${service.port}/api`;

  const anonymousHealth = await fetch(`${base}/health`);
  assert.equal(anonymousHealth.status, 200);
  assert.equal(anonymousHealth.headers.get("x-one-radio-control-token"), null);

  const unauthorized = await fetch(`${base}/players/netease_music/volume`);
  assert.equal(unauthorized.status, 401);

  const controlHeaders = { "x-one-radio-control-token": "test-control-token" };
  const inspected = await fetch(`${base}/players/netease_music/volume`, { headers: controlHeaders });
  assert.equal(inspected.status, 200);
  assert.equal((await json(inspected)).player.state, "ready");

  const ducked = await fetch(`${base}/players/volume/duck`, {
    method: "POST",
    headers: { "content-type": "application/json", ...controlHeaders },
    body: JSON.stringify({ sourceId: "qq_music", operationId: "host-volume" }),
  });
  assert.equal(ducked.status, 200);
  assert.equal((await json(ducked)).player.controlledElements, 3);

  const restored = await fetch(`${base}/players/volume/restore`, {
    method: "POST",
    headers: { "content-type": "application/json", ...controlHeaders },
    body: JSON.stringify({ sourceId: "qq_music", operationId: "host-volume" }),
  });
  assert.equal(restored.status, 200);
  assert.equal((await json(restored)).player.state, "restored");
  const toggled = await fetch(`${base}/players/control/toggle`, {
    method: "POST",
    headers: { "content-type": "application/json", ...controlHeaders },
    body: JSON.stringify({ sourceId: "qq_music", operationId: "toggle-player" }),
  });
  assert.equal(toggled.status, 200);

  const skipped = await fetch(`${base}/players/control/next`, {
    method: "POST",
    headers: { "content-type": "application/json", ...controlHeaders },
    body: JSON.stringify({ sourceId: "netease_music", operationId: "next-player" }),
  });
  assert.equal(skipped.status, 200);

  assert.deepEqual(calls, ["inspect:netease_music", "duck:qq_music:host-volume", "restore:qq_music:host-volume", "toggle:qq_music:toggle-player", "next:netease_music:next-player"]);

  for (const body of [
    { sourceId: "apple_music", operationId: "bad-source" },
    { sourceId: "netease_music", operationId: "" },
  ]) {
    const response = await fetch(`${base}/players/volume/duck`, {
      method: "POST",
      headers: { "content-type": "application/json", ...controlHeaders },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400);
  }
});

test("desktop programs require authorization and confirm real preparation before next and stop", async (context) => {
  const calls: string[] = [];
  const desktopPlayerController: DesktopPlayerControllerLike = {
    async inspect(sourceId) {
      calls.push(`inspect:${sourceId}`);
      return { sourceId, state: "ready", ok: true, controlledElements: 0, operationId: null, targetVolume: null, detail: "ready", appRunning: true, playing: true };
    },
    async duck(sourceId, operationId) {
      return { sourceId, state: "ducked", ok: true, controlledElements: 3, operationId, targetVolume: null, detail: "ducked", appRunning: true, playing: true };
    },
    async restore(sourceId, operationId) {
      return { sourceId, state: "restored", ok: true, controlledElements: 3, operationId, targetVolume: null, detail: "restored", appRunning: true, playing: null };
    },
    async pause(sourceId, operationId) {
      calls.push(`pause:${sourceId}:${operationId}`);
      return { sourceId, state: "paused", ok: true, controlledElements: 0, operationId, targetVolume: null, detail: "paused", appRunning: true, playing: false };
    },
    async toggle(sourceId, operationId) {
      calls.push(`toggle:${sourceId}:${operationId}`);
      return { sourceId, state: "paused", ok: true, controlledElements: 0, operationId, targetVolume: null, detail: "paused", appRunning: true, playing: false };
    },
    async next(sourceId, operationId) {
      calls.push(`next:${sourceId}:${operationId}`);
      return { sourceId, state: "next_requested", ok: true, controlledElements: 0, operationId, targetVolume: null, detail: "next", appRunning: true, playing: null };
    },
  };
  let prepareCalls = 0;
  const desktopProgramController: DesktopProgramControllerLike = {
    async prepare(sourceId, scenePreset, _description, operationId) {
      prepareCalls += 1;
      calls.push(`prepare:${sourceId}:${scenePreset}:${operationId}`);
      return { sourceId, operationId, query: "study jazz", state: "ready", ok: true, detail: "ready" };
    },
  };
  const service = await createLocalService({
    port: 0,
    desktopPlayerController,
    desktopProgramController,
    localControlToken: "desktop-program-token",
  });
  await service.start();
  context.after(() => service.stop());
  const base = `http://127.0.0.1:${service.port}/api`;
  const post = (path: string, body: unknown, authorized = true) => fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(authorized ? { "x-one-radio-control-token": "desktop-program-token" } : {}) },
    body: JSON.stringify(body),
  });

  const health = await json(await fetch(`${base}/health`));
  assert.equal(health.providers.host.provider, "local-configured");
  assert.equal(health.providers.tts.provider, "local-configured-tts");
  assert.equal(health.providers.tts.configured, true);
  assert.equal(health.providers.tts.state, "configured_unverified");

  const created = (await json(await post("/programs", {
    spec: { sourceId: "qq_music", durationMinutes: 30, scenePreset: "study", sceneDescription: "jazz and arbitrary prose", hostDensity: "low", energyCurve: "steady", avoid: [] },
    operationId: "desktop-create",
  }))).program;

  const unauthorized = await post(`/programs/${created.id}/confirm`, { generation: created.generation, operationId: "desktop-confirm" }, false);
  assert.equal(unauthorized.status, 401);
  assert.equal(prepareCalls, 0);

  const confirmedResponse = await post(`/programs/${created.id}/confirm`, { generation: created.generation, operationId: "desktop-confirm" });
  assert.equal(confirmedResponse.status, 200);
  const confirmed = (await json(confirmedResponse)).program;
  assert.equal(confirmed.status, "on_air");
  assert.equal(confirmed.currentTrack.title, "场景歌单：study jazz");
  assert.equal(confirmed.currentTrack.audioUrl, undefined);
  assert.equal(confirmed.nextTrack.title, "下一首由客户端队列决定");

  const replay = await post(`/programs/${created.id}/confirm`, { generation: created.generation, operationId: "desktop-confirm" });
  assert.equal(replay.status, 200);
  assert.equal((await json(replay)).replayed, true);
  assert.equal(prepareCalls, 1);

  const concurrentNextResponses = await Promise.all([
    post(`/programs/${created.id}/next`, { generation: confirmed.generation, operationId: "desktop-next-a" }),
    post(`/programs/${created.id}/next`, { generation: confirmed.generation, operationId: "desktop-next-b" }),
  ]);
  assert.deepEqual(concurrentNextResponses.map((response) => response.status).sort(), [200, 409]);
  const successfulNextResponse = concurrentNextResponses.find((response) => response.status === 200)!;
  const rejectedNextResponse = concurrentNextResponses.find((response) => response.status === 409)!;
  assert.equal((await json(rejectedNextResponse)).code, "GENERATION_MISMATCH");
  const next = (await json(successfulNextResponse)).program;
  assert.equal(next.currentTrack.title, "场景歌单：study jazz");
  assert.equal(calls.filter((call) => call.startsWith("next:")).length, 1);
  const successfulNextOperationId = calls.find((call) => call.startsWith("next:"))!.split(":").at(-1)!;

  const stopResponse = await post(`/programs/${created.id}/stop`, { generation: confirmed.generation, operationId: "desktop-stop" });
  assert.equal(stopResponse.status, 200);
  assert.equal((await json(stopResponse)).program.status, "stopped");
  assert.equal(calls.filter((call) => call === "pause:qq_music:desktop-stop").length, 1);

  const oldConfirmReplay = await post(`/programs/${created.id}/confirm`, { generation: created.generation, operationId: "desktop-confirm" });
  assert.equal((await json(oldConfirmReplay)).program.status, "stopped");
  const oldNextReplay = await post(`/programs/${created.id}/next`, { generation: confirmed.generation, operationId: successfulNextOperationId });
  assert.equal((await json(oldNextReplay)).program.status, "stopped");
  const oldCreateReplay = await post("/programs", {
    spec: { sourceId: "qq_music", durationMinutes: 30, scenePreset: "study", sceneDescription: "jazz and arbitrary prose", hostDensity: "low", energyCurve: "steady", avoid: [] },
    operationId: "desktop-create",
  });
  assert.equal((await json(oldCreateReplay)).program.status, "stopped");
});

test("desktop preparation failure keeps the program unconfirmed", async (context) => {
  const desktopPlayerController: DesktopPlayerControllerLike = {
    async inspect(sourceId) {
      return { sourceId, state: "connected_idle", ok: true, controlledElements: 0, operationId: null, targetVolume: null, detail: "idle", appRunning: true, playing: false };
    },
    async duck(sourceId, operationId) {
      return { sourceId, state: "ducked", ok: true, controlledElements: 3, operationId, targetVolume: null, detail: "ducked", appRunning: true, playing: true };
    },
    async restore(sourceId, operationId) {
      return { sourceId, state: "restored", ok: true, controlledElements: 3, operationId, targetVolume: null, detail: "restored", appRunning: true, playing: null };
    },
    async pause(sourceId, operationId) {
      return { sourceId, state: "paused", ok: true, controlledElements: 0, operationId, targetVolume: null, detail: "paused", appRunning: true, playing: false };
    },
    async toggle(sourceId, operationId) {
      return { sourceId, state: "playing", ok: true, controlledElements: 0, operationId, targetVolume: null, detail: "playing", appRunning: true, playing: true };
    },
    async next(sourceId, operationId) {
      return { sourceId, state: "next_requested", ok: true, controlledElements: 0, operationId, targetVolume: null, detail: "next", appRunning: true, playing: null };
    },
  };
  const desktopProgramController: DesktopProgramControllerLike = {
    async prepare(sourceId, _scenePreset, _description, operationId) {
      return { sourceId, operationId, query: "party", state: "window_unavailable", ok: false, detail: "客户端窗口不可用。" };
    },
  };
  const service = await createLocalService({ port: 0, desktopPlayerController, desktopProgramController, localControlToken: "failure-token" });
  await service.start();
  context.after(() => service.stop());
  const base = `http://127.0.0.1:${service.port}/api`;
  const created = (await json(await fetch(`${base}/programs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spec: { sourceId: "qq_music", durationMinutes: 30, scenePreset: "party", sceneDescription: "", hostDensity: "high", energyCurve: "rising", avoid: [] } }),
  }))).program;
  const response = await fetch(`${base}/programs/${created.id}/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-one-radio-control-token": "failure-token" },
    body: JSON.stringify({ generation: created.generation, operationId: "failed-confirm" }),
  });
  assert.equal(response.status, 409);
  assert.equal((await json(response)).code, "DESKTOP_PROGRAM_FAILED");
  const current = (await json(await fetch(`${base}/program`, { headers: { "x-one-radio-control-token": "failure-token" } }))).program;
  assert.equal(current.status, "awaiting_confirmation");
});

test("desktop confirm retries preparation after an engine failure", async (context) => {
  const spec = {
    sourceId: "qq_music" as const,
    durationMinutes: 30,
    scenePreset: "study" as const,
    sceneDescription: "jazz",
    hostDensity: "low" as const,
    energyCurve: "steady",
    avoid: [],
  };
  const initialState: Record<string, any> = {
    id: "confirm-retry-program",
    generation: 1,
    status: "awaiting_confirmation",
    spec,
    startedAt: null,
    deadlineAt: null,
    remainingSeconds: 900,
    currentTrack: null,
    nextTrack: null,
    queue: [],
    host: null,
    recentHostLines: [],
    error: null,
  };
  let state: Record<string, any> | null = null;
  let confirmAttempts = 0;
  let playing = false;
  let pauseCalls = 0;
  let prepareCalls = 0;
  let invalidateCalls = 0;

  const desktopPlayerController: DesktopPlayerControllerLike = {
    async inspect(sourceId) {
      return {
        sourceId,
        state: playing ? "ready" : "connected_idle",
        ok: playing,
        controlledElements: 0,
        operationId: null,
        targetVolume: null,
        detail: playing ? "playing" : "idle",
        appRunning: true,
        playing,
      };
    },
    async duck(sourceId, operationId) {
      return { sourceId, state: "ducked", ok: true, controlledElements: 3, operationId, targetVolume: null, detail: "ducked", appRunning: true, playing: true };
    },
    async restore(sourceId, operationId) {
      return { sourceId, state: "restored", ok: true, controlledElements: 3, operationId, targetVolume: null, detail: "restored", appRunning: true, playing: false };
    },
    async pause(sourceId, operationId) {
      pauseCalls += 1;
      playing = false;
      return { sourceId, state: "paused", ok: true, controlledElements: 0, operationId, targetVolume: null, detail: "paused", appRunning: true, playing: false };
    },
    async toggle(sourceId, operationId) {
      playing = true;
      return { sourceId, state: "playing", ok: true, controlledElements: 0, operationId, targetVolume: null, detail: "playing", appRunning: true, playing: true };
    },
    async next(sourceId, operationId) {
      return { sourceId, state: "next_requested", ok: true, controlledElements: 0, operationId, targetVolume: null, detail: "next", appRunning: true, playing: true };
    },
  };
  const desktopProgramController: DesktopProgramControllerLike = {
    async prepare(sourceId, _scenePreset, _description, operationId) {
      prepareCalls += 1;
      playing = true;
      return { sourceId, operationId, query: "study jazz", state: "ready", ok: true, detail: "ready" };
    },
    invalidate(_sourceId, _operationId) {
      invalidateCalls += 1;
    },
  };
  const engine = {
    create() {
      state = { ...initialState };
      return state;
    },
    getState() {
      return state;
    },
    confirm() {
      confirmAttempts += 1;
      if (confirmAttempts === 1) throw new Error("transient engine failure");
      if (!state) throw new Error("program was not created");
      state = {
        ...state,
        status: "on_air",
        startedAt: new Date().toISOString(),
        deadlineAt: new Date(Date.now() + 900_000).toISOString(),
        currentTrack: { id: "desktop-current", title: "current", artist: "client", durationSeconds: 240, energy: 0.3, mood: ["steady"], color: "#456" },
      };
      return state;
    },
    tick() {
      return state;
    },
    heartbeat() {
      return state;
    },
    next() {
      return state;
    },
    stop() {
      return state;
    },
  };
  const service = await createLocalService({
    port: 0,
    engine,
    desktopPlayerController,
    desktopProgramController,
    localControlToken: "confirm-retry-token",
  });
  await service.start();
  context.after(() => service.stop());
  const base = `http://127.0.0.1:${service.port}/api`;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-one-radio-control-token": "confirm-retry-token" },
    body: JSON.stringify(body),
  });

  const created = (await json(await post("/programs", { spec }))).program;
  const first = await post(`/programs/${created.id}/confirm`, { generation: created.generation, operationId: "confirm-retry" });
  assert.equal(first.status, 500);
  assert.equal((await json(await fetch(`${base}/program`, { headers: { "x-one-radio-control-token": "confirm-retry-token" } }))).program.status, "awaiting_confirmation");
  assert.equal(playing, false);

  const second = await post(`/programs/${created.id}/confirm`, { generation: created.generation, operationId: "confirm-retry" });
  assert.equal(second.status, 200);
  assert.equal((await json(second)).program.status, "on_air");
  assert.equal(prepareCalls, 2);
  assert.equal(invalidateCalls, 1);
  assert.equal(pauseCalls, 1);
  assert.equal(playing, true);
});

test("confirmed desktop programs stop at their absolute deadline without waiting for the polling tick", async (context) => {
  const spec = {
    sourceId: "qq_music" as const,
    durationMinutes: 30,
    scenePreset: "study" as const,
    sceneDescription: "",
    hostDensity: "low" as const,
    energyCurve: "steady",
    avoid: [],
  };
  let state: Record<string, any> | null = null;
  let pauseAt = 0;
  const desktopPlayerController: DesktopPlayerControllerLike = {
    async inspect(sourceId) {
      return { sourceId, state: "connected_idle", ok: true, controlledElements: 0, operationId: null, targetVolume: null, detail: "ready", appRunning: true, playing: false };
    },
    async duck(sourceId, operationId) {
      return { sourceId, state: "ducked", ok: true, controlledElements: 1, operationId, targetVolume: null, detail: "ducked", appRunning: true, playing: true };
    },
    async restore(sourceId, operationId) {
      return { sourceId, state: "restored", ok: true, controlledElements: 1, operationId, targetVolume: null, detail: "restored", appRunning: true, playing: true };
    },
    async pause(sourceId, operationId) {
      pauseAt = Date.now();
      return { sourceId, state: "paused", ok: true, controlledElements: 0, operationId, targetVolume: null, detail: "paused", appRunning: true, playing: false };
    },
    async toggle(sourceId, operationId) {
      return { sourceId, state: "playing", ok: true, controlledElements: 0, operationId, targetVolume: null, detail: "playing", appRunning: true, playing: true };
    },
    async next(sourceId, operationId) {
      return { sourceId, state: "next_requested", ok: true, controlledElements: 0, operationId, targetVolume: null, detail: "next", appRunning: true, playing: true };
    },
  };
  const desktopProgramController: DesktopProgramControllerLike = {
    async prepare(sourceId, _scenePreset, _description, operationId) {
      return { sourceId, operationId, query: "study", state: "ready", ok: true, detail: "ready" };
    },
  };
  const engine = {
    create(input: typeof spec) {
      state = {
        id: "deadline-program",
        generation: 1,
        status: "awaiting_confirmation",
        spec: input,
        startedAt: null,
        deadlineAt: null,
        remainingSeconds: 900,
        currentTrack: null,
        nextTrack: null,
        queue: [],
        host: null,
        recentHostLines: [],
        error: null,
      };
      return state;
    },
    getState() { return state; },
    confirm() {
      const deadlineAt = new Date(Date.now() + 80).toISOString();
      state = { ...state!, status: "on_air", startedAt: new Date().toISOString(), deadlineAt };
      return state;
    },
    tick(now?: number) {
      if (state?.deadlineAt && (now ?? Date.now()) >= Date.parse(state.deadlineAt)) {
        state = { ...state, status: "completed", remainingSeconds: 0, currentTrack: null, nextTrack: null, queue: [] };
      }
      return state;
    },
    heartbeat() { return state; },
    next() { return state; },
    stop() { return state; },
  };
  const service = await createLocalService({
    port: 0,
    engine,
    desktopPlayerController,
    desktopProgramController,
    localControlToken: "deadline-token",
  });
  await service.start();
  context.after(() => service.stop());
  const base = `http://127.0.0.1:${service.port}/api`;
  const headers = { "content-type": "application/json", "x-one-radio-control-token": "deadline-token" };
  const created = (await json(await fetch(`${base}/programs`, { method: "POST", headers, body: JSON.stringify({ spec }) }))).program;
  const confirmedAt = Date.now();
  const confirmed = await fetch(`${base}/programs/${created.id}/confirm`, {
    method: "POST",
    headers,
    body: JSON.stringify({ generation: created.generation, operationId: "deadline-confirm" }),
  });
  assert.equal(confirmed.status, 200);

  const expiresAt = Date.now() + 700;
  while (pauseAt === 0 && Date.now() < expiresAt) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(pauseAt > 0, "desktop playback should be paused by the deadline timer");
  assert.ok(pauseAt - confirmedAt < 700, "deadline handling should not wait for the one-second polling interval");
  assert.equal((await json(await fetch(`${base}/program`, { headers }))).program.status, "completed");
});

test("terminal pause retries stop when a new same-source program takes over", async (context) => {
  const oldSpec = {
    sourceId: "qq_music" as const,
    durationMinutes: 30,
    scenePreset: "study" as const,
    sceneDescription: "",
    hostDensity: "low" as const,
    energyCurve: "steady",
    avoid: [],
  };
  let state: Record<string, any> = {
    id: "old-terminal-program",
    generation: 1,
    status: "on_air",
    spec: oldSpec,
    startedAt: new Date().toISOString(),
    deadlineAt: new Date(Date.now() + 900_000).toISOString(),
    remainingSeconds: 900,
    currentTrack: { id: "old-current", title: "old", artist: "client", durationSeconds: 240, energy: 0.3, mood: ["steady"], color: "#456" },
    nextTrack: null,
    queue: [],
    host: null,
    recentHostLines: [],
    error: null,
  };
  const terminalPauseOperations: string[] = [];
  const desktopPlayerController: DesktopPlayerControllerLike = {
    async inspect(sourceId) {
      return { sourceId, state: "connected_idle", ok: false, controlledElements: 0, operationId: null, targetVolume: null, detail: "idle", appRunning: true, playing: false };
    },
    async duck(sourceId, operationId) {
      return { sourceId, state: "ducked", ok: true, controlledElements: 3, operationId, targetVolume: null, detail: "ducked", appRunning: true, playing: true };
    },
    async restore(sourceId, operationId) {
      return { sourceId, state: "restored", ok: true, controlledElements: 3, operationId, targetVolume: null, detail: "restored", appRunning: true, playing: false };
    },
    async pause(sourceId, operationId) {
      if (operationId.startsWith("terminal-old-terminal-program")) terminalPauseOperations.push(operationId);
      return { sourceId, state: "command_unconfirmed", ok: false, controlledElements: 0, operationId, targetVolume: null, detail: "pause not confirmed", appRunning: true, playing: true };
    },
    async toggle(sourceId, operationId) {
      return { sourceId, state: "playing", ok: true, controlledElements: 0, operationId, targetVolume: null, detail: "playing", appRunning: true, playing: true };
    },
    async next(sourceId, operationId) {
      return { sourceId, state: "next_requested", ok: true, controlledElements: 0, operationId, targetVolume: null, detail: "next", appRunning: true, playing: true };
    },
  };
  const desktopProgramController: DesktopProgramControllerLike = {
    async prepare(sourceId, _scenePreset, _description, operationId) {
      return { sourceId, operationId, query: "study", state: "ready", ok: true, detail: "ready" };
    },
  };
  const engine = {
    create(spec: typeof oldSpec) {
      state = {
        id: "new-same-source-program",
        generation: 1,
        status: "awaiting_confirmation",
        spec,
        startedAt: null,
        deadlineAt: null,
        remainingSeconds: 900,
        currentTrack: null,
        nextTrack: null,
        queue: [],
        host: null,
        recentHostLines: [],
        error: null,
      };
      return state;
    },
    getState() {
      return state;
    },
    confirm() {
      state = {
        ...state,
        status: "on_air",
        startedAt: new Date().toISOString(),
        deadlineAt: new Date(Date.now() + 900_000).toISOString(),
        currentTrack: { id: "new-current", title: "new", artist: "client", durationSeconds: 240, energy: 0.3, mood: ["steady"], color: "#456" },
      };
      return state;
    },
    tick() {
      return state;
    },
    heartbeat() {
      return state;
    },
    next() {
      state = { ...state, status: "completed", generation: state.generation + 1, currentTrack: null };
      return state;
    },
    stop() {
      return state;
    },
  };
  const service = await createLocalService({
    port: 0,
    engine,
    desktopPlayerController,
    desktopProgramController,
    localControlToken: "terminal-handoff-token",
  });
  await service.start();
  context.after(() => service.stop());
  const base = `http://127.0.0.1:${service.port}/api`;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-one-radio-control-token": "terminal-handoff-token" },
    body: JSON.stringify(body),
  });

  const terminal = await post(`/programs/${state.id}/next`, { generation: 1, operationId: "terminal-next" });
  assert.equal(terminal.status, 200);
  assert.equal(terminalPauseOperations.length, 1);

  const created = (await json(await post("/programs", { spec: oldSpec }))).program;
  const confirmed = await post(`/programs/${created.id}/confirm`, { generation: created.generation, operationId: "new-confirm" });
  assert.equal(confirmed.status, 200);
  assert.equal((await json(confirmed)).program.status, "on_air");

  await new Promise((resolve) => setTimeout(resolve, 1_150));
  assert.equal(terminalPauseOperations.length, 1);
});

test("failed host output is never synthesized or returned as playable copy", async (context) => {
  let synthesizeCalls = 0;
  const controlToken = "failed-host-token";
  const service = await createLocalService({
    port: 0,
    localControlToken: controlToken,
    hostProvider: {
      generate() {
        return { success: false, status: "failed_technical", text: "这段失败文本绝不能被朗读。" };
      },
    },
    ttsProvider: {
      synthesize() {
        synthesizeCalls += 1;
        return { status: "ready", audio: Buffer.from("RIFF0000WAVE") };
      },
    },
  });
  await service.start();
  context.after(() => service.stop());

  const response = await fetch(`http://127.0.0.1:${service.port}/api/host/preview`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-one-radio-control-token": controlToken },
    body: JSON.stringify({ context: { scenePreset: "study" } }),
  });
  assert.equal(response.status, 200);
  const payload = await json(response);
  assert.equal(payload.host.status, "failed_technical");
  assert.equal(payload.host.text, null);
  assert.equal(payload.audio.status, "unavailable");
  assert.equal(synthesizeCalls, 0);
});

test("failed TTS output cannot smuggle bytes into the audio cache", async (context) => {
  const controlToken = "failed-tts-token";
  const service = await createLocalService({
    port: 0,
    localControlToken: controlToken,
    hostProvider: {
      generate() {
        return { success: true, status: "ready", text: "现在继续保持专注。", factIds: [] };
      },
    },
    ttsProvider: {
      synthesize() {
        return { success: false, status: "failed", audio: Buffer.from("RIFF0000WAVEsmuggled") };
      },
    },
  });
  await service.start();
  context.after(() => service.stop());

  const response = await fetch(`http://127.0.0.1:${service.port}/api/host/preview`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-one-radio-control-token": controlToken },
    body: JSON.stringify({ context: { scenePreset: "study" } }),
  });
  const payload = await json(response);
  assert.equal(payload.host.text, "现在继续保持专注。");
  assert.equal(payload.audio.status, "failed_technical");
  assert.equal(payload.audio.url, null);
});

test("host preview requires local authorization before invoking host or TTS", async (context) => {
  let hostCalls = 0;
  let ttsCalls = 0;
  const service = await createLocalService({
    port: 0,
    localControlToken: "host-preview-auth-token",
    hostProvider: { generate() { hostCalls += 1; return { success: true, status: "ready", text: "不应生成", factIds: [] }; } },
    ttsProvider: { synthesize() { ttsCalls += 1; return { success: true, status: "ready", audio: Buffer.from("RIFF0000WAVE") }; } },
  });
  await service.start();
  context.after(() => service.stop());

  const response = await fetch(`http://127.0.0.1:${service.port}/api/host/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ context: { scenePreset: "study" } }),
  });
  assert.equal(response.status, 401);
  assert.equal(hostCalls, 0);
  assert.equal(ttsCalls, 0);
});

test("NetEase planning enforces exact liked quotas and treats recent-only songs as exploration", async (context) => {
  const songs = Array.from({ length: 20 }, (_, index) => ({
    id: String(4_000 + index),
    title: `配额歌曲 ${index + 1}`,
    artists: [{ id: String(5_000 + index), name: `配额艺术家 ${index + 1}` }],
    durationMs: 180_000,
  }));
  const token = "exact-quota-token";
  const service = await createLocalService({
    port: 0,
    localControlToken: token,
    neteaseProvider: planningProvider(songs, songs.slice(0, 10).map((song) => song.id), [songs[17]!.id], [songs[18]!.id]),
    hostProvider: groundedHostProvider(),
    ttsProvider: readyTtsProvider,
  });
  await service.start();
  context.after(() => service.stop());
  const base = `http://127.0.0.1:${service.port}/api`;
  const create = async (ratio: number, operationId: string) => {
    const response = await fetch(`${base}/programs`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-one-radio-control-token": token },
      body: JSON.stringify({ operationId, spec: { sourceId: "netease_music", durationMinutes: 30, scenePreset: "study", sceneDescription: "", hostDensity: "low", energyCurve: "steady", avoid: [], familiarityRatio: ratio } }),
    });
    assert.equal(response.status, 201);
    return (await json(response)).program;
  };
  const stop = async (program: any, operationId: string) => {
    const response = await fetch(`${base}/programs/${program.id}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-one-radio-control-token": token },
      body: JSON.stringify({ generation: program.generation, operationId }),
    });
    assert.equal(response.status, 200);
    resetServerTestProfileDir();
  };

  for (const ratio of [0, 50, 100]) {
    const program = await create(ratio, `quota-create-${ratio}`);
    assert.equal(program.planSummary.actualFamiliarityRatio, ratio);
    assert.equal(program.planSummary.familiarTracks * 100, program.planSummary.totalTracks * ratio);
    assert.ok(program.rundown.every((track: { liked?: boolean; heard?: boolean }) => track.heard === track.liked));
    const recentOnly = program.rundown.find((track: { id: string }) => track.id === songs[17]!.id);
    if (ratio === 0) assert.ok(recentOnly);
    if (recentOnly) assert.equal(recentOnly.liked, false);
    await stop(program, `quota-stop-${ratio}`);
  }
});

test("NetEase planning treats familiarity as a target when the liked pool is empty", async (context) => {
  const songs = Array.from({ length: 20 }, (_, index) => ({
    id: String(4_100 + index),
    title: `纯探索歌曲 ${index + 1}`,
    artists: [{ id: String(5_100 + index), name: `探索艺术家 ${index + 1}` }],
    durationMs: 180_000,
  }));
  const token = "approximate-quota-token";
  const service = await createLocalService({
    port: 0,
    localControlToken: token,
    neteaseProvider: planningProvider(songs, []),
    hostProvider: groundedHostProvider(),
    ttsProvider: readyTtsProvider,
  });
  await service.start();
  context.after(() => service.stop());
  const response = await fetch(`http://127.0.0.1:${service.port}/api/programs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-one-radio-control-token": token },
    body: JSON.stringify({ spec: { sourceId: "netease_music", durationMinutes: 60, scenePreset: "study", sceneDescription: "", hostDensity: "low", energyCurve: "steady", avoid: [], familiarityRatio: 20 } }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  const program = (await json(response)).program;
  assert.equal(program.planSummary.targetFamiliarityRatio, 20);
  assert.equal(program.planSummary.actualFamiliarityRatio, 0);
  assert.equal(program.planSummary.familiarTracks, 0);
  assert.equal(program.planSummary.unheardTracks, 19);
  assert.ok(program.rundown.reduce((total: number, track: { durationSeconds: number }) => total + track.durationSeconds, 0) >= 60 * 60 * 0.92);
});

test("NetEase planning relaxes familiar quota when selected styles need discovery songs", async (context) => {
  const likedSongs = Array.from({ length: 8 }, (_, index) => ({
    id: String(4_120 + index),
    title: `收藏情歌 ${index + 1}`,
    artists: [{ id: String(5_120 + index), name: `情歌艺术家 ${index + 1}` }],
    durationMs: 180_000,
  }));
  const discoverySongs = Array.from({ length: 10 }, (_, index) => ({
    id: String(4_180 + index),
    title: `派对电子 ${index + 1}`,
    artists: [{ id: String(5_180 + index), name: `电子艺术家 ${index + 1}` }],
    durationMs: 180_000,
  }));
  const token = "style-relaxed-quota-token";
  const directSearchQueries: string[] = [];
  const baseProvider = planningProvider([...likedSongs, ...discoverySongs], likedSongs.map((song) => song.id));
  const service = await createLocalService({
    port: 0,
    localControlToken: token,
    neteaseProvider: {
      ...baseProvider,
      search(keyword: string) { directSearchQueries.push(keyword); return { songs: [], total: 0 }; },
      searchPlaylists() {
        return { total: 1, playlists: [{ id: "style-relaxed-playlist", name: "派对电子精选", description: null, trackCount: discoverySongs.length }] };
      },
      playlistDetail(id: string) {
        return { id, name: "派对电子精选", description: null, trackCount: discoverySongs.length, tracks: discoverySongs };
      },
    },
    hostProvider: groundedHostProvider(),
    ttsProvider: readyTtsProvider,
  });
  await service.start();
  context.after(() => service.stop());
  const response = await fetch(`http://127.0.0.1:${service.port}/api/programs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-one-radio-control-token": token },
    body: JSON.stringify({ spec: { sourceId: "netease_music", durationMinutes: 30, scenePreset: "party", sceneDescription: "", hostDensity: "low", energyCurve: "high", avoid: [], familiarityRatio: 75, musicGenres: ["rock", "electronic"] } }),
  });
  assert.equal(response.status, 201);
  const program = (await json(response)).program;
  assert.equal(program.planSummary.targetFamiliarityRatio, 75);
  assert.ok(program.planSummary.actualFamiliarityRatio < 75);
  assert.ok(program.planSummary.unheardTracks >= program.planSummary.familiarTracks);
  assert.ok(program.rundown.some((track: { title: string }) => track.title.startsWith("派对电子")));
  assert.deepEqual(directSearchQueries, []);
});

test("NetEase planning anchors explicit styles to matching user artists and familiar songs", async (context) => {
  const likedSongs = [
    {
      id: "style-rnb-liked",
      title: "R&B 私藏",
      artists: [{ id: "style-rnb-artist", name: "Soul Anchor" }],
      durationMs: 180_000,
      styleTags: ["rnb_soul"],
    },
    {
      id: "style-rock-liked",
      title: "摇滚私藏",
      artists: [{ id: "style-rock-artist", name: "Rock Anchor" }],
      durationMs: 180_000,
      styleTags: ["rock"],
    },
  ];
  const rockDiscoverySongs = Array.from({ length: 9 }, (_, index) => ({
    id: `style-rock-discovery-${index + 1}`,
    title: `Rock Anchor 摇滚新歌 ${index + 1}`,
    artists: [{ id: `style-rock-discovery-artist-${index + 1}`, name: `摇滚新艺术家 ${index + 1}` }],
    durationMs: 180_000,
  }));
  const directSearchQueries: string[] = [];
  const playlistQueries: string[] = [];
  const token = "style-anchor-token";
  const baseProvider = planningProvider([...likedSongs, ...rockDiscoverySongs], likedSongs.map((song) => song.id));
  const service = await createLocalService({
    port: 0,
    localControlToken: token,
    neteaseProvider: {
      ...baseProvider,
      search(keyword: string) {
        directSearchQueries.push(keyword);
        return { songs: [], total: 0 };
      },
      searchPlaylists(keyword: string) {
        playlistQueries.push(keyword);
        return { total: 1, playlists: [{ id: "rock-anchor-playlist", name: keyword, description: null, trackCount: rockDiscoverySongs.length }] };
      },
      playlistDetail(id: string) {
        return { id, name: "摇滚精选", description: null, trackCount: rockDiscoverySongs.length, tracks: rockDiscoverySongs };
      },
    },
    hostProvider: groundedHostProvider(),
    ttsProvider: readyTtsProvider,
  });
  await service.start();
  context.after(() => service.stop());

  const response = await fetch(`http://127.0.0.1:${service.port}/api/programs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-one-radio-control-token": token },
    body: JSON.stringify({ spec: { sourceId: "netease_music", durationMinutes: 30, scenePreset: "party", sceneDescription: "", hostDensity: "low", energyCurve: "high", avoid: [], familiarityRatio: 75, musicGenres: ["rock"] } }),
  });

  assert.equal(response.status, 201);
  const program = (await json(response)).program;
  assert.deepEqual(directSearchQueries, []);
  assert.ok(playlistQueries.some((query) => /Rock Anchor/.test(query) && /摇滚|Rock/i.test(query)));
  assert.ok(program.rundown.some((track: { id: string }) => track.id === "style-rock-liked"));
  assert.ok(program.rundown.every((track: { id: string }) => track.id !== "style-rnb-liked"));
});

test("explicit Britpop recommendations use style playlists instead of a British song-title search", async (context) => {
  const playlistSongs = Array.from({ length: 12 }, (_, index) => ({
    id: `britpop-playlist-${index + 1}`,
    title: `英伦乐队作品 ${index + 1}`,
    artists: [{ id: `britpop-artist-${index + 1}`, name: `UK Indie Artist ${index + 1}` }],
    durationMs: 180_000,
    popularity: 80 + index,
  }));
  const misleadingSongs = Array.from({ length: 12 }, (_, index) => ({
    id: `british-title-${index + 1}`,
    title: index === 0 ? "British" : `British Medley ${index + 1}`,
    artists: [{ id: `unrelated-artist-${index + 1}`, name: `Unrelated Artist ${index + 1}` }],
    durationMs: 180_000,
    popularity: 99,
  }));
  const directSearchQueries: string[] = [];
  const playlistQueries: string[] = [];
  const token = "britpop-playlist-first-token";
  const baseProvider = planningProvider([...playlistSongs, ...misleadingSongs], []);
  const service = await createLocalService({
    port: 0,
    localControlToken: token,
    neteaseProvider: {
      ...baseProvider,
      search(keyword: string) {
        directSearchQueries.push(keyword);
        return { songs: misleadingSongs, total: misleadingSongs.length };
      },
      searchPlaylists(keyword: string) {
        playlistQueries.push(keyword);
        return {
          total: 1,
          playlists: [{ id: `britpop-list-${playlistQueries.length}`, name: `${keyword} 精选`, description: null, trackCount: playlistSongs.length, ownerUid: "public-britpop", subscribed: false }],
        };
      },
      playlistDetail(id: string) {
        return { id, name: "英伦摇滚精选", description: null, trackCount: playlistSongs.length, tracks: playlistSongs };
      },
    },
    hostProvider: groundedHostProvider(),
    ttsProvider: readyTtsProvider,
  });
  await service.start();
  context.after(() => service.stop());

  const response = await fetch(`http://127.0.0.1:${service.port}/api/programs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-one-radio-control-token": token },
    body: JSON.stringify({ spec: { sourceId: "netease_music", durationMinutes: 30, scenePreset: "commute", sceneDescription: "", hostDensity: "low", energyCurve: "steady", avoid: [], familiarityRatio: 10, recommendationMode: "genre", musicGenres: ["britpop"] } }),
  });

  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  const program = (await json(response)).program;
  assert.deepEqual(directSearchQueries, []);
  assert.ok(playlistQueries.some((query) => /英伦摇滚|Britpop|UK Indie/.test(query)));
  assert.ok(playlistQueries.every((query) => !/\bBritish\b/i.test(query)));
  assert.ok(program.rundown.length > 0);
  assert.ok(program.rundown.every((track: { id: string }) => track.id.startsWith("britpop-playlist-")));
});

test("explicit genre recommendations reject unrelated fuzzy playlist results and use varied verified queries", async (context) => {
  const reggaeSongs = Array.from({ length: 12 }, (_, index) => ({
    id: `verified-reggae-${index + 1}`,
    title: `Island Groove ${index + 1}`,
    artists: [{ id: `reggae-artist-${index + 1}`, name: `Reggae Artist ${index + 1}` }],
    durationMs: 180_000,
  }));
  const playlistQueries: string[] = [];
  const detailIds: string[] = [];
  const token = "verified-reggae-playlists-token";
  const baseProvider = planningProvider(reggaeSongs, []);
  const service = await createLocalService({
    port: 0,
    localControlToken: token,
    neteaseProvider: {
      ...baseProvider,
      search() { return { songs: [], total: 0 }; },
      searchPlaylists(keyword: string) {
        playlistQueries.push(keyword);
        return {
          total: 2,
          playlists: [
            { id: `unrelated-${playlistQueries.length}`, name: "华语流行情歌热榜", description: "热门抒情歌曲", trackCount: reggaeSongs.length },
            { id: `reggae-${playlistQueries.length}`, name: "牙买加 Reggae 与 Dub 律动", description: "Roots reggae and ska collection", trackCount: reggaeSongs.length },
          ],
        };
      },
      playlistDetail(id: string) {
        detailIds.push(id);
        return { id, name: "牙买加 Reggae 与 Dub 律动", description: "Roots reggae and ska collection", trackCount: reggaeSongs.length, tracks: reggaeSongs };
      },
    },
    hostProvider: groundedHostProvider(),
    ttsProvider: readyTtsProvider,
  });
  await service.start();
  context.after(() => service.stop());

  const response = await fetch(`http://127.0.0.1:${service.port}/api/programs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-one-radio-control-token": token },
    body: JSON.stringify({ spec: { sourceId: "netease_music", durationMinutes: 30, scenePreset: "party", sceneDescription: "", hostDensity: "low", energyCurve: "high", avoid: [], familiarityRatio: 10, recommendationMode: "genre", musicGenres: ["reggae"] } }),
  });

  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  const program = (await json(response)).program;
  assert.ok(playlistQueries.length >= 5);
  assert.ok(playlistQueries.some((query) => /牙买加|Dub|Ska/i.test(query)));
  assert.ok(detailIds.length > 0);
  assert.ok(detailIds.every((id) => id.startsWith("reggae-")));
  assert.ok(program.rundown.every((track: { id: string; styleTags?: string[] }) => track.id.startsWith("verified-reggae-") && track.styleTags?.includes("reggae")));
});

test("NetEase atmosphere exploration searches party playlists and samples different style pools", async (context) => {
  const likedSongs = Array.from({ length: 8 }, (_, index) => ({
    id: String(18_000 + index),
    title: `安静收藏 ${index + 1}`,
    artists: [{ id: String(19_000 + index), name: `安静歌手 ${index + 1}` }],
    durationMs: 180_000,
  }));
  const electronicSongs = Array.from({ length: 5 }, (_, index) => ({
    id: String(20_000 + index),
    title: `公共电子舞曲 ${index + 1}`,
    artists: [{ id: String(21_000 + index), name: `电子制作人 ${index + 1}` }],
    durationMs: 180_000,
  }));
  const rapSongs = Array.from({ length: 5 }, (_, index) => ({
    id: String(22_000 + index),
    title: `公共说唱段落 ${index + 1}`,
    artists: [{ id: String(23_000 + index), name: `说唱音乐人 ${index + 1}` }],
    durationMs: 180_000,
  }));
  const playlistDetailCalls: string[] = [];
  const playlistQueries: string[] = [];
  const token = "public-playlist-style-token";
  const baseProvider = planningProvider([...likedSongs, ...electronicSongs, ...rapSongs], likedSongs.map((song) => song.id));
  const service = await createLocalService({
    port: 0,
    localControlToken: token,
    neteaseProvider: {
      ...baseProvider,
      search() { return { songs: [], total: 0 }; },
      searchPlaylists(keyword: string) {
        playlistQueries.push(keyword);
        const playlists: Array<{ id: string; name: string; description: string | null; trackCount: number; ownerUid: string; subscribed: boolean }> = [
          { id: `blocked-${keyword}`, name: "低音重鼓Dj车载系列（精品50首）", description: "低音重鼓精选", trackCount: 50, ownerUid: "blocked-owner", subscribed: false },
        ];
        if (/电子|Electronic/i.test(keyword)) {
          playlists.push({ id: `electronic-${keyword}`, name: `${keyword} 电子派对`, description: null, trackCount: electronicSongs.length, ownerUid: "public-a", subscribed: false });
        }
        if (/说唱|Hip-Hop|hiphop|Rap/i.test(keyword)) {
          playlists.push({ id: `rap-${keyword}`, name: `${keyword} 说唱派对`, description: null, trackCount: rapSongs.length, ownerUid: "public-b", subscribed: false });
        }
        return {
          total: playlists.length,
          playlists,
        };
      },
      playlistDetail(id: string) {
        playlistDetailCalls.push(id);
        const tracks = id.startsWith("electronic-") ? electronicSongs : rapSongs;
        return { id, name: id, description: null, trackCount: tracks.length, tracks };
      },
    },
    hostProvider: groundedHostProvider(),
    ttsProvider: readyTtsProvider,
  });
  await service.start();
  context.after(() => service.stop());

  const response = await fetch(`http://127.0.0.1:${service.port}/api/programs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-one-radio-control-token": token },
    body: JSON.stringify({ spec: { sourceId: "netease_music", durationMinutes: 30, scenePreset: "party", sceneDescription: "", hostDensity: "low", energyCurve: "high", avoid: [], familiarityRatio: 10, recommendationMode: "atmosphere", musicGenres: [] } }),
  });

  assert.equal(response.status, 201);
  const program = (await json(response)).program;
  assert.ok(playlistQueries.some((query) => /朋友聚会|周末派对|Party Hits|House Party/i.test(query)));
  assert.ok(playlistQueries.every((query) => !/热门榜单|大众热门/.test(query)));
  assert.ok(playlistDetailCalls.every((id) => !id.startsWith("blocked-")));
  assert.ok(playlistDetailCalls.some((id) => id.startsWith("electronic-")));
  assert.ok(playlistDetailCalls.some((id) => id.startsWith("rap-")));
  assert.ok(program.rundown.some((track: { title: string }) => track.title.startsWith("公共电子舞曲")));
  assert.ok(program.rundown.some((track: { title: string }) => track.title.startsWith("公共说唱段落")));
});

test("NetEase atmosphere exploration prefers mainstream public-playlist songs over old remix and niche defaults", async (context) => {
  const blockedSongs = Array.from({ length: 18 }, (_, index) => {
    const kind = index % 3;
    return {
      id: String(23_000 + index),
      title: kind === 0 ? `怀旧老歌 ${index + 1}` : kind === 1 ? `运动热播 Remix ${index + 1}` : `New Age 冥想 ${index + 1}`,
      artists: [{ id: String(24_000 + index), name: `问题歌手 ${index + 1}` }],
      durationMs: 180_000,
      releaseYear: kind === 0 ? 2006 : 2025,
      popularity: 96,
      styleTags: kind === 2 ? ["new_age"] : ["dance"],
      searchQuery: kind === 2 ? "运动 new age" : "运动 remix 老歌",
    };
  });
  const publicSongs = Array.from({ length: 14 }, (_, index) => ({
    id: String(25_000 + index),
    title: `榜单运动新歌 ${index + 1}`,
    artists: [{ id: String(26_000 + index), name: `榜单歌手 ${index + 1}` }],
    durationMs: 180_000,
    releaseYear: 2026,
    popularity: 92,
    styleTags: index % 2 === 0 ? ["electronic"] : ["hiphop"],
    searchQuery: "运动 热门榜单 歌单",
  }));
  const playlistQueries: string[] = [];
  const token = "atmosphere-exploration-token";
  const baseProvider = planningProvider([...blockedSongs, ...publicSongs], []);
  const service = await createLocalService({
    port: 0,
    localControlToken: token,
    neteaseProvider: {
      ...baseProvider,
      search() { return { songs: blockedSongs, total: blockedSongs.length }; },
      searchPlaylists(keyword: string) {
        playlistQueries.push(keyword);
        return {
          total: 1,
          playlists: [{ id: `workout-mainstream-${playlistQueries.length}`, name: `${keyword} 大众热门`, description: null, trackCount: publicSongs.length, ownerUid: "public-workout", subscribed: false }],
        };
      },
      playlistDetail(id: string) {
        return { id, name: id, description: null, trackCount: publicSongs.length, tracks: publicSongs };
      },
    },
    hostProvider: groundedHostProvider(),
    ttsProvider: readyTtsProvider,
  });
  await service.start();
  context.after(() => service.stop());

  const response = await fetch(`http://127.0.0.1:${service.port}/api/programs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-one-radio-control-token": token },
    body: JSON.stringify({ spec: { sourceId: "netease_music", durationMinutes: 30, scenePreset: "workout", sceneDescription: "", hostDensity: "low", energyCurve: "high", avoid: [], familiarityRatio: 10, recommendationMode: "atmosphere", musicGenres: [] } }),
  });

  assert.equal(response.status, 201);
  const program = (await json(response)).program;
  assert.ok(playlistQueries.some((query) => /运动|健身|跑步|榜单|热门/.test(query)));
  assert.ok(program.rundown.length >= 8);
  assert.ok(program.rundown.every((track: { title: string }) => track.title.startsWith("榜单运动新歌")));
});

test("NetEase planning excludes played exploration tracks but still permits liked replays", async (context) => {
  const previousSongs = Array.from({ length: 20 }, (_, index) => ({
    id: String(24_000 + index),
    title: `上次节目歌曲 ${index + 1}`,
    artists: [{ id: String(25_000 + index), name: `历史歌手 ${index + 1}` }],
    durationMs: 60_000,
    styleTags: ["electronic"],
  }));
  const freshSongs = Array.from({ length: 30 }, (_, index) => ({
    id: String(26_000 + index),
    title: `新鲜派对歌曲 ${index + 1}`,
    artists: [{ id: String(27_000 + index), name: `新歌手 ${index + 1}` }],
    durationMs: 60_000,
    styleTags: ["electronic"],
  }));
  const profileDir = mkdtempSync(join(tmpdir(), "one-radio-profile-"));
  const previousProfileDir = process.env.ONE_RADIO_PROFILE_DIR;
  process.env.ONE_RADIO_PROFILE_DIR = profileDir;
  context.after(() => {
    if (previousProfileDir === undefined) delete process.env.ONE_RADIO_PROFILE_DIR;
    else process.env.ONE_RADIO_PROFILE_DIR = previousProfileDir;
    rmSync(profileDir, { recursive: true, force: true });
  });
  const accountKey = createHash("sha256").update("netease:7").digest("hex").slice(0, 24);
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, `netease-${accountKey}.json`), JSON.stringify({
    version: 1,
    playedTracks: previousSongs.map((song, index) => ({ id: song.id, title: song.title, artist: song.artists[0]!.name, playedAt: `2026-08-${String(index + 1).padStart(2, "0")}T00:00:00.000Z` })),
  }));

  const token = "recent-repeat-limit-token";
  const service = await createLocalService({
    port: 0,
    localControlToken: token,
    neteaseProvider: planningProvider([...previousSongs, ...freshSongs], [previousSongs[0]!.id]),
    hostProvider: groundedHostProvider(),
    ttsProvider: readyTtsProvider,
  });
  await service.start();
  context.after(() => service.stop());

  const response = await fetch(`http://127.0.0.1:${service.port}/api/programs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-one-radio-control-token": token },
    body: JSON.stringify({ spec: { sourceId: "netease_music", durationMinutes: 30, scenePreset: "party", sceneDescription: "", hostDensity: "low", energyCurve: "high", avoid: [], familiarityRatio: 10, musicGenres: ["electronic"] } }),
  });

  assert.equal(response.status, 201);
  const program = (await json(response)).program;
  const previousIds = new Set(previousSongs.map((song) => song.id));
  assert.ok(program.rundown.length >= 10);
  assert.ok(program.rundown.some((track: { id: string }) => track.id === previousSongs[0]!.id));
  assert.ok(program.rundown.every((track: { id: string }) => !previousIds.has(track.id) || track.id === previousSongs[0]!.id));
});

test("music atmosphere changes the account rundown arc without changing the candidate pool", async (context) => {
  const songs = Array.from({ length: 10 }, (_, index) => ({
    id: String(4_150 + index),
    title: `氛围候选 ${index + 1}`,
    artists: [{ id: String(5_150 + index), name: `氛围艺术家 ${index + 1}` }],
    durationMs: 180_000,
  }));
  const token = "atmosphere-order-token";
  const service = await createLocalService({
    port: 0,
    localControlToken: token,
    neteaseProvider: planningProvider(songs, []),
    hostProvider: groundedHostProvider(),
    ttsProvider: readyTtsProvider,
  });
  await service.start();
  context.after(() => service.stop());
  const base = `http://127.0.0.1:${service.port}/api`;
  const create = async (scenePreset: "late_night" | "party", operationId: string) => {
    const response = await fetch(`${base}/programs`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-one-radio-control-token": token },
      body: JSON.stringify({ operationId, spec: { sourceId: "netease_music", durationMinutes: 30, scenePreset, sceneDescription: "", hostDensity: "low", energyCurve: "scene", avoid: [], familiarityRatio: 0 } }),
    });
    assert.equal(response.status, 201);
    return (await json(response)).program;
  };
  const stop = async (program: any, operationId: string) => {
    const response = await fetch(`${base}/programs/${program.id}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-one-radio-control-token": token },
      body: JSON.stringify({ generation: program.generation, operationId }),
    });
    assert.equal(response.status, 200);
  };

  const relaxed = await create("late_night", "atmosphere-relaxed");
  await stop(relaxed, "atmosphere-relaxed-stop");
  resetServerTestProfileDir();
  const party = await create("party", "atmosphere-party");
  assert.notDeepEqual(relaxed.rundown.map((track: { id: string }) => track.id), party.rundown.map((track: { id: string }) => track.id));
  assert.ok(relaxed.rundown[0].arrangementTargetEnergy < party.rundown[0].arrangementTargetEnergy);
  assert.ok(relaxed.rundown.every((track: { energy: number; energyMeasured?: boolean }) => track.energy === 0.5 && track.energyMeasured === false));
  assert.ok(party.rundown.every((track: { energy: number; energyMeasured?: boolean }) => track.energy === 0.5 && track.energyMeasured === false));
  assert.ok(relaxed.rundown.reduce((total: number, track: { durationSeconds: number }) => total + track.durationSeconds, 0) >= 30 * 60);
  assert.ok(party.rundown.reduce((total: number, track: { durationSeconds: number }) => total + track.durationSeconds, 0) >= 30 * 60);
});

test("NetEase planning reserves discovery candidates before truncating a large liked library", async (context) => {
  const likedSongs = Array.from({ length: 100 }, (_, index) => ({
    id: String(10_000 + index),
    title: `大量收藏 ${index + 1}`,
    artists: [{ id: String(11_000 + index), name: `收藏艺术家 ${index + 1}` }],
    durationMs: 180_000,
  }));
  const discoverySongs = Array.from({ length: 40 }, (_, index) => ({
    id: String(12_000 + index),
    title: `探索候选 ${index + 1}`,
    artists: [{ id: String(13_000 + index), name: `探索艺术家 ${index + 1}` }],
    durationMs: 180_000,
  }));
  const token = "large-library-quota-token";
  const service = await createLocalService({
    port: 0,
    localControlToken: token,
    neteaseProvider: planningProvider([...likedSongs, ...discoverySongs], likedSongs.map((song) => song.id)),
    hostProvider: groundedHostProvider(),
    ttsProvider: readyTtsProvider,
  });
  await service.start();
  context.after(() => service.stop());
  const response = await fetch(`http://127.0.0.1:${service.port}/api/programs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-one-radio-control-token": token },
    body: JSON.stringify({ spec: { sourceId: "netease_music", durationMinutes: 30, scenePreset: "study", sceneDescription: "", hostDensity: "low", energyCurve: "steady", avoid: [], familiarityRatio: 20 } }),
  });
  assert.equal(response.status, 201);
  const program = (await json(response)).program;
  assert.equal(program.planSummary.actualFamiliarityRatio, 20);
  assert.ok(program.planSummary.unheardTracks > 0);
  assert.equal(program.planSummary.familiarTracks * 100, program.planSummary.totalTracks * 20);
});

test("NetEase planning uses playable quota backups for unavailable and trial-only songs", async (context) => {
  const likedSongs = Array.from({ length: 100 }, (_, index) => ({
    id: String(14_000 + index),
    title: `后备收藏 ${index + 1}`,
    artists: [{ id: String(15_000 + index), name: `后备收藏艺术家 ${index + 1}` }],
    durationMs: 180_000,
  }));
  const discoverySongs = Array.from({ length: 40 }, (_, index) => ({
    id: String(16_000 + index),
    title: `后备探索 ${index + 1}`,
    artists: [{ id: String(17_000 + index), name: `后备探索艺术家 ${index + 1}` }],
    durationMs: 180_000,
  }));
  const unavailableIds = new Set(likedSongs.slice(0, 5).map((song) => song.id));
  const trialOnlyIds = new Set(likedSongs.slice(5, 10).map((song) => song.id));
  const provider = planningProvider([...likedSongs, ...discoverySongs], likedSongs.map((song) => song.id));
  const token = "playable-quota-backup-token";
  const service = await createLocalService({
    port: 0,
    localControlToken: token,
    neteaseProvider: {
      ...provider,
      songUrl(id: string) {
        if (unavailableIds.has(id)) return { id, url: null };
        if (trialOnlyIds.has(id)) return { id, url: `https://music.126.net/${id}-trial.mp3`, isTrial: true, durationMs: 30_000 };
        return { id, url: `https://music.126.net/${id}.mp3`, durationMs: 180_000 };
      },
    },
    hostProvider: groundedHostProvider(),
    ttsProvider: readyTtsProvider,
  });
  await service.start();
  context.after(() => service.stop());
  const response = await fetch(`http://127.0.0.1:${service.port}/api/programs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-one-radio-control-token": token },
    body: JSON.stringify({ spec: { sourceId: "netease_music", durationMinutes: 30, scenePreset: "study", sceneDescription: "", hostDensity: "low", energyCurve: "steady", avoid: [], familiarityRatio: 20 } }),
  });
  assert.equal(response.status, 201);
  const program = (await json(response)).program;
  assert.equal(program.planSummary.actualFamiliarityRatio, 20);
  assert.equal(program.planSummary.familiarTracks * 100, program.planSummary.totalTracks * 20);
  assert.ok(program.rundown.every((track: { id: string }) => !unavailableIds.has(track.id)));
  assert.ok(program.rundown.every((track: { id: string }) => !trialOnlyIds.has(track.id)));
  assert.equal(new Set(program.rundown.map((track: { artist: string }) => track.artist)).size, program.rundown.length);
});

test("account planning treats requested duration as a soft target", async (context) => {
  const songs = Array.from({ length: 7 }, (_, index) => ({
    id: String(17_300 + index), title: `软时长歌曲 ${index + 1}`, artists: [{ id: String(17_400 + index), name: `软时长艺人 ${index + 1}` }], durationMs: 240_000,
  }));
  const token = "soft-duration-token";
  const service = await createLocalService({ port: 0, localControlToken: token, neteaseProvider: planningProvider(songs, []), hostProvider: groundedHostProvider(), ttsProvider: readyTtsProvider });
  await service.start();
  context.after(() => service.stop());
  const response = await fetch(`http://127.0.0.1:${service.port}/api/programs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-one-radio-control-token": token },
    body: JSON.stringify({ operationId: "soft-duration-create", spec: { sourceId: "netease_music", durationMinutes: 30, scenePreset: "study", sceneDescription: "", hostDensity: "low", energyCurve: "steady", avoid: [], familiarityRatio: 0 } }),
  });
  assert.equal(response.status, 201);
  const program = (await json(response)).program;
  assert.equal(program.rundown.reduce((total: number, track: { durationSeconds: number }) => total + track.durationSeconds, 0), 28 * 60);
});

test("delete and replace can use one short backup without rebuilding a full-duration pool", async (context) => {
  const songs = Array.from({ length: 6 }, (_, index) => ({
    id: String(17_500 + index),
    title: `原位替换候选 ${index + 1}`,
    artists: [{ id: String(17_600 + index), name: `原位替换艺人 ${index + 1}` }],
    durationMs: index === 5 ? 180_000 : 360_000,
  }));
  const token = "single-replacement-backup-token";
  const service = await createLocalService({
    port: 0,
    localControlToken: token,
    neteaseProvider: planningProvider(songs, []),
    hostProvider: groundedHostProvider(),
    ttsProvider: readyTtsProvider,
  });
  await service.start();
  context.after(() => service.stop());
  const base = `http://127.0.0.1:${service.port}/api`;
  const headers = { "content-type": "application/json", "x-one-radio-control-token": token };
  const createdResponse = await fetch(`${base}/programs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ operationId: "single-backup-create", spec: { sourceId: "netease_music", durationMinutes: 30, scenePreset: "study", sceneDescription: "", hostDensity: "low", energyCurve: "steady", avoid: [], familiarityRatio: 0 } }),
  });
  assert.equal(createdResponse.status, 201);
  const draft = (await json(createdResponse)).program;
  assert.equal(draft.rundown.length, 5);
  const originalIds = draft.rundown.map((track: { id: string }) => track.id);
  const replaceIndex = 2;
  const replaceResponse = await fetch(`${base}/programs/${draft.id}/replace`, {
    method: "POST",
    headers,
    body: JSON.stringify({ generation: draft.generation, planRevision: 0, operationId: "single-backup-replace", trackId: originalIds[replaceIndex] }),
  });
  assert.equal(replaceResponse.status, 200, await replaceResponse.clone().text());
  const replaced = (await json(replaceResponse)).program;
  assert.equal(replaced.rundown.length, 5);
  assert.notEqual(replaced.rundown[replaceIndex].id, originalIds[replaceIndex]);
  assert.deepEqual(replaced.rundown.filter((_: unknown, index: number) => index !== replaceIndex).map((track: { id: string }) => track.id), originalIds.filter((_: string, index: number) => index !== replaceIndex));
});

test("planner chat finds requested music and returns useful success or failure messages", async (context) => {
  const baseSongs = Array.from({ length: 6 }, (_, index) => ({
    id: String(17_700 + index), title: `基础歌曲 ${index + 1}`, artists: [{ id: String(17_800 + index), name: `基础艺人 ${index + 1}` }], durationMs: 360_000,
  }));
  const requestedSongs = Array.from({ length: 3 }, (_, index) => ({
    id: String(17_900 + index), title: `周杰伦候选 ${index + 1}`, artists: [{ id: "jay", name: "周杰伦" }], durationMs: 240_000,
  }));
  const rockSongs = Array.from({ length: 3 }, (_, index) => ({
    id: String(17_950 + index), title: `摇滚歌单候选 ${index + 1}`, artists: [{ id: `rock-${index}`, name: `摇滚艺人 ${index + 1}` }], durationMs: 240_000,
  }));
  const baseProvider = planningProvider(baseSongs, []);
  const searchTerms: string[] = [];
  const playlistSearchTerms: string[] = [];
  const token = "planner-search-token";
  const service = await createLocalService({
    port: 0,
    localControlToken: token,
    neteaseProvider: {
      ...baseProvider,
      search(keyword: string) {
        searchTerms.push(keyword);
        if (keyword === "周杰伦") return { songs: requestedSongs, total: requestedSongs.length };
        if (keyword === "不存在的歌手") return { songs: [], total: 0 };
        return { songs: baseSongs, total: baseSongs.length };
      },
      searchPlaylists(keyword: string) {
        playlistSearchTerms.push(keyword);
        return /(?:摇滚|Rock)/i.test(keyword)
          ? { playlists: [{ id: "rock-playlist", name: "摇滚精选歌单" }], total: 1 }
          : { playlists: [], total: 0 };
      },
      playlistDetail(id: string) { return id === "rock-playlist" ? { id, name: "摇滚精选歌单", tracks: rockSongs } : { id, tracks: [] }; },
      songDetail(ids: string[]) { return [...baseSongs, ...requestedSongs, ...rockSongs].filter((song) => ids.includes(song.id)); },
      songUrl(id: string) { return { id, url: `https://music.126.net/${id}.mp3`, durationMs: [...baseSongs, ...requestedSongs, ...rockSongs].find((song) => song.id === id)?.durationMs }; },
    },
    hostProvider: groundedHostProvider(),
    ttsProvider: readyTtsProvider,
  });
  await service.start();
  context.after(() => service.stop());
  const base = `http://127.0.0.1:${service.port}/api`;
  const headers = { "content-type": "application/json", "x-one-radio-control-token": token };
  const createdResponse = await fetch(`${base}/programs`, {
    method: "POST", headers,
    body: JSON.stringify({ operationId: "planner-search-create", spec: { sourceId: "netease_music", durationMinutes: 30, scenePreset: "study", sceneDescription: "", hostDensity: "low", energyCurve: "steady", avoid: [], familiarityRatio: 0 } }),
  });
  assert.equal(createdResponse.status, 201);
  const draft = (await json(createdResponse)).program;
  const adjustedResponse = await fetch(`${base}/programs/${draft.id}/adjust`, {
    method: "POST", headers,
    body: JSON.stringify({ generation: draft.generation, planRevision: 0, operationId: "planner-search-adjust", message: "帮我找周杰伦的歌曲。" }),
  });
  assert.equal(adjustedResponse.status, 200, await adjustedResponse.clone().text());
  const adjustedPayload = await json(adjustedResponse);
  assert.match(adjustedPayload.message, /已找到“周杰伦”的 2 首可播放歌曲/);
  assert.equal(adjustedPayload.program.rundown.filter((track: { artist: string }) => track.artist === "周杰伦").length, 2);
  assert.ok(searchTerms.includes("周杰伦"));

  const genreResponse = await fetch(`${base}/programs/${draft.id}/adjust`, {
    method: "POST", headers,
    body: JSON.stringify({ generation: draft.generation, planRevision: 1, operationId: "planner-genre-adjust", message: "帮我找几首摇滚歌曲。" }),
  });
  assert.equal(genreResponse.status, 200, await genreResponse.clone().text());
  const genrePayload = await json(genreResponse);
  assert.match(genrePayload.message, /已找到“摇滚”的 3 首可播放歌曲/);
  assert.equal(genrePayload.program.rundown.filter((track: { artist: string }) => track.artist.startsWith("摇滚艺人")).length, 3);
  assert.ok(playlistSearchTerms.some((term) => /摇滚/.test(term)));
  assert.ok(!searchTerms.includes("摇滚"));

  const failedResponse = await fetch(`${base}/programs/${draft.id}/adjust`, {
    method: "POST", headers,
    body: JSON.stringify({ generation: draft.generation, planRevision: 2, operationId: "planner-search-empty", message: "找不存在的歌手的歌曲。" }),
  });
  assert.equal(failedResponse.status, 409);
  assert.match((await json(failedResponse)).error, /没有找到“不存在的歌手”的可用歌曲/);
});

test("NetEase confirmation replaces a song that becomes trial-only before broadcast", async (context) => {
  const songs = Array.from({ length: 20 }, (_, index) => ({
    id: String(18_000 + index),
    title: `免费候选 ${index + 1}`,
    artists: [{ id: String(19_000 + index), name: `免费艺术家 ${index + 1}` }],
    durationMs: 180_000,
  }));
  const trialOnlyIds = new Set<string>();
  const storedTracks: string[] = [];
  const baseProvider = planningProvider(songs, []);
  const token = "confirm-free-playback-token";
  const service = await createLocalService({
    port: 0,
    localControlToken: token,
    neteaseProvider: {
      ...baseProvider,
      songUrl(id: string) {
        return trialOnlyIds.has(id)
          ? { id, url: `https://music.126.net/${id}-trial.mp3`, isTrial: true, durationMs: 30_000 }
          : { id, url: `https://music.126.net/${id}.mp3`, isTrial: false, durationMs: 180_000 };
      },
      createPlaylist(name: string) { return { id: "9900", name }; },
      addSongsToPlaylist(playlistId: string, trackIds: string[]) { storedTracks.splice(0, storedTracks.length, ...trackIds); return { playlistId, trackIds }; },
      playlistDetail() { return { id: "9900", name: "AI 电台", tracks: storedTracks.map((id) => ({ id })) }; },
    },
    hostProvider: groundedHostProvider(),
    ttsProvider: readyTtsProvider,
  });
  await service.start();
  context.after(() => service.stop());
  const base = `http://127.0.0.1:${service.port}/api`;
  const headers = { "content-type": "application/json", "x-one-radio-control-token": token };
  const createdResponse = await fetch(`${base}/programs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ operationId: "confirm-free-create", spec: { sourceId: "netease_music", durationMinutes: 30, scenePreset: "study", sceneDescription: "", hostDensity: "low", energyCurve: "steady", avoid: [], familiarityRatio: 0 } }),
  });
  assert.equal(createdResponse.status, 201);
  const draft = (await json(createdResponse)).program;
  const revokedId = draft.rundown[0].id;
  const preservedScripts = new Map(draft.rundown.slice(1).map((track: { id: string; hostScript?: { text: string } }) => [track.id, track.hostScript?.text]));
  trialOnlyIds.add(revokedId);

  const confirmedResponse = await fetch(`${base}/programs/${draft.id}/confirm`, {
    method: "POST",
    headers,
    body: JSON.stringify({ generation: draft.generation, planRevision: 0, operationId: "confirm-free-confirm" }),
  });
  assert.equal(confirmedResponse.status, 200, JSON.stringify(await confirmedResponse.clone().json()));
  const confirmed = (await json(confirmedResponse)).program;
  assert.equal(confirmed.status, "on_air");
  assert.ok(confirmed.rundown.every((track: { id: string }) => track.id !== revokedId));
  assert.deepEqual(storedTracks, confirmed.rundown.map((track: { id: string }) => track.id));
  assert.ok(confirmed.rundown.slice(1).every((track: { id: string; hostScript?: { text: string } }) => track.hostScript?.text === preservedScripts.get(track.id)));
});

test("NetEase planning covers 120-minute programs that need more than one hundred short tracks", async (context) => {
  const songs = Array.from({ length: 120 }, (_, index) => ({
    id: String(6_000 + index),
    title: `长节目歌曲 ${index + 1}`,
    artists: [{ id: String(7_000 + index), name: `长节目艺术家 ${index + 1}` }],
    durationMs: 60_000,
  }));
  const token = "long-program-token";
  const service = await createLocalService({
    port: 0,
    localControlToken: token,
    neteaseProvider: planningProvider(songs, []),
    hostProvider: groundedHostProvider(),
    ttsProvider: readyTtsProvider,
  });
  await service.start();
  context.after(() => service.stop());

  const response = await fetch(`http://127.0.0.1:${service.port}/api/programs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-one-radio-control-token": token },
    body: JSON.stringify({ spec: { sourceId: "netease_music", durationMinutes: 120, scenePreset: "commute", sceneDescription: "", hostDensity: "low", energyCurve: "steady", avoid: [], familiarityRatio: 0 } }),
  });
  assert.equal(response.status, 201);
  const program = (await json(response)).program;
  assert.ok(program.planSummary.totalTracks > 100);
  assert.equal(program.planSummary.familiarTracks, 0);
  assert.equal(program.planSummary.actualFamiliarityRatio, 0);
  assert.equal(new Set(program.rundown.map((track: { artist: string }) => track.artist)).size, program.planSummary.totalTracks);
  assert.ok(program.rundown.reduce((total: number, track: { durationSeconds: number }) => total + track.durationSeconds, 0) >= 115 * 60);
  for (const track of program.rundown.filter((item: { hostScript?: { factIds?: string[] } }) => item.hostScript?.factIds?.length === 0)) {
    assert.doesNotMatch(track.hostScript.text, new RegExp(track.title));
    assert.doesNotMatch(track.hostScript.text, new RegExp(track.artist));
  }
  const mysteryScripts = program.rundown.flatMap((track: { hostScript?: { factIds?: string[]; text?: string } }) => track.hostScript?.factIds?.length === 0 ? [track.hostScript.text] : []);
  assert.equal(new Set(mysteryScripts).size, mysteryScripts.length);
});

test("NetEase planning does not skip a feasible pair of long songs", async (context) => {
  const longSongs = [
    { id: "8001", title: "喜欢长歌", artists: [{ id: "8101", name: "长歌艺术家一" }], durationMs: 900_000 },
    { id: "8002", title: "探索长歌", artists: [{ id: "8102", name: "长歌艺术家二" }], durationMs: 900_000 },
  ];
  const shortSongs = Array.from({ length: 18 }, (_, index) => ({
    id: String(8_100 + index),
    title: `短歌 ${index + 1}`,
    artists: [{ id: String(8_200 + index), name: `短歌艺术家 ${index + 1}` }],
    durationMs: 60_000,
  }));
  const token = "long-pair-token";
  const service = await createLocalService({
    port: 0,
    localControlToken: token,
    neteaseProvider: planningProvider([...longSongs, ...shortSongs], [longSongs[0]!.id]),
    hostProvider: groundedHostProvider(),
    ttsProvider: readyTtsProvider,
  });
  await service.start();
  context.after(() => service.stop());
  const response = await fetch(`http://127.0.0.1:${service.port}/api/programs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-one-radio-control-token": token },
    body: JSON.stringify({ spec: { sourceId: "netease_music", durationMinutes: 30, scenePreset: "late_night", sceneDescription: "", hostDensity: "low", energyCurve: "low", avoid: [], familiarityRatio: 50 } }),
  });
  assert.equal(response.status, 201);
  const program = (await json(response)).program;
  assert.equal(program.planSummary.totalTracks, 2);
  assert.deepEqual(program.rundown.map((track: { id: string }) => track.id).sort(), ["8001", "8002"]);
});

test("NetEase planning filters DJ and low-quality Chinese remix songs from the final rundown", async (context) => {
  const blockedSongs = [
    { id: "bad-dj", title: "一路生花 DJ版", artists: [{ id: "bad-1", name: "土嗨制作人" }], durationMs: 360_000 },
    { id: "bad-douyin", title: "中文抖音热播 Remix", artists: [{ id: "bad-2", name: "网络歌手" }], durationMs: 360_000 },
    { id: "bad-car", title: "车载DJ串烧", artists: [{ id: "bad-3", name: "舞曲串烧" }], durationMs: 360_000 },
    { id: "bad-car-only", title: "低音重鼓车载系列", artists: [{ id: "bad-4", name: "网络歌手" }], durationMs: 360_000 },
    { id: "bad-dj-inline", title: "低音重鼓Dj精选", artists: [{ id: "bad-5", name: "网络歌手" }], durationMs: 360_000 },
  ];
  const allowedSongs = Array.from({ length: 5 }, (_, index) => ({
    id: `clean-${index + 1}`,
    title: `清洁电子 ${index + 1}`,
    artists: [{ id: `clean-artist-${index + 1}`, name: `清洁制作人 ${index + 1}` }],
    durationMs: 360_000,
    styleTags: ["electronic"],
  }));
  const token = "low-quality-remix-filter-token";
  const service = await createLocalService({
    port: 0,
    localControlToken: token,
    neteaseProvider: planningProvider([...blockedSongs, ...allowedSongs], blockedSongs.map((song) => song.id)),
    hostProvider: groundedHostProvider(),
    ttsProvider: readyTtsProvider,
  });
  await service.start();
  context.after(() => service.stop());
  const response = await fetch(`http://127.0.0.1:${service.port}/api/programs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-one-radio-control-token": token },
    body: JSON.stringify({ spec: { sourceId: "netease_music", durationMinutes: 30, scenePreset: "party", sceneDescription: "", hostDensity: "low", energyCurve: "high", avoid: [], familiarityRatio: 80, recommendationMode: "genre", musicGenres: ["electronic", "hiphop"] } }),
  });
  assert.equal(response.status, 201);
  const program = (await json(response)).program;
  assert.deepEqual(program.rundown.map((track: { id: string }) => track.id).sort(), allowedSongs.map((song) => song.id).sort());
  assert.equal(program.rundown.some((track: { title: string }) => /DJ|抖音|Remix|车载/.test(track.title)), false);
});

test("NetEase planning excludes alternate versions from exploration but keeps a liked live recording", async (context) => {
  const likedLive = { id: "liked-live", title: "用户收藏 (Live)", artists: [{ id: "liked-live-artist", name: "熟悉歌手" }], durationMs: 360_000, styleTags: ["electronic"] };
  const versionedDiscovery = [
    { id: "version-remix", title: "Pulse Remix", artists: [{ id: "version-artist-1", name: "Artist One" }], durationMs: 360_000 },
    { id: "version-live", title: "Pulse (Live)", artists: [{ id: "version-artist-2", name: "Artist Two" }], durationMs: 360_000 },
    { id: "version-concert", title: "Pulse 演唱会版", artists: [{ id: "version-artist-3", name: "Artist Three" }], durationMs: 360_000 },
    { id: "version-labelled", title: "Pulse 2026 Version", artists: [{ id: "version-artist-4", name: "Artist Four" }], durationMs: 360_000 },
    { id: "version-remaster", title: "Pulse Remastered", artists: [{ id: "version-artist-5", name: "Artist Five" }], durationMs: 360_000 },
  ];
  const originals = Array.from({ length: 6 }, (_, index) => ({
    id: `original-${index + 1}`,
    title: `Original Track ${index + 1}`,
    artists: [{ id: `original-artist-${index + 1}`, name: `Original Artist ${index + 1}` }],
    durationMs: 360_000,
  }));
  const token = "exploration-version-filter-token";
  const service = await createLocalService({
    port: 0,
    localControlToken: token,
    neteaseProvider: planningProvider([likedLive, ...versionedDiscovery, ...originals], [likedLive.id]),
    hostProvider: groundedHostProvider(),
    ttsProvider: readyTtsProvider,
  });
  await service.start();
  context.after(() => service.stop());
  const response = await fetch(`http://127.0.0.1:${service.port}/api/programs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-one-radio-control-token": token },
    body: JSON.stringify({ spec: { sourceId: "netease_music", durationMinutes: 30, scenePreset: "party", sceneDescription: "", hostDensity: "low", energyCurve: "high", avoid: [], familiarityRatio: 20, recommendationMode: "atmosphere", musicGenres: [] } }),
  });
  assert.equal(response.status, 201);
  const program = (await json(response)).program;
  assert.ok(program.rundown.some((track: { id: string }) => track.id === likedLive.id));
  assert.equal(program.rundown.some((track: { id: string }) => track.id.startsWith("version-")), false);
  assert.ok(program.rundown.every((track: { id: string }) => track.id === likedLive.id || track.id.startsWith("original-")));
});

test("NetEase planning finalizes fact-safe host scripts when draft quality fails", async (context) => {
  const songs = Array.from({ length: 5 }, (_, index) => ({
    id: String(9_000 + index),
    title: `事实歌曲 ${index + 1}`,
    artists: [{ id: String(9_100 + index), name: `事实艺术家 ${index + 1}` }],
    durationMs: 360_000,
  }));
  let ttsCalls = 0;
  const token = "ungrounded-host-token";
  const service = await createLocalService({
    port: 0,
    localControlToken: token,
    neteaseProvider: planningProvider(songs, []),
    hostProvider: { configured: true, state: "ready", generate() { return { success: true, status: "ready", text: "这是一段没有曲目引用的主持词。", factIds: [] }; } },
    ttsProvider: { configured: true, state: "ready", synthesize() { ttsCalls += 1; return { success: true, status: "ready", audio: Buffer.from("RIFF0000WAVE") }; } },
  });
  await service.start();
  context.after(() => service.stop());
  const base = `http://127.0.0.1:${service.port}/api`;
  const response = await fetch(`${base}/programs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-one-radio-control-token": token },
    body: JSON.stringify({ spec: { sourceId: "netease_music", durationMinutes: 30, scenePreset: "study", sceneDescription: "", hostDensity: "low", energyCurve: "steady", avoid: [], familiarityRatio: 0 } }),
  });
  assert.equal(response.status, 201);
  const payload = await json(response);
  assert.equal(payload.hostRetryRequired, undefined);
  assert.equal(payload.program.status, "awaiting_confirmation");
  assert.ok(payload.program.rundown.length > 0);
  assert.ok(payload.program.rundown.some((track: { hostMoment?: string; hostScript?: { text?: string } }) => track.hostMoment === "opening" && /欢迎收听/.test(track.hostScript?.text ?? "")));
  assert.ok(payload.program.rundown.some((track: { hostScript?: { text?: string } }) => /最后一首/.test(track.hostScript?.text ?? "")));
  assert.equal(ttsCalls, 0);
  assert.equal((await json(await fetch(`${base}/program`, { headers: { "x-one-radio-control-token": token } }))).program.id, payload.program.id);
});

test("NetEase planning keeps song order when host copy is internally finalized", async (context) => {
  const songs = Array.from({ length: 5 }, (_, index) => ({
    id: String(9_120 + index),
    title: `重写歌曲 ${index + 1}`,
    artists: [{ id: String(9_170 + index), name: `重写艺术家 ${index + 1}` }],
    durationMs: 360_000,
  }));
  let retryAllowed = false;
  let hostCalls = 0;
  const token = "host-review-retry-token";
  const service = await createLocalService({
    port: 0,
    localControlToken: token,
    neteaseProvider: planningProvider(songs, []),
    hostProvider: {
      configured: true,
      state: "ready",
      generate(hostContext: { allowedFacts?: Array<{ id: string; value: string }>; transitionReason?: string }) {
        hostCalls += 1;
        if (!retryAllowed) return { success: true, status: "ready", text: "这是一段没有曲目引用的主持词。", factIds: [] };
        const fact = hostContext.allowedFacts?.[0];
        const closingLead = hostContext.transitionReason?.includes("最后一首") ? "这是本档最后一首。" : "";
        return { success: true, status: "ready", text: `${closingLead}${fact?.value ?? ""}我们用这条线索进入下一首，声音关系会更清楚。`, factIds: fact ? [fact.id] : [] };
      },
    },
    ttsProvider: readyTtsProvider,
  });
  await service.start();
  context.after(() => service.stop());
  const base = `http://127.0.0.1:${service.port}/api`;
  const headers = { "content-type": "application/json", "x-one-radio-control-token": token };
  const createdResponse = await fetch(`${base}/programs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ spec: { sourceId: "netease_music", durationMinutes: 30, scenePreset: "study", sceneDescription: "", hostDensity: "low", energyCurve: "steady", avoid: [], familiarityRatio: 0 } }),
  });
  assert.equal(createdResponse.status, 201);
  const created = (await json(createdResponse)).program;
  const originalIds = created.rundown.map((track: { id: string }) => track.id);
  assert.deepEqual(created.rundown.map((track: { id: string }) => track.id), originalIds);
  assert.ok(created.rundown.every((track: { hostMoment?: string; hostScript?: { text?: string } }) => !track.hostMoment || Boolean(track.hostScript?.text)));
  assert.ok(hostCalls > 1);
});

test("NetEase host quality failure converges to a playable final script instead of looping", async (context) => {
  const songs = Array.from({ length: 5 }, (_, index) => ({
    id: String(9_180 + index),
    title: `最终歌曲 ${index + 1}`,
    artists: [{ id: String(9_230 + index), name: `最终艺术家 ${index + 1}` }],
    durationMs: 360_000,
  }));
  const token = "host-review-final-token";
  let ttsCalls = 0;
  const stored = new Map<string, string[]>();
  const baseProvider = planningProvider(songs, []);
  const service = await createLocalService({
    port: 0,
    localControlToken: token,
    neteaseProvider: {
      ...baseProvider,
      createPlaylist(name: string) {
        stored.set("final-host-playlist", []);
        return { id: "final-host-playlist", name };
      },
      addSongsToPlaylist(playlistId: string, trackIds: string[]) {
        stored.set(playlistId, trackIds);
        return { playlistId, trackIds };
      },
      playlistDetail(playlistId: string) {
        return { tracks: (stored.get(playlistId) ?? []).map((id) => ({ id })) };
      },
    },
    hostProvider: {
      configured: true,
      state: "ready",
      generate() {
        return { success: true, status: "ready", text: "这是一段没有曲目引用的主持词。", factIds: [] };
      },
    },
    ttsProvider: { configured: true, state: "ready", synthesize() { ttsCalls += 1; return { success: true, status: "ready", audio: Buffer.from("RIFF0000WAVE") }; } },
  });
  await service.start();
  context.after(() => service.stop());
  const base = `http://127.0.0.1:${service.port}/api`;
  const headers = { "content-type": "application/json", "x-one-radio-control-token": token };
  const createdResponse = await fetch(`${base}/programs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ spec: { sourceId: "netease_music", durationMinutes: 30, scenePreset: "study", sceneDescription: "", hostDensity: "low", energyCurve: "steady", avoid: [], familiarityRatio: 0 } }),
  });
  assert.equal(createdResponse.status, 201);
  const created = (await json(createdResponse)).program;
  const originalIds = created.rundown.map((track: { id: string }) => track.id);

  assert.deepEqual(created.rundown.map((track: { id: string }) => track.id), originalIds);
  assert.ok(created.rundown.some((track: { hostMoment?: string; hostScript?: { text?: string } }) => track.hostMoment === "opening" && /欢迎收听/.test(track.hostScript?.text ?? "")));
  assert.ok(created.rundown.some((track: { hostScript?: { text?: string } }) => /最后一首/.test(track.hostScript?.text ?? "")));

  const confirm = await fetch(`${base}/programs/${created.id}/confirm`, {
    method: "POST",
    headers,
    body: JSON.stringify({ generation: created.generation, planRevision: created.planRevision, operationId: "confirm-final-host" }),
  });
  assert.equal(confirm.status, 200);
  assert.ok(ttsCalls > 0);
});

test("host provider timeouts return a specific safe reason to the UI", async (context) => {
  const songs = Array.from({ length: 5 }, (_, index) => ({
    id: String(9_200 + index),
    title: `超时歌曲 ${index + 1}`,
    artists: [{ id: String(9_250 + index), name: `超时艺术家 ${index + 1}` }],
    durationMs: 360_000,
  }));
  const token = "host-timeout-reason-token";
  const service = await createLocalService({
    port: 0,
    localControlToken: token,
    neteaseProvider: planningProvider(songs, []),
    hostProvider: {
      configured: true,
      state: "ready",
      generate() {
        throw new ProviderError({ code: "timeout", message: "provider request timed out", provider: "test-host", retryable: true });
      },
    },
    ttsProvider: readyTtsProvider,
  });
  await service.start();
  context.after(() => service.stop());
  const response = await fetch(`http://127.0.0.1:${service.port}/api/programs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-one-radio-control-token": token },
    body: JSON.stringify({ spec: { sourceId: "netease_music", durationMinutes: 30, scenePreset: "study", sceneDescription: "", hostDensity: "low", energyCurve: "steady", avoid: [], familiarityRatio: 0 } }),
  });
  assert.equal(response.status, 202);
  const payload = await json(response);
  assert.equal(payload.hostRetryRequired, true);
  assert.match(payload.message, /主持词生成超时/);
});

test("NetEase planning retries a transient invalid host response and locks the recovered script", async (context) => {
  const songs = Array.from({ length: 5 }, (_, index) => ({
    id: String(9_300 + index),
    title: `恢复歌曲 ${index + 1}`,
    artists: [{ id: String(9_400 + index), name: `恢复艺术家 ${index + 1}` }],
    durationMs: 360_000,
  }));
  let calls = 0;
  const token = "host-retry-token";
  const service = await createLocalService({
    port: 0,
    localControlToken: token,
    neteaseProvider: planningProvider(songs, []),
    hostProvider: {
      configured: true,
      state: "ready",
      generate(hostContext: { allowedFacts?: Array<{ id: string; value: string }> }) {
        calls += 1;
        const fact = hostContext.allowedFacts?.[0];
        if (calls === 1) return { success: true, status: "ready", text: "缺少事实引用。", factIds: [] };
        return { success: true, status: "ready", text: `${fact?.value ?? ""}先把这一段旋律完整留在耳边，我们沿着现在的节奏继续听下去。`, factIds: fact ? [fact.id] : [] };
      },
    },
    ttsProvider: readyTtsProvider,
  });
  await service.start();
  context.after(() => service.stop());
  const response = await fetch(`http://127.0.0.1:${service.port}/api/programs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-one-radio-control-token": token },
    body: JSON.stringify({ spec: { sourceId: "netease_music", durationMinutes: 30, scenePreset: "study", sceneDescription: "", hostDensity: "low", energyCurve: "steady", avoid: [], familiarityRatio: 0 } }),
  });
  assert.equal(response.status, 201);
  const program = (await json(response)).program;
  assert.ok(calls > program.rundown.filter((track: { hostMoment?: string }) => track.hostMoment).length);
  assert.match(program.rundown[0].hostScript.text, /恢复歌曲/);
});

test("NetEase planning rejects on-air research disclaimers even when metadata is grounded", async (context) => {
  const songs = Array.from({ length: 5 }, (_, index) => ({
    id: String(9_450 + index),
    title: `资料歌曲 ${index + 1}`,
    artists: [{ id: String(9_550 + index), name: `资料艺术家 ${index + 1}` }],
    durationMs: 360_000,
  }));
  const token = "research-disclaimer-token";
  const service = await createLocalService({
    port: 0,
    localControlToken: token,
    neteaseProvider: planningProvider(songs, []),
    hostProvider: {
      configured: true,
      state: "ready",
      generate(hostContext: { allowedFacts?: Array<{ id: string; value: string }> }) {
        const fact = hostContext.allowedFacts?.[0];
        return { success: true, status: "ready", text: `${fact?.value ?? ""}现有资料没有更多信息，我们就不替它贴标签。`, factIds: fact ? [fact.id] : [] };
      },
    },
    ttsProvider: readyTtsProvider,
  });
  await service.start();
  context.after(() => service.stop());
  const response = await fetch(`http://127.0.0.1:${service.port}/api/programs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-one-radio-control-token": token },
    body: JSON.stringify({ spec: { sourceId: "netease_music", durationMinutes: 30, scenePreset: "study", sceneDescription: "", hostDensity: "low", energyCurve: "steady", avoid: [], familiarityRatio: 0 } }),
  });
  assert.equal(response.status, 201);
  const payload = await json(response);
  assert.equal(payload.hostRetryRequired, undefined);
  const hostTexts = payload.program.rundown.map((track: { hostScript?: { text?: string } }) => track.hostScript?.text ?? "").join("\n");
  assert.doesNotMatch(hostTexts, /资料没有更多信息|不替它贴标签/);
});

test("NetEase planning rejects a grounded citation with additional invented music facts", async (context) => {
  const songs = Array.from({ length: 5 }, (_, index) => ({
    id: String(9_500 + index),
    title: `可信歌曲 ${index + 1}`,
    artists: [{ id: String(9_600 + index), name: `可信艺术家 ${index + 1}` }],
    durationMs: 360_000,
  }));
  const token = "invented-host-fact-token";
  const service = await createLocalService({
    port: 0,
    localControlToken: token,
    neteaseProvider: planningProvider(songs, []),
    hostProvider: {
      configured: true,
      state: "ready",
      generate(hostContext: { allowedFacts?: Array<{ id: string; value: string }> }) {
        const fact = hostContext.allowedFacts?.[0];
        return { success: true, status: "ready", text: `${fact?.value ?? ""}歌里藏着一段无疾而终的爱情，听它怎样把遗憾放下。`, factIds: fact ? [fact.id] : [] };
      },
    },
    ttsProvider: readyTtsProvider,
  });
  await service.start();
  context.after(() => service.stop());
  const base = `http://127.0.0.1:${service.port}/api`;
  const response = await fetch(`${base}/programs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-one-radio-control-token": token },
    body: JSON.stringify({ spec: { sourceId: "netease_music", durationMinutes: 30, scenePreset: "study", sceneDescription: "", hostDensity: "low", energyCurve: "steady", avoid: [], familiarityRatio: 0 } }),
  });
  assert.equal(response.status, 201);
  const payload = await json(response);
  assert.equal(payload.hostRetryRequired, undefined);
  const hostTexts = payload.program.rundown.map((track: { hostScript?: { text?: string } }) => track.hostScript?.text ?? "").join("\n");
  assert.doesNotMatch(hostTexts, /无疾而终的爱情|遗憾放下/);
  assert.equal((await json(await fetch(`${base}/program`, { headers: { "x-one-radio-control-token": token } }))).program.id, payload.program.id);
});

test("program creation reports real completed stages before returning the preview", async (context) => {
  const songs = Array.from({ length: 6 }, (_, index) => ({
    id: String(9_700 + index),
    title: `进度歌曲 ${index + 1}`,
    artists: [{ id: String(9_800 + index), name: `进度艺术家 ${index + 1}` }],
    durationMs: 300_000,
  }));
  let releasePlayback!: () => void;
  let releaseHost!: () => void;
  const playbackGate = new Promise<void>((resolve) => { releasePlayback = resolve; });
  const hostGate = new Promise<void>((resolve) => { releaseHost = resolve; });
  const baseProvider = planningProvider(songs, []);
  const baseHost = groundedHostProvider();
  const token = "create-progress-token";
  const service = await createLocalService({
    port: 0,
    localControlToken: token,
    neteaseProvider: {
      ...baseProvider,
      async songUrl(id: string) {
        await playbackGate;
        return { id, url: `https://music.126.net/${id}.mp3` };
      },
    },
    hostProvider: {
      ...baseHost,
      async generate(hostContext: Parameters<typeof baseHost.generate>[0]) {
        await hostGate;
        return baseHost.generate(hostContext);
      },
    },
    ttsProvider: readyTtsProvider,
  });
  await service.start();
  context.after(() => service.stop());
  const base = `http://127.0.0.1:${service.port}/api`;
  const headers = { "content-type": "application/json", "x-one-radio-control-token": token };
  const operationId = "live-progress-create";
  const creation = fetch(`${base}/programs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ operationId, spec: { sourceId: "netease_music", durationMinutes: 30, scenePreset: "study", sceneDescription: "", hostDensity: "high", energyCurve: "steady", avoid: [], familiarityRatio: 0 } }),
  });
  const readProgress = async (minimum: number) => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const response = await fetch(`${base}/programs/progress?operationId=${operationId}`, { headers });
      if (response.ok) {
        const progress = (await json(response)).progress;
        if (progress.completedSteps >= minimum) return progress;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`progress did not reach step ${minimum}`);
  };

  assert.equal((await readProgress(1)).status, "running");
  releasePlayback();
  assert.equal((await readProgress(3)).completedSteps, 3);
  releaseHost();
  assert.equal((await creation).status, 201);
  assert.deepEqual(await readProgress(4), { completedSteps: 4, status: "completed", updatedAt: (await readProgress(4)).updatedAt });
});

test("producer failure still locks fact-safe host copy for the whole plan", async (context) => {
  const songs = Array.from({ length: 8 }, (_, index) => ({
    id: String(9_900 + index),
    title: `备用歌曲 ${index + 1}`,
    artists: [{ id: String(10_000 + index), name: "同一位艺术家" }],
    durationMs: 225_000,
  }));
  const token = "metadata-fallback-token";
  const service = await createLocalService({
    port: 0,
    localControlToken: token,
    neteaseProvider: planningProvider(songs, []),
    hostProvider: {
      configured: true,
      state: "ready",
      generate() { return { provider: "openai-compatible", configured: true, success: false, status: "failed", text: "", factIds: [] }; },
    },
    ttsProvider: readyTtsProvider,
  });
  await service.start();
  context.after(() => service.stop());
  const response = await fetch(`http://127.0.0.1:${service.port}/api/programs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-one-radio-control-token": token },
    body: JSON.stringify({ operationId: "fallback-create", spec: { sourceId: "netease_music", durationMinutes: 30, scenePreset: "study", sceneDescription: "", hostDensity: "high", energyCurve: "steady", avoid: [], familiarityRatio: 0 } }),
  });
  assert.equal(response.status, 201);
  const payload = (await json(response)).program;
  const hostScripts = payload.rundown.filter((item: { hostScript?: { text?: string } }) => Boolean(item.hostScript)).map((item: { hostScript: { text: string } }) => item.hostScript.text);
  assert.ok(hostScripts.length > 0);
  assert.ok(hostScripts.every((text: string) => text.length > 0));
  assert.ok((await json(await fetch(`http://127.0.0.1:${service.port}/api/program`, { headers: { "x-one-radio-control-token": token } }))).program);
});

test("NetEase confirmation fails closed when locked planning artifacts are missing", async (context) => {
  const engine = new ProgramEngine({ idFactory: () => "restored-program-without-rundown" });
  const draft = engine.create({ sourceId: "netease_music", durationMinutes: 30, scenePreset: "study", sceneDescription: "", hostDensity: "low", energyCurve: "steady", avoid: [], familiarityRatio: 0 });
  let accountCalls = 0;
  let hostCalls = 0;
  const token = "missing-artifact-token";
  const provider = planningProvider([], []);
  const service = await createLocalService({
    port: 0,
    engine,
    localControlToken: token,
    neteaseProvider: { ...provider, account() { accountCalls += 1; return { uid: "7" }; } },
    hostProvider: { configured: true, state: "ready", generate() { hostCalls += 1; return { success: true, status: "ready", text: "不应重新生成", factIds: [] }; } },
    ttsProvider: readyTtsProvider,
  });
  await service.start();
  context.after(() => service.stop());
  const response = await fetch(`http://127.0.0.1:${service.port}/api/programs/${draft.id}/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-one-radio-control-token": token },
    body: JSON.stringify({ generation: draft.generation, operationId: "missing-artifact-confirm" }),
  });
  assert.equal(response.status, 409);
  assert.equal((await json(response)).code, "PROGRAM_ARTIFACT_MISSING");
  assert.equal(accountCalls, 0);
  assert.equal(hostCalls, 0);
  assert.equal(engine.getState()?.status, "awaiting_confirmation");
});

test("NetEase validation routes expose provider results without leaking credentials", async (context) => {
  const controlToken = "netease-route-test-token";
  const authorizedFetch = (url: string, init: RequestInit = {}) => fetch(url, {
    ...init,
    headers: { ...Object.fromEntries(new Headers(init.headers)), "x-one-radio-control-token": controlToken },
  });
  const calls: string[] = [];
  const neteaseProvider = {
    configured: true,
    state: "ready",
    getStatus() {
      return { configured: true, state: "ready", authenticated: true, cookie: "MUSIC_U=private" };
    },
    health() {
      calls.push("health");
      return { configured: true, state: "ready" };
    },
    search(keyword: string, options?: { limit?: number; offset?: number }) {
      calls.push(`search:${keyword}:${options?.limit}:${options?.offset}`);
      return { songs: [{ id: "101", name: "测试歌曲", title: "测试歌曲", artists: [{ id: "5", name: "测试歌手" }], cookie: "private" }], total: 1 };
    },
    playlistDetail(id: string) {
      calls.push(`playlist:${id}`);
      return { id, name: "测试歌单", nested: { authorization: "Bearer private", visible: true } };
    },
    songDetail(ids: string[]) {
      calls.push(`song-detail:${ids.join(",")}`);
      return [{ id: ids[0], name: "测试歌曲", artists: ["测试歌手"] }];
    },
    songUrl(id: string) {
      calls.push(`song-url:${id}`);
      return { id, url: "https://music.example/song.mp3", token: "private" };
    },
    account() {
      calls.push("account");
      return { uid: "7", nickname: "本机用户" };
    },
    userPlaylists(uid: string) {
      calls.push(`user-playlists:${uid}`);
      return { playlists: [{ id: "9", name: "喜欢的节奏" }], more: false };
    },
    likedSongIds(uid: string) {
      calls.push(`liked:${uid}`);
      return ["101", "102"];
    },
    recentSongs() {
      calls.push("recent");
      return [{ song: { id: "101", artists: [{ id: "5", name: "测试歌手" }] } }];
    },
    listeningHistory(uid: string) {
      calls.push(`history:${uid}`);
      return [{ song: { id: "101", artists: [{ id: "5", name: "测试歌手" }] } }];
    },
    dailyRecommendations() {
      calls.push("daily");
      return [{ id: "103", title: "每日推荐候选", artists: [{ id: "6", name: "新歌手" }] }];
    },
    personalFm() {
      calls.push("fm");
      return [{ id: "104", title: "私人 FM 候选", artists: [{ id: "5", name: "测试歌手" }] }];
    },
    createQrLogin() {
      calls.push("qr-create");
      return { key: "qr_key-123", qrImageDataUrl: "data:image/png;base64,AAAA", cookie: "private" };
    },
    checkQrLogin(key: string) {
      calls.push(`qr-check:${key}`);
      return { key, state: "authenticated", cookie: "MUSIC_U=private", account: { id: 7 } };
    },
  };
  const service = await createLocalService({ port: 0, neteaseProvider, localControlToken: controlToken });
  await service.start();
  context.after(() => service.stop());
  const base = `http://127.0.0.1:${service.port}/api/netease`;

  assert.equal((await fetch(`${base}/status`)).status, 401);
  const status = await json(await authorizedFetch(`${base}/status`));
  assert.deepEqual(status.status, { provider: "netease", configured: true, state: "ready", authenticated: true });

  const preferences = await json(await authorizedFetch(`${base}/preferences`));
  assert.equal(preferences.preferences.state, "ready");
  assert.deepEqual(preferences.preferences.counts, {
    likedTracks: 2,
    playlists: 1,
    playlistTracks: 0,
    recentTracks: 1,
    historyTracks: 1,
    dailyCandidates: 1,
    fmCandidates: 1,
    sceneSearchCandidates: 0,
    profileSearchQueries: 0,
    profileSearchCandidates: 0,
    publicPlaylistQueries: 8,
    publicPlaylists: 0,
    publicPlaylistTracks: 0,
    similarCandidates: 0,
    expandedSearchCandidates: 0,
  });
  assert.equal(preferences.preferences.favoriteArtists[0].name, "测试歌手");
  assert.equal(preferences.preferences.nextCandidate.title, "私人 FM 候选");
  assert.equal(preferences.preferences.nextCandidate.controlState, "awaiting_client_confirmation");

  const qrCreated = await json(await authorizedFetch(`${base}/login/qr`, { method: "POST" }));
  assert.equal(qrCreated.login.key, "qr_key-123");
  assert.equal(qrCreated.login.dataUrl, "data:image/png;base64,AAAA");
  assert.equal("cookie" in qrCreated.login, false);
  const qrChecked = await json(await authorizedFetch(`${base}/login/qr/qr_key-123`));
  assert.equal(qrChecked.login.state, "authenticated");
  assert.deepEqual(qrChecked.login.account, { id: 7 });
  assert.equal("cookie" in qrChecked.login, false);

  const search = await json(await authorizedFetch(`${base}/search?keyword=${encodeURIComponent("周杰伦")}`));
  assert.equal(search.result.songs[0].name, "测试歌曲");
  assert.equal("cookie" in search.result.songs[0], false);

  const playlist = await json(await authorizedFetch(`${base}/playlist/123456`));
  assert.equal(playlist.playlist.name, "测试歌单");
  assert.deepEqual(playlist.playlist.nested, { visible: true });

  const song = await json(await authorizedFetch(`${base}/song/101`));
  assert.equal(song.result.songs[0].id, "101");
  assert.deepEqual(song.result.playback, { available: true });
  assert.deepEqual(calls.slice(0, 12), ["health", "health", "account", "user-playlists:7", "liked:7", "recent", "history:7", "daily", "fm", "song-detail:101,102", "playlist:9", "account"]);
  assert.ok(calls.includes("qr-create"));
  assert.ok(calls.includes("qr-check:qr_key-123"));
  assert.ok(calls.includes("search:周杰伦:20:0"));
  assert.ok(calls.includes("playlist:123456"));
  assert.ok(calls.includes("song-detail:101"));
  assert.ok(calls.includes("song-url:101"));

  assert.equal((await authorizedFetch(`${base}/preferences?scene=not-a-scene`)).status, 400);
  assert.equal((await authorizedFetch(`${base}/search?keyword=`)).status, 400);
  assert.equal((await authorizedFetch(`${base}/playlist/not-a-number`)).status, 400);
  assert.equal((await authorizedFetch(`${base}/song/1%2F2`)).status, 400);
  assert.equal((await authorizedFetch(`${base}/login/qr/invalid%2Fkey`)).status, 400);
});

test("NetEase programs create a temporary playlist per run, unless the listener keeps it", async (context) => {
  const playlistCreates: string[] = [];
  const playlistAdds: Array<{ playlistId: string; trackIds: string[] }> = [];
  const playlistDeletes: string[] = [];
  const likedMutations: Array<{ id: string; liked: boolean }> = [];
  const storedPlaylistTracks = new Map<string, string[]>();
  let desktopCalls = 0;
  let accountCalls = 0;
  let hostCalls = 0;
  let ttsCalls = 0;
  let playlistNamingCalls = 0;
  let blockAccountRead = false;
  let accountReadStarted: (() => void) | null = null;
  const songs = Array.from({ length: 10 }, (_, index) => ({
    id: String(200 + index),
    title: `画像候选 ${index + 1}`,
    artists: [{ id: String(500 + index), name: `艺术家 ${index + 1}` }],
    album: { id: String(800 + index), name: `专辑 ${index + 1}` },
    durationMs: 360_000 + index * 1_000,
    popularity: 70 - index,
  }));
  const neteaseProvider = {
    configured: true,
    state: "ready",
    getStatus() { return { configured: true, state: "ready", authenticated: true }; },
    health() { return { configured: true, state: "ready", authenticated: true }; },
    account(signal?: AbortSignal) {
      accountCalls += 1;
      if (!blockAccountRead) return { uid: "7", nickname: "本机用户" };
      accountReadStarted?.();
      return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    },
    userPlaylists() { return { playlists: [{ id: "9", name: "夜间收藏" }], more: false }; },
    likedSongIds() { return songs.slice(0, 4).map((song) => song.id); },
    songDetail(ids: string[]) { return songs.filter((song) => ids.includes(song.id)); },
    recentSongs() { return songs.slice(0, 2).map((song) => ({ song })); },
    listeningHistory() { return songs.slice(1, 4).map((song) => ({ song })); },
    dailyRecommendations() { return songs.slice(2, 7); },
    personalFm() { return songs.slice(1, 6); },
    search() { return { songs, total: songs.length }; },
    searchPlaylists() {
      return { total: 1, playlists: [{ id: "7001", name: "深夜放松精选", description: null, trackCount: songs.length }] };
    },
    songUrl(id: string) { return { id, url: `https://music.126.net/${id}.mp3`, bitrate: 320000, size: 1, format: "mp3", durationMs: 360_000 }; },
    createPlaylist(name: string) {
      playlistCreates.push(name);
      const id = String(9000 + playlistCreates.length);
      storedPlaylistTracks.set(id, []);
      return { id, name };
    },
    addSongsToPlaylist(playlistId: string, trackIds: string[]) {
      playlistAdds.push({ playlistId, trackIds: [...trackIds] });
      storedPlaylistTracks.set(playlistId, [...trackIds]);
      return { playlistId, trackIds };
    },
    deletePlaylist(playlistId: string) {
      playlistDeletes.push(playlistId);
      storedPlaylistTracks.delete(playlistId);
      return { playlistId, deleted: true };
    },
    setSongLiked(id: string, liked: boolean) {
      likedMutations.push({ id, liked });
      return { trackId: id, liked };
    },
    playlistDetail(playlistId: string) {
      if (playlistId === "7001") return { id: playlistId, name: "深夜放松精选", tracks: songs };
      return { id: playlistId, name: "AI 电台", tracks: (storedPlaylistTracks.get(playlistId) ?? []).map((id) => ({ id })) };
    },
  };
  const desktopPlayerController: DesktopPlayerControllerLike = {
    async inspect(sourceId) { desktopCalls += 1; return { sourceId, state: "app_not_running", ok: false, controlledElements: 0, operationId: null, targetVolume: null, detail: "not running", appRunning: false, playing: false }; },
    async duck(sourceId, operationId) { desktopCalls += 1; return { sourceId, state: "app_not_running", ok: false, controlledElements: 0, operationId, targetVolume: null, detail: "not running", appRunning: false, playing: false }; },
    async restore(sourceId, operationId) { desktopCalls += 1; return { sourceId, state: "app_not_running", ok: false, controlledElements: 0, operationId, targetVolume: null, detail: "not running", appRunning: false, playing: false }; },
    async pause(sourceId, operationId) { desktopCalls += 1; return { sourceId, state: "app_not_running", ok: false, controlledElements: 0, operationId, targetVolume: null, detail: "not running", appRunning: false, playing: false }; },
    async toggle(sourceId, operationId) { desktopCalls += 1; return { sourceId, state: "app_not_running", ok: false, controlledElements: 0, operationId, targetVolume: null, detail: "not running", appRunning: false, playing: false }; },
    async next(sourceId, operationId) { desktopCalls += 1; return { sourceId, state: "app_not_running", ok: false, controlledElements: 0, operationId, targetVolume: null, detail: "not running", appRunning: false, playing: false }; },
  };
  const hostProvider = {
    generate(context: { hostMoment?: string; transitionReason?: string; allowedFacts?: Array<{ id: string; value: string }> }) {
      hostCalls += 1;
      const fact = context.allowedFacts?.[0];
      const closingLead = context.transitionReason?.includes("最后一首") ? "这是本档最后一首。" : "";
      return { success: true, status: "ready", text: `${closingLead}${fact?.value ?? ""}`, factIds: fact ? [fact.id] : [], instruction: `natural radio ${hostCalls}`, deliveryInstruction: "自然口语", generatedAt: "2026-08-12T00:00:00.000Z", hostMoment: context.hostMoment };
    },
    async adjustRundown({ tracks }: { tracks: Array<{ id: string }> }) { return tracks.map((track) => track.id).reverse(); },
    generatePlaylistNames() { playlistNamingCalls += 1; throw new Error("private tracks must stay local"); },
  };
  const ttsProvider = {
    async synthesize() { ttsCalls += 1; await new Promise((resolve) => setTimeout(resolve, 20)); return { success: true, status: "ready", audio: Buffer.from("RIFF0000WAVElocked") }; },
  };
  const service = await createLocalService({ port: 0, neteaseProvider, desktopPlayerController, hostProvider, ttsProvider, localControlToken: "netease-program-token" });
  await service.start();
  context.after(() => service.stop());
  const base = `http://127.0.0.1:${service.port}/api`;
  const post = (path: string, body: unknown, signal?: AbortSignal) => fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-one-radio-control-token": "netease-program-token" },
    body: JSON.stringify(body),
    signal,
  });
  const createProgram = async (operationId: string) => (await json(await post("/programs", {
    operationId,
    spec: { sourceId: "netease_music", durationMinutes: 30, scenePreset: "late_night", sceneDescription: "安静但不低沉", hostDensity: "medium", energyCurve: "low", avoid: [], familiarityRatio: 20 },
  }))).program;

  const [first, concurrentReplay] = await Promise.all([
    createProgram("netease-create-1"),
    createProgram("netease-create-1"),
  ]);
  assert.equal(concurrentReplay.id, first.id);
  assert.equal((await fetch(`${base}/programs/progress?operationId=netease-create-1`)).status, 401);
  const completedProgress = await json(await fetch(`${base}/programs/progress?operationId=netease-create-1`, { headers: { "x-one-radio-control-token": "netease-program-token" } }));
  assert.deepEqual(completedProgress.progress, {
    completedSteps: 4,
    status: "completed",
    updatedAt: completedProgress.progress.updatedAt,
  });
  assert.equal((await fetch(`${base}/program`)).status, 401);
  assert.equal((await fetch(`${base}/programs/${first.id}`)).status, 401);
  assert.equal(accountCalls, 2);
  assert.equal(first.status, "awaiting_confirmation");
  assert.match(first.plannedPlaylistName, /^AI电台-放松-[\p{Script=Han}]{3,6}$/u);
  assert.ok(first.planSummary.totalTracks > 0);
  assert.equal(first.planSummary.targetFamiliarityRatio, 20);
  assert.equal(first.planSummary.heardTracks, Math.round(first.planSummary.totalTracks * 0.2));
  assert.equal(first.planSummary.actualFamiliarityRatio, Math.round((first.planSummary.heardTracks / first.planSummary.totalTracks) * 100));
  assert.ok(first.rundown.every((track: { hostMoment?: string; hostScript?: { text?: string } }) => !track.hostMoment || Boolean(track.hostScript?.text)));
  assert.equal(ttsCalls, 0, "draft creation must not synthesize speech before confirmation");
  assert.ok(first.listenerProfile.favoriteArtists.length > 0);
  const profilePath = join(SERVER_TEST_PROFILE_DIR, `netease-${createHash("sha256").update("netease:7").digest("hex").slice(0, 24)}.json`);
  const draftProfile = JSON.parse(readFileSync(profilePath, "utf8"));
  assert.deepEqual(draftProfile.playedTracks, [], "generating a rundown must not mark every candidate as played");
  const originalIds = first.rundown.map((track: { id: string }) => track.id);
  const invalidReorder = await post(`/programs/${first.id}/reorder`, { generation: first.generation, planRevision: 0, operationId: "plan-invalid", trackIds: [originalIds[0], originalIds[0]] });
  assert.equal(invalidReorder.status, 400);
  const reordered = (await json(await post(`/programs/${first.id}/reorder`, { generation: first.generation, planRevision: 0, operationId: "plan-reorder", trackIds: [...originalIds].reverse() }))).program;
  assert.deepEqual(reordered.rundown.map((track: { id: string }) => track.id), [...originalIds].reverse());
  assert.equal(ttsCalls, 0, "manual reorder must only rewrite copy before confirmation");
  const adjusted = (await json(await post(`/programs/${first.id}/adjust`, { generation: first.generation, planRevision: 1, operationId: "plan-adjust", message: "把顺序反过来" }))).program;
  assert.deepEqual(adjusted.rundown.map((track: { id: string }) => track.id), originalIds, "AI adjustment must reorder the current songs");
  assert.equal(ttsCalls, 0, "AI adjustment must not synthesize speech before confirmation");
  const hostCallsAfterAdjustment = hostCalls;
  const adjustmentReplay = (await json(await post(`/programs/${first.id}/adjust`, { generation: first.generation, planRevision: 1, operationId: "plan-adjust", message: "把顺序反过来" }))).program;
  assert.equal(adjustmentReplay.planRevision, 2);
  assert.equal(hostCalls, hostCallsAfterAdjustment, "replaying a plan operation must not call the model twice");
  const replacedIndex = 1;
  const replacedId = adjustmentReplay.rundown[replacedIndex].id;
  const replaced = (await json(await post(`/programs/${first.id}/replace`, { generation: first.generation, planRevision: 2, operationId: "plan-replace", trackId: replacedId }))).program;
  assert.equal(replaced.rundown.length, adjustmentReplay.rundown.length);
  assert.notEqual(replaced.rundown[replacedIndex].id, replacedId);
  assert.deepEqual(replaced.rundown.filter((_: unknown, index: number) => index !== replacedIndex).map((track: { id: string }) => track.id), adjustmentReplay.rundown.filter((_: unknown, index: number) => index !== replacedIndex).map((track: { id: string }) => track.id));
  assert.match(replaced.rundown.at(-1).hostScript.text, /最后一首|最后一曲|收官曲|收尾曲/);
  const replacedIds = new Set(replaced.rundown.map((track: { id: string }) => track.id));
  const regenerated = (await json(await post(`/programs/${first.id}/regenerate`, { generation: first.generation, planRevision: 3, operationId: "plan-regenerate" }))).program;
  assert.equal(regenerated.rundown.length, replaced.rundown.length);
  assert.ok(regenerated.rundown.every((track: { id: string }) => !replacedIds.has(track.id)), "recommendation refresh must replace the whole visible rundown when enough fresh tracks exist");
  const staleConfirm = await post(`/programs/${first.id}/confirm`, { generation: first.generation, planRevision: 1, operationId: "stale-plan-confirm" });
  assert.equal(staleConfirm.status, 409);
  assert.equal((await json(staleConfirm)).code, "GENERATION_MISMATCH");
  assert.equal(ttsCalls, 0, "a stale visible plan must fail before TTS or playlist writes");
  const hostCallsAfterPlanning = hostCalls;
  assert.equal(playlistCreates.length, 0);
  const unauthorized = await fetch(`${base}/programs/${first.id}/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ generation: first.generation, operationId: "unauthorized-confirm" }) });
  assert.equal(unauthorized.status, 401);
  assert.equal(playlistCreates.length, 0);
  blockAccountRead = true;
  const accountStarted = new Promise<void>((resolve) => { accountReadStarted = resolve; });
  const abortController = new AbortController();
  const abortedConfirm = post(`/programs/${first.id}/confirm`, { generation: first.generation, planRevision: 4, operationId: "netease-confirm-aborted" }, abortController.signal);
  await accountStarted;
  abortController.abort();
  await assert.rejects(abortedConfirm, /abort/i);
  blockAccountRead = false;
  accountReadStarted = null;
  assert.equal(playlistCreates.length, 0);
  const confirmedResponse = await post(`/programs/${first.id}/confirm`, { generation: first.generation, planRevision: 4, operationId: "netease-confirm-1" });
  assert.equal(confirmedResponse.status, 200);
  const confirmed = (await json(confirmedResponse)).program;
  assert.equal(confirmed.status, "on_air");
  const confirmedProfile = JSON.parse(readFileSync(profilePath, "utf8"));
  assert.equal(confirmedProfile.playedTracks[0]?.id, confirmed.currentTrack.id, "the first track is recorded when playback starts");
  assert.equal(confirmed.playlist.status, "ready");
  assert.equal(confirmed.playlist.name, first.plannedPlaylistName);
  assert.equal(confirmed.playlist.trackCount, playlistAdds[0]?.trackIds.length);
  assert.match(confirmed.currentTrack.audioUrl, new RegExp(`/api/netease/audio/${first.id}/${confirmed.generation}/\\d+$`));
  assert.equal(new Set(confirmed.rundown.map((track: { artist: string }) => track.artist)).size, confirmed.rundown.length);
  assert.equal(desktopCalls, 0);
  const targetLiked = confirmed.currentTrack.liked !== true;
  const likedResponse = await post(`/programs/${first.id}/current/like`, { generation: confirmed.generation, trackId: confirmed.currentTrack.id, liked: targetLiked });
  assert.equal(likedResponse.status, 200);
  const likedProgram = (await json(likedResponse)).program;
  assert.deepEqual(likedMutations, [{ id: confirmed.currentTrack.id, liked: targetLiked }]);
  assert.equal(likedProgram.currentTrack.liked, targetLiked);
  assert.equal(likedProgram.rundown.find((track: { id: string }) => track.id === confirmed.currentTrack.id).liked, targetLiked);
  const staleLikedResponse = await post(`/programs/${first.id}/current/like`, { generation: confirmed.generation, trackId: "stale-track", liked: false });
  assert.equal(staleLikedResponse.status, 409);
  const [lockedPreview, concurrentLockedPreview] = await Promise.all([
    post("/host/preview", { programId: first.id, generation: confirmed.generation, trackId: confirmed.currentTrack.id }),
    post("/host/preview", { programId: first.id, generation: confirmed.generation, trackId: confirmed.currentTrack.id }),
  ]);
  assert.equal(lockedPreview.status, 200);
  assert.equal(concurrentLockedPreview.status, 200);
  const confirmedCurrent = confirmed.rundown.find((track: { id: string }) => track.id === confirmed.currentTrack.id);
  assert.equal((await json(lockedPreview)).host.text, confirmedCurrent.hostScript.text);
  assert.equal((await json(concurrentLockedPreview)).host.text, confirmedCurrent.hostScript.text);
  const preparedTtsCalls = confirmed.rundown.filter((track: { hostScript?: { audioReady?: boolean } }) => track.hostScript?.audioReady === true).length;
  assert.equal(ttsCalls, preparedTtsCalls);
  const preparedHostScripts = confirmed.rundown
    .map((track: { hostScript?: { audioReady?: boolean; plannedDurationSeconds?: number; musicBedDelaySeconds?: number } }) => track.hostScript)
    .filter((script: unknown): script is { audioReady: boolean; plannedDurationSeconds: number; musicBedDelaySeconds: number } => Boolean(script));
  assert.ok(
    preparedHostScripts.every((script: { plannedDurationSeconds: number }) => script.plannedDurationSeconds >= 5 && script.plannedDurationSeconds <= 35),
    JSON.stringify(preparedHostScripts.map((script: { plannedDurationSeconds: number; musicBedDelaySeconds: number }) => ({ plannedDurationSeconds: script.plannedDurationSeconds, musicBedDelaySeconds: script.musicBedDelaySeconds }))),
  );
  assert.ok(preparedHostScripts.every((script: { musicBedDelaySeconds: number }) => script.musicBedDelaySeconds === 5));
  assert.ok(preparedHostScripts.every((script: { audioReady: boolean }) => script.audioReady === true));
  if (preparedHostScripts.length >= 3 && preparedHostScripts.some((script: { plannedDurationSeconds: number }) => script.plannedDurationSeconds >= 20)) {
    assert.ok(new Set(preparedHostScripts.map((script: { plannedDurationSeconds: number }) => script.plannedDurationSeconds)).size > 1);
  }
  assert.equal(hostCalls, hostCallsAfterPlanning);
  const missingPreviewGeneration = await post("/host/preview", { programId: first.id, trackId: confirmed.currentTrack.id });
  assert.equal(missingPreviewGeneration.status, 400);
  const futureHostTrack = confirmed.rundown.find((track: { id: string; hostScript?: unknown }) => track.id !== confirmed.currentTrack.id && track.hostScript);
  assert.ok(futureHostTrack);
  const futurePreview = await post("/host/preview", { programId: first.id, generation: confirmed.generation, trackId: futureHostTrack.id });
  assert.equal(futurePreview.status, 409);

  const replay = await post(`/programs/${first.id}/confirm`, { generation: first.generation, operationId: "netease-confirm-1" });
  assert.equal(replay.status, 200);
  assert.equal(playlistCreates.length, 1);
  assert.equal(playlistAdds.length, 1);
  assert.equal(playlistNamingCalls, 0);
  assert.match(playlistCreates[0] ?? "", /^AI电台-放松-[\p{Script=Han}]{3,6}$/u);

  const advanced = (await json(await post(`/programs/${first.id}/next`, { generation: confirmed.generation, operationId: "netease-next-1" }))).program;
  assert.notEqual(advanced.currentTrack.id, confirmed.currentTrack.id);
  const advancedProfile = JSON.parse(readFileSync(profilePath, "utf8"));
  assert.deepEqual(advancedProfile.playedTracks.slice(0, 2).map((track: { id: string }) => track.id), [advanced.currentTrack.id, confirmed.currentTrack.id]);

  const stopped = (await json(await post(`/programs/${first.id}/stop`, { generation: advanced.generation, operationId: "netease-stop-1" }))).program;
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.playlist.status, "deleted");
  assert.equal(stopped.playlist.retention, "temporary");
  assert.deepEqual(playlistDeletes, [confirmed.playlist.id]);
  const terminalPreview = await post("/host/preview", { programId: first.id, generation: stopped.generation, trackId: first.rundown[0].id });
  assert.equal(terminalPreview.status, 409);
  const second = await createProgram("netease-create-2");
  const secondConfirmed = await post(`/programs/${second.id}/confirm`, { generation: second.generation, operationId: "netease-confirm-2", keepPlaylist: true });
  assert.equal(secondConfirmed.status, 200);
  const secondProgram = (await json(secondConfirmed)).program;
  assert.equal(secondProgram.playlist.retention, "kept");
  const secondStopped = (await json(await post(`/programs/${second.id}/stop`, { generation: secondProgram.generation, operationId: "netease-stop-2" }))).program;
  assert.equal(secondStopped.status, "stopped");
  assert.equal(secondStopped.playlist.retention, "kept");
  assert.equal(secondStopped.playlist.status, "ready");
  assert.equal(playlistCreates.length, 2);
  assert.equal(playlistAdds.length, 2);
  assert.equal(playlistDeletes.length, 1);
  assert.notEqual(playlistCreates[0], playlistCreates[1]);
  assert.equal(desktopCalls, 0);
});

test("NetEase confirmation does not duplicate a playlist after an ambiguous create result", async (context) => {
  const songs = Array.from({ length: 5 }, (_, index) => ({
    id: String(10_000 + index),
    title: `防重歌曲 ${index + 1}`,
    artists: [{ id: String(10_100 + index), name: `防重艺术家 ${index + 1}` }],
    durationMs: 360_000,
  }));
  let createCalls = 0;
  const provider = {
    ...planningProvider(songs, []),
    userPlaylists() { return { playlists: [], more: false }; },
    createPlaylist() { createCalls += 1; throw new Error("response timed out after remote commit"); },
    addSongsToPlaylist() { throw new Error("must not add after uncertain create"); },
    playlistDetail() { return { tracks: [] }; },
  };
  const token = "ambiguous-playlist-create-token";
  const service = await createLocalService({ port: 0, localControlToken: token, neteaseProvider: provider, hostProvider: groundedHostProvider(), ttsProvider: readyTtsProvider });
  await service.start();
  context.after(() => service.stop());
  const base = `http://127.0.0.1:${service.port}/api`;
  const headers = { "content-type": "application/json", "x-one-radio-control-token": token };
  const created = (await json(await fetch(`${base}/programs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ spec: { sourceId: "netease_music", durationMinutes: 30, scenePreset: "study", sceneDescription: "", hostDensity: "low", energyCurve: "steady", avoid: [], familiarityRatio: 0 } }),
  }))).program;
  const first = await fetch(`${base}/programs/${created.id}/confirm`, {
    method: "POST",
    headers,
    body: JSON.stringify({ generation: created.generation, operationId: "ambiguous-confirm-1" }),
  });
  assert.equal(first.status, 502);
  assert.equal(createCalls, 1);
  const retry = await fetch(`${base}/programs/${created.id}/confirm`, {
    method: "POST",
    headers,
    body: JSON.stringify({ generation: created.generation, operationId: "ambiguous-confirm-2" }),
  });
  assert.equal(retry.status, 409);
  assert.equal((await json(retry)).code, "NETEASE_PLAYLIST_CREATE_UNCERTAIN");
  assert.equal(createCalls, 1);
});

test("confirmation prepares every locked TTS asset and on-air preview never synthesizes again", async (context) => {
  const songs = Array.from({ length: 5 }, (_, index) => ({
    id: String(10_500 + index),
    title: `预览歌曲 ${index + 1}`,
    artists: [{ id: String(10_600 + index), name: `预览艺术家 ${index + 1}` }],
    durationMs: 360_000,
  }));
  const stored = new Map<string, string[]>();
  let ttsCalls = 0;
  const ttsInstructions: string[] = [];
  const provider = {
    ...planningProvider(songs, []),
    createPlaylist(name: string) { stored.set("preview-list", []); return { id: "preview-list", name }; },
    addSongsToPlaylist(_playlistId: string, ids: string[]) { stored.set("preview-list", ids); return { playlistId: "preview-list", trackIds: ids }; },
    playlistDetail() { return { id: "preview-list", tracks: (stored.get("preview-list") ?? []).map((id) => ({ id })) }; },
  };
  const token = "preview-retry-token";
  const service = await createLocalService({
    port: 0,
    localControlToken: token,
    neteaseProvider: provider,
    hostProvider: groundedHostProvider(),
    lockedTtsTimeoutMs: 30,
    ttsProvider: { synthesize(input: { instruction?: string }) {
      ttsCalls += 1;
      ttsInstructions.push(input.instruction ?? "");
      return { success: true, status: "ready", audio: Buffer.from("RIFF0000WAVE") };
    } },
  });
  await service.start();
  context.after(() => service.stop());
  const base = `http://127.0.0.1:${service.port}/api`;
  const headers = { "content-type": "application/json", "x-one-radio-control-token": token };
  const post = (path: string, value: unknown) => fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(value) });
  const created = (await json(await post("/programs", { spec: { sourceId: "netease_music", durationMinutes: 30, scenePreset: "study", sceneDescription: "", hostDensity: "low", energyCurve: "steady", avoid: [], familiarityRatio: 0, hostProfile: "longxin" } }))).program;
  assert.ok(created.rundown.every((track: { hostMoment?: string; hostScript?: { audioReady?: boolean } }) => !track.hostMoment || track.hostScript?.audioReady !== true));
  assert.equal(ttsCalls, 0);
  const confirmed = (await json(await post(`/programs/${created.id}/confirm`, { generation: created.generation, operationId: "preview-confirm" }))).program;
  const previewBody = { programId: created.id, generation: confirmed.generation, trackId: confirmed.currentTrack.id };
  assert.ok(confirmed.rundown.every((track: { hostMoment?: string; hostScript?: { audioReady?: boolean } }) => !track.hostMoment || track.hostScript?.audioReady === true));
  assert.ok(ttsInstructions.every((instruction) => /龙鑫/.test(instruction) && /清爽阳光/.test(instruction)));
  assert.ok(ttsInstructions.some((instruction) => /节目中段串联/.test(instruction)));
  const callsAfterConfirmation = ttsCalls;
  const firstPreview = await json(await post("/host/preview", previewBody));
  const secondPreview = await json(await post("/host/preview", previewBody));
  assert.equal(firstPreview.audio?.status, "ready", JSON.stringify(firstPreview));
  assert.equal(secondPreview.audio?.status, "ready", JSON.stringify(secondPreview));
  assert.equal(ttsCalls, callsAfterConfirmation);
  const advanced = (await json(await post(`/programs/${created.id}/next`, { generation: confirmed.generation, operationId: "preview-next" }))).program;
  assert.ok(advanced.generation > confirmed.generation);
  const stale = await post("/host/preview", previewBody);
  assert.equal(stale.status, 409);
});

test("confirmation keeps the draft and creates no playlist when locked host audio fails", async (context) => {
  const songs = Array.from({ length: 5 }, (_, index) => ({
    id: String(10_700 + index),
    title: `预生成失败歌曲 ${index + 1}`,
    artists: [{ id: String(10_800 + index), name: `预生成失败艺术家 ${index + 1}` }],
    durationMs: 360_000,
  }));
  let ttsCalls = 0;
  const token = "planning-tts-failure-token";
  const service = await createLocalService({
    port: 0,
    localControlToken: token,
    neteaseProvider: planningProvider(songs, []),
    hostProvider: groundedHostProvider(),
    ttsProvider: {
      synthesize() {
        ttsCalls += 1;
        return ttsCalls === 2
          ? { success: false, status: "failed", audio: null }
          : { success: true, status: "ready", audio: Buffer.from("RIFF0000WAVE") };
      },
    },
  });
  await service.start();
  context.after(() => service.stop());
  const base = `http://127.0.0.1:${service.port}/api`;
  const headers = { "content-type": "application/json", "x-one-radio-control-token": token };
  const response = await fetch(`${base}/programs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ spec: { sourceId: "netease_music", durationMinutes: 30, scenePreset: "study", sceneDescription: "", hostDensity: "high", energyCurve: "steady", avoid: [], familiarityRatio: 0 } }),
  });
  assert.equal(response.status, 201);
  const draft = (await json(response)).program;
  assert.equal(ttsCalls, 0);
  const confirm = await fetch(`${base}/programs/${draft.id}/confirm`, {
    method: "POST",
    headers,
    body: JSON.stringify({ generation: draft.generation, operationId: "tts-failure-confirm" }),
  });
  assert.equal(confirm.status, 502);
  assert.equal((await json(confirm)).code, "TTS_PROVIDER_ERROR");
  const current = (await json(await fetch(`${base}/program`, { headers }))).program;
  assert.equal(current.id, draft.id);
  assert.equal(current.status, "awaiting_confirmation");
});

test("NetEase planning fails closed before confirmation when no personalized track is playable", async (context) => {
  let playlistCreates = 0;
  let desktopCalls = 0;
  const song = { id: "301", title: "不可播候选", artists: [{ id: "1", name: "艺术家" }], album: { id: "2", name: "专辑" }, durationMs: 180_000 };
  const provider = {
    configured: true,
    state: "ready",
    getStatus() { return { configured: true, state: "ready", authenticated: true }; },
    health() { return { configured: true, state: "ready", authenticated: true }; },
    account() { return { uid: "7" }; },
    userPlaylists() { return { playlists: [], more: false }; },
    likedSongIds() { return [song.id]; },
    songDetail() { return [song]; },
    recentSongs() { return []; },
    listeningHistory() { return []; },
    dailyRecommendations() { return [song]; },
    personalFm() { return []; },
    search() { return { songs: [song], total: 1 }; },
    songUrl() { return { id: song.id, url: null }; },
    createPlaylist() { playlistCreates += 1; return { id: "999", name: "不应创建" }; },
    addSongsToPlaylist() { throw new Error("must not add"); },
  };
  const desktopPlayerController = { inspect() { desktopCalls += 1; throw new Error("must not inspect desktop"); } } as unknown as DesktopPlayerControllerLike;
  const service = await createLocalService({ port: 0, neteaseProvider: provider, desktopPlayerController, localControlToken: "netease-no-play-token" });
  await service.start();
  context.after(() => service.stop());
  const base = `http://127.0.0.1:${service.port}/api`;
  const response = await fetch(`${base}/programs`, { method: "POST", headers: { "content-type": "application/json", "x-one-radio-control-token": "netease-no-play-token" }, body: JSON.stringify({ spec: { sourceId: "netease_music", durationMinutes: 30, scenePreset: "study", sceneDescription: "", hostDensity: "low", energyCurve: "steady", avoid: [] } }) });
  assert.equal(response.status, 409);
  assert.equal((await json(response)).code, "NETEASE_NO_PLAYABLE_TRACKS");
  assert.equal(playlistCreates, 0);
  assert.equal(desktopCalls, 0);
  assert.equal((await json(await fetch(`${base}/program`, { headers: { "x-one-radio-control-token": "netease-no-play-token" } }))).program, null);
});

test("NetEase planning requires local authorization before reading private signals", async (context) => {
  let providerCalls = 0;
  const provider = {
    configured: true,
    state: "ready",
    getStatus() { return { configured: true, state: "ready", authenticated: true }; },
    health() { return { configured: true, state: "ready", authenticated: true }; },
    account() { providerCalls += 1; return { uid: "7" }; },
  };
  const service = await createLocalService({ port: 0, neteaseProvider: provider, localControlToken: "private-plan-token" });
  await service.start();
  context.after(() => service.stop());
  const response = await fetch(`http://127.0.0.1:${service.port}/api/programs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spec: { sourceId: "netease_music", durationMinutes: 30, scenePreset: "study", sceneDescription: "", hostDensity: "low", energyCurve: "steady", avoid: [] } }),
  });
  assert.equal(response.status, 401);
  assert.equal(providerCalls, 0);
  assert.equal((await json(await fetch(`http://127.0.0.1:${service.port}/api/program`, { headers: { "x-one-radio-control-token": "private-plan-token" } }))).program, null);
});

test("NetEase preferences distinguish complete signal failure from an empty profile", async (context) => {
  const controlToken = "netease-unavailable-profile-token";
  const fail = () => { throw new Error("upstream unavailable"); };
  const service = await createLocalService({
    port: 0,
    localControlToken: controlToken,
    neteaseProvider: {
      configured: true,
      state: "ready",
      health() { return { configured: true, state: "ready", authenticated: true }; },
      getStatus() { return { configured: true, state: "ready", authenticated: true }; },
      account() { return { uid: "7" }; },
      userPlaylists: fail,
      likedSongIds: fail,
      recentSongs: fail,
      listeningHistory: fail,
      dailyRecommendations: fail,
      personalFm: fail,
      search: fail,
      songDetail: fail,
    },
  });
  await service.start();
  context.after(() => service.stop());
  const response = await fetch(`http://127.0.0.1:${service.port}/api/netease/preferences?scene=study`, {
    headers: { "x-one-radio-control-token": controlToken },
  });
  assert.equal(response.status, 200);
  const payload = await json(response);
  assert.equal(payload.preferences.state, "unavailable");
  assert.equal(payload.preferences.nextCandidate, null);
  assert.equal(payload.preferences.failedSignals.length, 6);
});

test("NetEase validation routes report unconfigured and upstream failure states truthfully", async (context) => {
  const controlToken = "netease-failure-test-token";
  const authorizedFetch = (url: string, init: RequestInit = {}) => fetch(url, {
    ...init,
    headers: { ...Object.fromEntries(new Headers(init.headers)), "x-one-radio-control-token": controlToken },
  });
  const unconfigured = await createLocalService({
    port: 0,
    localControlToken: controlToken,
    neteaseProvider: {
      configured: false,
      state: "blocked_by_configuration",
      getStatus() {
        return { configured: false, state: "blocked_by_configuration", cookie: "private" };
      },
      search() {
        throw new Error("must not be called");
      },
    },
  });
  await unconfigured.start();
  context.after(() => unconfigured.stop());
  const unconfiguredBase = `http://127.0.0.1:${unconfigured.port}/api/netease`;
  const status = await json(await authorizedFetch(`${unconfiguredBase}/status`));
  assert.equal(status.status.configured, false);
  assert.equal(status.status.state, "blocked_by_configuration");
  const blocked = await authorizedFetch(`${unconfiguredBase}/search?keyword=test`);
  assert.equal(blocked.status, 503);
  assert.equal((await json(blocked)).code, "NETEASE_UNAVAILABLE");
  const blockedQr = await authorizedFetch(`${unconfiguredBase}/login/qr`, { method: "POST" });
  assert.equal(blockedQr.status, 503);
  assert.equal((await json(blockedQr)).code, "NETEASE_UNAVAILABLE");

  const failing = await createLocalService({
    port: 0,
    localControlToken: controlToken,
    neteaseProvider: {
      configured: true,
      state: "ready",
      search() {
        throw new Error("Cookie: MUSIC_U=private-provider-secret");
      },
    },
  });
  await failing.start();
  context.after(() => failing.stop());
  const failed = await authorizedFetch(`http://127.0.0.1:${failing.port}/api/netease/search?keyword=test`);
  assert.equal(failed.status, 502);
  const failedText = await failed.text();
  assert.match(failedText, /NETEASE_PROVIDER_ERROR/);
  assert.doesNotMatch(failedText, /MUSIC_U|private-provider-secret/);

  const failingStatus = await createLocalService({
    port: 0,
    localControlToken: controlToken,
    neteaseProvider: {
      configured: true,
      health() {
        throw new Error("Cookie: MUSIC_U=status-secret");
      },
    },
  });
  await failingStatus.start();
  context.after(() => failingStatus.stop());
  const failedStatus = await authorizedFetch(`http://127.0.0.1:${failingStatus.port}/api/netease/status`);
  assert.equal(failedStatus.status, 502);
  const failedStatusText = await failedStatus.text();
  assert.match(failedStatusText, /NETEASE_PROVIDER_ERROR/);
  assert.doesNotMatch(failedStatusText, /MUSIC_U|status-secret/);
});

test("QQ API programs read the private profile, lock the rundown, and play without desktop control", async (context) => {
  const controlToken = "qq-api-program-token";
  const songs = Array.from({ length: 10 }, (_, index) => ({
    id: String(50_000 + index),
    title: `QQ 画像歌曲 ${index + 1}`,
    artists: [{ id: String(60_000 + index), name: `QQ 艺术家 ${index + 1}` }],
    album: { id: String(70_000 + index), name: `QQ 专辑 ${index + 1}` },
    durationMs: 360_000,
    popularity: 80 - index,
    songType: index % 2,
  }));
  const byId = new Map(songs.map((song) => [song.id, song]));
  const likedIds = songs.slice(0, 6).map((song) => song.id);
  const playlistTracks = new Map<string, string[]>();
  const qrMethods: string[] = [];
  let playlistCreateCalls = 0;
  let playlistAddCalls = 0;
  const playlistMutationIds: string[] = [];
  const playlistMutationDirIds: string[] = [];
  const playlistMutationUids: string[] = [];
  const likeMutations: Array<{ id: string; liked: boolean; songType: number | undefined; expectedUid: string | undefined }> = [];
  let desktopCalls = 0;
  const qqProvider = {
    configured: true,
    state: "ready",
    getStatus() {
      return { configured: true, state: "ready", authenticated: true, persistentLogin: true, loginType: "wx" };
    },
    health() {
      return { configured: true, state: "ready", authenticated: true, persistentLogin: true };
    },
    createQrLogin(loginType: "wx" | "qq" | "mobile" = "mobile") {
      qrMethods.push(`create:${loginType}`);
      return { key: `qr-${loginType}`, qrImageDataUrl: `data:image/png;base64,${loginType}` };
    },
    checkQrLogin(key: string, loginType: "wx" | "qq" | "mobile" = "mobile") {
      qrMethods.push(`check:${key}:${loginType}`);
      return { key, state: "authorized", loginType };
    },
    account() { return { uid: "qq-user-7", nickname: "QQ 测试用户" }; },
    userPlaylists() { return { playlists: [], more: false }; },
    likedSongIds() { return likedIds; },
    songDetail(ids: string[]) { return ids.flatMap((id) => byId.has(id) ? [byId.get(id)!] : []); },
    recentSongs() { return songs.slice(0, 2).map((song) => ({ song })); },
    listeningHistory() { return songs.slice(1, 4).map((song) => ({ song })); },
    dailyRecommendations() { return songs; },
    personalFm() { return songs.slice(2); },
    search() { return { songs, total: songs.length }; },
    songUrl(id: string) { return { id, url: `https://isure.stream.qqmusic.qq.com/${id}.mp3`, durationMs: byId.get(id)?.durationMs }; },
    createPlaylist(name: string) {
      playlistCreateCalls += 1;
      const tid = `qq-playlist-${playlistCreateCalls}`;
      playlistTracks.set(tid, []);
      return { id: tid, dirId: `qq-dir-${playlistCreateCalls}`, name };
    },
    addSongsToPlaylist(id: string, ids: string[], _signal?: AbortSignal, identity?: { dirId: string; expectedUid: string }) {
      playlistAddCalls += 1;
      playlistMutationIds.push(id);
      playlistMutationDirIds.push(identity?.dirId ?? "");
      playlistMutationUids.push(identity?.expectedUid ?? "");
      playlistTracks.set(id, [...ids]);
      return { playlistId: id, trackIds: ids };
    },
    setSongLiked(id: string, liked: boolean, songType: number | undefined, _signal?: AbortSignal, identity?: { expectedUid: string }) {
      likeMutations.push({ id, liked, songType, expectedUid: identity?.expectedUid });
      return { trackId: id, liked };
    },
    playlistDetail(id: string) {
      return { id, name: "QQ 电台节目", tracks: (playlistTracks.get(id) ?? []).map((trackId) => ({ id: trackId })) };
    },
  };
  const desktopPlayerController: DesktopPlayerControllerLike = {
    async inspect(sourceId) { desktopCalls += 1; return { sourceId, state: "app_not_running", ok: false, controlledElements: 0, operationId: null, targetVolume: null, detail: "must not inspect desktop", appRunning: false, playing: false }; },
    async duck(sourceId, operationId) { desktopCalls += 1; return { sourceId, state: "app_not_running", ok: false, controlledElements: 0, operationId, targetVolume: null, detail: "must not duck desktop", appRunning: false, playing: false }; },
    async restore(sourceId, operationId) { desktopCalls += 1; return { sourceId, state: "app_not_running", ok: false, controlledElements: 0, operationId, targetVolume: null, detail: "must not restore desktop", appRunning: false, playing: false }; },
    async pause(sourceId, operationId) { desktopCalls += 1; return { sourceId, state: "app_not_running", ok: false, controlledElements: 0, operationId, targetVolume: null, detail: "must not pause desktop", appRunning: false, playing: false }; },
    async toggle(sourceId, operationId) { desktopCalls += 1; return { sourceId, state: "app_not_running", ok: false, controlledElements: 0, operationId, targetVolume: null, detail: "must not toggle desktop", appRunning: false, playing: false }; },
    async next(sourceId, operationId) { desktopCalls += 1; return { sourceId, state: "app_not_running", ok: false, controlledElements: 0, operationId, targetVolume: null, detail: "must not next desktop", appRunning: false, playing: false }; },
  };
  let hostCalls = 0;
  const hostProvider = {
    configured: true,
    state: "ready",
    generate(context: {
      currentTrack?: { id: string; title: string; artist: string } | null;
      previousTrack?: { id: string; title: string; artist: string } | null;
      transitionReason?: string;
    }) {
      hostCalls += 1;
      const focus = context.transitionReason?.includes("点评刚播完") ? context.previousTrack : context.currentTrack;
      const title = focus?.title ?? "这首歌";
      const artist = focus?.artist ?? "这位艺术家";
      return {
        success: true,
        status: "ready",
        text: `这一段由《${title}》和${artist}带来。先听声音怎样把空间撑开，再留意节奏和人声之间的呼吸；每一层细节都在慢慢改变今晚的气氛。开场的第一拍会给出最直接的线索，接下来听它如何把力度、距离和情绪一点点展开。`,
        factIds: [`track:${focus?.id ?? songs.find((song) => song.title === title)?.id ?? ""}:metadata`],
        instruction: `QQ 电台主持 ${hostCalls}`,
      };
    },
  };
  const service = await createLocalService({ port: 0, localControlToken: controlToken, qqProvider, desktopPlayerController, hostProvider, ttsProvider: readyTtsProvider });
  await service.start();
  const originalFetch = globalThis.fetch;
  context.after(async () => {
    globalThis.fetch = originalFetch;
    await service.stop();
  });
  const base = `http://127.0.0.1:${service.port}/api`;
  const headers = { "content-type": "application/json", "x-one-radio-control-token": controlToken };
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });

  assert.equal((await fetch(`${base}/qq/status`)).status, 401);
  const status = await json(await fetch(`${base}/qq/status`, { headers }));
  assert.equal(status.status.authenticated, true);
  assert.equal(status.status.persistentLogin, true);
  const sources = await json(await fetch(`${base}/sources`));
  const qqSource = sources.sources.find((source: { sourceId: string }) => source.sourceId === "qq_music");
  assert.equal(qqSource.hostedProgramAllowed, true);
  assert.equal(qqSource.accountConnected, true);
  const preferences = await json(await fetch(`${base}/qq/preferences?scene=late_night`, { headers }));
  assert.equal(preferences.provider, "qq");
  assert.ok(preferences.preferences.listenerProfile.favoriteArtists.length > 0);
  const search = await json(await fetch(`${base}/qq/search?keyword=画像`, { headers }));
  assert.equal(search.provider, "qq");
  assert.equal(search.result.songs.length, songs.length);
  const song = await json(await fetch(`${base}/qq/song/${songs[0]!.id}`, { headers }));
  assert.equal(song.provider, "qq");
  assert.equal(song.result.playback.available, true);

  const mobileQr = await json(await post("/qq/login/qr", {}));
  assert.equal(mobileQr.login.loginType, "mobile");
  assert.match(mobileQr.login.dataUrl, /^data:image\/png;base64,/);
  const qqQr = await json(await post("/qq/login/qr", { loginType: "qq" }));
  assert.equal(qqQr.login.loginType, "qq");
  const qrState = await json(await fetch(`${base}/qq/login/qr/${mobileQr.login.key}`, { headers }));
  assert.equal(qrState.login.state, "authorized");
  const qqQrState = await json(await fetch(`${base}/qq/login/qr/${qqQr.login.key}`, { headers }));
  assert.equal(qqQrState.login.state, "authorized");
  assert.deepEqual(qrMethods, ["create:mobile", "create:qq", `check:${mobileQr.login.key}:mobile`, `check:${qqQr.login.key}:qq`]);

  const createdResponse = await post("/programs", {
    operationId: "qq-api-create",
    spec: { sourceId: "qq_music", durationMinutes: 30, scenePreset: "late_night", sceneDescription: "安静陪伴", hostDensity: "low", energyCurve: "low", avoid: [], familiarityRatio: 60 },
  });
  assert.equal(createdResponse.status, 201, await createdResponse.clone().text());
  const created = (await json(createdResponse)).program;
  assert.equal(created.status, "awaiting_confirmation");
  assert.match(created.plannedPlaylistName, /^AI电台-放松-[\p{Script=Han}]{6}$/u);
  assert.equal(created.planSummary.targetFamiliarityRatio, 60);
  assert.equal(created.rundown.length, 5);
  assert.ok(created.listenerProfile.favoriteArtists.length > 0);
  assert.ok(created.rundown.every((track: { hostMoment?: string; hostScript?: { text?: string } }) => !track.hostMoment || Boolean(track.hostScript?.text)));
  assert.equal(hostCalls, created.rundown.filter((track: { hostMoment?: string }) => Boolean(track.hostMoment)).length);

  const confirmedResponse = await post(`/programs/${created.id}/confirm`, { generation: created.generation, operationId: "qq-api-confirm" });
  assert.equal(confirmedResponse.status, 200);
  const confirmed = (await json(confirmedResponse)).program;
  assert.equal(confirmed.status, "on_air");
  assert.equal(confirmed.playlist.provider, "qq_music");
  assert.equal(confirmed.playlist.status, "ready");
  assert.equal(confirmed.playlist.name, created.plannedPlaylistName);
  assert.equal(confirmed.playlist.trackCount, 5);
  assert.equal(playlistCreateCalls, 1);
  assert.equal(playlistAddCalls, 1);
  assert.deepEqual(playlistMutationIds, ["qq-playlist-1"]);
  assert.deepEqual(playlistMutationDirIds, ["qq-dir-1"]);
  assert.deepEqual(playlistMutationUids, ["qq-user-7"]);
  assert.match(confirmed.currentTrack.audioUrl, new RegExp(`/api/qq/audio/${created.id}/${confirmed.generation}/\\d+$`));
  assert.equal(desktopCalls, 0);
  const qqLikedResponse = await post(`/programs/${created.id}/current/like`, { generation: confirmed.generation, trackId: confirmed.currentTrack.id, liked: false });
  assert.equal(qqLikedResponse.status, 200);
  const qqLikedProgram = (await json(qqLikedResponse)).program;
  assert.deepEqual(likeMutations, [{ id: confirmed.currentTrack.id, liked: false, songType: confirmed.currentTrack.songType, expectedUid: "qq-user-7" }]);
  assert.equal(qqLikedProgram.currentTrack.liked, false);

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("qqmusic.qq.com")) {
      return new Response(Buffer.from("QQ-AUDIO"), { status: 200, headers: { "content-type": "audio/mpeg", "content-length": "8" } });
    }
    return originalFetch(input, init);
  };
  const audio = await fetch(`http://127.0.0.1:${service.port}${confirmed.currentTrack.audioUrl}`, { headers: { "x-one-radio-control-token": controlToken } });
  assert.equal(audio.status, 200);
  assert.equal(await audio.text(), "QQ-AUDIO");
  assert.equal(confirmed.nextTrack.hostMoment, undefined);
  const seamlessNextAudio = await fetch(`http://127.0.0.1:${service.port}${confirmed.nextTrack.audioUrl}`, { headers: { "x-one-radio-control-token": controlToken } });
  assert.equal(seamlessNextAudio.status, 200, "the immediate next track may preload only when no host break is planned");
  assert.equal(await seamlessNextAudio.text(), "QQ-AUDIO");

  const nextResponse = await post(`/programs/${created.id}/next`, { generation: confirmed.generation, operationId: "qq-api-next" });
  assert.equal(nextResponse.status, 200);
  const next = (await json(nextResponse)).program;
  assert.equal(next.status, "on_air");
  assert.notEqual(next.currentTrack.id, confirmed.currentTrack.id);
  assert.match(next.currentTrack.audioUrl, new RegExp(`/api/qq/audio/${created.id}/${next.generation}/\\d+$`));
  assert.ok(next.nextTrack.hostMoment);
  const protectedHostNextAudio = await fetch(`http://127.0.0.1:${service.port}${next.nextTrack.audioUrl}`, { headers: { "x-one-radio-control-token": controlToken } });
  assert.equal(protectedHostNextAudio.status, 404, "a planned host break cannot be bypassed by preloading its track");
  const stoppedResponse = await post(`/programs/${created.id}/stop`, { generation: next.generation, operationId: "qq-api-stop" });
  assert.equal(stoppedResponse.status, 200);
  assert.equal((await json(stoppedResponse)).program.status, "stopped");
  assert.equal(desktopCalls, 0);
});

test("QQ confirmation rejects an account switch during provisioning before any playlist write", async (context) => {
  const token = "qq-account-binding-token";
  const songs = Array.from({ length: 5 }, (_, index) => ({
    id: String(80_000 + index),
    title: `账号绑定歌曲 ${index + 1}`,
    artists: [{ id: String(81_000 + index), name: `账号绑定艺术家 ${index + 1}` }],
    durationMs: 360_000,
  }));
  let confirming = false;
  let confirmAccountReads = 0;
  let playlistWrites = 0;
  const provider = planningProvider(songs, songs.slice(0, 3).map((song) => song.id));
  const service = await createLocalService({
    port: 0,
    localControlToken: token,
    qqProvider: {
      ...provider,
      getStatus() { return { configured: true, state: "ready", authenticated: true, persistentLogin: true }; },
      account() {
        if (!confirming) return { uid: "qq-account-a" };
        confirmAccountReads += 1;
        return { uid: confirmAccountReads === 1 ? "qq-account-a" : "qq-account-b" };
      },
      songUrl(id: string) { return { id, url: `https://isure.stream.qqmusic.qq.com/${id}.mp3` }; },
      createPlaylist() { playlistWrites += 1; return { id: "account-binding-playlist", dirId: "account-binding-dir", name: "账号绑定" }; },
      addSongsToPlaylist() { playlistWrites += 1; return { playlistId: "account-binding-playlist", trackIds: [] }; },
      playlistDetail() { return { id: "account-binding-playlist", name: "账号绑定", tracks: [] }; },
    },
    hostProvider: groundedHostProvider(),
    ttsProvider: readyTtsProvider,
  });
  await service.start();
  context.after(() => service.stop());
  const base = `http://127.0.0.1:${service.port}/api`;
  const headers = { "content-type": "application/json", "x-one-radio-control-token": token };
  const createdResponse = await fetch(`${base}/programs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ spec: { sourceId: "qq_music", durationMinutes: 30, scenePreset: "study", sceneDescription: "", hostDensity: "low", energyCurve: "steady", avoid: [], familiarityRatio: 60 } }),
  });
  assert.equal(createdResponse.status, 201);
  const created = (await json(createdResponse)).program;

  confirming = true;
  const confirmedResponse = await fetch(`${base}/programs/${created.id}/confirm`, {
    method: "POST",
    headers,
    body: JSON.stringify({ generation: created.generation, operationId: "qq-account-binding-confirm" }),
  });
  assert.equal(confirmedResponse.status, 409);
  assert.equal((await json(confirmedResponse)).code, "ACCOUNT_CHANGED");
  assert.equal(confirmAccountReads, 2);
  assert.equal(playlistWrites, 0);
});

test("account preference loading caps liked-song detail batches at one hundred and merges all five hundred", async (context) => {
  const likedIds = Array.from({ length: 500 }, (_, index) => String(100_000 + index));
  const detailBatches: string[][] = [];
  const qqProvider = {
    configured: true,
    state: "ready",
    getStatus() { return { configured: true, state: "ready", authenticated: true, persistentLogin: true }; },
    health() { return { configured: true, state: "ready", authenticated: true, persistentLogin: true }; },
    account() { return { uid: "batch-user" }; },
    userPlaylists() { return { playlists: [], more: false }; },
    likedSongIds() { return likedIds; },
    songDetail(ids: string[]) {
      detailBatches.push([...ids]);
      return ids.map((id) => ({
        id,
        title: `批量歌曲 ${id}`,
        artists: [{ id: `artist-${id}`, name: `批量艺术家 ${id}` }],
        album: { id: `album-${id}`, name: "批量专辑" },
        durationMs: 180_000,
      }));
    },
    recentSongs() { return []; },
    listeningHistory() { return []; },
    dailyRecommendations() { return []; },
    personalFm() { return []; },
    search() { return { songs: [], total: 0 }; },
  };
  const service = await createLocalService({ port: 0, qqProvider, localControlToken: "qq-batch-token" });
  await service.start();
  context.after(() => service.stop());
  const response = await fetch(`http://127.0.0.1:${service.port}/api/qq/preferences?scene=study`, { headers: { "x-one-radio-control-token": "qq-batch-token" } });
  assert.equal(response.status, 200, await response.clone().text());
  const payload = await json(response);
  assert.deepEqual(detailBatches.map((batch) => batch.length), [100, 100, 100, 100, 100]);
  assert.equal(Math.max(...detailBatches.map((batch) => batch.length)), 100);
  assert.equal(new Set(detailBatches.flat()).size, 500);
  assert.ok(payload.preferences.listenerProfile.topSongs.length > 0);
  assert.equal(payload.preferences.listenerProfile.favoriteArtists.length, 8);
});

test("account rundown drops public-host playback URLs before locking a draft", async (context) => {
  const songs = [
    { id: "qq-bad-url", title: "不安全地址", artists: [{ id: "qq-artist-bad", name: "不安全艺术家" }], album: { id: "qq-album-bad", name: "测试专辑" }, durationMs: 1_800_000 },
    { id: "qq-good-url", title: "允许地址", artists: [{ id: "qq-artist-good", name: "允许艺术家" }], album: { id: "qq-album-good", name: "测试专辑" }, durationMs: 1_800_000 },
  ];
  const qqProvider = {
    configured: true,
    state: "ready",
    getStatus() { return { configured: true, state: "ready", authenticated: true }; },
    health() { return { configured: true, state: "ready", authenticated: true }; },
    account() { return { uid: "url-user" }; },
    userPlaylists() { return { playlists: [], more: false }; },
    likedSongIds() { return []; },
    songDetail() { return []; },
    recentSongs() { return []; },
    listeningHistory() { return []; },
    dailyRecommendations() { return songs; },
    personalFm() { return []; },
    search() { return { songs, total: songs.length }; },
    searchPlaylists() {
      return { total: 1, playlists: [{ id: "900", name: "学习专注精选", description: null, trackCount: songs.length }] };
    },
    playlistDetail(id: string) {
      return { id, name: "学习专注精选", description: null, trackCount: songs.length, tracks: songs };
    },
    songUrl(id: string) {
      return { id, url: id === "qq-bad-url" ? "https://example.com/public.mp3" : `https://isure.stream.qqmusic.qq.com/${id}.mp3` };
    },
  };
  const service = await createLocalService({ port: 0, qqProvider, hostProvider: groundedHostProvider(), ttsProvider: readyTtsProvider, localControlToken: "qq-url-token" });
  await service.start();
  context.after(() => service.stop());
  const response = await fetch(`http://127.0.0.1:${service.port}/api/programs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-one-radio-control-token": "qq-url-token" },
    body: JSON.stringify({
      operationId: "qq-url-create",
      spec: { sourceId: "qq_music", durationMinutes: 30, scenePreset: "study", sceneDescription: "", hostDensity: "low", energyCurve: "steady", avoid: [], familiarityRatio: 0 },
    }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  const payload = await json(response);
  assert.equal(payload.program.rundown.length, 1);
  assert.equal(payload.program.rundown[0].id, "qq-good-url");
});

test("QQ playlist confirmation repairs provider head-insert ordering before broadcast", async (context) => {
  const songs = [
    { id: "qq-order-1", title: "顺序一", artists: [{ id: "qq-order-artist-1", name: "顺序艺术家一" }], album: { id: "qq-order-album-1", name: "顺序专辑" }, durationMs: 900_000 },
    { id: "qq-order-2", title: "顺序二", artists: [{ id: "qq-order-artist-2", name: "顺序艺术家二" }], album: { id: "qq-order-album-2", name: "顺序专辑" }, durationMs: 900_000 },
  ];
  const playlistTracks = new Map<string, string[]>();
  let addCalls = 0;
  let replaceCalls = 0;
  const qqProvider = {
    configured: true,
    state: "ready",
    getStatus() { return { configured: true, state: "ready", authenticated: true }; },
    health() { return { configured: true, state: "ready", authenticated: true }; },
    account() { return { uid: "order-user" }; },
    userPlaylists() { return { playlists: [], more: false }; },
    likedSongIds() { return []; },
    songDetail() { return []; },
    recentSongs() { return []; },
    listeningHistory() { return []; },
    dailyRecommendations() { return songs; },
    personalFm() { return []; },
    search() { return { songs, total: songs.length }; },
    songUrl(id: string) { return { id, url: `https://isure.stream.qqmusic.qq.com/${id}.mp3` }; },
    createPlaylist(name: string) { playlistTracks.set("qq-order-playlist", []); return { id: "qq-order-playlist", dirId: "qq-order-dir", name }; },
    addSongsToPlaylist(id: string, ids: string[]) { addCalls += 1; playlistTracks.set(id, [...ids]); return { playlistId: id, trackIds: ids }; },
    replacePlaylistTracks(id: string, ids: string[]) { replaceCalls += 1; playlistTracks.set(id, [...ids].reverse()); return { playlistId: id, trackIds: ids }; },
    playlistDetail(id: string) {
      const tracks = [...(playlistTracks.get(id) ?? [])].reverse().map((trackId) => ({ id: trackId }));
      return { id, name: "顺序校验", tracks };
    },
  };
  const service = await createLocalService({ port: 0, qqProvider, hostProvider: groundedHostProvider(), ttsProvider: readyTtsProvider, localControlToken: "qq-order-token" });
  await service.start();
  context.after(() => service.stop());
  const base = `http://127.0.0.1:${service.port}/api`;
  const headers = { "content-type": "application/json", "x-one-radio-control-token": "qq-order-token" };
  const createResponse = await fetch(`${base}/programs`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      operationId: "qq-order-create",
      spec: { sourceId: "qq_music", durationMinutes: 30, scenePreset: "study", sceneDescription: "", hostDensity: "low", energyCurve: "steady", avoid: [], familiarityRatio: 0 },
    }),
  });
  assert.equal(createResponse.status, 201, await createResponse.clone().text());
  const draft = (await json(createResponse)).program;
  const confirmResponse = await fetch(`${base}/programs/${draft.id}/confirm`, {
    method: "POST",
    headers,
    body: JSON.stringify({ generation: draft.generation, operationId: "qq-order-confirm" }),
  });
  assert.equal(confirmResponse.status, 200, await confirmResponse.clone().text());
  const confirmed = (await json(confirmResponse)).program;
  assert.equal(confirmed.status, "on_air");
  assert.equal(confirmed.playlist.status, "ready");
  assert.equal(addCalls, 1);
  assert.equal(replaceCalls, 1);
});

test("QQ ambiguous playlist creation recovers the exact deterministic name instead of creating a duplicate", async (context) => {
  const song = { id: "qq-recover-1", title: "恢复歌曲", artists: [{ id: "qq-recover-artist", name: "恢复艺术家" }], album: { id: "qq-recover-album", name: "恢复专辑" }, durationMs: 1_800_000 };
  const remotePlaylists: Array<{ id: string; tid: string; dirId: string; name: string }> = [];
  const playlistTracks = new Map<string, string[]>();
  let createCalls = 0;
  const playlistOffsets: number[] = [];
  const oldPlaylists = Array.from({ length: 100 }, (_, index) => ({ id: `old-${index}`, name: `旧歌单${index}` }));
  const qqProvider = {
    configured: true,
    state: "ready",
    getStatus() { return { configured: true, state: "ready", authenticated: true }; },
    health() { return { configured: true, state: "ready", authenticated: true }; },
    account() { return { uid: "recover-user" }; },
    userPlaylists(_uid: string, options: { offset?: number } = {}) {
      const offset = options.offset ?? 0;
      playlistOffsets.push(offset);
      return offset === 0
        ? { playlists: oldPlaylists, more: true }
        : { playlists: remotePlaylists, more: false };
    },
    likedSongIds() { return []; },
    songDetail() { return []; },
    recentSongs() { return []; },
    listeningHistory() { return []; },
    dailyRecommendations() { return [song]; },
    personalFm() { return []; },
    search() { return { songs: [song], total: 1 }; },
    songUrl(id: string) { return { id, url: `https://isure.stream.qqmusic.qq.com/${id}.mp3` }; },
    createPlaylist(name: string) {
      createCalls += 1;
      remotePlaylists.push({ id: "qq-recovered-playlist", tid: "qq-recovered-playlist", dirId: "77", name });
      playlistTracks.set("qq-recovered-playlist", []);
      if (createCalls === 1) throw new Error("timeout after remote commit");
      return { id: "qq-recovered-playlist", dirId: "77", name };
    },
    addSongsToPlaylist(id: string, ids: string[]) { playlistTracks.set(id, [...ids]); return { playlistId: id, trackIds: ids }; },
    playlistDetail(id: string) { return { id, name: "恢复歌单", tracks: (playlistTracks.get(id) ?? []).map((trackId) => ({ id: trackId })) }; },
  };
  const service = await createLocalService({ port: 0, qqProvider, hostProvider: groundedHostProvider(), ttsProvider: readyTtsProvider, localControlToken: "qq-recover-token" });
  await service.start();
  context.after(() => service.stop());
  const base = `http://127.0.0.1:${service.port}/api`;
  const headers = { "content-type": "application/json", "x-one-radio-control-token": "qq-recover-token" };
  const createResponse = await fetch(`${base}/programs`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      operationId: "qq-recover-create",
      spec: { sourceId: "qq_music", durationMinutes: 30, scenePreset: "late_night", sceneDescription: "", hostDensity: "low", energyCurve: "steady", avoid: [], familiarityRatio: 0 },
    }),
  });
  assert.equal(createResponse.status, 201, await createResponse.clone().text());
  const draft = (await json(createResponse)).program;
  const firstConfirm = await fetch(`${base}/programs/${draft.id}/confirm`, {
    method: "POST",
    headers,
    body: JSON.stringify({ generation: draft.generation, operationId: "qq-recover-confirm-1" }),
  });
  assert.equal(firstConfirm.status, 502);
  assert.equal((await json(firstConfirm)).code, "QQ_PROVIDER_ERROR");
  assert.equal(createCalls, 1);
  const secondConfirm = await fetch(`${base}/programs/${draft.id}/confirm`, {
    method: "POST",
    headers,
    body: JSON.stringify({ generation: draft.generation, operationId: "qq-recover-confirm-2" }),
  });
  assert.equal(secondConfirm.status, 200, await secondConfirm.clone().text());
  const confirmed = (await json(secondConfirm)).program;
  assert.equal(confirmed.status, "on_air");
  assert.equal(confirmed.playlist.id, "qq-recovered-playlist");
  assert.equal(createCalls, 1);
  assert.ok(playlistOffsets.includes(100));
  assert.match(remotePlaylists[0]?.name ?? "", /^AI电台-放松-[\p{Script=Han}]{6}$/u);
});

test("QQ confirmation fails before account writes when playlist inventory exceeds the recovery bound", async (context) => {
  const song = { id: "qq-inventory-1", title: "边界歌曲", artists: [{ id: "qq-inventory-artist", name: "边界艺术家" }], album: { id: "qq-inventory-album", name: "边界专辑" }, durationMs: 1_800_000 };
  let playlistCreateCalls = 0;
  const qqProvider = {
    configured: true,
    state: "ready",
    getStatus() { return { configured: true, state: "ready", authenticated: true }; },
    health() { return { configured: true, state: "ready", authenticated: true }; },
    account() { return { uid: "inventory-user" }; },
    userPlaylists(_uid: string, options: { offset?: number } = {}) {
      const offset = options.offset ?? 0;
      return { playlists: Array.from({ length: 100 }, (_, index) => ({ id: `old-${offset + index}`, name: `旧歌单${offset + index}` })), more: true };
    },
    likedSongIds() { return []; },
    songDetail() { return []; },
    recentSongs() { return []; },
    listeningHistory() { return []; },
    dailyRecommendations() { return [song]; },
    personalFm() { return []; },
    search() { return { songs: [song], total: 1 }; },
    songUrl(id: string) { return { id, url: `https://isure.stream.qqmusic.qq.com/${id}.mp3` }; },
    createPlaylist() { playlistCreateCalls += 1; return { id: "must-not-create", dirId: "must-not-create-dir", name: "must-not-create" }; },
    addSongsToPlaylist() { throw new Error("must not add songs"); },
    playlistDetail() { throw new Error("must not read a playlist that was not created"); },
  };
  const service = await createLocalService({ port: 0, qqProvider, hostProvider: groundedHostProvider(), ttsProvider: readyTtsProvider, localControlToken: "qq-inventory-token" });
  await service.start();
  context.after(() => service.stop());
  const base = `http://127.0.0.1:${service.port}/api`;
  const headers = { "content-type": "application/json", "x-one-radio-control-token": "qq-inventory-token" };
  const createResponse = await fetch(`${base}/programs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ operationId: "qq-inventory-create", spec: { sourceId: "qq_music", durationMinutes: 30, scenePreset: "late_night", sceneDescription: "", hostDensity: "low", energyCurve: "steady", avoid: [], familiarityRatio: 0 } }),
  });
  assert.equal(createResponse.status, 201, await createResponse.clone().text());
  const draft = (await json(createResponse)).program;
  const confirmResponse = await fetch(`${base}/programs/${draft.id}/confirm`, {
    method: "POST",
    headers,
    body: JSON.stringify({ generation: draft.generation, operationId: "qq-inventory-confirm" }),
  });
  assert.equal(confirmResponse.status, 503, await confirmResponse.clone().text());
  assert.equal((await json(confirmResponse)).code, "QQ_PROVIDER_ERROR");
  assert.equal(playlistCreateCalls, 0);
});

test("production QQ programs never fall back to desktop control", async (context) => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  let desktopCalls = 0;
  const desktopPlayerController: DesktopPlayerControllerLike = {
    async inspect(sourceId) { desktopCalls += 1; return { sourceId, state: "ready", ok: true, controlledElements: 0, operationId: null, targetVolume: null, detail: "unexpected", appRunning: true, playing: true }; },
    async duck(sourceId, operationId) { desktopCalls += 1; return { sourceId, state: "ducked", ok: true, controlledElements: 0, operationId, targetVolume: null, detail: "unexpected", appRunning: true, playing: true }; },
    async restore(sourceId, operationId) { desktopCalls += 1; return { sourceId, state: "restored", ok: true, controlledElements: 0, operationId, targetVolume: null, detail: "unexpected", appRunning: true, playing: true }; },
    async pause(sourceId, operationId) { desktopCalls += 1; return { sourceId, state: "paused", ok: true, controlledElements: 0, operationId, targetVolume: null, detail: "unexpected", appRunning: true, playing: false }; },
    async toggle(sourceId, operationId) { desktopCalls += 1; return { sourceId, state: "playing", ok: true, controlledElements: 0, operationId, targetVolume: null, detail: "unexpected", appRunning: true, playing: true }; },
    async next(sourceId, operationId) { desktopCalls += 1; return { sourceId, state: "next_requested", ok: true, controlledElements: 0, operationId, targetVolume: null, detail: "unexpected", appRunning: true, playing: null }; },
  };
  const desktopProgramController: DesktopProgramControllerLike = {
    async prepare(sourceId, _scenePreset, _description, operationId) { desktopCalls += 1; return { sourceId, operationId, query: "unexpected", state: "ready", ok: true, detail: "unexpected" }; },
  };
  const service = await createLocalService({ port: 0, desktopPlayerController, desktopProgramController, localControlToken: "qq-production-token" });
  await service.start();
  context.after(async () => {
    await service.stop();
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  });
  const response = await fetch(`http://127.0.0.1:${service.port}/api/programs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-one-radio-control-token": "qq-production-token" },
    body: JSON.stringify({
      operationId: "qq-production-create",
      spec: { sourceId: "qq_music", durationMinutes: 30, scenePreset: "study", sceneDescription: "", hostDensity: "low", energyCurve: "steady", avoid: [] },
    }),
  });
  assert.equal(response.status, 503);
  assert.equal((await json(response)).code, "QQ_UNAVAILABLE");
  assert.equal(desktopCalls, 0);
});
