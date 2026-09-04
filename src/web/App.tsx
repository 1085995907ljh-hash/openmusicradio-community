import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronDown,
  Clock3,
  Disc3,
  Download,
  ExternalLink,
  HardDrive,
  Heart,
  Info,
  ListMusic,
  BookOpen,
  Send,
  LoaderCircle,
  Mic2,
  Music2,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Settings2,
  SkipForward,
  SlidersHorizontal,
  Sparkles,
  Square,
  TriangleAlert,
  Trash2,
  Upload,
  UserRound,
  Volume2,
  Wifi,
  X,
  Zap,
} from "lucide-react";
import {
  SCENE_PRESETS,
  type CapabilityState,
  type HostContextPack,
  type HostSegment,
  type ProgramSpec,
  type ProgramRundownItem,
  type ProgramState,
  type ScenePreset,
  type SourceDiagnostic,
  type SourceId,
  type Track,
} from "../shared/contracts";
import {
  DEFAULT_HOST_PROFILE,
  HOST_PROFILE_IDS,
  HOST_PROFILES,
  hostDurationReachedCueUrl,
  MAX_MUSIC_GENRES,
  MUSIC_GENRE_IDS,
  MUSIC_GENRES,
  type HostProfileId,
  type MusicGenreId,
} from "../shared/program-options";
import { FIXTURE_TRACKS } from "../core/fixtures";
import {
  HOST_MUSIC_DUCK_VOLUME,
  HOST_MUSIC_RESTORE_DURATION_MS,
  HOST_MUSIC_START_DELAY_SECONDS,
  releaseTitlesMatch,
} from "../core/host-script-planning";
import { advanceEnvelopeElapsed, envelopeVolume, musicBedDelayRemainingMs } from "./audio-envelope.js";
import { RadioHostAvatar } from "./RadioHostPet";
import { resolveRadioHostPetMood } from "./radio-host-pet.js";
import { isBroadcastNavigationLocked } from "./topbar-policy.js";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  type ReactNode,
  type CSSProperties,
} from "react";
import Meyda, { type MeydaFeaturesObject } from "meyda";

type View = "setup" | "settings" | "generating" | "confirm" | "preparing" | "on_air" | "ended";
type TransportState = "idle" | "loading" | "ready" | "failed";
type SettingsSection = "accounts" | "ai" | "playback" | "data" | "local";
type FeedbackTone = "success" | "info" | "warning";

interface AppNotice {
  id: string;
  message: string;
  tone: FeedbackTone;
  persistent: boolean;
}

interface HealthState {
  ok: boolean;
  version?: string;
  uptimeSeconds?: number;
  checkedAt?: string;
  providers?: {
    host?: { configured?: boolean; state?: string };
    tts?: { configured?: boolean; state?: string };
  };
}

interface ReportEvent {
  id: string;
  at: string;
  label: string;
  detail: string;
  tone?: "neutral" | "success" | "warning" | "error";
}

interface PlannerChatMessage {
  id: string;
  role: "assistant" | "user";
  text: string;
}

interface PlanUpdateResult {
  ok: boolean;
  message: string;
}

interface LocalProgram extends ProgramState {
  localOnly?: boolean;
  report: ReportEvent[];
}

interface HostPreviewResponse {
  success?: boolean;
  host?: Partial<HostSegment> & { text?: string | null; status?: string; success?: boolean; factIds?: string[]; mock?: boolean; error?: { code?: string } };
  audio?: { status?: string; url?: string | null; audioId?: string | null };
}

type DesktopPlayerSource = "qq_music" | "netease_music";

interface DesktopPlayerResponse {
  player?: {
    sourceId?: DesktopPlayerSource;
    state?: string;
    ok?: boolean;
    operationId?: string | null;
    detail?: string;
    appRunning?: boolean;
    playing?: boolean | null;
  };
}

interface MusicApiStatusResponse {
  status?: {
    configured?: boolean;
    state?: string;
    authenticated?: boolean;
    persistentLogin?: boolean;
  };
}

interface AiConfigStatus {
  llm: { provider: "openai" | "deepseek" | "qwen" | "anthropic" | "gemini" | "custom"; model: string; reviewModel?: string; reasoningEffort?: "low" | "medium" | "high"; baseUrl?: string; hasKey: boolean };
  tts: { provider: "qwen" | "openai" | "azure"; model: string; voice: string; baseUrl?: string; region?: string; workspaceId?: string; hasKey: boolean };
}

interface InvitationAccessStatus {
  configured: boolean;
  connected: boolean;
  state: "unconfigured" | "invitation_required" | "connected" | "unreachable";
  user?: { id: string; displayName: string };
  device?: { id: string; name: string };
  service?: { llmModel: string; ttsModel: string; managed: true };
  detail?: string;
}

function feedbackPolicy(message: string): Pick<AppNotice, "tone" | "persistent"> {
  const warning = /失败|不可用|无法|未收到|失效|超时|跳过|重试|丢失|中断|停止|暂时|仍在|直接开始|请点击|请重新|请稍候/.test(message);
  if (warning) {
    return {
      tone: "warning",
      persistent: /请点击|请重新|无法恢复|未收到|已停止|仍在完成|失效/.test(message),
    };
  }
  const success = /已完成|已保存|已更新|已恢复|已准备好|正常|已发送/.test(message);
  return { tone: success ? "success" : "info", persistent: false };
}

const LOCAL_ONBOARDING_COMPLETE_KEY = "openmusicradio.onboarding-complete.v1";

interface DeviceStatus {
  storage: { audio: { entries: number; bytes: number }; profiles: { files: number; bytes: number } };
  desktopPet: { scale: "small" | "medium" | "large"; positionSaved: boolean; available: boolean };
}

interface AudioOutputOption {
  id: string;
  label: string;
}

type ApiMusicSource = "qq_music" | "netease_music";
type QqLoginType = "mobile";

interface MusicQrLogin {
  key: string;
  qrImageDataUrl: string;
  state?: "waiting_scan" | "waiting_confirm";
  loginType?: QqLoginType;
}

const DURATION_OPTIONS = [30, 45, 60, 90, 120] as const;
const HOST_DENSITY_OPTIONS = [
  { value: "low", label: "低", detail: "口播较少，歌曲之间留出更多空间" },
  { value: "medium", label: "中", detail: "口播适中，每几首歌自然衔接一次" },
  { value: "high", label: "高", detail: "口播较多，持续串联节目氛围" },
] as const;
const FAMILIARITY_OPTIONS = [
  { value: 80, label: "多放熟悉", detail: "约八成是你听过的歌" },
  { value: 40, label: "平衡推荐", detail: "约四成熟悉，其余拓展" },
  { value: 10, label: "多点探索", detail: "约九成是新歌" },
] as const;
type RecommendationMode = NonNullable<ProgramSpec["recommendationMode"]>;
const RECOMMENDATION_MODE_OPTIONS = [
  { value: "atmosphere", label: "按氛围推荐", detail: "AI 按场景情绪选歌，并编排曲序" },
  { value: "genre", label: "按风格推荐", detail: "选择音乐风格，AI 围绕风格找歌" },
] as const satisfies readonly { value: RecommendationMode; label: string; detail: string }[];
const GENRE_MODE_DEFAULT_SCENE: ScenePreset = "commute";

const USER_SOURCE_IDS = ["qq_music", "netease_music"] as const;
const LOCAL_PROGRAM_DEFAULTS_KEY = "openmusicradio.program-defaults.v1";
const LOCAL_AUDIO_OUTPUT_KEY = "openmusicradio.audio-output.v1";

interface LocalProgramDefaults {
  sourceId?: SourceId;
  durationMinutes?: number;
  recommendationMode?: RecommendationMode;
  scenePreset?: ScenePreset;
  hostDensity?: ProgramSpec["hostDensity"];
  hostProfile?: HostProfileId;
  musicGenres?: MusicGenreId[];
  desktopPetEnabled?: boolean;
  familiarityRatio?: number;
}

function normalizeLocalProgramDefaults(input: unknown): LocalProgramDefaults {
  try {
    const value = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    const sourceId = USER_SOURCE_IDS.includes(value.sourceId as (typeof USER_SOURCE_IDS)[number]) ? value.sourceId as SourceId : undefined;
    const durationMinutes = DURATION_OPTIONS.includes(value.durationMinutes as (typeof DURATION_OPTIONS)[number]) ? value.durationMinutes as number : undefined;
    const scenePreset = SCENE_PRESETS.includes(value.scenePreset as ScenePreset) ? value.scenePreset as ScenePreset : undefined;
    const hostDensity = ["low", "medium", "high"].includes(String(value.hostDensity)) ? value.hostDensity as ProgramSpec["hostDensity"] : undefined;
    const hostProfile = HOST_PROFILE_IDS.includes(value.hostProfile as HostProfileId) ? value.hostProfile as HostProfileId : undefined;
    const musicGenres = Array.isArray(value.musicGenres) ? value.musicGenres.filter((item): item is MusicGenreId => MUSIC_GENRE_IDS.includes(item as MusicGenreId)).slice(0, MAX_MUSIC_GENRES) : undefined;
    const recommendationMode = value.recommendationMode === "atmosphere" || value.recommendationMode === "genre"
      ? value.recommendationMode as RecommendationMode
      : (musicGenres?.length ?? 0) > 0 ? "genre" : undefined;
    const desktopPetEnabled = typeof value.desktopPetEnabled === "boolean" ? value.desktopPetEnabled : undefined;
    const familiarityRatio = typeof value.familiarityRatio === "number" && Number.isFinite(value.familiarityRatio) ? Math.max(0, Math.min(100, value.familiarityRatio)) : undefined;
    return { sourceId, durationMinutes, recommendationMode, scenePreset, hostDensity, hostProfile, musicGenres, desktopPetEnabled, familiarityRatio };
  } catch {
    return {};
  }
}

function readLocalProgramDefaults(): LocalProgramDefaults {
  try {
    return normalizeLocalProgramDefaults(JSON.parse(window.localStorage.getItem(LOCAL_PROGRAM_DEFAULTS_KEY) ?? "{}"));
  } catch {
    return {};
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const SOURCE_LABELS: Record<SourceId, string> = {
  fixture: "本地测试信号",
  qq_music: "QQ 音乐",
  netease_music: "网易云音乐",
};

const SOURCE_SHORT_LABELS: Record<SourceId, string> = {
  fixture: "本地测试",
  qq_music: "QQ 音乐",
  netease_music: "网易云",
};

const SCENE_META: Record<ScenePreset, { label: string; hint: string; curve: string; density: ProgramSpec["hostDensity"] }> = {
  late_night: { label: "放松", hint: "舒展、柔和、留白", curve: "舒缓 → 轻柔提升", density: "low" },
  study: { label: "专注", hint: "稳定、克制、不打扰", curve: "稳定 · 低波动", density: "low" },
  workout: { label: "运动", hint: "铺垫、高潮、放松", curve: "上升 → 高峰 → 释放", density: "medium" },
  commute: { label: "律动", hint: "节拍清晰、自然推进", curve: "平稳 → 明亮", density: "medium" },
  party: { label: "派对", hint: "让现场保持活力", curve: "明亮 → 高能", density: "high" },
};

const HOST_PERSONALITY_COPY: Record<HostProfileId, string> = {
  longhao: "耐心、细腻，擅长把复杂的话说得轻松自然。",
  xiaocheng: "理性克制，喜欢用清楚的信息建立可靠感。",
  longxin: "清爽、有活力，适合把节目讲得明亮又不油。",
  anxuan: "爽朗直接，表达有力量，也很会照顾现场节奏。",
  anya: "观察敏锐，措辞有分寸，偶尔带一点冷幽默。",
  anran: "好奇外向，反应很快，很容易把气氛带热。",
};

const FALLBACK_SOURCES: SourceDiagnostic[] = [
  {
    sourceId: "fixture",
    label: "本地测试信号",
    playbackReady: true,
    hostedProgramAllowed: true,
    state: "ready",
    detail: "本地确定性信号，仅用于视觉载体，不输出音乐音频。",
    checkedAt: new Date().toISOString(),
  },
  {
    sourceId: "qq_music",
    label: "QQ 音乐",
    playbackReady: false,
    hostedProgramAllowed: false,
    state: "failed_technical",
    detail: "本机连接诊断暂不可用。",
    checkedAt: new Date().toISOString(),
  },
  {
    sourceId: "netease_music",
    label: "网易云音乐",
    playbackReady: false,
    hostedProgramAllowed: false,
    state: "failed_technical",
    detail: "本机连接诊断暂不可用。",
    checkedAt: new Date().toISOString(),
  },
];

const API_PREFIX = "/api";

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function formatClock(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function formatTrackDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function humanState(state: CapabilityState) {
  const labels: Record<CapabilityState, string> = {
    ready: "可用",
    missing_credentials: "需要授权",
    blocked_by_credentials: "授权受阻",
    blocked_by_policy: "策略限制",
    blocked_by_policy_review: "等待策略审查",
    blocked_by_official_access: "官方访问受阻",
    blocked_by_terms: "条款限制",
    failed_technical: "技术故障",
    unsupported: "暂不支持",
  };
  return labels[state];
}

function statusTone(state: CapabilityState) {
  if (state === "ready") return "ready";
  if (state.startsWith("blocked") || state === "missing_credentials" || state === "blocked_by_terms") return "blocked";
  if (state === "failed_technical") return "error";
  return "muted";
}

function programPhaseLabel(status: ProgramState["status"]) {
  const labels: Record<ProgramState["status"], string> = {
    draft: "草稿",
    awaiting_confirmation: "等待确认",
    preparing: "准备中",
    on_air: "播出中",
    closing: "收尾中",
    completed: "已完成",
    stopped: "已停止",
    failed: "失败",
    control_lost: "控制已丢失",
    stop_unconfirmed: "停止未确认",
  };
  return labels[status];
}

function phaseFromRemaining(program: ProgramState) {
  const total = Math.max(1, program.spec.durationMinutes * 60);
  const progress = 1 - Math.max(0, program.remainingSeconds) / total;
  if (progress < 0.12) return "opening";
  if (progress < 0.52) return "building";
  if (progress < 0.78) return "peak";
  if (progress < 0.95) return "cooldown";
  return "closing";
}

function phaseLabel(phase: string) {
  const labels: Record<string, string> = { opening: "开场", building: "推进", peak: "高峰", cooldown: "降温", closing: "收尾" };
  return labels[phase] ?? phase;
}

function hostCadenceSeconds(scenePreset: ScenePreset): number {
  // Desktop clients do not expose track duration yet; use a conservative
  // 1-2-song time window until the read-only current-track bridge is added.
  return scenePreset === "party" ? 150 : scenePreset === "workout" ? 180 : 240;
}

function makeSpec(sourceId: SourceId, durationMinutes: number, recommendationMode: RecommendationMode, scenePreset: ScenePreset, hostDensity: ProgramSpec["hostDensity"], hostProfile: HostProfileId, musicGenres: MusicGenreId[], desktopPetEnabled: boolean): ProgramSpec {
  const selectedGenres = recommendationMode === "genre" ? musicGenres.slice(0, MAX_MUSIC_GENRES) : [];
  return {
    sourceId,
    durationMinutes,
    recommendationMode,
    scenePreset,
    sceneDescription: "",
    hostDensity,
    energyCurve: SCENE_META[scenePreset].curve,
    avoid: [],
    familiarityRatio: 40,
    hostProfile,
    musicGenres: selectedGenres,
    desktopPetEnabled,
  };
}

function programRecommendationLabel(spec: ProgramSpec): string {
  const mode = spec.recommendationMode === "genre" || (spec.musicGenres?.length ?? 0) > 0 ? "genre" : "atmosphere";
  if (mode === "genre") {
    const labels = (spec.musicGenres ?? []).map((genreId) => MUSIC_GENRES[genreId].label);
    return labels.length > 0 ? `按风格: ${labels.join(" / ")}` : "按风格";
  }
  return `按氛围: ${SCENE_META[spec.scenePreset].label}`;
}

function makeLocalProgram(spec: ProgramSpec): LocalProgram {
  const startedAt = nowIso();
  const deadlineAt = new Date(Date.now() + spec.durationMinutes * 60_000).toISOString();
  const [currentTrack, ...rest] = FIXTURE_TRACKS;
  return {
    id: makeId("fixture-program"),
    generation: 1,
    status: "on_air",
    spec,
    startedAt,
    deadlineAt,
    remainingSeconds: spec.durationMinutes * 60,
    currentTrack,
    nextTrack: rest[0] ?? null,
    queue: rest,
    host: null,
    recentHostLines: [],
    error: null,
    localOnly: true,
    report: [
      { id: makeId("event"), at: startedAt, label: "测试信号已启动", detail: "视觉载体已激活，不输出音乐音频。", tone: "success" },
      { id: makeId("event"), at: startedAt, label: "节目已确认", detail: `${spec.durationMinutes} 分钟 · ${SCENE_META[spec.scenePreset].label}`, tone: "success" },
    ],
  };
}

function makeLocalDraft(spec: ProgramSpec): LocalProgram {
  return {
    id: makeId("fixture-draft"),
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
    localOnly: true,
    report: [{ id: makeId("event"), at: nowIso(), label: "计划已在本地创建", detail: "服务不可用；启动测试信号前仍需完成确认。", tone: "warning" }],
  };
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_PREFIX}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = (await response.json().catch(() => null)) as T | { error?: string } | null;
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body ? body.error : undefined;
    const fallbackMessage = response.status === 502 || response.status === 503
      ? "本地服务暂时断开，正在恢复；请稍后重试。"
      : `请求失败（${response.status}）`;
    const error = new Error(message || fallbackMessage) as Error & { code?: string; status?: number };
    if (body && typeof body === "object" && "code" in body && typeof body.code === "string") error.code = body.code;
    error.status = response.status;
    throw error;
  }
  return body as T;
}

function readSourcePayload(payload: unknown): SourceDiagnostic[] {
  if (Array.isArray(payload)) return payload as SourceDiagnostic[];
  if (payload && typeof payload === "object") {
    const candidate = payload as { sources?: unknown; data?: unknown };
    if (Array.isArray(candidate.sources)) return candidate.sources as SourceDiagnostic[];
    if (Array.isArray(candidate.data)) return candidate.data as SourceDiagnostic[];
  }
  return [];
}

function hostResultFailed(host: HostPreviewResponse["host"] | undefined) {
  const status = typeof host?.status === "string" ? host.status.toLowerCase() : "";
  return host?.success === false || status === "failed" || status.startsWith("failed_");
}

function readProgramPayload(payload: unknown): ProgramState | null {
  if (!payload || typeof payload !== "object") return null;
  const candidate = payload as { program?: unknown; state?: unknown; data?: unknown };
  const state = candidate.program ?? candidate.state ?? candidate.data ?? payload;
  if (!state || typeof state !== "object") return null;
  const value = state as ProgramState;
  if (typeof value.status !== "string" || !value.spec) return null;
  return USER_SOURCE_IDS.includes(value.spec.sourceId as (typeof USER_SOURCE_IDS)[number]) ? value : null;
}

function confirmRetryMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message.trim() : "";
  const detail = raw && raw !== "确认状态未知。" && raw !== "未观察到确认结果"
    ? raw.replace(/[。；;\s]+$/, "")
    : "开播准备没有完成";
  return `${detail}。歌曲和口播已保留，可以重新确认。`;
}

function readHostRetryPayload(payload: unknown): { required: boolean; message?: string } {
  if (!payload || typeof payload !== "object") return { required: false };
  const candidate = payload as { hostRetryRequired?: unknown; message?: unknown };
  return {
    required: candidate.hostRetryRequired === true,
    ...(typeof candidate.message === "string" && candidate.message.trim() ? { message: candidate.message.trim() } : {}),
  };
}

function isApiMusicSource(sourceId: SourceId | undefined): sourceId is ApiMusicSource {
  return sourceId === "qq_music" || sourceId === "netease_music";
}

function hasLockedMusicArtifacts(program: ProgramState) {
  const rundown = program.rundown ?? [];
  const hostMoments = rundown.filter((track) => Boolean(track.hostMoment));
  return rundown.length > 0
    && Boolean(program.planSummary)
    && Boolean(program.listenerProfile)
    && hostMoments.length > 0
    && hostMoments.every((track) => Boolean(track.hostScript?.text));
}

function viewForProgramStatus(status: ProgramState["status"]): View {
  if (status === "draft" || status === "awaiting_confirmation") return "confirm";
  if (status === "preparing") return "preparing";
  if (status === "on_air" || status === "closing") return "on_air";
  return "ended";
}

function mergePolledProgram(current: LocalProgram, remote: ProgramState): LocalProgram {
  const sameItem = current.id === remote.id
    && current.generation === remote.generation
    && current.currentTrack?.id === remote.currentTrack?.id;
  const remoteHostLines = Array.isArray(remote.recentHostLines) ? remote.recentHostLines : [];
  return {
    ...current,
    ...remote,
    host: sameItem ? (remote.host ?? current.host) : remote.host,
    recentHostLines: sameItem && remoteHostLines.length === 0
      ? current.recentHostLines
      : remoteHostLines,
    report: current.report,
  };
}

function canMergeRemoteProgram(current: LocalProgram, remote: ProgramState): boolean {
  if (current.id !== remote.id || remote.generation < current.generation) return false;
  if (remote.generation > current.generation) return true;
  const statusRank = (status: ProgramState["status"]) => {
    if (status === "draft" || status === "awaiting_confirmation") return 0;
    if (status === "preparing") return 1;
    if (status === "on_air") return 2;
    if (status === "closing") return 3;
    return 4;
  };
  if (statusRank(remote.status) < statusRank(current.status)) return false;
  const terminalStatuses = new Set(["completed", "stopped", "failed", "control_lost", "stop_unconfirmed"]);
  if (terminalStatuses.has(current.status) && !terminalStatuses.has(remote.status)) return false;
  return !current.currentTrack?.id || !remote.currentTrack?.id || current.currentTrack.id === remote.currentTrack.id;
}

function mergeRemoteProgramIfCurrent(current: LocalProgram, remote: ProgramState): LocalProgram {
  return canMergeRemoteProgram(current, remote) ? mergePolledProgram(current, remote) : current;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return reduced;
}

