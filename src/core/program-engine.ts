import type {
  CreateProgramRequest,
  HostSegment,
  ProgramSpec,
  ProgramState,
  ProgramStatus,
  Track,
} from "../shared/contracts";
import {
  buildProgramPlan,
  buildProgramSpec,
  phaseForElapsedSeconds,
  SCENE_CONFIGS,
  type ProgramSpecInput,
} from "./scenes";
import {
  buildDeterministicQueue,
  chooseNextTrack,
  type QueueDecision,
} from "./queue";
import { cloneTrack, cloneTracks, FIXTURE_TRACKS } from "./fixtures";
import {
  buildHostContextPack,
  type ExtendedHostContextPack,
} from "./host-context";

export const HEARTBEAT_INTERVAL_MS = 2_000;
export const CONTROL_LOST_AFTER_MS = 6_000;
export const MIN_PROGRAM_MINUTES = 30;
export const MAX_PROGRAM_MINUTES = 120;

export interface ProgramEngineClock {
  now(): number | Date;
}

export type ClockValue = number | Date;

export interface ProgramEngineOptions {
  now?: () => number | Date;
  clock?: ProgramEngineClock | (() => number | Date);
  idFactory?: () => string;
  tracks?: readonly Track[];
  heartbeatIntervalMs?: number;
  controlLostAfterMs?: number;
  closingBufferSeconds?: number;
}

export interface CreateProgramCommand {
  spec: ProgramSpec | ProgramSpecInput;
  operationId?: string;
}

export interface ConfirmProgramCommand {
  programId?: string;
  operationId?: string;
  nowMs?: ClockValue;
}

export interface HeartbeatCommand {
  programId?: string;
  generation: number;
  operationId?: string;
  nowMs?: ClockValue;
}

export interface ProgramOperationCommand {
  programId?: string;
  operationId?: string;
  generation?: number;
  nowMs?: ClockValue;
}

export interface HostSegmentCallback {
  generation: number;
  segment: HostSegment;
  operationId?: string;
}

export type ProgramEngineErrorCode =
  | "invalid_spec"
  | "invalid_duration"
  | "invalid_scene"
  | "invalid_source"
  | "program_exists"
  | "program_not_found"
  | "invalid_state"
  | "operation_reused"
  | "stale_generation";

type OperationScope = "confirm" | "heartbeat" | "next" | "stop" | "host";

export class ProgramEngineError extends Error {
  readonly code: ProgramEngineErrorCode;

  constructor(code: ProgramEngineErrorCode, message: string) {
    super(message);
    this.name = "ProgramEngineError";
    this.code = code;
  }
}

export class ProgramEngine {
  readonly heartbeatIntervalMs: number;
  readonly controlLostAfterMs: number;

  private readonly nowProvider: () => number;
  private readonly idFactory: () => string;
  private readonly tracks: readonly Track[];
  private readonly closingBufferSeconds: number;
  private state: ProgramState | null = null;
  private currentTrackEndsAtMs: number | null = null;
  private lastHeartbeatAtMs: number | null = null;
  private previousTrack: Track | null = null;
  private readonly playedTrackIds = new Set<string>();
  private readonly playedArtistNames = new Set<string>();
  private readonly operationResults = new Map<string, { scope: OperationScope | "create"; state: ProgramState }>();
  private lastObservedNowMs: number | null = null;
  constructor(options: ProgramEngineOptions = {}) {
    this.nowProvider = makeNowProvider(options);
    this.idFactory = options.idFactory ?? (() => `program-${globalThis.crypto.randomUUID()}`);
    this.tracks = cloneTracks(options.tracks ?? FIXTURE_TRACKS);
    this.heartbeatIntervalMs = positiveOrDefault(
      options.heartbeatIntervalMs,
      HEARTBEAT_INTERVAL_MS,
    );
    this.controlLostAfterMs = positiveOrDefault(
      options.controlLostAfterMs,
      CONTROL_LOST_AFTER_MS,
    );
    this.closingBufferSeconds = Math.max(0, options.closingBufferSeconds ?? 15);
  }

