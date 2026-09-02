import type { HostProfileId, MusicGenreId } from "./program-options.js";

export const SCENE_PRESETS = ["late_night", "study", "workout", "commute", "party"] as const;
export type ScenePreset = (typeof SCENE_PRESETS)[number];

export const SOURCE_IDS = ["fixture", "qq_music", "netease_music"] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

export type CapabilityState =
  | "ready"
  | "missing_credentials"
  | "blocked_by_credentials"
  | "blocked_by_policy"
  | "blocked_by_policy_review"
  | "blocked_by_official_access"
  | "blocked_by_terms"
  | "failed_technical"
  | "unsupported";

export interface SourceDiagnostic {
  sourceId: SourceId;
  label: string;
  playbackReady: boolean;
  hostedProgramAllowed: boolean;
  accountConnected?: boolean;
  desktopState?: string;
  state: CapabilityState;
  detail: string;
  checkedAt: string;
}

export interface ProgramSpec {
  sourceId: SourceId;
  durationMinutes: number;
  recommendationMode?: "atmosphere" | "genre";
  scenePreset: ScenePreset;
  sceneDescription: string;
  hostDensity: "low" | "medium" | "high";
  energyCurve: string;
  avoid: string[];
  /** Hard target share of tracks in the listener's explicit liked-song list. */
  familiarityRatio?: number;
  /** Fixed Mandarin host voice for the entire program. */
  hostProfile?: HostProfileId;
  /** Optional music-style preferences used to expand and rank candidates. */
  musicGenres?: MusicGenreId[];
  /** Launch the native desktop companion after this program is confirmed. */
  desktopPetEnabled?: boolean;
}

export interface Track {
  id: string;
  title: string;
  artist: string;
  durationSeconds: number;
  energy: number;
  mood: string[];
  styleTags?: string[];
  color: string;
  audioUrl?: string;
  coverUrl?: string;
}

export interface ProgramRundownItem extends Track {
  sourceId: SourceId;
  /** Provider-specific QQ song type required for account mutations such as "我喜欢". */
  songType?: number;
  /** Target intensity for this position in the program arc, not measured audio metadata. */
  arrangementTargetEnergy?: number;
  /** Whether `energy` came from provider metadata instead of a neutral fallback. */
  energyMeasured?: boolean;
  album?: string | null;
  releaseYear?: number | null;
  credits?: {
    lyricists: string[];
    composers: string[];
    arrangers: string[];
  };
  popularity?: number | null;
  reasons: string[];
  liked?: boolean;
  heard?: boolean;
  hostMoment?: "opening" | "song_note" | "next_preview" | "scene_boost" | "music_news";
  hostScript?: ProgramHostScript;
}

export interface ProgramHostScript {
  id: string;
  text: string;
  factIds: string[];
  instruction: string;
  deliveryInstruction?: string;
  hostMoment: "opening" | "song_note" | "next_preview" | "scene_boost" | "music_news";
  generatedAt: string;
  plannedDurationSeconds?: number;
  musicBedDelaySeconds?: number;
  fallback?: boolean;
  fallbackReason?: string;
  audioReady?: boolean;
  audioPreparedAt?: string;
}

export interface ProgramListenerProfile {
  favoriteArtists: Array<{ name: string; score: number }>;
  topSongs: Array<{ title: string; artists: string[] }>;
  playlistNames: string[];
  inferredThemes: string[];
  styleTags?: string[];
  styleAffinities?: Array<{
    style: string;
    score: number;
    artists: Array<{ name: string; score: number; songs: string[] }>;
    familiarSongs: Array<{ title: string; artists: string[]; sources: string[] }>;
    evidence: string[];
  }>;
  taggedSongs?: Array<{ title: string; artists: string[]; tags: string[]; sources: string[] }>;
  evidence: string[];
}

export interface ProgramPlaylistReceipt {
  provider: "netease_music" | "qq_music";
  id: string;
  idKind?: "tid";
  dirId?: string;
  name: string;
  trackCount: number;
  status: "created" | "ready" | "partial" | "deleted" | "delete_failed";
  retention: "temporary" | "kept";
}

export interface ProgramPlanSummary {
  totalTracks: number;
  likedTracks: number;
  heardTracks: number;
  familiarTracks: number;
  unheardTracks: number;
  targetFamiliarityRatio: number;
  actualFamiliarityRatio: number;
}

export interface HostContextPack {
  scenePreset: ScenePreset;
  programPhase: "opening" | "building" | "peak" | "cooldown" | "closing";
  timeRemainingSeconds: number;
  previousTrack: Track | null;
  currentTrack: Track | null;
  nextTrack: Track | null;
  transitionReason: string;
  recentHostLines: string[];
  allowedFacts: Array<{ id: string; value: string; source: "fixture" | "user" | "web"; sourceUrl?: string }>;
  forbiddenClaims: string[];
  /** Whether this is a discovery track the listener is unlikely to know. */
  isExploration?: boolean;
  /** Fixed Mandarin host persona used by the current program. */
  hostProfile?: HostProfileId;
  /** The bounded, user-approved profile summary used for personalized hosting. */
  listenerProfile?: ProgramListenerProfile;
  /** The Yao-authored runtime contract loaded by the local service. */
  skillInstruction?: string;
  /** Independent producer review contract. When present, no draft is returned before approval. */
  reviewInstruction?: string;
  hostMoment?: "opening" | "song_note" | "next_preview" | "scene_boost" | "music_news";
  hostLengthSeconds?: number;
}

export interface HostSegment {
  id: string;
  text: string;
  factIds: string[];
  instruction: string;
  deliveryInstruction?: string;
  generatedAt: string;
  plannedDurationSeconds?: number;
  audioUrl?: string;
  status: "generated" | "synthesizing" | "ready" | "playing" | "skipped" | "failed";
}

export type ProgramStatus =
  | "draft"
  | "awaiting_confirmation"
  | "preparing"
  | "on_air"
  | "closing"
  | "completed"
  | "stopped"
  | "failed"
  | "control_lost"
  | "stop_unconfirmed";

export interface ProgramState {
  id: string;
  generation: number;
  status: ProgramStatus;
  spec: ProgramSpec;
  startedAt: string | null;
  deadlineAt: string | null;
  remainingSeconds: number;
  currentTrack: Track | null;
  nextTrack: Track | null;
  queue: Track[];
  rundown?: ProgramRundownItem[];
  rundownIndex?: number;
  planRevision?: number;
  /** The unique account playlist name reserved for this draft before remote creation. */
  plannedPlaylistName?: string;
  playlist?: ProgramPlaylistReceipt;
  planSummary?: ProgramPlanSummary;
  listenerProfile?: ProgramListenerProfile;
  host: HostSegment | null;
  recentHostLines: string[];
  error: string | null;
}

export interface CreateProgramRequest {
  spec: ProgramSpec;
}

export interface ApiError {
  error: string;
  code: string;
}
