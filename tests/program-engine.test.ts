import test from "node:test";
import assert from "node:assert/strict";

import {
  CONTROL_LOST_AFTER_MS,
  MAX_PROGRAM_MINUTES,
  MIN_PROGRAM_MINUTES,
  ProgramEngine,
  ProgramEngineError,
} from "../src/core/program-engine.js";

const BASE_TIME = Date.parse("2026-01-02T03:04:05.000Z");

function spec(overrides: Record<string, unknown> = {}) {
  return {
    sourceId: "fixture" as const,
    durationMinutes: 30,
    scenePreset: "study" as const,
    ...overrides,
  };
}

function segment(text: string) {
  return {
    id: `host-${text}`,
    text,
    factIds: [],
    instruction: "test instruction",
    generatedAt: new Date(BASE_TIME).toISOString(),
    status: "generated" as const,
  };
}

test("program creation accepts only integral durations from 30 through 120 minutes", () => {
  for (const duration of [MIN_PROGRAM_MINUTES, 45, 60, MAX_PROGRAM_MINUTES]) {
    const engine = new ProgramEngine({ now: () => BASE_TIME });
    const created = engine.create(spec({ durationMinutes: duration }));
    assert.equal(created.status, "awaiting_confirmation");
    assert.equal(created.spec.durationMinutes, duration);
    assert.equal(created.remainingSeconds, duration * 60);
  }

  const invalidDurations: unknown[] = [0, -1, 15, 29, 121, 30.5, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, Number.MAX_VALUE];
  for (const duration of invalidDurations) {
    const engine = new ProgramEngine({ now: () => BASE_TIME });
    assert.throws(
      () => engine.create(spec({ durationMinutes: duration })),
      (error: unknown) => error instanceof ProgramEngineError && error.code === "invalid_duration",
      `duration ${String(duration)} should be rejected`,
    );
    assert.equal(engine.getState(), null);
  }
});

test("reset removes the entire local program session", () => {
  const engine = new ProgramEngine({ now: () => BASE_TIME });
  const created = engine.create(spec());
  assert.equal(engine.getState()?.id, created.id);
  engine.reset();
  assert.equal(engine.getState(), null);
  const next = engine.create(spec({ scenePreset: "commute" }));
  assert.equal(next.status, "awaiting_confirmation");
});

test("unknown scenes are rejected and an empty optional description uses the scene default", () => {
  const unknownScene = new ProgramEngine();
  assert.throws(
    () => unknownScene.create(spec({ scenePreset: "unknown" })),
    (error: unknown) => error instanceof ProgramEngineError && error.code === "invalid_scene",
  );
  assert.equal(unknownScene.getState(), null);

  for (const sceneDescription of ["", "   "]) {
    const engine = new ProgramEngine();
    const created = engine.create(spec({ sceneDescription }));
    assert.ok(created.spec.sceneDescription.trim().length > 0);
  }
});

test("confirmation freezes the scene and records an absolute deadline", () => {
  const input = spec({ durationMinutes: 30, scenePreset: "commute" });
  const engine = new ProgramEngine({ now: () => BASE_TIME });
  const created = engine.create(input);

  (input as { scenePreset: string }).scenePreset = "party";
  const externallyMutatedSnapshot = created;
  externallyMutatedSnapshot.spec.scenePreset = "party";
  assert.equal(engine.getState()?.spec.scenePreset, "commute");

  const confirmed = engine.confirm({ programId: created.id, nowMs: BASE_TIME });
  assert.equal(confirmed.status, "on_air");
  assert.equal(confirmed.startedAt, new Date(BASE_TIME).toISOString());
  assert.equal(confirmed.deadlineAt, new Date(BASE_TIME + 30 * 60 * 1000).toISOString());
  assert.equal(confirmed.spec.scenePreset, "commute");
  assert.ok(confirmed.currentTrack);
  assert.ok(confirmed.nextTrack);
  assert.equal(confirmed.generation, 1);
});

test("desktop programs do not invent song transitions from fixture timing", () => {
  let now = BASE_TIME;
  const engine = new ProgramEngine({ now: () => now, controlLostAfterMs: 2_000_000 });
  const created = engine.create(spec({ sourceId: "netease_music", durationMinutes: 30 }));
  const confirmed = engine.confirm({ programId: created.id, nowMs: now });
  assert.equal(confirmed.currentTrack, null);
  assert.equal(confirmed.nextTrack, null);
  assert.deepEqual(confirmed.queue, []);

  now += 10 * 60 * 1000;
  const ticked = engine.tick(now);
  assert.equal(ticked?.status, "on_air");
  assert.equal(ticked?.currentTrack, null);

  const skipped = engine.next({
    programId: created.id,
    operationId: "desktop-manual-next",
    generation: ticked?.generation,
    nowMs: now,
  });
  assert.equal(skipped.currentTrack, null);
  assert.equal(skipped.generation, (ticked?.generation ?? 0) + 1);
});

