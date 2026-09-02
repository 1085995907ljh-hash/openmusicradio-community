import type { HostContextPack, ScenePreset } from "../shared/contracts.js";
import type { HostProfileId } from "../shared/program-options.js";

export const OPENAI_API_MODES = ["auto", "responses", "chat_completions"] as const;
export type OpenAIApiMode = (typeof OPENAI_API_MODES)[number];
export const REASONING_EFFORTS = ["low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export type ProviderErrorCode =
  | "missing_credentials"
  | "invalid_input"
  | "invalid_response"
  | "invalid_facts"
  | "invalid_audio"
  | "timeout"
  | "unauthorized"
  | "rate_limited"
  | "business_error"
  | "unsupported"
  | "network_error";

export interface ProviderErrorInfo {
  code: ProviderErrorCode;
  message: string;
  provider: string;
  status?: number;
  retryable: boolean;
  retryAfterMs?: number;
}

/**
 * Provider failures are typed so the local service can expose a stable code
 * without copying upstream response bodies (which may contain secrets).
 */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly provider: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(info: ProviderErrorInfo, options?: { cause?: unknown }) {
    super(info.message, options);
    this.name = "ProviderError";
    this.code = info.code;
    this.provider = info.provider;
    this.status = info.status;
    this.retryable = info.retryable;
    this.retryAfterMs = info.retryAfterMs;
  }

  toInfo(): ProviderErrorInfo {
    return {
      code: this.code,
      message: this.message,
      provider: this.provider,
      ...(this.status === undefined ? {} : { status: this.status }),
      retryable: this.retryable,
      ...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }),
    };
  }
}

export type HostGenerationStatus = "ready" | "mock" | "failed";

export interface HostGenerationResult {
  provider: string;
  status: HostGenerationStatus;
  configured: boolean;
  mock: boolean;
  success: boolean;
  text: string;
  factIds: string[];
  instruction: string;
  /** Model-authored delivery direction passed to the TTS provider. */
  deliveryInstruction?: string;
  generatedAt: string;
  model: string;
  apiMode: OpenAIApiMode | "mock";
  /** True when fact-safe local copy was used to guarantee an on-air break. */
  fallback?: boolean;
  error?: ProviderErrorInfo;
}

export interface HostProviderStatus {
  provider: string;
  configured: boolean;
  mock: boolean;
  baseUrl: string;
  model: string;
  mode: OpenAIApiMode | "local";
  timeoutMs: number;
}

export interface OpenAICompatibleHostProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  reviewModel?: string;
  reasoningEffort?: ReasoningEffort;
  mode?: OpenAIApiMode | string;
  enableWebSearch?: boolean;
  allowInsecureHttp?: boolean;
  timeoutMs?: number;
  maxTextLength?: number;
  fetchImpl?: typeof globalThis.fetch;
  /** Alias retained for tests and callers that use the platform name. */
  fetch?: typeof globalThis.fetch;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export interface HostGenerationOptions {
  signal?: AbortSignal;
}

export type HostShowFrequency = "low" | "medium" | "high";

export interface HostShowTrackContext {
  trackIndex: number;
  title: string;
  artist: string;
  album?: string;
  exploration: boolean;
  allowedFacts: HostContextPack["allowedFacts"];
}

export interface HostShowGenerationRequest {
  scenePreset: ScenePreset;
  frequency: HostShowFrequency;
  openingGreeting?: "早上好" | "下午好" | "晚上好" | "夜深了";
  hostProfile?: HostProfileId;
  tracks: HostShowTrackContext[];
  skillInstruction: string;
  reviewInstruction: string;
  listenerProfile?: HostContextPack["listenerProfile"];
  userAdjustment?: string;
}

export interface HostShowBreak {
  id: string;
  /** One-based playlist position, matching the Skill output contract. */
  beforeTrackIndex: number;
  type: "opening" | "middle" | "closing";
  targetSeconds: number;
  text: string;
  sourceIds: string[];
  deliveryInstruction: string;
}

export interface HostShowGenerationResult {
  success: boolean;
  provider: string;
  status: HostGenerationStatus;
  model: string;
  reviewModel: string;
  apiMode: OpenAIApiMode | "mock";
  breaks: HostShowBreak[];
  generatedAt: string;
  /** True only when the model/reviewer flow failed and local fact-safe copy was used. */
  fallback?: boolean;
  error?: ProviderErrorInfo;
}