async function fetchProgramWithTimeout(programId: string, timeoutMs: number, parentSignal?: AbortSignal): Promise<ProgramState | null> {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  if (parentSignal?.aborted) controller.abort();
  parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return readProgramPayload(await fetchJson<unknown>(`/programs/${programId}`, { signal: controller.signal }));
  } finally {
    window.clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

async function waitForConfirmedProgram(programId: string, signal: AbortSignal, deadlineMs = 15 * 60_000): Promise<ProgramState> {
  const deadlineAt = Date.now() + deadlineMs;
  while (!signal.aborted && Date.now() < deadlineAt) {
    try {
      const remainingMs = Math.max(1, deadlineAt - Date.now());
      const remote = await fetchProgramWithTimeout(programId, Math.min(5_000, remainingMs), signal);
      if (remote && !["draft", "awaiting_confirmation", "preparing"].includes(remote.status)) return remote;
    } catch (error) {
      if (signal.aborted) throw error;
      // The confirm request remains authoritative. A transient observation
      // failure must not cancel an otherwise healthy local transaction.
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        window.clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      const timer = window.setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, 800);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  throw new Error("开播准备超过 15 分钟，已停止等待并开始核对服务状态。");
}

function Tooltip({ children, text }: { children: ReactNode; text: string }) {
  return <span className="tooltip-wrap" data-tooltip={text}>{children}</span>;
}

function IconButton({ label, children, onClick, disabled, className = "", type = "button" }: { label: string; children: ReactNode; onClick?: () => void; disabled?: boolean; className?: string; type?: "button" | "submit" }) {
  return (
    <Tooltip text={label}>
      <button className={`icon-button ${className}`} type={type} aria-label={label} title={label} onClick={onClick} disabled={disabled}>
        {children}
      </button>
    </Tooltip>
  );
}

function StatusDot({ tone = "ready" }: { tone?: "ready" | "blocked" | "error" | "muted" }) {
  return <span className={`status-dot status-dot-${tone}`} aria-hidden="true" />;
}

function App() {
  const [initialProgramDefaults] = useState(readLocalProgramDefaults);
  const [showLanding, setShowLanding] = useState(() => !new URLSearchParams(window.location.search).has("skipIntro"));
  const landingEnteredRef = useRef(false);
  const landingFocusPendingRef = useRef(false);
  const [view, setView] = useState<View>("setup");
  const [setupPhase, setSetupPhase] = useState<"connect" | "settings">("connect");
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("accounts");
  const [sources, setSources] = useState<SourceDiagnostic[]>(FALLBACK_SOURCES.filter((source) => USER_SOURCE_IDS.includes(source.sourceId as (typeof USER_SOURCE_IDS)[number])));
  const [sourceTransport, setSourceTransport] = useState<TransportState>("loading");
  const [health, setHealth] = useState<HealthState>({ ok: false });
  const [selectedSource, setSelectedSource] = useState<SourceId>(initialProgramDefaults.sourceId ?? "qq_music");
  const [durationMinutes, setDurationMinutes] = useState<number>(initialProgramDefaults.durationMinutes ?? 30);
  const [recommendationMode, setRecommendationMode] = useState<RecommendationMode>(initialProgramDefaults.recommendationMode ?? ((initialProgramDefaults.musicGenres?.length ?? 0) > 0 ? "genre" : "atmosphere"));
  const [scenePreset, setScenePreset] = useState<ScenePreset>(initialProgramDefaults.scenePreset ?? "late_night");
  const [hostDensity, setHostDensity] = useState<ProgramSpec["hostDensity"]>(initialProgramDefaults.hostDensity ?? "low");
  const [hostProfile, setHostProfile] = useState<HostProfileId>(initialProgramDefaults.hostProfile ?? DEFAULT_HOST_PROFILE);
  const [musicGenres, setMusicGenres] = useState<MusicGenreId[]>(initialProgramDefaults.musicGenres ?? []);
  const [desktopPetEnabled, setDesktopPetEnabled] = useState(initialProgramDefaults.desktopPetEnabled ?? false);
  const [familiarityRatio, setFamiliarityRatio] = useState(initialProgramDefaults.familiarityRatio ?? 40);
  const [audioOutputId, setAudioOutputId] = useState(() => window.localStorage.getItem(LOCAL_AUDIO_OUTPUT_KEY) || "default");
  const [program, setProgram] = useState<LocalProgram | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [notice, setNoticeState] = useState<AppNotice | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [planUpdating, setPlanUpdating] = useState(false);
  const [keepPlaylist, setKeepPlaylist] = useState(false);
  const [playlistSavePromptOpen, setPlaylistSavePromptOpen] = useState(false);
  const [isNexting, setIsNexting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [likePendingTrackId, setLikePendingTrackId] = useState<string | null>(null);
  const [likeConfirmPrompt, setLikeConfirmPrompt] = useState<{ trackId: string; trackTitle: string; sourceId: ApiMusicSource; liked: boolean } | null>(null);
  const [showSourceDetails, setShowSourceDetails] = useState(false);
  const [showPlaylist, setShowPlaylist] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now());
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [trackElapsedSeconds, setTrackElapsedSeconds] = useState(0);
  const [trackDurationSeconds, setTrackDurationSeconds] = useState(0);
  const [audioNeedsGesture, setAudioNeedsGesture] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [hostPreviewPending, setHostPreviewPending] = useState(false);
  const [hostRetryNonce, setHostRetryNonce] = useState(0);
  const [desktopControlPending, setDesktopControlPending] = useState<"toggle" | "next" | null>(null);
  const [desktopPlayers, setDesktopPlayers] = useState<Partial<Record<DesktopPlayerSource, DesktopPlayerResponse["player"]>>>({});
  const [musicApiStatus, setMusicApiStatus] = useState<Partial<Record<ApiMusicSource, MusicApiStatusResponse["status"]>>>({});
  const [musicQrLogin, setMusicQrLogin] = useState<({ sourceId: ApiMusicSource } & MusicQrLogin) | null>(null);
  const [musicLoginPending, setMusicLoginPending] = useState(false);
  const [musicPreferencesState, setMusicPreferencesState] = useState<TransportState>("idle");
  const [aiConfig, setAiConfig] = useState<AiConfigStatus | null>(null);
  const [aiConfigPending, setAiConfigPending] = useState(true);
  const [invitationAccess, setInvitationAccess] = useState<InvitationAccessStatus | null>(null);
  const [invitationPending, setInvitationPending] = useState(false);
  const [aiTestTarget, setAiTestTarget] = useState<"llm" | "tts" | null>(null);
  const [localOnboardingComplete, setLocalOnboardingComplete] = useState(() => window.localStorage.getItem(LOCAL_ONBOARDING_COMPLETE_KEY) === "true");
  const [connectionReviewOpen, setConnectionReviewOpen] = useState(false);
  const [voicePreviewProfile, setVoicePreviewProfile] = useState<HostProfileId | null>(null);
  const [processComplete, setProcessComplete] = useState(false);
  const [processCompletedSteps, setProcessCompletedSteps] = useState(0);
  const [hostScriptRetryMessage, setHostScriptRetryMessage] = useState<string | null>(null);
  const [hostScriptRetryPending, setHostScriptRetryPending] = useState(false);
  const setNotice = useCallback((message: string | null) => {
    if (!message) {
      setNoticeState(null);
      return;
    }
    setNoticeState({ id: makeId("feedback"), message, ...feedbackPolicy(message) });
  }, []);
  useEffect(() => {
    if (!notice || notice.persistent) return;
    const duration = notice.tone === "success" ? 2_800 : notice.tone === "info" ? 4_000 : 6_000;
    const timer = window.setTimeout(() => {
      setNoticeState((current) => current?.id === notice.id ? null : current);
    }, duration);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const musicAudioRef = useRef<HTMLAudioElement | null>(null);
  const voicePreviewAudioRef = useRef<HTMLAudioElement | null>(null);
  const durationCueAudioRef = useRef<HTMLAudioElement | null>(null);
  const voicePreviewBusyRef = useRef(false);
  const cancelVoicePreview = useCallback(() => {
    const preview = voicePreviewAudioRef.current;
    voicePreviewAudioRef.current = null;
    if (preview) {
      preview.pause();
      preview.currentTime = 0;
      preview.removeAttribute("src");
      preview.load();
    }
    voicePreviewBusyRef.current = false;
    setVoicePreviewProfile(null);
  }, []);
  const audioTokenRef = useRef(0);
  const musicAudioTokenRef = useRef(0);
  const musicVolumeRampRef = useRef<number | null>(null);
  const hostMusicStartTimerRef = useRef<number | null>(null);
  const webDuckOwnerRef = useRef<string | null>(null);
  const hostAudioSourceRef = useRef<{ key: string; url: string; token: number } | null>(null);
  const musicFailureRef = useRef<{ key: string; attempts: number } | null>(null);
  const nextInFlightRef = useRef(false);
  const nextRetryTimerRef = useRef<number | null>(null);
  const seamlessMusicKeyRef = useRef<string | null>(null);
  const handleNextRef = useRef<(naturalEnd?: boolean, retryAttempt?: number) => Promise<void>>(async () => undefined);
  const fixtureAudioRef = useRef<{ url: string; key: string } | null>(null);
  const pendingAudioRef = useRef<{ url: string; key: string; mode: "fixture" | "host"; loop: boolean; sourceId?: DesktopPlayerSource } | null>(null);
  const pendingMusicRef = useRef<{ url: string; key: string } | null>(null);
  const ttsEndedRef = useRef<(() => void) | null>(null);
  const hostRequestRef = useRef<{ key: string; controller: AbortController } | null>(null);
  const hostRetryRef = useRef<{ key: string; attempts: number } | null>(null);
  const hostRetryTimerRef = useRef<number | null>(null);
  const hostPlaybackWatchdogRef = useRef<number | null>(null);
  const heartbeatRequestRef = useRef<AbortController | null>(null);
  const programPollRequestRef = useRef<AbortController | null>(null);
  const hostKeyRef = useRef<string | null>(null);
  const remainingSecondsRef = useRef(0);
  const activeDuckRef = useRef<{ sourceId: DesktopPlayerSource; operationId: string } | null>(null);
  const restorePromiseRef = useRef<{ operationId: string; promise: Promise<boolean> } | null>(null);
  const pendingDuckRef = useRef<{ sourceId: DesktopPlayerSource; operationId: string; cancelled: boolean } | null>(null);
  const sourceRefreshTokenRef = useRef(0);
  const sourceAutoSelectDoneRef = useRef(false);
  const createOperationRef = useRef<{ id: string; spec: string } | null>(null);
  const currentAudioModeRef = useRef<{ mode: "fixture" | "host"; key: string; sourceId?: DesktopPlayerSource } | null>(null);
  const programRef = useRef<LocalProgram | null>(null);
  const desktopPetRevisionRef = useRef(0);
  const desktopPetSessionRef = useRef<{ id: string; startedAt: number; programId: string } | null>(null);
  const durationReachedNoticeRef = useRef<string | null>(null);
  const settingsReturnViewRef = useRef<View>("setup");
  programRef.current = program;

  useEffect(() => {
    window.localStorage.setItem(LOCAL_AUDIO_OUTPUT_KEY, audioOutputId);
    let disposed = false;
    const applyOutput = async () => {
      const elements = [musicAudioRef.current, audioRef.current, durationCueAudioRef.current].filter((item): item is HTMLAudioElement => Boolean(item));
      try {
        await Promise.all(elements.map(async (element) => {
          const sinkElement = element as HTMLAudioElement & { setSinkId?: (sinkId: string) => Promise<void> };
          if (typeof sinkElement.setSinkId === "function") await sinkElement.setSinkId(audioOutputId);
        }));
      } catch {
        if (!disposed && audioOutputId !== "default") {
          setAudioOutputId("default");
          setLastError("所选音频设备已经不可用，已恢复为系统默认输出。");
        }
      }
    };
    void applyOutput();
    return () => { disposed = true; };
  }, [audioOutputId]);

  useEffect(() => {
    try {
      window.localStorage.setItem(LOCAL_PROGRAM_DEFAULTS_KEY, JSON.stringify({
        sourceId: selectedSource,
        durationMinutes,
        recommendationMode,
        scenePreset,
        hostDensity,
        hostProfile,
        musicGenres: recommendationMode === "genre" ? musicGenres.slice(0, MAX_MUSIC_GENRES) : [],
        desktopPetEnabled,
        familiarityRatio,
      } satisfies LocalProgramDefaults));
    } catch {
      // The current session remains usable when browser storage is unavailable.
    }
  }, [desktopPetEnabled, durationMinutes, familiarityRatio, hostDensity, hostProfile, musicGenres, recommendationMode, scenePreset, selectedSource]);

  const selectedDiagnostic = sources.find((source) => source.sourceId === selectedSource)
    ?? FALLBACK_SOURCES.find((source) => source.sourceId === selectedSource)
    ?? FALLBACK_SOURCES.find((source) => source.sourceId === "qq_music")!;
  const selectedMusicApiStatus = isApiMusicSource(selectedSource) ? musicApiStatus[selectedSource] : undefined;
  const aiConnectionReady = invitationAccess?.connected === true;
  const musicConnectionVerified = Boolean(isApiMusicSource(selectedSource) && selectedMusicApiStatus?.authenticated === true);
  const initializationReady = musicConnectionVerified && aiConnectionReady;
  const createBlocker = !aiConnectionReady
    ? "请先完成邀请码验证。"
    : recommendationMode === "genre" && musicGenres.length === 0
      ? "按风格推荐时，请至少选择一种音乐风格。"
      : isApiMusicSource(selectedSource)
        ? selectedMusicApiStatus?.authenticated !== true
          ? `请先在连接页完成${SOURCE_LABELS[selectedSource]}扫码授权。`
          : selectedMusicApiStatus?.state !== "ready"
            ? `${SOURCE_LABELS[selectedSource]}连接正在检查，请返回连接页刷新后重试。`
            : !selectedDiagnostic.playbackReady || !selectedDiagnostic.hostedProgramAllowed
              ? `${SOURCE_LABELS[selectedSource]}音源尚未准备好，请返回连接页刷新。`
              : null
        : sourceTransport === "failed"
          ? "本机诊断不可用，请返回连接页刷新后重试。"
          : selectedDiagnostic.desktopState === "automation_denied"
            ? "请在系统设置的辅助功能中允许本机服务控制音乐客户端。"
            : selectedDiagnostic.desktopState === "screen_locked"
              ? "请先解锁 Mac，再创建主持节目。"
              : selectedDiagnostic.accountConnected !== true
                ? "请先打开桌面音乐客户端。"
                : !selectedDiagnostic.playbackReady || !selectedDiagnostic.hostedProgramAllowed
                  ? "当前音源尚不能创建主持节目。"
                  : null;
  const canCreate = createBlocker === null && !isCreating;
  const broadcastNavigationLocked = isBroadcastNavigationLocked(program?.status);
  const programActive = broadcastNavigationLocked;
  const remainingSeconds = useMemo(() => {
    if (!program) return 0;
    if (program.localOnly && program.deadlineAt && ["on_air", "preparing", "closing"].includes(program.status)) {
      return Math.max(0, Math.ceil((new Date(program.deadlineAt).getTime() - nowMs) / 1000));
    }
    return Math.max(0, Math.floor(program.remainingSeconds));
  }, [nowMs, program]);
  remainingSecondsRef.current = remainingSeconds;
  useEffect(() => {
    setTrackElapsedSeconds(0);
    setTrackDurationSeconds(program?.currentTrack?.durationSeconds ?? 0);
  }, [program?.currentTrack?.id, program?.generation]);
  useEffect(() => {
    if (!program || ["draft", "awaiting_confirmation"].includes(program.status)) return;
    const sessionAgeMs = desktopPetSessionRef.current ? Date.now() - desktopPetSessionRef.current.startedAt : Number.POSITIVE_INFINITY;
    if (desktopPetSessionRef.current?.programId !== program.id || sessionAgeMs >= 2 * 60 * 60 * 1_000) {
      desktopPetSessionRef.current = { id: crypto.randomUUID(), startedAt: Date.now(), programId: program.id };
      desktopPetRevisionRef.current = 0;
    }
    const mood = resolveRadioHostPetMood({
        view: view === "generating" || view === "preparing" || view === "settings" ? "setup" : view,
      programStatus: program.status,
      hostStatus: program.host?.status,
      creating: isCreating,
      hostPending: hostPreviewPending,
      audioPlaying,
      nexting: isNexting,
    });
    const petSession = desktopPetSessionRef.current;
    if (!petSession) return;
    const controllers = new Set<AbortController>();
    const postState = () => {
      const controller = new AbortController();
      controllers.add(controller);
      desktopPetRevisionRef.current += 1;
      void fetchJson("/desktop-pet/state", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          programId: program.id,
          generation: program.generation,
          trackId: program.currentTrack?.id,
          mood,
          revision: desktopPetRevisionRef.current,
          clientId: petSession.id,
          clientStartedAt: petSession.startedAt,
        }),
      }).catch(() => undefined).finally(() => controllers.delete(controller));
    };
    postState();
    const heartbeat = window.setInterval(postState, 2_000);
    return () => {
      window.clearInterval(heartbeat);
      for (const controller of controllers) controller.abort();
    };
  }, [audioPlaying, hostPreviewPending, isCreating, isNexting, program?.currentTrack?.id, program?.generation, program?.host?.status, program?.id, program?.status, view]);
  const scheduledDesktopHostSlot = program && !isApiMusicSource(program.spec.sourceId) && program.spec.sourceId !== "fixture"
    ? Math.floor(Math.max(0, program.spec.durationMinutes * 60 - remainingSeconds) / hostCadenceSeconds(program.spec.scenePreset))
    : 0;

  const rampMusicVolume = useCallback((target: number, durationMs: number) => {
    if (musicVolumeRampRef.current !== null) window.clearInterval(musicVolumeRampRef.current);
    musicVolumeRampRef.current = null;
    const music = musicAudioRef.current;
    if (!music) return;
    const start = music.volume;
    if (durationMs <= 0) {
      music.volume = target;
      return;
    }
    const stepMs = 50;
    let elapsedMs = 0;
    const tick = () => {
      if (musicAudioRef.current !== music) {
        if (musicVolumeRampRef.current !== null) window.clearInterval(musicVolumeRampRef.current);
        musicVolumeRampRef.current = null;
        return;
      }
      elapsedMs = advanceEnvelopeElapsed(elapsedMs, stepMs, durationMs);
      music.volume = Math.max(0, Math.min(1, envelopeVolume(start, target, elapsedMs, durationMs)));
      if (elapsedMs >= durationMs) {
        music.volume = target;
        if (musicVolumeRampRef.current !== null) window.clearInterval(musicVolumeRampRef.current);
        musicVolumeRampRef.current = null;
      }
    };
    musicVolumeRampRef.current = window.setInterval(tick, stepMs);
  }, []);

  const duckWebMusic = useCallback((owner: string) => {
    webDuckOwnerRef.current = owner;
    rampMusicVolume(HOST_MUSIC_DUCK_VOLUME, 0);
  }, [rampMusicVolume]);

  const restoreWebMusic = useCallback((owner?: string) => {
    if (owner && webDuckOwnerRef.current !== owner) return;
    webDuckOwnerRef.current = null;
    rampMusicVolume(1, HOST_MUSIC_RESTORE_DURATION_MS);
  }, [rampMusicVolume]);

  const restoreDuckOperation = useCallback((active: { sourceId: DesktopPlayerSource; operationId: string }) => {
    const inFlight = restorePromiseRef.current;
    if (inFlight?.operationId === active.operationId) return inFlight.promise;
    const entry = { operationId: active.operationId, promise: Promise.resolve(false) as Promise<boolean> };
    entry.promise = (async () => {
      let restored = false;
      let detail = "播放器音量恢复未确认，请在音乐播放器中检查音量。";
      try {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (activeDuckRef.current?.operationId !== active.operationId) break;
          try {
            const payload = await fetchJson<DesktopPlayerResponse>("/players/volume/restore", {
              method: "POST",
              body: JSON.stringify(active),
            });
            restored = payload.player?.ok === true;
            detail = payload.player?.detail || detail;
          } catch {
            restored = false;
          }
          if (restored) break;
          if (attempt < 2) await new Promise((resolve) => window.setTimeout(resolve, 150 * (attempt + 1)));
        }
        if (!restored) setNotice(detail);
      } finally {
        if (restored && activeDuckRef.current?.operationId === active.operationId) activeDuckRef.current = null;
        if (restorePromiseRef.current === entry) restorePromiseRef.current = null;
      }
      return restored;
    })();
    restorePromiseRef.current = entry;
    return entry.promise;
  }, []);

  const restorePlayerVolume = useCallback(async (operationId?: string) => {
    const active = activeDuckRef.current;
    if (!active || (operationId && active.operationId !== operationId)) return;
    await restoreDuckOperation(active);
  }, [restoreDuckOperation]);

  const duckPlayerVolume = useCallback(async (sourceId: DesktopPlayerSource, operationId: string) => {
    const pending = { sourceId, operationId, cancelled: false };
    const previous = pendingDuckRef.current;
    if (previous && previous.operationId !== operationId) previous.cancelled = true;
    pendingDuckRef.current = pending;
    try {
      const payload = await fetchJson<DesktopPlayerResponse>("/players/volume/duck", {
        method: "POST",
        body: JSON.stringify({ sourceId, operationId }),
      });
      if (payload.player?.ok) {
        activeDuckRef.current = { sourceId, operationId };
        if (pending.cancelled || pendingDuckRef.current !== pending) {
          await restoreDuckOperation({ sourceId, operationId });
          return "cancelled" as const;
        }
        return "ducked" as const;
      }
      if (payload.player?.state === "busy") {
        setNotice("上一段口播仍在恢复播放器音量，本次口播已跳过。");
        return "blocked" as const;
      }
      setNotice(payload.player?.detail || "没有检测到可调节音量的音乐播放器，口播仍会继续。");
    } catch {
      setNotice("无法连接本机播放器音量控制，口播仍会继续。");
    } finally {
      if (pendingDuckRef.current === pending) pendingDuckRef.current = null;
    }
    return "unavailable" as const;
  }, [restoreDuckOperation]);

  const stopAudio = useCallback(async (options?: { waitForRestore?: boolean }) => {
    if (nextRetryTimerRef.current !== null) window.clearTimeout(nextRetryTimerRef.current);
    nextRetryTimerRef.current = null;
    if (pendingDuckRef.current) pendingDuckRef.current.cancelled = true;
    audioTokenRef.current += 1;
    pendingAudioRef.current = null;
    fixtureAudioRef.current = null;
    pendingMusicRef.current = null;
    seamlessMusicKeyRef.current = null;
    musicAudioTokenRef.current += 1;
    if (musicVolumeRampRef.current !== null) window.clearInterval(musicVolumeRampRef.current);
    musicVolumeRampRef.current = null;
    if (hostMusicStartTimerRef.current !== null) window.clearTimeout(hostMusicStartTimerRef.current);
    hostMusicStartTimerRef.current = null;
    webDuckOwnerRef.current = null;
    hostAudioSourceRef.current = null;
    if (hostRequestRef.current) hostRequestRef.current.controller.abort();
    hostRequestRef.current = null;
    if (hostRetryTimerRef.current !== null) window.clearTimeout(hostRetryTimerRef.current);
    hostRetryTimerRef.current = null;
    if (hostPlaybackWatchdogRef.current !== null) window.clearTimeout(hostPlaybackWatchdogRef.current);
    hostPlaybackWatchdogRef.current = null;
    hostRetryRef.current = null;
    hostKeyRef.current = null;
    const audio = audioRef.current;
    if (audio) {
      if (ttsEndedRef.current) audio.removeEventListener("ended", ttsEndedRef.current);
      ttsEndedRef.current = null;
      audio.pause();
      audio.currentTime = 0;
      audio.removeAttribute("src");
      audio.load();
      audio.loop = false;
    }
    const music = musicAudioRef.current;
    if (music) {
      music.pause();
      music.currentTime = 0;
      music.removeAttribute("src");
      music.load();
      music.volume = 1;
    }
    const durationCue = durationCueAudioRef.current;
    if (durationCue) {
      durationCue.pause();
      durationCue.currentTime = 0;
    }
    cancelVoicePreview();
    setAudioPlaying(false);
    setAudioNeedsGesture(false);
    currentAudioModeRef.current = null;
    const restorePromise = restorePlayerVolume();
    if (options?.waitForRestore) await restorePromise;
  }, [cancelVoicePreview, restorePlayerVolume]);

  const setMusicFromSource = useCallback(async (url: string, key: string) => {
    const music = musicAudioRef.current;
    if (!music) return false;
    const token = ++musicAudioTokenRef.current;
    music.pause();
    music.currentTime = 0;
    music.src = url;
    music.load();
    try {
      await music.play();
      if (token !== musicAudioTokenRef.current) return false;
      pendingMusicRef.current = null;
      setAudioPlaying(true);
      setAudioNeedsGesture(false);
      setAudioError(null);
      return true;
    } catch (error) {
      if (token !== musicAudioTokenRef.current) return false;
      pendingMusicRef.current = { url, key };
      setAudioPlaying(false);
      setAudioNeedsGesture(true);
      if (error instanceof DOMException && error.name === "NotAllowedError") setNotice("音乐已准备好，请点击“开启声音”在此浏览器中播放。");
      else setAudioError("音乐音频无法加载，节目单仍可查看。");
      return false;
    }
  }, []);

  const prepareMusicBehindHost = useCallback((url: string, key: string) => {
    const music = musicAudioRef.current;
    if (!music) return;
    musicAudioTokenRef.current += 1;
    if (musicVolumeRampRef.current !== null) window.clearInterval(musicVolumeRampRef.current);
    musicVolumeRampRef.current = null;
    webDuckOwnerRef.current = key;
    music.pause();
    music.currentTime = 0;
    music.volume = HOST_MUSIC_DUCK_VOLUME;
    music.removeAttribute("src");
    music.load();
    pendingMusicRef.current = { url, key };
    setAudioPlaying(false);
  }, []);

  const releaseMusicWithoutHost = useCallback(async (key: string) => {
    if (hostMusicStartTimerRef.current !== null) window.clearTimeout(hostMusicStartTimerRef.current);
    hostMusicStartTimerRef.current = null;
    const pending = pendingMusicRef.current;
    if (!pending || pending.key !== key) return;
    const played = await setMusicFromSource(pending.url, pending.key);
    if (played) restoreWebMusic(key);
  }, [restoreWebMusic, setMusicFromSource]);

  const startMusicBehindHost = useCallback((key: string, delaySeconds: number, hostAudio?: HTMLAudioElement) => {
    if (hostMusicStartTimerRef.current !== null) window.clearTimeout(hostMusicStartTimerRef.current);
    hostMusicStartTimerRef.current = null;
    const start = () => {
      hostMusicStartTimerRef.current = null;
      const queued = pendingMusicRef.current;
      if (queued?.key === key) void setMusicFromSource(queued.url, queued.key);
    };
    if (delaySeconds <= 0) {
      start();
      return;
    }
    if (!hostAudio) {
      hostMusicStartTimerRef.current = window.setTimeout(start, delaySeconds * 1000);
      return;
    }
    const waitForPlayedAudio = () => {
      const queued = pendingMusicRef.current;
      if (queued?.key !== key || hostAudio.ended) return;
      const remainingMs = musicBedDelayRemainingMs(hostAudio.currentTime, delaySeconds);
      if (remainingMs === 0) {
        start();
        return;
      }
      hostMusicStartTimerRef.current = window.setTimeout(waitForPlayedAudio, Math.min(100, remainingMs));
    };
    waitForPlayedAudio();
  }, [setMusicFromSource]);

  const cancelHostForTrackChange = useCallback(() => {
    const audio = audioRef.current;
    audioTokenRef.current += 1;
    if (hostPlaybackWatchdogRef.current !== null) window.clearTimeout(hostPlaybackWatchdogRef.current);
    hostPlaybackWatchdogRef.current = null;
    if (hostMusicStartTimerRef.current !== null) window.clearTimeout(hostMusicStartTimerRef.current);
    hostMusicStartTimerRef.current = null;
    if (audio && ttsEndedRef.current) audio.removeEventListener("ended", ttsEndedRef.current);
    ttsEndedRef.current = null;
    hostAudioSourceRef.current = null;
    pendingAudioRef.current = null;
    currentAudioModeRef.current = null;
    setAudioNeedsGesture(false);
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
      audio.removeAttribute("src");
      audio.load();
    }
    return webDuckOwnerRef.current;
  }, []);

  const setAudioFromSource = useCallback(async (url: string, key: string, mode: "fixture" | "host", loop: boolean) => {
    const audio = audioRef.current;
    if (!audio) return false;
    const token = ++audioTokenRef.current;
    const sourceId = pendingAudioRef.current?.key === key ? pendingAudioRef.current.sourceId : undefined;
    if (ttsEndedRef.current) audio.removeEventListener("ended", ttsEndedRef.current);
    ttsEndedRef.current = null;
    audio.pause();
    audio.currentTime = 0;
    audio.loop = loop;
    audio.src = url;
    audio.load();
    try {
      await audio.play();
      if (token !== audioTokenRef.current) return false;
      pendingAudioRef.current = null;
      currentAudioModeRef.current = { mode, key, sourceId };
      setAudioNeedsGesture(false);
      setAudioError(null);
      return true;
    } catch (error) {
      if (token !== audioTokenRef.current) return false;
      pendingAudioRef.current = { url, key, mode, loop, sourceId };
      setAudioNeedsGesture(true);
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        setNotice("音频已准备好，请点击“开启声音”在此浏览器中播放。");
      } else {
        setAudioError(mode === "fixture" ? "测试音频无法加载，视觉载体仍可使用。" : "主持音频无法启动，当前曲目仍可继续。");
      }
      return false;
    }
  }, []);

  const enableAudio = useCallback(async () => {
    const pendingMusic = pendingMusicRef.current;
    const pending = pendingAudioRef.current;
    const audio = audioRef.current;
    const music = musicAudioRef.current;
    if (!pending && pendingMusic) {
      const played = await setMusicFromSource(pendingMusic.url, pendingMusic.key);
      const hostStillSpeaking = currentAudioModeRef.current?.mode === "host"
        && currentAudioModeRef.current.key === pendingMusic.key
        && audio?.paused === false;
      if (played && webDuckOwnerRef.current === pendingMusic.key && !hostStillSpeaking) restoreWebMusic(pendingMusic.key);
      return;
    }
    if (!pending && !pendingMusic && music?.currentSrc) {
      try {
        await music.play();
        setAudioPlaying(true);
        setAudioNeedsGesture(false);
        setAudioError(null);
      } catch (error) {
        setAudioNeedsGesture(true);
        if (!(error instanceof DOMException && error.name === "NotAllowedError")) setAudioError("音乐暂时无法继续播放，请稍后重试。");
      }
      return;
    }
    if (!audio || !pending) return;
    const duckOutcome = pending.mode === "host" && pending.sourceId ? await duckPlayerVolume(pending.sourceId, pending.key) : "unavailable";
    if (duckOutcome === "blocked" || duckOutcome === "cancelled") return;
    if (pending.mode === "host" && pendingAudioRef.current?.key !== pending.key) return;
    if (pending.mode === "host" && !pending.sourceId) {
      const queuedMusic = pendingMusicRef.current;
      if (queuedMusic?.key === pending.key && music) {
        if (musicVolumeRampRef.current !== null) window.clearInterval(musicVolumeRampRef.current);
        musicVolumeRampRef.current = null;
        webDuckOwnerRef.current = pending.key;
        music.volume = HOST_MUSIC_DUCK_VOLUME;
      } else {
        duckWebMusic(pending.key);
      }
    }
    const expectedHostToken = pending.mode === "host" ? audioTokenRef.current + 1 : null;
    if (expectedHostToken !== null) hostAudioSourceRef.current = { key: pending.key, url: pending.url, token: expectedHostToken };
    const played = await setAudioFromSource(pending.url, pending.key, pending.mode, pending.loop);
    if (!played && expectedHostToken !== null && hostAudioSourceRef.current?.token === expectedHostToken) hostAudioSourceRef.current = null;
    if (!played && pending.mode === "host" && pending.sourceId) void restorePlayerVolume(pending.key);
    if (!played && pending.mode === "host" && pendingMusicRef.current?.key !== pending.key) restoreWebMusic(pending.key);
    if (played && pending.mode === "host") {
      const fixture = fixtureAudioRef.current;
      const token = audioTokenRef.current;
      setProgram((current) => {
        if (!current || `${current.id}:${current.generation}:${current.currentTrack?.id}` !== pending.key || !current.host) return current;
        return { ...current, host: { ...current.host, status: "playing" } };
      });
      const finishHost = () => {
        if (ttsEndedRef.current === finishHost) ttsEndedRef.current = null;
        if (token !== audioTokenRef.current) return;
        if (hostPlaybackWatchdogRef.current !== null) window.clearTimeout(hostPlaybackWatchdogRef.current);
        hostPlaybackWatchdogRef.current = null;
        if (currentAudioModeRef.current?.key === pending.key) currentAudioModeRef.current = null;
        void restorePlayerVolume(pending.key);
        restoreWebMusic(pending.key);
        startMusicBehindHost(pending.key, 0);
        setProgram((current) => {
          if (!current || `${current.id}:${current.generation}:${current.currentTrack?.id}` !== pending.key || !current.host) return current;
          return { ...current, host: { ...current.host, status: "ready" } };
        });
      };
      ttsEndedRef.current = finishHost;
      audio.addEventListener("ended", finishHost, { once: true });
      if (hostPlaybackWatchdogRef.current !== null) window.clearTimeout(hostPlaybackWatchdogRef.current);
      hostPlaybackWatchdogRef.current = window.setTimeout(() => {
        audio.pause();
        finishHost();
        audioTokenRef.current += 1;
      }, 45_000);
      const delaySeconds = (program?.currentTrack as ProgramRundownItem | null)?.hostScript?.musicBedDelaySeconds ?? HOST_MUSIC_START_DELAY_SECONDS;
      startMusicBehindHost(pending.key, delaySeconds, audio);
    }
  }, [duckPlayerVolume, duckWebMusic, program?.currentTrack, restorePlayerVolume, restoreWebMusic, setAudioFromSource, startMusicBehindHost]);

  const toggleAudio = useCallback(() => {
    const music = musicAudioRef.current;
    if (!music) return;
    if (music.paused) {
      const pending = pendingMusicRef.current;
      if (pendingMusicRef.current && webDuckOwnerRef.current === pendingMusicRef.current.key && !audioNeedsGesture) {
        return;
      }
      if (pending) {
        void setMusicFromSource(pending.url, pending.key);
      } else if (music.currentSrc) {
        void music.play().catch(() => setAudioNeedsGesture(true));
      } else if (fixtureAudioRef.current) {
        void setMusicFromSource(fixtureAudioRef.current.url, fixtureAudioRef.current.key);
      }
      return;
    }
    music.pause();
    setAudioPlaying(false);
  }, [audioNeedsGesture, setMusicFromSource]);

  const refreshSources = useCallback(async () => {
    const refreshToken = ++sourceRefreshTokenRef.current;
    setSourceTransport("loading");
    try {
      const [payload, qqStatus, neteaseStatus] = await Promise.all([
        fetchJson<unknown>("/sources"),
        fetchJson<MusicApiStatusResponse>("/qq/status").catch(() => null),
        fetchJson<MusicApiStatusResponse>("/netease/status").catch(() => null),
      ]);
      if (refreshToken !== sourceRefreshTokenRef.current) return;
      const parsed = readSourcePayload(payload);
      if (parsed.length > 0) {
        const byId = new Map(parsed.map((source) => [source.sourceId, source]));
        setMusicApiStatus({ qq_music: qqStatus?.status, netease_music: neteaseStatus?.status });
        const nextSources: SourceDiagnostic[] = USER_SOURCE_IDS.map((id) => {
          const source = byId.get(id) ?? FALLBACK_SOURCES.find((item) => item.sourceId === id)!;
          const status = isApiMusicSource(id) ? (id === "qq_music" ? qqStatus?.status : neteaseStatus?.status) : undefined;
          const authenticated = status?.authenticated === true;
          return {
            ...source,
            playbackReady: authenticated,
            hostedProgramAllowed: authenticated,
            accountConnected: authenticated,
            state: authenticated ? "ready" : status?.configured ? "missing_credentials" : "failed_technical",
            detail: id === "qq_music" ? "通过本地 QQ 音乐 API 读取画像、创建歌单并在网页播放。" : "通过本地网易云 API 读取画像、创建歌单并在网页播放。",
          };
        });
        setSources(nextSources);
        if (!sourceAutoSelectDoneRef.current) {
          sourceAutoSelectDoneRef.current = true;
          setSelectedSource((current) => {
            const currentStatus = current === "qq_music" ? qqStatus?.status : current === "netease_music" ? neteaseStatus?.status : undefined;
            if (currentStatus?.authenticated === true) return current;
            if (neteaseStatus?.status?.authenticated === true) return "netease_music";
            if (qqStatus?.status?.authenticated === true) return "qq_music";
            return current;
          });
        }
        setSourceTransport(qqStatus?.status || neteaseStatus?.status ? "ready" : "failed");
        return;
      }
      throw new Error("No source diagnostics returned");
    } catch {
      if (refreshToken !== sourceRefreshTokenRef.current) return;
      setSources(FALLBACK_SOURCES.filter((source) => USER_SOURCE_IDS.includes(source.sourceId as (typeof USER_SOURCE_IDS)[number])));
      setDesktopPlayers({});
      setMusicApiStatus({});
      setSourceTransport("failed");
    }
  }, []);

  const controlDesktopPlayer = useCallback(async (action: "toggle" | "next") => {
    if (selectedSource !== "qq_music") return;
    setDesktopControlPending(action);
    setNotice(null);
    setLastError(null);
    try {
      const payload = await fetchJson<DesktopPlayerResponse>(`/players/control/${action}`, {
        method: "POST",
        body: JSON.stringify({ sourceId: selectedSource, operationId: makeId(`desktop-${action}`) }),
      });
      if (!payload.player?.ok) {
        setNotice(null);
        setLastError(payload.player?.detail || "桌面播放器未确认控制结果。");
      } else {
        setLastError(null);
      }
      await refreshSources();
    } catch (error) {
      setNotice(null);
      setLastError(error instanceof Error ? error.message : "桌面播放器控制失败。");
    } finally {
      setDesktopControlPending(null);
    }
  }, [refreshSources, selectedSource]);

  const refreshHealth = useCallback(async () => {
    try {
      const payload = await fetchJson<HealthState>("/health");
      setHealth({ ...payload, ok: payload.ok !== false });
    } catch {
      setHealth({ ok: false });
    }
  }, []);

  const refreshMusicStatus = useCallback(async () => {
    try {
      const [qq, netease] = await Promise.all([
        fetchJson<MusicApiStatusResponse>("/qq/status").catch(() => null),
        fetchJson<MusicApiStatusResponse>("/netease/status").catch(() => null),
      ]);
      setMusicApiStatus({
        qq_music: qq?.status ?? { configured: false, state: "unavailable", authenticated: false },
        netease_music: netease?.status ?? { configured: false, state: "unavailable", authenticated: false },
      });
    } catch {
      setMusicApiStatus({});
    }
  }, []);

  const refreshAiConfig = useCallback(async () => {
    setAiConfigPending(true);
    try {
      const payload = await fetchJson<{ config?: AiConfigStatus }>("/ai/config");
      setAiConfig(payload.config ?? null);
    } catch {
      setAiConfig(null);
    } finally {
      setAiConfigPending(false);
    }
  }, []);

  const refreshInvitationAccess = useCallback(async (verify = false) => {
    try {
      const payload = await fetchJson<{ access?: InvitationAccessStatus }>(`/access/status${verify ? "?verify=1" : ""}`);
      setInvitationAccess(payload.access ?? null);
    } catch {
      setInvitationAccess(null);
    }
  }, []);

  const claimInvitation = useCallback(async (inviteCode: string, displayName: string): Promise<boolean> => {
    if (invitationPending) return false;
    setInvitationPending(true);
    setLastError(null);
    try {
      const payload = await fetchJson<{ access: InvitationAccessStatus; config: AiConfigStatus }>("/access/claim", {
        method: "POST",
        body: JSON.stringify({ inviteCode, displayName }),
      });
      setInvitationAccess(payload.access);
      setAiConfig(payload.config);
      return true;
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "邀请码连接失败。");
      return false;
    } finally {
      setInvitationPending(false);
    }
  }, [invitationPending]);

  const saveAiConfig = useCallback(async (settings: AiConfigStatus, secrets: { llmApiKey: string; ttsApiKey: string }): Promise<AiConfigStatus | null> => {
    setAiConfigPending(true);
    setLastError(null);
    try {
      const payload = await fetchJson<{ config: AiConfigStatus }>("/ai/config", { method: "POST", body: JSON.stringify({ llm: settings.llm, tts: settings.tts, ...secrets }) });
      setAiConfig(payload.config);
      return payload.config;
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "AI 服务配置保存失败。");
      return null;
    } finally {
      setAiConfigPending(false);
    }
  }, []);

  const testAiService = useCallback(async (target: "llm" | "tts"): Promise<boolean> => {
    if (aiTestTarget) return false;
    setAiTestTarget(target);
    setLastError(null);
    try {
      await fetchJson(`/ai/test`, { method: "POST", body: JSON.stringify({ target }) });
      return true;
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "AI 服务连接测试失败。");
      return false;
    } finally {
      setAiTestTarget(null);
    }
  }, [aiTestTarget]);

  const previewHostVoice = useCallback(async (profileId: HostProfileId) => {
    if (voicePreviewBusyRef.current) {
      if (voicePreviewProfile === profileId) cancelVoicePreview();
      return;
    }
    voicePreviewBusyRef.current = true;
    const previous = voicePreviewAudioRef.current;
    if (previous) {
      previous.pause();
      previous.currentTime = 0;
      previous.removeAttribute("src");
      previous.load();
      voicePreviewAudioRef.current = null;
    }
    setVoicePreviewProfile(profileId);
    setLastError(null);
    let preview: HTMLAudioElement | null = null;
    try {
      preview = new Audio(`/hosts/previews/${profileId}.mp3`);
      voicePreviewAudioRef.current = preview;
      await new Promise<void>((resolve, reject) => {
        const finish = () => resolve();
        preview!.addEventListener("ended", finish, { once: true });
        preview!.addEventListener("error", () => reject(new Error("声线试听音频无法播放。")), { once: true });
        void preview!.play().catch(reject);
      });
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "声线试听失败。");
    } finally {
      if (preview && voicePreviewAudioRef.current === preview) {
        preview.pause();
        preview.removeAttribute("src");
        preview.load();
        voicePreviewAudioRef.current = null;
      }
      voicePreviewBusyRef.current = false;
      setVoicePreviewProfile(null);
    }
  }, [cancelVoicePreview, voicePreviewProfile]);

  const startMusicLogin = useCallback(async (sourceId: ApiMusicSource) => {
    setMusicLoginPending(true);
    setLastError(null);
    try {
      const payload = await fetchJson<{ login?: MusicQrLogin }>(`/${sourceId === "qq_music" ? "qq" : "netease"}/login/qr`, {
        method: "POST",
        body: sourceId === "qq_music" ? JSON.stringify({ loginType: "mobile" satisfies QqLoginType }) : undefined,
      });
      if (!payload.login?.key || !payload.login.qrImageDataUrl) throw new Error(`未生成${SOURCE_LABELS[sourceId]}登录二维码。`);
      setMusicQrLogin({ ...payload.login, sourceId, ...(sourceId === "qq_music" ? { loginType: "mobile" as const } : {}), state: "waiting_scan" });
    } catch (error) {
      setLastError(error instanceof Error ? error.message : `${SOURCE_LABELS[sourceId]}登录启动失败。`);
    } finally {
      setMusicLoginPending(false);
    }
  }, []);

  useEffect(() => {
    if (!musicQrLogin) return;
    let disposed = false;
    let checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const provider = musicQrLogin.sourceId === "qq_music" ? "qq" : "netease";
        const method = musicQrLogin.sourceId === "qq_music" ? "?method=mobile" : "";
        const payload = await fetchJson<{ login?: { state?: string } }>(`/${provider}/login/qr/${encodeURIComponent(musicQrLogin.key)}${method}`);
        if (disposed) return;
        const state = payload.login?.state;
        if (state === "authorized") {
          setMusicQrLogin((current) => current?.key === musicQrLogin.key ? null : current);
          setLastError(null);
          await Promise.all([refreshMusicStatus(), refreshSources()]);
        } else if (state === "expired") {
          setMusicQrLogin((current) => current?.key === musicQrLogin.key ? null : current);
          setLastError(`${SOURCE_LABELS[musicQrLogin.sourceId]}登录二维码已过期，请重新生成。`);
        } else if (state === "waiting_confirm" || state === "waiting_scan") {
          setLastError(null);
          setMusicQrLogin((current) => current?.key === musicQrLogin.key ? { ...current, state } : current);
        }
      } catch {
        if (!disposed) setLastError(`暂时无法检查${SOURCE_LABELS[musicQrLogin.sourceId]}扫码状态。`);
      } finally {
        checking = false;
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 2_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [musicQrLogin?.key, musicQrLogin?.sourceId, musicQrLogin?.loginType, refreshMusicStatus, refreshSources]);

  useEffect(() => {
    if (musicQrLogin?.sourceId === "qq_music" && musicQrLogin.loginType !== "mobile") {
      setMusicQrLogin(null);
    }
  }, [musicQrLogin?.sourceId, musicQrLogin?.loginType]);

  useEffect(() => {
    void refreshSources();
    void refreshHealth();
    void refreshMusicStatus();
    void refreshAiConfig();
    void refreshInvitationAccess(true);
  }, [refreshAiConfig, refreshHealth, refreshInvitationAccess, refreshMusicStatus, refreshSources]);

  useEffect(() => {
    if (program || view !== "setup" || setupPhase !== "connect" || connectionReviewOpen || !localOnboardingComplete || aiConfigPending || sourceTransport === "loading" || !initializationReady) return;
    setSetupPhase("settings");
  }, [aiConfigPending, connectionReviewOpen, initializationReady, localOnboardingComplete, program, setupPhase, sourceTransport, view]);

  useEffect(() => {
    if (showLanding || !landingFocusPendingRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(".main-content")?.focus();
      landingFocusPendingRef.current = false;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [showLanding]);

  useEffect(() => {
    if (view !== "setup" && view !== "settings" && view !== "confirm") return;
    let disposed = false;
    const refreshDiagnostics = () => {
      if (disposed || document.visibilityState === "hidden") return;
      void refreshSources();
      void refreshHealth();
    };
    refreshDiagnostics();
    const timer = window.setInterval(refreshDiagnostics, 10_000);
    window.addEventListener("focus", refreshDiagnostics);
    document.addEventListener("visibilitychange", refreshDiagnostics);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshDiagnostics);
      document.removeEventListener("visibilitychange", refreshDiagnostics);
    };
  }, [refreshHealth, refreshSources, view]);

  useEffect(() => {
    if (selectedMusicApiStatus?.authenticated !== true) setMusicPreferencesState("idle");
  }, [selectedMusicApiStatus?.authenticated]);

  useEffect(() => {
    let disposed = false;
    const restoreProgram = async () => {
      try {
        const payload = await fetchJson<unknown>("/program");
        const remote = readProgramPayload(payload);
        if (disposed || !remote || programRef.current || createOperationRef.current) return;
        if (landingEnteredRef.current && ["completed", "stopped", "failed", "control_lost", "stop_unconfirmed"].includes(remote.status)) return;
        setProgram({ ...remote, report: [] });
        setView(viewForProgramStatus(remote.status));
      } catch {
        // A missing service is represented by the explicit fixture path in the setup form.
      }
    };
    void restoreProgram();
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (view !== "preparing" || isConfirming || !program || program.status === "preparing") return;
    if (["draft", "awaiting_confirmation"].includes(program.status)) {
      setView("confirm");
      return;
    }
    setProcessComplete(true);
    const timer = window.setTimeout(() => setView(viewForProgramStatus(program.status)), 320);
    return () => window.clearTimeout(timer);
  }, [isConfirming, program?.id, program?.status, view]);

  useEffect(() => {
    if (!program?.localOnly || !program.deadlineAt || !["preparing", "on_air", "closing"].includes(program.status)) return;
    const delay = Math.max(0, new Date(program.deadlineAt).getTime() - Date.now());
    const timer = window.setTimeout(() => {
      void stopAudio();
      setProgram((current) => current && current.id === program.id && ["preparing", "on_air", "closing"].includes(current.status)
        ? { ...current, status: "completed", remainingSeconds: 0, currentTrack: null, nextTrack: null, queue: [], host: null }
        : current);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [program?.deadlineAt, program?.id, program?.status, stopAudio]);

  useEffect(() => {
    const active = Boolean(program && !program.localOnly && ["preparing", "on_air"].includes(program.status));
    if (!active || !program) return;
    const cue = new Audio(hostDurationReachedCueUrl(program.spec.hostProfile ?? DEFAULT_HOST_PROFILE));
    cue.preload = "auto";
    durationCueAudioRef.current = cue;
    const sinkElement = cue as HTMLAudioElement & { setSinkId?: (sinkId: string) => Promise<void> };
    if (typeof sinkElement.setSinkId === "function") void sinkElement.setSinkId(audioOutputId).catch(() => undefined);
    cue.load();
    return () => {
      if (durationCueAudioRef.current === cue) durationCueAudioRef.current = null;
      cue.pause();
      cue.removeAttribute("src");
      cue.load();
    };
  }, [audioOutputId, program?.id, program?.localOnly, program?.spec.hostProfile, program?.status]);

  useEffect(() => {
    if (!program || program.localOnly || program.status !== "on_air" || remainingSeconds > 0) return;
    if (durationReachedNoticeRef.current === program.id) return;
    durationReachedNoticeRef.current = program.id;
    setNotice("本档节目设定时长已到，将在当前歌曲完整播放后结束。");
    const cue = durationCueAudioRef.current;
    if (!cue) return;
    const owner = `duration-reached:${program.id}`;
    let disposed = false;
    const playCue = () => {
      if (disposed || durationCueAudioRef.current !== cue) return;
      cue.currentTime = 0;
      duckWebMusic(owner);
      const finish = () => restoreWebMusic(owner);
      cue.addEventListener("ended", finish, { once: true });
      cue.addEventListener("error", finish, { once: true });
      void cue.play().catch(finish);
    };
    const hostAudio = audioRef.current;
    if (hostAudio && !hostAudio.paused && !hostAudio.ended) hostAudio.addEventListener("ended", playCue, { once: true });
    else playCue();
    return () => {
      disposed = true;
      hostAudio?.removeEventListener("ended", playCue);
    };
  }, [duckWebMusic, program?.id, program?.localOnly, program?.status, remainingSeconds, restoreWebMusic, setNotice]);

  useEffect(() => {
    if (!programActive || !program?.id) return;
    let disposed = false;
    const poll = async () => {
      if (program.localOnly) return;
      programPollRequestRef.current?.abort();
      const controller = new AbortController();
      programPollRequestRef.current = controller;
      try {
        const payload = await fetchJson<unknown>(`/programs/${program.id}`, { signal: controller.signal });
        const remote = readProgramPayload(payload);
        if (!disposed && remote) setProgram((current) => current ? mergeRemoteProgramIfCurrent(current, remote) : { ...remote, report: [] });
      } catch (error) {
        if (disposed) return;
        if (error instanceof DOMException && error.name === "AbortError") return;
        const requestError = error as Error & { code?: string; status?: number };
        if (requestError.status === 404 || requestError.code === "PROGRAM_NOT_FOUND") {
          void stopAudio();
          setProgram(null);
          setView("setup");
          setNotice("本地服务已重启，旧节目已停止，请重新创建节目。");
          return;
        }
        setNotice("服务状态刷新失败，当前仍显示最近一次确认的状态。");
      } finally {
        if (programPollRequestRef.current === controller) programPollRequestRef.current = null;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      programPollRequestRef.current?.abort();
      programPollRequestRef.current = null;
    };
  }, [program?.id, program?.localOnly, programActive, stopAudio]);

  useEffect(() => {
    if (!programActive || !program?.id || program.localOnly || isNexting || isStopping) return;
    let disposed = false;
    const beat = async () => {
      heartbeatRequestRef.current?.abort();
      const controller = new AbortController();
      heartbeatRequestRef.current = controller;
      try {
        const payload = await fetchJson<unknown>(`/programs/${program.id}/heartbeat`, {
          method: "POST",
          signal: controller.signal,
          body: JSON.stringify({ generation: program.generation }),
        });
        const remote = readProgramPayload(payload);
        if (!disposed && remote) setProgram((current) => current ? mergeRemoteProgramIfCurrent(current, remote) : { ...remote, report: [] });
      } catch (error) {
        if (!disposed && !(error instanceof DOMException && error.name === "AbortError")) {
          setNotice("控制心跳未收到。如果无法恢复控制，服务将停止节目。");
        }
      } finally {
        if (heartbeatRequestRef.current === controller) heartbeatRequestRef.current = null;
      }
    };
    void beat();
    const timer = window.setInterval(() => void beat(), 2000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      heartbeatRequestRef.current?.abort();
      heartbeatRequestRef.current = null;
    };
  }, [isNexting, isStopping, program?.generation, program?.id, program?.localOnly, programActive]);

  useEffect(() => {
    if (!program?.localOnly || !["on_air", "preparing", "closing"].includes(program.status)) return;
    if (remainingSeconds > 0) return;
    setProgram((current) => {
      if (!current || !current.localOnly || ["completed", "stopped", "failed"].includes(current.status)) return current;
      const event: ReportEvent = { id: makeId("event"), at: nowIso(), label: "节目已到达截止时间", detail: "视觉载体在确认的截止时间结束。", tone: "success" };
      return { ...current, status: "completed", remainingSeconds: 0, report: [...current.report, event] };
    });
    setView("ended");
  }, [nowMs, program?.localOnly, program?.status, remainingSeconds]);

  useEffect(() => {
    const track = program?.currentTrack;
    const shouldPlay = Boolean(!showLanding && view === "on_air" && program && !program.localOnly && program.status === "on_air" && track?.audioUrl);
    if (!shouldPlay || !program || !track?.audioUrl) {
      void stopAudio();
      return;
    }
    const key = `${program.id}:${program.generation}:${track.id}`;
    const previousDuckOwner = cancelHostForTrackChange();
    const seamlessHandoff = seamlessMusicKeyRef.current === key;
    if (seamlessHandoff) seamlessMusicKeyRef.current = null;
    musicFailureRef.current = { key, attempts: 0 };
    fixtureAudioRef.current = { url: track.audioUrl, key };
    const rundownItem = track as ProgramRundownItem;
    const startsWithHost = isApiMusicSource(program.spec.sourceId) && Boolean(rundownItem.hostMoment);
    if (startsWithHost) prepareMusicBehindHost(track.audioUrl, key);
    else {
      if (previousDuckOwner) restoreWebMusic(previousDuckOwner);
      if (!seamlessHandoff) void setMusicFromSource(track.audioUrl, key);
    }
  }, [cancelHostForTrackChange, prepareMusicBehindHost, program?.currentTrack?.audioUrl, program?.currentTrack?.id, program?.generation, program?.id, program?.localOnly, program?.status, setMusicFromSource, showLanding, stopAudio, view]);

  useEffect(() => {
    const track = program?.currentTrack;
    if (showLanding || view !== "on_air" || !program || program.localOnly || program.status !== "on_air" || !track) return;
    const apiMusicSource = isApiMusicSource(program.spec.sourceId);
    const desktopSource = !apiMusicSource && program.spec.sourceId !== "fixture";
    const exactApiMusic = apiMusicSource && Boolean(track.audioUrl) && Array.isArray(program.rundown);
    const rundownItem = track as ProgramRundownItem;
    if (exactApiMusic && (program.rundownIndex ?? 0) > 0 && !rundownItem.hostMoment) {
      setHostPreviewPending(false);
      return;
    }
    const trackKey = `${program.id}:${program.generation}:${track.id}`;
    const timeRemainingSeconds = remainingSecondsRef.current;
    const hostSlot = exactApiMusic ? (program.rundownIndex ?? 0) : desktopSource ? scheduledDesktopHostSlot : 0;
    const hostMoment: HostContextPack["hostMoment"] = exactApiMusic
      ? (rundownItem.hostMoment ?? (hostSlot === 0 ? "opening" : "song_note"))
      : !desktopSource || hostSlot === 0
        ? "opening"
        : (["song_note", "next_preview", "scene_boost", "music_news"] as const)[(hostSlot - 1) % 4];
    const hostKey = `${trackKey}:slot:${hostSlot}`;
    if (hostKeyRef.current === hostKey) return;
    if (hostRetryRef.current?.key !== hostKey) hostRetryRef.current = { key: hostKey, attempts: 0 };
    hostKeyRef.current = hostKey;
    hostRequestRef.current?.controller.abort();
    const controller = new AbortController();
    hostRequestRef.current = { key: hostKey, controller };
    setHostPreviewPending(true);
    const safeTrack = (value: Track | null): Track | null => {
      if (!value) return null;
      const { audioUrl: _audioUrl, ...withoutAudio } = value;
      return withoutAudio;
    };
    const context: HostContextPack = {
      scenePreset: program.spec.scenePreset,
      programPhase: phaseFromRemaining({ ...program, remainingSeconds: timeRemainingSeconds }),
      timeRemainingSeconds,
      previousTrack: null,
      // Desktop clients own the actual queue. Their synthetic engine tracks must
      // never be presented to the host as confirmed song metadata.
      currentTrack: desktopSource ? null : safeTrack(track),
      nextTrack: desktopSource ? null : safeTrack(program.nextTrack),
      transitionReason: desktopSource
        ? hostSlot > 0 ? "节目正在持续播出，准备下一段自然的电台串场" : "节目开场，先建立这档电台的听感"
        : program.nextTrack ? "opening a concise link into the next confirmed track" : "holding the current program arc",
      hostMoment,
      hostLengthSeconds: 18,
      recentHostLines: program.recentHostLines.slice(-8),
      allowedFacts: [
        ...(!desktopSource && program.spec.sourceId === "fixture" ? [{ id: `track:${track.id}:metadata`, value: `${track.title} by ${track.artist}`, source: "fixture" as const }] : []),
        ...(exactApiMusic ? [
          { id: `track:${track.id}:metadata`, value: `${track.title} · ${track.artist}${rundownItem.album && !releaseTitlesMatch(track.title, rundownItem.album) ? ` · 专辑《${rundownItem.album}》` : ""}`, source: "user" as const },
          ...(Array.isArray(rundownItem.reasons) && rundownItem.reasons.length > 0 ? [{ id: `track:${track.id}:reasons`, value: rundownItem.reasons.join("；"), source: "user" as const }] : []),
          ...(program.nextTrack ? [{ id: `track:${program.nextTrack.id}:metadata`, value: `下一首：${program.nextTrack.title} · ${program.nextTrack.artist}`, source: "user" as const }] : []),
        ] : []),
        { id: "program:scene", value: programRecommendationLabel(program.spec), source: "user" },
        ...(program.spec.sceneDescription ? [{ id: "program:scene-description", value: program.spec.sceneDescription, source: "user" as const }] : []),
      ],
      forbiddenClaims: ["user location, activity, feelings, memories, health, or private circumstances", "unverified music history or artist facts"],
    };
    const requestKey = trackKey;
    const scheduleLockedTtsRetry = () => {
      // Account-backed programs already contain a complete pre-generated audio
      // artifact. A retry cannot repair that immutable artifact and would only
      // delay the music transition.
      if (exactApiMusic || hostRetryRef.current?.key !== hostKey || hostRetryRef.current.attempts >= 1) return false;
      hostRetryRef.current.attempts += 1;
      const attempt = hostRetryRef.current.attempts;
      if (hostRetryTimerRef.current !== null) window.clearTimeout(hostRetryTimerRef.current);
      hostRetryTimerRef.current = window.setTimeout(() => {
        hostRetryTimerRef.current = null;
        if (hostKeyRef.current !== hostKey) return;
        hostKeyRef.current = null;
        setHostRetryNonce((value) => value + 1);
      }, 750 * attempt);
      setNotice(`主持语音暂时不可用，正在重试（${attempt}/1）。`);
      return true;
    };
    let timedOut = false;
    const timeoutId = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, exactApiMusic ? 3_000 : 27_000);
    const preview = async () => {
      try {
        const payload = await fetchJson<HostPreviewResponse>("/host/preview", {
          method: "POST",
          signal: controller.signal,
          body: JSON.stringify(exactApiMusic
            ? { programId: program.id, generation: program.generation, trackId: track.id }
            : { context }),
        });
        if (controller.signal.aborted || hostRequestRef.current?.key !== hostKey) return;
        const result = payload.host;
        const text = typeof result?.text === "string" ? result.text.trim() : "";
        const audioUrl = payload.audio?.status === "ready" && typeof payload.audio.url === "string" && payload.audio.url.length > 0
          ? payload.audio.url
          : null;
        const rejected = payload.success === false || result?.mock === true || hostResultFailed(result) || !result;
        if (rejected) {
          setProgram((current) => {
            if (!current || `${current.id}:${current.generation}:${current.currentTrack?.id}` !== requestKey) return current;
            return { ...current, host: null };
          });
          if (scheduleLockedTtsRetry()) {
            // The text is already locked; only the transient synthesis request is retried.
          } else if (result?.mock === true) {
            setNotice("AI 主持人不可用，确定性模拟响应未播出。");
            void releaseMusicWithoutHost(requestKey);
          } else {
            setNotice(`AI 主持人不可用${result?.error?.code ? `（${result.error.code}）` : ""}；未播出未经验证的片段。`);
            void releaseMusicWithoutHost(requestKey);
          }
        } else if (text) {
          const hostStatus: HostSegment["status"] = audioUrl ? "ready" : result?.status === "playing" ? "playing" : "generated";
          const host: HostSegment = {
            id: typeof result?.id === "string" ? result.id : makeId("host"),
            text,
            factIds: Array.isArray(result?.factIds) ? result.factIds.filter((factId): factId is string => typeof factId === "string") : [],
            instruction: typeof result?.instruction === "string" ? result.instruction : "fact-bounded transition",
            deliveryInstruction: typeof result?.deliveryInstruction === "string" ? result.deliveryInstruction : undefined,
            generatedAt: typeof result?.generatedAt === "string" ? result.generatedAt : nowIso(),
            plannedDurationSeconds: rundownItem.hostScript?.plannedDurationSeconds,
            audioUrl: audioUrl ?? undefined,
            status: hostStatus,
          };
          setProgram((current) => {
            if (!current || `${current.id}:${current.generation}:${current.currentTrack?.id}` !== requestKey) return current;
            const lines = current.recentHostLines.includes(text) ? current.recentHostLines : [...current.recentHostLines, text].slice(-3);
            return { ...current, host, recentHostLines: lines, error: null };
          });
        } else {
          setProgram((current) => {
            if (!current || `${current.id}:${current.generation}:${current.currentTrack?.id}` !== requestKey) return current;
            return { ...current, host: null };
          });
        }
        if (audioUrl && text && !rejected) {
          hostRetryRef.current = null;
          const audio = audioRef.current;
          const fixture = fixtureAudioRef.current;
          const playerSource: DesktopPlayerSource | null = null;
          if (audio && (fixture?.key === requestKey || playerSource)) {
            const duckOutcome = playerSource ? await duckPlayerVolume(playerSource, requestKey) : "unavailable";
            const ducked = duckOutcome === "ducked";
            const music = musicAudioRef.current;
            if (!playerSource && music) duckWebMusic(requestKey);
            if (duckOutcome === "blocked" || duckOutcome === "cancelled") return;
            if (controller.signal.aborted || hostRequestRef.current?.key !== hostKey) {
              if (ducked && playerSource) await restoreDuckOperation({ sourceId: playerSource, operationId: requestKey });
              if (!playerSource) restoreWebMusic(requestKey);
              return;
            }
            audio.pause();
            const token = ++audioTokenRef.current;
            audio.loop = false;
            audio.src = audioUrl;
            audio.load();
            hostAudioSourceRef.current = { key: requestKey, url: audioUrl, token };
            const restoreFixture = () => {
              if (ttsEndedRef.current === restoreFixture) ttsEndedRef.current = null;
              if (token !== audioTokenRef.current) return;
              if (hostPlaybackWatchdogRef.current !== null) window.clearTimeout(hostPlaybackWatchdogRef.current);
              hostPlaybackWatchdogRef.current = null;
              if (currentAudioModeRef.current?.key === requestKey) currentAudioModeRef.current = null;
              void restorePlayerVolume(requestKey);
              if (hostAudioSourceRef.current?.token === token) hostAudioSourceRef.current = null;
              if (hostMusicStartTimerRef.current !== null) window.clearTimeout(hostMusicStartTimerRef.current);
              hostMusicStartTimerRef.current = null;
              const queuedMusic = pendingMusicRef.current;
              if (queuedMusic?.key === requestKey) void releaseMusicWithoutHost(requestKey);
              else if (music) restoreWebMusic(requestKey);
              setProgram((current) => {
                if (!current || `${current.id}:${current.generation}:${current.currentTrack?.id}` !== requestKey || !current.host) return current;
                return { ...current, host: { ...current.host, status: "ready" } };
              });
            };
            ttsEndedRef.current = restoreFixture;
            audio.addEventListener("ended", restoreFixture, { once: true });
            try {
              await audio.play();
              if (token !== audioTokenRef.current || (fixture && fixtureAudioRef.current?.key !== requestKey)) return;
              pendingAudioRef.current = null;
              currentAudioModeRef.current = { mode: "host", key: requestKey, sourceId: playerSource ?? undefined };
              if (hostPlaybackWatchdogRef.current !== null) window.clearTimeout(hostPlaybackWatchdogRef.current);
              hostPlaybackWatchdogRef.current = window.setTimeout(() => {
                audio.pause();
                restoreFixture();
                audioTokenRef.current += 1;
              }, 45_000);
              setAudioNeedsGesture(false);
              startMusicBehindHost(requestKey, rundownItem.hostScript?.musicBedDelaySeconds ?? HOST_MUSIC_START_DELAY_SECONDS, audio);
              setProgram((current) => {
                if (!current || `${current.id}:${current.generation}:${current.currentTrack?.id}` !== requestKey || !current.host) return current;
                return { ...current, host: { ...current.host, status: "playing" } };
              });
            } catch (error) {
              if (token !== audioTokenRef.current || (fixture && fixtureAudioRef.current?.key !== requestKey)) {
                if (ducked && playerSource) await restoreDuckOperation({ sourceId: playerSource, operationId: requestKey });
                if (!playerSource) restoreWebMusic(requestKey);
                return;
              }
              if (currentAudioModeRef.current?.key === requestKey) currentAudioModeRef.current = null;
              void restorePlayerVolume(requestKey);
              if (hostAudioSourceRef.current?.token === token) hostAudioSourceRef.current = null;
              if (error instanceof DOMException && error.name === "NotAllowedError") {
                pendingAudioRef.current = { url: audioUrl, key: requestKey, mode: "host", loop: false, sourceId: playerSource ?? undefined };
                setAudioNeedsGesture(true);
                setNotice("主持人语音已准备好，请点击“开启声音”收听这段过渡。");
              } else {
                pendingAudioRef.current = null;
                setAudioNeedsGesture(false);
                setAudioError("主持音频无法启动，音乐将直接开始。");
                if (!playerSource) void releaseMusicWithoutHost(requestKey);
              }
            }
          }
        } else if (!rejected && exactApiMusic && text && !audioUrl) {
          if (!scheduleLockedTtsRetry()) {
            setNotice("主持文案已准备好，但语音暂时不可用。音乐将直接开始。");
            void releaseMusicWithoutHost(requestKey);
          }
        } else if (!rejected && payload.audio?.status && payload.audio.status !== "unavailable") {
          setNotice("主持文案已准备好，但语音暂时不可用。音乐将直接开始。");
          void releaseMusicWithoutHost(requestKey);
        }
      } catch (error) {
        if (timedOut) {
          if (!scheduleLockedTtsRetry()) {
            setNotice("主持预览超时。音乐将继续播放，不加入未经验证的语音片段。");
            void releaseMusicWithoutHost(requestKey);
          }
          return;
        }
        if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
        if (!scheduleLockedTtsRetry()) {
          setNotice("主持预览不可用。音乐将继续播放，不加入未经验证的语音片段。");
          void releaseMusicWithoutHost(requestKey);
        }
      } finally {
        window.clearTimeout(timeoutId);
        if (hostRequestRef.current?.key === hostKey) {
          hostRequestRef.current = null;
          setHostPreviewPending(false);
        }
      }
    };
    void preview();
    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
      if (hostRetryTimerRef.current !== null) window.clearTimeout(hostRetryTimerRef.current);
      hostRetryTimerRef.current = null;
    };
  }, [duckPlayerVolume, duckWebMusic, hostRetryNonce, program?.currentTrack?.id, program?.generation, program?.id, program?.localOnly, program?.spec.scenePreset, program?.status, releaseMusicWithoutHost, restoreDuckOperation, restorePlayerVolume, restoreWebMusic, scheduledDesktopHostSlot, showLanding, startMusicBehindHost, view]);

  const handleHostAudioError = useCallback(() => {
    const audio = audioRef.current;
    const source = hostAudioSourceRef.current;
    if (!audio || !source || source.token !== audioTokenRef.current || !audio.error) return;
    const resolvedSource = new URL(source.url, window.location.href).href;
    if (audio.currentSrc && audio.currentSrc !== resolvedSource) return;
    const finish = ttsEndedRef.current;
    if (finish) finish();
    else {
      void restorePlayerVolume(source.key);
      restoreWebMusic(source.key);
    }
    if (pendingAudioRef.current?.key === source.key) pendingAudioRef.current = null;
    void releaseMusicWithoutHost(source.key);
    hostAudioSourceRef.current = null;
    setAudioError("主持音频无法播放，音乐将继续。");
  }, [releaseMusicWithoutHost, restorePlayerVolume, restoreWebMusic]);

  const buildSpec = () => {
    const effectiveScenePreset = recommendationMode === "genre" ? GENRE_MODE_DEFAULT_SCENE : scenePreset;
    return {
      ...makeSpec(selectedSource, durationMinutes, recommendationMode, effectiveScenePreset, hostDensity, hostProfile, musicGenres, desktopPetEnabled),
      familiarityRatio,
    };
  };

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    if (!canCreate) {
      if (createBlocker) setLastError(createBlocker);
      return;
    }
    setLastError(null);
    setNotice(null);
    setIsCreating(true);
    setKeepPlaylist(false);
    setPlaylistSavePromptOpen(false);
    setProcessComplete(false);
    setProcessCompletedSteps(0);
    setHostScriptRetryMessage(null);
    setView("generating");
    setMusicPreferencesState(isApiMusicSource(selectedSource) ? "loading" : "idle");
    const spec = buildSpec();
    const serializedSpec = JSON.stringify(spec);
    const operationId = createOperationRef.current?.spec === serializedSpec ? createOperationRef.current.id : makeId("create");
    createOperationRef.current = { id: operationId, spec: serializedSpec };
    const progressController = new AbortController();
    const monitorProgress = async () => {
      while (!progressController.signal.aborted) {
        try {
          const payload = await fetchJson<{ progress?: { completedSteps?: number; status?: string } }>(`/programs/progress?operationId=${encodeURIComponent(operationId)}`, { signal: progressController.signal });
          const completedSteps = payload.progress?.completedSteps;
          if (typeof completedSteps === "number") setProcessCompletedSteps(Math.max(0, Math.min(4, completedSteps)));
          if (payload.progress?.status === "completed" || payload.progress?.status === "failed" || payload.progress?.status === "action_required") return;
        } catch (error) {
          if (progressController.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
          if ((error as Error & { status?: number }).status !== 404) return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 120));
      }
    };
    const progressPromise = monitorProgress();
    try {
      const payload = await fetchJson<unknown>("/programs", { method: "POST", body: JSON.stringify({ spec, operationId }) });
      const remote = readProgramPayload(payload);
      if (!remote) throw new Error("服务返回了无效节目");
      const hostRetry = readHostRetryPayload(payload);
      const nextProgram: LocalProgram = { ...remote, report: [{ id: makeId("event"), at: nowIso(), label: hostRetry.required ? "歌单已保留" : "计划已创建", detail: hostRetry.required ? "主持口播需要重新生成一次；歌曲和顺序不会变化。" : "确认前不会发送任何播放指令。", tone: hostRetry.required ? "warning" : "success" }] };
      programRef.current = nextProgram;
      setProgram(nextProgram);
      setMusicPreferencesState(isApiMusicSource(selectedSource) ? "ready" : "idle");
      if (hostRetry.required) {
        setProcessCompletedSteps(3);
        setProcessComplete(false);
        setHostScriptRetryMessage(hostRetry.message ?? "口播审核没有通过，歌单已保留。请确认后单独重新生成口播。");
        setView("generating");
        return;
      }
      createOperationRef.current = null;
      setProcessCompletedSteps(4);
      setProcessComplete(true);
      await new Promise((resolve) => window.setTimeout(resolve, 520));
      setView(viewForProgramStatus(remote.status));
    } catch (error) {
      try {
        const current = readProgramPayload(await fetchJson<unknown>("/program"));
        if (current && JSON.stringify(current.spec) === JSON.stringify(spec)) {
          const nextProgram: LocalProgram = { ...current, report: [{ id: makeId("event"), at: nowIso(), label: "计划已恢复", detail: "创建响应中断后已从本地服务找回计划。", tone: "warning" }] };
          programRef.current = nextProgram;
          setProgram(nextProgram);
          setMusicPreferencesState(isApiMusicSource(selectedSource) ? "ready" : "idle");
          if (isApiMusicSource(current.spec.sourceId) && !hasLockedMusicArtifacts(current)) {
            setProcessCompletedSteps(3);
            setProcessComplete(false);
            setHostScriptRetryMessage("口播审核没有通过，歌单已保留。请确认后单独重新生成口播。");
            setView("generating");
            return;
          }
          createOperationRef.current = null;
          setProcessCompletedSteps(4);
          setProcessComplete(true);
          await new Promise((resolve) => window.setTimeout(resolve, 520));
          setView(viewForProgramStatus(current.status));
          return;
        }
      } catch {
        // Keep the original creation error and operation id so a retry remains idempotent.
      }
      setMusicPreferencesState(isApiMusicSource(selectedSource) ? "failed" : "idle");
      setLastError(error instanceof Error ? error.message : "节目计划创建失败，请检查本地服务。");
      setView("setup");
    } finally {
      progressController.abort();
      await progressPromise;
      setIsCreating(false);
    }
  };

  const regenerateHostScripts = async () => {
    if (!program || hostScriptRetryPending) return;
    const baseRevision = program.planRevision ?? 0;
    setHostScriptRetryPending(true);
    setLastError(null);
    setNotice(null);
    setProcessComplete(false);
    setProcessCompletedSteps(3);
    setView("generating");
    try {
      const payload = await fetchJson<unknown>(`/programs/${program.id}/regenerate-host`, {
        method: "POST",
        body: JSON.stringify({
          generation: program.generation,
          planRevision: baseRevision,
          operationId: makeId("host-script-retry"),
        }),
      });
      const remote = readProgramPayload(payload);
      if (!remote) throw new Error("服务没有返回重写后的主持词。");
      const hostMessage = payload && typeof payload === "object" && "message" in payload && typeof payload.message === "string"
        ? payload.message
        : "主持口播已生成最终可播版本，歌单没有变化。";
      const nextProgram: LocalProgram = {
        ...remote,
        report: [...program.report, { id: makeId("event"), at: nowIso(), label: "口播已生成", detail: hostMessage, tone: "success" }],
      };
      programRef.current = nextProgram;
      setProgram(nextProgram);
      createOperationRef.current = null;
      setHostScriptRetryMessage(null);
      setProcessCompletedSteps(4);
      setProcessComplete(true);
      await new Promise((resolve) => window.setTimeout(resolve, 520));
      setView(viewForProgramStatus(remote.status));
    } catch (error) {
      setProcessCompletedSteps(3);
      setProcessComplete(false);
      setHostScriptRetryMessage(error instanceof Error
        ? `${error.message} 请稍后再试；歌曲和顺序已经保留。`
        : "口播生成没有完成，请稍后再试；歌曲和顺序已经保留。");
      setView("generating");
    } finally {
      setHostScriptRetryPending(false);
    }
  };

  const handleConfirm = async (keepPlaylistForRun = keepPlaylist) => {
    if (!program || isConfirming || planUpdating) return;
    const diagnostic = sources.find((source) => source.sourceId === program.spec.sourceId);
    const player = program.spec.sourceId === "qq_music" ? desktopPlayers.qq_music : undefined;
    const playerControllable = player?.appRunning === true && !["automation_denied", "screen_locked", "failed", "app_not_running"].includes(player.state ?? "");
    const apiMusic = isApiMusicSource(program.spec.sourceId);
    const lockedArtifactsReady = apiMusic && hasLockedMusicArtifacts(program);
    const readyToConfirm = Boolean(
      (apiMusic ? lockedArtifactsReady : diagnostic?.playbackReady && diagnostic.hostedProgramAllowed)
      && health.ok
      && (apiMusic || (health.providers?.host?.configured && ["ready", "configured_unverified"].includes(health.providers.host.state ?? "")))
      && (apiMusic ? musicApiStatus[program.spec.sourceId as ApiMusicSource]?.authenticated === true : playerControllable),
    );
    if (!program.localOnly && !readyToConfirm) {
      setLastError("开播检查尚未全部通过，请刷新诊断后重试。");
      return;
    }
    if (program.localOnly) {
      setProgram(makeLocalProgram(program.spec));
      setView("on_air");
      setNotice("本地视觉测试信号正在运行，其中不包含授权音乐或 AI 语音。");
      return;
    }
    setIsConfirming(true);
    setProcessComplete(false);
    setView("preparing");
    setLastError(null);
    const operationId = makeId("confirm");
    const confirmController = new AbortController();
    const observationController = new AbortController();
    try {
      const confirmRequest = fetchJson<unknown>(`/programs/${program.id}/confirm`, {
        method: "POST",
        signal: confirmController.signal,
        body: JSON.stringify({ generation: program.generation, planRevision: program.planRevision ?? 0, operationId, keepPlaylist: keepPlaylistForRun }),
      }).then((payload) => {
        const remote = readProgramPayload(payload);
        if (!remote) throw new Error("服务返回了无效确认结果");
        return remote;
      });
      let remote = await Promise.race([
        confirmRequest,
        waitForConfirmedProgram(program.id, observationController.signal),
      ]);
      if (!remote) throw new Error("服务返回了无效确认结果");
      if (remote.status === "preparing") remote = await waitForConfirmedProgram(program.id, observationController.signal);
      confirmController.abort();
      observationController.abort();
      setProgram((current) => {
        if (!current) return current;
        const merged = mergeRemoteProgramIfCurrent(current, remote);
        return merged === current ? current : { ...merged, report: [...current.report, { id: makeId("event"), at: nowIso(), label: "节目已确认", detail: "服务已完成开播准备。", tone: "success" }] };
      });
      setProcessComplete(true);
      await new Promise((resolve) => window.setTimeout(resolve, 320));
      setView(viewForProgramStatus(remote.status));
      if (!["preparing", "on_air", "closing"].includes(remote.status)) setLastError(remote.error ?? "节目已结束，不能再次启动。");
      await refreshSources();
    } catch (error) {
      confirmController.abort();
      observationController.abort();
      if (error instanceof Error && (error as Error & { code?: string }).code === "PROGRAM_NOT_FOUND") {
        resetDraft();
        setNotice("本地服务已重新加载，旧节目草稿已失效。请重新创建节目。");
        return;
      }
      try {
        const remote = await fetchProgramWithTimeout(program.id, 5_000);
        if (!remote) throw new Error("未观察到确认结果");
        setProgram((current) => {
          if (!current) return current;
          const merged = mergeRemoteProgramIfCurrent(current, remote);
          return merged === current ? current : { ...merged, report: [...current.report, { id: makeId("event"), at: nowIso(), label: "确认状态已对账", detail: `未知响应后已恢复 · 操作 ${operationId}`, tone: "warning" }] };
        });
        if (!["draft", "awaiting_confirmation", "preparing"].includes(remote.status)) {
          setProcessComplete(true);
          await new Promise((resolve) => window.setTimeout(resolve, 320));
        }
        setView(viewForProgramStatus(remote.status));
        if (remote.status === "preparing") {
          setNotice("本地服务仍在完成语音和播放队列准备，请稍候。");
        } else if (["on_air", "closing"].includes(remote.status)) {
          setNotice("确认响应丢失，但服务状态已完成对账。");
        } else if (["draft", "awaiting_confirmation"].includes(remote.status)) {
          setLastError(confirmRetryMessage(error));
        } else {
          setLastError(remote.error ?? "节目已结束，已恢复最终状态。");
        }
      } catch {
        setLastError(confirmRetryMessage(error));
        setView("confirm");
      }
    } finally {
      setIsConfirming(false);
    }
  };

  const requestProgramConfirmation = () => {
    if (!program || isConfirming || planUpdating) return;
    if (isApiMusicSource(program.spec.sourceId) && !program.localOnly) {
      setPlaylistSavePromptOpen(true);
      return;
    }
    void handleConfirm(false);
  };

  const confirmPlaylistSaveChoice = (shouldKeepPlaylist: boolean) => {
    setPlaylistSavePromptOpen(false);
    setKeepPlaylist(shouldKeepPlaylist);
    void handleConfirm(shouldKeepPlaylist);
  };

  const updatePlan = async (action: "reorder" | "regenerate" | "adjust" | "replace", payload: Record<string, unknown> = {}) => {
    if (!program || planUpdating) return { ok: false, message: "节目单正在处理上一条要求，请稍后再试。" } satisfies PlanUpdateResult;
    const baseRevision = program.planRevision ?? 0;
    const operationId = makeId(`plan-${action}`);
    setPlanUpdating(true);
    setLastError(null);
    try {
      const response = await fetchJson<{ program?: unknown; message?: string }>(`/programs/${program.id}/${action}`, { method: "POST", body: JSON.stringify({ generation: program.generation, planRevision: baseRevision, operationId, ...payload }) });
      const remote = readProgramPayload(response);
      if (!remote) throw new Error("服务没有返回更新后的节目单。");
      setProgram((current) => current ? { ...current, ...remote } : current);
      return { ok: true, message: response.message?.trim() || "节目单已更新。" } satisfies PlanUpdateResult;
    } catch (error) {
      try {
        const remote = readProgramPayload(await fetchJson<unknown>(`/programs/${program.id}`));
        if (remote && (remote.planRevision ?? 0) > baseRevision) {
          setProgram((current) => current ? { ...current, ...remote } : current);
          setNotice("调整响应中断，但已从本地服务恢复最新节目单。");
          return { ok: true, message: "刚才的响应中断了，但我已经恢复了更新后的节目单。" } satisfies PlanUpdateResult;
        }
      } catch {
        // Preserve the original mutation error when no newer canonical plan is observable.
      }
      const message = error instanceof Error ? error.message : "节目计划调整失败。";
      setLastError(message);
      return { ok: false, message } satisfies PlanUpdateResult;
    } finally {
      setPlanUpdating(false);
    }
  };

  const requestCurrentTrackLikeToggle = () => {
    const currentProgram = programRef.current;
    const currentTrack = currentProgram?.currentTrack;
    if (!currentProgram || !currentTrack || currentProgram.status !== "on_air" || likePendingTrackId) return;
    const rundownItem = currentProgram.rundown?.find((item) => item.id === currentTrack.id) ?? currentTrack as ProgramRundownItem;
    const sourceId = isApiMusicSource(rundownItem.sourceId) ? rundownItem.sourceId : isApiMusicSource(currentProgram.spec.sourceId) ? currentProgram.spec.sourceId : null;
    if (!sourceId) return;
    const liked = rundownItem.liked !== true;
    setLikeConfirmPrompt({ trackId: currentTrack.id, trackTitle: currentTrack.title, sourceId, liked });
  };

  const confirmCurrentTrackLikeToggle = async () => {
    const prompt = likeConfirmPrompt;
    const currentProgram = programRef.current;
    if (!prompt || !currentProgram || currentProgram.status !== "on_air" || likePendingTrackId) return;
    const rundownItem = currentProgram.rundown?.find((item) => item.id === prompt.trackId);
    if (!rundownItem) {
      setLikeConfirmPrompt(null);
      setNotice("当前歌曲已切换，请重新点击喜欢。");
      return;
    }
    setLastError(null);
    setLikePendingTrackId(prompt.trackId);
    try {
      const payload = await fetchJson<unknown>(`/programs/${currentProgram.id}/current/like`, {
        method: "POST",
        body: JSON.stringify({ generation: currentProgram.generation, trackId: prompt.trackId, liked: prompt.liked }),
      });
      const remote = readProgramPayload(payload);
      if (!remote) throw new Error("服务没有返回更新后的喜欢状态。");
      setProgram((current) => current ? mergeRemoteProgramIfCurrent(current, remote) : current);
      setLikeConfirmPrompt(null);
    } catch (error) {
      setNotice(prompt.liked ? "没有写入我喜欢，电台继续播放。" : "没有取消喜欢，电台继续播放。");
      setLikeConfirmPrompt(null);
    } finally {
      setLikePendingTrackId(null);
    }
  };

  const handleNext = async (naturalEnd = false, retryAttempt = 0) => {
    if (!program || nextInFlightRef.current || program.status !== "on_air") return;
    nextInFlightRef.current = true;
    if (!naturalEnd && nextRetryTimerRef.current !== null) {
      window.clearTimeout(nextRetryTimerRef.current);
      nextRetryTimerRef.current = null;
    }
    heartbeatRequestRef.current?.abort();
    setIsNexting(true);
    setLastError(null);
    const operationId = makeId("next");
    if (program.localOnly) {
      setProgram((current) => {
        if (!current || !current.currentTrack) return current;
        const [next, ...queue] = current.queue;
        if (!next) {
          return { ...current, error: "测试队列中没有下一首曲目。", report: [...current.report, { id: makeId("event"), at: nowIso(), label: "下一首不可用", detail: "测试队列为空。", tone: "warning" }] };
        }
        return {
          ...current,
          currentTrack: next,
          nextTrack: queue[0] ?? null,
          queue,
          generation: current.generation + 1,
          host: null,
          report: [...current.report, { id: makeId("event"), at: nowIso(), label: "下一首曲目", detail: `${next.title} · 操作 ${operationId}`, tone: "success" }],
        };
      });
      nextInFlightRef.current = false;
      setIsNexting(false);
      return;
    }
    try {
      const payload = await fetchJson<unknown>(`/programs/${program.id}/next`, {
        method: "POST",
        body: JSON.stringify({ generation: program.generation, operationId }),
      });
      const remote = readProgramPayload(payload);
      if (!remote) throw new Error("服务返回了无效的下一首结果");
      if (nextRetryTimerRef.current !== null) window.clearTimeout(nextRetryTimerRef.current);
      nextRetryTimerRef.current = null;
      if (["stopped", "completed", "failed", "stop_unconfirmed"].includes(remote.status)) {
        await stopAudio({ waitForRestore: true });
        setProgram((current) => {
          if (!current) return current;
          const merged = mergeRemoteProgramIfCurrent(current, remote);
          return merged === current ? current : { ...merged, report: [...current.report, { id: makeId("event"), at: nowIso(), label: "节目提前结束", detail: "节目单已经耗尽，没有动态补充歌曲。", tone: "warning" }] };
        });
        setView("ended");
        return;
      }
      setProgram((current) => {
        if (!current) return current;
        const merged = mergeRemoteProgramIfCurrent(current, remote);
        return merged === current ? current : { ...merged, report: [...current.report, { id: makeId("event"), at: nowIso(), label: "下一首曲目", detail: isApiMusicSource(program.spec.sourceId) ? `已进入节目单下一首 · 操作 ${operationId}` : `客户端没有返回目标曲目确认 · 操作 ${operationId}`, tone: isApiMusicSource(program.spec.sourceId) ? "success" : "warning" }] };
      });
      setNotice(isApiMusicSource(program.spec.sourceId) ? null : "切歌请求已发送；是否成功及实际曲目以桌面客户端为准。");
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "选择下一首失败");
      if (naturalEnd && retryAttempt < 2) {
        const retryProgramId = program.id;
        const retryGeneration = program.generation;
        const retryTrackId = program.currentTrack?.id;
        if (nextRetryTimerRef.current !== null) window.clearTimeout(nextRetryTimerRef.current);
        nextRetryTimerRef.current = window.setTimeout(() => {
          nextRetryTimerRef.current = null;
          const latest = programRef.current;
          if (!latest || latest.id !== retryProgramId || latest.generation !== retryGeneration || latest.currentTrack?.id !== retryTrackId || latest.status !== "on_air") return;
          void handleNextRef.current(true, retryAttempt + 1);
        }, 750 * (retryAttempt + 1));
      } else if (naturalEnd) {
        try {
          const currentPayload = await fetchJson<unknown>(`/programs/${program.id}`);
          const current = readProgramPayload(currentPayload);
          if (!current) throw new Error("无法读取节目状态");
          if (current.generation !== program.generation || current.currentTrack?.id !== program.currentTrack?.id || !["on_air", "preparing"].includes(current.status)) {
            setProgram((previous) => previous ? mergeRemoteProgramIfCurrent(previous, current) : { ...current, report: [] });
          } else {
            const stoppedPayload = await fetchJson<unknown>(`/programs/${program.id}/stop`, {
              method: "POST",
              body: JSON.stringify({ generation: current.generation, operationId: makeId("auto-stop") }),
            });
            const stopped = readProgramPayload(stoppedPayload);
            if (!stopped) throw new Error("服务没有确认节目停止");
            await stopAudio({ waitForRestore: true });
            setProgram((previous) => previous ? { ...previous, ...stopped, report: [...previous.report, { id: makeId("event"), at: nowIso(), label: "播放链路已停止", detail: "连续切歌失败，节目已安全停止。", tone: "warning" }] } : previous);
            setView("ended");
            setNotice("连续切歌失败，节目已安全停止。请重新开始一档节目。");
          }
        } catch {
          await stopAudio({ waitForRestore: true });
          setProgram((current) => current && current.id === program.id ? { ...current, status: "failed", error: "连续切歌失败，已停止本地音频。" } : current);
          setView("ended");
          setLastError("连续切歌失败，已停止本地音频。服务端仍会在硬截止时间结束节目。");
        }
      }
    } finally {
      nextInFlightRef.current = false;
      setIsNexting(false);
    }
  };
  handleNextRef.current = handleNext;

  const handleMusicError = () => {
    const track = program?.currentTrack;
    if (!program || !isApiMusicSource(program.spec.sourceId) || !track?.audioUrl || program.status !== "on_air") {
      setAudioError("音乐音频无法加载，节目单仍可查看。");
      return;
    }
    const key = `${program.id}:${program.generation}:${track.id}`;
    const failure = musicFailureRef.current?.key === key ? musicFailureRef.current : { key, attempts: 0 };
    failure.attempts += 1;
    musicFailureRef.current = failure;
    if (failure.attempts === 1) {
      setNotice("当前播放地址失效，正在刷新后重试一次。");
      const separator = track.audioUrl.includes("?") ? "&" : "?";
      void setMusicFromSource(`${track.audioUrl}${separator}retry=${Date.now()}`, key);
      return;
    }
    setNotice("当前歌曲仍无法播放，正在跳到下一首。");
    void handleNext(true);
  };

  const handleStop = async () => {
    if (!program || isStopping || ["stopped", "completed", "failed", "stop_unconfirmed"].includes(program.status)) return;
    heartbeatRequestRef.current?.abort();
    setIsStopping(true);
    setLastError(null);
    const operationId = makeId("stop");
    // Finish any active TTS duck lease before asking the service to stop the program.
    // This prevents a late restore response from racing the desktop stop command.
    await stopAudio({ waitForRestore: true });
    if (program.localOnly) {
      setProgram((current) => current ? {
        ...current,
        status: "stopped",
        remainingSeconds,
        host: current.host ? { ...current.host, status: "skipped" } : null,
        report: [...current.report, { id: makeId("event"), at: nowIso(), label: "节目已停止", detail: `用户确认停止 · 操作 ${operationId}`, tone: "success" }],
      } : current);
      setAudioPlaying(false);
      setView("ended");
      setNotice(null);
      setIsStopping(false);
      return;
    }
    try {
      const payload = await fetchJson<unknown>(`/programs/${program.id}/stop`, {
        method: "POST",
        body: JSON.stringify({ generation: program.generation, operationId }),
      });
      const remote = readProgramPayload(payload);
      if (!remote) throw new Error("服务返回了无效的停止结果");
      setProgram((current) => current ? { ...current, ...remote, report: [...current.report, { id: makeId("event"), at: nowIso(), label: "已请求停止", detail: `操作 ${operationId}`, tone: "success" }] } : current);
      setView("ended");
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "停止未能确认");
    } finally {
      setIsStopping(false);
    }
  };

  const handleExitProgram = async () => {
    if (!program || isStopping) return;
    if (["stopped", "completed", "failed", "stop_unconfirmed"].includes(program.status)) {
      resetDraft();
      return;
    }
    setIsStopping(true);
    setLastError(null);
    try {
      const operationId = makeId("exit-program");
      const payload = await fetchJson<unknown>(`/programs/${program.id}/stop`, {
        method: "POST",
        body: JSON.stringify({ generation: program.generation, operationId }),
      });
      const remote = readProgramPayload(payload);
      if (!remote || !["stopped", "completed", "failed", "stop_unconfirmed"].includes(remote.status)) throw new Error("退出节目未能确认");
      await stopAudio({ waitForRestore: true });
      resetDraft();
    } catch (error) {
      try {
        const remote = readProgramPayload(await fetchJson<unknown>(`/programs/${program.id}`));
        if (remote && ["stopped", "completed", "failed", "stop_unconfirmed"].includes(remote.status)) {
          await stopAudio({ waitForRestore: true });
          resetDraft();
          setNotice("退出响应中断，但服务状态已完成对账。你可以重新创建节目。");
          return;
        }
        setProgram((current) => current ? { ...current, ...remote } : current);
      } catch (reconcileError) {
        if (reconcileError instanceof Error && (reconcileError as Error & { code?: string }).code === "PROGRAM_NOT_FOUND") {
          await stopAudio({ waitForRestore: true });
          resetDraft();
          setNotice("节目已不在本地服务中，你可以重新创建节目。");
          return;
        }
      }
      setLastError(error instanceof Error ? error.message : "退出节目失败，请重试。节目仍保持当前状态。");
    } finally {
      setIsStopping(false);
    }
  };

  const enforcePlaybackDeadline = () => {
    if (!program?.deadlineAt || !["preparing", "on_air", "closing"].includes(program.status)) return true;
    if (Date.now() < new Date(program.deadlineAt).getTime()) return true;
    void stopAudio();
    setProgram((current) => current && current.id === program.id && ["preparing", "on_air", "closing"].includes(current.status)
      ? { ...current, status: "completed", remainingSeconds: 0, currentTrack: null, nextTrack: null, queue: [], host: null }
      : current);
    return false;
  };

  const resetDraft = () => {
    setProgram(null);
    setView("setup");
    setConnectionReviewOpen(false);
    setSetupPhase(localOnboardingComplete && initializationReady ? "settings" : "connect");
    setLastError(null);
    setNotice(null);
    setShowPlaylist(false);
    setKeepPlaylist(false);
    setPlaylistSavePromptOpen(false);
  };

  const renderView = () => {
    if (view === "settings") return <LocalSettingsView
      section={settingsSection}
      onSectionChange={setSettingsSection}
      onClose={() => setView(settingsReturnViewRef.current === "settings" ? "setup" : settingsReturnViewRef.current)}
      sources={sources}
      sourceTransport={sourceTransport}
      health={health}
      musicApiStatus={musicApiStatus}
      musicQrLogin={musicQrLogin}
      musicLoginPending={musicLoginPending}
      onStartMusicLogin={(sourceId) => void startMusicLogin(sourceId)}
      onRefreshMusicLogin={(sourceId) => {
        setMusicQrLogin(null);
        void startMusicLogin(sourceId);
      }}
      onCancelMusicLogin={() => setMusicQrLogin(null)}
      aiConfig={aiConfig}
      aiConfigPending={aiConfigPending}
      onRefreshAiConfig={() => void refreshAiConfig()}
      onSaveAiConfig={saveAiConfig}
      onTestAi={testAiService}
      aiTestTarget={aiTestTarget}
      invitationAccess={invitationAccess}
      invitationPending={invitationPending}
      onClaimInvitation={claimInvitation}
      onRefreshAll={() => { void refreshSources(); void refreshHealth(); void refreshMusicStatus(); void refreshAiConfig(); void refreshInvitationAccess(true); }}
      desktopPetEnabled={desktopPetEnabled}
      onDesktopPetEnabledChange={setDesktopPetEnabled}
      audioOutputId={audioOutputId}
      onAudioOutputChange={setAudioOutputId}
      onNotice={setNotice}
      onError={setLastError}
    />;
    if (view === "generating") return <ProcessView mode="generating" complete={processComplete} completedSteps={processCompletedSteps} hostRetryMessage={hostScriptRetryMessage} hostRetryPending={hostScriptRetryPending} onRetryHostScripts={() => void regenerateHostScripts()} />;
    if (view === "preparing") return <ProcessView mode="preparing" complete={processComplete} />;
    if (view === "confirm" && program) {
      const diagnostic = sources.find((source) => source.sourceId === program.spec.sourceId);
      const apiMusic = isApiMusicSource(program.spec.sourceId);
      const lockedArtifactsReady = apiMusic && hasLockedMusicArtifacts(program);
      const checks = {
        source: apiMusic
          ? Boolean((program.rundown?.length ?? 0) > 0 && program.planSummary)
          : Boolean(diagnostic?.playbackReady && diagnostic.hostedProgramAllowed),
        player: apiMusic ? musicApiStatus[program.spec.sourceId as ApiMusicSource]?.authenticated === true : true,
        service: health.ok,
        host: apiMusic
          ? lockedArtifactsReady
          : Boolean(health.providers?.host?.configured && ["ready", "configured_unverified"].includes(health.providers.host.state ?? "")),
        tts: apiMusic ? invitationAccess?.connected === true : Boolean(health.providers?.tts?.configured),
      };
      return <ConfirmView program={program} checks={checks} onExit={() => void handleExitProgram()} onConfirm={requestProgramConfirmation} confirming={isConfirming} exiting={isStopping} updating={planUpdating} onReplace={(trackId) => updatePlan("replace", { trackId })} onAdjust={(message) => updatePlan("adjust", { message })} onRegenerate={() => updatePlan("regenerate")} />;
    }
    if ((view === "on_air" || view === "ended") && program) {
      return (
          <OnAirView
            program={program}
            remainingSeconds={remainingSeconds}
          onNext={() => void handleNext()}
          onStop={() => void handleStop()}
          nexting={isNexting}
          stopping={isStopping}
          onPlaylist={() => setShowPlaylist(true)}
          onBackToSetup={resetDraft}
          audioPlaying={audioPlaying}
          trackElapsedSeconds={trackElapsedSeconds}
          trackDurationSeconds={trackDurationSeconds}
          onToggleAudio={toggleAudio}
          audioNeedsGesture={audioNeedsGesture}
          audioError={audioError}
          onEnableAudio={() => void enableAudio()}
          hostPreviewPending={hostPreviewPending}
          likePending={likePendingTrackId === program.currentTrack?.id}
          onToggleCurrentLike={requestCurrentTrackLikeToggle}
          audioRef={musicAudioRef}
        />
      );
    }
    return (
      <SetupView
        phase={setupPhase}
        onPhaseChange={(phase) => {
          if (phase !== "settings") cancelVoicePreview();
          if (phase === "settings" && initializationReady) {
            window.localStorage.setItem(LOCAL_ONBOARDING_COMPLETE_KEY, "true");
            setLocalOnboardingComplete(true);
          }
          setConnectionReviewOpen(phase === "connect");
          setSetupPhase(phase);
        }}
        sources={sources}
        sourceTransport={sourceTransport}
        diagnosticsUnavailable={sourceTransport === "failed"}
        selectedSource={selectedSource}
        onSourceChange={(source) => {
          if (musicQrLogin && musicQrLogin.sourceId !== source) setMusicQrLogin(null);
          setSelectedSource(source);
        }}
        durationMinutes={durationMinutes}
        onDurationChange={setDurationMinutes}
        recommendationMode={recommendationMode}
        onRecommendationModeChange={(mode) => setRecommendationMode(mode)}
        scenePreset={scenePreset}
        onSceneChange={(scene) => { setScenePreset(scene); setHostDensity(SCENE_META[scene].density); }}
        hostDensity={hostDensity}
        onDensityChange={setHostDensity}
        hostProfile={hostProfile}
        onHostProfileChange={(profile) => {
          cancelVoicePreview();
          setHostProfile(profile);
        }}
        musicGenres={musicGenres.slice(0, MAX_MUSIC_GENRES)}
        onMusicGenresChange={setMusicGenres}
        desktopPetEnabled={desktopPetEnabled}
        onDesktopPetEnabledChange={setDesktopPetEnabled}
        familiarityRatio={familiarityRatio}
        onFamiliarityRatioChange={setFamiliarityRatio}
        onSubmit={(event) => void handleCreate(event)}
        canCreate={canCreate}
        createBlocker={createBlocker}
        creating={isCreating}
        showDetails={showSourceDetails}
        onToggleDetails={() => setShowSourceDetails((show) => !show)}
        onRefreshSources={() => void refreshSources()}
        onTogglePlayer={() => void controlDesktopPlayer("toggle")}
        onNextTrack={() => void controlDesktopPlayer("next")}
        desktopControlPending={desktopControlPending}
        analysisState={musicPreferencesState}
        musicApiStatus={musicApiStatus}
        musicQrLogin={musicQrLogin}
        musicLoginPending={musicLoginPending}
        onStartMusicLogin={(sourceId) => void startMusicLogin(sourceId)}
        onRefreshMusicLogin={(sourceId) => {
          setMusicQrLogin(null);
          void startMusicLogin(sourceId);
        }}
        onCancelMusicLogin={() => setMusicQrLogin(null)}
        aiConfig={aiConfig}
        aiConfigPending={aiConfigPending}
        onRefreshAiConfig={() => void refreshAiConfig()}
        onSaveAiConfig={saveAiConfig}
        onTestAi={testAiService}
        aiTestTarget={aiTestTarget}
        invitationAccess={invitationAccess}
        invitationPending={invitationPending}
        onClaimInvitation={claimInvitation}
        errorMessage={lastError}
        onDismissError={() => setLastError(null)}
        onPreviewHost={(profileId) => void previewHostVoice(profileId)}
        voicePreviewProfile={voicePreviewProfile}
      />
    );
  };

  const closePlaylist = useCallback(() => setShowPlaylist(false), []);

  const standalonePreparing = view === "preparing";
  const visibleNotice = notice && (notice.tone === "warning" || !["on_air", "ended"].includes(view)) ? notice : null;
  if (showLanding) return <LandingPage onEnter={() => {
    landingEnteredRef.current = true;
    landingFocusPendingRef.current = true;
    if (!program || ["completed", "stopped", "failed", "control_lost", "stop_unconfirmed"].includes(program.status)) resetDraft();
    setShowLanding(false);
  }} />;
  return (
    <div className={`app-shell${standalonePreparing ? " app-shell-preparing" : ""}`}>
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark" aria-hidden="true"><img src="/brand/openmusicradio-icon-note-headphones.png" alt="" /></div>
          <div className="brand-lockup">
            <div className="brand-name brand-neon-wordmark" aria-label="OPEN MUSIC RADIO">
              <span>OPEN MUSIC</span>
              <strong>RADIO</strong>
            </div>
            <div className="brand-subtitle">LOCAL BROADCAST / OMR-01</div>
          </div>
        </div>
        {view === "settings" ? <div className="topbar-context" aria-label="当前页面"><Settings2 size={15} /><span><strong>本机设置</strong><small>LOCAL CONFIG</small></span></div> : <nav className="top-stage-nav" aria-label="节目流程">
          <TopStage index="01" label="连接平台" state={view === "setup" ? setupPhase === "connect" ? "active" : "done" : "done"} />
          <TopStage index="02" label="设置节目" state={view === "setup" ? setupPhase === "settings" ? "active" : "upcoming" : "done"} />
          <TopStage index="03" label="生成节目" state={view === "generating" ? "active" : view === "setup" ? "upcoming" : "done"} />
          <TopStage index="04" label="确认计划" state={view === "confirm" ? "active" : ["preparing", "on_air", "ended"].includes(view) ? "done" : "upcoming"} />
          <TopStage index="05" label="播出中" state={["preparing", "on_air"].includes(view) ? "active" : view === "ended" ? "done" : "upcoming"} />
        </nav>}
        <div className="topbar-actions">
          <IconButton label={view === "settings" ? "返回节目" : broadcastNavigationLocked ? "播出中不可打开设置" : "本机设置"} disabled={broadcastNavigationLocked} className={`topbar-tool topbar-tool-settings${view === "settings" ? " is-active" : ""}`} onClick={() => {
            if (broadcastNavigationLocked) return;
            if (view === "settings") {
              setView(settingsReturnViewRef.current === "settings" ? "setup" : settingsReturnViewRef.current);
              return;
            }
            settingsReturnViewRef.current = view;
            cancelVoicePreview();
            setView("settings");
          }}>{view === "settings" ? <X size={20} strokeWidth={1.8} /> : <Settings2 size={20} strokeWidth={1.8} />}</IconButton>
        </div>
      </header>

      <div className={`page-frame view-${view}${view === "setup" ? ` setup-phase-${setupPhase}` : ""}${standalonePreparing ? " preparing-frame" : ""}`}>
        <main className="main-content" tabIndex={-1}>
          {view !== "setup" && lastError && <div className="feedback-region"><ErrorBanner message={lastError} onDismiss={() => setLastError(null)} /></div>}
          {visibleNotice?.tone === "warning" && <div className="feedback-region"><NoticeBanner notice={visibleNotice} onDismiss={() => setNotice(null)} /></div>}
          {renderView()}
        </main>
      </div>

      {visibleNotice && visibleNotice.tone !== "warning" && <NoticeToast notice={visibleNotice} onDismiss={() => setNotice(null)} />}

      {showPlaylist && program && <PlaylistDialog program={program} onClose={closePlaylist} />}
      {playlistSavePromptOpen && program && isApiMusicSource(program.spec.sourceId) && (
        <PlaylistSaveDialog
          sourceId={program.spec.sourceId}
          trackCount={program.rundown?.length ?? 0}
          confirming={isConfirming}
          onKeep={() => confirmPlaylistSaveChoice(true)}
          onTemporary={() => confirmPlaylistSaveChoice(false)}
          onClose={() => setPlaylistSavePromptOpen(false)}
        />
      )}
      {likeConfirmPrompt && (
        <LikeSongConfirmDialog
          sourceId={likeConfirmPrompt.sourceId}
          trackTitle={likeConfirmPrompt.trackTitle}
          liked={likeConfirmPrompt.liked}
          confirming={likePendingTrackId === likeConfirmPrompt.trackId}
          onConfirm={() => void confirmCurrentTrackLikeToggle()}
          onClose={() => setLikeConfirmPrompt(null)}
        />
      )}
      <audio
        key="meyda-audio-graph-v1"
        ref={musicAudioRef}
        onPlay={(event) => {
          if (enforcePlaybackDeadline()) setAudioPlaying(true);
          setTrackElapsedSeconds(event.currentTarget.currentTime || 0);
        }}
        onTimeUpdate={(event) => {
          if (!enforcePlaybackDeadline()) return;
          setTrackElapsedSeconds(event.currentTarget.currentTime || 0);
          if (Number.isFinite(event.currentTarget.duration) && event.currentTarget.duration > 0) setTrackDurationSeconds(event.currentTarget.duration);
        }}
        onLoadedMetadata={(event) => {
          if (Number.isFinite(event.currentTarget.duration) && event.currentTarget.duration > 0) setTrackDurationSeconds(event.currentTarget.duration);
        }}
        onDurationChange={(event) => {
          if (Number.isFinite(event.currentTarget.duration) && event.currentTarget.duration > 0) setTrackDurationSeconds(event.currentTarget.duration);
        }}
        onPause={() => setAudioPlaying(false)}
        onEnded={() => {
          if (!program || !isApiMusicSource(program.spec.sourceId) || !program.currentTrack?.audioUrl) return;
          const next = program.nextTrack as ProgramRundownItem | null;
          if (next?.audioUrl && !next.hostMoment) {
            const nextKey = `${program.id}:${program.generation + 1}:${next.id}`;
            seamlessMusicKeyRef.current = nextKey;
            fixtureAudioRef.current = { url: next.audioUrl, key: nextKey };
            musicFailureRef.current = { key: nextKey, attempts: 0 };
            void setMusicFromSource(next.audioUrl, nextKey);
          }
          void handleNext(true);
        }}
        onCanPlay={() => setAudioError(null)}
        onError={handleMusicError}
        aria-label="当前曲目音频"
      />
      <audio ref={audioRef} onError={handleHostAudioError} aria-label="主持人口播音频" />
    </div>
  );
}