test("account programs finish the current song after the requested duration", () => {
  const engine = new ProgramEngine({ now: () => BASE_TIME, controlLostAfterMs: 2_000_000 });
  const created = engine.create(spec({ sourceId: "netease_music", durationMinutes: 30 }));
  const confirmed = engine.confirm({ programId: created.id, nowMs: BASE_TIME });
  const deadline = Date.parse(confirmed.deadlineAt as string);
  engine.heartbeat({ programId: created.id, generation: confirmed.generation, nowMs: deadline - 1 });

  const atDuration = engine.tick(deadline);
  assert.equal(atDuration?.status, "on_air");
  assert.equal(atDuration?.remainingSeconds, 0);

  const afterCurrentSong = engine.next({ programId: created.id, generation: confirmed.generation, operationId: "finish-current-after-duration", nowMs: deadline + 1 });
  assert.equal(afterCurrentSong.status, "completed");
  assert.equal(afterCurrentSong.currentTrack, null);
});

test("repeating next and stop with the same operationId is idempotent", () => {
  const engine = new ProgramEngine({ now: () => BASE_TIME });
  const created = engine.create(spec());
  const confirmed = engine.confirm({ programId: created.id, nowMs: BASE_TIME });
  const originalTrackId = confirmed.currentTrack?.id;

  const nextCommand = {
    programId: created.id,
    operationId: "next-once",
    generation: confirmed.generation,
    nowMs: BASE_TIME + 1_000,
  };
  const afterNext = engine.next(nextCommand);
  assert.equal(afterNext.status, "on_air");
  assert.equal(afterNext.generation, confirmed.generation + 1);
  assert.notEqual(afterNext.currentTrack?.id, originalTrackId);

  const repeatedNext = engine.next({ ...nextCommand, nowMs: BASE_TIME + 2_000 });
  assert.deepEqual(repeatedNext, afterNext);

  const stopCommand = {
    programId: created.id,
    operationId: "stop-once",
    generation: afterNext.generation,
    nowMs: BASE_TIME + 3_000,
  };
  const stopped = engine.stop(stopCommand);
  assert.equal(stopped.status, "stopped");
  const repeatedStop = engine.stop({ ...stopCommand, nowMs: BASE_TIME + 4_000 });
  assert.deepEqual(repeatedStop, stopped);

  const secondStopOperation = engine.stop({
    programId: created.id,
    operationId: "stop-again",
    generation: stopped.generation,
    nowMs: BASE_TIME + 5_000,
  });
  assert.deepEqual(secondStopOperation, stopped);
});

test("deadline and stop have one terminal outcome regardless of the first command", () => {
  const first = new ProgramEngine({ now: () => BASE_TIME, controlLostAfterMs: 2_000_000 });
  const createdFirst = first.create(spec({ durationMinutes: 30 }));
  const confirmedFirst = first.confirm({ programId: createdFirst.id, nowMs: BASE_TIME });
  const deadline = Date.parse(confirmedFirst.deadlineAt as string);
  const deadlineFirst = first.next({
    programId: createdFirst.id,
    generation: confirmedFirst.generation,
    operationId: "deadline-next",
    nowMs: deadline,
  });
  assert.equal(deadlineFirst.status, "completed");
  assert.equal(deadlineFirst.remainingSeconds, 0);
  assert.equal(deadlineFirst.nextTrack, null);
  assert.deepEqual(first.stop({ programId: createdFirst.id, operationId: "after-deadline", nowMs: deadline }), deadlineFirst);

  const second = new ProgramEngine({ now: () => BASE_TIME });
  const createdSecond = second.create(spec({ durationMinutes: 30 }));
  const confirmedSecond = second.confirm({ programId: createdSecond.id, nowMs: BASE_TIME });
  const stopFirst = second.stop({
    programId: createdSecond.id,
    generation: confirmedSecond.generation,
    operationId: "stop-before-deadline",
    nowMs: Date.parse(confirmedSecond.deadlineAt as string),
  });
  assert.equal(stopFirst.status, "stopped");
  assert.deepEqual(second.tick(Date.parse(confirmedSecond.deadlineAt as string)), stopFirst);
  assert.deepEqual(
    second.next({ programId: createdSecond.id, generation: confirmedSecond.generation, nowMs: BASE_TIME + 1_000 }),
    stopFirst,
  );
});