  /** Create a planned program. Confirmation is required before it can go on air. */
  create(
    input: ProgramSpec | ProgramSpecInput | CreateProgramRequest | CreateProgramCommand,
    operationId?: string,
  ): ProgramState {
    const command = normalizeCreateCommand(input, operationId);
    if (command.operationId) {
      const previous = this.operationResults.get(`create:${command.operationId}`);
      if (previous) return cloneProgramState(previous.state);
    }
    if (this.state && !isTerminal(this.state.status)) {
      throw new ProgramEngineError(
        "program_exists",
        "An active program already exists; stop it before creating another program.",
      );
    }

    const spec = normalizeAndValidateSpec(command.spec);
    const state: ProgramState = {
      id: this.idFactory(),
      generation: 1,
      status: "awaiting_confirmation",
      spec,
      startedAt: null,
      deadlineAt: null,
      remainingSeconds: spec.durationMinutes * 60,
      currentTrack: null,
      nextTrack: null,
      queue: [],
      host: null,
      recentHostLines: [],
      error: null,
    };
    this.resetRuntime(state);
    this.state = state;
    return this.rememberOperation(command.operationId, state, "create");
  }

  createProgram(
    input: ProgramSpec | ProgramSpecInput | CreateProgramRequest | CreateProgramCommand,
    operationId?: string,
  ): ProgramState {
    return this.create(input, operationId);
  }

  /** Confirm the immutable spec and begin the fixture-backed program. */
  confirm(
    programIdOrCommand?: string | ConfirmProgramCommand,
    operationId?: string,
  ): ProgramState {
    const command = normalizeProgramCommand(programIdOrCommand, operationId);
    const state = this.requireState(command.programId);
    if (command.operationId) {
      const previous = this.readOperation(command.operationId, state.id, "confirm");
      if (previous) return cloneProgramState(previous);
    }
    if (state.status !== "awaiting_confirmation" && state.status !== "draft") {
      return this.rememberOperation(command.operationId, state, "confirm");
    }

    const nowMs = this.readNow(command.nowMs);
    const durationSeconds = state.spec.durationMinutes * 60;
    const deadlineMs = nowMs + durationSeconds * 1000;
    const queue = buildDeterministicQueue(this.tracks, {
      durationSeconds,
      scenePreset: state.spec.scenePreset,
      avoidMoods: state.spec.avoid,
      closingBufferSeconds: this.closingBufferSeconds,
      maxTracks: this.tracks.length,
    });
    const fixtureBacked = state.spec.sourceId === "fixture";
    const currentTrack = fixtureBacked ? queue.shift() ?? null : null;
    const nextTrack = fixtureBacked ? queue.shift() ?? null : null;
    state.startedAt = timestamp(nowMs);
    state.deadlineAt = timestamp(deadlineMs);
    state.remainingSeconds = durationSeconds;
    state.status = currentTrack || !fixtureBacked ? "on_air" : "failed";
    state.currentTrack = currentTrack;
    state.nextTrack = nextTrack;
    state.queue = fixtureBacked ? queue : [];
    state.host = null;
    state.error = currentTrack || !fixtureBacked ? null : "No fixture track satisfies the confirmed program constraints.";
    this.currentTrackEndsAtMs = currentTrack
      ? nowMs + currentTrack.durationSeconds * 1000
      : null;
    this.lastHeartbeatAtMs = nowMs;
    this.previousTrack = null;
    this.playedTrackIds.clear();
    this.playedArtistNames.clear();
    if (currentTrack) this.markPlayed(currentTrack);
    return this.rememberOperation(command.operationId, state, "confirm");
  }

  getState(): ProgramState | null {
    return this.state ? cloneProgramState(this.state) : null;
  }

  getProgramPlan(): ReturnType<typeof buildProgramPlan> | null {
    return this.state ? buildProgramPlan(this.state.spec) : null;
  }