function LandingPage({ onEnter }: { onEnter: () => void }) {
  return (
    <main className="radio-landing">
      <div className="landing-cyber-grid" aria-hidden="true" />
      <div className="landing-particles" aria-hidden="true">
        {Array.from({ length: 18 }, (_, index) => <i key={index} style={{
          "--particle-x": `${(index * 37 + 7) % 100}%`,
          "--particle-y": `${(index * 53 + 11) % 94}%`,
          "--particle-delay": `${-(index % 13) * 0.41}s`,
          "--particle-drift": `${18 + (index % 7) * 9}px`,
          "--particle-duration": `${4.8 + (index % 6) * 0.55}s`,
        } as CSSProperties} />)}
      </div>
      <header className="landing-header">
        <div className="landing-system"><StatusDot tone="ready" />LOCAL AI BROADCAST SYSTEM</div>
        <div className="landing-channel">SIGNAL /// 001</div>
      </header>
      <section className="landing-stage" aria-labelledby="landing-title">
        <div className="landing-title-block">
          <div className="landing-kicker-row"><span className="landing-kicker">PRIVATE SIGNAL</span><span className="landing-frequency">FM 001.0</span></div>
          <h1 id="landing-title" className="landing-wordmark" aria-label="OPEN MUSIC RADIO">
            <span className="landing-wordmark-open" data-text="OPEN MUSIC">OPEN MUSIC</span>
            <strong data-text="RADIO">RADIO</strong>
          </h1>
          <p>把今晚调到你的频率。</p>
          <div className="landing-capabilities" aria-label="本机电台能力">
            <span><b>01</b><strong>LOCAL MUSIC</strong><small>授权音乐源</small></span>
            <span><b>02</b><strong>AI HOST</strong><small>个性化主持</small></span>
            <span><b>03</b><strong>PRIVATE MODE</strong><small>本机运行</small></span>
          </div>
          <button className="landing-play" type="button" onClick={onEnter} aria-label="进入 OPEN MUSIC RADIO 连接平台">
            <span className="landing-play-icon"><Play size={17} fill="currentColor" /></span>
            <span><strong>ENTER BROADCAST</strong><small>进入控制台</small></span>
          </button>
        </div>
        <div className="landing-entry-console">
          <div className="landing-crt" aria-hidden="true">
            <div className="landing-crt-bezel">
              <div className="landing-crt-screen">
                <div className="landing-crt-readout"><span>OMR://PRIVATE-BAND</span><strong>001.0</strong></div>
                <div className="landing-hacker-terminal">
                  <div className="landing-terminal-lines">
                    <span><b>OMR@LOCAL</b>:~$ init broadcast</span>
                    <span><em>[NODE]</em> LOCAL AUDIO BUS / STANDBY</span>
                    <span><em>[ROUTER]</em> PRIVATE SIGNAL / IDLE</span>
                    <span><em>[HOST]</em> VOICE CHANNEL / UNLINKED</span>
                    <span className="landing-terminal-prompt">&gt; AWAITING OPERATOR_<i /></span>
                  </div>
                  <div className="landing-terminal-spectrum">{Array.from({ length: 29 }, (_, index) => <i key={index} style={{ "--bar": index } as CSSProperties} />)}</div>
                </div>
                <div className="landing-crt-lock"><span>LOCAL SIGNAL</span><b>STANDBY</b></div>
              </div>
              <div className="landing-crt-deck">
                <span className="landing-crt-led" />
                <span className="landing-crt-knob" />
                <span className="landing-crt-segments"><i /><i /><i /><i /></span>
                <span className="landing-crt-level"><i /></span>
              </div>
            </div>
          </div>
          <div className="landing-console-status" aria-hidden="true">
            <span><b>BUS</b> LOCAL</span><span><b>HOST</b> STANDBY</span><span><b>OUT</b> PRIVATE</span>
          </div>
        </div>
      </section>
      <div className="landing-route" aria-hidden="true">
        <span><b>01</b> CONNECT SOURCE</span><i /><span><b>02</b> BUILD PROGRAM</span><i /><span><b>03</b> OPEN BROADCAST</span>
      </div>
      <footer className="landing-footer"><span>NEXT / CONNECT</span><span>OPEN MUSIC RADIO / LOCAL MODE</span><span>{new Date().getFullYear()}</span></footer>
    </main>
  );
}

