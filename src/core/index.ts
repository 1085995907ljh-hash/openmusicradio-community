export {
  MAX_PROGRAM_MINUTES,
  MIN_PROGRAM_MINUTES,
  ProgramEngine,
  ProgramEngineError,
  cloneProgramState,
  createProgramEngine,
  CONTROL_LOST_AFTER_MS,
  HEARTBEAT_INTERVAL_MS,
} from "./program-engine";
export type {
  ClockValue,
  ConfirmProgramCommand,
  CreateProgramCommand,
  HeartbeatCommand,
  HostSegmentCallback,
  ProgramEngineClock,
  ProgramEngineErrorCode,
  ProgramEngineOptions,
  ProgramOperationCommand,
} from "./program-engine";

export {
  SCENE_CONFIGS,
  SCENE_PRESET_OPTIONS,
  buildProgramPlan,
  buildProgramSpec,
  energyRangeForPhase,
  getSceneConfig,
  phaseForElapsedSeconds,
} from "./scenes";
export type {
  EnergyRange,
  HostDensity,
  ProgramPhase,
  ProgramPlanPhase,
  ProgramPlanSummary,
  ProgramSpecInput,
  SceneConfig,
  ScenePresetOption,
} from "./scenes";

export {
  FIXTURE_LIBRARY,
  FIXTURE_TRACKS,
  cloneTrack,
  cloneTracks,
  getFixtureTracks,
} from "./fixtures";

export {
  buildDeterministicQueue,
  buildQueue,
  chooseNextTrack,
  rankTracks,
  selectNextTrack,
} from "./queue";

export {
  PERSONALIZATION_SOURCES,
  personalizeCandidates,
  rankPersonalizedCandidates,
  rankPersonalizedTracks,
  selectNextPersonalizedTrack,
} from "./personalization";
export { buildListeningProfile } from "./listening-profile";
export type { ListeningProfile, ListeningProfileInput, ListeningProfileSong } from "./listening-profile";
export type {
  PersonalizationCandidate,
  PersonalizationInput,
  PersonalizationOptions,
  PersonalizationResult,
  SessionFeedback,
  SessionFeedbackEvent,
} from "./personalization";
export type {
  BuildQueueOptions,
  QueueDecision,
  QueueOptions,
  RankedTrack,
  RejectedTrack,
} from "./queue";

export {
  buildHostContextPack,
  createHostContextPack,
  factsForTracks,
} from "./host-context";

export { SCENE_PRESETS, SOURCE_IDS } from "../shared/contracts";
export type {
  ApiError,
  CapabilityState,
  CreateProgramRequest,
  HostContextPack,
  HostSegment,
  ProgramSpec,
  ProgramState,
  ProgramStatus,
  SourceDiagnostic,
  SourceId,
  Track,
} from "../shared/contracts";
export type {
  EmotionProfile,
  ExtendedHostContextPack,
  HostContextOverrides,
} from "./host-context";