  getHostContextPack(): ExtendedHostContextPack | null {
    if (!this.state) return null;
    const elapsedSeconds = this.state.startedAt
      ? this.state.spec.durationMinutes * 60 - this.state.remainingSeconds
      : 0;
    return buildHostContextPack(this.state, {
      previousTrack: this.previousTrack,
      programPhase: phaseForElapsedSeconds(elapsedSeconds, this.state.spec.durationMinutes * 60),
    });
  }

  /** Advance the clock, enforce lease/deadline, and promote naturally-ended tracks. */
  tick(nowMs?: ClockValue): ProgramState | null {
    if (!this.state) return null;
    if (isTerminal(this.state.status)) return this.getState();
    const now = this.readNow(nowMs);
    if (this.state.status === "awaiting_confirmation" || this.state.status === "draft") {
      return this.getState();
    }

    if (this.lastHeartbeatAtMs !== null && now - this.lastHeartbeatAtMs > this.controlLostAfterMs) {
      this.enterControlLost(now);
      return this.getState();
    }
    const deadlineMs = this.state.deadlineAt ? Date.parse(this.state.deadlineAt) : null;
    if (deadlineMs !== null && now >= deadlineMs) {
      if (this.state.spec.sourceId === "fixture") this.completeAtDeadline(now);
      else this.state.remainingSeconds = 0;
      return this.getState();
    }
    if (deadlineMs !== null) {
      this.state.remainingSeconds = Math.max(0, Math.ceil((deadlineMs - now) / 1000));
    }

    while (
      this.state.spec.sourceId === "fixture" &&
      this.state.status === "on_air" &&
      this.currentTrackEndsAtMs !== null &&
      now >= this.currentTrackEndsAtMs
    ) {
      if (!this.promoteNextTrack(now, "natural track end")) break;
    }
    return this.getState();
  }

  heartbeat(
    programIdOrCommand: string | HeartbeatCommand | undefined,
    generation?: number,
    nowMs?: ClockValue,
  ): ProgramState {
    const command = normalizeHeartbeatCommand(programIdOrCommand, generation, nowMs);
    const state = this.requireState(command.programId);
    if (command.operationId) {
      const previous = this.readOperation(command.operationId, state.id, "heartbeat");
      if (previous) return cloneProgramState(previous);
    }
    if (isTerminal(state.status) || state.status === "awaiting_confirmation" || state.status === "draft") {
      return this.rememberOperation(command.operationId, state, "heartbeat");
    }
    if (command.generation !== state.generation) {
      return this.rememberOperation(command.operationId, state, "heartbeat");
    }
    const now = this.readNow(command.nowMs);
    if (this.lastHeartbeatAtMs !== null && now - this.lastHeartbeatAtMs > this.controlLostAfterMs) {
      this.enterControlLost(now);
      return this.rememberOperation(command.operationId, state, "heartbeat");
    }
    this.lastHeartbeatAtMs = now;
    return this.rememberOperation(command.operationId, state, "heartbeat");
  }

  next(
    programIdOrCommand?: string | ProgramOperationCommand,
    operationId?: string,
    generation?: number,
    nowMs?: ClockValue,
  ): ProgramState {
    const command = normalizeOperationCommand(programIdOrCommand, operationId, generation, nowMs);
    const state = this.requireState(command.programId);
    if (command.operationId) {
      const previous = this.readOperation(command.operationId, state.id, "next");
      if (previous) return cloneProgramState(previous);
    }
    const now = this.readNow(command.nowMs);
    if (isTerminal(state.status)) return this.rememberOperation(command.operationId, state, "next");
    if (command.generation !== undefined && command.generation !== state.generation) {
      throw new ProgramEngineError("stale_generation", "Program generation is stale.");
    }
    if (!this.beforeSideEffect(now)) return this.rememberOperation(command.operationId, state, "next");
    if (state.status !== "on_air") return this.rememberOperation(command.operationId, state, "next");
    if (state.spec.sourceId !== "fixture") {
      const deadlineMs = state.deadlineAt ? Date.parse(state.deadlineAt) : null;
      if (deadlineMs !== null && now >= deadlineMs) {
        this.completeAtDeadline(now);
        return this.rememberOperation(command.operationId, state, "next");
      }
      state.host = null;
      state.generation += 1;
      this.currentTrackEndsAtMs = null;
      return this.rememberOperation(command.operationId, state, "next");
    }
    this.promoteNextTrack(now, "manual next");
    return this.rememberOperation(command.operationId, state, "next");
  }

