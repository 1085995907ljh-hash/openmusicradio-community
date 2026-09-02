import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DesktopPetController, desktopPetStateForProgram } from "../src/server/desktop-pet.js";
import type { ProgramState } from "../src/shared/contracts.js";

class FakePetProcess extends EventEmitter {
  kills: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.kills.push(signal);
    return true;
  }
}

function program(id: string, status: ProgramState["status"] = "awaiting_confirmation"): ProgramState {
  return {
    id,
    generation: 1,
    status,
    spec: {
      sourceId: "qq_music",
      durationMinutes: 30,
      scenePreset: "late_night",
      sceneDescription: "",
      hostDensity: "medium",
      energyCurve: "low",
      avoid: [],
      hostProfile: "anya",
    },
    startedAt: null,
    deadlineAt: null,
    remainingSeconds: 1_800,
    currentTrack: null,
    nextTrack: null,
    queue: [],
    host: null,
    recentHostLines: [],
    error: null,
  };
}

test("desktop pet derives bounded user-visible state from the program", () => {
  const preparing = desktopPetStateForProgram(program("program-a"));
  assert.equal(preparing.profileId, "anya");
  assert.equal(preparing.mood, "preparing");
  assert.equal(preparing.message, "");

  const listening = desktopPetStateForProgram(program("program-a", "on_air"), "listening", "不应显示的状态文字");
  assert.equal(listening.message, "");

  const speaking = desktopPetStateForProgram(program("program-a", "on_air"), "speaking", "正在口播", 0, 8);
  assert.equal(speaking.message, "正在口播");
  assert.equal(speaking.speechDurationSeconds, 8);

  const failed = desktopPetStateForProgram(program("program-a", "failed"));
  assert.equal(failed.mood, "error");
});

test("desktop pet launches once, respects manual exit for the same program, and returns for a new program", () => {
  const directory = mkdtempSync(join(tmpdir(), "one-radio-pet-"));
  const statePath = join(directory, "state.json");
  const children: FakePetProcess[] = [];
  const launches: string[][] = [];
  const controller = new DesktopPetController({
    enabled: true,
    binaryPath: join(directory, "OneRadioPet"),
    assetsPath: join(directory, "hosts"),
    statePath,
    spawnProcess: (_binary, args) => {
      launches.push(args);
      const child = new FakePetProcess();
      children.push(child);
      return child;
    },
  });

  try {
    const first = desktopPetStateForProgram(program("program-a"), undefined, undefined, 1);
    controller.update(first);
    controller.update({ ...first, mood: "listening", revision: 2, updatedAt: new Date().toISOString() });
    assert.equal(launches.length, 1);
    assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")).mood, "listening");
    assert.equal(launches[0]?.slice(0, 4).join("|"), ["--state-file", statePath, "--assets-dir", join(directory, "hosts")].join("|"));
    assert.equal(launches[0]?.[4], "--instance-id");
    assert.equal(typeof launches[0]?.[5], "string");

    children[0]!.emit("exit", 0, null);
    controller.update({ ...first, mood: "paused", revision: 3, updatedAt: new Date().toISOString() });
    assert.equal(launches.length, 1, "manual exit must suppress relaunch for the same program");

    controller.update(desktopPetStateForProgram(program("program-b"), undefined, undefined, 4));
    assert.equal(launches.length, 2, "a new program may launch the companion again");
    controller.stop();
    assert.deepEqual(children[1]!.kills, ["SIGTERM"]);
    assert.equal(existsSync(statePath), false);
    controller.update({ ...desktopPetStateForProgram(program("program-c")), revision: 99 });
    assert.equal(launches.length, 2, "updates after stop must not relaunch the companion");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a new program owns a fresh pet process so its close action is not attributed to the old program", () => {
  const directory = mkdtempSync(join(tmpdir(), "one-radio-pet-race-"));
  const children: FakePetProcess[] = [];
  const controller = new DesktopPetController({
    enabled: true,
    binaryPath: join(directory, "OneRadioPet"),
    assetsPath: join(directory, "hosts"),
    statePath: join(directory, "state.json"),
    spawnProcess: () => {
      const child = new FakePetProcess();
      children.push(child);
      return child;
    },
  });
  try {
    controller.update(desktopPetStateForProgram(program("program-a"), undefined, undefined, 1));
    controller.update(desktopPetStateForProgram(program("program-b"), undefined, undefined, 2));
    assert.equal(children.length, 2, "the new program must own a newly bound process");
    assert.deepEqual(children[0]!.kills, ["SIGTERM"]);
    children[0]!.emit("exit", 0, null);
    assert.equal(children.length, 2, "the stale child exit must not affect the new process");
    children[1]!.emit("exit", 0, null);
    controller.update(desktopPetStateForProgram(program("program-b"), "listening", undefined, 3));
    assert.equal(children.length, 2, "manual close must suppress relaunch for the displayed program");
  } finally {
    controller.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("desktop pet can be hidden without permanently closing future programs", () => {
  const directory = mkdtempSync(join(tmpdir(), "one-radio-pet-hide-"));
  const children: FakePetProcess[] = [];
  const statePath = join(directory, "state.json");
  const controller = new DesktopPetController({
    enabled: true,
    binaryPath: join(directory, "OneRadioPet"),
    assetsPath: join(directory, "hosts"),
    statePath,
    spawnProcess: () => {
      const child = new FakePetProcess();
      children.push(child);
      return child;
    },
  });
  try {
    controller.update(desktopPetStateForProgram(program("program-a"), undefined, undefined, 1));
    controller.hide();
    assert.deepEqual(children[0]?.kills, ["SIGTERM"]);
    assert.equal(existsSync(statePath), false);
    controller.update(desktopPetStateForProgram(program("program-b"), undefined, undefined, 2));
    assert.equal(children.length, 2, "a later opted-in program may relaunch the companion");
  } finally {
    controller.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