function TopStage({ index, label, state }: { index: string; label: string; state: "active" | "done" | "upcoming" }) {
  return <span className={`top-stage top-stage-${state}`} aria-current={state === "active" ? "step" : undefined}><span className="top-stage-index"><small>CH</small><strong>{index}</strong></span><span className="top-stage-copy"><strong>{label}</strong></span>{state === "done" && <Check size={11} className="top-stage-check" aria-hidden="true" />}</span>;
}

function StepItem({ index, label, state }: { index: string; label: string; state: "active" | "done" | "upcoming" }) {
  return (
    <div className={`step-item step-${state}`}>
      <span className="step-number">{state === "done" ? <Check size={13} /> : index}</span>
      <span>{label}</span>
    </div>
  );
}

function ErrorBanner({ message, onDismiss, title = "无法继续当前操作" }: { message: string; onDismiss: () => void; title?: string }) {
  return <div className="inline-alert inline-alert-error" role="alert"><span className="feedback-icon"><TriangleAlert size={16} /></span><span className="feedback-copy"><strong>{title}</strong><small>{message}</small></span><IconButton label="关闭错误提示" onClick={onDismiss}><X size={15} /></IconButton></div>;
}

function NoticeBanner({ notice, onDismiss }: { notice: AppNotice; onDismiss: () => void }) {
  return <div className="inline-alert inline-alert-warning" role="status"><span className="feedback-icon"><AlertTriangle size={16} /></span><span className="feedback-copy"><strong>系统将继续安全运行</strong><small>{notice.message}</small></span><IconButton label="关闭提示" onClick={onDismiss}><X size={15} /></IconButton></div>;
}