  stop(
    programIdOrCommand?: string | ProgramOperationCommand,
    operationId?: string,
    generation?: number,
    nowMs?: ClockValue,
  ): ProgramState {
    const command = normalizeOperationCommand(programIdOrCommand, operationId, generation, nowMs);
    const state = this.requireState(command.programId);
    if (command.operationId) {
      const previous = this.readOperation(command.operationId, state.id, "stop");
      if (previous) return cloneProgramState(previous);
    }
    if (isTerminal(state.status)) return this.rememberOperation(command.operationId, state, "stop");
    if (command.generation !== undefined && command.generation !== state.generation) {
      throw new ProgramEngineError("stale_generation", "Program generation is stale.");
    }
    state.status = "stopped";
    state.generation += 1;
    state.error = null;
    state.currentTrack = null;
    state.nextTrack = null;
    state.queue = [];
    state.host = null;
    this.currentTrackEndsAtMs = null;
    this.lastHeartbeatAtMs = null;
    return this.rememberOperation(command.operationId, state, "stop");
  }

  /** Apply an async host callback only if it belongs to the current generation. */
  applyHostSegment(
    callbackOrSegment: HostSegmentCallback | HostSegment,
    generation?: number,
    operationId?: string,
  ): ProgramState {
    const state = this.requireState();
    const callback = isHostCallback(callbackOrSegment)
      ? callbackOrSegment
      : { generation: generation ?? state.generation, segment: callbackOrSegment, operationId };
    if (callback.operationId) {
      const previous = this.readOperation(callback.operationId, state.id, "host");
      if (previous) return cloneProgramState(previous);
    }
    if (callback.generation !== state.generation || isTerminal(state.status)) {
      return this.rememberOperation(callback.operationId, state, "host");
    }
    state.host = cloneHostSegment(callback.segment);
    if (callback.segment.text.trim()) {
      state.recentHostLines = [...state.recentHostLines, callback.segment.text.trim()].slice(-12);
    }
    return this.rememberOperation(callback.operationId, state, "host");
  }

  commitHostSegment(
    callbackOrSegment: HostSegmentCallback | HostSegment,
    generation?: number,
    operationId?: string,
  ): ProgramState {
    return this.applyHostSegment(callbackOrSegment, generation, operationId);
  }

  applyHostCallback(
    generation: number,
    segment: HostSegment,
    operationId?: string,
  ): ProgramState {
    return this.applyHostSegment(segment, generation, operationId);
  }

  acceptHostSegment(
    generation: number,
    segment: HostSegment,
    operationId?: string,
  ): ProgramState {
    return this.applyHostSegment(segment, generation, operationId);
  }

  recordHostLine(line: string, generation = this.state?.generation): ProgramState {
    const state = this.requireState();
    if (generation !== state.generation || isTerminal(state.status)) return this.getState() as ProgramState;
    const normalized = line.trim();
    if (normalized) state.recentHostLines = [...state.recentHostLines, normalized].slice(-12);
    return this.getState() as ProgramState;
  }

