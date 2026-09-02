import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DesktopPlayerController } from "../src/server/desktop-player.js";

test("desktop player reports running, playing, idle, lock, permission, and missing-app states", async () => {
  const outputs = ["APP_NOT_RUNNING", "SCREEN_LOCKED", "AUTOMATION_DENIED", "CONNECTED_IDLE", "READY"];
  const controller = new DesktopPlayerController(async () => outputs.shift() ?? "FAILED");

  const missing = await controller.inspect("qq_music");
  assert.equal(missing.state, "app_not_running");
  assert.equal(missing.appRunning, false);

  const locked = await controller.inspect("netease_music");
  assert.equal(locked.state, "screen_locked");
  assert.equal(locked.playing, null);

  assert.equal((await controller.inspect("netease_music")).state, "automation_denied");
  const idle = await controller.inspect("qq_music");
  assert.equal(idle.state, "connected_idle");
  assert.equal(idle.appRunning, true);
  assert.equal(idle.playing, false);

  const playing = await controller.inspect("netease_music");
  assert.equal(playing.state, "ready");
  assert.equal(playing.ok, true);
  assert.equal(playing.playing, true);
});

test("desktop scripts target only fixed app processes and localized control menus", async () => {
  const scripts: string[] = [];
  const controller = new DesktopPlayerController(async (script) => {
    scripts.push(script);
    return "READY";
  });

  await controller.inspect("qq_music");
  await controller.inspect("netease_music");
  await controller.next("qq_music", "next-qq");
  await controller.next("netease_music", "next-netease");

  assert.match(scripts[0], /process "QQMusic"/);
  assert.match(scripts[0], /frontmost of process "loginwindow"/);
  assert.match(scripts[0], /menu bar item "播放控制"/);
  assert.doesNotMatch(scripts[0], /Google Chrome|javascript|https:\/\//);
  assert.match(scripts[1], /process "NeteaseMusic"/);
  assert.match(scripts[1], /menu bar item "控制"/);
  assert.match(scripts[1], /errorNumber is -1719/);
  assert.match(scripts[2], /menu item "下一首"/);
  assert.match(scripts[3], /menu item "下一个"/);
});

test("duck uses three app-volume steps and only its lease can restore", async () => {
  const scripts: string[] = [];
  const outputs = ["OK|2", "OK|2"];
  const controller = new DesktopPlayerController(async (script) => {
    scripts.push(script);
    return outputs.shift() ?? "FAILED";
  });

  const ducked = await controller.duck("netease_music", "host-1");
  assert.equal(ducked.state, "ducked");
  assert.equal(ducked.controlledElements, 2);
  assert.match(scripts[0], /repeat 3 times/);
  assert.match(scripts[0], /menu item "降低音量"/);

  const replayed = await controller.duck("netease_music", "host-1");
  assert.equal(replayed.replayed, true);
  assert.equal(scripts.length, 1);

  assert.equal((await controller.duck("netease_music", "host-2")).state, "busy");
  assert.equal((await controller.restore("netease_music", "host-2")).state, "stale_operation");
  assert.equal(scripts.length, 1);

  const restored = await controller.restore("netease_music", "host-1");
  assert.equal(restored.state, "restored");
  assert.match(scripts[1], /repeat 2 times/);
  assert.match(scripts[1], /menu item "升高音量"/);
});

test("restore without a matching active duck never raises app volume", async () => {
  let called = false;
  const controller = new DesktopPlayerController(async () => {
    called = true;
    return "OK|3";
  });

  assert.equal((await controller.restore("qq_music", "unknown")).state, "stale_operation");
  assert.equal(called, false);
});

test("malformed desktop automation responses fail closed", async () => {
  const outputs = ["OK|garbage", "OK|4", "OK|3|extra", "UNKNOWN"];
  const controller = new DesktopPlayerController(async () => outputs.shift() ?? "FAILED");

  assert.equal((await controller.duck("qq_music", "host-1")).state, "failed");
  assert.equal((await controller.duck("qq_music", "host-2")).state, "failed");
  assert.equal((await controller.duck("qq_music", "host-3")).state, "failed");
  const failed = await controller.inspect("qq_music");
  assert.equal(failed.state, "failed");
  assert.equal(failed.appRunning, null);
});

test("toggle and next are serialized and blocked during host ducking", async () => {
  const outputs = ["PLAYING", "NEXT_REQUESTED", "OK|3", "OK|3"];
  const controller = new DesktopPlayerController(async () => outputs.shift() ?? "FAILED");

  assert.equal((await controller.toggle("qq_music", "toggle-1")).state, "playing");
  assert.equal((await controller.next("qq_music", "next-1")).state, "next_requested");
  assert.equal((await controller.duck("qq_music", "host-1")).state, "ducked");
  assert.equal((await controller.next("qq_music", "next-2")).state, "busy");
  assert.equal((await controller.restore("qq_music", "host-1")).state, "restored");
});

test("emergency pause fences an in-flight next command with a final pause", async () => {
  const events: string[] = [];
  let releaseNext: (() => void) | undefined;
  const controller = new DesktopPlayerController(async (script) => {
    if (script.includes('return "NEXT_REQUESTED"')) {
      events.push("next-start");
      await new Promise<void>((resolve) => { releaseNext = resolve; });
      events.push("next-end");
      return "NEXT_REQUESTED";
    }
    events.push("pause");
    return "PAUSED";
  });

  const next = controller.next("qq_music", "deadline-next");
  await new Promise((resolve) => setImmediate(resolve));
  const emergency = controller.emergencyPause("qq_music", "deadline-stop");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["next-start", "pause"]);
  releaseNext?.();

  assert.equal((await next).state, "next_requested");
  assert.equal((await emergency).state, "paused");
  assert.deepEqual(events, ["next-start", "pause", "next-end", "pause"]);
});

