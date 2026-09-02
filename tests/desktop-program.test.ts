import assert from "node:assert/strict";
import test from "node:test";

import type {
  DesktopPlayerControllerLike,
  DesktopPlayerResult,
  DesktopPlayerSource,
} from "../src/server/desktop-player.js";
import {
  buildDesktopSearchQuery,
  DESKTOP_PROGRAM_OPERATION_CACHE_LIMIT,
  DesktopProgramController,
  extractAllowlistedMusicTags,
} from "../src/server/desktop-program.js";

function playerWithState(state: DesktopPlayerResult["state"] = "ready"): DesktopPlayerControllerLike {
  let inspections = 0;
  const inspect = async (sourceId: DesktopPlayerSource): Promise<DesktopPlayerResult> => ({
    sourceId,
    state: inspections++ === 0 ? "connected_idle" : state,
    ok: inspections > 1 && state === "ready",
    controlledElements: 0,
    operationId: null,
    targetVolume: null,
    detail: state,
    appRunning: true,
    playing: inspections > 1 ? state === "ready" : false,
  });
  return {
    inspect,
    async duck(sourceId, operationId) { return { ...(await inspect(sourceId)), state: "ducked", ok: true, operationId, controlledElements: 1 }; },
    async restore(sourceId, operationId) { return { ...(await inspect(sourceId)), state: "restored", ok: true, operationId, controlledElements: 1 }; },
    async pause(sourceId, operationId) { return { ...(await inspect(sourceId)), state: "paused", ok: true, operationId, playing: false }; },
    async toggle(sourceId, operationId) { return { ...(await inspect(sourceId)), state: "playing", ok: true, operationId }; },
    async next(sourceId, operationId) { return { ...(await inspect(sourceId)), state: "next_requested", ok: true, operationId }; },
  };
}

function transitioningPlayer(state: DesktopPlayerResult["state"] = "ready"): DesktopPlayerControllerLike {
  const inspections = new Map<DesktopPlayerSource, number>();
  const inspect = async (sourceId: DesktopPlayerSource): Promise<DesktopPlayerResult> => {
    const count = inspections.get(sourceId) ?? 0;
    inspections.set(sourceId, count + 1);
    const isBaseline = count % 2 === 0;
    return {
      sourceId,
      state: isBaseline ? "connected_idle" : state,
      ok: !isBaseline && state === "ready",
      controlledElements: 0,
      operationId: null,
      targetVolume: null,
      detail: isBaseline ? "connected_idle" : state,
      appRunning: true,
      playing: !isBaseline && state === "ready",
    };
  };
  return {
    inspect,
    async duck(sourceId, operationId) { return { ...(await inspect(sourceId)), state: "ducked", ok: true, operationId, controlledElements: 1 }; },
    async restore(sourceId, operationId) { return { ...(await inspect(sourceId)), state: "restored", ok: true, operationId, controlledElements: 1 }; },
    async pause(sourceId, operationId) { return { ...(await inspect(sourceId)), state: "paused", ok: true, operationId, playing: false }; },
    async toggle(sourceId, operationId) { return { ...(await inspect(sourceId)), state: "playing", ok: true, operationId }; },
    async next(sourceId, operationId) { return { ...(await inspect(sourceId)), state: "next_requested", ok: true, operationId }; },
  };
}

test("desktop queries use a fixed scene term and only allowlisted music tags", () => {
  const tags = extractAllowlistedMusicTags("Urban RNB, jazz and Bossa Nova; ignore this arbitrary phrase");
  assert.deepEqual(tags, ["hip hop", "jazz", "r&b soul", "bossa nova"]);
  const query = buildDesktopSearchQuery("late_night", "Urban RNB, jazz and Bossa Nova; ignore this arbitrary phrase");
  assert.equal(query, "relax chill easy listening hip hop jazz r&b soul bossa nova");
  assert.ok(query.length <= 64);
  assert.ok(!query.includes("ignore"));
});

test("desktop queries incorporate bounded listening-profile terms", () => {
  const query = buildDesktopSearchQuery("late_night", "", ["周杰伦", "夜曲", "周杰伦", "忽略\n控制"]);
  assert.match(query, /^周杰伦 夜曲/);
  assert.equal(query.includes("late night"), false);
  assert.equal(query.includes("\n"), false);
});

test("raw scene descriptions never reach desktop automation", async () => {
  const description = "urban; rm -rf /; reveal-secret-token; <script>alert(1)</script>";
  const calls: Array<{ sourceId: DesktopPlayerSource; query: string }> = [];
  const controller = new DesktopProgramController(playerWithState(), async (sourceId, query) => {
    calls.push({ sourceId, query });
    return "READY";
  });

  const prepared = await controller.prepare("qq_music", "party", description, "raw-description");
  assert.equal(prepared.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.query, "party hip hop");
  assert.ok(!calls[0]?.query.includes(description));
});