function NoticeToast({ notice, onDismiss }: { notice: AppNotice; onDismiss: () => void }) {
  const icon = notice.tone === "success" ? <Check size={15} /> : <Info size={15} />;
  return <div className={`feedback-toast feedback-toast-${notice.tone}`} role="status" aria-live="polite"><span className="feedback-icon">{icon}</span><span>{notice.message}</span><IconButton label="关闭提示" onClick={onDismiss}><X size={14} /></IconButton></div>;
}

const LLM_OPTIONS: Array<{ id: AiConfigStatus["llm"]["provider"]; label: string; model: string }> = [
  { id: "openai", label: "OpenAI", model: "gpt-5.4-mini" },
  { id: "deepseek", label: "DeepSeek", model: "deepseek-v4-flash" },
  { id: "qwen", label: "通义千问", model: "qwen-plus" },
  { id: "anthropic", label: "Anthropic", model: "claude-sonnet-4-6" },
  { id: "gemini", label: "Google Gemini", model: "gemini-3.5-flash" },
  { id: "custom", label: "OpenAI 兼容", model: "model-name" },
];
const TTS_OPTIONS: Array<{ id: AiConfigStatus["tts"]["provider"]; label: string; model: string; voice: string }> = [
  { id: "qwen", label: "通义 CosyVoice", model: "cosyvoice-v2", voice: "longanxuan" },
  { id: "openai", label: "OpenAI TTS", model: "gpt-4o-mini-tts", voice: "auto" },
  { id: "azure", label: "Azure Speech", model: "neural-tts", voice: "auto" },
];

const AI_PROVIDER_GUIDES: Record<AiConfigStatus["llm"]["provider"], { label: string; href: string; detail: string }> = {
  openai: { label: "OpenAI", href: "https://platform.openai.com/api-keys", detail: "在 API Keys 中创建项目密钥。" },
  deepseek: { label: "DeepSeek", href: "https://platform.deepseek.com/api_keys", detail: "登录开放平台后创建 API Key。" },
  qwen: { label: "通义千问", href: "https://bailian.console.aliyun.com/?apiKey=1#/api-key", detail: "在阿里云百炼控制台创建 DashScope API Key。" },
  anthropic: { label: "Anthropic", href: "https://console.anthropic.com/settings/keys", detail: "在 Console 的 API Keys 中创建密钥。" },
  gemini: { label: "Google Gemini", href: "https://aistudio.google.com/apikey", detail: "在 Google AI Studio 创建 Gemini API Key。" },
  custom: { label: "OpenAI 兼容服务", href: "https://platform.openai.com/docs/api-reference/authentication", detail: "填写服务商提供的 HTTPS API 地址、模型名和密钥。" },
};

const TTS_PROVIDER_GUIDES: Record<AiConfigStatus["tts"]["provider"], { label: string; href: string; detail: string }> = {
  qwen: { label: "通义 CosyVoice", href: "https://help.aliyun.com/en/model-studio/get-api-key", detail: "CosyVoice 与通义千问可共用 DashScope API Key。" },
  openai: { label: "OpenAI TTS", href: "https://platform.openai.com/api-keys", detail: "使用具有音频模型权限的 OpenAI 项目密钥。" },
  azure: { label: "Azure Speech", href: "https://learn.microsoft.com/en-us/azure/ai-services/speech-service/get-started-speech-to-text", detail: "创建 Speech 资源，并填写资源 Key 与对应区域。" },
};

function AiServicePanel({ config, pending, testTarget, onReload, onSave, onTest }: { config: AiConfigStatus | null; pending: boolean; testTarget: "llm" | "tts" | null; onReload: () => void; onSave: (settings: AiConfigStatus, secrets: { llmApiKey: string; ttsApiKey: string }) => Promise<AiConfigStatus | null>; onTest: (target: "llm" | "tts") => Promise<boolean> }) {
  const [draft, setDraft] = useState<AiConfigStatus | null>(null);
  const [llmApiKey, setLlmApiKey] = useState("");
  const [ttsApiKey, setTtsApiKey] = useState("");
  const [showGuide, setShowGuide] = useState(false);
  const [verifying, setVerifying] = useState(false);
  useEffect(() => { if (config) setDraft(config); }, [config]);
  const value = draft ?? config;
  if (!value) return <section className="ai-service-panel" aria-busy={pending}>{pending ? <><LoaderCircle size={15} className="spin" />正在读取本机 AI 配置</> : <><TriangleAlert size={15} />本机 AI 配置读取失败<button className="text-button" type="button" onClick={onReload}><RefreshCw size={13} />重试</button></>}</section>;
  const updateLlmProvider = (provider: AiConfigStatus["llm"]["provider"]) => {
    const option = LLM_OPTIONS.find((item) => item.id === provider)!;
    setDraft({ ...value, llm: { provider, model: option.model, hasKey: provider === value.llm.provider && value.llm.hasKey } });
  };
  const updateTtsProvider = (provider: AiConfigStatus["tts"]["provider"]) => {
    const option = TTS_OPTIONS.find((item) => item.id === provider)!;
    setDraft({ ...value, tts: { provider, model: option.model, voice: option.voice, hasKey: provider === value.tts.provider && value.tts.hasKey, ...(provider === "azure" ? { region: "eastasia" } : {}) } });
  };
  const saveAndTest = async () => {
    if (verifying) return;
    setVerifying(true);
    const saved = await onSave(value, { llmApiKey, ttsApiKey });
    if (!saved) {
      setVerifying(false);
      return;
    }
    setLlmApiKey("");
    setTtsApiKey("");
    const llmReady = await onTest("llm");
    const ttsReady = llmReady ? await onTest("tts") : false;
    if (llmReady && ttsReady) {
      setDraft(saved);
    }
    setVerifying(false);
  };
  const llmGuide = AI_PROVIDER_GUIDES[value.llm.provider];
  const ttsGuide = TTS_PROVIDER_GUIDES[value.tts.provider];
  const connected = value.llm.hasKey && value.tts.hasKey;
  return <section className="ai-service-panel onboarding-service-card">
    <div className="onboarding-card-heading">
      <span><Sparkles size={15} /><span><strong>本机 AI 服务</strong><small>文案生成与主持语音</small></span></span>
      <span className={`service-connection-state ${connected ? "is-connected" : "is-pending"}`}><StatusDot tone={connected ? "ready" : "muted"} />{connected ? "已连通" : "待配置"}</span>
    </div>
      <div className="onboarding-card-tools"><button className="text-button" type="button" onClick={() => setShowGuide(true)}><BookOpen size={14} />获取 API 教程</button><span>{connected ? `${llmGuide.label} + ${ttsGuide.label}` : "选择供应商并填写密钥"}</span></div>
      <p className="onboarding-privacy-note">密钥只提交给这台 Mac 上的本机服务，不会保存在浏览器中。已配置的密钥留空即可保留。</p>
      <div className="ai-config-grid ai-onboarding-grid">
        <fieldset className="ai-provider-card"><legend>大模型</legend>
          <div className="ai-provider-card-status"><span>{llmGuide.label}</span><strong>{value.llm.hasKey ? "已连通" : "待填写密钥"}</strong></div>
          <label>供应商<select value={value.llm.provider} onChange={(event) => updateLlmProvider(event.target.value as AiConfigStatus["llm"]["provider"])}>{LLM_OPTIONS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          <label>生成模型<input value={value.llm.model} onChange={(event) => setDraft({ ...value, llm: { ...value.llm, model: event.target.value } })} /></label>
          <label>审核模型<input value={value.llm.reviewModel ?? value.llm.model} onChange={(event) => setDraft({ ...value, llm: { ...value.llm, reviewModel: event.target.value } })} /></label>
          <label>推理强度<select value={value.llm.reasoningEffort ?? "high"} onChange={(event) => setDraft({ ...value, llm: { ...value.llm, reasoningEffort: event.target.value as AiConfigStatus["llm"]["reasoningEffort"] } })}><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
          {value.llm.provider === "custom" && <label className="field-span-2">API 地址<input placeholder="https://example.com/v1" value={value.llm.baseUrl ?? ""} onChange={(event) => setDraft({ ...value, llm: { ...value.llm, baseUrl: event.target.value } })} /></label>}
          <label className="field-span-2">API Key<input type="password" autoComplete="off" placeholder={value.llm.hasKey ? "本机已有密钥，留空不修改" : "输入 API Key"} value={llmApiKey} onChange={(event) => setLlmApiKey(event.target.value)} /></label>
        </fieldset>
        <fieldset className="ai-provider-card"><legend>语音服务</legend>
          <div className="ai-provider-card-status"><span>{ttsGuide.label}</span><strong>{value.tts.hasKey ? "已连通" : "待填写密钥"}</strong></div>
          <label>供应商<select value={value.tts.provider} onChange={(event) => updateTtsProvider(event.target.value as AiConfigStatus["tts"]["provider"])}>{TTS_OPTIONS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          <label>语音模型<input value={value.tts.model} onChange={(event) => setDraft({ ...value, tts: { ...value.tts, model: event.target.value } })} /></label>
          <label>声线<input value={value.tts.voice} onChange={(event) => setDraft({ ...value, tts: { ...value.tts, voice: event.target.value } })} /></label>
          {value.tts.provider === "azure" && <label>区域<input value={value.tts.region ?? "eastasia"} onChange={(event) => setDraft({ ...value, tts: { ...value.tts, region: event.target.value } })} /></label>}
          {value.tts.provider === "qwen" && <label>Workspace ID（可选）<input value={value.tts.workspaceId ?? ""} onChange={(event) => setDraft({ ...value, tts: { ...value.tts, workspaceId: event.target.value } })} /></label>}
          <label className="field-span-2">API Key<input type="password" autoComplete="off" placeholder={value.tts.hasKey ? "本机已有密钥，留空不修改" : "输入 API Key"} value={ttsApiKey} onChange={(event) => setTtsApiKey(event.target.value)} /></label>
        </fieldset>
      </div>
      <div className="ai-service-actions onboarding-ai-actions">
        <button className="primary-button" type="button" disabled={pending || verifying || Boolean(testTarget) || (!llmApiKey && !value.llm.hasKey) || (!ttsApiKey && !value.tts.hasKey)} onClick={() => void saveAndTest()}>{pending || verifying || testTarget ? <LoaderCircle size={14} className="spin" /> : <Zap size={14} />}{testTarget === "llm" ? "正在测试大模型" : testTarget === "tts" ? "正在测试语音" : verifying || pending ? "正在保存" : connected ? "保存并重新测试" : "保存并测试连接"}</button>
      </div>
    {showGuide && <ApiGuideDialog llm={llmGuide} tts={ttsGuide} onClose={() => setShowGuide(false)} />}
  </section>;
}

function ApiGuideDialog({ llm, tts, onClose }: { llm: { label: string; href: string; detail: string }; tts: { label: string; href: string; detail: string }; onClose: () => void }) {
  const dialogRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]"));
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); opener?.focus(); };
  }, [onClose]);
  return <div className="dialog-scrim api-guide-scrim" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <section ref={dialogRef} tabIndex={-1} className="api-guide-dialog" role="dialog" aria-modal="true" aria-labelledby="api-guide-title">
      <div className="dialog-header"><div><p className="eyebrow">LOCAL AI SETUP</p><h2 id="api-guide-title">获取 API Key</h2></div><IconButton label="关闭教程" onClick={onClose}><X size={17} /></IconButton></div>
      <p className="api-guide-intro">选择供应商、创建密钥、回到本页粘贴，然后点击“保存并测试连接”。密钥不会写入网页存储。</p>
      <ol className="api-guide-steps"><li><span>01</span><div><strong>{llm.label}</strong><p>{llm.detail}</p><a href={llm.href} target="_blank" rel="noreferrer">打开官方控制台 <ExternalLink size={13} /></a></div></li><li><span>02</span><div><strong>{tts.label}</strong><p>{tts.detail}</p><a href={tts.href} target="_blank" rel="noreferrer">打开官方说明 <ExternalLink size={13} /></a></div></li><li><span>03</span><div><strong>回到本机测试</strong><p>粘贴密钥并测试。连接成功后，本页会持续显示当前供应商和“已连通”状态。</p></div></li></ol>
      <div className="dialog-footer"><span><Check size={13} />配置保存在本机，之后仍可随时修改。</span><button className="primary-button" type="button" onClick={onClose}>我知道了</button></div>
    </section>
  </div>;
}