  private promoteNextTrack(nowMs: number, _reason: string): boolean {
    if (!this.state || this.state.status !== "on_air") return false;
    this.state.host = null;
    const previous = this.state.currentTrack;
    if (previous) this.previousTrack = cloneTrack(previous);
    const candidate = this.state.nextTrack
      ? cloneTrack(this.state.nextTrack)
      : this.selectAdditionalTrack(nowMs);
    if (!candidate) {
      this.state.currentTrack = null;
      this.state.nextTrack = null;
      this.currentTrackEndsAtMs = null;
      this.state.status = "closing";
      this.state.generation += 1;
      return false;
    }
    const deadlineMs = this.state.deadlineAt ? Date.parse(this.state.deadlineAt) : null;
    if (
      deadlineMs !== null &&
      nowMs + (candidate.durationSeconds + this.closingBufferSeconds) * 1000 > deadlineMs
    ) {
      // Skipping near the deadline must never start a track that cannot finish in time.
      this.state.currentTrack = null;
      this.state.nextTrack = null;
      this.state.queue = [];
      this.currentTrackEndsAtMs = null;
      this.state.status = "closing";
      this.state.generation += 1;
      return false;
    }
    this.state.currentTrack = candidate;
    this.state.nextTrack = this.state.queue.shift() ?? this.selectAdditionalTrack(nowMs, true);
    this.state.generation += 1;
    this.currentTrackEndsAtMs = nowMs + candidate.durationSeconds * 1000;
    this.markPlayed(candidate);
    return true;
  }

  private selectAdditionalTrack(nowMs: number, allowCurrentQueue = false): Track | null {
    if (!this.state) return null;
    const deadlineMs = this.state.deadlineAt ? Date.parse(this.state.deadlineAt) : nowMs;
    const remainingSeconds = Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
    const candidates = allowCurrentQueue ? this.state.queue : this.tracks;
    const options = {
      remainingSeconds,
      scenePreset: this.state.spec.scenePreset,
      elapsedSeconds: this.state.spec.durationMinutes * 60 - this.state.remainingSeconds,
      durationSeconds: this.state.spec.durationMinutes * 60,
      playedTrackIds: this.playedTrackIds,
      playedArtistNames: this.playedArtistNames,
      recentTrackIds: [this.state.currentTrack?.id, this.previousTrack?.id].filter((id): id is string => Boolean(id)),
      recentArtistNames: [this.state.currentTrack?.artist, this.previousTrack?.artist].filter((artist): artist is string => Boolean(artist)),
      avoidMoods: this.state.spec.avoid,
      closingBufferSeconds: this.closingBufferSeconds,
    };
    const decision: QueueDecision = chooseNextTrack(candidates, options);
    if (!decision.selected) return null;
    if (allowCurrentQueue) {
      this.state.queue = this.state.queue.filter((track) => track.id !== decision.selected?.id);
    }
    return decision.selected;
  }

  private beforeSideEffect(nowMs: number): boolean {
    if (!this.state) return false;
    if (this.lastHeartbeatAtMs !== null && nowMs - this.lastHeartbeatAtMs > this.controlLostAfterMs) {
      this.enterControlLost(nowMs);
      return false;
    }
    const deadlineMs = this.state.deadlineAt ? Date.parse(this.state.deadlineAt) : null;
    if (deadlineMs !== null && nowMs >= deadlineMs) {
      if (this.state.spec.sourceId === "fixture") {
        this.completeAtDeadline(nowMs);
        return false;
      }
      this.state.remainingSeconds = 0;
    }
    if (deadlineMs !== null) {
      this.state.remainingSeconds = Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
    }
    return true;
  }

  private completeAtDeadline(nowMs: number): void {
    if (!this.state || isTerminal(this.state.status)) return;
    this.state.status = "completed";
    this.state.remainingSeconds = 0;
    this.state.currentTrack = null;
    this.state.nextTrack = null;
    this.state.queue = [];
    this.state.error = null;
    this.state.host = null;
    this.currentTrackEndsAtMs = null;
    this.lastHeartbeatAtMs = nowMs;
  }

  private enterControlLost(nowMs: number): void {
    if (!this.state || isTerminal(this.state.status)) return;
    this.state.status = "control_lost";
    this.state.generation += 1;
    this.state.error = "Control lease expired after six seconds without a heartbeat.";
    this.lastHeartbeatAtMs = nowMs;
    this.currentTrackEndsAtMs = null;
    this.state.currentTrack = null;
    this.state.nextTrack = null;
    this.state.queue = [];
    this.state.host = null;
  }

  private markPlayed(track: Track): void {
    this.playedTrackIds.add(track.id);
    this.playedArtistNames.add(track.artist);
  }