test("missing heartbeats after six seconds enter control_lost and prevent resumption", () => {
  const engine = new ProgramEngine({ now: () => BASE_TIME });
  const created = engine.create(spec({ durationMinutes: 30 }));
  const confirmed = engine.confirm({ programId: created.id, nowMs: BASE_TIME });

  const atBoundary = engine.tick(BASE_TIME + CONTROL_LOST_AFTER_MS);
  assert.equal(atBoundary?.status, "on_air");

  const lost = engine.tick(BASE_TIME + CONTROL_LOST_AFTER_MS + 1);
  assert.equal(lost?.status, "control_lost");
  assert.equal(lost?.error, "Control lease expired after six seconds without a heartbeat.");
  assert.equal(lost?.nextTrack, null);
  assert.deepEqual(lost?.queue, []);
  assert.equal(lost?.generation, confirmed.generation + 1);

  const heartbeat = engine.heartbeat({
    programId: created.id,
    generation: lost?.generation as number,
    nowMs: BASE_TIME + CONTROL_LOST_AFTER_MS + 2,
  });
  assert.equal(heartbeat.status, "control_lost");
  assert.deepEqual(
    engine.next({ programId: created.id, generation: heartbeat.generation, nowMs: BASE_TIME + 10_000 }),
    heartbeat,
  );
});

test("host callbacks from an old generation cannot replace current or terminal host state", () => {
  const engine = new ProgramEngine({ now: () => BASE_TIME });
  const created = engine.create(spec());
  const confirmed = engine.confirm({ programId: created.id, nowMs: BASE_TIME });

  const firstHost = engine.applyHostSegment({ generation: confirmed.generation, segment: segment("first generation") });
  assert.equal(firstHost.host?.text, "first generation");

  const afterNext = engine.next({
    programId: created.id,
    generation: confirmed.generation,
    nowMs: BASE_TIME + 1_000,
  });
  assert.equal(afterNext.generation, confirmed.generation + 1);

  const stale = engine.applyHostSegment({ generation: confirmed.generation, segment: segment("late old generation") });
  assert.equal(stale.host, null);
  assert.equal(stale.recentHostLines.includes("late old generation"), false);

  const current = engine.applyHostSegment({ generation: afterNext.generation, segment: segment("current generation") });
  assert.equal(current.host?.text, "current generation");

  const stopped = engine.stop({ programId: created.id, generation: afterNext.generation, nowMs: BASE_TIME + 2_000 });
  const lateAfterStop = engine.applyHostSegment({ generation: afterNext.generation, segment: segment("late after stop") });
  assert.equal(lateAfterStop.status, "stopped");
  assert.equal(lateAfterStop.host?.text, stopped.host?.text);
  assert.equal(lateAfterStop.recentHostLines.includes("late after stop"), false);
});

test("a 120-minute fixture plan does not repeat tracks before the strict closing window", () => {
  const engine = new ProgramEngine({ now: () => BASE_TIME, controlLostAfterMs: 24 * 60 * 60 * 1000 });
  const created = engine.create(spec({ durationMinutes: 120 }));
  let state = engine.confirm({ programId: created.id, nowMs: BASE_TIME });
  const played: string[] = [];
  let now = BASE_TIME;

  while (state.status === "on_air" && state.currentTrack) {
    played.push(state.currentTrack.id);
    now += state.currentTrack.durationSeconds * 1000;
    state = engine.tick(now) as typeof state;
  }

  assert.equal(new Set(played).size, played.length);
  assert.ok(played.length > 16);
  assert.equal(state.status, "closing");
  assert.ok(state.remainingSeconds < 6 * 60);
});

test("confirmation fails explicitly when every fixture candidate is excluded", () => {
  const engine = new ProgramEngine({
    now: () => BASE_TIME,
    tracks: [{ id: "only", title: "Only", artist: "Fixture", durationSeconds: 180, energy: 0.5, mood: ["blocked"], color: "#000000" }],
  });
  const created = engine.create(spec({ avoid: ["blocked"] }));
  const confirmed = engine.confirm({ programId: created.id, nowMs: BASE_TIME });

  assert.equal(confirmed.status, "failed");
  assert.equal(confirmed.currentTrack, null);
  assert.match(confirmed.error ?? "", /No fixture track/);
});

test("operation ids cannot be reused across actions and clock rollback cannot extend a program", () => {
  const engine = new ProgramEngine({ now: () => BASE_TIME });
  const created = engine.create(spec({ durationMinutes: 30 }));
  const confirmed = engine.confirm({ programId: created.id, nowMs: BASE_TIME });
  const afterNext = engine.next({ programId: created.id, generation: confirmed.generation, operationId: "shared", nowMs: BASE_TIME + 1_000 });

  assert.throws(
    () => engine.stop({ programId: created.id, generation: afterNext.generation, operationId: "shared", nowMs: BASE_TIME + 2_000 }),
    (error: unknown) => error instanceof ProgramEngineError && error.code === "operation_reused",
  );

  const beforeRollback = engine.tick(BASE_TIME + 3_000);
  const afterRollback = engine.tick(BASE_TIME - 30_000);
  assert.equal(afterRollback?.remainingSeconds, beforeRollback?.remainingSeconds);
});
