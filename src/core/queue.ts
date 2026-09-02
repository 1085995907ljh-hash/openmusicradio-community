import type { Track } from "../shared/contracts";
import type { ProgramPhase } from "./scenes";
import { energyRangeForPhase, phaseForElapsedSeconds } from "./scenes";
import { cloneTrack } from "./fixtures";
import type { ScenePreset } from "../shared/contracts";

export interface QueueOptions {
  remainingSeconds?: number;
  targetEnergy?: number;
  scenePreset?: ScenePreset;
  phase?: ProgramPhase;
  elapsedSeconds?: number;
  durationSeconds?: number;
  playedTrackIds?: Iterable<string>;
  recentTrackIds?: Iterable<string>;
  playedArtistNames?: Iterable<string>;
  recentArtistNames?: Iterable<string>;
  avoidMoods?: Iterable<string>;
  closingBufferSeconds?: number;
  isPlayable?: (track: Track) => boolean;
}

export interface RankedTrack {
  track: Track;
  score: number;
  reasons: string[];
}

export interface RejectedTrack {
  track: Track;
  reason: string;
}

export interface QueueDecision {
  selected: Track | null;
  ranked: RankedTrack[];
  rejected: RejectedTrack[];
  reason: string;
}

const DEFAULT_CLOSING_BUFFER_SECONDS = 15;

/**
 * Rank candidates using only stable metadata and explicit inputs.
 * Array order is never used as a tie breaker; ids provide the final order.
 */
export function rankTracks(
  candidates: readonly Track[],
  options: QueueOptions = {},
): RankedTrack[] {
  const { ranked } = rankTracksWithRejections(candidates, options);
  return ranked.map((entry) => ({
    ...entry,
    track: cloneTrack(entry.track),
    reasons: [...entry.reasons],
  }));
}

export function chooseNextTrack(
  candidates: readonly Track[],
  options: QueueOptions = {},
): QueueDecision {
  const { ranked, rejected } = rankTracksWithRejections(candidates, options);
  const selected = ranked[0]?.track ?? null;
  return {
    selected: selected ? cloneTrack(selected) : null,
    ranked: ranked.map((entry) => ({ ...entry, track: cloneTrack(entry.track), reasons: [...entry.reasons] })),
    rejected: rejected.map((entry) => ({ track: cloneTrack(entry.track), reason: entry.reason })),
    reason: selected
      ? ranked[0].reasons.join("; ") || "best deterministic score"
      : "no candidate satisfies playback and deadline constraints",
  };
}

/** Select only the track, for callers that do not need diagnostics. */
export function selectNextTrack(
  candidates: readonly Track[],
  options: QueueOptions = {},
): Track | null {
  return chooseNextTrack(candidates, options).selected;
}

export interface BuildQueueOptions extends QueueOptions {
  durationSeconds: number;
  maxTracks?: number;
}

/**
 * Build a complete deterministic queue for one program. Track ids are never
 * repeated, and each chosen track fits before the absolute deadline buffer.
 */
export function buildDeterministicQueue(
  candidates: readonly Track[],
  options: BuildQueueOptions,
): Track[] {
  const queue: Track[] = [];
  const playedTrackIds = new Set(options.playedTrackIds ?? []);
  const playedArtistNames = new Set(options.playedArtistNames ?? []);
  const maxTracks = options.maxTracks ?? candidates.length;
  let elapsedSeconds = options.elapsedSeconds ?? 0;

  while (queue.length < maxTracks) {
    const remainingSeconds = Math.max(0, options.durationSeconds - elapsedSeconds);
    const phase = options.scenePreset
      ? options.phase ?? phaseForElapsedSeconds(elapsedSeconds, options.durationSeconds)
      : options.phase;
    const selected = chooseNextTrack(candidates, {
      ...options,
      remainingSeconds,
      elapsedSeconds,
      phase,
      playedTrackIds,
      playedArtistNames,
      recentTrackIds: undefined,
    }).selected;

    if (!selected) break;
    queue.push(cloneTrack(selected));
    playedTrackIds.add(selected.id);
    playedArtistNames.add(selected.artist);
    elapsedSeconds += selected.durationSeconds;
  }

  return queue;
}