  private resetRuntime(state: ProgramState): void {
    this.currentTrackEndsAtMs = null;
    this.lastHeartbeatAtMs = null;
    this.previousTrack = null;
    this.playedTrackIds.clear();
    this.playedArtistNames.clear();
    this.operationResults.clear();
    this.lastObservedNowMs = null;
    this.state = state;
  }

  private requireState(programId?: string): ProgramState {
    if (!this.state || (programId && this.state.id !== programId)) {
      throw new ProgramEngineError("program_not_found", "Program was not found.");
    }
    return this.state;
  }

  private readNow(value?: ClockValue): number {
    let candidate: number;
    if (value !== undefined) {
      try {
        candidate = normalizeClockValue(value);
      } catch {
        throw new ProgramEngineError("invalid_spec", "Clock value must be finite.");
      }
    } else {
      candidate = this.nowProvider();
    }
    const monotonic = this.lastObservedNowMs === null ? candidate : Math.max(candidate, this.lastObservedNowMs);
    this.lastObservedNowMs = monotonic;
    return monotonic;
  }

  private rememberOperation(
    operationId: string | undefined,
    state: ProgramState,
    scope: OperationScope | "create",
  ): ProgramState {
    const snapshot = cloneProgramState(state);
    if (operationId) {
      const key = scope === "create" ? `create:${operationId}` : `${state.id}:${operationId}`;
      const previous = this.operationResults.get(key);
      if (previous && previous.scope !== scope) {
        throw new ProgramEngineError("operation_reused", "operationId was already used for a different action.");
      }
      this.operationResults.set(key, { scope, state: snapshot });
      while (this.operationResults.size > 256) {
        const oldest = this.operationResults.keys().next().value;
        if (typeof oldest === "string") this.operationResults.delete(oldest);
        else break;
      }
    }
    return cloneProgramState(snapshot);
  }

  private readOperation(operationId: string, programId: string, scope: OperationScope): ProgramState | undefined {
    const previous = this.operationResults.get(`${programId}:${operationId}`);
    if (!previous) return undefined;
    if (previous.scope !== scope) {
      throw new ProgramEngineError("operation_reused", "operationId was already used for a different action.");
    }
    return previous.state;
  }
}

export function createProgramEngine(options: ProgramEngineOptions = {}): ProgramEngine {
  return new ProgramEngine(options);
}

function normalizeCreateCommand(
  input: ProgramSpec | ProgramSpecInput | CreateProgramRequest | CreateProgramCommand,
  operationId?: string,
): CreateProgramCommand {
  if (isCreateCommand(input)) {
    return { spec: input.spec, operationId: operationId ?? input.operationId };
  }
  if (isCreateRequest(input)) return { spec: input.spec, operationId };
  return { spec: input, operationId };
}

function normalizeAndValidateSpec(input: ProgramSpec | ProgramSpecInput): ProgramSpec {
  const raw = input as Partial<ProgramSpec>;
  if (!raw.scenePreset || !(raw.scenePreset in SCENE_CONFIGS)) {
    throw new ProgramEngineError("invalid_scene", "A supported scene preset is required.");
  }
  const duration = raw.durationMinutes;
  if (
    typeof duration !== "number" ||
    !Number.isFinite(duration) ||
    !Number.isInteger(duration) ||
    duration < MIN_PROGRAM_MINUTES ||
    duration > MAX_PROGRAM_MINUTES
  ) {
    throw new ProgramEngineError(
      "invalid_duration",
      `Duration must be an integer from ${MIN_PROGRAM_MINUTES} to ${MAX_PROGRAM_MINUTES} minutes.`,
    );
  }
  if (raw.sourceId !== undefined && !["fixture", "qq_music", "netease_music"].includes(raw.sourceId)) {
    throw new ProgramEngineError("invalid_source", "Source is not supported by the shared contract.");
  }
  const spec = buildProgramSpec({
    sourceId: raw.sourceId,
    durationMinutes: duration,
    scenePreset: raw.scenePreset,
    sceneDescription: raw.sceneDescription,
    hostDensity: raw.hostDensity,
    energyCurve: raw.energyCurve,
    avoid: raw.avoid,
    familiarityRatio: raw.familiarityRatio,
    recommendationMode: raw.recommendationMode,
    hostProfile: raw.hostProfile,
    musicGenres: raw.musicGenres,
    desktopPetEnabled: raw.desktopPetEnabled,
  });
  return {
    ...spec,
    avoid: [...spec.avoid],
  };
}

