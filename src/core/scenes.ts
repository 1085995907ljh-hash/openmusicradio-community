import type {
  ProgramSpec,
  ScenePreset,
  SourceId,
} from "../shared/contracts";
import { DEFAULT_HOST_PROFILE, type HostProfileId, type MusicGenreId } from "../shared/program-options";

export type ProgramPhase =
  | "opening"
  | "building"
  | "peak"
  | "cooldown"
  | "closing";

export type HostDensity = ProgramSpec["hostDensity"];

export const HOST_TTS_VOLUME_BOOST_DB = 6;

export interface EnergyRange {
  min: number;
  max: number;
}

export interface SceneConfig {
  preset: ScenePreset;
  label: string;
  goal: string;
  sceneDescription: string;
  hostDensity: HostDensity;
  hostCadence: string;
  sentenceSeconds: { min: number; max: number };
  hostLanguageDirection: string;
  ttsDirection: string;
  ttsParameters: { rate: number; pitch: number; volume: number };
  energyCurve: string;
  energyByPhase: Record<ProgramPhase, EnergyRange>;
  avoid: string[];
}

export interface ScenePresetOption {
  value: ScenePreset;
  label: string;
  description: string;
}

export const SCENE_CONFIGS: Record<ScenePreset, SceneConfig> = {
  late_night: {
    preset: "late_night",
    label: "放松",
    goal: "Let the music settle gently without losing its shape.",
    sceneDescription: "A relaxed set with soft transitions, restrained peaks, and generous breathing room.",
    hostDensity: "low",
    hostCadence: "Every 2-4 tracks, with a 10-22 second line.",
    sentenceSeconds: { min: 10, max: 22 },
    hostLanguageDirection: "句子舒展，转场柔和，允许短暂停顿；少用密集短句和强情绪词。",
    ttsDirection: "Warm, slower, and spacious with natural pauses.",
    ttsParameters: { rate: 0.82, pitch: 0.96, volume: 48 },
    energyCurve: "low and steady, with a soft lift before cooldown",
    energyByPhase: {
      opening: { min: 0.2, max: 0.35 },
      building: { min: 0.25, max: 0.45 },
      peak: { min: 0.35, max: 0.55 },
      cooldown: { min: 0.2, max: 0.4 },
      closing: { min: 0.15, max: 0.3 },
    },
    avoid: ["abrupt jumps", "shouted delivery", "busy transitions"],
  },
  study: {
    preset: "study",
    label: "专注",
    goal: "Support sustained attention without competing for it.",
    sceneDescription: "A focused set with stable pacing, small energy changes, and brief host interruptions.",
    hostDensity: "low",
    hostCadence: "Every 3-5 tracks, with a 6-12 second line.",
    sentenceSeconds: { min: 6, max: 12 },
    hostLanguageDirection: "信息先行，句子清楚克制，少用修饰；保持稳定，不与音乐争夺注意力。",
    ttsDirection: "Even, precise, and low-variation at a slightly slower pace.",
    ttsParameters: { rate: 0.90, pitch: 1, volume: 49 },
    energyCurve: "flat and consistent, avoiding sharp peaks",
    energyByPhase: {
      opening: { min: 0.3, max: 0.45 },
      building: { min: 0.35, max: 0.55 },
      peak: { min: 0.45, max: 0.65 },
      cooldown: { min: 0.35, max: 0.5 },
      closing: { min: 0.25, max: 0.4 },
    },
    avoid: ["long monologues", "dramatic drops", "frequent interruptions"],
  },
  workout: {
    preset: "workout",
    label: "运动",
    goal: "Move from warm-up to a strong peak, then make recovery easy.",
    sceneDescription: "A purposeful workout arc with a rising middle, a clear high point, and a measured cooldown.",
    hostDensity: "high",
    hostCadence: "Every 1-3 tracks or at a phase change, with a 5-12 second line.",
    sentenceSeconds: { min: 5, max: 12 },
    hostLanguageDirection: "句子更短，动词更直接，节奏向前；有动力但不喊口号。",
    ttsDirection: "Energetic and clear, but not rushed or shouted.",
    ttsParameters: { rate: 1.00, pitch: 1.02, volume: 53 },
    energyCurve: "rising through the middle, then deliberate cooldown",
    energyByPhase: {
      opening: { min: 0.35, max: 0.55 },
      building: { min: 0.55, max: 0.75 },
      peak: { min: 0.75, max: 0.95 },
      cooldown: { min: 0.4, max: 0.65 },
      closing: { min: 0.2, max: 0.45 },
    },
    avoid: ["slow starts", "long silence at transitions", "unsafe exertion claims"],
  },
  commute: {
    preset: "commute",
    label: "律动",
    goal: "Keep a clear pulse and a natural sense of forward motion.",
    sceneDescription: "A groove-led set with concise links, clean transitions, and a dependable pulse.",
    hostDensity: "medium",
    hostCadence: "Every 2-3 tracks, with an 8-18 second line.",
    sentenceSeconds: { min: 8, max: 18 },
    hostLanguageDirection: "口吻自然利落，句子长短有变化，带轻微推进感；像陪伴，不像播报。",
    ttsDirection: "Natural, clear, and a little more relaxed than normal speech.",
    ttsParameters: { rate: 0.96, pitch: 1, volume: 51 },
    energyCurve: "steady forward motion with a modest midpoint lift",
    energyByPhase: {
      opening: { min: 0.35, max: 0.55 },
      building: { min: 0.45, max: 0.7 },
      peak: { min: 0.6, max: 0.8 },
      cooldown: { min: 0.4, max: 0.6 },
      closing: { min: 0.3, max: 0.5 },
    },
    avoid: ["complicated instructions", "long preambles", "sudden mood swings"],
  },
  party: {
    preset: "party",
    label: "派对",
    goal: "Keep the room moving and prevent awkward gaps.",
    sceneDescription: "An upbeat party set with compact links, quick momentum, and a controlled final comedown.",
    hostDensity: "high",
    hostCadence: "Every 2-3 tracks or before a peak, with a 5-10 second line.",
    sentenceSeconds: { min: 5, max: 10 },
    hostLanguageDirection: "短句紧凑，语气明亮，重音更鲜明；热情但不叫喊，不牺牲音乐信息。",
    ttsDirection: "Lively and light, timed to the beat without rushing.",
    ttsParameters: { rate: 1.06, pitch: 1.04, volume: 55 },
    energyCurve: "high energy with short ramps into repeated peaks",
    energyByPhase: {
      opening: { min: 0.45, max: 0.65 },
      building: { min: 0.6, max: 0.8 },
      peak: { min: 0.8, max: 1 },
      cooldown: { min: 0.5, max: 0.7 },
      closing: { min: 0.3, max: 0.55 },
    },
    avoid: ["dead air", "slow spoken sections", "unverified crowd claims"],
  },
};