test("toggle and next operation ids are idempotent and cannot cross actions", async () => {
  let calls = 0;
  const controller = new DesktopPlayerController(async () => {
    calls += 1;
    return calls === 1 ? "PLAYING" : "NEXT_REQUESTED";
  });

  const firstToggle = await controller.toggle("qq_music", "same-operation");
  const replayedToggle = await controller.toggle("qq_music", "same-operation");
  assert.equal(firstToggle.state, "playing");
  assert.equal(replayedToggle.replayed, true);
  assert.equal(calls, 1);

  assert.equal((await controller.next("qq_music", "same-operation")).state, "operation_reused");
  assert.equal(calls, 1);

  const firstNext = await controller.next("qq_music", "next-operation");
  const replayedNext = await controller.next("qq_music", "next-operation");
  assert.equal(firstNext.state, "next_requested");
  assert.equal(replayedNext.replayed, true);
  assert.equal(calls, 2);
});

test("partial restore retains only the remaining volume steps for retry", async () => {
  const scripts: string[] = [];
  const outputs = ["OK|3", "OK|1", "OK|2"];
  const controller = new DesktopPlayerController(async (script) => {
    scripts.push(script);
    return outputs.shift() ?? "FAILED";
  });

  assert.equal((await controller.duck("qq_music", "partial-host")).controlledElements, 3);
  const partial = await controller.restore("qq_music", "partial-host");
  assert.equal(partial.state, "restore_incomplete");
  assert.match(partial.detail, /仍有 2 档/);
  assert.match(scripts[1], /repeat 3 times/);

  const completed = await controller.restore("qq_music", "partial-host");
  assert.equal(completed.state, "restored");
  assert.match(scripts[2], /repeat 2 times/);
});