function normalizeProgramCommand(
  programIdOrCommand: string | ConfirmProgramCommand | undefined,
  operationId?: string,
): ConfirmProgramCommand {
  if (typeof programIdOrCommand === "object" && programIdOrCommand !== null) {
    return {
      ...programIdOrCommand,
      operationId: operationId ?? programIdOrCommand.operationId,
    };
  }
  return { programId: programIdOrCommand, operationId };
}

function normalizeHeartbeatCommand(
  programIdOrCommand: string | HeartbeatCommand | undefined,
  generation?: number,
  nowMs?: ClockValue,
): HeartbeatCommand {
  if (typeof programIdOrCommand === "object" && programIdOrCommand !== null) {
    return {
      ...programIdOrCommand,
      generation: programIdOrCommand.generation,
      nowMs: nowMs ?? programIdOrCommand.nowMs,
    };
  }
  if (generation === undefined) {
    throw new ProgramEngineError("stale_generation", "Heartbeat requires the current generation.");
  }
  return { programId: programIdOrCommand, generation, nowMs };
}

function normalizeOperationCommand(
  programIdOrCommand: string | ProgramOperationCommand | undefined,
  operationId?: string,
  generation?: number,
  nowMs?: ClockValue,
): ProgramOperationCommand {
  if (typeof programIdOrCommand === "object" && programIdOrCommand !== null) {
    return {
      ...programIdOrCommand,
      operationId: operationId ?? programIdOrCommand.operationId,
      generation: generation ?? programIdOrCommand.generation,
      nowMs: nowMs ?? programIdOrCommand.nowMs,
    };
  }
  return { programId: programIdOrCommand, operationId, generation, nowMs };
}

function makeNowProvider(options: ProgramEngineOptions): () => number {
  if (options.now) {
    const now = options.now;
    return () => normalizeClockValue(now());
  }
  if (typeof options.clock === "function") {
    const clock = options.clock;
    return () => normalizeClockValue(clock());
  }
  if (options.clock) {
    const clock = options.clock;
    return () => normalizeClockValue(clock.now());
  }
  return () => Date.now();
}

function normalizeClockValue(value: number | Date): number {
  const numberValue = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(numberValue)) throw new Error("Clock must return a finite timestamp.");
  return numberValue;
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function timestamp(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

function isTerminal(status: ProgramStatus): boolean {
  return [
    "completed",
    "stopped",
    "failed",
    "control_lost",
    "stop_unconfirmed",
  ].includes(status);
}

function isCreateRequest(value: unknown): value is CreateProgramRequest {
  return Boolean(value && typeof value === "object" && "spec" in value && (value as { spec?: unknown }).spec);
}

function isCreateCommand(value: unknown): value is CreateProgramCommand {
  return isCreateRequest(value) && "operationId" in (value as object);
}

function isHostCallback(value: HostSegmentCallback | HostSegment): value is HostSegmentCallback {
  return "segment" in value && "generation" in value;
}

function cloneHostSegment(segment: HostSegment): HostSegment {
  return { ...segment, factIds: [...segment.factIds] };
}

export function cloneProgramState(state: ProgramState): ProgramState {
  return {
    ...state,
    spec: { ...state.spec, avoid: [...state.spec.avoid], musicGenres: [...(state.spec.musicGenres ?? [])] },
    currentTrack: state.currentTrack ? cloneTrack(state.currentTrack) : null,
    nextTrack: state.nextTrack ? cloneTrack(state.nextTrack) : null,
    queue: state.queue.map(cloneTrack),
    host: state.host ? cloneHostSegment(state.host) : null,
    recentHostLines: [...state.recentHostLines],
  };
}