function InvitationAccessPanel({ access, pending, onClaim, onContinue }: {
  access: InvitationAccessStatus | null;
  pending: boolean;
  onClaim: (inviteCode: string, displayName: string) => Promise<boolean>;
  onContinue?: () => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const connected = access?.connected === true;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!displayName.trim() || !inviteCode.trim()) return;
    await onClaim(inviteCode, displayName);
  };
  return <section className={`onboarding-service-card invitation-access-card ${connected ? "is-connected" : ""}`}>
    <div className="onboarding-card-heading">
      <span><Wifi size={15} /><span><strong>验证内测身份</strong><small>PRIVATE BETA ACCESS</small></span></span>
      <span className={`service-connection-state ${connected ? "is-connected" : "is-pending"}`}><StatusDot tone={connected ? "ready" : "muted"} />{connected ? "已验证" : "未验证"}</span>
    </div>
    {connected ? <><div className="invitation-connected-summary">
      <div className="invitation-profile-mark" aria-hidden="true">{access.user?.displayName?.trim().slice(0, 1).toUpperCase() || "O"}</div>
      <div><span className="console-code">AUTHORIZED OPERATOR</span><h3>{access.user?.displayName}</h3><p>{access.device?.name} 已通过邀请码验证。</p></div>
      <Check size={22} />
    </div>{onContinue && <button className="primary-button invitation-continue-button" type="button" onClick={onContinue}>下一步，音乐授权 <ArrowRight size={15} /></button>}</> : <form className="invitation-form" onSubmit={submit}>
      <div className="invitation-copy"><h3>输入你的邀请码</h3><p>验证通过后，这台 Mac 会自动接通节目文案和六位主持人的声线。</p></div>
      <label>你的名字<input autoComplete="name" maxLength={40} placeholder="例如：小林" value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
      <label>团队邀请码<input autoComplete="off" maxLength={40} spellCheck={false} placeholder="OMR-XXXXXX" value={inviteCode} onChange={(event) => setInviteCode(event.target.value.toUpperCase())} /></label>
      <button className="primary-button" type="submit" disabled={pending || !displayName.trim() || !inviteCode.trim()}>{pending ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}{pending ? "正在验证" : "验证邀请码"}</button>
    </form>}
    <div className="managed-service-strip"><Check size={13} /><span>无需填写模型或语音 API Key</span><span>设备凭证仅保存在本机钥匙串</span></div>
  </section>;
}

function LocalSettingsView({
  section,
  onSectionChange,
  onClose,
  sources,
  sourceTransport,
  health,
  musicApiStatus,
  musicQrLogin,
  musicLoginPending,
  onStartMusicLogin,
  onRefreshMusicLogin,
  onCancelMusicLogin,
  aiConfig,
  aiConfigPending,
  onRefreshAiConfig,
  onSaveAiConfig,
  onTestAi,
  aiTestTarget,
  invitationAccess,
  invitationPending,
  onClaimInvitation,
  onRefreshAll,
  desktopPetEnabled,
  onDesktopPetEnabledChange,
  audioOutputId,
  onAudioOutputChange,
  onNotice,
  onError,
}: {
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  onClose: () => void;
  sources: SourceDiagnostic[];
  sourceTransport: TransportState;
  health: HealthState;
  musicApiStatus: Partial<Record<ApiMusicSource, MusicApiStatusResponse["status"]>>;
  musicQrLogin: ({ sourceId: ApiMusicSource } & MusicQrLogin) | null;
  musicLoginPending: boolean;
  onStartMusicLogin: (sourceId: ApiMusicSource) => void;
  onRefreshMusicLogin: (sourceId: ApiMusicSource) => void;
  onCancelMusicLogin: () => void;
  aiConfig: AiConfigStatus | null;
  aiConfigPending: boolean;
  onRefreshAiConfig: () => void;
  onSaveAiConfig: (settings: AiConfigStatus, secrets: { llmApiKey: string; ttsApiKey: string }) => Promise<AiConfigStatus | null>;
  onTestAi: (target: "llm" | "tts") => Promise<boolean>;
  aiTestTarget: "llm" | "tts" | null;
  invitationAccess: InvitationAccessStatus | null;
  invitationPending: boolean;
  onClaimInvitation: (inviteCode: string, displayName: string) => Promise<boolean>;
  onRefreshAll: () => void;
  desktopPetEnabled: boolean;
  onDesktopPetEnabledChange: (enabled: boolean) => void;
  audioOutputId: string;
  onAudioOutputChange: (id: string) => void;
  onNotice: (message: string | null) => void;
  onError: (message: string | null) => void;
}) {
  const [deviceStatus, setDeviceStatus] = useState<DeviceStatus | null>(null);
  const [devicePending, setDevicePending] = useState(false);
  const [maintenancePending, setMaintenancePending] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<string | null>(null);
  const [audioOutputs, setAudioOutputs] = useState<AudioOutputOption[]>([{ id: "default", label: "系统默认输出" }]);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const sections: Array<{ id: SettingsSection; label: string; detail: string }> = [
    { id: "accounts", label: "音乐账号", detail: "授权与连接" },
    { id: "ai", label: "AI 与语音", detail: "团队托管服务" },
    { id: "playback", label: "播放与人物", detail: "设备与桌面形象" },
    { id: "data", label: "本机数据", detail: "存储与备份" },
    { id: "local", label: "本机状态", detail: "服务与诊断" },
  ];
  const refreshDeviceStatus = useCallback(async () => {
    setDevicePending(true);
    try {
      const payload = await fetchJson<DeviceStatus>("/device/status");
      setDeviceStatus(payload);
    } catch (error) {
      onError(error instanceof Error ? error.message : "本机数据状态读取失败。");
    } finally {
      setDevicePending(false);
    }
  }, [onError]);
  const refreshAudioOutputs = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "audiooutput");
      const options = devices.map((device, index) => ({ id: device.deviceId, label: device.label || `音频输出 ${index + 1}` }));
      if (!options.some((item) => item.id === "default")) options.unshift({ id: "default", label: "系统默认输出" });
      setAudioOutputs(options);
      if (!options.some((item) => item.id === audioOutputId)) onAudioOutputChange("default");
    } catch {
      setAudioOutputs([{ id: "default", label: "系统默认输出" }]);
    }
  }, [audioOutputId, onAudioOutputChange]);
  useEffect(() => { void refreshDeviceStatus(); }, [refreshDeviceStatus]);
  useEffect(() => { if (section === "playback") void refreshAudioOutputs(); }, [refreshAudioOutputs, section]);
  const runMaintenance = async (key: string, action: () => Promise<void | string>, success: string) => {
    if (maintenancePending) return;
    setMaintenancePending(key);
    onError(null);
    try {
      const resultMessage = await action();
      setConfirmAction(null);
      onNotice(resultMessage || success);
    } catch (error) {
      onError(error instanceof Error ? error.message : "本机设置操作失败。");
    } finally {
      setMaintenancePending(null);
    }
  };
  const downloadJson = (filename: string, value: unknown) => {
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  };
  const exportSettings = () => {
    const llm = aiConfig ? { provider: aiConfig.llm.provider, model: aiConfig.llm.model, reviewModel: aiConfig.llm.reviewModel, reasoningEffort: aiConfig.llm.reasoningEffort, baseUrl: aiConfig.llm.baseUrl } : null;
    const tts = aiConfig ? { provider: aiConfig.tts.provider, model: aiConfig.tts.model, voice: aiConfig.tts.voice, baseUrl: aiConfig.tts.baseUrl, region: aiConfig.tts.region, workspaceId: aiConfig.tts.workspaceId } : null;
    const programDefaults = normalizeLocalProgramDefaults(JSON.parse(window.localStorage.getItem(LOCAL_PROGRAM_DEFAULTS_KEY) ?? "{}"));
    downloadJson(`openmusicradio-settings-${new Date().toISOString().slice(0, 10)}.json`, { version: 1, exportedAt: new Date().toISOString(), programDefaults, ai: llm && tts ? { llm, tts } : null, audioOutputId });
    onNotice("本机配置已导出。文件不包含 API Key 或音乐账号授权。");
  };
  const importSettings = async (file: File) => {
    if (file.size > 64 * 1024) throw new Error("配置文件不能超过 64 KB。");
    const backup = JSON.parse(await file.text()) as Record<string, unknown>;
    if (backup.version !== 1) throw new Error("配置文件版本不受支持。");
    const defaults = normalizeLocalProgramDefaults(backup.programDefaults);
    window.localStorage.setItem(LOCAL_PROGRAM_DEFAULTS_KEY, JSON.stringify(defaults));
    if (typeof backup.audioOutputId === "string" && backup.audioOutputId.length <= 256) window.localStorage.setItem(LOCAL_AUDIO_OUTPUT_KEY, backup.audioOutputId);
    if (backup.ai && typeof backup.ai === "object" && !Array.isArray(backup.ai)) {
      const ai = backup.ai as Record<string, unknown>;
      if (!ai.llm || !ai.tts || typeof ai.llm !== "object" || typeof ai.tts !== "object") throw new Error("AI 配置格式不完整。");
      await fetchJson("/ai/config", { method: "POST", body: JSON.stringify({ llm: ai.llm, tts: ai.tts }) });
    }
    onNotice("配置已导入，正在重新载入本机设置。");
    window.setTimeout(() => window.location.reload(), 350);
  };
  const confirmButtons = (key: string, label: string, onConfirm: () => void) => confirmAction === key
    ? <span className="inline-confirm-actions"><button className="text-button" type="button" onClick={() => setConfirmAction(null)}>取消</button><button className="danger-button" type="button" disabled={maintenancePending !== null} onClick={onConfirm}>{maintenancePending === key ? <LoaderCircle size={13} className="spin" /> : <Trash2 size={13} />}{label}</button></span>
    : <button className="text-button danger-text-button" type="button" onClick={() => setConfirmAction(key)}><Trash2 size={13} />{label}</button>;
  return <section className="local-settings-view" aria-labelledby="local-settings-title">
    <div className="settings-page-heading">
      <div><p className="eyebrow">SYSTEM / LOCAL CONFIG</p><h2 id="local-settings-title">管理这台设备上的服务。</h2><p>账号授权、API 密钥和运行状态都只属于这台 Mac，不需要登录 OpenMusicRadio 账户。</p></div>
      <button className="secondary-button" type="button" onClick={onClose}><X size={15} />关闭设置</button>
    </div>
    <div className="settings-workbench">
      <nav className="settings-nav" aria-label="设置分类" role="tablist">
        {sections.map((item) => <button key={item.id} type="button" role="tab" aria-selected={section === item.id} className={section === item.id ? "selected" : ""} onClick={() => onSectionChange(item.id)}><strong>{item.label}</strong><small>{item.detail}</small></button>)}
      </nav>
      <div className="settings-pane">
        {section === "accounts" && <section role="tabpanel" aria-labelledby="settings-accounts-title">
          <div className="settings-section-heading"><div><span>ACCOUNT ROUTING</span><h3 id="settings-accounts-title">音乐账号</h3><p>查看本机连接状态，或重新扫码更新授权。节目使用哪个音源，仍在创建节目时选择。</p></div><button className="text-button" type="button" onClick={onRefreshAll}><RefreshCw size={13} />刷新状态</button></div>
          <div className="settings-account-list">
            {USER_SOURCE_IDS.map((sourceId) => {
              const status = musicApiStatus[sourceId];
              const source = sources.find((item) => item.sourceId === sourceId);
              const login = musicQrLogin?.sourceId === sourceId ? musicQrLogin : null;
              const configured = status?.configured === true;
              const authenticated = status?.authenticated === true;
              const checking = sourceTransport === "loading" || !status;
              return <div className="settings-account-row" key={sourceId}>
                <div className={`source-icon source-icon-${sourceId}`} aria-hidden="true"><SourceGlyph sourceId={sourceId} /></div>
                <div className="settings-account-copy"><strong>{SOURCE_LABELS[sourceId]}</strong><span><StatusDot tone={authenticated ? "ready" : configured ? "muted" : "error"} />{checking ? "正在检查" : authenticated ? "账号已授权" : configured ? "等待扫码授权" : "本地连接器不可用"}</span><small>{authenticated ? (status?.persistentLogin ? "授权已保存在本机" : "授权仅当前会话有效") : source?.detail ?? "尚未读取连接状态"}</small></div>
                <div className="settings-account-actions"><button className="secondary-button settings-account-action" type="button" disabled={musicLoginPending || !configured} onClick={() => onStartMusicLogin(sourceId)}>{musicLoginPending && login ? <LoaderCircle size={14} className="spin" /> : <ExternalLink size={14} />}{authenticated ? "重新授权" : "扫码连接"}</button>{authenticated && confirmButtons(`logout-${sourceId}`, "撤销授权", () => void runMaintenance(`logout-${sourceId}`, async () => { await fetchJson(`/${sourceId === "qq_music" ? "qq" : "netease"}/logout`, { method: "POST", body: "{}" }); onRefreshAll(); }, `${SOURCE_LABELS[sourceId]}本机授权已撤销。`))}</div>
                {login && <div className="settings-account-qr" role="region" aria-label={`${SOURCE_LABELS[sourceId]}扫码登录`}><div><strong>{login.state === "waiting_confirm" ? "请在手机上确认登录" : `使用${SOURCE_LABELS[sourceId]} App 扫码`}</strong><IconButton label="取消扫码" onClick={onCancelMusicLogin}><X size={14} /></IconButton></div><img src={login.qrImageDataUrl} alt={`${SOURCE_LABELS[sourceId]}登录二维码`} /><button className="text-button" type="button" disabled={musicLoginPending} onClick={() => onRefreshMusicLogin(sourceId)}><RefreshCw size={13} />刷新二维码</button></div>}
              </div>;
            })}
          </div>
        </section>}
        {section === "ai" && <section className="settings-ai-section" role="tabpanel" aria-labelledby="settings-ai-title">
          <div className="settings-section-heading"><div><span>MANAGED RADIO SERVICE</span><h3 id="settings-ai-title">AI 与语音</h3><p>节目编排、口播审核和六位主持声线由团队统一提供。本机不保存供应商 API Key。</p></div></div>
          <InvitationAccessPanel access={invitationAccess} pending={invitationPending} onClaim={onClaimInvitation} />
        </section>}
        {section === "playback" && <section role="tabpanel" aria-labelledby="settings-playback-title">
          <div className="settings-section-heading"><div><span>PLAYBACK DEVICE</span><h3 id="settings-playback-title">播放与桌面人物</h3><p>选择网页音频输出，并设置以后创建节目时桌面人物的默认行为。</p></div><button className="text-button" type="button" onClick={() => void refreshAudioOutputs()}><RefreshCw size={13} />刷新设备</button></div>
          <div className="settings-control-list">
            <div className="settings-control-row"><div className="settings-control-copy"><Volume2 size={17} /><span><strong>音频输出</strong><small>同时用于音乐和主持人口播</small></span></div><select value={audioOutputId} disabled={!("setSinkId" in HTMLMediaElement.prototype)} onChange={(event) => onAudioOutputChange(event.target.value)}>{audioOutputs.map((output) => <option key={output.id} value={output.id}>{output.label}</option>)}</select></div>
            <div className="settings-control-row"><div className="settings-control-copy"><RadioHostAvatar profileId="longhao" /><span><strong>默认显示桌面人物</strong><small>仍可在每次创建节目时单独关闭</small></span></div><button type="button" className={`settings-toggle ${desktopPetEnabled ? "selected" : ""}`} aria-pressed={desktopPetEnabled} onClick={() => onDesktopPetEnabledChange(!desktopPetEnabled)}><span />{desktopPetEnabled ? "开启" : "关闭"}</button></div>
            <div className="settings-control-row"><div className="settings-control-copy"><SlidersHorizontal size={17} /><span><strong>桌面人物尺寸</strong><small>下次出现时应用；人物右键菜单也可以调整</small></span></div><div className="compact-segmented" role="radiogroup" aria-label="桌面人物尺寸">{(["small", "medium", "large"] as const).map((scale) => <button key={scale} type="button" role="radio" aria-checked={deviceStatus?.desktopPet.scale === scale} className={deviceStatus?.desktopPet.scale === scale ? "selected" : ""} disabled={devicePending || maintenancePending !== null || deviceStatus?.desktopPet.available === false} onClick={() => void runMaintenance(`pet-${scale}`, async () => { const result = await fetchJson<{ desktopPet: DeviceStatus["desktopPet"] }>("/device/pet", { method: "POST", body: JSON.stringify({ scale }) }); setDeviceStatus((current) => current ? { ...current, desktopPet: result.desktopPet } : current); }, "桌面人物尺寸已保存，下次出现时生效。")}>{scale === "small" ? "小" : scale === "medium" ? "中" : "大"}</button>)}</div></div>
            <div className="settings-control-row"><div className="settings-control-copy"><RotateCcw size={17} /><span><strong>桌面位置</strong><small>{deviceStatus?.desktopPet.positionSaved ? "正在使用上次拖动后的位置" : "使用屏幕右下角默认位置"}</small></span></div>{confirmButtons("pet-position", "恢复默认位置", () => void runMaintenance("pet-position", async () => { const result = await fetchJson<{ desktopPet: DeviceStatus["desktopPet"] }>("/device/pet", { method: "POST", body: JSON.stringify({ resetPosition: true }) }); setDeviceStatus((current) => current ? { ...current, desktopPet: result.desktopPet } : current); }, "桌面人物位置已恢复为默认值。"))}</div>
          </div>
        </section>}
        {section === "data" && <section role="tabpanel" aria-labelledby="settings-data-title">
          <div className="settings-section-heading"><div><span>LOCAL STORAGE</span><h3 id="settings-data-title">本机数据</h3><p>管理临时音频、推荐画像和配置备份。节目进行中会拒绝删除运行依赖。</p></div><button className="text-button" type="button" disabled={devicePending} onClick={() => void refreshDeviceStatus()}><RefreshCw size={13} />刷新容量</button></div>
          <div className="settings-data-list">
            <div><span className="settings-data-icon"><HardDrive size={17} /></span><span><strong>临时音频缓存</strong><small>{deviceStatus ? `${deviceStatus.storage.audio.entries} 项 · ${formatBytes(deviceStatus.storage.audio.bytes)}` : "正在读取"}</small></span>{confirmButtons("clear-cache", "清理缓存", () => void runMaintenance("clear-cache", async () => { await fetchJson("/device/cache/clear", { method: "POST", body: "{}" }); await refreshDeviceStatus(); }, "临时音频缓存已清理。"))}</div>
            <div><span className="settings-data-icon"><Activity size={17} /></span><span><strong>听歌画像</strong><small>{deviceStatus ? `${deviceStatus.storage.profiles.files} 个账号画像 · ${formatBytes(deviceStatus.storage.profiles.bytes)}` : "正在读取"}</small></span>{confirmButtons("reset-profile", "重置画像", () => void runMaintenance("reset-profile", async () => { await fetchJson("/device/profile/reset", { method: "POST", body: "{}" }); await refreshDeviceStatus(); }, "听歌画像与节目历史已重置。"))}</div>
            <div><span className="settings-data-icon"><Download size={17} /></span><span><strong>配置备份</strong><small>只包含节目默认值和非敏感模型参数</small></span><span className="settings-row-actions"><button className="secondary-button" type="button" onClick={exportSettings}><Download size={14} />导出</button><button className="secondary-button" type="button" onClick={() => importInputRef.current?.click()}><Upload size={14} />导入</button><input ref={importInputRef} className="visually-hidden" type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void runMaintenance("import", () => importSettings(file), "配置已导入。"); }} /></span></div>
            <div><span className="settings-data-icon"><Sparkles size={17} /></span><span><strong>团队服务凭证</strong><small>{invitationAccess?.connected ? `已绑定 ${invitationAccess.user?.displayName ?? "当前成员"}` : "尚未输入邀请码"}</small></span></div>
          </div>
        </section>}
        {section === "local" && <section role="tabpanel" aria-labelledby="settings-local-title">
          <div className="settings-section-heading"><div><span>DEVICE HEALTH</span><h3 id="settings-local-title">本机状态</h3><p>集中检查开播依赖。这里显示真实服务状态，不会用本地假数据替代失败结果。</p></div><span className="settings-row-actions"><button className="secondary-button" type="button" onClick={() => { onRefreshAll(); void refreshDeviceStatus(); }}><RefreshCw size={14} />重新检查</button><button className="secondary-button" type="button" onClick={() => void runMaintenance("diagnostics", async () => { const report = await fetchJson<Record<string, unknown>>("/device/diagnostics"); downloadJson(`openmusicradio-diagnostics-${new Date().toISOString().slice(0, 10)}.json`, report); }, "诊断报告已导出。")}>{maintenancePending === "diagnostics" ? <LoaderCircle size={14} className="spin" /> : <Download size={14} />}导出诊断</button></span></div>
          <div className="local-status-list">
            <div><span><StatusDot tone={health.ok ? "ready" : "error"} />本机控制服务</span><strong>{health.ok ? "运行中" : "连接失败"}</strong><small>{health.version ? `版本 ${health.version}` : "负责节目状态、账号授权和音频控制"}</small></div>
            <div><span><StatusDot tone={musicApiStatus.qq_music?.configured ? "ready" : "error"} />QQ 音乐连接器</span><strong>{musicApiStatus.qq_music?.configured ? "可用" : "不可用"}</strong><small>歌曲检索、账号画像与播放控制</small></div>
            <div><span><StatusDot tone={musicApiStatus.netease_music?.configured ? "ready" : "error"} />网易云音乐连接器</span><strong>{musicApiStatus.netease_music?.configured ? "可用" : "不可用"}</strong><small>歌曲检索、账号画像与播放控制</small></div>
            <div><span><StatusDot tone={invitationAccess?.connected ? "ready" : "muted"} />团队托管服务</span><strong>{invitationAccess?.connected ? "已接通" : "未连接"}</strong><small>{invitationAccess?.service ? `${invitationAccess.service.llmModel} / ${invitationAccess.service.ttsModel}` : "等待邀请码"}</small></div>
          </div>
          <div className="local-privacy-note"><Wifi size={16} /><span><strong>本机播放，云端生成</strong><small>音乐账号授权留在这台 Mac；团队服务只接收节目生成所需的信息，并按邀请成员区分用量。</small></span></div>
        </section>}
      </div>
    </div>
  </section>;
}

function ProcessView({
  mode,
  complete = false,
  completedSteps = 0,
  hostRetryMessage = null,
  hostRetryPending = false,
  onRetryHostScripts,
}: {
  mode: "generating" | "preparing";
  complete?: boolean;
  completedSteps?: number;
  hostRetryMessage?: string | null;
  hostRetryPending?: boolean;
  onRetryHostScripts?: () => void;
}) {
  const steps = mode === "generating"
    ? ["读取账号听歌画像", "筛选可播放候选", "排定熟悉与探索比例", "生成、审核并锁定主持词"]
    : ["合成全部主持语音", "整理本次播放队列", "核对歌曲与播放顺序", "校验第一首播放信号"];
  const taskLabel = mode === "generating" ? "PLAN ENGINE" : "ON AIR PREP";
  const confirmedSteps = complete ? steps.length : Math.max(0, Math.min(steps.length, completedSteps));
  const progress = Math.round(confirmedSteps / steps.length * 100);
  const activeStep = confirmedSteps < steps.length ? steps[confirmedSteps] : null;
  const currentStatus = hostRetryMessage ? (hostRetryPending ? "正在重新生成口播" : "口播服务需要重试") : complete ? "完整结果已返回" : activeStep ? `正在${activeStep}` : "正在启动任务";
  return <section className="process-view" role="status" aria-live="polite">
    <div className="process-signal">
      <div className={`process-orbit${complete ? " is-complete" : ""}`} style={{ "--process-progress": `${progress}%` } as CSSProperties} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-label={`处理进度 ${progress}%`}>
        <span className="process-cassette-reel" aria-hidden="true"><i /><i /><i /></span>
        <span className="process-tape-head" aria-hidden="true" />
        <span className="process-orbit-core"><strong>{progress}%</strong><small>{complete ? "COMPLETE" : `${confirmedSteps} / ${steps.length}`}</small></span>
      </div>
      <span className="process-signal-caption">OPEN MUSIC RADIO / LOCAL TASK</span>
    </div>
    <div className="process-copy">
      <div className="process-terminal"><span>OPEN MUSIC RADIO / {taskLabel}</span><strong>{progress}%</strong></div>
      <h2>{mode === "generating" ? "正在生成节目计划" : "正在完成开播准备"}</h2>
      <p>{mode === "generating" ? "这里只生成节目单和主持文案，不会改动你的音乐平台。" : "全部语音、播放队列和首曲信号就绪后，节目会自动开始播放。"}</p>
      <div className="process-current"><Activity size={16} aria-hidden="true" /><span><strong>{currentStatus}</strong><small>{hostRetryMessage ? "歌单和顺序已经保留，只会重新生成主持人口播。" : complete ? "本次任务已校验。" : "每个阶段完成后会立即更新，达到 100% 后进入节目计划。"}</small></span></div>
      {hostRetryMessage && <div className="process-retry-compact">
        <span>{hostRetryPending ? "正在处理，请稍等。" : "模型服务刚才没有返回稳定结果，可以只重试口播。"}</span>
        <button className="primary-button" type="button" onClick={onRetryHostScripts} disabled={!onRetryHostScripts || hostRetryPending}>
          {hostRetryPending ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}
          {hostRetryPending ? "正在重试" : "重试口播"}
        </button>
      </div>}
      <div className="process-meter process-meter-live" aria-hidden="true"><span style={{ width: `${progress}%` }} /></div>
      <div className="process-queue-heading"><span>PROCESS QUEUE</span><small>{steps.length} ITEMS</small></div>
      <ol>{steps.map((step, index) => {
        const done = index < confirmedSteps;
        const active = !complete && index === confirmedSteps;
        return <li key={step} className={done ? "done" : active ? "active" : "pending"}><span className="process-step-index">{done ? <Check size={13} /> : String(index + 1).padStart(2, "0")}</span><span>{step}</span><small>{done ? "已完成" : active ? "处理中" : "等待"}</small></li>;
      })}</ol>
    </div>
  </section>;
}