test("a new controller recovers a persisted duck lease after service restart", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "one-radio-lease-test-"));
  const leasePath = join(directory, "leases.json");
  context.after(() => rmSync(directory, { recursive: true, force: true }));

  const first = new DesktopPlayerController(async () => "OK|2", leasePath);
  assert.equal((await first.duck("netease_music", "persisted-host")).state, "ducked");
  assert.equal(existsSync(leasePath), true);

  let recoveryCalls = 0;
  new DesktopPlayerController(async () => {
    recoveryCalls += 1;
    return "OK|2";
  }, leasePath);
  for (let attempt = 0; attempt < 10 && recoveryCalls === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(recoveryCalls, 1);
  assert.equal(existsSync(leasePath), false);
});

test("controller handoff serializes an in-flight duck and rolls it back before the new owner runs", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "one-radio-handoff-test-"));
  const leasePath = join(directory, "leases.json");
  context.after(() => rmSync(directory, { recursive: true, force: true }));

  let release: (() => void) | undefined;
  let firstCalls = 0;
  const first = new DesktopPlayerController(async () => {
    firstCalls += 1;
    if (firstCalls === 1) await new Promise<void>((resolve) => { release = resolve; });
    return "OK|2";
  }, leasePath);
  const firstDuck = first.duck("qq_music", "old-owner");
  await new Promise((resolve) => setImmediate(resolve));

  let secondCalls = 0;
  const second = new DesktopPlayerController(async () => {
    secondCalls += 1;
    return "OK|2";
  }, leasePath);
  const secondDuck = second.duck("qq_music", "new-owner");
  release?.();

  assert.equal((await firstDuck).state, "failed");
  assert.equal((await secondDuck).state, "ducked");
  assert.equal(firstCalls, 2);
  assert.equal(secondCalls, 1);
  assert.equal((await second.restore("qq_music", "new-owner")).state, "restored");
});

test("a live foreign process lease is not recovered or overwritten", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "one-radio-foreign-lease-test-"));
  const leasePath = join(directory, "leases.json");
  const owner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"]);
  context.after(() => {
    owner.kill();
    rmSync(directory, { recursive: true, force: true });
  });
  assert.equal(typeof owner.pid, "number");
  writeFileSync(leasePath, JSON.stringify({
    version: 1,
    ownerPid: owner.pid,
    leases: [{ sourceId: "netease_music", operationId: "foreign-host", steps: 2 }],
  }));

  let calls = 0;
  const controller = new DesktopPlayerController(async () => {
    calls += 1;
    return "OK|2";
  }, leasePath);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls, 0);
  assert.equal((await controller.duck("netease_music", "local-host")).state, "busy");
  assert.equal(calls, 0);
  assert.equal(existsSync(leasePath), true);
});

test("restore does not report success when its lease record cannot be removed", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "one-radio-persist-failure-test-"));
  const leasePath = join(directory, "leases.json");
  context.after(() => {
    chmodSync(directory, 0o700);
    rmSync(directory, { recursive: true, force: true });
  });

  const scripts: string[] = [];
  const controller = new DesktopPlayerController(async (script) => {
    scripts.push(script);
    return "OK|2";
  }, leasePath);
  assert.equal((await controller.duck("qq_music", "persist-failure")).state, "ducked");
  chmodSync(directory, 0o500);

  const restored = await controller.restore("qq_music", "persist-failure");
  assert.equal(restored.state, "failed");
  assert.match(restored.detail, /已撤销本次恢复/);
  assert.match(scripts.at(-1) ?? "", /repeat 2 times/);
  assert.equal(existsSync(leasePath), true);
});

test("concurrent diagnostics share one desktop automation request", async () => {
  let release: (() => void) | undefined;
  let calls = 0;
  const controller = new DesktopPlayerController(async () => {
    calls += 1;
    await new Promise<void>((resolve) => { release = resolve; });
    return "READY";
  });

  const first = controller.inspect("netease_music");
  const second = controller.inspect("netease_music");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release?.();

  assert.equal((await first).state, "ready");
  assert.equal((await second).state, "ready");
  assert.equal(calls, 1);
});
