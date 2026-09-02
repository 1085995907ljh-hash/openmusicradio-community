import type {
  HostContextPack,
  ProgramState,
  Track,
} from "../shared/contracts";
import { phaseForElapsedSeconds, type ProgramPhase } from "./scenes";
import { cloneTrack } from "./fixtures";

export interface EmotionProfile {
  currentMoods: string[];
  nextMoods: string[];
  currentEnergy: number | null;
  nextEnergy: number | null;
}

export interface ExtendedHostContextPack extends HostContextPack {
  emotionProfile: EmotionProfile;
}

export interface HostContextOverrides {
  programPhase?: ProgramPhase;
  timeRemainingSeconds?: number;
  previousTrack?: Track | null;
  currentTrack?: Track | null;
  nextTrack?: Track | null;
  transitionReason?: string;
  recentHostLines?: string[];
  allowedFacts?: Array<{ id: string; value: string; source: "fixture" | "user" }>;
  forbiddenClaims?: string[];
}

const DEFAULT_FORBIDDEN_CLAIMS = [
  "Do not infer the user's location, mood, memories, health, heart rate, work, or private experiences.",
  "Do not invent an album, release year, chart position, genre attribution, or artist biography.",
  "Do not claim a listener action or audience reaction that the engine did not observe.",
];

/** Build a fact-bounded context from the current immutable program snapshot. */
export function buildHostContextPack(
  state: ProgramState,
  overrides: HostContextOverrides = {},
): ExtendedHostContextPack {
  const durationSeconds = state.spec.durationMinutes * 60;
  const elapsedSeconds = state.startedAt
    ? Math.max(0, durationSeconds - state.remainingSeconds)
    : 0;
  const programPhase =
    overrides.programPhase ?? phaseForElapsedSeconds(elapsedSeconds, durationSeconds);
  const timeRemainingSeconds = Math.max(
    0,
    Math.floor(overrides.timeRemainingSeconds ?? state.remainingSeconds),
  );
  const previousTrack = overrides.previousTrack === undefined
    ? null
    : overrides.previousTrack;
  const currentTrack = overrides.currentTrack === undefined
    ? state.currentTrack
    : overrides.currentTrack;
  const nextTrack = overrides.nextTrack === undefined
    ? state.nextTrack
    : overrides.nextTrack;
  const allowedFacts = overrides.allowedFacts
    ? overrides.allowedFacts.map((fact) => ({ ...fact }))
    : factsForTracks([previousTrack, currentTrack, nextTrack]);

  return {
    scenePreset: state.spec.scenePreset,
    programPhase,
    timeRemainingSeconds,
    previousTrack: previousTrack ? cloneTrack(previousTrack) : null,
    currentTrack: currentTrack ? cloneTrack(currentTrack) : null,
    nextTrack: nextTrack ? cloneTrack(nextTrack) : null,
    transitionReason:
      overrides.transitionReason ?? transitionReason(programPhase, currentTrack, nextTrack),
    recentHostLines: [...(overrides.recentHostLines ?? state.recentHostLines)],
    allowedFacts,
    forbiddenClaims: [...(overrides.forbiddenClaims ?? DEFAULT_FORBIDDEN_CLAIMS)],
    emotionProfile: {
      currentMoods: currentTrack ? [...currentTrack.mood] : [],
      nextMoods: nextTrack ? [...nextTrack.mood] : [],
      currentEnergy: currentTrack?.energy ?? null,
      nextEnergy: nextTrack?.energy ?? null,
    },
  };
}

export const createHostContextPack = buildHostContextPack;

export function factsForTracks(
  tracks: readonly (Track | null | undefined)[],
): Array<{ id: string; value: string; source: "fixture" }> {
  const facts: Array<{ id: string; value: string; source: "fixture" }> = [];
  const seen = new Set<string>();
  for (const track of tracks) {
    if (!track) continue;
    const entries = [
      [`track:${track.id}:title`, `Title: ${track.title}`],
      [`track:${track.id}:artist`, `Artist: ${track.artist}`],
      [`track:${track.id}:duration`, `Duration: ${track.durationSeconds} seconds`],
    ] as const;
    for (const [id, value] of entries) {
      if (seen.has(id)) continue;
      seen.add(id);
      facts.push({ id, value, source: "fixture" });
    }
  }
  return facts;
}

function transitionReason(
  phase: ProgramPhase,
  currentTrack: Track | null | undefined,
  nextTrack: Track | null | undefined,
): string {
  if (!currentTrack) return "opening the program";
  if (!nextTrack) return phase === "closing" ? "closing before the deadline" : "no eligible next track";
  if (phase === "peak") return "moving into the program peak";
  if (phase === "cooldown" || phase === "closing") return "bringing the energy down toward the close";
  return "continuing the selected program arc";
}
