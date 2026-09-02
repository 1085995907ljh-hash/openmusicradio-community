import test from "node:test";
import assert from "node:assert/strict";

import { ProgramEngine } from "../src/core/program-engine.js";
import { createLocalService } from "../src/server/index.js";
import type { DesktopPetControllerLike, DesktopPetState } from "../src/server/desktop-pet.js";

test("program lifecycle launches and securely updates the native desktop companion", async (context) => {
  const states: DesktopPetState[] = [];
  let stopped = false;
  const desktopPetController: DesktopPetControllerLike = {
    update(state) { states.push(state); },
    hide() {},
    stop() { stopped = true; },
  };
  const engine = new ProgramEngine({ idFactory: () => "desktop-pet-program" });
  const service = await createLocalService({ port: 0, engine, desktopPetController, localControlToken: "desktop-pet-token" });
  await service.start();
  context.after(() => service.stop());
  const base = `http://127.0.0.1:${service.port}/api`;
  const clientStartedAt = Date.now();
  const spec = {
    sourceId: "fixture",
    durationMinutes: 30,
    scenePreset: "study",
    sceneDescription: "",
    hostDensity: "low",
    energyCurve: "steady",
    avoid: [],
    hostProfile: "anya",
    desktopPetEnabled: true,
  };

  const createdResponse = await fetch(`${base}/programs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spec, operationId: "pet-create" }),
  });
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json() as { program: { id: string; generation: number } }).program;
  assert.equal(states.length, 1, "entering plan confirmation launches the desktop companion");
  assert.equal(states.at(-1)?.mood, "preparing");
  assert.equal(states.at(-1)?.message, "");

  const unauthorized = await fetch(`${base}/desktop-pet/state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ programId: created.id, generation: created.generation, mood: "preparing", revision: 1, clientId: "client-old", clientStartedAt }),
  });
  assert.equal(unauthorized.status, 401);

  const invalidDraftMood = await fetch(`${base}/desktop-pet/state`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-one-radio-control-token": "desktop-pet-token" },
    body: JSON.stringify({ programId: created.id, generation: created.generation, mood: "speaking", revision: 2, clientId: "client-old", clientStartedAt }),
  });
  assert.equal(invalidDraftMood.status, 409);

  const invalidDraftPreparing = await fetch(`${base}/desktop-pet/state`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-one-radio-control-token": "desktop-pet-token" },
    body: JSON.stringify({ programId: created.id, generation: created.generation, mood: "preparing", revision: 3, clientId: "client-old", clientStartedAt }),
  });
  assert.equal(invalidDraftPreparing.status, 409);

  const confirmedResponse = await fetch(`${base}/programs/${created.id}/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ generation: created.generation, operationId: "pet-confirm" }),
  });
  assert.equal(confirmedResponse.status, 200);
  const confirmed = (await confirmedResponse.json() as { program: { generation: number; currentTrack: { id: string } } }).program;
  assert.equal(states.length, 2, "confirming the program advances the existing desktop companion");
  assert.equal(states.at(-1)?.profileId, "anya");

  const listening = await fetch(`${base}/desktop-pet/state`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-one-radio-control-token": "desktop-pet-token" },
    body: JSON.stringify({ programId: created.id, generation: confirmed.generation, trackId: confirmed.currentTrack.id, mood: "listening", revision: 3, clientId: "client-old", clientStartedAt }),
  });
  assert.equal(listening.status, 200);
  assert.equal(states.at(-1)?.mood, "listening");
  assert.equal(states.at(-1)?.message, "");

  const stale = await fetch(`${base}/desktop-pet/state`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-one-radio-control-token": "desktop-pet-token" },
    body: JSON.stringify({ programId: created.id, generation: confirmed.generation, trackId: confirmed.currentTrack.id, mood: "paused", revision: 2, clientId: "client-old", clientStartedAt }),
  });
  assert.equal(stale.status, 200);
  assert.equal(states.at(-1)?.mood, "listening", "an older browser state must not overwrite the latest mood");

  const refreshedPausedClient = await fetch(`${base}/desktop-pet/state`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-one-radio-control-token": "desktop-pet-token" },
    body: JSON.stringify({ programId: created.id, generation: confirmed.generation, trackId: confirmed.currentTrack.id, mood: "paused", revision: 1, clientId: "client-new", clientStartedAt: clientStartedAt + 1 }),
  });
  assert.equal(refreshedPausedClient.status, 200);
  assert.equal(states.at(-1)?.mood, "listening", "a new idle tab must not steal a fresh playback lease");

  const statesBeforeCompetingPlayback = states.length;
  const refreshedPlayingClient = await fetch(`${base}/desktop-pet/state`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-one-radio-control-token": "desktop-pet-token" },
    body: JSON.stringify({ programId: created.id, generation: confirmed.generation, trackId: confirmed.currentTrack.id, mood: "listening", revision: 2, clientId: "client-new", clientStartedAt: clientStartedAt + 1 }),
  });
  assert.equal(refreshedPlayingClient.status, 200);
  assert.equal(states.length, statesBeforeCompetingPlayback, "a different session must wait for the active playback lease to expire");

  const ownerPaused = await fetch(`${base}/desktop-pet/state`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-one-radio-control-token": "desktop-pet-token" },
    body: JSON.stringify({ programId: created.id, generation: confirmed.generation, trackId: confirmed.currentTrack.id, mood: "paused", revision: 4, clientId: "client-old", clientStartedAt }),
  });
  assert.equal(ownerPaused.status, 200);
  assert.equal(states.at(-1)?.mood, "paused");

  const idleHeartbeat = await fetch(`${base}/desktop-pet/state`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-one-radio-control-token": "desktop-pet-token" },
    body: JSON.stringify({ programId: created.id, generation: confirmed.generation, trackId: confirmed.currentTrack.id, mood: "paused", revision: 3, clientId: "client-new", clientStartedAt: clientStartedAt + 1 }),
  });
  assert.equal(idleHeartbeat.status, 200);
  assert.equal(states.at(-1)?.mood, "paused", "the owner keeps its lease while paused and still heartbeating");

  const ownerResumed = await fetch(`${base}/desktop-pet/state`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-one-radio-control-token": "desktop-pet-token" },
    body: JSON.stringify({ programId: created.id, generation: confirmed.generation, trackId: confirmed.currentTrack.id, mood: "listening", revision: 5, clientId: "client-old", clientStartedAt }),
  });
  assert.equal(ownerResumed.status, 200);
  assert.equal(states.at(-1)?.mood, "listening", "the playback owner can resume after a pause");

  const ownerPausedAgain = await fetch(`${base}/desktop-pet/state`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-one-radio-control-token": "desktop-pet-token" },
    body: JSON.stringify({ programId: created.id, generation: confirmed.generation, trackId: confirmed.currentTrack.id, mood: "paused", revision: 6, clientId: "client-old", clientStartedAt }),
  });
  assert.equal(ownerPausedAgain.status, 200);
  const beforeActiveTakeover = states.length;

  const activeTakeover = await fetch(`${base}/desktop-pet/state`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-one-radio-control-token": "desktop-pet-token" },
    body: JSON.stringify({ programId: created.id, generation: confirmed.generation, trackId: confirmed.currentTrack.id, mood: "speaking", revision: 4, clientId: "client-new", clientStartedAt: clientStartedAt + 1 }),
  });
  assert.equal(activeTakeover.status, 200);
  assert.equal(states.length, beforeActiveTakeover + 1, "real playback may take over from a paused owner");
  assert.equal(states.at(-1)?.mood, "speaking");

  await service.stop();
  assert.equal(stopped, true);
});

test("an opted-out program never launches the desktop companion", async (context) => {
  const states: DesktopPetState[] = [];
  let hidden = 0;
  const desktopPetController: DesktopPetControllerLike = {
    update(state) { states.push(state); },
    hide() { hidden += 1; },
    stop() {},
  };
  const engine = new ProgramEngine({ idFactory: () => "desktop-pet-opt-out" });
  const service = await createLocalService({ port: 0, engine, desktopPetController });
  await service.start();
  context.after(() => service.stop());
  const base = `http://127.0.0.1:${service.port}/api`;
  const spec = {
    sourceId: "fixture",
    durationMinutes: 30,
    scenePreset: "study",
    sceneDescription: "",
    hostDensity: "low",
    energyCurve: "steady",
    avoid: [],
    hostProfile: "anya",
    desktopPetEnabled: false,
  };
  const createdResponse = await fetch(`${base}/programs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spec, operationId: "pet-opt-out-create" }),
  });
  const created = (await createdResponse.json() as { program: { id: string; generation: number } }).program;
  const confirmedResponse = await fetch(`${base}/programs/${created.id}/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ generation: created.generation, operationId: "pet-opt-out-confirm" }),
  });
  assert.equal(confirmedResponse.status, 200);
  assert.equal(states.length, 0);
  assert.equal(hidden, 1);
});