export interface MusicResearchRequest {
  scenePreset: ScenePreset;
  listenerProfile?: {
    favoriteArtists: string[];
    topSongs: string[];
    inferredThemes: string[];
  };
  tracks: Array<{ title: string; artist: string; exploration?: boolean }>;
}

export interface MusicResearchFact {
  id: string;
  value: string;
  sourceUrl: string;
}

export interface PlaylistNamingRequest {
  scenePreset: ScenePreset;
  energyCurve: string;
  tracks: Array<{ title: string; artist: string }>;
}

export interface PlaylistNamingResult {
  success: boolean;
  names: string[];
}

export interface TtsSynthesisRequest {
  text: string;
  scenePreset: ScenePreset;
  /** One of the product's fixed Mandarin host voices. */
  hostProfile?: HostProfileId;
  /** Optional model-authored delivery direction; never contains the script. */
  instruction?: string;
  signal?: AbortSignal;
}

export type TtsSynthesisStatus = "ready" | "mock" | "disabled" | "failed";

export interface TtsResult {
  provider: string;
  status: TtsSynthesisStatus;
  configured: boolean;
  mock: boolean;
  success: boolean;
  model: string;
  voice: string;
  language: "Chinese";
  scenePreset: ScenePreset;
  instruction: string;
  /** In-memory audio only. Upstream temporary URLs are intentionally omitted. */
  audio: Buffer | null;
  /** Alias used by callers that call the payload a buffer. */
  buffer: Buffer | null;
  /** Compatibility alias for server adapters that use the explicit name. */
  audioBuffer: Buffer | null;
  error?: ProviderErrorInfo;
}

export interface QwenTtsProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  websocketUrl?: string;
  workspaceId?: string;
  /**
   * Test-only escape hatch for an explicitly local HTTP endpoint. Remote
   * credentialed endpoints remain HTTPS-only regardless of this flag.
   */
  allowInsecureLoopback?: boolean;
  model?: string;
  voice?: string;
  timeoutMs?: number;
  fetchImpl?: typeof globalThis.fetch;
  /** Alias retained for tests and callers that use the platform name. */
  fetch?: typeof globalThis.fetch;
  websocketFactory?: (url: string, options: { headers: Record<string, string> }) => {
    on(event: string, listener: (...args: any[]) => void): void;
    send(data: string): void;
    close(): void;
    terminate?(): void;
  };
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export interface TtsProviderStatus {
  provider: string;
  configured: boolean;
  mock: boolean;
  baseUrl: string;
  model: string;
  voice: string;
  language: "Chinese";
  timeoutMs: number;
}

export const SCENE_INSTRUCTIONS: Readonly<Record<ScenePreset, string>> = Object.freeze({
  late_night: "用普通话中文，以舒展、温和、留有停顿的放松陪伴语气播报。",
  study: "用普通话中文，以平稳、清晰、变化较小的专注陪伴语气播报，避免打断注意力。",
  workout: "用普通话中文，以明快、有动力、节奏清楚的运动语气播报，但不要喊叫。",
  commute: "用普通话中文，以自然、清楚、轻快的律动语气播报，跟随节拍推进。",
  party: "用普通话中文，以活泼、热情、有感染力的聚会语气播报，但保持同一主持声线。",
});

export function sceneInstruction(scenePreset: ScenePreset): string {
  return SCENE_INSTRUCTIONS[scenePreset];
}

export function isScenePreset(value: unknown): value is ScenePreset {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(SCENE_INSTRUCTIONS, value);
}

export interface HostProvider {
  generate(context: HostContextPack, options?: HostGenerationOptions): Promise<HostGenerationResult>;
  generateShow?(request: HostShowGenerationRequest, options?: HostGenerationOptions): Promise<HostShowGenerationResult>;
  research?(request: MusicResearchRequest, options?: HostGenerationOptions): Promise<MusicResearchFact[]>;
  generatePlaylistNames?(request: PlaylistNamingRequest, options?: HostGenerationOptions): Promise<PlaylistNamingResult>;
  getStatus(): HostProviderStatus;
}

export interface TtsProvider {
  synthesize(request: TtsSynthesisRequest): Promise<TtsResult>;
  getStatus(): TtsProviderStatus;
}