export const buildQueue = buildDeterministicQueue;

function rankTracksWithRejections(
  candidates: readonly Track[],
  options: QueueOptions,
): { ranked: RankedTrack[]; rejected: RejectedTrack[] } {
  const playedTrackIds = toSet(options.playedTrackIds);
  const recentTrackIds = toSet(options.recentTrackIds);
  const playedArtistNames = toSet(options.playedArtistNames);
  const recentArtistNames = toSet(options.recentArtistNames);
  const avoidMoods = toSet(options.avoidMoods);
  const closingBufferSeconds = Math.max(
    0,
    options.closingBufferSeconds ?? DEFAULT_CLOSING_BUFFER_SECONDS,
  );
  const targetEnergy = resolveTargetEnergy(options);
  const ranked: RankedTrack[] = [];
  const rejected: RejectedTrack[] = [];
  const seenIds = new Set<string>();

  for (const track of candidates) {
    if (seenIds.has(track.id)) {
      rejected.push({ track, reason: "duplicate track id in candidates" });
      continue;
    }
    seenIds.add(track.id);

    if (playedTrackIds.has(track.id)) {
      rejected.push({ track, reason: "track already played in this program" });
      continue;
    }
    if (recentTrackIds.has(track.id)) {
      rejected.push({ track, reason: "track is in the recent-play window" });
      continue;
    }
    if (options.isPlayable && !options.isPlayable(track)) {
      rejected.push({ track, reason: "track is not playable" });
      continue;
    }
    if (options.remainingSeconds !== undefined) {
      const available = options.remainingSeconds - closingBufferSeconds;
      if (track.durationSeconds > available) {
        rejected.push({ track, reason: "track would cross the strict deadline" });
        continue;
      }
    }
    if (avoidMoods.size && track.mood.some((mood) => avoidMoods.has(mood))) {
      rejected.push({ track, reason: "track matches an avoided mood" });
      continue;
    }

    const energyDistance = Math.abs(track.energy - targetEnergy);
    const repeatArtistPenalty = playedArtistNames.has(track.artist) ? 14 : 0;
    const recentArtistPenalty = recentArtistNames.has(track.artist) ? 7 : 0;
    const durationFit = durationFitScore(track.durationSeconds, options.remainingSeconds);
    const reasons = [
      `energy distance ${energyDistance.toFixed(3)}`,
      repeatArtistPenalty ? "repeat artist penalty" : "new artist",
      recentArtistPenalty ? "recent artist penalty" : "artist not recent",
      `duration fit ${durationFit.toFixed(1)}`,
    ];
    const score =
      100 -
      energyDistance * 70 -
      repeatArtistPenalty -
      recentArtistPenalty +
      durationFit;
    ranked.push({ track, score, reasons });
  }

  ranked.sort((left, right) => {
    const scoreDelta = right.score - left.score;
    if (Math.abs(scoreDelta) > 1e-9) return scoreDelta;
    return left.track.id.localeCompare(right.track.id);
  });
  return { ranked, rejected };
}

function resolveTargetEnergy(options: QueueOptions): number {
  if (options.targetEnergy !== undefined && Number.isFinite(options.targetEnergy)) {
    return clamp(options.targetEnergy, 0, 1);
  }
  if (options.scenePreset) {
    const phase = options.phase ?? (
      options.durationSeconds !== undefined
        ? phaseForElapsedSeconds(options.elapsedSeconds ?? 0, options.durationSeconds)
        : "building"
    );
    const range = energyRangeForPhase(options.scenePreset, phase);
    return (range.min + range.max) / 2;
  }
  return 0.5;
}

function durationFitScore(durationSeconds: number, remainingSeconds?: number): number {
  if (remainingSeconds === undefined || remainingSeconds <= 0) return 0;
  const ratio = durationSeconds / remainingSeconds;
  return Math.max(0, 8 - Math.abs(0.65 - ratio) * 8);
}

function toSet(values: Iterable<string> | undefined): Set<string> {
  return new Set(values ?? []);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export { SCENE_CONFIGS } from "./scenes";