export const SCENE_PRESET_OPTIONS: readonly ScenePresetOption[] = (
  Object.values(SCENE_CONFIGS).map((config) => ({
    value: config.preset,
    label: config.label,
    description: config.goal,
  }))
);

export function getSceneConfig(scenePreset: ScenePreset): SceneConfig {
  const config = SCENE_CONFIGS[scenePreset];
  if (!config) throw new Error(`Unknown scene preset: ${String(scenePreset)}`);
  return cloneSceneConfig(config);
}

export function boostedHostTtsVolume(baseVolume: number): number {
  if (!Number.isFinite(baseVolume)) return HOST_TTS_VOLUME_BOOST_DB;
  return Math.max(0, Math.min(100, baseVolume + HOST_TTS_VOLUME_BOOST_DB));
}

export interface ProgramSpecInput {
  sourceId?: SourceId;
  durationMinutes: number;
  recommendationMode?: ProgramSpec["recommendationMode"];
  scenePreset: ScenePreset;
  sceneDescription?: string;
  hostDensity?: HostDensity;
  energyCurve?: string;
  avoid?: string[];
  familiarityRatio?: number;
  hostProfile?: HostProfileId;
  musicGenres?: MusicGenreId[];
  desktopPetEnabled?: boolean;
}

export function buildProgramSpec(input: ProgramSpecInput): ProgramSpec {
  const config = SCENE_CONFIGS[input.scenePreset];
  if (!config) {
    throw new Error(`Unknown scene preset: ${String(input.scenePreset)}`);
  }
  const recommendationMode = input.recommendationMode ?? ((input.musicGenres?.length ?? 0) > 0 ? "genre" : "atmosphere");

  return {
    sourceId: input.sourceId ?? "fixture",
    durationMinutes: input.durationMinutes,
    recommendationMode,
    scenePreset: input.scenePreset,
    sceneDescription: input.sceneDescription?.trim() || config.sceneDescription,
    hostDensity: input.hostDensity ?? config.hostDensity,
    energyCurve: input.energyCurve ?? config.energyCurve,
    avoid: [...(input.avoid ?? config.avoid)],
    familiarityRatio: Math.max(0, Math.min(100, Math.round(input.familiarityRatio ?? 40))),
    hostProfile: input.hostProfile ?? DEFAULT_HOST_PROFILE,
    musicGenres: recommendationMode === "genre" ? [...(input.musicGenres ?? [])] : [],
    desktopPetEnabled: input.desktopPetEnabled ?? false,
  };
}