function SetupView({
  phase,
  onPhaseChange,
  sources,
  sourceTransport,
  diagnosticsUnavailable,
  selectedSource,
  onSourceChange,
  durationMinutes,
  onDurationChange,
  recommendationMode,
  onRecommendationModeChange,
  scenePreset,
  onSceneChange,
  hostDensity,
  onDensityChange,
  hostProfile,
  onHostProfileChange,
  musicGenres,
  onMusicGenresChange,
  desktopPetEnabled,
  onDesktopPetEnabledChange,
  familiarityRatio,
  onFamiliarityRatioChange,
  onSubmit,
  canCreate,
  createBlocker,
  creating,
  showDetails,
  onToggleDetails,
  onRefreshSources,
  onTogglePlayer,
  onNextTrack,
  desktopControlPending,
  analysisState,
  musicApiStatus,
  musicQrLogin,
  musicLoginPending,
  onStartMusicLogin,
  onRefreshMusicLogin,
  onCancelMusicLogin,
  aiConfig,
  aiConfigPending,
  onRefreshAiConfig,
  onSaveAiConfig,
  onTestAi,
  aiTestTarget,
  invitationAccess,
  invitationPending,
  onClaimInvitation,
  errorMessage,
  onDismissError,
  onPreviewHost,
  voicePreviewProfile,
}: {
  phase: "connect" | "settings";
  onPhaseChange: (phase: "connect" | "settings") => void;
  sources: SourceDiagnostic[];
  sourceTransport: TransportState;
  diagnosticsUnavailable: boolean;
  selectedSource: SourceId;
  onSourceChange: (source: SourceId) => void;
  durationMinutes: number;
  onDurationChange: (duration: number) => void;
  recommendationMode: RecommendationMode;
  onRecommendationModeChange: (mode: RecommendationMode) => void;
  scenePreset: ScenePreset;
  onSceneChange: (scene: ScenePreset) => void;
  hostDensity: ProgramSpec["hostDensity"];
  onDensityChange: (density: ProgramSpec["hostDensity"]) => void;
  hostProfile: HostProfileId;
  onHostProfileChange: (profile: HostProfileId) => void;
  musicGenres: MusicGenreId[];
  onMusicGenresChange: (genres: MusicGenreId[]) => void;
  desktopPetEnabled: boolean;
  onDesktopPetEnabledChange: (enabled: boolean) => void;
  familiarityRatio: number;
  onFamiliarityRatioChange: (value: number) => void;
  onSubmit: (event: FormEvent) => void;
  canCreate: boolean;
  createBlocker: string | null;
  creating: boolean;
  showDetails: boolean;
  onToggleDetails: () => void;
  onRefreshSources: () => void;
  onTogglePlayer: () => void;
  onNextTrack: () => void;
  desktopControlPending: "toggle" | "next" | null;
  analysisState: TransportState;
  musicApiStatus: Partial<Record<ApiMusicSource, MusicApiStatusResponse["status"]>>;
  musicQrLogin: ({ sourceId: ApiMusicSource } & MusicQrLogin) | null;
  musicLoginPending: boolean;
  onStartMusicLogin: (sourceId: ApiMusicSource) => void;
  onRefreshMusicLogin: (sourceId: ApiMusicSource) => void;
  onCancelMusicLogin: () => void;
  aiConfig: AiConfigStatus | null;
  aiConfigPending: boolean;
  onRefreshAiConfig: () => void;
  onSaveAiConfig: (settings: AiConfigStatus, secrets: { llmApiKey: string; ttsApiKey: string }) => Promise<AiConfigStatus | null>;
  onTestAi: (target: "llm" | "tts") => Promise<boolean>;
  aiTestTarget: "llm" | "tts" | null;
  invitationAccess: InvitationAccessStatus | null;
  invitationPending: boolean;
  onClaimInvitation: (inviteCode: string, displayName: string) => Promise<boolean>;
  errorMessage: string | null;
  onDismissError: () => void;
  onPreviewHost: (profileId: HostProfileId) => void;
  voicePreviewProfile: HostProfileId | null;
}) {
  const settingsHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const hostChoiceRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [connectStage, setConnectStage] = useState<"invite" | "music">("invite");
  const autoQrAttemptRef = useRef<string | null>(null);
  const startMusicLoginRef = useRef(onStartMusicLogin);
  startMusicLoginRef.current = onStartMusicLogin;
  const selected = sources.find((source) => source.sourceId === selectedSource)
    ?? FALLBACK_SOURCES.find((source) => source.sourceId === selectedSource)
    ?? FALLBACK_SOURCES.find((source) => source.sourceId === "qq_music")!;
  const scene = SCENE_META[scenePreset];
  const selectedApiSource = isApiMusicSource(selectedSource) ? selectedSource : null;
  const selectedApiStatus = selectedApiSource ? musicApiStatus[selectedApiSource] : undefined;
  const loginForSelected = musicQrLogin?.sourceId === selectedApiSource ? musicQrLogin : null;
  const selectedHost = HOST_PROFILES[hostProfile];
  const selectedGenreLabels = musicGenres.map((genreId) => MUSIC_GENRES[genreId].label);
  const recommendationSummary = recommendationMode === "genre"
    ? selectedGenreLabels.length > 0 ? `按风格: ${selectedGenreLabels.join(" / ")}` : "按风格: 请选择风格"
    : `按氛围: ${scene.label}`;
  const musicConnectReady = selectedApiStatus?.authenticated === true;
  const accessVerified = invitationAccess?.connected === true;
  useEffect(() => {
    if (phase !== "connect") return;
    if (!accessVerified && connectStage !== "invite") setConnectStage("invite");
  }, [accessVerified, connectStage, phase]);
  useEffect(() => {
    if (phase !== "connect" || connectStage !== "music" || !accessVerified || !selectedApiSource) return;
    if (!selectedApiStatus?.configured || selectedApiStatus.authenticated || loginForSelected || musicLoginPending) return;
    const attemptKey = `${selectedApiSource}:${invitationAccess?.device?.id ?? "device"}`;
    if (autoQrAttemptRef.current === attemptKey) return;
    autoQrAttemptRef.current = attemptKey;
    startMusicLoginRef.current(selectedApiSource);
  }, [accessVerified, connectStage, invitationAccess?.device?.id, loginForSelected, musicLoginPending, phase, selectedApiSource, selectedApiStatus?.authenticated, selectedApiStatus?.configured]);
  const toggleGenre = (genre: MusicGenreId) => {
    if (!musicGenres.includes(genre) && musicGenres.length >= MAX_MUSIC_GENRES) return;
    onMusicGenresChange(musicGenres.includes(genre)
      ? musicGenres.filter((value) => value !== genre)
      : [...musicGenres, genre]);
  };
  const handleHostChoiceKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (index + 1) % HOST_PROFILE_IDS.length;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (index - 1 + HOST_PROFILE_IDS.length) % HOST_PROFILE_IDS.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = HOST_PROFILE_IDS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    onHostProfileChange(HOST_PROFILE_IDS[nextIndex]!);
    hostChoiceRefs.current[nextIndex]?.focus();
  };
  useEffect(() => {
    if (phase !== "settings") return;
    const frame = requestAnimationFrame(() => {
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      settingsHeadingRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [phase]);
  return (
    <div className={`setup-layout setup-layout-${phase}`}>
      {phase === "connect" && <section className={`setup-column connect-platform-column connection-onboarding connection-onboarding-${connectStage}`}>
        <div className="section-intro section-intro-wide">
          <div><p className="eyebrow">01 / CONNECT</p><h2>{connectStage === "invite" ? "加入 Open Music Radio" : "连接你的音乐平台"}</h2><p>{connectStage === "invite" ? "使用团队邀请码完成一次验证。" : "选择常用平台，扫码授权后即可开始设置节目。"}</p></div>
          <div className="connection-mini-progress" aria-label={`连接进度，第 ${connectStage === "invite" ? 1 : 2} 步，共 2 步`}>
            <button type="button" className={connectStage === "invite" ? "active" : "done"} onClick={() => setConnectStage("invite")}><span>1</span>验证邀请</button>
            <i aria-hidden="true" />
            <button type="button" className={connectStage === "music" ? "active" : ""} disabled={!accessVerified} onClick={() => setConnectStage("music")}><span>2</span>音乐授权</button>
          </div>
        </div>
        {errorMessage && <div className="feedback-region connection-feedback"><ErrorBanner title={connectStage === "invite" ? "邀请码未通过" : "音乐平台连接失败"} message={errorMessage} onDismiss={onDismissError} /></div>}
        <div className="onboarding-grid onboarding-grid-single">
          {connectStage === "invite" && <InvitationAccessPanel access={invitationAccess} pending={invitationPending} onClaim={onClaimInvitation} onContinue={() => setConnectStage("music")} />}
          {connectStage === "music" && <section className="onboarding-service-card music-onboarding-card">
            <div className="onboarding-card-heading"><span><Music2 size={15} /><span><strong>选择音乐平台</strong><small>授权保存在当前 Mac</small></span></span><button className="text-button" type="button" onClick={onRefreshSources}><RefreshCw size={13} />刷新</button></div>
            <div className="source-list compact-source-list">{sources.map((source) => <SourceRow key={source.sourceId} source={source} selected={selectedSource === source.sourceId} diagnosticUnavailable={diagnosticsUnavailable && source.sourceId === "qq_music"} musicApiStatus={musicApiStatus} onSelect={() => onSourceChange(source.sourceId)} />)}</div>
            {selectedApiSource && <div className="music-login-workbench">
              <div className="music-login-status"><span><StatusDot tone={selectedApiStatus?.configured ? "ready" : "error"} />本地连接器</span><strong>{selectedApiStatus?.configured ? "可用" : "不可用"}</strong><span><StatusDot tone={selectedApiStatus?.authenticated ? "ready" : "muted"} />账号授权</span><strong>{selectedApiStatus?.authenticated ? "已连通" : "等待扫码"}</strong></div>
              {loginForSelected
                ? <div className="netease-qr compact-qr" role="region" aria-label={`${SOURCE_LABELS[selectedApiSource]}扫码登录`}><div className="netease-qr-heading"><span>{loginForSelected.state === "waiting_confirm" ? "请在手机上确认登录" : `使用${SOURCE_LABELS[selectedApiSource]} App 扫码`}</span><IconButton label="取消扫码" onClick={onCancelMusicLogin}><X size={14} /></IconButton></div><img src={loginForSelected.qrImageDataUrl} alt={`${SOURCE_LABELS[selectedApiSource]}登录二维码`} /><button className="text-button" type="button" onClick={() => onRefreshMusicLogin(selectedApiSource)} disabled={musicLoginPending}><RefreshCw size={13} />刷新二维码</button></div>
                : selectedApiStatus?.authenticated
                  ? <button className="text-button music-change-account" type="button" onClick={() => onStartMusicLogin(selectedApiSource)} disabled={musicLoginPending}><RefreshCw size={13} />更换音乐账号</button>
                  : <button className="primary-button" type="button" onClick={() => onStartMusicLogin(selectedApiSource)} disabled={musicLoginPending || !selectedApiStatus?.configured}>{musicLoginPending ? <LoaderCircle size={15} className="spin" /> : <ExternalLink size={15} />}{musicLoginPending ? "正在生成登录二维码" : "显示登录二维码"}</button>}
            </div>}
            {musicConnectReady && <div className="connection-card-complete"><span><Check size={14} />{SOURCE_LABELS[selectedApiSource ?? "qq_music"]}已连接</span><button className="primary-button" type="button" onClick={() => onPhaseChange("settings")}>进入节目设置 <ArrowRight size={15} /></button></div>}
            <p className="connection-local-note">音乐账号授权只保存在这台 Mac，可随时在设置中重新授权。</p>
          </section>}
        </div>
      </section>}

      {phase === "settings" && <section className="setup-column setup-form-column setup-settings-screen">
        <div className="section-intro section-intro-tight">
          <p className="eyebrow">02 / PROGRAM</p>
          <h2 ref={settingsHeadingRef} tabIndex={-1}>设定这档节目的声音与节奏。</h2>
        </div>
        <form className="program-form" onSubmit={onSubmit}>
          <section className="program-console program-host-console" aria-labelledby="host-console-title">
            <div className="console-panel-heading">
              <div><span className="console-code">VOICE DECK / A</span><h3 id="host-console-title">选择主持人</h3></div>
            </div>
            <div className="form-block host-form-block">
              <div className="field-label-row"><span className="field-label">主持声线</span></div>
              <div className="host-grid" role="radiogroup" aria-label="主持声线">{HOST_PROFILE_IDS.map((profileId, index) => {
                const profile = HOST_PROFILES[profileId];
                const previewing = voicePreviewProfile === profileId;
                return <div key={profileId} className={`host-option ${hostProfile === profileId ? "selected" : ""}`}>
                  <button ref={(element) => { hostChoiceRefs.current[index] = element; }} type="button" className="host-choice-button" role="radio" aria-checked={hostProfile === profileId} tabIndex={hostProfile === profileId ? 0 : -1} disabled={creating} onKeyDown={(event) => handleHostChoiceKeyDown(event, index)} onClick={() => onHostProfileChange(profileId)}>
                    <RadioHostAvatar profileId={profileId} portrait />
                    <span className="host-card-copy"><strong>{profile.name} <span className="host-gender" aria-hidden="true">{profile.genderSymbol}</span></strong><span className="host-card-meta"><small className="host-age">{profile.age} 岁</small><small className="host-mbti">{profile.mbti}</small></span><p>{HOST_PERSONALITY_COPY[profileId]}</p></span>
                    {hostProfile === profileId && <span className="host-selected-mark" aria-hidden="true"><Check size={12} /></span>}
                  </button>
                  <div className="host-preview-panel"><button type="button" className="host-preview-button" aria-label={previewing ? `停止试听${profile.name}` : `试听${profile.name}`} disabled={voicePreviewProfile !== null && !previewing} onClick={() => onPreviewHost(profileId)}>{previewing ? <Square size={12} /> : <Play size={13} />}<span>{previewing ? "停止" : "试听"}</span></button></div>
                </div>;
              })}</div>
            </div>
          </section>

          <section className="program-console program-control-console" aria-labelledby="control-console-title">
            <div className="console-panel-heading">
              <div><span className="console-code">PROGRAM DECK / B</span><h3 id="control-console-title">节目参数</h3></div>
            </div>
            <div className="program-control-grid">
              <div className="form-block control-duration">
                <div className="field-label-row"><span className="field-label">时长</span></div>
                <div className="segmented-control duration-control" role="radiogroup" aria-label="节目时长">{DURATION_OPTIONS.map((duration) => <button key={duration} className={durationMinutes === duration ? "selected" : ""} type="button" role="radio" aria-checked={durationMinutes === duration} onClick={() => onDurationChange(duration)}>{duration}<span>分钟</span></button>)}</div>
              </div>

              <div className="form-block control-host-settings">
                <div className="field-label-row"><span className="field-label">主持设置</span></div>
                <div className="host-lower-controls">
                  <div className="host-density-block">
                    <span className="host-setting-title">口播频率</span>
                    <div className="density-select" role="radiogroup" aria-label="主持频率">{HOST_DENSITY_OPTIONS.map((option) => <button key={option.value} type="button" role="radio" aria-checked={hostDensity === option.value} className={hostDensity === option.value ? "selected" : ""} onClick={() => onDensityChange(option.value)}>{option.label}</button>)}</div>
                  </div>
                  <div className="host-companion-row">
                    <span className="host-setting-title">桌面陪伴</span>
                    <button type="button" className={`desktop-companion-toggle ${desktopPetEnabled ? "selected" : ""}`} aria-pressed={desktopPetEnabled} onClick={() => onDesktopPetEnabledChange(!desktopPetEnabled)} disabled={creating}><span className="companion-toggle-indicator">{desktopPetEnabled ? <Check size={13} /> : null}</span><span><strong>{desktopPetEnabled ? "开启" : "关闭"}</strong><small>{desktopPetEnabled ? "确认后出现" : "本档不显示"}</small></span></button>
                  </div>
                </div>
              </div>

              <div className="form-block control-recommendation-mode">
                <div className="field-label-row"><span className="field-label">推荐方式</span></div>
                <div className="recommendation-mode-select" role="radiogroup" aria-label="推荐方式">{RECOMMENDATION_MODE_OPTIONS.map((option) => <button key={option.value} type="button" role="radio" aria-checked={recommendationMode === option.value} className={recommendationMode === option.value ? "selected" : ""} onClick={() => onRecommendationModeChange(option.value)}><strong>{option.label}</strong><span>{option.detail}</span></button>)}</div>
              </div>

              {recommendationMode === "atmosphere"
                ? <div className="form-block control-scene">
                  <div className="field-label-row"><span className="field-label">音乐氛围</span></div>
                  <div className="scene-grid" role="radiogroup" aria-label="音乐氛围">{SCENE_PRESETS.map((sceneId) => { const item = SCENE_META[sceneId]; return <button key={sceneId} type="button" className={`scene-option ${scenePreset === sceneId ? "selected" : ""}`} role="radio" aria-checked={scenePreset === sceneId} onClick={() => onSceneChange(sceneId)}><span className="scene-option-label">{item.label}</span><span className="scene-option-hint">{item.hint}</span></button>; })}</div>
                  <div className="scene-readout"><Zap size={14} /><span>能量曲线</span><strong>{scene.curve}</strong></div>
                </div>
                : <div className="form-block control-genres">
                  <div className="field-label-row"><span className="field-label">音乐风格 <span className="optional">最多选 {MAX_MUSIC_GENRES} 种</span></span><span className="field-help">{musicGenres.length === 0 ? "请选择风格" : `已选 ${musicGenres.length} / ${MAX_MUSIC_GENRES}`}</span></div>
                  <div className="genre-grid" role="group" aria-label="音乐风格">{MUSIC_GENRE_IDS.map((genreId) => { const genre = MUSIC_GENRES[genreId]; const selectedGenre = musicGenres.includes(genreId); const selectionLimitReached = musicGenres.length >= MAX_MUSIC_GENRES && !selectedGenre; return <button key={genreId} type="button" aria-pressed={selectedGenre} disabled={selectionLimitReached} className={`genre-option ${selectedGenre ? "selected" : ""}`} onClick={() => toggleGenre(genreId)}>{genre.label}</button>; })}</div>
                </div>}

              <div className="recommendation-controls recommendation-controls-single control-familiarity">
                <div className="form-block">
                  <div className="field-label-row"><span className="field-label">熟悉 / 探索</span></div>
                  <div className="familiarity-select" role="radiogroup" aria-label="熟悉和探索比例">
                    {FAMILIARITY_OPTIONS.map((option) => (
                      <button key={option.value} type="button" role="radio" aria-checked={familiarityRatio === option.value} className={familiarityRatio === option.value ? "selected" : ""} onClick={() => onFamiliarityRatioChange(option.value)}>
                        <strong>{option.label}</strong>
                        <span>{option.detail}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </section>

          <div className="form-submit-row"><button className="secondary-button" type="button" onClick={() => onPhaseChange("connect")} disabled={creating}>返回连接</button>{errorMessage ? <div className="form-feedback" role="alert"><TriangleAlert size={14} /><span>{errorMessage}</span><IconButton label="关闭错误提示" onClick={onDismissError}><X size={13} /></IconButton></div> : createBlocker ? <div className="brief-summary is-warning" role="status"><AlertTriangle size={14} /><span>{createBlocker}</span></div> : <div className="brief-summary"><span className="summary-dot" /><span>{durationMinutes} 分钟 · {recommendationSummary} · {selectedHost.name} · {SOURCE_SHORT_LABELS[selectedSource]}</span></div>}<button className={`primary-button${!canCreate ? " is-blocked" : ""}`} disabled={creating} data-ready={canCreate ? "true" : "false"} type="submit">{creating ? <LoaderCircle size={16} className="spin" /> : <ArrowRight size={16} />}{creating ? "准备中" : "查看计划"}</button></div>
        </form>
      </section>}
    </div>
  );
}

function SourceRow({ source, selected, diagnosticUnavailable, musicApiStatus, onSelect }: { source: SourceDiagnostic; selected: boolean; diagnosticUnavailable: boolean; musicApiStatus: Partial<Record<ApiMusicSource, MusicApiStatusResponse["status"]>>; onSelect: () => void }) {
  const apiSource = isApiMusicSource(source.sourceId);
  const authenticated = apiSource ? musicApiStatus[source.sourceId as ApiMusicSource]?.authenticated === true : false;
  const permissionBlocked = source.desktopState === "automation_denied";
  const screenLocked = source.desktopState === "screen_locked";
  const tone = apiSource ? authenticated ? "ready" : "blocked" : diagnosticUnavailable ? "error" : permissionBlocked ? "error" : screenLocked || source.accountConnected !== true ? "blocked" : statusTone(source.state) as "ready" | "blocked" | "error" | "muted";
  const connectionLabel = apiSource ? authenticated ? "账号已连通 · 网页播放可用" : `请扫码连接${source.label}账号` : diagnosticUnavailable ? "本机诊断不可用" : permissionBlocked ? "需要辅助功能权限" : screenLocked ? "请先解锁 Mac" : source.desktopState === "ready" ? "桌面客户端正在播放" : source.accountConnected && source.playbackReady ? "桌面自动选歌可用" : source.accountConnected ? "手动控制可用" : source.desktopState === "app_not_running" ? "请打开桌面客户端" : source.playbackReady ? "播放可用" : "等待客户端连接";
  const stateLabel = apiSource ? authenticated ? "网页可开播" : "未连接" : diagnosticUnavailable ? "诊断不可用" : permissionBlocked ? "权限受阻" : screenLocked ? "Mac 已锁屏" : source.desktopState === "app_not_running" ? "未连接" : source.desktopState === "ready" ? "播放中" : source.accountConnected && source.playbackReady ? "桌面可开播" : source.accountConnected ? "可控制" : humanState(source.state);
  return <button type="button" className={`source-row source-row-${source.sourceId} ${selected ? "selected" : ""}`} onClick={onSelect} aria-pressed={selected}><span className={`source-icon source-icon-${source.sourceId}`}><SourceGlyph sourceId={source.sourceId} /></span><span className="source-row-copy"><strong>{source.label}</strong><small>{connectionLabel}</small></span><span className={`source-state state-${tone}`}><StatusDot tone={tone} />{stateLabel}</span>{selected && <Check size={14} className="source-check" />}</button>;
}

function SourceGlyph({ sourceId }: { sourceId: SourceId }) {
  if (sourceId === "qq_music") {
    return <img src="/platforms/qq-music.png" alt="" aria-hidden="true" />;
  }
  if (sourceId === "netease_music") {
    return <img src="/platforms/netease-music.png" alt="" aria-hidden="true" />;
  }
  return <Music2 size={17} aria-hidden="true" />;
}

function ConfirmView({ program, checks, onExit, onConfirm, confirming, exiting, updating, onReplace, onAdjust, onRegenerate }: { program: LocalProgram; checks: { source: boolean; player: boolean; service: boolean; host: boolean; tts: boolean }; onExit: () => void; onConfirm: () => void; confirming: boolean; exiting: boolean; updating: boolean; onReplace: (trackId: string) => Promise<PlanUpdateResult>; onAdjust: (message: string) => Promise<PlanUpdateResult>; onRegenerate: () => Promise<PlanUpdateResult> }) {
  const apiMusic = isApiMusicSource(program.spec.sourceId);
  const rundown = program.rundown ?? [];
  const hostMoments = rundown.filter((track) => Boolean(track.hostMoment));
  const allScriptsLocked = hostMoments.length > 0 && hostMoments.every((track) => Boolean(track.hostScript?.text));
  const selectedHost = HOST_PROFILES[program.spec.hostProfile ?? DEFAULT_HOST_PROFILE];
  const density = HOST_DENSITY_OPTIONS.find((option) => option.value === program.spec.hostDensity);
  const familiarity = FAMILIARITY_OPTIONS.find((option) => option.value === program.spec.familiarityRatio);
  const genreLabels = (program.spec.musicGenres ?? []).map((genreId) => MUSIC_GENRES[genreId].label);
  const [chat, setChat] = useState("");
  const [replacingTrackId, setReplacingTrackId] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [messages, setMessages] = useState<PlannerChatMessage[]>([
    { id: "planner-welcome", role: "assistant", text: "我可以按你的要求调整节目单。想换一整组推荐，可以点击节目单右上角的刷新按钮；删除单曲时会在原位置补入新歌。" },
  ]);
  const chatLogRef = useRef<HTMLDivElement | null>(null);
  const canConfirm = checks.source && checks.player && checks.service && checks.host && checks.tts && (!apiMusic || (rundown.length > 0 && allScriptsLocked && Boolean(program.listenerProfile)));
  useEffect(() => {
    const log = chatLogRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages, updating]);
  const appendMessage = (role: PlannerChatMessage["role"], text: string) => {
    setMessages((current) => [...current, { id: makeId(`planner-${role}`), role, text }]);
  };
  const replaceTrack = async (track: ProgramRundownItem) => {
    if (updating) return;
    setReplacingTrackId(track.id);
    appendMessage("user", `删除《${track.title}》并原位补一首。`);
    const result = await onReplace(track.id);
    appendMessage("assistant", result.ok ? `《${track.title}》已删除。新歌已补入第 ${rundown.findIndex((item) => item.id === track.id) + 1} 位，相关口播也已重写。` : result.message);
    setReplacingTrackId(null);
  };
  const submitAdjustment = async () => {
    const message = chat.trim();
    if (!message || updating) return;
    appendMessage("user", message);
    setChat("");
    const result = await onAdjust(message);
    appendMessage("assistant", result.message);
  };
  const regeneratePlan = async () => {
    if (updating) return;
    setRegenerating(true);
    appendMessage("user", "换一组歌曲推荐。");
    const result = await onRegenerate();
    appendMessage("assistant", result.ok ? "已经重新推荐并生成节目单，你可以继续调整顺序或删除单曲。" : result.message);
    setRegenerating(false);
  };
  return (
    <div className="confirm-view">
      <div className="confirm-topbar"><p className="eyebrow">确认计划</p><button className="secondary-button" type="button" onClick={onExit} disabled={exiting || confirming || updating}>{exiting ? <LoaderCircle size={15} className="spin" /> : <RotateCcw size={15} />}{exiting ? "退出中" : "退出节目"}</button></div>
      <section className="program-spec-summary" aria-labelledby="program-spec-summary-title">
        <div className="program-spec-summary-heading"><p className="eyebrow" id="program-spec-summary-title">本次电台参数</p><span>{rundown.length} 首歌曲 · {hostMoments.length} 段口播</span></div>
        <dl className="program-spec-list">
          <div><dt>音源与时长</dt><dd>{SOURCE_SHORT_LABELS[program.spec.sourceId]} · {program.spec.durationMinutes} 分钟</dd></div>
          <div><dt>推荐方式</dt><dd>{programRecommendationLabel(program.spec)}</dd></div>
          <div><dt>主持人</dt><dd>{selectedHost.name} · {selectedHost.trait}{program.spec.desktopPetEnabled ? " · 桌面搭子开启" : ""}</dd></div>
          <div><dt>口播频率</dt><dd>{density?.label ?? program.spec.hostDensity}频 · {density?.detail ?? "自然衔接"}</dd></div>
          <div><dt>推荐倾向</dt><dd>{familiarity?.label ?? "平衡推荐"} · 熟悉歌曲目标 {program.spec.familiarityRatio ?? 40}%</dd></div>
          <div><dt>音乐锚点</dt><dd>{genreLabels.length > 0 ? genreLabels.join(" / ") : "跟随账号听歌画像"}</dd></div>
        </dl>
      </section>
      {apiMusic && (
        <div className="plan-editor-grid">
          <section className="program-outline" aria-label="节目单">
            <div className="outline-heading">
              <div><p className="eyebrow outline-channel-label"><ListMusic size={13} />节目单 <span>CH-A</span></p><h3>{rundown.length} 首歌曲 · 可替换歌曲</h3><p className="outline-playlist-name"><span>本次歌单</span>{program.playlist?.name ?? program.plannedPlaylistName ?? "等待生成名称"}</p></div>
              <div className="outline-heading-actions">
                <span className="outline-console-status"><i />EDIT READY</span>
                <span className="outline-lock-note"><Check size={13} />删除后原位补歌</span>
                <IconButton label="重新生成歌曲推荐" disabled={updating} onClick={() => void regeneratePlan()}>
                  {regenerating ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}
                </IconButton>
              </div>
            </div>
            <ol>{rundown.map((track, index) => (
              <li key={track.id} className="outline-item">
                <span className="outline-index-cell"><span className="outline-index">{String(index + 1).padStart(2, "0")}</span><span className={`outline-familiarity ${track.liked ? "is-familiar" : "is-discovery"}`}>{track.liked ? "熟悉" : "探索"}</span></span>
                <TrackArtwork track={track} compact />
                <div className="outline-track">
                  <div className="outline-track-heading">
                    <div><strong>{track.title}</strong><span className="outline-track-artist"><UserRound size={12} aria-hidden="true" />{track.artist}</span></div>
                    <div className="outline-track-actions"><time>{Math.floor(track.durationSeconds / 60)}:{String(track.durationSeconds % 60).padStart(2, "0")}</time><IconButton label={`删除《${track.title}》并原位替换`} disabled={updating} onClick={() => void replaceTrack(track)}>
                      {replacingTrackId === track.id ? <LoaderCircle size={14} className="spin" /> : <Trash2 size={14} />}
                    </IconButton></div>
                  </div>
                  {track.hostScript && <div className="outline-host-script"><span className="outline-host-mark"><Mic2 size={14} /></span><div><span>主持口播</span><p>{track.hostScript.text}</p></div></div>}
                </div>
              </li>
            ))}</ol>
          </section>
          <aside className="ai-adjust-panel ai-chat-panel">
            <div className="ai-chat-identity"><span className="ai-host-avatar"><RadioHostAvatar profileId={selectedHost.id} portrait /></span><div className="ai-host-copy"><h3>{selectedHost.name}</h3><span><i />在线 · {selectedHost.trait}</span></div></div>
            <div className="ai-chat-log" ref={chatLogRef} aria-live="polite">
              {messages.map((message) => <div key={message.id} className={`ai-chat-message is-${message.role}`}>{message.role === "assistant" && <RadioHostAvatar profileId={selectedHost.id} portrait />}<div><span>{message.role === "assistant" ? selectedHost.name : "你"}</span><p>{message.text}</p></div></div>)}
              {updating && <div className="ai-chat-message is-assistant is-working"><RadioHostAvatar profileId={selectedHost.id} portrait /><div><span>{selectedHost.name}</span><p><LoaderCircle size={13} className="spin" />正在调整歌曲推荐与顺序...</p></div></div>}
            </div>
            <div className="ai-chat-compose">
              <div className="ai-chat-input-shell">
                <textarea rows={1} value={chat} onChange={(event) => setChat(event.target.value)} maxLength={600} placeholder={`告诉${selectedHost.name}你想怎样调整节目单`} disabled={updating} />
                <div className="ai-chat-input-actions"><small>{chat.length}/600</small><IconButton label={`发送给${selectedHost.name}`} className="ai-chat-send" disabled={updating || !chat.trim()} onClick={() => void submitAdjustment()}>{updating ? <LoaderCircle size={15} className="spin" /> : <Send size={16} />}</IconButton></div>
              </div>
              <small>可以调整歌曲顺序和推荐倾向。重新推荐整组歌曲请使用节目单右上角的刷新按钮。</small>
            </div>
          </aside>
        </div>
      )}
      <div className="confirm-actions"><p className={`confirm-commit-summary ${canConfirm ? "" : "is-blocked"}`}><Info size={14} />{canConfirm ? apiMusic ? "确认后会先询问是否保存本次歌单，然后准备主持语音并开播。" : "确认后才会控制音乐客户端并开始播放。" : "开播检查尚未通过，请检查音源、账号、本地服务与语音配置。"}</p><button className="primary-button primary-button-wide" type="button" onClick={onConfirm} disabled={confirming || exiting || updating || !canConfirm}>{confirming ? <LoaderCircle size={16} className="spin" /> : <Play size={16} />}{confirming ? "启动中" : updating ? "计划更新中" : "确认并启动"}</button></div>
    </div>
  );
}

function PlaylistSaveDialog({ sourceId, trackCount, confirming, onKeep, onTemporary, onClose }: { sourceId: ApiMusicSource; trackCount: number; confirming: boolean; onKeep: () => void; onTemporary: () => void; onClose: () => void }) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const sourceLabel = SOURCE_LABELS[sourceId];
  useEffect(() => {
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>("button:not([disabled])"));
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  return (
    <div className="dialog-scrim" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section ref={dialogRef} tabIndex={-1} className="playlist-save-dialog" role="dialog" aria-modal="true" aria-labelledby="playlist-save-title" aria-describedby="playlist-save-desc">
        <div className="dialog-header">
          <div><p className="eyebrow">开播前确认</p><h2 id="playlist-save-title">保存本次歌单到{sourceLabel}吗？</h2></div>
          <IconButton label="返回确认计划" onClick={onClose}><X size={17} /></IconButton>
        </div>
        <div className="playlist-save-body" id="playlist-save-desc">
          <p>本次电台会先准备一份 {trackCount} 首歌的临时歌单，保证播放顺序稳定。</p>
          <p>选择保存，会把这份歌单留在你的{sourceLabel}账号里；选择不保存，节目播完或退出后会自动删除。</p>
        </div>
        <div className="playlist-save-options">
          <button className="primary-button" type="button" onClick={onKeep} disabled={confirming}><ListMusic size={15} />保存到{sourceLabel}</button>
          <button className="secondary-button" type="button" onClick={onTemporary} disabled={confirming}><X size={15} />不保存，播完删除</button>
        </div>
      </section>
    </div>
  );
}

function LikeSongConfirmDialog({ sourceId, trackTitle, liked, confirming, onConfirm, onClose }: { sourceId: ApiMusicSource; trackTitle: string; liked: boolean; confirming: boolean; onConfirm: () => void; onClose: () => void }) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const sourceLabel = SOURCE_LABELS[sourceId];
  const actionTitle = liked ? "喜欢这首歌？" : "取消喜欢这首歌？";
  const actionCopy = liked
    ? `确认后，${sourceLabel}账号会把《${trackTitle}》收录到“我喜欢”的歌曲里。`
    : `确认后，${sourceLabel}账号会从“我喜欢”的歌曲里取消《${trackTitle}》。`;
  useEffect(() => {
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !confirming) onClose();
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>("button:not([disabled])"));
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirming, onClose]);
  return (
    <div className="dialog-scrim" role="presentation" onMouseDown={(event) => { if (!confirming && event.currentTarget === event.target) onClose(); }}>
      <section ref={dialogRef} tabIndex={-1} className="playlist-save-dialog like-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="like-confirm-title" aria-describedby="like-confirm-desc">
        <div className="dialog-header">
          <div><p className="eyebrow">{sourceLabel} / 我喜欢</p><h2 id="like-confirm-title">{actionTitle}</h2></div>
          <IconButton label="关闭确认弹窗" onClick={onClose} disabled={confirming}><X size={17} /></IconButton>
        </div>
        <div className="playlist-save-body like-confirm-body" id="like-confirm-desc">
          <p>{actionCopy}</p>
        </div>
        <div className="playlist-save-options">
          <button className={liked ? "primary-button" : "stop-button"} type="button" onClick={onConfirm} disabled={confirming}>{confirming ? <LoaderCircle size={15} className="spin" /> : <Heart size={15} fill={liked ? "currentColor" : "none"} />}{confirming ? "处理中" : liked ? "确认喜欢" : "确认取消"}</button>
          <button className="secondary-button" type="button" onClick={onClose} disabled={confirming}><X size={15} />再想想</button>
        </div>
      </section>
    </div>
  );
}

function TrackArtwork({ track, fixture = false, compact = false, circular = false, spinning = false }: { track: Track | null; fixture?: boolean; compact?: boolean; circular?: boolean; spinning?: boolean }) {
  const coverUrl = track?.coverUrl ?? (fixture ? "/radio-fixture-cover.png" : undefined);
  const [failedCoverUrl, setFailedCoverUrl] = useState<string | null>(null);
  const visibleCoverUrl = coverUrl && coverUrl !== failedCoverUrl ? coverUrl : undefined;
  return (
    <div className={`${compact ? "queue-art" : "track-art"}${visibleCoverUrl ? " has-cover" : ""}${circular ? " track-art-circular" : ""}${spinning ? " is-spinning" : ""}`} style={{ "--track-color": track?.color ?? "#738078" } as CSSProperties}>
      <Disc3 size={compact ? 17 : 62} strokeWidth={1.2} />
      {visibleCoverUrl && <img key={visibleCoverUrl} className="track-cover" src={visibleCoverUrl} alt={track ? `${track.title} 封面` : "节目封面"} referrerPolicy="no-referrer" onError={() => setFailedCoverUrl(visibleCoverUrl)} />}
      {!compact && <><div className="art-scrim" /><span className="art-index">{track ? track.id.slice(-2) : "--"}</span></>}
    </div>
  );
}

let visualizerContext: AudioContext | null = null;
const visualizerSources = new WeakMap<HTMLMediaElement, AudioNode>();
type MeydaAnalyzerInstance = ReturnType<typeof Meyda.createMeydaAnalyzer>;
interface VisualizerFeatures {
  amplitudeSpectrum: Float32Array;
  frames: number;
  loudness: number;
  rms: number;
}
const visualizerAnalyzers = new WeakMap<HTMLMediaElement, MeydaAnalyzerInstance>();
const visualizerFeatures = new WeakMap<HTMLMediaElement, VisualizerFeatures>();

function AudioSignalCanvas({ audioRef, active, label }: { audioRef: RefObject<HTMLAudioElement | null>; active: boolean; label: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  useEffect(() => {
    const canvas = canvasRef.current;
    const audio = audioRef.current;
    if (!canvas || reducedMotion) return;
    let frame = 0;
    let cancelled = false;
    let source: AudioNode | null = null;
    let meydaAnalyzer: MeydaAnalyzerInstance | null = null;
    let features: VisualizerFeatures | null = null;
    let drawCount = 0;
    if (audio && active) try {
      visualizerContext ??= new AudioContext();
      source = visualizerSources.get(audio) ?? null;
      if (!source) {
        source = visualizerContext.createMediaElementSource(audio);
        source.connect(visualizerContext.destination);
        visualizerSources.set(audio, source);
      }
      features = visualizerFeatures.get(audio) ?? { amplitudeSpectrum: new Float32Array(512), frames: 0, loudness: 0, rms: 0 };
      visualizerFeatures.set(audio, features);
      meydaAnalyzer = visualizerAnalyzers.get(audio) ?? null;
      if (!meydaAnalyzer) {
        const featureTarget = features;
        meydaAnalyzer = Meyda.createMeydaAnalyzer({
          audioContext: visualizerContext,
          source,
          bufferSize: 1024,
          hopSize: 512,
          featureExtractors: ["rms", "loudness", "amplitudeSpectrum"],
          startImmediately: false,
          callback: (nextFeatures: Partial<MeydaFeaturesObject>) => {
            featureTarget.frames += 1;
            featureTarget.rms = typeof nextFeatures.rms === "number" ? nextFeatures.rms : 0;
            featureTarget.loudness = typeof nextFeatures.loudness?.total === "number" ? nextFeatures.loudness.total : 0;
            if (nextFeatures.amplitudeSpectrum) featureTarget.amplitudeSpectrum = nextFeatures.amplitudeSpectrum;
          },
        });
        visualizerAnalyzers.set(audio, meydaAnalyzer);
      }
      meydaAnalyzer.start();
      canvas.dataset.analyserMode = "meyda-media-element";
      void visualizerContext.resume().catch(() => undefined);
    } catch {
      meydaAnalyzer = null;
      features = null;
      canvas.dataset.analyserMode = "fallback";
    }
    const context = canvas.getContext("2d");
    let lastDraw = 0;
    let displayedBeat = 0;
    let rmsFloor = .012;
    let rmsCeiling = .12;
    let previousRms = 0;
    const draw = (time: number) => {
      if (cancelled || !context) return;
      frame = window.requestAnimationFrame(draw);
      if (document.hidden || time - lastDraw < 66) return;
      lastDraw = time;
      const ratio = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      const values = features?.amplitudeSpectrum ?? new Float32Array(64);
      const rawRms = active ? features?.rms ?? 0 : 0;
      if (active && rawRms > 0) {
        rmsFloor += (rawRms - rmsFloor) * (rawRms < rmsFloor ? .14 : .003);
        rmsCeiling += (rawRms - rmsCeiling) * (rawRms > rmsCeiling ? .22 : .008);
        rmsCeiling = Math.max(rmsFloor + .018, rmsCeiling);
      }
      const rmsRange = Math.max(.018, rmsCeiling - rmsFloor);
      const normalizedRms = active ? Math.max(0, Math.min(1, (rawRms - rmsFloor) / rmsRange)) : 0;
      const onset = active ? Math.max(0, Math.min(1, (rawRms - previousRms) / rmsRange)) : 0;
      previousRms = rawRms;
      const rmsLevel = active ? Math.min(1, Math.pow(normalizedRms, .62) * .82 + onset * .38) : 0;
      const loudnessLevel = active ? Math.min(1, (features?.loudness ?? 0) / 28) : 0;
      const signalLevel = Math.min(1, Math.pow(Math.max(rmsLevel, loudnessLevel * .72), .78));
      const targetBeat = active ? Math.min(1, .06 + rmsLevel * .94) : 0;
      displayedBeat += (targetBeat - displayedBeat) * (targetBeat > displayedBeat ? .78 : .2);
      const beatLevel = active ? displayedBeat : 0;
      let spectrumPeak = 0;
      for (const value of values) spectrumPeak = Math.max(spectrumPeak, value);
      canvas.dataset.signalLevel = signalLevel.toFixed(3);
      canvas.dataset.beatLevel = beatLevel.toFixed(3);
      canvas.dataset.featureFrames = String(features?.frames ?? 0);
      canvas.dataset.rms = rawRms.toFixed(5);
      canvas.dataset.analyserEngine = "meyda";
      canvas.dataset.frame = String(++drawCount);
      canvas.closest<HTMLElement>(".broadcast-stage")?.style.setProperty("--audio-beat", beatLevel.toFixed(3));
      const minDimension = Math.min(width, height);
      const canvasRect = canvas.getBoundingClientRect();
      const coverRect = canvas.closest(".broadcast-stage")?.querySelector<HTMLElement>(".track-art-circular")?.getBoundingClientRect();
      const centerX = coverRect ? coverRect.left - canvasRect.left + coverRect.width / 2 : width / 2;
      const centerY = coverRect ? coverRect.top - canvasRect.top + coverRect.height / 2 : height / 2;
      const coverRadius = coverRect ? Math.min(coverRect.width, coverRect.height) / 2 : minDimension * .17;
      const safeRadius = Math.max(coverRadius + 28, Math.min(centerX, width - centerX, centerY, height - centerY) - 12);
      const baseRadius = Math.min(safeRadius - 18, coverRadius + 12 + beatLevel * minDimension * .04);
      const availableBarLength = Math.max(18, safeRadius - baseRadius);
      const ringStep = Math.min(minDimension * .045, availableBarLength / 3);
      const rayOuterRadius = Math.min(safeRadius, baseRadius + availableBarLength * .82);
      canvas.dataset.ringCenterX = centerX.toFixed(2);
      canvas.dataset.ringCenterY = centerY.toFixed(2);
      canvas.dataset.coverRadius = coverRadius.toFixed(2);
      canvas.dataset.innerRadius = baseRadius.toFixed(2);
      canvas.dataset.outerRadius = safeRadius.toFixed(2);
      let renderedOuterRadius = baseRadius;
      const idlePulse = active ? 1 : .72 + Math.sin(time * .0011) * .12;
      const visualEnergy = Math.max(active ? .12 : .2, signalLevel);
      context.strokeStyle = `rgba(51,255,0,${.09 + visualEnergy * .08})`;
      context.lineWidth = 1;
      for (let ring = 1; ring <= 3; ring += 1) {
        context.beginPath();
        context.arc(centerX, centerY, baseRadius + ring * ringStep, 0, Math.PI * 2);
        context.stroke();
      }
      for (let ray = 0; ray < 16; ray += 1) {
        const angle = ray / 16 * Math.PI * 2;
        context.beginPath();
        context.moveTo(centerX + Math.cos(angle) * (baseRadius + 8), centerY + Math.sin(angle) * (baseRadius + 8));
        context.lineTo(centerX + Math.cos(angle) * rayOuterRadius, centerY + Math.sin(angle) * rayOuterRadius);
        context.stroke();
      }
      const count = 72;
      for (let index = 0; index < count; index += 1) {
        const sample = values[Math.floor(index / count * values.length)] ?? 0;
        const normalizedSpectrum = spectrumPeak > 0 ? Math.min(1, sample / spectrumPeak) : 0;
        const strength = features ? Math.min(1.12, Math.max(.04, Math.pow(normalizedSpectrum, .52) * (.42 + signalLevel * .86))) : .2 * idlePulse;
        const angle = index / count * Math.PI * 2 - Math.PI / 2;
        const inner = baseRadius;
        const outer = Math.min(safeRadius, inner + 5 + strength * availableBarLength * .92);
        renderedOuterRadius = Math.max(renderedOuterRadius, outer);
        const x1 = centerX + Math.cos(angle) * inner;
        const y1 = centerY + Math.sin(angle) * inner;
        const x2 = centerX + Math.cos(angle) * outer;
        const y2 = centerY + Math.sin(angle) * outer;
        context.strokeStyle = `rgba(51,255,0,${.24 + strength * .7})`;
        context.lineWidth = index % 3 === 0 ? 2.4 : 1.2;
        context.beginPath(); context.moveTo(x1, y1); context.lineTo(x2, y2); context.stroke();
      }
      canvas.dataset.spectrumSpan = (renderedOuterRadius - baseRadius).toFixed(2);
    };
    frame = window.requestAnimationFrame(draw);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      canvas.closest<HTMLElement>(".broadcast-stage")?.style.setProperty("--audio-beat", "0");
      meydaAnalyzer?.stop();
      if (features) {
        features.frames = 0;
        features.rms = 0;
        features.loudness = 0;
      }
    };
  }, [active, audioRef, reducedMotion]);
  return <div className="signal-canvas" aria-hidden="true"><canvas ref={canvasRef} /><span>{label}</span></div>;
}

const HOST_TEXT_FALLBACK_MS_PER_CHARACTER = 24;
const HOST_TEXT_MIN_REVEAL_DURATION_MS = 520;
const HOST_TEXT_AUDIO_LEAD_RATIO = 0.76;

function hostTextRevealDurationMs(characterCount: number, plannedDurationSeconds?: number): number {
  const quickFallback = Math.max(HOST_TEXT_MIN_REVEAL_DURATION_MS, characterCount * HOST_TEXT_FALLBACK_MS_PER_CHARACTER);
  if (typeof plannedDurationSeconds !== "number" || !Number.isFinite(plannedDurationSeconds) || plannedDurationSeconds <= 0) return quickFallback;
  const durationFromAudio = plannedDurationSeconds * 1000 * HOST_TEXT_AUDIO_LEAD_RATIO;
  return Math.max(HOST_TEXT_MIN_REVEAL_DURATION_MS, Math.min(durationFromAudio, quickFallback));
}

function StreamingHostText({ text, active, plannedDurationSeconds }: { text: string; active: boolean; plannedDurationSeconds?: number }) {
  const characters = useMemo(() => Array.from(text), [text]);
  const [revealed, setRevealed] = useState(() => active ? 0 : characters.length);
  const wasActiveRef = useRef(false);
  const reducedMotion = usePrefersReducedMotion();
  useEffect(() => {
    if (!active || characters.length === 0) {
      wasActiveRef.current = false;
      setRevealed(characters.length);
      return;
    }
    if (!wasActiveRef.current) setRevealed(0);
    wasActiveRef.current = true;
    if (reducedMotion) {
      setRevealed(characters.length);
      return;
    }
    const startedAt = performance.now();
    const revealDurationMs = hostTextRevealDurationMs(characters.length, plannedDurationSeconds);
    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / revealDurationMs);
      setRevealed(Math.min(characters.length, Math.ceil(characters.length * progress)));
      if (progress < 1) frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [active, characters, plannedDurationSeconds, reducedMotion]);
  const visible = characters.slice(0, revealed).join("");
  return <p className={`host-line host-line-streaming${active ? " is-typing" : ""}`}><span aria-hidden="true">{visible}</span><span className="sr-only" aria-live="polite">{active ? `主持人口播：${text}` : `已锁定主持词：${text}`}</span></p>;
}

function OnAirView({ program, remainingSeconds, onNext, onStop, nexting, stopping, onPlaylist, onBackToSetup, audioPlaying, trackElapsedSeconds, trackDurationSeconds, onToggleAudio, audioNeedsGesture, audioError, onEnableAudio, hostPreviewPending, likePending, onToggleCurrentLike, audioRef }: { program: LocalProgram; remainingSeconds: number; onNext: () => void; onStop: () => void; nexting: boolean; stopping: boolean; onPlaylist: () => void; onBackToSetup: () => void; audioPlaying: boolean; trackElapsedSeconds: number; trackDurationSeconds: number; onToggleAudio: () => void; audioNeedsGesture: boolean; audioError: string | null; onEnableAudio: () => void; hostPreviewPending: boolean; likePending: boolean; onToggleCurrentLike: () => void; audioRef: RefObject<HTMLAudioElement | null> }) {
  const current = program.currentTrack;
  const next = program.nextTrack;
  const terminal = ["completed", "stopped", "failed", "control_lost", "stop_unconfirmed"].includes(program.status);
  const syntheticFixture = program.spec.sourceId === "fixture";
  const desktopSource = !isApiMusicSource(program.spec.sourceId) && program.spec.sourceId !== "fixture";
  const playlistDeleted = program.playlist?.status === "deleted";
  const effectiveTrackDuration = trackDurationSeconds > 0 ? trackDurationSeconds : current?.durationSeconds ?? 0;
  const currentRundownItem = program.rundown?.find((item) => item.id === current?.id) ?? current as ProgramRundownItem | null;
  const creditParts = currentRundownItem?.credits ? [
    currentRundownItem.credits.lyricists.length > 0 ? `词 ${currentRundownItem.credits.lyricists.join(" / ")}` : "",
    currentRundownItem.credits.composers.length > 0 ? `曲 ${currentRundownItem.credits.composers.join(" / ")}` : "",
    currentRundownItem.credits.arrangers.length > 0 ? `编曲 ${currentRundownItem.credits.arrangers.join(" / ")}` : "",
  ].filter(Boolean) : [];
  const releaseParts = [
    currentRundownItem?.album && current && !releaseTitlesMatch(current.title, currentRundownItem.album) ? `《${currentRundownItem.album}》` : "",
    currentRundownItem?.releaseYear ? `${currentRundownItem.releaseYear} 年` : "",
  ].filter(Boolean);
  const trackProgress = effectiveTrackDuration > 0 ? Math.max(0, Math.min(100, trackElapsedSeconds / effectiveTrackDuration * 100)) : 0;
  const currentHostScript = currentRundownItem?.hostScript;
  const lockedHostText = currentHostScript?.text ?? program.host?.text ?? "";
  const currentLiked = currentRundownItem?.liked === true;
  const likeSupported = Boolean(!terminal && !program.localOnly && current?.audioUrl && currentRundownItem && (currentRundownItem.sourceId === "netease_music" || currentRundownItem.sourceId === "qq_music"));
  const hostStateLabel = hostPreviewPending
    ? "生成中"
    : program.host?.status === "playing"
      ? "正在口播"
      : program.host?.audioUrl
      ? "语音就绪"
      : program.host?.text
        ? "仅文案"
        : "无片段";
  return (
    <div className="on-air-view">
      <div className="on-air-topline"><div><p className="eyebrow">{terminal ? "会话已结束" : "直播节目"}</p><h2>{programRecommendationLabel(program.spec)}<span className="title-slash">/</span><span className="muted-title">{program.spec.durationMinutes} 分钟</span></h2></div><div className={`air-status ${terminal ? "air-status-ended" : ""}`}><StatusDot tone={program.status === "control_lost" || program.status === "stop_unconfirmed" ? "error" : terminal ? "muted" : "ready"} />{programPhaseLabel(program.status)}</div></div>
      <div className="air-main-grid">
        <section className="now-playing-panel">
          <div className="panel-kicker"><span><Activity size={14} />正在播放</span><span className="signal-label"><StatusDot tone={terminal ? "muted" : syntheticFixture ? "blocked" : "ready"} />{syntheticFixture ? "合成测试信号" : "音源信号"}</span></div>
          <div className="broadcast-stage"><AudioSignalCanvas audioRef={audioRef} active={audioPlaying && !terminal} label={program.host?.status === "playing" ? "MUSIC BED / DUCKED" : "LIVE AUDIO SPECTRUM"} /><TrackArtwork track={current} fixture={syntheticFixture} circular spinning={audioPlaying && !terminal} /></div>
          <div className="track-copy"><p className="track-overline">{desktopSource ? "桌面客户端队列" : isApiMusicSource(program.spec.sourceId) ? `${SOURCE_LABELS[program.spec.sourceId]}专属节目单` : current ? `曲目 ${current.id.split("-").pop()}` : "暂无曲目"}</p><h3>{current?.title ?? "暂无当前曲目"}</h3><p>{current?.artist ?? "等待音源确认"}</p></div>
          <div className="track-meta">{desktopSource ? <><span>曲目信息以客户端为准</span><span>实时播放</span></> : <><span>{current ? formatTrackDuration(current.durationSeconds) : "--:--"}</span>{creditParts.length > 0 && <span>{creditParts.join(" · ")}</span>}{releaseParts.length > 0 && <span>{releaseParts.join(" · ")}</span>}</>}</div>
          {audioError && <p className="audio-error"><AlertTriangle size={13} />{audioError}</p>}
          {!terminal && <div className="playback-actions">
            {likeSupported && <button className={`audio-toggle like-song-button${currentLiked ? " is-liked" : ""}`} type="button" aria-pressed={currentLiked} aria-label={currentLiked ? `取消喜欢《${current?.title ?? "当前歌曲"}》` : `喜欢《${current?.title ?? "当前歌曲"}》`} onClick={onToggleCurrentLike} disabled={likePending || nexting || stopping}>{likePending ? <LoaderCircle size={16} className="spin" /> : <Heart size={16} fill={currentLiked ? "currentColor" : "none"} />}{likePending ? "保存中" : currentLiked ? "已喜欢" : "喜欢歌曲"}</button>}
            {!program.localOnly && current?.audioUrl && (audioNeedsGesture
              ? <button className="audio-toggle audio-enable" type="button" onClick={onEnableAudio}><Play size={15} />开启声音</button>
              : <button className="audio-toggle" type="button" onClick={onToggleAudio}>{audioPlaying ? <Pause size={15} /> : <Play size={15} />}{isApiMusicSource(program.spec.sourceId) ? audioPlaying ? "暂停音乐" : "继续音乐" : audioPlaying ? "暂停测试音" : "播放测试音"}</button>)}
            <button className="audio-toggle next-button" type="button" onClick={onNext} disabled={program.status !== "on_air" || nexting || stopping}><SkipForward size={16} />{nexting ? "切换中" : program.status === "preparing" ? "准备中" : "下一首"}</button>
          </div>}
        </section>

        <section className="air-detail-column">
          <div className="countdown-panel">
            <div className="panel-kicker"><span><Clock3 size={14} />剩余时间</span><span className="countdown-note">{terminal ? "已停止" : remainingSeconds <= 0 ? "当前歌曲播完后结束" : `约 ${program.deadlineAt ? new Date(program.deadlineAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "--"} 到时`}</span></div>
            <div className="countdown-value" role="timer" aria-live="off">{remainingSeconds <= 0 && !terminal ? "本曲结束" : formatClock(remainingSeconds)}</div>
            <div className="track-progress-heading"><span>{current?.title ?? "当前曲目"}</span><span>{formatTrackDuration(Math.floor(trackElapsedSeconds))} / {effectiveTrackDuration > 0 ? formatTrackDuration(Math.floor(effectiveTrackDuration)) : "--:--"}</span></div>
            <div className="track-progress" role="progressbar" aria-label="当前歌曲播放进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(trackProgress)}><span style={{ width: `${trackProgress}%` }} /></div>
          </div>
          <div className="host-panel"><div className="panel-kicker"><span><Mic2 size={14} />主持人口播</span><span className={`host-state ${program.host?.audioUrl ? "host-ready" : "host-failed"}`}><span className="host-pulse" />{hostStateLabel}</span></div><div className="host-panel-content"><RadioHostAvatar profileId={program.spec.hostProfile ?? DEFAULT_HOST_PROFILE} /><div className="host-copy"><strong>{HOST_PROFILES[program.spec.hostProfile ?? DEFAULT_HOST_PROFILE].name}</strong><div className="host-script-scroll" tabIndex={0} aria-label="主持人口播内容">{lockedHostText ? <StreamingHostText key={`${program.id}:${program.generation}:${current?.id ?? "none"}:${lockedHostText}`} text={lockedHostText} active={program.host?.status === "playing"} plannedDurationSeconds={currentHostScript?.plannedDurationSeconds ?? program.host?.plannedDurationSeconds} /> : <p className="host-line">{hostPreviewPending ? "主持人即将开口。" : "这一首不安排口播。"}</p>}</div></div></div></div>
          <div className="queue-panel"><div className="panel-kicker"><span><Music2 size={14} />下一首</span><span>{desktopSource ? "客户端维护" : `${program.queue.length + (next ? 1 : 0)} 首待播`}</span></div>{next ? <div className="queue-track"><TrackArtwork track={next} fixture={syntheticFixture} compact /><span><strong>{next.title}</strong><small>{next.artist}</small></span><span className="queue-duration">{desktopSource ? "--:--" : formatTrackDuration(next.durationSeconds)}</span></div> : <div className="queue-empty"><Square size={14} />本档节目即将结束</div>}</div>
        </section>
      </div>
      <div className="air-controls"><div className="control-note"><span className="control-lock"><Wifi size={13} /></span><span>{terminal ? "本次节目已结束" : "电台信号连接中"}<small>{terminal ? "可以查看本次歌单或创建下一档节目" : playlistDeleted ? "临时歌单已在音乐平台清理" : "播放与截止时间由本地服务保持"}</small></span></div><div className="control-actions"><button className="secondary-button" type="button" onClick={onPlaylist}><ListMusic size={15} />查看歌单</button>{terminal ? <button className="secondary-button" type="button" onClick={onBackToSetup}><RotateCcw size={15} />新建节目</button> : <button className="stop-button" type="button" onClick={onStop} disabled={stopping || nexting}><RotateCcw size={16} />{stopping ? "退出中" : "退出节目"}</button>}</div></div>
    </div>
  );
}

function PlaylistDialog({ program, onClose }: { program: LocalProgram; onClose: () => void }) {
  const dialogRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"));
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      opener?.focus();
    };
  }, [onClose]);
  const tracks = program.rundown ?? [];
  const playlistStatus = (() => {
    const playlist = program.playlist;
    if (!playlist) return { icon: <Info size={14} />, className: "playlist-account-status playlist-account-status-local", title: "这是本次电台的锁定歌单。", detail: `${SOURCE_LABELS[program.spec.sourceId]} · 本机节目记录` };
    if (playlist.retention === "kept") return { icon: <Check size={14} />, className: "playlist-account-status", title: "已保存到你的账户歌单。", detail: `${SOURCE_LABELS[program.spec.sourceId]} · ${playlist.trackCount} 首` };
    if (playlist.status === "deleted") return { icon: <Check size={14} />, className: "playlist-account-status playlist-account-status-local", title: "本次电台歌单已结束。", detail: `${SOURCE_LABELS[program.spec.sourceId]} · 歌曲仍可在这里查看` };
    if (playlist.status === "delete_failed") return { icon: <Info size={14} />, className: "playlist-account-status playlist-account-status-local", title: "本次歌单仍可在客户端查看。", detail: "后台清理没有完成，可以在音乐客户端手动删除" };
    return { icon: <ListMusic size={14} />, className: "playlist-account-status playlist-account-status-local", title: "这是本次电台歌单。", detail: `${SOURCE_LABELS[program.spec.sourceId]} · ${playlist.trackCount} 首` };
  })();
  return (
    <div className="dialog-scrim" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section ref={dialogRef} tabIndex={-1} className="playlist-dialog" role="dialog" aria-modal="true" aria-labelledby="playlist-title">
        <div className="dialog-header">
          <div><p className="eyebrow">本次电台歌单</p><h2 id="playlist-title">{program.playlist?.name ?? `${programRecommendationLabel(program.spec)} / ${program.spec.durationMinutes} 分钟`}</h2></div>
          <IconButton label="关闭歌单" onClick={onClose}><X size={17} /></IconButton>
        </div>
        <div className={playlistStatus.className} role="status">{playlistStatus.icon}<span><strong>{playlistStatus.title}</strong><small>{playlistStatus.detail}</small></span></div>
        <div className="playlist-tracks">
          <div className="panel-kicker"><span><ListMusic size={14} />播放顺序</span><span>{tracks.length} 首</span></div>
          {tracks.length === 0
            ? <p className="playlist-empty">本次节目没有可展示的曲目。</p>
            : <ol>{tracks.map((track, index) => <li key={`${track.id}-${index}`} className={track.id === program.currentTrack?.id ? "is-current" : ""}><span className="playlist-index">{String(index + 1).padStart(2, "0")}</span><TrackArtwork track={track} fixture={program.spec.sourceId === "fixture"} compact /><span className="playlist-track-copy"><strong>{track.title}</strong><small>{track.artist}{track.album && !releaseTitlesMatch(track.title, track.album) ? ` · ${track.album}` : ""}{track.releaseYear ? ` · ${track.releaseYear}` : ""}</small></span><time>{formatTrackDuration(track.durationSeconds)}</time></li>)}</ol>}
        </div>
        <div className="dialog-footer"><span><ListMusic size={13} />歌曲按本次电台的锁定顺序展示。</span><button className="secondary-button" type="button" onClick={onClose}>关闭</button></div>
      </section>
    </div>
  );
}

export default App;