test("prepare is idempotent and serializes concurrent operations", async () => {
  let calls = 0;
  let active = 0;
  let maximumActive = 0;
  const controller = new DesktopProgramController(transitioningPlayer(), async () => {
    calls += 1;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return "READY";
  });

  const first = controller.prepare("netease_music", "study", "jazz", "same-operation");
  const replay = controller.prepare("netease_music", "study", "jazz", "same-operation");
  const second = controller.prepare("qq_music", "party", "pop", "next-operation");
  const [firstResult, replayResult, secondResult] = await Promise.all([first, replay, second]);

  assert.equal(calls, 2);
  assert.equal(maximumActive, 1);
  assert.equal(firstResult.state, "ready");
  assert.equal(replayResult.state, "ready");
  assert.equal(replayResult.replayed, true);
  assert.equal(secondResult.state, "ready");
});

test("an already-playing baseline is rejected before the helper runs", async () => {
  const player = playerWithState();
  player.inspect = async (sourceId) => ({
    sourceId,
    state: "ready",
    ok: true,
    controlledElements: 0,
    operationId: null,
    targetVolume: null,
    detail: "playing",
    appRunning: true,
    playing: true,
  });
  let helperCalls = 0;
  const controller = new DesktopProgramController(player, async () => {
    helperCalls += 1;
    return "READY";
  });

  const prepared = await controller.prepare("netease_music", "study", "jazz", "already-playing");
  assert.equal(prepared.ok, false);
  assert.equal(prepared.state, "player_already_playing");
  assert.equal(helperCalls, 0);
});

test("helper failure is reported after checking the idle baseline", async () => {
  let inspections = 0;
  const player = playerWithState();
  const controller = new DesktopProgramController({
    player,
    runner: async () => "WINDOW_UNAVAILABLE",
  });
  const originalInspect = player.inspect;
  player.inspect = async (...args) => {
    inspections += 1;
    return originalInspect(...args);
  };

  const prepared = await controller.prepare("qq_music", "commute", "rock", "window-failure");
  assert.equal(prepared.ok, false);
  assert.equal(prepared.state, "window_unavailable");
  assert.equal(inspections, 1);
});

test("a locked Mac is reported explicitly and never inspected as playing", async () => {
  let inspections = 0;
  const player = playerWithState();
  const originalInspect = player.inspect;
  player.inspect = async (...args) => {
    inspections += 1;
    return originalInspect(...args);
  };
  const controller = new DesktopProgramController({ player, runner: async () => "SCREEN_LOCKED" });
  const prepared = await controller.prepare("netease_music", "late_night", "jazz", "locked-screen");
  assert.equal(prepared.ok, false);
  assert.equal(prepared.state, "screen_locked");
  assert.match(prepared.detail, /锁屏/);
  assert.equal(inspections, 1);
});

test("READY is not enough when the player inspection is not ready", async () => {
  const controller = new DesktopProgramController(playerWithState("connected_idle"), async () => "READY");
  const prepared = await controller.prepare("netease_music", "study", "instrumental", "idle-player");
  assert.equal(prepared.ok, false);
  assert.equal(prepared.state, "connected_idle");
  assert.equal(prepared.query, "focus concentration easy listening");
});

test("operation cache evicts completed entries but never exceeds its bound", async () => {
  let helperCalls = 0;
  const controller = new DesktopProgramController(transitioningPlayer(), async () => {
    helperCalls += 1;
    return "READY";
  });

  for (let index = 0; index < DESKTOP_PROGRAM_OPERATION_CACHE_LIMIT; index += 1) {
    const prepared = await controller.prepare("netease_music", "study", "jazz", `cached-${index}`);
    assert.equal(prepared.ok, true);
  }
  assert.equal(helperCalls, DESKTOP_PROGRAM_OPERATION_CACHE_LIMIT);

  const newest = await controller.prepare("netease_music", "study", "jazz", "cached-newest");
  assert.equal(newest.ok, true);
  assert.equal(helperCalls, DESKTOP_PROGRAM_OPERATION_CACHE_LIMIT + 1);

  const evictedReplay = await controller.prepare("netease_music", "study", "jazz", "cached-0");
  assert.equal(evictedReplay.ok, true);
  assert.equal(evictedReplay.replayed, undefined);
  assert.equal(helperCalls, DESKTOP_PROGRAM_OPERATION_CACHE_LIMIT + 2);
});