export interface ProgramPlanPhase {
  phase: ProgramPhase;
  startFraction: number;
  endFraction: number;
  energy: EnergyRange;
  objective: string;
}

export interface ProgramPlanSummary {
  scenePreset: ScenePreset;
  sceneLabel: string;
  sceneGoal: string;
  sceneDescription: string;
  energyCurve: string;
  hostDensity: HostDensity;
  hostCadence: string;
  hostLanguageDirection: string;
  ttsDirection: string;
  avoid: string[];
  phases: ProgramPlanPhase[];
  summary: string;
}

const PHASE_OBJECTIVES: Record<ProgramPhase, string> = {
  opening: "Settle into the selected scene.",
  building: "Establish the program rhythm.",
  peak: "Deliver the strongest energy point.",
  cooldown: "Reduce intensity without an abrupt stop.",
  closing: "Leave enough space for a clean ending.",
};

const PHASE_FRACTIONS: Array<readonly [ProgramPhase, number, number]> = [
  ["opening", 0, 0.12],
  ["building", 0.12, 0.55],
  ["peak", 0.55, 0.78],
  ["cooldown", 0.78, 0.94],
  ["closing", 0.94, 1],
];

export function buildProgramPlan(spec: ProgramSpec): ProgramPlanSummary {
  const config = SCENE_CONFIGS[spec.scenePreset];
  if (!config) {
    throw new Error(`Unknown scene preset: ${String(spec.scenePreset)}`);
  }

  const phases = PHASE_FRACTIONS.map(([phase, startFraction, endFraction]) => ({
    phase,
    startFraction,
    endFraction,
    energy: { ...config.energyByPhase[phase] },
    objective: PHASE_OBJECTIVES[phase],
  }));

  return {
    scenePreset: spec.scenePreset,
    sceneLabel: config.label,
    sceneGoal: config.goal,
    sceneDescription: spec.sceneDescription,
    energyCurve: spec.energyCurve,
    hostDensity: spec.hostDensity,
    hostCadence: config.hostCadence,
    hostLanguageDirection: config.hostLanguageDirection,
    ttsDirection: config.ttsDirection,
    avoid: [...spec.avoid],
    phases,
    summary: `${config.label}: ${spec.sceneDescription} Energy is ${spec.energyCurve}. Host density is ${spec.hostDensity}.`,
  };
}

export function phaseForElapsedSeconds(
  elapsedSeconds: number,
  durationSeconds: number,
): ProgramPhase {
  if (durationSeconds <= 0 || elapsedSeconds <= 0) return "opening";
  const fraction = Math.min(1, Math.max(0, elapsedSeconds / durationSeconds));
  for (const [phase, startFraction, endFraction] of PHASE_FRACTIONS) {
    if (fraction < endFraction || phase === "closing") {
      if (fraction >= startFraction) return phase;
    }
  }
  return "closing";
}

export function energyRangeForPhase(
  scenePreset: ScenePreset,
  phase: ProgramPhase,
): EnergyRange {
  return { ...SCENE_CONFIGS[scenePreset].energyByPhase[phase] };
}

function cloneSceneConfig(config: SceneConfig): SceneConfig {
  return {
    ...config,
    sentenceSeconds: { ...config.sentenceSeconds },
    ttsParameters: { ...config.ttsParameters },
    energyByPhase: Object.fromEntries(
      Object.entries(config.energyByPhase).map(([phase, range]) => [phase, { ...range }]),
    ) as Record<ProgramPhase, EnergyRange>,
    avoid: [...config.avoid],
  };
}
