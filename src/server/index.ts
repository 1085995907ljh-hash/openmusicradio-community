import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile as nodeExecFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { promisify } from "node:util";
import {
  SCENE_PRESETS,
  SOURCE_IDS,
  type HostContextPack,
  type ProgramSpec,
  type ProgramState,
  type ProgramRundownItem,
  type ProgramHostScript,
  type ProgramListenerProfile,
  type ProgramPlaylistReceipt,
  type ScenePreset,
  type SourceDiagnostic,
} from "../shared/contracts.js";
import {
  DEFAULT_HOST_PROFILE,
  HOST_PROFILES,
  HOST_PROFILE_IDS,
  hostOpeningIdentity,
  hostTtsInstruction,
  MAX_MUSIC_GENRES,
  MUSIC_GENRE_IDS,
  MUSIC_GENRES,
  type HostProfileId,
  type MusicGenreId,
} from "../shared/program-options.js";
import { FIXTURE_TRACKS } from "../core/fixtures.js";
import { personalizeCandidates, type PersonalizationCandidate } from "../core/personalization.js";
import { isDisallowedRecommendationCandidate, isExplorationVersionCandidate } from "../core/recommendation-guards.js";
import { buildListeningProfile, inferSongTags } from "../core/listening-profile.js";
import { isCompleteAccountPlayback } from "../core/playback-access.js";
import { parseMusicSearchAdjustment } from "../core/rundown-adjustment.js";
import { energyRangeForPhase, getSceneConfig, phaseForElapsedSeconds } from "../core/scenes.js";
import {
  hostCharacterBounds,
  hostScriptRepeats,
  HOST_MUSIC_DUCK_DB,
  HOST_MUSIC_START_DELAY_SECONDS,
  radioGreetingAt,
  evenlySpacedHostBreakIndices,
  normalizeSpokenEnglishCase,
  normalizeSpokenYearDigits,
  middleHostBreakCountIsAcceptable,
  planHostBreak,
  planHostDurationTargets,
  releaseTitlesMatch,
  spokenArtistName,
  type HostBreakMode,
} from "../core/host-script-planning.js";
import {
  assertDesktopPlayerSource,
  DESKTOP_PLAYER_SOURCES,
  DesktopPlayerController,
  type DesktopPlayerSource,
  type DesktopPlayerControllerLike,
} from "./desktop-player.js";
import {
  DesktopProgramController,
  DESKTOP_SCENE_QUERY_TERMS,
  type DesktopProgramControllerLike,
  type DesktopProgramResult,
} from "./desktop-program.js";
import { LocalHostProvider } from "../providers/local-host.js";
import { createGuaranteedHostFallback } from "../providers/openai-compatible.js";
import { QwenTtsProvider } from "../providers/qwen-tts.js";
import { ProviderError } from "../providers/types.js";
import { LocalAiConfigStore, LLM_PROVIDER_IDS, TTS_PROVIDER_IDS, type LocalAiSettings } from "./local-ai-config.js";
import { LocalConfiguredHostProvider, LocalConfiguredTtsProvider } from "./local-ai-providers.js";
import { CloudAccessStore, ManagedAiConfigStore } from "./cloud-access.js";
import { loadRadioHostReviewSkill, loadRadioHostSkill } from "./radio-host-skill.js";
import {
  DESKTOP_PET_MOODS,
  DesktopPetController,
  desktopPetStateForProgram,
  type DesktopPetControllerLike,
  type DesktopPetMood,
} from "./desktop-pet.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4317;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_LOCKED_HOST_AUDIO_BYTES = 64 * 1024 * 1024;
const LOCKED_TTS_CONCURRENCY = 3;
const AUDIO_TTL_MS = 5 * 60 * 1000;
const LOCKED_TTS_TIMEOUT_MS = 25_000;
const MAX_OPERATION_ID_LENGTH = 128;
const MAX_NETEASE_PLAYBACK_CANDIDATES = 240;
const MAX_NETEASE_RUNDOWN_TRACKS = 240;
const HOST_SCRIPT_MAX_ATTEMPTS = 2;
const FIXTURE_TRACK_IDS = new Set(FIXTURE_TRACKS.map((track) => track.id));
const DEFAULT_LISTENING_PROFILE_DIR = join(homedir(), "Library", "Application Support", "OneRadio", "profiles");
const DESKTOP_PET_PREFERENCES_SUITE = process.env.ONE_RADIO_PET_PREFERENCES_SUITE?.trim() || "dev.openmusicradio.desktop-pet";
const MAX_PUBLIC_PLAYLIST_QUERIES = 18;
const PUBLIC_PLAYLIST_SEARCH_LIMIT = 8;
const MAX_PUBLIC_PLAYLIST_DETAILS = 24;
const PUBLIC_PLAYLIST_TRACK_SAMPLE_LIMIT = 24;
const ATMOSPHERE_EXPLORATION_RATIO_MAX = 10;
const LEGACY_DISCOVERY_YEARS = 10;
const PROGRAM_DURATION_TOLERANCE_RATIO = 0.08;
const MAX_PROGRAM_DURATION_SHORTFALL_SECONDS = 5 * 60;
const SCENE_STYLE_TAGS: Record<ScenePreset, MusicGenreId[]> = {
  late_night: ["new_age", "rnb_soul", "jazz", "easy_listening", "folk"],
  study: ["easy_listening", "new_age", "jazz", "classical", "bossa_nova"],
  workout: ["electronic", "dance", "hiphop", "rock", "pop"],
  commute: ["pop", "rnb_soul", "britpop", "folk", "electronic"],
  party: ["dance", "electronic", "hiphop", "rnb_soul", "rock"],
};

function minimumProgramDurationSeconds(durationMinutes: number): number {
  const requestedSeconds = durationMinutes * 60;
  const toleranceSeconds = Math.min(MAX_PROGRAM_DURATION_SHORTFALL_SECONDS, requestedSeconds * PROGRAM_DURATION_TOLERANCE_RATIO);
  return Math.max(1, Math.floor(requestedSeconds - toleranceSeconds));
}
const MAINSTREAM_DISCOVERY_STYLES = new Set<MusicGenreId>(["pop", "rock", "electronic", "hiphop", "rnb_soul"]);
const DEFAULT_LOW_SHARE_STYLES = new Set<MusicGenreId>(["new_age", "world", "ethnic", "latin", "easy_listening", "dance", "bossa_nova"]);
const STYLE_PLAYLIST_QUERY_TERMS: Readonly<Record<MusicGenreId, readonly string[]>> = {
  pop: ["流行热歌 歌单", "华语流行 歌单", "欧美流行 歌单", "当代流行好歌", "Pop Hits"],
  rock: ["摇滚精选 歌单", "独立摇滚 歌单", "Alternative Rock 歌单", "吉他摇滚现场感", "Indie Rock Essentials"],
  folk: ["民谣精选 歌单", "城市民谣 歌单", "Folk Acoustic 歌单", "木吉他唱作人", "民谣旅行歌单"],
  electronic: ["电子音乐精选 歌单", "House Techno 歌单", "Electronic Music 歌单", "合成器电子乐", "Techno House Essentials"],
  dance: ["舞曲律动 歌单", "Dance Pop 歌单", "Disco Groove 歌单", "舞池律动精选", "Disco Funk Dance"],
  hiphop: ["说唱精选 歌单", "华语嘻哈 歌单", "Hip-Hop Rap 歌单", "说唱新声歌单", "Boom Bap Trap"],
  easy_listening: ["轻音乐精选 歌单", "舒缓纯音乐 歌单", "Easy Listening 歌单", "安静器乐陪伴", "舒缓钢琴吉他"],
  jazz: ["爵士精选 歌单", "现代爵士 歌单", "Jazz Essentials 歌单", "爵士咖啡馆", "Bebop Swing Collection"],
  country: ["乡村音乐精选 歌单", "Country Music 歌单", "Modern Country 歌单", "纳什维尔唱作人", "Americana Country"],
  rnb_soul: ["R&B Soul 精选 歌单", "节奏布鲁斯 歌单", "Neo Soul 歌单", "灵魂乐律动", "Contemporary R&B"],
  classical: ["古典音乐精选 歌单", "Classical Essentials 歌单", "室内乐 歌单", "交响乐必听", "钢琴协奏曲精选"],
  ethnic: ["民族音乐精选 歌单", "中国民族音乐 歌单", "传统民乐 歌单", "民族器乐采风", "中国传统器乐"],
  britpop: ["英伦摇滚 歌单", "Britpop 歌单", "UK Indie 歌单", "曼彻斯特独立摇滚", "Manchester Alternative Bands"],
  metal: ["金属乐精选 歌单", "Heavy Metal 歌单", "Alternative Metal 歌单", "重型吉他金属", "Metal Essentials"],
  punk: ["朋克摇滚精选 歌单", "Punk Rock 歌单", "Pop Punk 歌单", "车库朋克乐队", "Post Punk Essentials"],
  blues: ["蓝调精选 歌单", "Blues Essentials 歌单", "Modern Blues 歌单", "芝加哥蓝调", "Delta Blues Collection"],
  reggae: ["雷鬼精选 歌单", "Reggae Essentials 歌单", "Roots Reggae 歌单", "牙买加阳光律动", "Dub Ska Reggae"],
  world: ["世界音乐精选 歌单", "World Music 歌单", "全球音乐 歌单", "环球声音采集", "Global Folk Collection"],
  latin: ["拉丁音乐精选 歌单", "Latin Pop 歌单", "Salsa 音乐 歌单", "Bachata Salsa 律动", "Reggaeton Latin Hits"],
  new_age: ["New Age 精选 歌单", "新世纪音乐 歌单", "氛围冥想音乐 歌单", "自然疗愈器乐", "Ambient Meditation"],
  gufeng: ["古风精选 歌单", "国风音乐 歌单", "中国风歌曲 歌单", "国风唱作精选", "古琴笛箫国风"],
  post_rock: ["后摇精选 歌单", "Post-Rock 歌单", "氛围后摇 歌单", "器乐摇滚渐进铺陈", "Instrumental Post Rock"],
  bossa_nova: ["Bossa Nova 精选 歌单", "巴萨诺瓦 歌单", "Brazilian Bossa 歌单", "里约午后爵士", "Samba Bossa Nova"],
};
const STYLE_PLAYLIST_EVIDENCE: Readonly<Record<MusicGenreId, RegExp>> = {
  pop: /流行|pop|热歌|hits|city pop|k-?pop|j-?pop/i,
  rock: /摇滚|rock|alternative|吉他乐队/i,
  folk: /民谣|folk|acoustic|木吉他|唱作人/i,
  electronic: /电子|电音|electronic|techno|house|synth|合成器/i,
  dance: /舞曲|dance|disco|舞池|groove/i,
  hiphop: /说唱|嘻哈|hip.?hop|rap|trap|boom bap/i,
  easy_listening: /轻音乐|舒缓|easy listening|器乐|钢琴|吉他/i,
  jazz: /爵士|jazz|bebop|swing/i,
  country: /乡村|country|nashville|americana|纳什维尔/i,
  rnb_soul: /r&b|rnb|soul|节奏布鲁斯|灵魂乐|neo soul/i,
  classical: /古典|classical|交响|协奏曲|室内乐/i,
  ethnic: /民族|民乐|传统器乐|ethnic/i,
  britpop: /英伦|britpop|uk indie|british alternative|曼彻斯特/i,
  metal: /金属|metal|重型吉他/i,
  punk: /朋克|punk|车库摇滚/i,
  blues: /蓝调|布鲁斯|blues/i,
  reggae: /雷鬼|reggae|roots reggae|dub|ska|牙买加/i,
  world: /世界音乐|world music|global folk|环球声音/i,
  latin: /拉丁|latin|salsa|bachata|reggaeton/i,
  new_age: /new age|新世纪|冥想|疗愈|ambient/i,
  gufeng: /古风|国风|中国风|古琴|笛箫/i,
  post_rock: /后摇|post.?rock|器乐摇滚|instrumental rock/i,
  bossa_nova: /bossa nova|巴萨诺瓦|samba bossa|里约/i,
};
const MUSIC_GENRE_QUERY_ALIASES: Readonly<Record<MusicGenreId, readonly string[]>> = {
  pop: ["流行", "pop"],
  rock: ["摇滚", "rock"],
  folk: ["民谣", "folk"],
  electronic: ["电子", "electronic"],
  dance: ["舞曲", "dance"],
  hiphop: ["说唱", "嘻哈", "hiphop", "hip-hop", "rap"],
  easy_listening: ["轻音乐", "easy listening"],
  jazz: ["爵士", "jazz"],
  country: ["乡村", "country"],
  rnb_soul: ["r&b/soul", "r&b", "soul", "rnb soul"],
  classical: ["古典", "classical"],
  ethnic: ["民族", "ethnic"],
  britpop: ["英伦", "英伦摇滚", "britpop", "uk indie"],
  metal: ["金属", "metal"],
  punk: ["朋克", "punk"],
  blues: ["蓝调", "布鲁斯", "blues"],
  reggae: ["雷鬼", "reggae"],
  world: ["世界音乐", "world music"],
  latin: ["拉丁", "latin"],
  new_age: ["new age", "新世纪"],
  gufeng: ["古风", "国风", "gufeng"],
  post_rock: ["后摇", "post-rock", "post rock"],
  bossa_nova: ["bossa nova", "巴萨诺瓦"],
};
const SCENE_PLAYLIST_QUERY_TERMS: Record<ScenePreset, readonly string[]> = {
  late_night: ["深夜 放松 氛围 歌单", "夜晚 松弛 音乐 歌单", "睡前 安静 陪伴 歌单", "Late Night Chill 歌单"],
  study: ["学习 专注 氛围 歌单", "工作 阅读 专注 歌单", "咖啡馆 学习 音乐 歌单", "Focus Study 歌单"],
  workout: ["运动 健身 高能 歌单", "跑步 训练 节奏 歌单", "健身房 热力 音乐 歌单", "Workout Energy 歌单"],
  commute: ["通勤 开车 律动 歌单", "上班路上 轻快 歌单", "城市通勤 音乐 歌单", "Drive Commute 歌单"],
  party: ["派对 聚会 热场 歌单", "朋友聚会 氛围 歌单", "周末派对 律动 歌单", "Party Hits 歌单", "House Party 歌单"],
};
// Six deterministic Han characters keep the user-facing name readable while
// retaining substantially more entropy than the old sixteen-name fallback.
const QQ_PLAYLIST_NAME_ALPHABET = "月光夜星河风声海岸城市微远方来信清醒书页思绪回响安静向前晨读余音热力节拍律动能量汗水燃点动力沿途轻响路上微风转角旋律清晨穿行晚归节奏闪耀拍点欢聚声浪今夜升温快乐回环霓虹";
const PLAYLIST_SCENE_LABELS: Record<ScenePreset, string> = {
  late_night: "放松",
  study: "专注",
  workout: "运动",
  commute: "律动",
  party: "派对",
};
const NETEASE_PLAYLIST_SUFFIXES: Record<ScenePreset, readonly string[]> = {
  late_night: ["微光慢行", "舒展回声", "松弛漫游", "清风低语", "轻柔潮汐", "慢拍来信"],
  study: ["清醒书页", "专注留白", "思绪微光", "安静向前", "纸上清风", "晨读余音"],
  workout: ["热力节拍", "向前律动", "能量上扬", "汗水回声", "燃点时刻", "动力续航"],
  commute: ["律动轻响", "明亮慢拍", "节拍微风", "转角旋律", "流动脉冲", "轻快节奏"],
  party: ["闪耀拍点", "欢聚声浪", "今夜升温", "快乐回环", "热场律动", "霓虹节拍"],
};

function programPlaylistName(programId: string, spec: ProgramSpec, provider: "netease" | "qq", existingNames: Set<string>): string {
  const prefix = `AI电台-${PLAYLIST_SCENE_LABELS[spec.scenePreset]}-`;
  if (provider === "netease") {
    const candidates = NETEASE_PLAYLIST_SUFFIXES[spec.scenePreset];
    const start = createHash("sha256").update(programId).digest()[0]! % candidates.length;
    return Array.from({ length: candidates.length }, (_, offset) => `${prefix}${candidates[(start + offset) % candidates.length]}`)
      .find((candidate) => !existingNames.has(candidate))
      ?? `${prefix}${candidates[start]}`;
  }
  for (let attempt = 0; attempt < 128; attempt += 1) {
    const digest = createHash("sha256").update(`qq-program-playlist:${programId}:${attempt}`).digest();
    const suffix = Array.from({ length: 6 }, (_, index) => QQ_PLAYLIST_NAME_ALPHABET[digest.readUInt16BE(index * 2) % QQ_PLAYLIST_NAME_ALPHABET.length]).join("");
    const candidate = `${prefix}${suffix}`;
    if (!existingNames.has(candidate)) return candidate;
  }
  throw new ServiceError("QQ_PROVIDER_ERROR", 502, "无法为本次 QQ 节目生成唯一歌单名。");
}

const ACTIVE_STATUSES = new Set<ProgramState["status"]>([
  "draft",
  "awaiting_confirmation",
  "preparing",
  "on_air",
  "closing",
]);

const TERMINAL_STATUSES = new Set<ProgramState["status"]>([
  "completed",
  "stopped",
  "failed",
  "control_lost",
  "stop_unconfirmed",
]);

type UnknownRecord = Record<string, unknown>;

interface EngineLike {
  create(spec: ProgramSpec): unknown;
  confirm(programId: string): unknown;
  getState(): unknown;
  tick(now?: unknown): unknown;
  heartbeat(programId: string, generation: number): unknown;
  next(command: unknown): unknown;
  stop(command: unknown): unknown;
  reset?(): void;
}

interface HostProviderLike {
  generate(context: HostContextPack, options?: { signal?: AbortSignal }): unknown;
  generateShow?(request: {
    scenePreset: ScenePreset;
    frequency: "low" | "medium" | "high";
    openingGreeting?: "早上好" | "下午好" | "晚上好" | "夜深了";
    hostProfile?: HostProfileId;
    tracks: Array<{
      trackIndex: number;
      title: string;
      artist: string;
      album?: string;
      exploration: boolean;
      allowedFacts: HostContextPack["allowedFacts"];
    }>;
    skillInstruction: string;
    reviewInstruction: string;
    listenerProfile?: ProgramListenerProfile;
    userAdjustment?: string;
  }, options?: { signal?: AbortSignal }): unknown;
  research?(request: {
    scenePreset: ScenePreset;
    listenerProfile?: { favoriteArtists: string[]; topSongs: string[]; inferredThemes: string[] };
    tracks: Array<{ title: string; artist: string; exploration?: boolean }>;
  }, options?: { signal?: AbortSignal }): unknown;
  generatePlaylistNames?(request: {
    scenePreset: ScenePreset;
    energyCurve: string;
    tracks: Array<{ title: string; artist: string }>;
  }, options?: { signal?: AbortSignal }): unknown;
  configured?: boolean;
  state?: string;
  getStatus?(): unknown;
  adjustRundown?(request: { instruction: string; tracks: Array<{ id: string; title: string; artist: string; mood: string[] }> }, signal?: AbortSignal): Promise<string[]>;
}

interface TtsProviderLike {
  synthesize(input: { text: string; scenePreset: ScenePreset; hostProfile?: HostProfileId; instruction?: string; signal?: AbortSignal }): unknown;
  snapshot?(): Promise<{ fingerprint: string; synthesize(input: { text: string; scenePreset: ScenePreset; hostProfile?: HostProfileId; instruction?: string; signal?: AbortSignal }): unknown; isCurrent(): Promise<boolean> }>;
  configured?: boolean;
  state?: string;
  getStatus?(): unknown;
}

interface NeteaseProviderLike {
  configured?: boolean;
  state?: string;
  getStatus?(): unknown;
  health?(signal?: AbortSignal): unknown;
  search?(keyword: string, options?: { limit?: number; offset?: number; signal?: AbortSignal }): unknown;
  searchPlaylists?(keyword: string, options?: { limit?: number; offset?: number; signal?: AbortSignal }): unknown;
  playlistDetail?(id: string, signal?: AbortSignal): unknown;
  songDetail?(ids: string[], signal?: AbortSignal): unknown;
  songCredits?(id: string, signal?: AbortSignal): unknown;
  songUrl?(id: string, options?: { level?: string; signal?: AbortSignal }): unknown;
  createQrLogin?(signal?: AbortSignal): unknown;
  checkQrLogin?(key: string, signal?: AbortSignal): unknown;
  account?(signal?: AbortSignal): unknown;
  userPlaylists?(uid: string, options?: { limit?: number; offset?: number; signal?: AbortSignal }): unknown;
  likedSongIds?(uid: string, signal?: AbortSignal): unknown;
  likedSongs?(options?: { limit?: number; signal?: AbortSignal }): unknown;
  recentSongs?(options?: { limit?: number; signal?: AbortSignal }): unknown;
  listeningHistory?(uid: string, options?: { period?: "week" | "all"; signal?: AbortSignal }): unknown;
  dailyRecommendations?(options?: { refresh?: boolean; signal?: AbortSignal }): unknown;
  personalFm?(signal?: AbortSignal): unknown;
  similarSongs?(id: string, options?: { limit?: number; offset?: number; signal?: AbortSignal }): unknown;
  createPlaylist?(name: string, signal?: AbortSignal): unknown;
  addSongsToPlaylist?(playlistId: string, trackIds: string[], signal?: AbortSignal): unknown;
  deletePlaylist?(playlistId: string, signal?: AbortSignal): unknown;
  setSongLiked?(id: string, liked: boolean, signal?: AbortSignal): unknown;
  logout?(): unknown;
}

/**
 * QQ Music is intentionally modelled after the account API contract used by
 * NetEase. The concrete adapter may use QQ Music mobile QR login, but the
 * service only deals in provider-neutral account/profile/search/playlist
 * operations and never needs to drive the desktop player for API-backed QQ
 * programs.
 */
interface QqProviderLike {
  configured?: boolean;
  state?: string;
  getStatus?(): unknown;
  health?(signal?: AbortSignal): unknown;
  search?(keyword: string, options?: { limit?: number; offset?: number; signal?: AbortSignal }): unknown;
  searchPlaylists?(keyword: string, options?: { limit?: number; offset?: number; signal?: AbortSignal }): unknown;
  playlistDetail?(id: string, signal?: AbortSignal): unknown;
  songDetail?(ids: string[], signal?: AbortSignal): unknown;
  songUrl?(id: string, options?: { level?: string; signal?: AbortSignal }): unknown;
  createQrLogin?(loginType?: "wx" | "qq" | "mobile", signal?: AbortSignal): unknown;
  checkQrLogin?(key: string, loginType?: "wx" | "qq" | "mobile", signal?: AbortSignal): unknown;
  account?(signal?: AbortSignal): unknown;
  userPlaylists?(uid: string, options?: { limit?: number; offset?: number; signal?: AbortSignal }): unknown;
  likedSongIds?(uid: string, signal?: AbortSignal): unknown;
  likedSongs?(options?: { limit?: number; signal?: AbortSignal }): unknown;
  recentSongs?(options?: { limit?: number; signal?: AbortSignal }): unknown;
  listeningHistory?(uid: string, options?: { period?: "week" | "all"; signal?: AbortSignal }): unknown;
  dailyRecommendations?(options?: { refresh?: boolean; signal?: AbortSignal }): unknown;
  personalFm?(signal?: AbortSignal): unknown;
  similarSongs?(id: string, options?: { limit?: number; offset?: number; signal?: AbortSignal }): unknown;
  createPlaylist?(name: string, signal?: AbortSignal, identity?: { expectedUid: string }): unknown;
  addSongsToPlaylist?(playlistId: string, trackIds: string[], signal?: AbortSignal, identity?: { dirId: string; expectedUid: string }): unknown;
  replacePlaylistTracks?(playlistId: string, trackIds: string[], signal?: AbortSignal, identity?: { dirId: string; expectedUid: string }): unknown;
  deletePlaylist?(playlistId: string, signal?: AbortSignal, identity?: { dirId: string; expectedUid: string }): unknown;
  setSongLiked?(id: string, liked: boolean, songType: number | undefined, signal?: AbortSignal, identity?: { expectedUid: string }): unknown;
  logout?(signal?: AbortSignal): unknown;
}

type AccountProviderLike = NeteaseProviderLike | QqProviderLike;
const execFile = promisify(nodeExecFile);

interface AudioEntry {
  data: Buffer;
  contentType: string;
  expiresAt: number;
}

interface LockedHostAudio {
  data: Buffer;
  contentType: string;
  preparedAt: string;
}

interface AccountRundown {
  items: ProgramRundownItem[];
  index: number;
  revision: number;
  listenerProfile?: ProgramListenerProfile;
  accountUid?: string;
  hostAudio: Map<string, LockedHostAudio>;
  preferences?: UnknownRecord;
  hostScriptsPending?: boolean;
  hostScriptsFinalized?: boolean;
}

export interface LocalServiceOptions {
  port?: number;
  host?: string;
  version?: string;
  allowedOrigins?: string[];
  engine?: EngineLike;
  hostProvider?: HostProviderLike;
  ttsProvider?: TtsProviderLike;
  neteaseProvider?: NeteaseProviderLike;
  qqProvider?: QqProviderLike;
  desktopPlayerController?: DesktopPlayerControllerLike;
  desktopProgramController?: DesktopProgramControllerLike;
  desktopPetController?: DesktopPetControllerLike;
  localControlToken?: string;
  lockedTtsTimeoutMs?: number;
  aiConfigStore?: LocalAiConfigStore;
  cloudAccessStore?: CloudAccessStore;
}

export interface LocalService {
  server: ReturnType<typeof createServer>;
  port: number;
  start(): Promise<{ host: string; port: number }>;
  stop(): Promise<void>;
}

class ServiceError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "ServiceError";
    this.status = status;
    this.code = code;
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function musicFactMatchesTrack(value: string, track: Pick<ProgramRundownItem, "title" | "artist">, playlist: Array<Pick<ProgramRundownItem, "title" | "artist">>): boolean {
  const fact = value.toLocaleLowerCase();
  const title = track.title.toLocaleLowerCase();
  const artist = track.artist.toLocaleLowerCase();
  if (title && fact.includes(title)) return true;
  if (!artist || !fact.includes(artist)) return false;
  return !playlist.some((candidate) => candidate.title !== track.title && candidate.title.length >= 3 && fact.includes(candidate.title.toLocaleLowerCase()));
}

function nonEmptyString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new ServiceError("INVALID_INPUT", 400, `${field} is required`);
  }
  return value.trim();
}

function safeCode(value: unknown, fallback = "ENGINE_ERROR"): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 64);
  return /^[A-Z][A-Z0-9_]*$/.test(normalized) ? normalized : fallback;
}

function publicMessage(code: string, fallback = "Request could not be completed"): string {
  const messages: Record<string, string> = {
    INVALID_INPUT: "Request input is invalid",
    INVALID_JSON: "Request body must be valid JSON",
    BODY_REQUIRED: "Request body is required",
    BODY_TOO_LARGE: "Request body is too large",
    UNSUPPORTED_MEDIA_TYPE: "Content-Type must be application/json",
    CORS_ORIGIN_NOT_ALLOWED: "Origin is not allowed",
    PROGRAM_NOT_FOUND: "Program was not found",
    NO_ACTIVE_PROGRAM: "There is no active program",
    PROGRAM_ALREADY_ACTIVE: "Another program is already active",
    PROGRAM_TERMINAL: "Program is already in a terminal state",
    GENERATION_MISMATCH: "Program generation is stale",
    OPERATION_REQUIRED: "operationId is required",
    OPERATION_REUSED: "operationId was already used with different input",
    PROGRAM_EXISTS: "Another program is already active",
    STALE_GENERATION: "Program generation is stale",
    SOURCE_NOT_ALLOWED: "Selected source is not allowed for a hosted program",
    HOST_CONTEXT_REQUIRED: "Host context is required",
    HOST_UNAVAILABLE: "Host provider is unavailable",
    TTS_UNAVAILABLE: "TTS provider is unavailable",
    TTS_AUDIO_TOO_LARGE: "Generated audio is too large",
    NETEASE_UNAVAILABLE: "NetEase Cloud Music API is not configured",
    NETEASE_LOGIN_REQUIRED: "请先扫码连接网易云音乐账号",
    NETEASE_PROVIDER_ERROR: "NetEase Cloud Music API request failed",
    QQ_UNAVAILABLE: "QQ Music API is not configured",
    QQ_LOGIN_REQUIRED: "请先扫码连接 QQ 音乐账号",
    QQ_PROVIDER_ERROR: "QQ Music API request failed",
    QQ_AUDIO_BUSY: "QQ 音乐音频流已经在传输中。",
    PLAYER_SOURCE_INVALID: "Player source must be QQ Music or NetEase Cloud Music",
    PLAYER_VOLUME_INVALID: "Player volume must be between 0 and 1",
    DESKTOP_PROGRAM_FAILED: "Desktop music selection could not be confirmed",
    DESKTOP_STOP_UNCONFIRMED: "Desktop music could not be confirmed as stopped",
    DESKTOP_NEXT_UNCONFIRMED: "Desktop music could not be advanced",
    UNAUTHORIZED: "Local player control request is not authorized",
    AUDIO_NOT_FOUND: "Audio was not found or has expired",
    METHOD_NOT_ALLOWED: "Method is not allowed",
    NOT_FOUND: "Resource was not found",
    INTERNAL_ERROR: "Internal server error",
  };
  return messages[code] ?? fallback;
}

function statusForCode(code: string): number {
  if (code === "PROGRAM_NOT_FOUND" || code === "AUDIO_NOT_FOUND" || code === "NOT_FOUND") return 404;
  if (code === "PROGRAM_ALREADY_ACTIVE" || code === "PROGRAM_EXISTS" || code === "PROGRAM_TERMINAL" || code === "GENERATION_MISMATCH" || code === "STALE_GENERATION" || code === "OPERATION_REUSED" || code === "SOURCE_NOT_ALLOWED") return 409;
  if (code === "BODY_TOO_LARGE") return 413;
  if (code === "UNSUPPORTED_MEDIA_TYPE") return 415;
  if (code === "CORS_ORIGIN_NOT_ALLOWED") return 403;
  if (code === "UNAUTHORIZED") return 401;
  if (code === "NETEASE_LOGIN_REQUIRED") return 401;
  if (code === "QQ_LOGIN_REQUIRED") return 401;
  if (code === "DESKTOP_PROGRAM_FAILED" || code === "DESKTOP_STOP_UNCONFIRMED" || code === "DESKTOP_NEXT_UNCONFIRMED") return 409;
  if (code === "HOST_UNAVAILABLE" || code === "TTS_UNAVAILABLE" || code === "NETEASE_UNAVAILABLE" || code === "QQ_UNAVAILABLE") return 503;
  if (code === "INTERNAL_ERROR" || code.startsWith("ENGINE_") || code.endsWith("_PROVIDER_ERROR")) return 500;
  return 400;
}

function desktopPlayerSource(value: unknown): DesktopPlayerSource {
  if (typeof value !== "string") throw new ServiceError("PLAYER_SOURCE_INVALID", 400, publicMessage("PLAYER_SOURCE_INVALID"));
  try {
    return assertDesktopPlayerSource(value);
  } catch {
    throw new ServiceError("PLAYER_SOURCE_INVALID", 400, publicMessage("PLAYER_SOURCE_INVALID"));
  }
}

function failFromUnknown(error: unknown, fallbackCode = "ENGINE_ERROR"): ServiceError {
  if (error instanceof ServiceError) return error;
  const record = isRecord(error) ? error : null;
  const code = safeCode(record?.code, fallbackCode);
  return new ServiceError(code, statusForCode(code), publicMessage(code));
}

function hostProviderFailure(error: unknown, stage: string): ServiceError {
  if (error instanceof ServiceError) return error;
  if (!(error instanceof ProviderError)) {
    return new ServiceError("HOST_PROVIDER_ERROR", 502, `${stage}失败：本地服务没有收到可用的模型结果。`);
  }
  const messages: Record<ProviderError["code"], string> = {
    missing_credentials: `${stage}失败：未找到大模型 API Key。`,
    invalid_input: `${stage}失败：发送给模型的请求参数无效。`,
    invalid_response: `${stage}失败：模型返回的格式不符合节目文案要求。`,
    invalid_facts: `${stage}失败：模型返回的事实引用未通过校验。`,
    invalid_audio: `${stage}失败：服务返回了无效音频。`,
    timeout: `${stage}超时：模型在限定时间内没有返回结果，可以重试。`,
    unauthorized: `${stage}失败：模型服务拒绝了当前 API Key。`,
    rate_limited: `${stage}失败：模型服务当前限流，请稍后重试。`,
    business_error: `${stage}失败：模型服务拒绝了本次生成请求。`,
    unsupported: `${stage}失败：当前模型或接口不支持所需能力。`,
    network_error: `${stage}失败：本地服务无法连接模型接口。`,
  };
  const status = error.code === "timeout" ? 504 : error.code === "rate_limited" ? 429 : 502;
  return new ServiceError("HOST_PROVIDER_ERROR", status, messages[error.code]);
}

function isHostScriptQualityFailure(error: unknown): error is ServiceError {
  return error instanceof ServiceError
    && error.code === "HOST_PROVIDER_ERROR"
    && /口播未通过|主持词未通过|主持词与本档前文重复|整档文案未展示/.test(error.message);
}

function unwrapEngineResult(value: unknown): unknown {
  if (isRecord(value) && value.ok === false) {
    const code = safeCode(value.code, "ENGINE_ERROR");
    throw new ServiceError(code, statusForCode(code), publicMessage(code));
  }
  if (isRecord(value) && "state" in value) return value.state;
  if (isRecord(value) && "program" in value) return value.program;
  return value;
}

function asProgramState(value: unknown): ProgramState | null {
  const unwrapped = unwrapEngineResult(value);
  if (unwrapped === null || unwrapped === undefined) return null;
  if (!isRecord(unwrapped)) throw new ServiceError("ENGINE_INVALID_STATE", 500, publicMessage("INTERNAL_ERROR"));
  return unwrapped as unknown as ProgramState;
}

function nowIso(): string {
  return new Date().toISOString();
}

function programStyleTags(scenePreset: ScenePreset, musicGenres: readonly MusicGenreId[] = []): MusicGenreId[] {
  return [...new Set(musicGenres.length > 0 ? musicGenres : SCENE_STYLE_TAGS[scenePreset])];
}

function recommendationModeForSpec(spec: Pick<ProgramSpec, "recommendationMode" | "musicGenres">): NonNullable<ProgramSpec["recommendationMode"]> {
  return spec.recommendationMode === "genre" || ((spec.musicGenres?.length ?? 0) > 0 && spec.recommendationMode !== "atmosphere") ? "genre" : "atmosphere";
}

function isAtmosphereExploration(mode: NonNullable<ProgramSpec["recommendationMode"]>, familiarityRatio: number): boolean {
  return mode === "atmosphere" && familiarityRatio <= ATMOSPHERE_EXPLORATION_RATIO_MAX;
}

function arrangementSceneForSpec(spec: Pick<ProgramSpec, "recommendationMode" | "musicGenres" | "scenePreset">): ScenePreset {
  return recommendationModeForSpec(spec) === "genre" ? "commute" : spec.scenePreset;
}

function searchQueryForRecommendation(scenePreset: ScenePreset, styleTags: readonly MusicGenreId[], mode: NonNullable<ProgramSpec["recommendationMode"]>): string {
  return mode === "genre"
    ? styleTags.map((genre) => MUSIC_GENRES[genre].label).join(" ")
    : [DESKTOP_SCENE_QUERY_TERMS[scenePreset], ...styleTags.map((genre) => MUSIC_GENRES[genre].label)].join(" ");
}

function selectedStyleAffinities(profile: { styleAffinities?: unknown }, styleTags: readonly MusicGenreId[]): UnknownRecord[] {
  const wanted = new Set(styleTags);
  const affinities = Array.isArray(profile.styleAffinities) ? profile.styleAffinities : [];
  return affinities.filter((item): item is UnknownRecord =>
    isRecord(item) && typeof item.style === "string" && wanted.has(item.style as MusicGenreId),
  );
}

function stylePublicPlaylistQueries(scenePreset: ScenePreset, styleTags: readonly MusicGenreId[], affinities: readonly UnknownRecord[], mode: NonNullable<ProgramSpec["recommendationMode"]> = "atmosphere", exploration = false): string[] {
  const byStyle = new Map(affinities.flatMap((affinity) =>
    typeof affinity.style === "string" ? [[affinity.style, affinity] as const] : [],
  ));
  const queries: string[] = [];
  if (mode === "atmosphere") {
    const sceneQueries = SCENE_PLAYLIST_QUERY_TERMS[scenePreset];
    queries.push(...sceneQueries.slice(0, exploration ? sceneQueries.length : 3));
  }
  for (const genre of styleTags) {
    const styleTerm = MUSIC_GENRES[genre].searchTerm;
    const affinity = byStyle.get(genre);
    const artists = affinity && Array.isArray(affinity.artists) ? affinity.artists : [];
    for (const artist of artists.slice(0, mode === "genre" ? 1 : 2)) {
      if (isRecord(artist) && typeof artist.name === "string" && artist.name.trim()) {
        queries.push(mode === "atmosphere"
          ? `${artist.name.trim()} ${DESKTOP_SCENE_QUERY_TERMS[scenePreset]} ${styleTerm} 歌单`
          : `${artist.name.trim()} ${STYLE_PLAYLIST_QUERY_TERMS[genre][0]}`);
      }
    }
    if (mode === "atmosphere") queries.push(`${DESKTOP_SCENE_QUERY_TERMS[scenePreset]} ${styleTerm} 歌单`);
    else queries.push(...STYLE_PLAYLIST_QUERY_TERMS[genre]);
  }
  return [...new Set(queries)];
}

function genreForPlaylistQuery(query: string, genres: readonly MusicGenreId[]): MusicGenreId | null {
  const normalized = query.normalize("NFKC").toLocaleLowerCase();
  for (const genre of genres) {
    if (STYLE_PLAYLIST_QUERY_TERMS[genre].some((term) => normalized.includes(term.normalize("NFKC").toLocaleLowerCase()))) return genre;
  }
  return null;
}

function playlistHasStyleEvidence(value: unknown, genre: MusicGenreId): boolean {
  if (!isRecord(value)) return false;
  const text = [value.name, value.description]
    .filter((field): field is string => typeof field === "string" && field.trim().length > 0)
    .join(" ")
    .normalize("NFKC");
  return STYLE_PLAYLIST_EVIDENCE[genre].test(text);
}

function seededSampleScore(seed: string, ...parts: Array<string | number>): number {
  const digest = createHash("sha256").update([seed, ...parts].join(":"), "utf8").digest();
  return digest.readUInt32BE(0) / 0xffff_ffff;
}

function rerankAtmosphereExploration<T extends { candidate: PersonalizationCandidate; score: number; reasons: string[] }>(entries: readonly T[]): T[] {
  return entries
    .map((entry, index) => {
      const adjustment = atmosphereExplorationScoreAdjustment(entry.candidate);
      return {
        entry: adjustment === 0 ? entry : { ...entry, score: entry.score + adjustment, reasons: [...entry.reasons, `atmosphere exploration quality ${adjustment >= 0 ? "+" : ""}${adjustment}`] },
        index,
      };
    })
    .sort((left, right) => right.entry.score - left.entry.score || left.index - right.index)
    .map(({ entry }) => entry);
}

function atmosphereExplorationScoreAdjustment(candidate: PersonalizationCandidate): number {
  let adjustment = 0;
  const tags = styleTagSet(candidate.styleTags);
  if (candidate.publicPlaylistId !== undefined) adjustment += 24;
  if (typeof candidate.playlistSampleScore === "number" && Number.isFinite(candidate.playlistSampleScore)) {
    adjustment += Math.round(Math.max(0, Math.min(1, candidate.playlistSampleScore)) * 20);
  }
  const popularity = typeof candidate.popularity === "number" && Number.isFinite(candidate.popularity)
    ? Math.min(1, candidate.popularity > 1 ? candidate.popularity / 100 : candidate.popularity)
    : 0;
  adjustment += Math.round(popularity * 14);
  if ([...tags].some((tag) => MAINSTREAM_DISCOVERY_STYLES.has(tag))) adjustment += 14;
  if (isLegacyDiscoveryCandidate(candidate)) adjustment -= 72;
  if (isRemixDiscoveryCandidate(candidate)) adjustment -= 72;
  if (isLowShareDefaultStyle(candidate)) adjustment -= 34;
  return adjustment;
}

function isLowShareDefaultStyle(candidate: Pick<PersonalizationCandidate, "title" | "artist" | "artists" | "album" | "genre" | "styleTags" | "searchQuery" | "query">): boolean {
  const tags = styleTagSet(candidate.styleTags);
  const hasLowShareStyle = [...tags].some((tag) => DEFAULT_LOW_SHARE_STYLES.has(tag));
  if (!hasLowShareStyle && !/(?:new age|世界音乐|world music|民族|ethnic|拉丁|latin|轻音乐|easy listening|复古\s*disco|retro\s*disco|bossa nova|巴萨诺瓦)/i.test(candidateSearchText(candidate))) return false;
  return ![...tags].some((tag) => MAINSTREAM_DISCOVERY_STYLES.has(tag));
}

function isLegacyDiscoveryCandidate(candidate: Pick<PersonalizationCandidate, "title" | "artist" | "artists" | "album" | "genre" | "releaseYear" | "searchQuery" | "query">): boolean {
  const releaseYear = typeof candidate.releaseYear === "number" && Number.isFinite(candidate.releaseYear) ? candidate.releaseYear : null;
  if (releaseYear && releaseYear <= new Date().getFullYear() - LEGACY_DISCOVERY_YEARS) return true;
  return /(?:老歌|怀旧|复古\s*disco|retro\s*disco|oldies|golden oldies)/i.test(candidateSearchText(candidate));
}

function isRemixDiscoveryCandidate(candidate: Pick<PersonalizationCandidate, "title" | "artist" | "artists" | "album" | "genre" | "searchQuery" | "query">): boolean {
  return /(?:remix|re-?mix|bootleg|mashup|mix版|混音版|加速版|加快版|降调版|升调版|slowed|sped\s*up|speed\s*up)/i.test(candidateSearchText(candidate));
}

function styleTagSet(value: unknown): Set<MusicGenreId> {
  return new Set(Array.isArray(value) ? value.filter((tag): tag is MusicGenreId => typeof tag === "string" && MUSIC_GENRE_IDS.includes(tag as MusicGenreId)) : []);
}

function candidateSearchText(candidate: Pick<PersonalizationCandidate, "title" | "artist" | "artists" | "album" | "genre" | "searchQuery" | "query">): string {
  const fields = [candidate.title, candidate.artist, candidate.genre, candidate.searchQuery, candidate.query];
  if (typeof candidate.album === "string") fields.push(candidate.album);
  else if (isRecord(candidate.album) && typeof candidate.album.name === "string") fields.push(candidate.album.name);
  if (Array.isArray(candidate.artists)) {
    for (const artist of candidate.artists) {
      if (typeof artist === "string") fields.push(artist);
      else if (isRecord(artist) && typeof artist.name === "string") fields.push(artist.name);
    }
  }
  return fields.filter((value): value is string => typeof value === "string" && value.trim().length > 0).join(" ").normalize("NFKC");
}

function withSearchContext(song: unknown, searchQuery: string, styleTags: readonly MusicGenreId[]): unknown {
  return isRecord(song) ? { ...song, searchQuery, styleTags: [...styleTags] } : song;
}

function exactGenreQueryTags(query: string): MusicGenreId[] {
  const normalize = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase().replace(/(?:音乐)?(?:风格|类型)$/u, "").trim();
  const normalized = normalize(query);
  if (!normalized) return [];
  const match = (value: string) => MUSIC_GENRE_IDS.filter((genre) => MUSIC_GENRE_QUERY_ALIASES[genre].some((alias) => normalize(alias) === value));
  const direct = match(normalized);
  if (direct.length > 0) return direct;
  const withoutMusicSuffix = normalized.replace(/音乐$/u, "").trim();
  const musicStyle = withoutMusicSuffix === normalized ? [] : match(withoutMusicSuffix);
  if (musicStyle.length > 0) return musicStyle;
  const parts = normalized.split(/[、，,]|(?:和|与)/u).map(normalize).filter(Boolean);
  if (parts.length < 2) return [];
  const matched = parts.map((part) => MUSIC_GENRE_IDS.find((genre) => MUSIC_GENRE_QUERY_ALIASES[genre].some((alias) => normalize(alias) === part)));
  return matched.every((genre): genre is MusicGenreId => genre !== undefined) ? [...new Set(matched)] : [];
}

function inferStyleTags(value: unknown, fallbackTags: readonly MusicGenreId[] = []): MusicGenreId[] {
  const record = isRecord(value) && isRecord(value.song) ? value.song : value;
  const fields: string[] = [];
  if (isRecord(record)) {
    for (const key of ["genre", "searchQuery"] as const) {
      if (typeof record[key] === "string") fields.push(record[key]);
    }
    if (Array.isArray(record.mood)) fields.push(...record.mood.filter((item): item is string => typeof item === "string"));
    if (Array.isArray(record.styleTags)) fields.push(...record.styleTags.filter((item): item is string => typeof item === "string"));
  }
  const text = fields.join(" ").toLocaleLowerCase();
  const profileInferred = inferSongTags({ id: "style-probe", title: "", artists: [], tags: [text] })
    .filter((tag): tag is MusicGenreId => MUSIC_GENRE_IDS.includes(tag as MusicGenreId));
  const inferred = MUSIC_GENRE_IDS.filter((genre) => {
    const option = MUSIC_GENRES[genre];
    const terms = [genre.replace("_", " "), option.label, ...option.searchTerm.split(/\s+/)]
      .map((term) => term.toLocaleLowerCase())
      .filter((term) => term.length > 2);
    return terms.some((term) => text.includes(term));
  });
  return [...new Set([...fallbackTags, ...profileInferred, ...inferred])];
}

function listeningProfilePath(providerId: "netease" | "qq", uid: string): string {
  const accountKey = createHash("sha256").update(`${providerId}:${uid}`).digest("hex").slice(0, 24);
  return join(listeningProfileDirectory(), `${providerId}-${accountKey}.json`);
}

function listeningProfileDirectory(): string {
  return process.env.ONE_RADIO_PROFILE_DIR?.trim() || DEFAULT_LISTENING_PROFILE_DIR;
}

async function profileStorageStats(): Promise<{ files: number; bytes: number }> {
  const directory = listeningProfileDirectory();
  try {
    const directoryStat = await lstat(directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw new Error("Profile storage path is unsafe");
    const names = (await readdir(directory)).filter((name) => /^(?:netease|qq)-[a-f0-9]{24}\.json$/.test(name));
    const sizes = await Promise.all(names.map(async (name) => {
      const entry = await lstat(join(directory, name));
      return entry.isFile() && !entry.isSymbolicLink() ? entry.size : 0;
    }));
    return { files: names.length, bytes: sizes.reduce((total, size) => total + size, 0) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { files: 0, bytes: 0 };
    throw error;
  }
}

async function clearListeningProfiles(): Promise<number> {
  const directory = listeningProfileDirectory();
  try {
    const directoryStat = await lstat(directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw new Error("Profile storage path is unsafe");
    const names = (await readdir(directory)).filter((name) => /^(?:netease|qq)-[a-f0-9]{24}\.json$/.test(name));
    await Promise.all(names.map(async (name) => {
      const path = join(directory, name);
      const entry = await lstat(path);
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Profile storage entry is unsafe");
      await unlink(path);
    }));
    return names.length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

async function readDesktopPetPreferences(): Promise<{ scale: "small" | "medium" | "large"; positionSaved: boolean; available: boolean }> {
  if (process.platform !== "darwin") return { scale: "small", positionSaved: false, available: false };
  const readDefault = async (key: string): Promise<string | null> => {
    try {
      const { stdout } = await execFile("/usr/bin/defaults", ["read", DESKTOP_PET_PREFERENCES_SUITE, key], { timeout: 3_000 });
      return stdout.trim();
    } catch {
      return null;
    }
  };
  const [rawScale, x, y] = await Promise.all([readDefault("desktopPetScale"), readDefault("desktopPetX"), readDefault("desktopPetY")]);
  const scale = rawScale === "medium" || rawScale === "large" ? rawScale : "small";
  return { scale, positionSaved: x !== null && y !== null, available: true };
}

async function writeDesktopPetPreferences(input: { scale?: "small" | "medium" | "large"; resetPosition?: boolean }): Promise<{ scale: "small" | "medium" | "large"; positionSaved: boolean; available: boolean }> {
  if (process.platform !== "darwin") throw new Error("Desktop pet preferences require macOS");
  if (input.scale) await execFile("/usr/bin/defaults", ["write", DESKTOP_PET_PREFERENCES_SUITE, "desktopPetScale", "-string", input.scale], { timeout: 3_000 });
  if (input.resetPosition) {
    await Promise.all(["desktopPetX", "desktopPetY"].map(async (key) => {
      try {
        await execFile("/usr/bin/defaults", ["delete", DESKTOP_PET_PREFERENCES_SUITE, key], { timeout: 3_000 });
      } catch {
        // A missing saved coordinate is already reset.
      }
    }));
  }
  return readDesktopPetPreferences();
}

async function clearDesktopPetPreferences(): Promise<void> {
  if (process.platform !== "darwin") return;
  try {
    await execFile("/usr/bin/defaults", ["delete", DESKTOP_PET_PREFERENCES_SUITE], { timeout: 3_000 });
  } catch {
    // A missing preference suite is already reset.
  }
}

async function loadListeningProfileSnapshot(providerId: "netease" | "qq", uid: string): Promise<UnknownRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(listeningProfilePath(providerId, uid), "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function recentProgramTrackIds(snapshot: UnknownRecord | null): string[] {
  if (!snapshot) return [];
  const playedIds = Array.isArray(snapshot.playedTracks)
    ? snapshot.playedTracks.flatMap((entry) => isRecord(entry) && typeof entry.id === "string" ? [entry.id] : [])
    : [];
  const legacyIds = Array.isArray(snapshot.programHistory) ? snapshot.programHistory
    .flatMap((entry) => isRecord(entry) && Array.isArray(entry.trackIds) ? entry.trackIds : [])
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0) : [];
  return [...new Set([...playedIds, ...legacyIds])];
}

async function persistListeningProfileSnapshot(
  providerId: "netease" | "qq",
  uid: string,
  snapshot: UnknownRecord,
): Promise<void> {
  const path = listeningProfilePath(providerId, uid);
  const accountKey = createHash("sha256").update(`${providerId}:${uid}`).digest("hex").slice(0, 24);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify({
    version: 1,
    provider: providerId,
    accountKey,
    updatedAt: nowIso(),
    ...snapshot,
  }, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function persistPlayedTrackSnapshot(
  providerId: "netease" | "qq",
  uid: string | undefined,
  preferences: UnknownRecord | undefined,
  spec: ProgramSpec,
  track: ProgramRundownItem | undefined,
  programId: string,
): Promise<void> {
  if (!uid || !preferences || !track) return;
  const latestSnapshot = await loadListeningProfileSnapshot(providerId, uid);
  const previousSnapshot = latestSnapshot ?? (isRecord(preferences.previousSnapshot) ? preferences.previousSnapshot : null);
  const previousPlayed = previousSnapshot && Array.isArray(previousSnapshot.playedTracks)
    ? previousSnapshot.playedTracks.filter(isRecord)
    : [];
  const playedTracks = [
    {
      id: track.id,
      title: track.title,
      artist: track.artist,
      playedAt: nowIso(),
      programId,
      scenePreset: spec.scenePreset,
      musicGenres: programStyleTags(spec.scenePreset, spec.musicGenres ?? []),
    },
    ...previousPlayed.filter((entry) => entry.id !== track.id),
  ];
  await persistListeningProfileSnapshot(providerId, uid, {
    programHistory: previousSnapshot && Array.isArray(previousSnapshot.programHistory) ? previousSnapshot.programHistory : [],
    playedTracks,
    counts: isRecord(preferences.counts) ? preferences.counts : {},
    favoriteArtists: Array.isArray(preferences.favoriteArtists) ? preferences.favoriteArtists : [],
    profile: isRecord(preferences.profile) ? preferences.profile : {},
    listenerProfile: isRecord(preferences.listenerProfile) ? preferences.listenerProfile : {},
    routePlan: isRecord(preferences.routePlan) ? preferences.routePlan : {},
    selectedScene: spec.scenePreset,
    selectedMusicGenres: programStyleTags(spec.scenePreset, spec.musicGenres ?? []),
    recommendationMode: recommendationModeForSpec(spec),
  }).catch(() => undefined);
}

function envHas(...keys: string[]): boolean {
  return keys.some((key) => typeof process.env[key] === "string" && process.env[key]!.trim().length > 0);
}

function sourceDiagnostic(
  sourceId: SourceDiagnostic["sourceId"],
  label: string,
  configured: boolean,
  readyState: SourceDiagnostic["state"],
  blockedState: SourceDiagnostic["state"],
  readyDetail: string,
  blockedDetail: string,
  checkedAt: string,
): SourceDiagnostic {
  const ready = configured;
  const state = ready ? readyState : configured ? blockedState : "blocked_by_credentials";
  return {
    sourceId,
    label,
    playbackReady: ready,
    hostedProgramAllowed: ready,
    state,
    detail: ready ? readyDetail : configured ? blockedDetail : "未配置访问凭据。",
    checkedAt,
  };
}

function buildSourceDiagnostics(): SourceDiagnostic[] {
  const checkedAt = nowIso();
  return [
    sourceDiagnostic(
      "fixture",
      "Local fixture",
      true,
      "ready",
      "ready",
      "Deterministic local audio fixture",
      "Deterministic local audio fixture",
      checkedAt,
    ),
    sourceDiagnostic(
      "qq_music",
      "QQ 音乐",
      true,
      "ready",
      "blocked_by_official_access",
      "QQ 音乐桌面适配器可按场景搜索并建立播放队列。",
      "QQ 音乐桌面自动选歌暂不可用。",
      checkedAt,
    ),
    sourceDiagnostic(
      "netease_music",
      "网易云音乐",
      true,
      "ready",
      "blocked_by_official_access",
      "网易云本地 API 可读取画像、创建歌单并提供网页播放地址。",
      "网易云本地 API 暂不可用。",
      checkedAt,
    ),
  ];
}

async function importSibling(name: "core" | "providers"): Promise<UnknownRecord> {
  let lastError: unknown;
  const base = `../${name}/index`;
  for (const extension of [".js", ".ts"]) {
    try {
      return (await import(`${base}${extension}`)) as unknown as UnknownRecord;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Unable to load ${name}`);
}

async function loadEngine(): Promise<EngineLike> {
  const module = await importSibling("core");
  const factory = module.createProgramEngine ?? (isRecord(module.default) ? module.default.createProgramEngine : undefined);
  if (typeof factory !== "function") throw new ServiceError("ENGINE_UNAVAILABLE", 503, publicMessage("INTERNAL_ERROR"));
  const engine = await Promise.resolve(factory());
  if (!isRecord(engine)) throw new ServiceError("ENGINE_UNAVAILABLE", 503, publicMessage("INTERNAL_ERROR"));
  return engine as unknown as EngineLike;
}

async function loadProviders(): Promise<{ host?: HostProviderLike; tts?: TtsProviderLike; netease?: NeteaseProviderLike; qq?: QqProviderLike }> {
  const module = await importSibling("providers");
  const hostFactory = module.createHostProvider ?? (isRecord(module.default) ? module.default.createHostProvider : undefined);
  const ttsFactory = module.createTtsProvider ?? (isRecord(module.default) ? module.default.createTtsProvider : undefined);
  const neteaseFactory = module.createNeteaseProvider ?? (isRecord(module.default) ? module.default.createNeteaseProvider : undefined);
  const qqFactory = module.createQqProvider ?? (isRecord(module.default) ? module.default.createQqProvider : undefined);
  const host = typeof hostFactory === "function" ? await Promise.resolve(hostFactory(process.env)) : undefined;
  const tts = typeof ttsFactory === "function" ? await Promise.resolve(ttsFactory(process.env)) : undefined;
  const netease = typeof neteaseFactory === "function" ? await Promise.resolve(neteaseFactory(process.env)) : undefined;
  const qq = typeof qqFactory === "function" ? await Promise.resolve(qqFactory(process.env)) : undefined;
  return {
    host: isRecord(host) ? (host as unknown as HostProviderLike) : undefined,
    tts: isRecord(tts) ? (tts as unknown as TtsProviderLike) : undefined,
    netease: isRecord(netease) ? (netease as unknown as NeteaseProviderLike) : undefined,
    qq: isRecord(qq) ? (qq as unknown as QqProviderLike) : undefined,
  };
}

function operationIdFromBody(body: UnknownRecord, required: boolean): string | null {
  const value = body.operationId;
  if (value === undefined || value === null || value === "") {
    if (required) throw new ServiceError("OPERATION_REQUIRED", 400, publicMessage("OPERATION_REQUIRED"));
    return null;
  }
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_OPERATION_ID_LENGTH) {
    throw new ServiceError("INVALID_INPUT", 400, publicMessage("INVALID_INPUT"));
  }
  return value.trim();
}

function generationFromBody(body: UnknownRecord, required: boolean): number | null {
  const value = body.generation;
  if (value === undefined || value === null) {
    if (required) throw new ServiceError("INVALID_INPUT", 400, "generation is required");
    return null;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ServiceError("INVALID_INPUT", 400, "generation is invalid");
  }
  return value as number;
}

function validateProgramSpec(value: unknown): ProgramSpec {
  if (!isRecord(value)) throw new ServiceError("INVALID_INPUT", 400, publicMessage("INVALID_INPUT"));
  const sourceId = value.sourceId;
  const scenePreset = value.scenePreset;
  if (!SOURCE_IDS.includes(sourceId as (typeof SOURCE_IDS)[number])) {
    throw new ServiceError("INVALID_INPUT", 400, "sourceId is invalid");
  }
  if (!SCENE_PRESETS.includes(scenePreset as (typeof SCENE_PRESETS)[number])) {
    throw new ServiceError("INVALID_INPUT", 400, "scenePreset is invalid");
  }
  if (!Number.isInteger(value.durationMinutes) || (value.durationMinutes as number) < 30 || (value.durationMinutes as number) > 120) {
    throw new ServiceError("INVALID_INPUT", 400, "durationMinutes must be between 30 and 120");
  }
  const rawRecommendationMode = value.recommendationMode;
  if (rawRecommendationMode !== undefined && rawRecommendationMode !== "atmosphere" && rawRecommendationMode !== "genre") {
    throw new ServiceError("INVALID_INPUT", 400, "recommendationMode is invalid");
  }
  if (typeof value.sceneDescription !== "string" || value.sceneDescription.length > 500) {
    throw new ServiceError("INVALID_INPUT", 400, "sceneDescription must be a string up to 500 characters");
  }
  const sceneDescription = value.sceneDescription.trim();
  const hostDensity = value.hostDensity;
  if (hostDensity !== "low" && hostDensity !== "medium" && hostDensity !== "high") {
    throw new ServiceError("INVALID_INPUT", 400, "hostDensity is invalid");
  }
  const energyCurve = nonEmptyString(value.energyCurve, "energyCurve", 200);
  if (!Array.isArray(value.avoid) || value.avoid.length > 50 || value.avoid.some((item) => typeof item !== "string" || item.length > 120)) {
    throw new ServiceError("INVALID_INPUT", 400, "avoid must be an array of short strings");
  }
  for (const field of ["familiarityRatio"] as const) {
    if (value[field] !== undefined && (!Number.isFinite(value[field]) || (value[field] as number) < 0 || (value[field] as number) > 100)) {
      throw new ServiceError("INVALID_INPUT", 400, `${field} must be between 0 and 100`);
    }
  }
  const hostProfile = value.hostProfile ?? DEFAULT_HOST_PROFILE;
  if (!HOST_PROFILE_IDS.includes(hostProfile as HostProfileId)) {
    throw new ServiceError("INVALID_INPUT", 400, "hostProfile is invalid");
  }
  const musicGenres = value.musicGenres ?? [];
  if (!Array.isArray(musicGenres) || musicGenres.some((item) => !MUSIC_GENRE_IDS.includes(item as MusicGenreId))) {
    throw new ServiceError("INVALID_INPUT", 400, "musicGenres contains an invalid music style");
  }
  const uniqueMusicGenres = [...new Set(musicGenres as MusicGenreId[])];
  if (uniqueMusicGenres.length > MAX_MUSIC_GENRES) {
    throw new ServiceError("INVALID_INPUT", 400, `音乐风格最多选择 ${MAX_MUSIC_GENRES} 种。`);
  }
  const recommendationMode = rawRecommendationMode === "atmosphere" || rawRecommendationMode === "genre"
    ? rawRecommendationMode
    : uniqueMusicGenres.length > 0 ? "genre" : "atmosphere";
  if (recommendationMode === "genre" && uniqueMusicGenres.length === 0) {
    throw new ServiceError("INVALID_INPUT", 400, "按风格推荐时至少选择一种音乐风格。");
  }
  if (value.desktopPetEnabled !== undefined && typeof value.desktopPetEnabled !== "boolean") {
    throw new ServiceError("INVALID_INPUT", 400, "desktopPetEnabled must be a boolean");
  }
  return {
    sourceId: sourceId as ProgramSpec["sourceId"],
    durationMinutes: value.durationMinutes as number,
    recommendationMode,
    scenePreset: scenePreset as ProgramSpec["scenePreset"],
    sceneDescription,
    hostDensity,
    energyCurve,
    avoid: (value.avoid as string[]).map((item) => item.trim()),
    familiarityRatio: Math.round((value.familiarityRatio as number | undefined) ?? 40),
    hostProfile: hostProfile as HostProfileId,
    musicGenres: recommendationMode === "genre" ? uniqueMusicGenres : [],
    desktopPetEnabled: value.desktopPetEnabled ?? false,
  };
}

function personalizationTermsFromPreferences(value: unknown): string[] {
  if (!isRecord(value)) return [];
  const terms: string[] = [];
  const artists = Array.isArray(value.favoriteArtists) ? value.favoriteArtists : [];
  for (const item of artists.slice(0, 4)) {
    if (isRecord(item) && typeof item.name === "string") terms.push(item.name);
  }
  const profile = isRecord(value.profile) ? value.profile : null;
  const topSongs = profile && Array.isArray(profile.topSongs) ? profile.topSongs : [];
  const planned = Array.isArray(value.programPlan) ? value.programPlan : [];
  for (const item of planned.slice(0, 4)) {
    if (!isRecord(item)) continue;
    if (typeof item.title === "string") terms.push(item.title);
    if (Array.isArray(item.artists) && typeof item.artists[0] === "string") terms.push(item.artists[0]);
  }
  for (const item of topSongs.slice(0, 2)) {
    if (!isRecord(item)) continue;
    if (typeof item.title === "string") terms.push(item.title);
    if (Array.isArray(item.artists) && typeof item.artists[0] === "string") terms.push(item.artists[0]);
  }
  return [...new Set(terms)].slice(0, 8);
}

function rankCandidatesByEra<T extends { score: number; candidate: object }>(entries: readonly T[], preference: number): T[] {
  const strength = Math.abs(preference - 50) / 50;
  if (strength === 0) return [...entries];
  const direction = preference > 50 ? 1 : -1;
  const currentYear = new Date().getUTCFullYear();
  const adjusted = entries.map((entry, index) => {
    const year = "releaseYear" in entry.candidate && typeof entry.candidate.releaseYear === "number" ? entry.candidate.releaseYear : null;
    const normalized = year && year >= 1950 && year <= currentYear ? (year - 1950) / Math.max(1, currentYear - 1950) : 0.5;
    return { entry, index, adjustedScore: entry.score + direction * (normalized - 0.5) * 24 * strength };
  });
  return adjusted.sort((left, right) => right.adjustedScore - left.adjustedScore || left.index - right.index).map(({ entry }) => entry);
}

function validateProgramId(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new ServiceError("INVALID_INPUT", 400, publicMessage("INVALID_INPUT"));
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(decoded)) {
    throw new ServiceError("INVALID_INPUT", 400, publicMessage("INVALID_INPUT"));
  }
  return decoded;
}

function validateContext(value: unknown): HostContextPack {
  if (!isRecord(value)) throw new ServiceError("HOST_CONTEXT_REQUIRED", 400, publicMessage("HOST_CONTEXT_REQUIRED"));
  const scenePreset = value.scenePreset;
  if (!SCENE_PRESETS.includes(scenePreset as (typeof SCENE_PRESETS)[number])) {
    throw new ServiceError("INVALID_INPUT", 400, "scenePreset is invalid");
  }
  const allowedFacts = Array.isArray(value.allowedFacts)
    ? value.allowedFacts.filter((fact): fact is { id: string; value: string; source: "user" | "web"; sourceUrl?: string } => (
      isRecord(fact)
      && (fact.source === "user" || fact.source === "web")
      && typeof fact.id === "string"
      && (fact.id === "program:scene" || fact.id === "program:scene-description" || /^track:[A-Za-z0-9_-]+:(?:metadata|reasons)$/.test(fact.id) || (fact.source === "web" && /^web:[A-Za-z0-9_-]+$/.test(fact.id)))
      && typeof fact.value === "string"
      && fact.value.length <= 500
      && (fact.sourceUrl === undefined || (typeof fact.sourceUrl === "string" && /^https:\/\//.test(fact.sourceUrl)))
    ))
    : [];
  return {
    ...(value as unknown as HostContextPack),
    previousTrack: null,
    currentTrack: null,
    nextTrack: null,
    allowedFacts,
    forbiddenClaims: ["用户的位置、行为、情绪、记忆、健康和私人情况", "未经验证的歌曲、歌手和音乐历史事实"],
  };
}

async function readJsonBody(req: IncomingMessage): Promise<UnknownRecord> {
  const contentType = req.headers["content-type"];
  if (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("application/json")) {
    throw new ServiceError("UNSUPPORTED_MEDIA_TYPE", 415, publicMessage("UNSUPPORTED_MEDIA_TYPE"));
  }
  const contentLength = req.headers["content-length"];
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)) {
    throw new ServiceError("BODY_TOO_LARGE", 413, publicMessage("BODY_TOO_LARGE"));
  }
  const chunks: Buffer[] = [];
  let size = 0;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false;
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };
    req.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BODY_BYTES) {
        req.resume();
        rejectOnce(new ServiceError("BODY_TOO_LARGE", 413, publicMessage("BODY_TOO_LARGE")));
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolvePromise();
    });
    req.on("aborted", () => rejectOnce(new ServiceError("INVALID_INPUT", 400, "Request was aborted")));
    req.on("error", () => rejectOnce(new ServiceError("INVALID_INPUT", 400, "Request body could not be read")));
  });
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text.length === 0) throw new ServiceError("BODY_REQUIRED", 400, publicMessage("BODY_REQUIRED"));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ServiceError("INVALID_JSON", 400, publicMessage("INVALID_JSON"));
  }
  if (!isRecord(parsed)) throw new ServiceError("INVALID_JSON", 400, publicMessage("INVALID_JSON"));
  return parsed;
}

function toBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") {
    if (value.startsWith("data:")) {
      const comma = value.indexOf(",");
      if (comma >= 0) return Buffer.from(value.slice(comma + 1), "base64");
    }
    if (/^[A-Za-z0-9+/=\s]+$/.test(value) && value.length >= 16) return Buffer.from(value, "base64");
  }
  return null;
}

function fixtureAudioFor(trackId: string): Buffer {
  const sampleRate = 22_050;
  const seconds = 12;
  const samples = sampleRate * seconds;
  const dataSize = samples * 2;
  const output = Buffer.allocUnsafe(44 + dataSize);
  let hash = 0;
  for (let index = 0; index < trackId.length; index += 1) hash = (hash * 31 + trackId.charCodeAt(index)) >>> 0;
  const baseFrequency = 180 + (hash % 180);
  output.write("RIFF", 0, "ascii");
  output.writeUInt32LE(36 + dataSize, 4);
  output.write("WAVE", 8, "ascii");
  output.write("fmt ", 12, "ascii");
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write("data", 36, "ascii");
  output.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < samples; index += 1) {
    const time = index / sampleRate;
    const beat = Math.max(0, 1 - ((index % Math.floor(sampleRate * 0.5)) / (sampleRate * 0.08)));
    const tone = Math.sin(2 * Math.PI * baseFrequency * time) * 0.065;
    const harmony = Math.sin(2 * Math.PI * (baseFrequency * 1.5) * time) * 0.025;
    const envelope = Math.min(1, time * 8, (seconds - time) * 8);
    const value = Math.max(-1, Math.min(1, (tone + harmony + beat * 0.025) * envelope));
    output.writeInt16LE(Math.round(value * 32_000), 44 + index * 2);
  }
  return output;
}

function contentTypeFrom(value: unknown): string {
  if (typeof value !== "string") return "audio/mpeg";
  const normalized = value.toLowerCase().trim();
  return /^audio\/[a-z0-9.+-]+$/.test(normalized) ? normalized : "audio/mpeg";
}

function isAllowedNeteaseAudioUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return false;
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return hostname === "music.126.net"
      || hostname.endsWith(".music.126.net")
      || hostname === "music.163.com"
      || hostname.endsWith(".music.163.com")
      || hostname === "vod.126.net"
      || hostname.endsWith(".vod.126.net");
  } catch {
    return false;
  }
}

function isAllowedQqAudioUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.port || url.username || url.password) return false;
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    // QQ playback URLs vary by CDN region. Keep this allowlist intentionally
    // narrow and do not proxy arbitrary provider-supplied destinations.
    return hostname === "qq.com"
      || hostname.endsWith(".qq.com")
      || hostname === "gtimg.cn"
      || hostname.endsWith(".gtimg.cn")
      || hostname === "y.qq.com"
      || hostname.endsWith(".music.qq.com")
      || hostname.endsWith(".qqmusic.qq.com");
  } catch {
    return false;
  }
}

function programForResponse(
  state: ProgramState | null,
  selection?: DesktopProgramResult,
  rundown?: { items: ProgramRundownItem[]; index: number; revision?: number },
  playlist?: ProgramPlaylistReceipt,
): ProgramState | null {
  if (!state) return null;
  const addAudioUrl = <T extends ProgramState["currentTrack"]>(track: T): T => {
    if (!track || (state.spec.sourceId !== "fixture") || track.audioUrl) return track;
    return { ...track, audioUrl: `/api/fixtures/${encodeURIComponent(track.id)}.wav` } as T;
  };
  const desktopTrack = <T extends ProgramState["currentTrack"]>(track: T, role: "current" | "next" | "queue"): T => {
    if (!track || !selection || state.spec.sourceId === "fixture") return track;
    const provider = state.spec.sourceId === "qq_music" ? "QQ 音乐" : "网易云音乐";
    const title = role === "current" ? `场景歌单：${selection.query}` : role === "next" ? "下一首由客户端队列决定" : "后续曲目由客户端队列决定";
    return {
      ...track,
      title,
      artist: `${provider} · 桌面播放队列`,
      mood: [state.spec.scenePreset],
      audioUrl: undefined,
    } as T;
  };
  const desktopPlaceholder = (role: "current" | "next"): NonNullable<ProgramState["currentTrack"]> | null => {
    if (!selection || state.spec.sourceId !== "qq_music" || !["preparing", "on_air", "closing"].includes(state.status)) return null;
    return {
      id: `desktop-${role}-${state.generation}`,
      title: role === "current" ? `场景歌单：${selection.query}` : "下一首由客户端队列决定",
      artist: "QQ 音乐 · 桌面播放队列",
      durationSeconds: 0,
      energy: 0.5,
      mood: [state.spec.scenePreset],
      color: "#456b57",
    };
  };
  if (rundown && rundown.items.length > 0) {
    const likedTracks = rundown.items.filter((track) => track.liked === true).length;
    const heardTracks = rundown.items.filter((track) => track.liked === true).length;
    const planSummary = {
      totalTracks: rundown.items.length,
      likedTracks,
      heardTracks,
      familiarTracks: likedTracks,
      unheardTracks: Math.max(0, rundown.items.length - heardTracks),
      targetFamiliarityRatio: state.spec.familiarityRatio ?? 40,
      actualFamiliarityRatio: Math.round((heardTracks / rundown.items.length) * 100),
    };
    const index = Math.max(0, Math.min(rundown.index, rundown.items.length - 1));
    if (!["preparing", "on_air", "closing"].includes(state.status)) {
      return { ...state, rundown: rundown.items, rundownIndex: index, planRevision: rundown.revision ?? 0, planSummary, ...(playlist ? { playlist } : {}) };
    }
    const audioTrack = (track: ProgramRundownItem | undefined): ProgramRundownItem | null => track ? {
      ...track,
      audioUrl: `/api/${state.spec.sourceId === "qq_music" ? "qq" : "netease"}/audio/${encodeURIComponent(state.id)}/${state.generation}/${encodeURIComponent(track.id)}`,
    } : null;
    const current = audioTrack(rundown.items[index]);
    const next = audioTrack(rundown.items[index + 1]);
    return {
      ...state,
      currentTrack: current,
      nextTrack: next,
      queue: rundown.items.slice(index + 2).map((track) => audioTrack(track)!),
      rundown: rundown.items,
      rundownIndex: index,
      planRevision: rundown.revision ?? 0,
      planSummary,
      ...(playlist ? { playlist } : {}),
    };
  }
  return {
    ...state,
    currentTrack: desktopTrack(addAudioUrl(state.currentTrack), "current") ?? desktopPlaceholder("current"),
    nextTrack: desktopTrack(addAudioUrl(state.nextTrack), "next") ?? desktopPlaceholder("next"),
    queue: state.queue.map((track) => desktopTrack(addAudioUrl(track), "queue") as NonNullable<ProgramState["currentTrack"]>),
  };
}

function providerMetadata(provider: HostProviderLike | TtsProviderLike | undefined): UnknownRecord {
  if (!provider || typeof provider.getStatus !== "function") return {};
  try {
    const status = provider.getStatus();
    if (!isRecord(status)) return {};
    return {
      ...(typeof status.provider === "string" ? { provider: status.provider.slice(0, 64) } : {}),
      ...(typeof status.model === "string" ? { model: status.model.slice(0, 128) } : {}),
      ...(typeof status.voice === "string" ? { voice: status.voice.slice(0, 64) } : {}),
    };
  } catch {
    return {};
  }
}

function audioContentType(record: UnknownRecord, bytes: Buffer): string {
  const explicit = record.contentType ?? record.mimeType;
  if (typeof explicit === "string") return contentTypeFrom(explicit);
  return bytes.subarray(0, 4).toString("ascii") === "RIFF" ? "audio/wav" : "audio/mpeg";
}

function hasSupportedAudioSignature(bytes: Buffer): boolean {
  if (bytes.length < 12) return false;
  const ascii4 = bytes.subarray(0, 4).toString("ascii");
  if (ascii4 === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WAVE") return true;
  if (ascii4 === "OggS" || ascii4 === "fLaC") return true;
  if (bytes.subarray(0, 3).toString("ascii") === "ID3") return true;
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return true;
  return bytes.subarray(4, 8).toString("ascii") === "ftyp";
}

function providerConfigured(provider: UnknownRecord | undefined, keys: string[]): boolean {
  if (provider && typeof provider.configured === "boolean") return provider.configured;
  return envHas(...keys);
}

function providerState(provider: UnknownRecord | undefined, configured: boolean, fallback: string): string {
  const state = provider?.state;
  return typeof state === "string" && state.length <= 64 ? state : configured ? "ready" : fallback;
}

const SENSITIVE_RESPONSE_KEY = /^(?:cookie|cookies|set[_-]?cookie|authorization|proxy[_-]?authorization|auth|token|access[_-]?token|refresh[_-]?token|credential|credentials|secret|_+csrf|csrf|xsrf|music[_-]?u)$/i;
const SENSITIVE_RESPONSE_VALUE = /(\b(?:MUSIC_[A-Z_]+|__csrf)\s*[=:]\s*)[^;\s,}\]]+|(\b(?:Bearer|Basic)\s+)[A-Za-z0-9._~+\/-]+=*/gi;

function publicProviderValue(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (typeof value === "string") return value.replace(SENSITIVE_RESPONSE_VALUE, (_match, secretPrefix, authPrefix) => `${secretPrefix ?? authPrefix ?? ""}[redacted]`);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 12 || typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => publicProviderValue(item, seen, depth + 1));
  const output: UnknownRecord = {};
  for (const [key, item] of Object.entries(value).slice(0, 200)) {
    if (SENSITIVE_RESPONSE_KEY.test(key)) continue;
    output[key] = publicProviderValue(item, seen, depth + 1);
  }
  return output;
}

function neteaseId(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new ServiceError("INVALID_INPUT", 400, publicMessage("INVALID_INPUT"));
  }
  if (!/^\d{1,32}$/.test(decoded)) throw new ServiceError("INVALID_INPUT", 400, "id must contain digits only");
  return decoded;
}

function neteaseQrKey(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new ServiceError("INVALID_INPUT", 400, publicMessage("INVALID_INPUT"));
  }
  if (!/^[A-Za-z0-9_.=~-]{1,512}$/.test(decoded)) throw new ServiceError("INVALID_INPUT", 400, "QR login key is invalid");
  return decoded;
}

function qqId(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new ServiceError("INVALID_INPUT", 400, publicMessage("INVALID_INPUT"));
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(decoded)) throw new ServiceError("INVALID_INPUT", 400, "QQ Music id is invalid");
  return decoded;
}

function qqQrKey(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new ServiceError("INVALID_INPUT", 400, publicMessage("INVALID_INPUT"));
  }
  if (!/^[A-Za-z0-9_.=~-]{1,512}$/.test(decoded)) throw new ServiceError("INVALID_INPUT", 400, "QQ QR login key is invalid");
  return decoded;
}

function qqLoginType(value: unknown): "wx" | "qq" | "mobile" {
  if (value === "wx" || value === "qq" || value === "mobile") return value;
  return "mobile";
}

function pruneAudio(audio: Map<string, AudioEntry>): void {
  const current = Date.now();
  for (const [id, entry] of audio) {
    if (entry.expiresAt <= current) audio.delete(id);
  }
  while (audio.size > 32) {
    const first = audio.keys().next().value;
    if (typeof first === "string") audio.delete(first);
    else break;
  }
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(body);
}

function writeError(res: ServerResponse, error: ServiceError): void {
  writeJson(res, error.status, { error: error.message, code: error.code });
}

function asRequestPath(req: IncomingMessage): URL {
  try {
    return new URL(req.url ?? "/", "http://127.0.0.1");
  } catch {
    throw new ServiceError("INVALID_INPUT", 400, publicMessage("INVALID_INPUT"));
  }
}

function operationKey(programId: string, operationId: string): string {
  return `${programId}:${operationId}`;
}

export async function createLocalService(options: LocalServiceOptions = {}): Promise<LocalService> {
  const lockedTtsTimeoutMs = Number.isInteger(options.lockedTtsTimeoutMs) && (options.lockedTtsTimeoutMs ?? 0) >= 10
    ? options.lockedTtsTimeoutMs!
    : LOCKED_TTS_TIMEOUT_MS;
  const host = options.host ?? DEFAULT_HOST;
  if (host !== DEFAULT_HOST) throw new ServiceError("INVALID_INPUT", 400, "Local service must bind to 127.0.0.1");
  const configuredPort = options.port ?? Number(process.env.PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(configuredPort) || configuredPort < 0 || configuredPort > 65535) {
    throw new ServiceError("INVALID_INPUT", 400, "PORT is invalid");
  }

  const engine = options.engine ?? (await loadEngine());
  const loadedProviders: { host?: HostProviderLike; tts?: TtsProviderLike; netease?: NeteaseProviderLike; qq?: QqProviderLike } = await loadProviders().catch(() => ({}));
  const cloudAccessStore = options.cloudAccessStore ?? new CloudAccessStore();
  const aiConfigStore = options.aiConfigStore
    ?? (process.env.ONE_RADIO_AI_MODE === "local" ? new LocalAiConfigStore() : new ManagedAiConfigStore(cloudAccessStore));
  const hostProvider = options.hostProvider ?? new LocalConfiguredHostProvider(aiConfigStore);
  const ttsProvider = options.ttsProvider ?? new LocalConfiguredTtsProvider(aiConfigStore);
  const neteaseProvider = options.neteaseProvider ?? loadedProviders.netease;
  const qqProvider = options.qqProvider ?? loadedProviders.qq;
  // A QQ provider opts the source into the account/API flow. Keeping the
  // legacy desktop fallback when no adapter is installed preserves local
  // fixture compatibility without making desktop control a requirement for
  // an API-backed QQ program.
  // Production QQ programs are API-only. The desktop branch remains reachable
  // solely for legacy tests that explicitly inject both desktop controllers.
  const qqDesktopCompatibilityMode = process.env.NODE_ENV !== "production"
    && options.qqProvider === undefined
    && options.desktopPlayerController !== undefined
    && options.desktopProgramController !== undefined;
  const qqApiEnabled = !qqDesktopCompatibilityMode;
  const radioHostSkill = loadRadioHostSkill();
  const radioHostReviewSkill = loadRadioHostReviewSkill();
  const desktopPlayerController = options.desktopPlayerController ?? new DesktopPlayerController();
  const desktopProgramController = options.desktopProgramController ?? new DesktopProgramController(desktopPlayerController);
  const desktopPetController = options.desktopPetController ?? new DesktopPetController();
  const localControlToken = options.localControlToken
    ?? process.env.LOCAL_CONTROL_TOKEN
    ?? randomBytes(32).toString("hex");
  const startedAt = Date.now();
  const version = options.version ?? process.env.APP_VERSION ?? "0.1.0";
  const operationResults = new Map<string, { action: "confirm" | "next" | "stop"; generation?: number; state: ProgramState }>();
  type PlanOperationAction = "reorder" | "regenerate" | "adjust" | "replace" | "regenerate-host";
  type CreateProgressStatus = "running" | "completed" | "failed" | "action_required";
  const planOperationResults = new Map<string, { action: PlanOperationAction; baseRevision: number; revision: number }>();
  const createResults = new Map<string, { spec: ProgramSpec; state: ProgramState }>();
  const createProgress = new Map<string, { completedSteps: number; status: CreateProgressStatus; updatedAt: string }>();
  const desktopSelections = new Map<string, DesktopProgramResult>();
  const accountRundowns = new Map<string, AccountRundown>();
  const accountPlaylists = new Map<string, ProgramPlaylistReceipt>();
  const accountPlaylistNames = new Map<string, string>();
  const accountPlaylistKeepRequests = new Set<string>();
  const uncertainAccountPlaylistCreates = new Set<string>();
  const qqQrLoginTypes = new Map<string, "wx" | "qq" | "mobile">();
  // Keep the existing NetEase-oriented helpers source-compatible while the
  // account-backed QQ path uses the same rundown/playlist state machines.
  const neteaseRundowns = accountRundowns;
  const neteasePlaylists = accountPlaylists;
  const neteasePlaylistNames = accountPlaylistNames;
  const neteasePlaylistKeepRequests = accountPlaylistKeepRequests;
  const uncertainNeteasePlaylistCreates = uncertainAccountPlaylistCreates;
  const pendingLockedHostPreviews = new Map<string, { promise: Promise<UnknownRecord>; controller: AbortController; waiters: number }>();
  const lockedHostPreviewResults = new Map<string, { result: UnknownRecord; expiresAt: number }>();
  const activeNeteaseAudioStreams = new Set<string>();
  const activeQqAudioStreams = new Set<string>();
  const terminalDesktopStops = new Set<string>();
  const pendingTerminalStops = new Map<string, { state: ProgramState; attempts: number }>();
  const programDeadlineTimers = new Map<string, NodeJS.Timeout>();
  const programActionChains = new Map<string, Promise<void>>();
  let createActionChain: Promise<void> = Promise.resolve();
  const audio = new Map<string, AudioEntry>();
  const diagnosticEvents: Array<{ at: string; method: string; path: string; status: number; code?: string }> = [];
  let tickTimer: NodeJS.Timeout | undefined;
  let tickInFlight = false;
  let actualPort = configuredPort;
  let started = false;

  const rememberDiagnosticEvent = (event: { at: string; method: string; path: string; status: number; code?: string }): void => {
    diagnosticEvents.push(event);
    if (diagnosticEvents.length > 100) diagnosticEvents.splice(0, diagnosticEvents.length - 100);
  };

  const audioStorageStats = (): { entries: number; bytes: number } => {
    pruneAudio(audio);
    let entries = audio.size;
    let bytes = [...audio.values()].reduce((total, item) => total + item.data.length, 0);
    for (const rundown of accountRundowns.values()) {
      entries += rundown.hostAudio.size;
      bytes += [...rundown.hostAudio.values()].reduce((total, item) => total + item.data.length, 0);
    }
    return { entries, bytes };
  };

  const assertMaintenanceAllowed = (): void => {
    const state = stateNow();
    if (state && ACTIVE_STATUSES.has(state.status)) throw new ServiceError("PROGRAM_ACTIVE", 409, "节目进行中，不能删除本机运行数据或授权。");
  };

  const clearAudioStorage = (): number => {
    const removed = audioStorageStats().entries;
    audio.clear();
    for (const rundown of accountRundowns.values()) rundown.hostAudio.clear();
    lockedHostPreviewResults.clear();
    for (const pending of pendingLockedHostPreviews.values()) pending.controller.abort();
    pendingLockedHostPreviews.clear();
    return removed;
  };

  const clearAllLocalAccountData = async (): Promise<{ removedProfiles: number; removedAudioEntries: number }> => {
    const current = stateNow();
    if (current && ["preparing", "on_air", "closing"].includes(current.status)) {
      throw new ServiceError("PROGRAM_ACTIVE", 409, "节目正在播出，结束节目后才能清除全部本机数据。");
    }
    const logout = async (provider: NeteaseProviderLike | QqProviderLike | undefined, label: string) => {
      if (!provider || typeof provider.logout !== "function") return;
      try {
        await Promise.resolve(provider.logout());
      } catch {
        throw new ServiceError("ACCOUNT_RESET_FAILED", 503, `${label}本机授权清除失败，请确认本地连接器运行后重试。`);
      }
    };
    await logout(qqProvider, "QQ 音乐");
    await logout(neteaseProvider, "网易云音乐");
    if (current) await cleanupTemporaryAccountPlaylist(current).catch(() => undefined);
    await aiConfigStore.reset();
    await cloudAccessStore.disconnect();
    const removedProfiles = await clearListeningProfiles();
    const removedAudioEntries = clearAudioStorage();
    await clearDesktopPetPreferences();
    desktopPetController.hide?.();
    for (const timer of programDeadlineTimers.values()) clearTimeout(timer);
    for (const pending of pendingLockedHostPreviews.values()) pending.controller.abort();
    operationResults.clear();
    planOperationResults.clear();
    createResults.clear();
    createProgress.clear();
    desktopSelections.clear();
    accountRundowns.clear();
    accountPlaylists.clear();
    accountPlaylistNames.clear();
    accountPlaylistKeepRequests.clear();
    uncertainAccountPlaylistCreates.clear();
    qqQrLoginTypes.clear();
    pendingLockedHostPreviews.clear();
    lockedHostPreviewResults.clear();
    activeNeteaseAudioStreams.clear();
    activeQqAudioStreams.clear();
    terminalDesktopStops.clear();
    pendingTerminalStops.clear();
    programDeadlineTimers.clear();
    programActionChains.clear();
    desktopPetClientRevisions.clear();
    diagnosticEvents.splice(0);
    engine.reset?.();
    return { removedProfiles, removedAudioEntries };
  };

  const readOperationResult = (key: string, action: "confirm" | "next" | "stop", generation?: number): ProgramState | null => {
    const previous = operationResults.get(key);
    if (!previous) return null;
    if (previous.action !== action || previous.generation !== generation) throw new ServiceError("OPERATION_REUSED", 409, publicMessage("OPERATION_REUSED"));
    return previous.state;
  };

  const rememberOperationResult = (key: string, action: "confirm" | "next" | "stop", state: ProgramState, generation?: number): void => {
    const previous = operationResults.get(key);
    if (previous && (previous.action !== action || previous.generation !== generation)) throw new ServiceError("OPERATION_REUSED", 409, publicMessage("OPERATION_REUSED"));
    operationResults.set(key, { action, generation, state });
    while (operationResults.size > 256) {
      const oldest = operationResults.keys().next().value;
      if (typeof oldest === "string") operationResults.delete(oldest);
      else break;
    }
  };

  const stateNow = (): ProgramState | null => {
    try {
      return asProgramState(engine.getState());
    } catch (error) {
      throw failFromUnknown(error);
    }
  };

  const invokeEngine = async (method: keyof EngineLike, args: unknown[]): Promise<ProgramState | null> => {
    const fn = engine[method];
    if (typeof fn !== "function") throw new ServiceError("ENGINE_UNAVAILABLE", 503, publicMessage("INTERNAL_ERROR"));
    try {
      const value = await Promise.resolve((fn as (...parameters: unknown[]) => unknown).apply(engine, args));
      const result = asProgramState(value);
      return result ?? stateNow();
    } catch (error) {
      throw failFromUnknown(error);
    }
  };

  const assertProgram = (id: string): ProgramState => {
    const state = stateNow();
    if (!state || state.id !== id) throw new ServiceError("PROGRAM_NOT_FOUND", 404, publicMessage("PROGRAM_NOT_FOUND"));
    return state;
  };

  const assertGeneration = (state: ProgramState, generation: number | null): void => {
    if (generation !== null && state.generation !== generation) {
      throw new ServiceError("GENERATION_MISMATCH", 409, publicMessage("GENERATION_MISMATCH"));
    }
  };

  const serializeProgramAction = async <T>(programId: string, action: () => Promise<T>): Promise<T> => {
    const previous = programActionChains.get(programId) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(action);
    const tail = pending.then(() => undefined, () => undefined);
    programActionChains.set(programId, tail);
    try {
      return await pending;
    } finally {
      if (programActionChains.get(programId) === tail) programActionChains.delete(programId);
    }
  };

  const serializeCreateAction = async <T>(action: () => Promise<T>): Promise<T> => {
    const pending = createActionChain.catch(() => undefined).then(action);
    createActionChain = pending.then(() => undefined, () => undefined);
    return pending;
  };

  const responseProgram = (state: ProgramState | null): ProgramState | null => {
    const rundown = state ? accountRundowns.get(state.id) : undefined;
    const response = programForResponse(
    state,
    state ? desktopSelections.get(state.id) : undefined,
    rundown,
    state ? accountPlaylists.get(state.id) : undefined,
    );
    if (!response) return response;
    const plannedPlaylistName = accountPlaylistNames.get(response.id);
    return {
      ...response,
      ...(rundown?.listenerProfile ? { listenerProfile: rundown.listenerProfile } : {}),
      ...(plannedPlaylistName ? { plannedPlaylistName } : {}),
    };
  };

  let desktopPetRevision = 0;
  const desktopPetClientRevisions = new Map<string, { clientId: string; startedAt: number; revision: number; mood: DesktopPetMood; lastSeenAt: number; ownsPlayback: boolean }>();
  const updateDesktopPet = (state: ProgramState, mood?: DesktopPetMood, message?: string): void => {
    try {
      const canonical = stateNow();
      if (!canonical || canonical.id !== state.id || canonical.generation !== state.generation) return;
      if (canonical.spec.desktopPetEnabled !== true) {
        desktopPetController.hide?.();
        return;
      }
      const publicState = responseProgram(canonical) ?? canonical;
      let resolvedMessage = message;
      let speechDurationSeconds: number | undefined;
      if (mood === "speaking" && resolvedMessage === undefined) {
        const rundown = accountRundowns.get(canonical.id);
        const hostScript = rundown?.items[rundown.index]?.hostScript
          ?? publicState.rundown?.find((item) => item.id === publicState.currentTrack?.id)?.hostScript;
        resolvedMessage = hostScript?.text ?? publicState.host?.text ?? "";
        speechDurationSeconds = hostScript?.plannedDurationSeconds ?? publicState.host?.plannedDurationSeconds;
      }
      desktopPetRevision += 1;
      desktopPetController.update(desktopPetStateForProgram(publicState, mood, resolvedMessage, desktopPetRevision, speechDurationSeconds));
    } catch {
      // The radio remains usable when the optional desktop companion cannot launch.
    }
  };

  const pauseDesktopProgram = async (state: ProgramState, operationId: string): Promise<boolean> => {
    if (state.spec.sourceId !== "qq_music" && state.spec.sourceId !== "netease_music") return true;
    if ((state.spec.sourceId === "netease_music" || state.spec.sourceId === "qq_music") && accountRundowns.has(state.id)) return true;
    try {
      const paused = await desktopPlayerController.pause(state.spec.sourceId, operationId);
      return paused.state === "paused" || paused.state === "connected_idle";
    } catch {
      return false;
    }
  };

  const prepareExclusiveDesktopPlayback = async (selectedSource: DesktopPlayerSource, operationId: string): Promise<void> => {
    for (const sourceId of DESKTOP_PLAYER_SOURCES) {
      let inspected;
      try {
        inspected = await desktopPlayerController.inspect(sourceId);
      } catch {
        throw new ServiceError("DESKTOP_PROGRAM_FAILED", 409, `无法检查${sourceId === "qq_music" ? "QQ 音乐" : "网易云音乐"}的播放状态。`);
      }
      if (inspected.state === "app_not_running" || inspected.state === "connected_idle" || inspected.state === "paused") continue;
      if (inspected.state === "ready" || inspected.state === "playing") {
        const paused = await desktopPlayerController.pause(sourceId, `prepare-${operationId}-${sourceId}`);
        if (paused.state === "paused" || paused.state === "connected_idle") continue;
      }
      const label = sourceId === "qq_music" ? "QQ 音乐" : "网易云音乐";
      const role = sourceId === selectedSource ? "所选" : "另一";
      throw new ServiceError("DESKTOP_PROGRAM_FAILED", 409, `${role}客户端 ${label} 尚不能安全切换到新节目：${inspected.detail}`);
    }
  };

  const attemptTerminalDesktopStop = async (state: ProgramState): Promise<void> => {
    if (terminalDesktopStops.has(state.id)) return;
    const current = stateNow();
    if (current && current.id !== state.id && ACTIVE_STATUSES.has(current.status) && current.spec.sourceId === state.spec.sourceId) {
      pendingTerminalStops.delete(state.id);
      terminalDesktopStops.add(state.id);
      return;
    }
    const pending = pendingTerminalStops.get(state.id) ?? { state, attempts: 0 };
    pending.attempts += 1;
    pendingTerminalStops.set(state.id, pending);
    const operationId = `terminal-${state.id}-${state.generation}-${pending.attempts}`;
    let stopped: boolean;
    if (state.spec.sourceId === "qq_music" && typeof desktopPlayerController.emergencyPause === "function") {
      try {
        const result = await desktopPlayerController.emergencyPause(state.spec.sourceId, operationId);
        stopped = result.state === "paused" || result.state === "connected_idle";
      } catch {
        stopped = false;
      }
    } else {
      stopped = await pauseDesktopProgram(state, operationId);
    }
    if (stopped) {
      terminalDesktopStops.add(state.id);
      pendingTerminalStops.delete(state.id);
    }
  };

  const releaseProgramHostAudio = (programId: string): void => {
    accountRundowns.get(programId)?.hostAudio.clear();
    for (const [key, cached] of lockedHostPreviewResults) {
      if (!key.startsWith(`${programId}:`)) continue;
      const cachedAudio = isRecord(cached.result.audio) ? cached.result.audio : {};
      if (typeof cachedAudio.audioId === "string") audio.delete(cachedAudio.audioId);
      lockedHostPreviewResults.delete(key);
    }
    for (const [key, pending] of pendingLockedHostPreviews) {
      if (!key.startsWith(`${programId}:`)) continue;
      pending.controller.abort();
      pendingLockedHostPreviews.delete(key);
    }
  };

  const stopDesktopForTerminal = async (before: ProgramState | null, after: ProgramState | null): Promise<void> => {
    if (!before || !after || before.id !== after.id || !ACTIVE_STATUSES.has(before.status) || !TERMINAL_STATUSES.has(after.status)) return;
    const deadlineTimer = programDeadlineTimers.get(after.id);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    programDeadlineTimers.delete(after.id);
    releaseProgramHostAudio(after.id);
    if (after.spec.sourceId !== "qq_music" && after.spec.sourceId !== "netease_music") return;
    await attemptTerminalDesktopStop(after);
    await cleanupTemporaryAccountPlaylist(after);
  };

  const scheduleProgramDeadline = (state: ProgramState): void => {
    const previous = programDeadlineTimers.get(state.id);
    if (previous) clearTimeout(previous);
    programDeadlineTimers.delete(state.id);
    if (!state.deadlineAt || !ACTIVE_STATUSES.has(state.status)) return;
    const deadlineMs = Date.parse(state.deadlineAt);
    if (!Number.isFinite(deadlineMs)) return;
    const timer = setTimeout(() => {
      programDeadlineTimers.delete(state.id);
      void (async () => {
        const before = stateNow();
        if (!before || before.id !== state.id || !ACTIVE_STATUSES.has(before.status)) return;
        const after = await invokeEngine("tick", [deadlineMs]);
        await stopDesktopForTerminal(before, after);
      })().catch(() => undefined);
    }, Math.max(0, deadlineMs - Date.now()));
    programDeadlineTimers.set(state.id, timer);
  };

  const requestOriginAllowed = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin;
    if (!origin) return true;
    const allowed = new Set(options.allowedOrigins ?? []);
    const webPort = Number(process.env.WEB_PORT ?? 5173);
    allowed.add(`http://127.0.0.1:${webPort}`);
    allowed.add(`http://localhost:${webPort}`);
    allowed.add(`http://127.0.0.1:${actualPort}`);
    allowed.add(`http://localhost:${actualPort}`);
    return allowed.has(origin);
  };

  const applyCors = (req: IncomingMessage, res: ServerResponse): void => {
    const origin = req.headers.origin;
    if (typeof origin === "string" && requestOriginAllowed(req)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }
  };

  const assertPlayerControlAuthorized = (req: IncomingMessage): void => {
    const provided = req.headers["x-one-radio-control-token"];
    if (provided !== localControlToken) {
      throw new ServiceError("UNAUTHORIZED", 401, "本机播放器控制请求未获授权。");
    }
  };

  const handleAudio = (res: ServerResponse, id: string): void => {
    pruneAudio(audio);
    const entry = audio.get(id);
    if (!entry) throw new ServiceError("AUDIO_NOT_FOUND", 404, publicMessage("AUDIO_NOT_FOUND"));
    res.statusCode = 200;
    res.setHeader("Content-Type", entry.contentType);
    res.setHeader("Cache-Control", "private, max-age=30");
    res.setHeader("Content-Length", entry.data.length);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(entry.data);
  };

  const handleAccountAudio = async (
    req: IncomingMessage,
    res: ServerResponse,
    providerId: "netease" | "qq",
    programId: string,
    generation: number,
    id: string,
  ): Promise<void> => {
    const state = assertProgram(programId);
    if (state.generation !== generation || !ACTIVE_STATUSES.has(state.status)) {
      throw new ServiceError("AUDIO_NOT_FOUND", 404, publicMessage("AUDIO_NOT_FOUND"));
    }
    const expectedSource = providerId === "qq" ? "qq_music" : "netease_music";
    if (state.spec.sourceId !== expectedSource) throw new ServiceError("AUDIO_NOT_FOUND", 404, publicMessage("AUDIO_NOT_FOUND"));
    const rundown = accountRundowns.get(programId);
    const currentItem = rundown?.items[rundown.index];
    const nextItem = rundown?.items[rundown.index + 1];
    const isCurrentTrack = currentItem?.id === id;
    const isSeamlessNextTrack = nextItem?.id === id && !nextItem.hostMoment;
    if (!rundown || (!isCurrentTrack && !isSeamlessNextTrack)) {
      throw new ServiceError("AUDIO_NOT_FOUND", 404, publicMessage("AUDIO_NOT_FOUND"));
    }
    const requestedItem = isCurrentTrack ? currentItem : nextItem;
    const provider = providerId === "qq" ? await requireQq() : await requireNetease();
    if (typeof provider.songUrl !== "function") throw new ServiceError(providerId === "qq" ? "QQ_UNAVAILABLE" : "NETEASE_UNAVAILABLE", 503, publicMessage(providerId === "qq" ? "QQ_UNAVAILABLE" : "NETEASE_UNAVAILABLE"));
    const streamKey = `${providerId}:${programId}:${generation}:${id}`;
    const activeStreams = providerId === "qq" ? activeQqAudioStreams : activeNeteaseAudioStreams;
    if (activeStreams.has(streamKey)) throw new ServiceError(providerId === "qq" ? "QQ_AUDIO_BUSY" : "NETEASE_AUDIO_BUSY", 429, publicMessage(providerId === "qq" ? "QQ_AUDIO_BUSY" : "NETEASE_AUDIO_BUSY"));
    activeStreams.add(streamKey);
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once("aborted", abort);
    res.once("close", abort);
    const programDeadlineMs = state.deadlineAt ? Date.parse(state.deadlineAt) : Date.now() + 20_000;
    let deadlineTimer = setTimeout(abort, 20_000);
    let idleTimer: NodeJS.Timeout | undefined;
    try {
      const playback = await invokeAccount(providerId, () => provider.songUrl!(id, { signal: controller.signal }));
      if (!isCompleteAccountPlayback(playback, requestedItem?.durationSeconds ? requestedItem.durationSeconds * 1_000 : null)) {
        throw new ServiceError("AUDIO_NOT_FOUND", 404, publicMessage("AUDIO_NOT_FOUND"));
      }
      const allowedUrl = providerId === "qq" ? isAllowedQqAudioUrl(playback.url) : isAllowedNeteaseAudioUrl(playback.url);
      if (!allowedUrl) throw new ServiceError("AUDIO_NOT_FOUND", 404, publicMessage("AUDIO_NOT_FOUND"));
      const range = req.headers.range;
      if (range !== undefined && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) throw new ServiceError("INVALID_INPUT", 400, "Range header is invalid");
      const response = await fetch(playback.url, {
        redirect: "error",
        signal: controller.signal,
        headers: range ? { range } : undefined,
      });
      if (response.status === 416) {
        const contentRange = response.headers.get("content-range");
        if (contentRange && /^bytes \*\/\d+$/.test(contentRange)) res.setHeader("Content-Range", contentRange);
        res.statusCode = 416;
        res.end();
        return;
      }
      if ((response.status !== 200 && response.status !== 206) || !response.body) {
        throw new ServiceError(providerId === "qq" ? "QQ_PROVIDER_ERROR" : "NETEASE_PROVIDER_ERROR", 502, publicMessage(providerId === "qq" ? "QQ_PROVIDER_ERROR" : "NETEASE_PROVIDER_ERROR"));
      }
      clearTimeout(deadlineTimer);
      deadlineTimer = setTimeout(abort, Math.max(1, Math.min(programDeadlineMs - Date.now(), 10 * 60_000)));
      const lengthHeader = response.headers.get("content-length");
      const declaredLength = lengthHeader === null ? null : Number(lengthHeader);
      if (declaredLength !== null && Number.isFinite(declaredLength) && declaredLength > 32 * 1024 * 1024) {
        throw new ServiceError(providerId === "qq" ? "QQ_PROVIDER_ERROR" : "NETEASE_PROVIDER_ERROR", 502, providerId === "qq" ? "QQ 音频响应过大。" : "网易云音频响应过大。");
      }
      res.statusCode = response.status;
      res.setHeader("Content-Type", contentTypeFrom(response.headers.get("content-type")));
      res.setHeader("Cache-Control", "private, max-age=30");
      if (declaredLength !== null && Number.isFinite(declaredLength) && declaredLength >= 0) res.setHeader("Content-Length", declaredLength);
      const contentRange = response.headers.get("content-range");
      if (response.status === 206 && (!contentRange || !/^bytes \d+-\d+\/(?:\d+|\*)$/.test(contentRange))) {
        throw new ServiceError(providerId === "qq" ? "QQ_PROVIDER_ERROR" : "NETEASE_PROVIDER_ERROR", 502, providerId === "qq" ? "QQ 返回了无效的分段音频响应。" : "网易云返回了无效的分段音频响应。");
      }
      if (response.status === 206) res.setHeader("Content-Range", contentRange!);
      if (response.headers.get("accept-ranges") === "bytes") res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("X-Content-Type-Options", "nosniff");
      let total = 0;
      idleTimer = setTimeout(abort, 20_000);
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(abort, 20_000);
        total += chunk.byteLength;
        if (total > 32 * 1024 * 1024) throw new ServiceError(providerId === "qq" ? "QQ_PROVIDER_ERROR" : "NETEASE_PROVIDER_ERROR", 502, providerId === "qq" ? "QQ 音频响应过大。" : "网易云音频响应过大。");
        if (!res.write(Buffer.from(chunk))) await once(res, "drain");
      }
      res.end();
    } finally {
      clearTimeout(deadlineTimer);
      if (idleTimer) clearTimeout(idleTimer);
      req.off("aborted", abort);
      res.off("close", abort);
      activeStreams.delete(streamKey);
    }
  };

  const neteaseStatus = async (probe = false, signal?: AbortSignal): Promise<UnknownRecord> => {
    if (!neteaseProvider) {
      return { provider: "netease", configured: false, state: "blocked_by_configuration", authenticated: false };
    }
    let raw: UnknownRecord = {};
    if (probe && typeof neteaseProvider.health === "function") {
      try {
        await Promise.resolve(neteaseProvider.health(signal));
      } catch {
        throw new ServiceError("NETEASE_PROVIDER_ERROR", 502, publicMessage("NETEASE_PROVIDER_ERROR"));
      }
    }
    if (typeof neteaseProvider.getStatus === "function") {
      try {
        const value = await Promise.resolve(neteaseProvider.getStatus());
        if (isRecord(value)) raw = value;
      } catch {
        throw new ServiceError("NETEASE_PROVIDER_ERROR", 502, publicMessage("NETEASE_PROVIDER_ERROR"));
      }
    }
    const configured = neteaseProvider.configured === true || raw.configured === true;
    const stateValue = typeof raw.state === "string" && raw.state.length <= 64
      ? raw.state
      : typeof neteaseProvider.state === "string" && neteaseProvider.state.length <= 64
        ? neteaseProvider.state
        : configured ? "ready" : "blocked_by_configuration";
    const result: UnknownRecord = {
      provider: "netease",
      configured,
      state: stateValue,
      ...(typeof raw.authenticated === "boolean" ? { authenticated: raw.authenticated } : {}),
      ...(typeof raw.persistentLogin === "boolean" ? { persistentLogin: raw.persistentLogin } : {}),
      ...(typeof raw.accountReady === "boolean" ? { accountReady: raw.accountReady } : {}),
    };
    return result;
  };

  const qqStatus = async (probe = false, signal?: AbortSignal): Promise<UnknownRecord> => {
    if (!qqProvider) {
      return { provider: "qq", configured: false, state: "blocked_by_configuration", authenticated: false, persistentLogin: false };
    }
    let raw: UnknownRecord = {};
    if (probe && typeof qqProvider.health === "function") {
      try {
        await Promise.resolve(qqProvider.health(signal));
      } catch {
        throw new ServiceError("QQ_PROVIDER_ERROR", 502, publicMessage("QQ_PROVIDER_ERROR"));
      }
    }
    if (typeof qqProvider.getStatus === "function") {
      try {
        const value = await Promise.resolve(qqProvider.getStatus());
        if (isRecord(value)) raw = value;
      } catch {
        throw new ServiceError("QQ_PROVIDER_ERROR", 502, publicMessage("QQ_PROVIDER_ERROR"));
      }
    }
    const configured = qqProvider.configured === true || raw.configured === true;
    const stateValue = typeof raw.state === "string" && raw.state.length <= 64
      ? raw.state
      : typeof qqProvider.state === "string" && qqProvider.state.length <= 64
        ? qqProvider.state
        : configured ? "ready" : "blocked_by_configuration";
    const result: UnknownRecord = {
      provider: "qq",
      configured,
      state: stateValue,
      ...(typeof raw.authenticated === "boolean" ? { authenticated: raw.authenticated } : { authenticated: false }),
      ...(typeof raw.persistentLogin === "boolean" ? { persistentLogin: raw.persistentLogin } : { persistentLogin: false }),
      ...(typeof raw.accountReady === "boolean" ? { accountReady: raw.accountReady } : {}),
      ...(typeof raw.loginType === "string" && (raw.loginType === "wx" || raw.loginType === "qq" || raw.loginType === "mobile") ? { loginType: raw.loginType } : {}),
    };
    return result;
  };

  const requireNetease = async (): Promise<NeteaseProviderLike> => {
    const status = await neteaseStatus();
    if (!neteaseProvider || status.configured !== true) {
      throw new ServiceError("NETEASE_UNAVAILABLE", 503, publicMessage("NETEASE_UNAVAILABLE"));
    }
    return neteaseProvider;
  };

  const requireQq = async (): Promise<QqProviderLike> => {
    const status = await qqStatus();
    if (!qqProvider || status.configured !== true) {
      throw new ServiceError("QQ_UNAVAILABLE", 503, publicMessage("QQ_UNAVAILABLE"));
    }
    return qqProvider;
  };

  const invokeNetease = async (action: () => unknown): Promise<unknown> => {
    try {
      return publicProviderValue(await Promise.resolve(action()));
    } catch {
      throw new ServiceError("NETEASE_PROVIDER_ERROR", 502, publicMessage("NETEASE_PROVIDER_ERROR"));
    }
  };

  const invokeAccount = async (providerId: "netease" | "qq", action: () => unknown): Promise<unknown> => {
    try {
      return publicProviderValue(await Promise.resolve(action()));
    } catch {
      throw new ServiceError(providerId === "qq" ? "QQ_PROVIDER_ERROR" : "NETEASE_PROVIDER_ERROR", 502, publicMessage(providerId === "qq" ? "QQ_PROVIDER_ERROR" : "NETEASE_PROVIDER_ERROR"));
    }
  };

  const invokeNeteaseStage = async (stage: string, action: () => unknown): Promise<unknown> => {
    try {
      return await invokeNetease(action);
    } catch (error) {
      if (error instanceof ServiceError && error.code === "NETEASE_PROVIDER_ERROR") {
        throw new ServiceError("NETEASE_PROVIDER_ERROR", error.status, `网易云${stage}失败，请稍后重试。`);
      }
      throw error;
    }
  };

  const invokeAccountStage = async (providerId: "netease" | "qq", stage: string, action: () => unknown): Promise<unknown> => {
    try {
      return await invokeAccount(providerId, action);
    } catch (error) {
      const code = providerId === "qq" ? "QQ_PROVIDER_ERROR" : "NETEASE_PROVIDER_ERROR";
      if (error instanceof ServiceError && error.code === code) {
        throw new ServiceError(code, error.status, `${providerId === "qq" ? "QQ 音乐" : "网易云"}${stage}失败，请稍后重试。`);
      }
      throw error;
    }
  };

  const loadAccountPreferences = async (providerId: "netease" | "qq", scenePreset: ScenePreset, signal: AbortSignal, familiarityRatio = 60, musicGenres: MusicGenreId[] = [], recommendationMode: NonNullable<ProgramSpec["recommendationMode"]> = musicGenres.length > 0 ? "genre" : "atmosphere"): Promise<UnknownRecord> => {
    const provider: AccountProviderLike = providerId === "qq" ? await requireQq() : await requireNetease();
    const status = providerId === "qq" ? await qqStatus(true, signal) : await neteaseStatus(true, signal);
    if (status.authenticated !== true) {
      throw new ServiceError(providerId === "qq" ? "QQ_LOGIN_REQUIRED" : "NETEASE_LOGIN_REQUIRED", 401, publicMessage(providerId === "qq" ? "QQ_LOGIN_REQUIRED" : "NETEASE_LOGIN_REQUIRED"));
    }
    const required = ["account", "userPlaylists", "likedSongIds", "recentSongs", "listeningHistory", "dailyRecommendations", "personalFm", "search", "songDetail"] as const;
    if (required.some((method) => typeof provider[method] !== "function")) {
      throw new ServiceError(providerId === "qq" ? "QQ_UNAVAILABLE" : "NETEASE_UNAVAILABLE", 503, `当前${providerId === "qq" ? "QQ 音乐" : "网易云"}适配器尚未接入用户偏好读取。`);
    }

    const invoke = (action: () => unknown) => invokeAccount(providerId, action);
    const accountValue = await invoke(() => provider.account!(signal));
    if (!isRecord(accountValue) || typeof accountValue.uid !== "string") {
      throw new ServiceError(providerId === "qq" ? "QQ_PROVIDER_ERROR" : "NETEASE_PROVIDER_ERROR", 502, publicMessage(providerId === "qq" ? "QQ_PROVIDER_ERROR" : "NETEASE_PROVIDER_ERROR"));
    }
    const uid = accountValue.uid;
    const previousSnapshot = await loadListeningProfileSnapshot(providerId, uid);
    const previousProgramIds = recentProgramTrackIds(previousSnapshot);
    const sceneStyleTags = programStyleTags(scenePreset, musicGenres);
    const sceneSearchQuery = searchQueryForRecommendation(scenePreset, sceneStyleTags, recommendationMode);
    const signalNames = ["userPlaylists", "likedSongIds", "recentSongs", "listeningHistory", "dailyRecommendations", "personalFm"] as const;
    const tasks = await Promise.allSettled([
      invoke(() => provider.userPlaylists!(uid, { limit: 100, offset: 0, signal })),
      (async () => {
        if (typeof provider.likedSongs === "function") {
          const songsValue = await invoke(() => provider.likedSongs!({ limit: 500, signal }));
          const songs = Array.isArray(songsValue) ? songsValue : [];
          const ids = songs.flatMap((song) => isRecord(song) && typeof song.id === "string" ? [song.id] : []);
          return { ids, songs, truncated: false };
        }
        const idsValue = await invoke(() => provider.likedSongIds!(uid, signal));
        const ids = Array.isArray(idsValue) ? idsValue.filter((id): id is string => typeof id === "string") : [];
        const detailIds = ids.slice(0, 500);
        const detailBatches: string[][] = [];
        for (let offset = 0; offset < detailIds.length; offset += 100) {
          detailBatches.push(detailIds.slice(offset, offset + 100));
        }
        const detailResults = await Promise.all(detailBatches.map((batch) => invoke(() => provider.songDetail!(batch, signal))));
        const songs = detailResults.flatMap((value) => Array.isArray(value) ? value : []);
        return { ids, songs, truncated: ids.length > detailIds.length };
      })(),
      invoke(() => provider.recentSongs!({ limit: 100, signal })),
      invoke(() => provider.listeningHistory!(uid, { period: "week", signal })),
      invoke(() => provider.dailyRecommendations!({ signal })),
      invoke(() => provider.personalFm!(signal)),
    ]);
    const valueAt = (index: number): unknown => tasks[index]?.status === "fulfilled" ? tasks[index].value : null;
    const playlistsValue = valueAt(0);
    const playlists = isRecord(playlistsValue) && Array.isArray(playlistsValue.playlists) ? playlistsValue.playlists : [];
    const likedValue = valueAt(1);
    const likedIds = isRecord(likedValue) && Array.isArray(likedValue.ids) ? likedValue.ids : [];
    const likedSongs = isRecord(likedValue) && Array.isArray(likedValue.songs) ? likedValue.songs : [];
    const recent = Array.isArray(valueAt(2)) ? valueAt(2) as unknown[] : [];
    const history = Array.isArray(valueAt(3)) ? valueAt(3) as unknown[] : [];
    const daily = Array.isArray(valueAt(4)) ? valueAt(4) as unknown[] : [];
    const fm = Array.isArray(valueAt(5)) ? valueAt(5) as unknown[] : [];
    const sceneSearchSongs: unknown[] = [];
    const playlistDetailResults: PromiseSettledResult<unknown>[] = [];
    if (typeof provider.playlistDetail === "function") {
      for (const playlist of playlists.slice(0, 8)) {
        if (!isRecord(playlist)) continue;
        const id = typeof playlist.id === "string" ? playlist.id : typeof playlist.dirId === "string" ? playlist.dirId : null;
        if (!id) continue;
        try {
          const value = await invoke(() => provider.playlistDetail!(id, signal));
          const playlistName = typeof playlist.name === "string" ? playlist.name : "";
          const playlistTags = inferStyleTags({ searchQuery: playlistName });
          playlistDetailResults.push({
            status: "fulfilled",
            value: isRecord(value) && Array.isArray(value.tracks)
              ? { ...value, tracks: value.tracks.map((song) => withSearchContext(song, playlistName, playlistTags)) }
              : value,
          });
        } catch (reason) {
          playlistDetailResults.push({ status: "rejected", reason });
        }
      }
    }
    const playlistSongs = playlistDetailResults.flatMap((task) => task.status === "fulfilled" && isRecord(task.value) && Array.isArray(task.value.tracks) ? task.value.tracks : []);

    const artistScores = new Map<string, { id: string; name: string; score: number }>();
    const addSongArtists = (value: unknown, weight: number): void => {
      const record = isRecord(value) ? value : null;
      const song = record && isRecord(record.song) ? record.song : record;
      if (!song || !Array.isArray(song.artists)) return;
      for (const artistValue of song.artists) {
        if (!isRecord(artistValue) || typeof artistValue.id !== "string" || typeof artistValue.name !== "string") continue;
        const previous = artistScores.get(artistValue.id);
        artistScores.set(artistValue.id, { id: artistValue.id, name: artistValue.name, score: (previous?.score ?? 0) + weight });
      }
    };
    for (const entry of likedSongs) addSongArtists(entry, 5);
    for (const entry of recent) addSongArtists(entry, 2);
    for (const entry of history) addSongArtists(entry, 3);
    for (const entry of playlistSongs) addSongArtists(entry, 2);
    const favoriteArtists = [...artistScores.values()]
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
      .slice(0, 8);
    const failedSignals: string[] = tasks.flatMap((task, index) => task.status === "rejected" ? [signalNames[index] ?? "unknown"] : []);
    if (isRecord(playlistsValue) && playlistsValue.more === true) failedSignals.push("userPlaylists:truncated");
    if (isRecord(likedValue) && likedValue.truncated === true) failedSignals.push("likedSongDetails:truncated");
    if (playlistDetailResults.some((task) => task.status === "rejected")) failedSignals.push("playlistDetails:partial");
    const fulfilledSignals = tasks.filter((task) => task.status === "fulfilled").length;
    const profileSong = (value: unknown) => {
      const record = isRecord(value) ? value : null;
      const song = record && isRecord(record.song) ? record.song : record;
      if (!song || typeof song.id !== "string" || typeof song.title !== "string" || !Array.isArray(song.artists)) return null;
      const tags = inferStyleTags(song);
      return {
        id: song.id,
        title: song.title,
        artists: song.artists.filter(isRecord).map((artist) => typeof artist.name === "string" ? artist.name : "").filter(Boolean),
        ...(tags.length > 0 ? { tags } : {}),
      };
    };
    const baseProfile = buildListeningProfile({
      likedSongs: likedSongs.map(profileSong).filter((value): value is NonNullable<ReturnType<typeof profileSong>> => value !== null),
      recentSongs: recent.map(profileSong).filter((value): value is NonNullable<ReturnType<typeof profileSong>> => value !== null),
      historySongs: history.map(profileSong).filter((value): value is NonNullable<ReturnType<typeof profileSong>> => value !== null),
      playlistSongs: playlistSongs.map(profileSong).filter((value): value is NonNullable<ReturnType<typeof profileSong>> => value !== null),
      playlists: playlists.flatMap((playlist) => isRecord(playlist) && typeof playlist.name === "string" ? [playlist.name] : []),
    });
    const profile = baseProfile;
    const currentStyleAffinities = selectedStyleAffinities(profile, sceneStyleTags);
    const publicPlaylistQueries = stylePublicPlaylistQueries(scenePreset, sceneStyleTags, currentStyleAffinities, recommendationMode, isAtmosphereExploration(recommendationMode, familiarityRatio))
      .filter((query, index, all) => query.length > 0 && all.indexOf(query) === index)
      .slice(0, MAX_PUBLIC_PLAYLIST_QUERIES);
    const playlistSamplingSeed = randomBytes(8).toString("hex");
    const playlistSearchResults = typeof provider.searchPlaylists === "function" && typeof provider.playlistDetail === "function" && publicPlaylistQueries.length > 0
      ? await Promise.allSettled(publicPlaylistQueries.map((query) => invoke(() => provider.searchPlaylists!(query, { limit: PUBLIC_PLAYLIST_SEARCH_LIMIT, offset: 0, signal }))))
      : [];
    if (playlistSearchResults.some((task) => task.status === "rejected")) failedSignals.push("publicPlaylistSearch:partial");
    const publicPlaylistSeeds: Array<{ id: string; query: string; styleTags: MusicGenreId[] }> = [];
    const seenPublicPlaylistIds = new Set<string>();
    const playlistSearchGroups = playlistSearchResults.flatMap((task, index) => {
      if (task.status !== "fulfilled" || !isRecord(task.value) || !Array.isArray(task.value.playlists)) return [];
      const query = publicPlaylistQueries[index] ?? "";
      const queryGenre = genreForPlaylistQuery(query, sceneStyleTags);
      const queryTags = queryGenre ? [queryGenre] : inferStyleTags({ searchQuery: query });
      return [{ query, styleTags: queryTags.length > 0 ? queryTags : sceneStyleTags, playlists: task.value.playlists, queryGenre }];
    }).sort((left, right) => seededSampleScore(playlistSamplingSeed, left.query) - seededSampleScore(playlistSamplingSeed, right.query));
    const maxPlaylistSearchLength = Math.max(0, ...playlistSearchGroups.map((group) => group.playlists.length));
    for (let playlistIndex = 0; playlistIndex < maxPlaylistSearchLength; playlistIndex += 1) {
      for (const group of playlistSearchGroups) {
        const playlist = group.playlists[playlistIndex];
        if (!isRecord(playlist) || typeof playlist.id !== "string" || seenPublicPlaylistIds.has(playlist.id)) continue;
        if (isDisallowedRecommendationCandidate(playlist)) continue;
        if (recommendationMode === "genre" && (!group.queryGenre || !playlistHasStyleEvidence(playlist, group.queryGenre))) continue;
        seenPublicPlaylistIds.add(playlist.id);
        publicPlaylistSeeds.push({ id: playlist.id, query: group.query, styleTags: group.styleTags });
      }
    }
    const publicPlaylistDetailResults = await Promise.allSettled(
      publicPlaylistSeeds.slice(0, MAX_PUBLIC_PLAYLIST_DETAILS).map((playlist) => invoke(() => provider.playlistDetail!(playlist.id, signal))),
    );
    if (publicPlaylistDetailResults.some((task) => task.status === "rejected")) failedSignals.push("publicPlaylistDetails:partial");
    const publicPlaylistSongGroups = publicPlaylistDetailResults.map((task, index) => {
      if (task.status !== "fulfilled" || !isRecord(task.value) || !Array.isArray(task.value.tracks)) return [];
      const playlist = publicPlaylistSeeds[index];
      if (!playlist) return [];
      if (recommendationMode === "genre" && (playlist.styleTags.length !== 1 || !playlistHasStyleEvidence(task.value, playlist.styleTags[0]!))) return [];
      return task.value.tracks
        .map((song, trackIndex) => isRecord(song) ? {
          ...song,
          searchQuery: playlist.query,
          styleTags: playlist.styleTags,
          publicPlaylistId: playlist.id,
          playlistSampleScore: seededSampleScore(playlistSamplingSeed, playlist.id, typeof song.id === "string" ? song.id : trackIndex),
        } : song)
        .filter(isRecord)
        .sort((left, right) => Number(right.playlistSampleScore) - Number(left.playlistSampleScore))
        .slice(0, PUBLIC_PLAYLIST_TRACK_SAMPLE_LIMIT);
    });
    const publicPlaylistSongs: unknown[] = [];
    const maxPublicPlaylistLength = Math.max(0, ...publicPlaylistSongGroups.map((group) => group.length));
    for (let trackIndex = 0; trackIndex < maxPublicPlaylistLength; trackIndex += 1) {
      for (const group of publicPlaylistSongGroups) {
        const song = group[trackIndex];
        if (song) publicPlaylistSongs.push(song);
      }
    }
    const similaritySeeds = [...likedSongs, ...recent, ...history].flatMap((value) => {
      const record = isRecord(value) && isRecord(value.song) ? value.song : value;
      return isRecord(record) && typeof record.id === "string" ? [record.id] : [];
    }).filter((id, index, all) => all.indexOf(id) === index).slice(0, 6);
    const similarResults = typeof provider.similarSongs === "function"
      ? await Promise.allSettled(similaritySeeds.map((id) => invoke(() => provider.similarSongs!(id, { limit: 30, signal }))))
      : [];
    if (similarResults.some((task) => task.status === "rejected")) failedSignals.push("similarSongs:partial");
    const similarSongs = similarResults.flatMap((task) => task.status === "fulfilled" && Array.isArray(task.value) ? task.value : []);
    const search = [...publicPlaylistSongs, ...similarSongs];

    const candidateFromSong = (value: unknown): PersonalizationCandidate | null => {
      const record = isRecord(value) && isRecord(value.song) ? value.song : value;
      if (!isRecord(record) || typeof record.id !== "string" || typeof record.title !== "string" || !Array.isArray(record.artists)) return null;
      if (isDisallowedRecommendationCandidate(record)) return null;
      const styleTags = inferStyleTags(record);
      return {
        id: record.id,
        title: record.title,
        artists: record.artists as PersonalizationCandidate["artists"],
        ...(styleTags.length > 0 ? { styleTags } : {}),
        ...(typeof record.searchQuery === "string" ? { searchQuery: record.searchQuery } : {}),
        ...(typeof record.publicPlaylistId === "string" ? { publicPlaylistId: record.publicPlaylistId } : {}),
        ...(typeof record.playlistSampleScore === "number" ? { playlistSampleScore: record.playlistSampleScore } : {}),
        ...(typeof record.durationMs === "number" ? { durationMs: record.durationMs } : {}),
        ...(isRecord(record.album) && typeof record.album.name === "string" ? {
          album: {
            name: record.album.name,
            ...(typeof record.album.coverUrl === "string" ? { coverUrl: record.album.coverUrl } : {}),
          },
        } : {}),
        ...(typeof record.popularity === "number" ? { popularity: record.popularity } : {}),
        ...(typeof record.releaseYear === "number" ? { releaseYear: record.releaseYear } : {}),
        ...(typeof record.songType === "number" ? { songType: record.songType } : {}),
        ...(typeof record.energy === "number" ? { energy: Math.max(0, Math.min(1, record.energy)) } : {}),
        ...(typeof record.genre === "string" ? { genre: record.genre } : {}),
        ...(Array.isArray(record.mood) ? { mood: record.mood.filter((item): item is string => typeof item === "string") } : {}),
      };
    };
    const candidates = (values: unknown[]): PersonalizationCandidate[] => values.map(candidateFromSong).filter((value): value is PersonalizationCandidate => value !== null);
    const preferredArtists: Record<string, number> = Object.fromEntries(favoriteArtists.map((artist) => [artist.name, artist.score]));
    for (const affinity of currentStyleAffinities) {
      const artists = Array.isArray(affinity.artists) ? affinity.artists : [];
      for (const artist of artists) {
        if (!isRecord(artist) || typeof artist.name !== "string" || !artist.name.trim()) continue;
        const score = typeof artist.score === "number" && Number.isFinite(artist.score) ? artist.score : 0;
        preferredArtists[artist.name.trim()] = Math.max(preferredArtists[artist.name.trim()] ?? 0, score + 30);
      }
    }
    const recentTrackIds = recent.flatMap((value) => isRecord(value) && isRecord(value.song) && typeof value.song.id === "string" ? [value.song.id] : []);
    const decision = personalizeCandidates({
      liked: candidates(likedSongs),
      recent: candidates(recent),
      history: candidates(history),
      daily: candidates(daily),
      fm: candidates(fm),
      search: candidates([...playlistSongs, ...search]),
      preferredArtists,
      recentTrackIds,
      recentArtistNames: [],
      scene: { preset: scenePreset, query: sceneSearchQuery, styleTags: sceneStyleTags },
      session: { recentTrackIds: previousProgramIds },
    });
    const atmosphereExploration = isAtmosphereExploration(recommendationMode, familiarityRatio);
    const eraRanked = atmosphereExploration ? rerankAtmosphereExploration(decision.ranked) : decision.ranked;
    const likedTrackIds = new Set(likedIds.map(String));
    const playedTrackIds = new Set(previousProgramIds);
    const eligibleRanked = eraRanked.filter((entry) => {
      const id = String(entry.candidate.id);
      return likedTrackIds.has(id) || (!playedTrackIds.has(id) && !isExplorationVersionCandidate(entry.candidate));
    });
    const preferUniqueArtists = <T extends { candidate: object }>(entries: T[]): T[] => {
      const unique: T[] = [];
      const repeats: T[] = [];
      const seen = new Set<string>();
      for (const entry of entries) {
        const artists = "artists" in entry.candidate && Array.isArray(entry.candidate.artists) ? entry.candidate.artists : [];
        const first = artists[0];
        const name = typeof first === "string" ? first : isRecord(first) && typeof first.name === "string" ? first.name : "";
        const key = name.trim().toLocaleLowerCase();
        if (key && !seen.has(key)) {
          seen.add(key);
          unique.push(entry);
        } else {
          repeats.push(entry);
        }
      }
      return [...unique, ...repeats];
    };
    const familiarRanked = preferUniqueArtists(eligibleRanked.filter((entry) => likedTrackIds.has(String(entry.candidate.id))));
    const discoveryRanked = preferUniqueArtists(eligibleRanked.filter((entry) => !likedTrackIds.has(String(entry.candidate.id))));
    // Reserve each quota pool before playback verification while keeping the
    // total upstream URL checks bounded. At 120 tracks this leaves one full
    // program's worth of same-pool fallbacks for every supported ratio.
    const familiarCapacity = Math.round(MAX_NETEASE_PLAYBACK_CANDIDATES * familiarityRatio / 100);
    const discoveryCapacity = MAX_NETEASE_PLAYBACK_CANDIDATES - familiarCapacity;
    const reservedCandidates = [
      ...familiarRanked.slice(0, familiarCapacity),
      ...discoveryRanked.slice(0, discoveryCapacity),
    ];
    const reservedIds = new Set(reservedCandidates.map((entry) => String(entry.candidate.id)));
    for (const entry of eligibleRanked) {
      if (reservedCandidates.length >= MAX_NETEASE_PLAYBACK_CANDIDATES) break;
      const id = String(entry.candidate.id);
      if (reservedIds.has(id)) continue;
      reservedCandidates.push(entry);
      reservedIds.add(id);
    }
    const candidateIds = new Set(reservedCandidates.map((entry) => String(entry.candidate.id)));
    const candidatePlan = eligibleRanked.filter((entry) => candidateIds.has(String(entry.candidate.id)));
    const heardTrackIds = new Set([...likedIds.map(String), ...recentTrackIds, ...history.flatMap((value) => {
      const record = isRecord(value) && isRecord(value.song) ? value.song : value;
      return isRecord(record) && typeof record.id === "string" ? [record.id] : [];
    })]);

    const accountAfter = await invoke(() => provider.account!(signal));
    if (!isRecord(accountAfter) || accountAfter.uid !== uid) {
      throw new ServiceError("ACCOUNT_CHANGED", 409, "音乐账号在读取画像时发生了变化，请重新生成本次节目。");
    }
    const result: UnknownRecord = {
      state: fulfilledSignals === 0 ? "unavailable" : failedSignals.length > 0 ? "degraded" : "ready",
      loadedAt: nowIso(),
      account: { connected: true },
      counts: {
        likedTracks: likedIds.length,
        playlists: playlists.length,
        playlistTracks: playlistSongs.length,
        recentTracks: recent.length,
        historyTracks: history.length,
        dailyCandidates: daily.length,
        fmCandidates: fm.length,
        sceneSearchCandidates: sceneSearchSongs.length,
        profileSearchQueries: 0,
        profileSearchCandidates: 0,
        publicPlaylistQueries: publicPlaylistQueries.length,
        publicPlaylists: publicPlaylistSeeds.length,
        publicPlaylistTracks: publicPlaylistSongs.length,
        similarCandidates: similarSongs.length,
        expandedSearchCandidates: search.length,
      },
      favoriteArtists,
      profile,
      listenerProfile: {
        favoriteArtists: favoriteArtists.map(({ name, score }) => ({ name, score })),
        topSongs: profile.topSongs.map((song) => ({ title: song.title, artists: song.artists })),
        playlistNames: profile.playlistNames,
        inferredThemes: profile.inferredThemes,
        styleTags: profile.styleTags,
        styleAffinities: profile.styleAffinities.map((affinity) => ({
          style: affinity.style,
          score: affinity.score,
          artists: affinity.artists.map((artist) => ({ name: artist.name, score: artist.score, songs: artist.songs })),
          familiarSongs: affinity.familiarSongs.map((song) => ({ title: song.title, artists: song.artists, sources: song.sources })),
          evidence: affinity.evidence,
        })),
        taggedSongs: profile.taggedSongs.map((song) => ({
          title: song.title,
          artists: song.artists,
          tags: song.tags,
          sources: song.sources,
        })),
        evidence: profile.evidence,
      },
      routePlan: {
        scene: scenePreset,
        recommendationMode,
        candidateCount: eraRanked.length,
        hostNodes: eraRanked.slice(0, 8).map((entry, index) => ({
          afterCandidate: index,
          purpose: index === 0 ? "开场建立节目气质" : index % 2 === 0 ? "承接上一段并介绍下一首候选" : "保持节目连续性",
        })),
      },
      nextCandidate: eraRanked[0] ? {
        id: String(eraRanked[0].candidate.id),
        title: typeof eraRanked[0].candidate.title === "string" ? eraRanked[0].candidate.title : "",
        artists: Array.isArray(eraRanked[0].candidate.artists) ? eraRanked[0].candidate.artists : [],
        reasons: eraRanked[0].reasons,
        controlState: "awaiting_client_confirmation",
      } : null,
      programPlan: candidatePlan.map((entry) => ({
        id: String(entry.candidate.id),
        title: typeof entry.candidate.title === "string" ? entry.candidate.title : "",
        artists: Array.isArray(entry.candidate.artists) ? entry.candidate.artists : [],
        album: isRecord(entry.candidate.album) && typeof entry.candidate.album.name === "string" ? entry.candidate.album.name : null,
        coverUrl: isRecord(entry.candidate.album) && typeof entry.candidate.album.coverUrl === "string" ? entry.candidate.album.coverUrl : null,
        popularity: typeof entry.candidate.popularity === "number" ? entry.candidate.popularity : null,
        releaseYear: typeof entry.candidate.releaseYear === "number" ? entry.candidate.releaseYear : null,
        durationMs: typeof entry.candidate.durationMs === "number" ? entry.candidate.durationMs : null,
        songType: typeof entry.candidate.songType === "number" ? entry.candidate.songType : null,
        energy: typeof entry.candidate.energy === "number" ? Math.max(0, Math.min(1, entry.candidate.energy)) : null,
        genre: typeof entry.candidate.genre === "string" ? entry.candidate.genre : null,
        mood: Array.isArray(entry.candidate.mood) ? entry.candidate.mood.filter((item): item is string => typeof item === "string") : [],
        styleTags: Array.isArray(entry.candidate.styleTags) ? entry.candidate.styleTags.filter((item): item is string => typeof item === "string") : [],
        reasons: entry.reasons,
        liked: likedTrackIds.has(String(entry.candidate.id)),
        heard: heardTrackIds.has(String(entry.candidate.id)),
      })),
      failedSignals,
    };
    await persistListeningProfileSnapshot(providerId, uid, {
      programHistory: Array.isArray(previousSnapshot?.programHistory) ? previousSnapshot.programHistory : [],
      playedTracks: Array.isArray(previousSnapshot?.playedTracks) ? previousSnapshot.playedTracks : [],
      counts: result.counts,
      favoriteArtists,
      profile,
      listenerProfile: result.listenerProfile,
      routePlan: result.routePlan,
      selectedScene: scenePreset,
      selectedMusicGenres: sceneStyleTags,
      recommendationMode,
    }).catch(() => undefined);
    Object.defineProperty(result, "accountUid", { value: uid, enumerable: false });
    Object.defineProperty(result, "previousSnapshot", { value: previousSnapshot, enumerable: false });
    Object.defineProperty(result, "previousProgramTrackIds", { value: previousProgramIds, enumerable: false });
    return result;
  };

  const loadNeteasePreferences = (scenePreset: ScenePreset, signal: AbortSignal, familiarityRatio = 60, musicGenres: MusicGenreId[] = [], recommendationMode?: ProgramSpec["recommendationMode"]): Promise<UnknownRecord> =>
    loadAccountPreferences("netease", scenePreset, signal, familiarityRatio, musicGenres, recommendationMode ?? (musicGenres.length > 0 ? "genre" : "atmosphere"));
  const loadQqPreferences = (scenePreset: ScenePreset, signal: AbortSignal, familiarityRatio = 60, musicGenres: MusicGenreId[] = [], recommendationMode?: ProgramSpec["recommendationMode"]): Promise<UnknownRecord> =>
    loadAccountPreferences("qq", scenePreset, signal, familiarityRatio, musicGenres, recommendationMode ?? (musicGenres.length > 0 ? "genre" : "atmosphere"));

  const prepareAccountRundown = async (
    providerId: "netease" | "qq",
    spec: ProgramSpec,
    preferences: UnknownRecord,
    signal: AbortSignal,
    onCompletedStep?: (step: 2 | 3) => void,
    minimumDurationSeconds = minimumProgramDurationSeconds(spec.durationMinutes),
    minimumTrackCount = 1,
  ): Promise<ProgramRundownItem[]> => {
    const provider = providerId === "qq" ? await requireQq() : await requireNetease();
    if (typeof provider.songUrl !== "function") return [];
    const planned = Array.isArray(preferences.programPlan) ? preferences.programPlan : [];
    const playable: ProgramRundownItem[] = [];
    const usedIds = new Set<string>();
    const measuredEnergyById = new Map<string, number>();
    const inspectPlannedSong = async (value: unknown): Promise<ProgramRundownItem | null> => {
      if (!isRecord(value) || typeof value.id !== "string" || typeof value.title !== "string") return null;
      if (isDisallowedRecommendationCandidate(value)) return null;
      if (value.liked !== true && isExplorationVersionCandidate(value)) return null;
      const artists = Array.isArray(value.artists) ? value.artists.map((artist) => {
        if (typeof artist === "string") return artist.trim();
        return isRecord(artist) && typeof artist.name === "string" ? artist.name.trim() : "";
      }).filter(Boolean) : [];
      const artist = artists[0];
      if (!artist) return null;
      let playback: unknown;
      const songId = value.id;
      try {
        playback = await invokeAccount(providerId, () => provider.songUrl!(String(songId), { signal }));
      } catch {
        return null;
      }
      const expectedDurationMs = typeof value.durationMs === "number" && value.durationMs > 0 ? value.durationMs : null;
      if (!isCompleteAccountPlayback(playback, expectedDurationMs)) return null;
      const allowedUrl = providerId === "qq" ? isAllowedQqAudioUrl(playback.url) : isAllowedNeteaseAudioUrl(playback.url);
      if (!allowedUrl) return null;
      const durationMs = typeof value.durationMs === "number" && value.durationMs > 0 ? value.durationMs : 210_000;
      const measuredEnergy = typeof value.energy === "number" && Number.isFinite(value.energy) ? Math.max(0, Math.min(1, value.energy)) : null;
      if (measuredEnergy !== null) measuredEnergyById.set(value.id, measuredEnergy);
      const knownMood = Array.isArray(value.mood) && value.mood.length > 0
        ? value.mood.filter((item): item is string => typeof item === "string")
        : [];
      const styleTags = Array.isArray(value.styleTags)
        ? value.styleTags.filter((item): item is string => typeof item === "string")
        : [];
      return {
        id: value.id,
        title: value.title,
        artist,
        durationSeconds: Math.max(1, Math.round(durationMs / 1000)),
        energy: measuredEnergy ?? 0.5,
        energyMeasured: measuredEnergy !== null,
        mood: knownMood,
        ...(styleTags.length > 0 ? { styleTags } : {}),
        color: "#5f806b",
        ...(typeof value.coverUrl === "string" ? { coverUrl: value.coverUrl } : {}),
        sourceId: providerId === "qq" ? "qq_music" : "netease_music",
        ...(typeof value.songType === "number" && Number.isSafeInteger(value.songType) && value.songType >= 0 ? { songType: value.songType } : {}),
        album: typeof value.album === "string" ? value.album : null,
        releaseYear: typeof value.releaseYear === "number" ? value.releaseYear : null,
        popularity: typeof value.popularity === "number" ? value.popularity : null,
        reasons: Array.isArray(value.reasons) ? value.reasons.filter((reason): reason is string => typeof reason === "string").slice(0, 4) : ["来自你的听歌画像与本次场景的匹配"],
        liked: value.liked === true,
        heard: value.heard === true,
      };
    };
    // The QQ SDK mutates shared request context while resolving playback URLs;
    // concurrent calls can make an otherwise playable batch fail together.
    const concurrency = providerId === "qq" ? 1 : 8;
    for (let offset = 0; offset < planned.length; offset += concurrency) {
      const batch = await Promise.all(planned.slice(offset, offset + concurrency).map(inspectPlannedSong));
      for (const item of batch) {
        if (!item || usedIds.has(item.id)) continue;
        playable.push(item);
        usedIds.add(item.id);
      }
    }
    if (playable.length === 0) return [];
    onCompletedStep?.(2);
    const requestedRatio = spec.familiarityRatio ?? 40;
    // The ratio is a recommendation target. Only explicitly liked songs count
    // as familiar, but a sparse pool must never block an otherwise valid show.
    const familiar = playable.filter((track) => track.liked === true);
    const discovery = playable.filter((track) => track.liked !== true);
    const sceneStyleSet = new Set(programStyleTags(spec.scenePreset, spec.musicGenres ?? []));
    const mode = recommendationModeForSpec(spec);
    const atmosphereExploration = isAtmosphereExploration(mode, requestedRatio);
    const explicitMusicStyles = mode === "genre";
    const fitsProgramStyle = (track: ProgramRundownItem): boolean => {
      const tags = track.styleTags ?? [];
      if (tags.length > 0) return tags.some((tag) => sceneStyleSet.has(tag as MusicGenreId));
      if (explicitMusicStyles) return false;
      return track.reasons.some((reason) => /scene (?:style|query style|search) reward|场景|氛围/.test(reason));
    };
    const familiarFitShare = familiar.length === 0 ? 0 : familiar.filter(fitsProgramStyle).length / familiar.length;
    const discoveryFitShare = discovery.length === 0 ? 0 : discovery.filter(fitsProgramStyle).length / discovery.length;
    const hasStyleFamiliarAnchors = familiar.some(fitsProgramStyle);
    const targetRatio = explicitMusicStyles && !hasStyleFamiliarAnchors && discoveryFitShare >= 0.35
      ? 0
      : discoveryFitShare >= 0.35 && familiarFitShare < 0.2
      ? Math.min(requestedRatio, (spec.musicGenres?.length ?? 0) > 0 ? 35 : 45)
      : requestedRatio;
    const selectApproximate = (trackCount: number): ProgramRundownItem[] => {
      const selected: ProgramRundownItem[] = [];
      const selectedIds = new Set<string>();
      const usedArtists = new Set<string>();
      const selectedStyleCounts = new Map([...sceneStyleSet].map((style) => [style, 0]));
      const lowShareStyleLimit = atmosphereExploration ? Math.max(1, Math.floor(trackCount * 0.2)) : Number.POSITIVE_INFINITY;
      let lowShareStyleCount = 0;
      const matchingProgramStyles = (track: ProgramRundownItem): MusicGenreId[] => [
        ...new Set((track.styleTags ?? []).filter((tag): tag is MusicGenreId => sceneStyleSet.has(tag as MusicGenreId))),
      ];
      const leastRepresentedMatch = (track: ProgramRundownItem): MusicGenreId | null => {
        const matches = matchingProgramStyles(track);
        if (matches.length === 0) return null;
        return matches.sort((left, right) => (selectedStyleCounts.get(left) ?? 0) - (selectedStyleCounts.get(right) ?? 0))[0] ?? null;
      };
      const fillsUnderusedStyle = (track: ProgramRundownItem): boolean => {
        const style = leastRepresentedMatch(track);
        if (!style) return false;
        const lowest = Math.min(...[...selectedStyleCounts.values()]);
        return (selectedStyleCounts.get(style) ?? 0) === lowest;
      };
      const take = (pool: ProgramRundownItem[], uniqueArtist: boolean, allowExplorationFallback: boolean): ProgramRundownItem | null => {
        const requireStyleMatch = explicitMusicStyles;
        const canTake = (track: ProgramRundownItem): boolean =>
          !selectedIds.has(track.id)
          && (!uniqueArtist || !usedArtists.has(track.artist.toLocaleLowerCase()))
          && (
            allowExplorationFallback
            || !atmosphereExploration
            || (
              !isLegacyDiscoveryCandidate(track)
              && !isRemixDiscoveryCandidate(track)
              && (!isLowShareDefaultStyle(track) || lowShareStyleCount < lowShareStyleLimit)
            )
          );
        const item = pool.find((track) => sceneStyleSet.size > 1 && fitsProgramStyle(track) && fillsUnderusedStyle(track) && canTake(track))
          ?? pool.find((track) => fitsProgramStyle(track) && canTake(track))
          ?? (requireStyleMatch ? null : pool.find(canTake));
        if (!item) return null;
        selectedIds.add(item.id);
        usedArtists.add(item.artist.toLocaleLowerCase());
        const style = leastRepresentedMatch(item);
        if (style) selectedStyleCounts.set(style, (selectedStyleCounts.get(style) ?? 0) + 1);
        if (atmosphereExploration && isLowShareDefaultStyle(item)) lowShareStyleCount += 1;
        return item;
      };
      for (let index = 0; index < trackCount; index += 1) {
        const preferFamiliar = Math.round((index + 1) * targetRatio / 100) > Math.round(index * targetRatio / 100);
        const preferred = preferFamiliar ? familiar : discovery;
        const alternate = preferFamiliar ? discovery : familiar;
        const item = take(preferred, true, false)
          ?? take(alternate, true, false)
          ?? take(preferred, false, false)
          ?? take(alternate, false, false)
          ?? take(preferred, true, true)
          ?? take(alternate, true, true)
          ?? take(preferred, false, true)
          ?? take(alternate, false, true);
        if (!item) break;
        selected.push(item);
      }
      const relevance = new Map(playable.map((track, index) => [track.id, playable.length <= 1 ? 0.5 : 1 - index / (playable.length - 1)]));
      const remaining = [...selected];
      const ordered: ProgramRundownItem[] = [];
      const totalDurationSeconds = selected.reduce((total, track) => total + track.durationSeconds, 0);
      let elapsedSeconds = 0;
      for (let index = 0; index < selected.length; index += 1) {
        const phase = phaseForElapsedSeconds(elapsedSeconds, Math.max(1, totalDurationSeconds));
        const arrangementScene = arrangementSceneForSpec(spec);
        const range = energyRangeForPhase(arrangementScene, phase);
        const target = (range.min + range.max) / 2;
        let bestIndex = 0;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (let candidateIndex = 0; candidateIndex < remaining.length; candidateIndex += 1) {
          const track = remaining[candidateIndex]!;
          const measured = measuredEnergyById.get(track.id) ?? null;
          const proxy = measured ?? relevance.get(track.id) ?? 0.5;
          const distance = Math.abs(proxy - target);
          if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = candidateIndex;
          }
        }
        const [track] = remaining.splice(bestIndex, 1);
        if (track) {
          ordered.push({ ...track, arrangementTargetEnergy: target, reasons: [...track.reasons, mode === "genre" ? `按所选风格的${phase}段落编排` : `按${getSceneConfig(spec.scenePreset).label}氛围的${phase}段落编排`] });
          elapsedSeconds += track.durationSeconds;
        }
      }
      return ordered;
    };
    let items: ProgramRundownItem[] = [];
    let bestRatioDistance = Number.POSITIVE_INFINITY;
    let bestDurationSeconds = Number.POSITIVE_INFINITY;
    const maximumTrackCount = Math.min(MAX_NETEASE_RUNDOWN_TRACKS, playable.length);
    for (let trackCount = 1; trackCount <= maximumTrackCount; trackCount += 1) {
      const candidate = selectApproximate(trackCount);
      const durationSeconds = candidate.reduce((total, track) => total + track.durationSeconds, 0);
      if (durationSeconds < minimumDurationSeconds || candidate.length < minimumTrackCount) continue;
      const actualRatio = candidate.filter((track) => track.liked === true).length * 100 / candidate.length;
      const ratioDistance = Math.abs(actualRatio - targetRatio);
      if (ratioDistance < bestRatioDistance || (ratioDistance === bestRatioDistance && durationSeconds < bestDurationSeconds)) {
        items = candidate;
        bestRatioDistance = ratioDistance;
        bestDurationSeconds = durationSeconds;
      }
      if (ratioDistance === 0) break;
    }
    const rundown: ProgramRundownItem[] = items.map((item) => ({ ...item, heard: item.liked === true }));
    if (providerId === "netease" && "songCredits" in provider && typeof provider.songCredits === "function") {
      for (let offset = 0; offset < rundown.length; offset += 4) {
        const batch = rundown.slice(offset, offset + 4);
        const credits = await Promise.all(batch.map(async (item) => {
          try {
            const value = await invokeAccount(providerId, () => provider.songCredits!(item.id, signal));
            if (!isRecord(value)) return null;
            const names = (entry: unknown): string[] => Array.isArray(entry)
              ? entry.filter((name): name is string => typeof name === "string" && name.trim().length > 0).map((name) => name.trim()).slice(0, 12)
              : [];
            return { lyricists: names(value.lyricists), composers: names(value.composers), arrangers: names(value.arrangers) };
          } catch {
            return null;
          }
        }));
        credits.forEach((value, index) => {
          if (value && (value.lyricists.length > 0 || value.composers.length > 0 || value.arrangers.length > 0)) batch[index].credits = value;
        });
      }
    }
    onCompletedStep?.(3);
    return rundown;
  };

  const prepareNeteaseRundown = (spec: ProgramSpec, preferences: UnknownRecord, signal: AbortSignal): Promise<ProgramRundownItem[]> =>
    prepareAccountRundown("netease", spec, preferences, signal);
  const prepareQqRundown = (spec: ProgramSpec, preferences: UnknownRecord, signal: AbortSignal): Promise<ProgramRundownItem[]> =>
    prepareAccountRundown("qq", spec, preferences, signal);

  const revalidateAccountRundown = async (
    providerId: "netease" | "qq",
    spec: ProgramSpec,
    artifact: AccountRundown,
    signal: AbortSignal,
  ): Promise<{ items: ProgramRundownItem[]; replacedIndexes: number[] }> => {
    const provider = providerId === "qq" ? await requireQq() : await requireNetease();
    if (typeof provider.songUrl !== "function") throw new ServiceError(providerId === "qq" ? "QQ_UNAVAILABLE" : "NETEASE_UNAVAILABLE", 503, publicMessage(providerId === "qq" ? "QQ_UNAVAILABLE" : "NETEASE_UNAVAILABLE"));
    const inspect = async (item: ProgramRundownItem): Promise<boolean> => {
      try {
        const playback = await invokeAccount(providerId, () => provider.songUrl!(item.id, { signal }));
        return isCompleteAccountPlayback(playback, item.durationSeconds * 1_000);
      } catch {
        return false;
      }
    };
    const validByIndex: boolean[] = [];
    const concurrency = providerId === "qq" ? 1 : 8;
    for (let offset = 0; offset < artifact.items.length; offset += concurrency) {
      validByIndex.push(...await Promise.all(artifact.items.slice(offset, offset + concurrency).map(inspect)));
    }
    const invalidIndexes = validByIndex.flatMap((valid, index) => valid ? [] : [index]);
    if (invalidIndexes.length === 0) return { items: artifact.items, replacedIndexes: [] };
    if (!artifact.preferences || !Array.isArray(artifact.preferences.programPlan)) {
      throw new ServiceError("PLAYBACK_PERMISSION_CHANGED", 409, "部分歌曲已无法由当前账号完整播放，请重新生成本次节目。");
    }
    const currentIds = new Set(artifact.items.map((item) => item.id));
    const replacementPreferences = {
      ...artifact.preferences,
      programPlan: artifact.preferences.programPlan.filter((value) => !isRecord(value) || !currentIds.has(String(value.id))),
    };
    const replacements = (await prepareAccountRundown(providerId, spec, replacementPreferences, signal, undefined, 1, invalidIndexes.length))
      .filter((item) => !currentIds.has(item.id));
    if (replacements.length < invalidIndexes.length) {
      throw new ServiceError("PLAYBACK_PERMISSION_CHANGED", 409, "当前账号可完整播放的歌曲不足，请重新生成本次节目。");
    }
    const items = artifact.items.map((item) => ({ ...item }));
    invalidIndexes.forEach((index, replacementIndex) => {
      const previous = items[index]!;
      items[index] = { ...replacements[replacementIndex]!, hostMoment: previous.hostMoment };
    });
    return { items, replacedIndexes: invalidIndexes };
  };

  const createFinalHostScriptVersion = (spec: ProgramSpec, sourceItems: ProgramRundownItem[]): ProgramRundownItem[] => {
    const positions = new Set(evenlySpacedHostBreakIndices(sourceItems.length, spec.hostDensity));
    const profileId = spec.hostProfile ?? DEFAULT_HOST_PROFILE;
    const greeting = radioGreetingAt(new Date());
    const detailFor = (item: ProgramRundownItem): string => {
      const title = normalizeSpokenEnglishCase(item.title);
      const details: string[] = [];
      if (item.releaseYear) details.push(`发行于${item.releaseYear}年`);
      if (item.album && !releaseTitlesMatch(item.title, item.album)) details.push(`收在《${normalizeSpokenEnglishCase(item.album)}》里`);
      if (details.length === 0) return "";
      return `这首歌${details.join("，")}`;
    };
    return sourceItems.map(({ hostMoment: _hostMoment, hostScript: _hostScript, ...item }, index) => {
      if (!positions.has(index)) return item;
      const artist = normalizeSpokenEnglishCase(spokenArtistName(item.artist));
      const title = `《${normalizeSpokenEnglishCase(item.title)}》`;
      const detail = detailFor(item);
      const isOpening = index === 0;
      const isClosing = index === sourceItems.length - 1;
      const hostMoment: NonNullable<ProgramRundownItem["hostMoment"]> = isOpening ? "opening" : isClosing ? "song_note" : "next_preview";
      const text = isOpening
        ? `${greeting}，${hostOpeningIdentity(profileId)}今天先从${artist}的${title}开始。${detail ? `${detail}。` : ""}`
        : isClosing
          ? `这是本档节目的最后一首，${artist}的${title}。${detail ? `${detail}。` : ""}`
          : `${index % 2 === 0 ? "下一首换到" : "接下来听"}${artist}的${title}。${detail ? `${detail}。` : ""}`;
      const hostScript: ProgramHostScript = {
        id: randomUUID(),
        text: normalizeSpokenEnglishCase(text).slice(0, 600),
        factIds: [`track:${item.id}:metadata`],
        instruction: "final playable host version after producer rewrite limit",
        deliveryInstruction: "自然口语，歌名和音乐人说清楚，句尾收稳。",
        hostMoment,
        generatedAt: nowIso(),
        plannedDurationSeconds: item.liked !== true ? 24 : 18,
        musicBedDelaySeconds: HOST_MUSIC_START_DELAY_SECONDS,
      };
      return { ...item, hostMoment, hostScript };
    });
  };

  const lockNeteaseHostScripts = async (
    spec: ProgramSpec,
    items: ProgramRundownItem[],
    listenerProfile: ProgramListenerProfile | undefined,
    signal: AbortSignal,
    userAdjustment = "",
  ): Promise<ProgramRundownItem[]> => {
    if (!hostProvider || typeof hostProvider.generate !== "function") {
      throw new ServiceError("HOST_PROVIDER_ERROR", 503, "主持人模型不可用，无法锁定本次节目文案。");
    }
    items = items.map(({ hostScript: _hostScript, ...item }) => item);
    const totalSeconds = items.reduce((total, item) => total + item.durationSeconds, 0);
    let hostDurationTargets = planHostDurationTargets(items.filter((item) => Boolean(item.hostMoment)).map((item) => item.liked !== true));
    const lockedItems: ProgramRundownItem[] = [];
    const recentHostLines: string[] = [];
    const profileForPrompt = listenerProfile
      ? {
          favoriteArtists: listenerProfile.favoriteArtists.slice(0, 8).map((item) => item.name),
          inferredThemes: listenerProfile.inferredThemes.slice(0, 8),
        }
      : undefined;
    let webFacts: Array<{ id: string; value: string; sourceUrl: string }> = [];
    const researchProvider = hostProvider as HostProviderLike;
    if (typeof researchProvider.research === "function") {
      try {
        const researched = await Promise.resolve(researchProvider.research({
          scenePreset: spec.scenePreset,
          tracks: [...items]
            .sort((left, right) => Number(left.liked === true) - Number(right.liked === true))
            .slice(0, 12)
            .map((item) => ({ title: item.title, artist: item.artist, exploration: item.liked !== true })),
        }, { signal }));
        if (Array.isArray(researched)) {
          webFacts = researched
            .filter((fact): fact is { id: string; value: string; sourceUrl: string } => (
              isRecord(fact)
              && typeof fact.id === "string"
              && /^web:[A-Za-z0-9_-]+$/.test(fact.id)
              && typeof fact.value === "string"
              && fact.value.trim().length >= 12
              && typeof fact.sourceUrl === "string"
              && /^https:\/\//.test(fact.sourceUrl)
            ))
            .slice(0, 24)
            .map((fact) => ({ id: fact.id, value: fact.value.trim().slice(0, 500), sourceUrl: fact.sourceUrl.slice(0, 500) }));
        }
      } catch {
        // A news lookup is additive. Song/profile facts remain sufficient to host safely.
      }
    }
    if (typeof researchProvider.generateShow === "function") {
      const showTracks = items.map((item, index) => {
        const spokenArtist = spokenArtistName(item.artist);
        const relevantWebFacts = webFacts
          .filter((fact) => musicFactMatchesTrack(fact.value, item, items))
          .slice(0, item.liked !== true ? 6 : 3);
        const allowedFacts: HostContextPack["allowedFacts"] = [
          { id: `track:${item.id}:metadata`, value: `歌曲《${item.title}》，艺术家是${spokenArtist}。`, source: "user" },
          ...(item.album && !releaseTitlesMatch(item.title, item.album) ? [{ id: `track:${item.id}:album`, value: `《${item.title}》所属专辑是《${item.album}》。`, source: "user" as const }] : []),
          ...(item.releaseYear ? [{ id: `track:${item.id}:year`, value: `《${item.title}》发行于${item.releaseYear}年。`, source: "user" as const }] : []),
          ...relevantWebFacts.map((fact) => ({ id: fact.id, value: fact.value, source: "web" as const, sourceUrl: fact.sourceUrl })),
        ];
        return {
          trackIndex: index + 1,
          title: item.title,
          artist: spokenArtist,
          ...(item.album ? { album: item.album } : {}),
          ...(item.releaseYear ? { releaseYear: item.releaseYear } : {}),
          ...(item.credits ? { credits: item.credits } : {}),
          exploration: item.liked !== true,
          allowedFacts,
        };
      });
      let raw: unknown;
      try {
        raw = await Promise.resolve(researchProvider.generateShow({
          scenePreset: spec.scenePreset,
          frequency: spec.hostDensity,
          openingGreeting: radioGreetingAt(new Date()),
          hostProfile: spec.hostProfile ?? DEFAULT_HOST_PROFILE,
          tracks: showTracks,
          skillInstruction: radioHostSkill,
          reviewInstruction: radioHostReviewSkill,
          ...(listenerProfile ? { listenerProfile } : {}),
          ...(userAdjustment ? { userAdjustment } : {}),
        }, { signal }));
      } catch (error) {
        throw hostProviderFailure(error, "整档主持文案生成");
      }
      const result = isRecord(raw) ? raw : {};
      const breaks = Array.isArray(result.breaks) ? result.breaks.filter(isRecord) : [];
      if (result.success === true && result.fallback !== true && breaks.length > 0) {
        const byTrack = new Map<number, UnknownRecord>();
        for (const hostBreak of breaks) {
          const beforeTrackIndex = Number(hostBreak.beforeTrackIndex);
          if (Number.isInteger(beforeTrackIndex) && beforeTrackIndex >= 1 && beforeTrackIndex <= items.length) byTrack.set(beforeTrackIndex - 1, hostBreak);
        }
        const fallbackItems = createFinalHostScriptVersion(spec, items);
        return items.map((item, index) => {
          const hostBreak = byTrack.get(index);
          const fallbackItem = fallbackItems[index];
          const fallbackScript = fallbackItem?.hostScript;
          const required = index === 0 || index === items.length - 1;
          if (!hostBreak && (!required || !fallbackScript)) return { ...item, hostMoment: undefined, hostScript: undefined };
          const hostMoment: NonNullable<ProgramRundownItem["hostMoment"]> = index === 0 ? "opening" : index === items.length - 1 ? "song_note" : "next_preview";
          if (!hostBreak && fallbackScript) return { ...item, hostMoment, hostScript: fallbackScript };
          let text = typeof hostBreak?.text === "string" ? normalizeSpokenYearDigits(normalizeSpokenEnglishCase(hostBreak.text.trim())).slice(0, 600) : "";
          if (!text && fallbackScript) text = fallbackScript.text;
          if (index === items.length - 1 && !/最后一首|最后一曲|收官曲|收尾曲/.test(text)) text = `这是本档节目的最后一首。${text}`;
          const targetSeconds = typeof hostBreak?.targetSeconds === "number" && Number.isFinite(hostBreak.targetSeconds)
            ? Math.min(35, Math.max(5, Math.round(hostBreak.targetSeconds)))
            : (fallbackScript?.plannedDurationSeconds ?? (item.liked !== true ? 28 : 22));
          const factIds = Array.isArray(hostBreak?.sourceIds)
            ? hostBreak.sourceIds.filter((id): id is string => typeof id === "string")
            : (fallbackScript?.factIds ?? [`track:${item.id}:metadata`]);
          const hostScript: ProgramHostScript = {
            id: typeof hostBreak?.id === "string" ? hostBreak.id : randomUUID(),
            text,
            factIds,
            instruction: "whole-show writer and producer finalized",
            ...(typeof hostBreak?.deliveryInstruction === "string" ? { deliveryInstruction: hostBreak.deliveryInstruction.slice(0, 160) } : { deliveryInstruction: fallbackScript?.deliveryInstruction ?? "自然口语，音乐人和歌名说清楚。" }),
            hostMoment,
            generatedAt: typeof result.generatedAt === "string" ? result.generatedAt : nowIso(),
            plannedDurationSeconds: targetSeconds,
            musicBedDelaySeconds: HOST_MUSIC_START_DELAY_SECONDS,
          };
          return { ...item, hostMoment, hostScript };
        });
      }
      throw new ServiceError("HOST_PROVIDER_ERROR", 502, "整档口播未通过节目监制审核，未展示半成品。");
    }
    const legacyMoments = new Set(evenlySpacedHostBreakIndices(items.length, spec.hostDensity));
    items = items.map((item, index) => ({
      ...item,
      hostMoment: legacyMoments.has(index) ? (index === 0 ? "opening" : index === items.length - 1 ? "song_note" : "next_preview") : undefined,
    }));
    hostDurationTargets = planHostDurationTargets(items.filter((item) => Boolean(item.hostMoment)).map((item) => item.liked !== true));
    let elapsed = 0;
    let hostBreakIndex = 0;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      if (!item.hostMoment) {
        lockedItems.push(item);
        elapsed += item.durationSeconds;
        continue;
      }
      const fraction = totalSeconds > 0 ? elapsed / totalSeconds : 0;
      const isFinalTrack = index === items.length - 1;
      const programPhase: HostContextPack["programPhase"] = isFinalTrack ? "closing" : fraction < 0.12 ? "opening" : fraction < 0.55 ? "building" : fraction < 0.78 ? "peak" : fraction < 0.94 ? "cooldown" : "closing";
      const previous = index > 0 ? items[index - 1]! : null;
      const currentHostBreakIndex = hostBreakIndex;
      const isExploration = item.liked !== true;
      const requestedHostMode: HostBreakMode = hostBreakIndex === 0 || isFinalTrack
        ? "artist_spotlight"
        : isExploration
          ? "verified_story"
        : (["previous_review", "artist_spotlight", "verified_story", "artist_spotlight"] as const)[(hostBreakIndex - 1) % 4]!;
      hostBreakIndex += 1;
      const relevantWebFacts = webFacts.filter((fact) => {
        if (musicFactMatchesTrack(fact.value, item, items)) return true;
        return previous ? musicFactMatchesTrack(fact.value, previous, items) : false;
      }).slice(0, isExploration ? 6 : 4);
      const hostMode = requestedHostMode === "verified_story" && relevantWebFacts.length === 0
        ? "artist_spotlight"
        : requestedHostMode;
      const groundedTrack = hostMode === "previous_review" && previous ? previous : item;
      const spokenArtist = spokenArtistName(groundedTrack.artist);
      const spokenPrevious = previous ? { ...previous, artist: spokenArtistName(previous.artist) } : null;
      const spokenCurrent = { ...item, artist: spokenArtistName(item.artist) };
      const allowedFacts: HostContextPack["allowedFacts"] = [
        {
          id: `track:${groundedTrack.id}:metadata`,
          value: `${hostMode === "previous_review" ? "刚刚播完的歌曲" : "马上要播的歌曲"}《${groundedTrack.title}》，艺术家是${spokenArtist}。`,
          source: "user",
        },
        ...(groundedTrack.album && !releaseTitlesMatch(groundedTrack.title, groundedTrack.album) ? [{ id: `track:${groundedTrack.id}:album`, value: `《${groundedTrack.title}》所属专辑是《${groundedTrack.album}》。`, source: "user" as const }] : []),
        ...(previous && previous.id !== groundedTrack.id ? [{ id: `track:${previous.id}:previous`, value: `刚刚播完的是${spokenArtistName(previous.artist)}的《${previous.title}》。`, source: "user" as const }] : []),
        ...(profileForPrompt?.favoriteArtists.length ? [{ id: "profile:artists", value: `听众长期偏好的艺术家包括：${profileForPrompt.favoriteArtists.join("、")}。`, source: "user" as const }] : []),
        ...(profileForPrompt?.inferredThemes.length ? [{ id: "profile:themes", value: `听众画像中反复出现的音乐主题包括：${profileForPrompt.inferredThemes.join("、")}。`, source: "user" as const }] : []),
        ...relevantWebFacts.map((fact) => ({ id: fact.id, value: fact.value, source: "web" as const, sourceUrl: fact.sourceUrl })),
      ];
      const transitionReason = isFinalTrack
        ? `这是整档节目的最后一首。必须在开头明确告诉听众“这是最后一首”或同等清晰的结束提示，再用已核验事实介绍${spokenArtist}和《${groundedTrack.title}》；不要总结节目，不要说告别套话。`
        : hostMode === "previous_review"
          ? "点评刚播完的一首：只使用有证据的歌手背景、制作故事、唱腔、风格或经典影响；然后自然引向马上要播的一首，不谈更后面的歌。不要把作词作曲名单当点评主体。"
        : hostMode === "artist_spotlight"
          ? "聚焦马上要播的艺人：优先使用有来源的背景、风格、荣誉、成就、近况、歌迷称呼或公众评价；如果只有曲名、艺人和专辑元数据，就只做简洁介绍，不用场景话术凑字数，也不要谈资料不足。"
          : hostMode === "verified_story"
            ? "讲一个与马上要播歌曲或艺人直接相关、已有来源的故事或逸事；不要扩写资料之外的事实。"
            : "用风格、声音气质或有证据的故事线索做悬念预告；绝对不要说出马上要播的歌名或艺人，也不要谈更后面的歌。";
      const explorationDirection = isExploration
        ? "这是探索歌曲，听众可能不熟悉。优先解释音乐人是谁、作品怎么创作、风格与理念、经典成就、奖项或生涯意义、可靠公开轶事；没有对应事实就只介绍艺人、歌名和专辑。"
        : "这是熟悉歌曲，背景信息点到为止，避免重复用户已经知道的曲名和艺人。经典熟悉曲优先讲成就、影响或故事，不要只报作词作曲。";
      const hostProfile = HOST_PROFILES[spec.hostProfile ?? DEFAULT_HOST_PROFILE];
      const arrangementEnergy = item.arrangementTargetEnergy ?? item.energy;
      const previousArrangementEnergy = previous?.arrangementTargetEnergy ?? previous?.energy;
      const hostPlan = planHostBreak({
        mode: hostMode,
        scenePreset: spec.scenePreset,
        programPhase,
        previousTrack: previous ? { ...previous, energy: previousArrangementEnergy ?? previous.energy } : null,
        currentTrack: { ...item, energy: arrangementEnergy },
        facts: allowedFacts.map((fact) => fact.value),
        targetDurationSeconds: relevantWebFacts.length === 0 ? 15 : hostDurationTargets[currentHostBreakIndex],
      });
      const characterBounds = hostCharacterBounds(hostPlan.durationSeconds);
      const moodDirection = item.mood.length > 0 ? `平台提供的曲目氛围标签为${item.mood.join("、")}。` : "平台未提供可验证的曲目氛围标签，不要把节目氛围说成歌曲事实。";
      const emotionalDirection = `主持角色是${hostProfile.name}，表达特征为${hostProfile.trait}。${moodDirection}本段编排目标强度约${Math.round(arrangementEnergy * 100)}；${previous ? `上一段编排目标强度约${Math.round((previousArrangementEnergy ?? previous.energy) * 100)}。` : "这是节目开场。"}这里的强度是节目编排目标，不是平台测得的歌曲声学属性。口播必须跟随段落变化调整句长、力度和停顿，避免统一收尾。`;
      const hostContext: HostContextPack = {
          scenePreset: spec.scenePreset,
          programPhase,
          timeRemainingSeconds: Math.max(0, totalSeconds - elapsed),
          previousTrack: spokenPrevious,
          currentTrack: spokenCurrent,
          nextTrack: null,
          transitionReason: `${transitionReason}${explorationDirection}${emotionalDirection}这是整档第${currentHostBreakIndex + 1}/${hostDurationTargets.length}段口播。根据节目位置自然组织，不套固定的开头、转折和收尾结构；每句话都要增加一条音乐信息。${userAdjustment ? `用户对本档的调整要求：${userAdjustment.slice(0, 300)}。` : ""}本段目标${hostPlan.durationSeconds}秒、约${characterBounds.min}-${characterBounds.max}字；口播开始约${hostPlan.musicBedDelaySeconds}秒后，让待播歌曲前奏以${HOST_MUSIC_DUCK_DB} dB 的压低音量进入；口播结束后音乐在2秒内恢复正常音量。英文歌名、专辑名和艺人名使用正常首字母大写，不写成连续全大写。`,
          recentHostLines: recentHostLines.slice(-8),
          allowedFacts,
          forbiddenClaims: ["未经验证的音乐资料、新闻、用户感受或私人经历", "声音稳稳托住", "把注意力交给音乐", "把注意力交回", "音乐现在接上", "继续往前走", "先记住这两个名字", "不急着预判", "别着急把它收起来", "换一种开场", "注意最初几秒", "留意开场几秒", "先听第一拍", "让我们开始这段音乐", "探索位", "背景有点东西", "先听完再说", "别急着下结论", "看看合不合拍", "顺手认识一下", "马上播出"],
          isExploration,
          hostProfile: spec.hostProfile ?? DEFAULT_HOST_PROFILE,
          skillInstruction: radioHostSkill,
          reviewInstruction: radioHostReviewSkill,
          ...(listenerProfile ? { listenerProfile } : {}),
          hostMoment: item.hostMoment,
          hostLengthSeconds: hostPlan.durationSeconds,
      };
      let accepted: { result: UnknownRecord; text: string; factIds: string[] } | null = null;
      for (let attempt = 1; attempt <= HOST_SCRIPT_MAX_ATTEMPTS; attempt += 1) {
        if (signal.aborted) throw new ServiceError("REQUEST_ABORTED", 499, "请求已取消。");
        let raw: unknown;
        try {
          raw = await Promise.resolve(hostProvider.generate!(hostContext, { signal }));
        } catch (error) {
          if (attempt === HOST_SCRIPT_MAX_ATTEMPTS) {
            if (error instanceof ProviderError || error instanceof ServiceError) {
              throw hostProviderFailure(error, `第 ${index + 1} 首前的主持词生成`);
            }
            throw new ServiceError("HOST_PROVIDER_ERROR", 502, `主持词生成失败（第 ${index + 1} 首前，已重试 ${HOST_SCRIPT_MAX_ATTEMPTS} 次）。`);
          }
          continue;
        }
        const result = isRecord(raw) ? raw : {};
        const status = typeof result.status === "string" ? result.status : "failed";
        const text = typeof result.text === "string" ? result.text.trim() : "";
        const factIds = Array.isArray(result.factIds) ? result.factIds.filter((id): id is string => typeof id === "string").slice(0, 32) : [];
        const selectedFacts = factIds.map((id) => allowedFacts.find((fact) => fact.id === id)).filter((fact): fact is NonNullable<typeof fact> => Boolean(fact));
        const characterCount = Array.from(text).length;
        const cloudTextUsesOnlySelectedFacts = result.provider !== "openai-compatible" || textUsesOnlySelectedFacts(text, selectedFacts);
        const grounded = Boolean(selectedFacts.length > 0 && (text.includes(groundedTrack.title) || text.includes(spokenArtist)));
        const rejected = result.success !== true
          || !["generated", "ready", "playing"].includes(status)
          || !text
          || (result.provider === "openai-compatible" && (characterCount < characterBounds.min || characterCount > characterBounds.max))
          || !grounded
          || !cloudTextUsesOnlySelectedFacts
          || hasOnAirResearchDisclaimer(text)
          || hasUnbackedMusicClaim(text, selectedFacts)
          || hasRepeatedHostTemplate(text)
          || /[:：—]|不是.{0,24}而是/.test(text)
          || (result.provider === "openai-compatible" && isFinalTrack && !/最后一首|最后一曲|收官曲|收尾曲/.test(text))
          || (result.provider === "openai-compatible" && hostScriptRepeats(text, recentHostLines));
        if (rejected && result.provider === "openai-compatible") {
          const fallback = createGuaranteedHostFallback(hostContext);
          accepted = {
            result: { ...result, success: true, status: "ready", fallback: true, deliveryInstruction: fallback.deliveryInstruction },
            text: fallback.text,
            factIds: fallback.factIds,
          };
          break;
        }
        if (!rejected) {
          accepted = { result, text, factIds };
          break;
        }
        // The production provider already completed its writer-review rewrite
        // loop. Do not restart that loop or bypass its final rejection here.
        if (result.provider === "openai-compatible") break;
        if (text) hostContext.recentHostLines = [...recentHostLines, text].slice(-8);
      }
      if (!accepted) {
        throw new ServiceError("HOST_PROVIDER_ERROR", 502, `第 ${index + 1} 首前的口播未通过节目监制审核，整档文案未展示。`);
      }
      const { result, text, factIds } = accepted;
      const lockedText = normalizeSpokenYearDigits(normalizeSpokenEnglishCase(result.provider !== "openai-compatible" && isFinalTrack && !/最后一首|最后一曲|收官曲|收尾曲/.test(text)
        ? `这是本档节目的最后一首。${text}`
        : text));
      if (result.provider === "openai-compatible" && result.fallback !== true && hostScriptRepeats(lockedText, recentHostLines)) {
        throw new ServiceError("HOST_PROVIDER_ERROR", 502, `主持词与本档前文重复（第 ${index + 1} 首前）。`);
      }
      const hostScript: ProgramHostScript = {
        id: typeof result.id === "string" ? result.id : randomUUID(),
        text: lockedText.slice(0, 600),
        factIds,
        instruction: typeof result.instruction === "string" ? result.instruction.slice(0, 500) : "locked pre-show radio script",
        ...(typeof result.deliveryInstruction === "string" ? { deliveryInstruction: result.deliveryInstruction.slice(0, 160) } : {}),
        hostMoment: item.hostMoment,
        generatedAt: typeof result.generatedAt === "string" ? result.generatedAt : nowIso(),
        plannedDurationSeconds: hostPlan.durationSeconds,
        musicBedDelaySeconds: hostPlan.musicBedDelaySeconds,
      };
      recentHostLines.push(lockedText);
      lockedItems.push({ ...item, hostScript });
      elapsed += item.durationSeconds;
    }
    return lockedItems;
  };

  const prepareLockedHostAudio = async (
    spec: ProgramSpec,
    items: ProgramRundownItem[],
    signal: AbortSignal,
  ): Promise<{ items: ProgramRundownItem[]; audio: Map<string, LockedHostAudio> }> => {
    if (!ttsProvider || typeof ttsProvider.synthesize !== "function") {
      throw new ServiceError("TTS_PROVIDER_ERROR", 503, "主持语音服务不可用，无法完成开播准备。");
    }
    const targets = items.filter((item): item is ProgramRundownItem & { hostScript: ProgramHostScript } => Boolean(item.hostScript));
    if (targets.length === 0) throw new ServiceError("TTS_PROVIDER_ERROR", 502, "本次节目没有可预生成的主持语音。");
    const prepared = new Map<string, LockedHostAudio>();
    const ttsSnapshot = typeof ttsProvider.snapshot === "function" ? await ttsProvider.snapshot() : null;
    const batchTts = ttsSnapshot ?? ttsProvider;
    const batchController = new AbortController();
    const abortBatchFromParent = () => batchController.abort();
    signal.addEventListener("abort", abortBatchFromParent, { once: true });
    let totalBytes = 0;
    let cursor = 0;
    const synthesizeOne = async (item: ProgramRundownItem & { hostScript: ProgramHostScript }): Promise<void> => {
      if (signal.aborted) throw new ServiceError("REQUEST_ABORTED", 499, "请求已取消。");
      const controller = new AbortController();
      const abortFromBatch = () => controller.abort();
      batchController.signal.addEventListener("abort", abortFromBatch, { once: true });
      const timeout = setTimeout(() => controller.abort(), lockedTtsTimeoutMs);
      try {
        const raw = await Promise.race([
          Promise.resolve(batchTts.synthesize({
            text: normalizeSpokenYearDigits(normalizeSpokenEnglishCase(item.hostScript.text)),
            scenePreset: spec.scenePreset,
            hostProfile: spec.hostProfile ?? DEFAULT_HOST_PROFILE,
            instruction: hostTtsInstruction(spec.hostProfile ?? DEFAULT_HOST_PROFILE, item.hostScript.hostMoment, item.hostScript.deliveryInstruction),
            signal: controller.signal,
          })),
          new Promise<never>((_, reject) => {
            controller.signal.addEventListener("abort", () => reject(new ServiceError(signal.aborted ? "REQUEST_ABORTED" : "TTS_PROVIDER_ERROR", signal.aborted ? 499 : 504, signal.aborted ? "请求已取消。" : "主持语音预生成超时。")), { once: true });
          }),
        ]);
        if (controller.signal.aborted) {
          throw new ServiceError(signal.aborted ? "REQUEST_ABORTED" : "TTS_PROVIDER_ERROR", signal.aborted ? 499 : 504, signal.aborted ? "请求已取消。" : "主持语音预生成超时。");
        }
        const record = isRecord(raw) ? raw : {};
        const bytes = toBuffer(record.audio ?? record.buffer ?? record.audioBuffer ?? record.data ?? record.audioBase64 ?? record.base64);
        if (record.success !== true || record.status !== "ready" || !bytes || !hasSupportedAudioSignature(bytes)) {
          throw new ServiceError("TTS_PROVIDER_ERROR", 502, "主持语音预生成失败。");
        }
        if (bytes.length > MAX_AUDIO_BYTES) throw new ServiceError("TTS_AUDIO_TOO_LARGE", 413, publicMessage("TTS_AUDIO_TOO_LARGE"));
        totalBytes += bytes.length;
        if (totalBytes > MAX_LOCKED_HOST_AUDIO_BYTES) throw new ServiceError("TTS_AUDIO_TOO_LARGE", 413, "本次节目主持语音总大小超过限制。");
        prepared.set(item.id, { data: bytes, contentType: audioContentType(record, bytes), preparedAt: nowIso() });
      } catch (error) {
        if (error instanceof ServiceError) throw error;
        throw failFromUnknown(error, "TTS_PROVIDER_ERROR");
      } finally {
        clearTimeout(timeout);
        batchController.signal.removeEventListener("abort", abortFromBatch);
      }
    };
    const workers = Array.from({ length: Math.min(LOCKED_TTS_CONCURRENCY, targets.length) }, async () => {
      while (cursor < targets.length) {
        const target = targets[cursor++];
        if (target) await synthesizeOne(target);
      }
    });
    try {
      await Promise.all(workers);
      if (ttsSnapshot && !await ttsSnapshot.isCurrent()) {
        throw new ServiceError("TTS_PROVIDER_ERROR", 409, "语音配置在准备期间发生变化，请重新确认并生成统一声线。");
      }
    } catch (error) {
      batchController.abort();
      await Promise.allSettled(workers);
      throw error;
    } finally {
      signal.removeEventListener("abort", abortBatchFromParent);
    }
    const preparedItems = items.map((item) => {
      if (!item.hostScript) return item;
      const asset = prepared.get(item.id);
      if (!asset) throw new ServiceError("TTS_PROVIDER_ERROR", 502, "主持语音预生成不完整。");
      return { ...item, hostScript: { ...item.hostScript, audioReady: true, audioPreparedAt: asset.preparedAt } };
    });
    return { items: preparedItems, audio: prepared };
  };

  function hasUnbackedMusicClaim(text: string, facts: Array<{ value: string }>): boolean {
    const factualPhrases = text.match(/(?:(?:这首歌|这首作品|这段旋律|它|歌里|作品|歌词|旋律里|歌曲背后)[^，。！？；\n]{0,32}(?:写给|讲述|讲的是|表达|描写|刻画|记录|献给|灵感来自|关于|藏着|围绕|背后是)[^，。！？；\n]{0,32}|(?:歌|作品|歌词|旋律|创作|故事)[^，。！？；\n]{0,32}(?:爱情|遗憾|离别|重逢|成长|孤独|回忆|经历|关系|情感|灵感|背景|主题)|(?:来自|出生于|发行于|作词|作曲|是一首|被称为|获得|排名|榜单|爵士|摇滚|民谣|流行)[^，。！？；\n]{0,24})/g) ?? [];
    if (factualPhrases.length === 0) return false;
    const factTexts = facts.map((fact) => fact.value.replace(/[\s，。！？；：、“”"'《》·,.!?;:()[\]{}—-]/g, "").toLocaleLowerCase());
    return factualPhrases.some((phrase) => {
      const normalized = phrase.replace(/[\s，。！？；：、“”"'《》·,.!?;:()[\]{}—-]/g, "").toLocaleLowerCase();
      if (normalized.length <= 2) return false;
      return !factTexts.some((fact) => {
        if (fact.includes(normalized) || normalized.includes(fact)) return true;
        const claimPairs = new Set(Array.from({ length: Math.max(0, normalized.length - 1) }, (_, index) => normalized.slice(index, index + 2)));
        let overlap = 0;
        for (const pair of claimPairs) if (fact.includes(pair)) overlap += 1;
        return overlap >= 2 && overlap / Math.max(1, claimPairs.size) >= 0.2;
      });
    });
  }

  function textUsesOnlySelectedFacts(_text: string, facts: Array<{ value: string }>): boolean {
    return facts.length > 0;
  }

  function hasOnAirResearchDisclaimer(text: string): boolean {
    return /(?:没有|缺少|未有|无法|未能|没能)(?:更多|足够|可靠|可核验|相关)?(?:资料|信息|依据|证据)|不(?:急着|替它|为它)?(?:贴标签|补写|添剧情)|现有资料|手边没有/.test(text);
  }

  function hasRepeatedHostTemplate(text: string): boolean {
    return /(?:声音稳稳托住|把注意力交给音乐|把注意力交回|音乐现在接上|继续往前走|先记住这两个名字|不急着预判|根据资料|值得一提|接下来请欣赏|探索位|背景有点东西|先听完再说|别急着下结论|看看合不合拍|顺手认识一下|马上播出)/.test(text);
  }

  const provisionNeteasePlaylist = async (
    programId: string,
    spec: ProgramSpec,
    items: ProgramRundownItem[],
    signal: AbortSignal,
  ): Promise<ProgramPlaylistReceipt> => {
    const assertNotAborted = (): void => {
      if (signal.aborted) throw new ServiceError("REQUEST_ABORTED", 499, "请求已取消，未继续写入网易云账号。");
    };
    assertNotAborted();
    const provider = await requireNetease();
    if (typeof provider.createPlaylist !== "function" || typeof provider.addSongsToPlaylist !== "function" || typeof provider.playlistDetail !== "function") {
      throw new ServiceError("NETEASE_UNAVAILABLE", 503, "当前网易云适配器尚未接入歌单写入能力。");
    }
    let receipt = neteasePlaylists.get(programId);
    const existingReceipt = Boolean(receipt);
    if (!receipt) {
      let name = neteasePlaylistNames.get(programId);
      const storedName = Boolean(name);
      let recoveredId: string | null = null;
      let existingNames = new Set<string>();
      if (typeof provider.account === "function" && typeof provider.userPlaylists === "function") {
        assertNotAborted();
        const account = await invokeNeteaseStage("读取账号", () => provider.account!(signal));
        assertNotAborted();
        if (isRecord(account) && typeof account.uid === "string") {
          const uid = account.uid;
          const playlists = await invokeNeteaseStage("读取歌单", () => provider.userPlaylists!(uid, { limit: 100, offset: 0, signal }));
          assertNotAborted();
          const rows = isRecord(playlists) && Array.isArray(playlists.playlists) ? playlists.playlists : [];
          existingNames = new Set(rows.flatMap((playlist) => isRecord(playlist) && typeof playlist.name === "string" ? [playlist.name] : []));
          const match = storedName && !uncertainNeteasePlaylistCreates.has(programId)
            ? rows.find((playlist) => isRecord(playlist) && playlist.name === name && typeof playlist.id === "string")
            : undefined;
          if (isRecord(match) && typeof match.id === "string") {
            recoveredId = match.id;
            uncertainNeteasePlaylistCreates.delete(programId);
          }
        }
      }
      if (!name) {
        for (const usedName of neteasePlaylistNames.values()) existingNames.add(usedName);
        name = programPlaylistName(programId, spec, "netease", existingNames);
        neteasePlaylistNames.set(programId, name);
      }
      if (!recoveredId) {
        if (uncertainNeteasePlaylistCreates.has(programId)) {
          throw new ServiceError("NETEASE_PLAYLIST_CREATE_UNCERTAIN", 409, "上次创建歌单的结果尚未能从账号读回；为避免重复歌单，本次不会再次创建，请稍后重试。");
        }
        assertNotAborted();
        let created: unknown;
        try {
          created = await invokeNeteaseStage("创建节目歌单", () => provider.createPlaylist!(name, signal));
        } catch (error) {
          uncertainNeteasePlaylistCreates.add(programId);
          throw error;
        }
        if (!isRecord(created) || typeof created.id !== "string") {
          uncertainNeteasePlaylistCreates.add(programId);
          throw new ServiceError("NETEASE_PROVIDER_ERROR", 502, "网易云没有返回已创建歌单的 ID。");
        }
        uncertainNeteasePlaylistCreates.delete(programId);
        recoveredId = created.id;
      }
      receipt = { provider: "netease_music", id: recoveredId, name, trackCount: 0, status: "created", retention: neteasePlaylistKeepRequests.has(programId) ? "kept" : "temporary" };
      neteasePlaylists.set(programId, receipt);
    }
    if (receipt.status === "ready") return receipt;
    const trackIds = items.map((item) => item.id);
    let missingTrackIds = trackIds;
    if (existingReceipt) {
      const detail = await invokeNeteaseStage("读取节目歌单", () => provider.playlistDetail!(receipt!.id, signal));
      const existingIds = new Set(
        isRecord(detail) && Array.isArray(detail.tracks)
          ? detail.tracks.flatMap((track) => isRecord(track) && typeof track.id === "string" ? [track.id] : [])
          : [],
      );
      missingTrackIds = trackIds.filter((id) => !existingIds.has(id));
      if (missingTrackIds.length === 0) {
        receipt = { ...receipt, trackCount: trackIds.length, status: "ready" };
        neteasePlaylists.set(programId, receipt);
        return receipt;
      }
    }
    try {
      assertNotAborted();
      await invokeNeteaseStage("写入节目歌曲", () => provider.addSongsToPlaylist!(receipt!.id, missingTrackIds, signal));
      assertNotAborted();
      let verifiedTrackCount = trackIds.length;
      const detail = await invokeNeteaseStage("验证节目歌曲", () => provider.playlistDetail!(receipt!.id, signal));
      assertNotAborted();
      const actualIds = new Set(
        isRecord(detail) && Array.isArray(detail.tracks)
          ? detail.tracks.flatMap((track) => isRecord(track) && typeof track.id === "string" ? [track.id] : [])
          : [],
      );
      verifiedTrackCount = trackIds.filter((id) => actualIds.has(id)).length;
      if (verifiedTrackCount !== trackIds.length) {
        receipt = { ...receipt, trackCount: verifiedTrackCount, status: "partial" };
        neteasePlaylists.set(programId, receipt);
        throw new ServiceError("NETEASE_PROVIDER_ERROR", 502, `网易云歌单只确认写入 ${verifiedTrackCount}/${trackIds.length} 首歌曲。`);
      }
      receipt = { ...receipt, trackCount: verifiedTrackCount, status: "ready" };
      neteasePlaylists.set(programId, receipt);
      return receipt;
    } catch (error) {
      neteasePlaylists.set(programId, { ...receipt, status: "partial" });
      throw error;
    }
  };

  const provisionQqPlaylist = async (
    programId: string,
    spec: ProgramSpec,
    items: ProgramRundownItem[],
    expectedUid: string,
    signal: AbortSignal,
  ): Promise<ProgramPlaylistReceipt> => {
    const assertNotAborted = (): void => {
      if (signal.aborted) throw new ServiceError("REQUEST_ABORTED", 499, "请求已取消，未继续写入 QQ 音乐账号。");
    };
    assertNotAborted();
    const provider = await requireQq();
    if (typeof provider.createPlaylist !== "function" || typeof provider.addSongsToPlaylist !== "function" || typeof provider.playlistDetail !== "function") {
      throw new ServiceError("QQ_UNAVAILABLE", 503, "当前 QQ 音乐适配器尚未接入歌单写入能力。");
    }
    let receipt = accountPlaylists.get(programId);
    const existingReceipt = Boolean(receipt);
    if (!receipt) {
      let name = accountPlaylistNames.get(programId);
      const storedName = Boolean(name);
      let recoveredId: string | null = null;
      let recoveredDirId: string | null = null;
      let existingNames = new Set<string>();
      if (typeof provider.account === "function" && typeof provider.userPlaylists === "function") {
        const account = await invokeAccountStage("qq", "读取账号", () => provider.account!(signal));
        assertNotAborted();
        if (isRecord(account) && typeof account.uid === "string") {
          if (account.uid !== expectedUid) throw new ServiceError("ACCOUNT_CHANGED", 409, "QQ 音乐账号已经变化，请退出本次节目后重新生成。");
          const rows: unknown[] = [];
          let playlistInventoryComplete = false;
          for (let offset = 0; offset < 1_000; offset += 100) {
            const playlists = await invokeAccountStage("qq", "读取歌单", () => provider.userPlaylists!(account.uid as string, { limit: 100, offset, signal }));
            const page = isRecord(playlists) && Array.isArray(playlists.playlists) ? playlists.playlists : [];
            rows.push(...page);
            if (!isRecord(playlists) || playlists.more !== true) {
              playlistInventoryComplete = true;
              break;
            }
            if (page.length === 0) break;
          }
          if (!playlistInventoryComplete) {
            throw new ServiceError("QQ_PROVIDER_ERROR", 503, "QQ 音乐歌单清单未完整，本次未创建新歌单。");
          }
          existingNames = new Set(rows.flatMap((row) => isRecord(row) && typeof row.name === "string" ? [row.name] : []));
          // An ambiguous create must be recoverable by its exact deterministic
          // name. The high-entropy program-derived suffix makes this lookup
          // safer than issuing a second create (which would duplicate a list).
          const match = storedName
            ? rows.find((row) => isRecord(row) && row.name === name && (typeof row.tid === "string" || typeof row.tid === "number"))
            : undefined;
          if (isRecord(match)
            && (typeof match.tid === "string" || typeof match.tid === "number")
            && (typeof match.dirId === "string" || typeof match.dirId === "number")) {
            recoveredId = String(match.tid);
            recoveredDirId = String(match.dirId);
            uncertainAccountPlaylistCreates.delete(programId);
          }
        }
      }
      if (!name) {
        for (const used of accountPlaylistNames.values()) existingNames.add(used);
        name = programPlaylistName(programId, spec, "qq", existingNames);
        accountPlaylistNames.set(programId, name);
      }
      if (!recoveredId) {
        if (uncertainAccountPlaylistCreates.has(programId)) {
          throw new ServiceError("QQ_PLAYLIST_CREATE_UNCERTAIN", 409, "上次创建 QQ 节目歌单的结果尚未能从账号读回；为避免重复歌单，本次不会再次创建，请稍后重试。");
        }
        let created: unknown;
        try {
          created = await invokeAccountStage("qq", "创建节目歌单", () => provider.createPlaylist!(name!, signal, { expectedUid }));
        } catch (error) {
          uncertainAccountPlaylistCreates.add(programId);
          throw error;
        }
        if (!isRecord(created)
          || !(typeof created.id === "string" || typeof created.id === "number")
          || !(typeof created.dirId === "string" || typeof created.dirId === "number")) {
          uncertainAccountPlaylistCreates.add(programId);
          throw new ServiceError("QQ_PROVIDER_ERROR", 502, "QQ 音乐没有返回已创建歌单的 TID 和 dirId。");
        }
        uncertainAccountPlaylistCreates.delete(programId);
        recoveredId = String(created.id);
        recoveredDirId = String(created.dirId);
      }
      receipt = { provider: "qq_music", id: recoveredId, idKind: "tid", dirId: recoveredDirId!, name: name!, trackCount: 0, status: "created", retention: accountPlaylistKeepRequests.has(programId) ? "kept" : "temporary" };
      accountPlaylists.set(programId, receipt);
    }
    if (receipt.status === "ready") return receipt;
    if (receipt.idKind !== "tid") {
      throw new ServiceError("PROGRAM_ARTIFACT_MISSING", 409, "旧版 QQ 节目草稿缺少歌单 TID，不能安全继续写入；请退出后重新创建节目。");
    }
    const trackIds = items.map((item) => item.id);
    const readbackTrackIds = (detail: unknown): string[] => isRecord(detail) && Array.isArray(detail.tracks)
      ? detail.tracks.flatMap((track) => isRecord(track) && (typeof track.id === "string" || typeof track.id === "number") ? [String(track.id)] : [])
      : [];
    const hasExactTrackOrder = (detail: unknown): boolean => {
      const actualIds = readbackTrackIds(detail);
      return actualIds.length === trackIds.length && actualIds.every((id, index) => id === trackIds[index]);
    };
    let missingTrackIds = trackIds;
    if (!receipt.dirId) {
      const detail = await invokeAccountStage("qq", "读取节目歌单", () => provider.playlistDetail!(receipt!.id, signal));
      if (!isRecord(detail) || !(typeof detail.dirId === "string" || typeof detail.dirId === "number")) {
        throw new ServiceError("PROGRAM_ARTIFACT_MISSING", 409, "QQ 节目草稿缺少歌单 dirId，不能安全写入；请退出后重新创建节目。");
      }
      receipt = { ...receipt, dirId: String(detail.dirId) };
      accountPlaylists.set(programId, receipt);
    }
    if (existingReceipt) {
      const detail = await invokeAccountStage("qq", "读取节目歌单", () => provider.playlistDetail!(receipt!.id, signal));
      const existingIds = new Set(readbackTrackIds(detail));
      missingTrackIds = trackIds.filter((id) => !existingIds.has(id));
      if (missingTrackIds.length === 0) {
        if (!hasExactTrackOrder(detail)) {
          if (typeof provider.replacePlaylistTracks !== "function") {
            const partial = { ...receipt, trackCount: trackIds.filter((id) => existingIds.has(id)).length, status: "partial" as const };
            accountPlaylists.set(programId, partial);
            throw new ServiceError("QQ_PROVIDER_ERROR", 502, "QQ 音乐节目歌单的歌曲顺序与锁定计划不一致。");
          }
          await invokeAccountStage("qq", "修复节目歌单顺序", () => provider.replacePlaylistTracks!(receipt!.id, trackIds, signal, { dirId: receipt!.dirId!, expectedUid }));
          const repaired = await invokeAccountStage("qq", "验证节目歌单顺序", () => provider.playlistDetail!(receipt!.id, signal));
          if (!hasExactTrackOrder(repaired)) {
            const partial = { ...receipt, trackCount: readbackTrackIds(repaired).length, status: "partial" as const };
            accountPlaylists.set(programId, partial);
            throw new ServiceError("QQ_PROVIDER_ERROR", 502, "QQ 音乐节目歌单的歌曲顺序修复失败。");
          }
          receipt = { ...receipt, trackCount: trackIds.length, status: "ready" };
          accountPlaylists.set(programId, receipt);
          return receipt;
        }
        receipt = { ...receipt, trackCount: trackIds.length, status: "ready" };
        accountPlaylists.set(programId, receipt);
        return receipt;
      }
    }
    try {
      assertNotAborted();
      await invokeAccountStage("qq", "写入节目歌曲", () => provider.addSongsToPlaylist!(receipt!.id, missingTrackIds, signal, { dirId: receipt!.dirId!, expectedUid }));
      assertNotAborted();
      let detail = await invokeAccountStage("qq", "验证节目歌曲", () => provider.playlistDetail!(receipt!.id, signal));
      let actualIds = new Set(readbackTrackIds(detail));
      let verifiedTrackCount = trackIds.filter((id) => actualIds.has(id)).length;
      if (verifiedTrackCount === trackIds.length && !hasExactTrackOrder(detail) && typeof provider.replacePlaylistTracks === "function") {
        await invokeAccountStage("qq", "修复节目歌单顺序", () => provider.replacePlaylistTracks!(receipt!.id, trackIds, signal, { dirId: receipt!.dirId!, expectedUid }));
        detail = await invokeAccountStage("qq", "验证节目歌单顺序", () => provider.playlistDetail!(receipt!.id, signal));
        actualIds = new Set(readbackTrackIds(detail));
        verifiedTrackCount = trackIds.filter((id) => actualIds.has(id)).length;
      }
      if (verifiedTrackCount !== trackIds.length || !hasExactTrackOrder(detail)) {
        const partial = { ...receipt, trackCount: verifiedTrackCount, status: "partial" as const };
        accountPlaylists.set(programId, partial);
        const message = verifiedTrackCount !== trackIds.length
          ? `QQ 音乐歌单只确认写入 ${verifiedTrackCount}/${trackIds.length} 首歌曲。`
          : "QQ 音乐节目歌单的歌曲顺序与锁定计划不一致。";
        throw new ServiceError("QQ_PROVIDER_ERROR", 502, message);
      }
      receipt = { ...receipt, trackCount: verifiedTrackCount, status: "ready" };
      accountPlaylists.set(programId, receipt);
      return receipt;
    } catch (error) {
      accountPlaylists.set(programId, { ...receipt, status: "partial" });
      throw error;
    }
  };

  const keepAccountPlaylist = (programId: string): ProgramPlaylistReceipt | null => {
    accountPlaylistKeepRequests.add(programId);
    const receipt = accountPlaylists.get(programId);
    if (!receipt || receipt.status === "deleted" || receipt.status === "delete_failed") return receipt ?? null;
    const kept = { ...receipt, retention: "kept" as const };
    accountPlaylists.set(programId, kept);
    return kept;
  };

  const cleanupTemporaryAccountPlaylist = async (state: ProgramState | null): Promise<void> => {
    if (!state || (state.spec.sourceId !== "netease_music" && state.spec.sourceId !== "qq_music")) return;
    const receipt = accountPlaylists.get(state.id);
    if (!receipt || receipt.retention === "kept" || receipt.status === "deleted" || receipt.status === "delete_failed") return;
    const artifact = accountRundowns.get(state.id);
    const markFailure = () => {
      accountPlaylists.set(state.id, { ...receipt, status: "delete_failed", retention: "temporary" });
    };
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12_000);
      try {
        if (receipt.provider === "netease_music") {
          const provider = await requireNetease();
          if (typeof provider.deletePlaylist !== "function") {
            markFailure();
            return;
          }
          if (typeof provider.account === "function" && artifact?.accountUid) {
            const currentAccount = await invokeAccountStage("netease", "核对账号", () => provider.account!(controller.signal));
            if (!isRecord(currentAccount) || currentAccount.uid !== artifact.accountUid) {
              markFailure();
              return;
            }
          }
          await invokeNeteaseStage("删除临时节目歌单", () => provider.deletePlaylist!(receipt.id, controller.signal));
        } else {
          const provider = await requireQq();
          if (typeof provider.deletePlaylist !== "function" || !receipt.dirId || !artifact?.accountUid) {
            markFailure();
            return;
          }
          const currentAccount = typeof provider.account === "function"
            ? await invokeAccountStage("qq", "核对账号", () => provider.account!(controller.signal))
            : null;
          if (!isRecord(currentAccount) || currentAccount.uid !== artifact.accountUid) {
            markFailure();
            return;
          }
          await invokeAccountStage("qq", "删除临时节目歌单", () => provider.deletePlaylist!(receipt.id, controller.signal, { dirId: receipt.dirId!, expectedUid: artifact.accountUid! }));
        }
      } finally {
        clearTimeout(timeout);
      }
      const latest = accountPlaylists.get(state.id) ?? receipt;
      if (latest.retention !== "kept") accountPlaylists.set(state.id, { ...latest, status: "deleted", retention: "temporary" });
    } catch {
      markFailure();
    }
  };

  const handleHostPreview = async (body: UnknownRecord, signal?: AbortSignal): Promise<UnknownRecord> => {
    const lockedProgramId = typeof body.programId === "string" ? validateProgramId(body.programId) : null;
    const lockedTrackId = typeof body.trackId === "string" ? body.trackId : null;
    let context: HostContextPack;
    let hostResult: unknown;
    let lockedAudio: LockedHostAudio | undefined;
    let hostProfile: HostProfileId = DEFAULT_HOST_PROFILE;
    if (lockedProgramId && lockedTrackId) {
      const state = assertProgram(lockedProgramId);
      const generation = generationFromBody(body, true);
      assertGeneration(state, generation);
      hostProfile = state.spec.hostProfile ?? DEFAULT_HOST_PROFILE;
      if (!["preparing", "on_air", "closing"].includes(state.status)) {
        throw new ServiceError("PROGRAM_NOT_ACTIVE", 409, "节目尚未开播或已经结束，不能合成主持语音。");
      }
    const rundown = accountRundowns.get(lockedProgramId);
      const item = rundown?.items[rundown.index];
      if (!item || item.id !== lockedTrackId) {
        throw new ServiceError("HOST_SCRIPT_NOT_CURRENT", 409, "只能播放当前曲目的已锁定主持文案。");
      }
      if (!item?.hostScript) throw new ServiceError("HOST_SCRIPT_NOT_FOUND", 404, "本首歌曲没有已锁定的主持文案。");
      lockedAudio = rundown.hostAudio.get(item.id);
      if (!lockedAudio || item.hostScript.audioReady !== true) {
        throw new ServiceError("PROGRAM_ARTIFACT_MISSING", 409, "本首主持语音尚未完成，节目不能开播。");
      }
      const index = rundown.index;
      context = {
        scenePreset: state.spec.scenePreset,
        programPhase: "building",
        timeRemainingSeconds: state.remainingSeconds,
        previousTrack: index > 0 ? rundown!.items[index - 1] : null,
        currentTrack: item,
        nextTrack: rundown?.items[index + 1] ?? null,
        transitionReason: "播放开播前已锁定的主持文案",
        recentHostLines: state.recentHostLines,
        allowedFacts: [],
        forbiddenClaims: [],
        hostMoment: item.hostScript.hostMoment,
        hostLengthSeconds: 18,
      };
      hostResult = { ...item.hostScript, status: "ready", success: true, configured: true, mock: false };
    } else {
      const contextValue = body.context ?? body;
      context = validateContext(contextValue);
    }
    const generateHost = hostProvider?.generate;
    if (!hostResult && typeof generateHost !== "function") {
      hostResult = { status: "blocked_by_credentials", configured: false, text: null };
    } else if (!hostResult) {
      try {
        hostResult = await Promise.resolve(generateHost!.call(hostProvider, context, { signal }));
      } catch (error) {
        const serviceError = failFromUnknown(error, "HOST_PROVIDER_ERROR");
        hostResult = { status: "failed_technical", configured: providerConfigured(hostProvider as unknown as UnknownRecord, ["OPENAI_API_KEY"]), errorCode: serviceError.code, text: null };
      }
    }
    if (typeof hostResult === "string") hostResult = { text: null, status: "failed_unverified", success: false };
    const rawHost = isRecord(hostResult) ? hostResult : {};
    const hostStatus = typeof rawHost.status === "string" ? rawHost.status.slice(0, 64) : "failed";
    const hostSucceeded = rawHost.success === true && ["generated", "ready", "playing"].includes(hostStatus);
    const result: UnknownRecord = {
      ...(typeof rawHost.id === "string" && rawHost.id.length <= 128 ? { id: rawHost.id } : {}),
      status: hostStatus,
      ...(typeof rawHost.configured === "boolean" ? { configured: rawHost.configured } : {}),
      ...(typeof rawHost.mock === "boolean" ? { mock: rawHost.mock } : {}),
      ...(typeof rawHost.success === "boolean" ? { success: rawHost.success } : {}),
      text: hostSucceeded && typeof rawHost.text === "string" ? rawHost.text.slice(0, 4000) : null,
      factIds: Array.isArray(rawHost.factIds) ? rawHost.factIds.filter((factId): factId is string => typeof factId === "string" && factId.length <= 128).slice(0, 32) : [],
      ...(typeof rawHost.instruction === "string" ? { instruction: rawHost.instruction.slice(0, 500) } : {}),
      ...(typeof rawHost.deliveryInstruction === "string" ? { deliveryInstruction: rawHost.deliveryInstruction.slice(0, 160) } : {}),
      ...(typeof rawHost.generatedAt === "string" ? { generatedAt: rawHost.generatedAt } : {}),
      ...(typeof rawHost.model === "string" ? { model: rawHost.model.slice(0, 128) } : {}),
      ...(typeof rawHost.apiMode === "string" ? { apiMode: rawHost.apiMode.slice(0, 64) } : {}),
    };
    if (isRecord(rawHost.error)) {
      const errorCode = typeof rawHost.error.code === "string" && /^[a-z0-9_]{1,64}$/.test(rawHost.error.code) ? rawHost.error.code : "provider_error";
      result.error = {
        code: errorCode,
        ...(typeof rawHost.error.provider === "string" ? { provider: rawHost.error.provider.slice(0, 64) } : {}),
        ...(typeof rawHost.error.retryable === "boolean" ? { retryable: rawHost.error.retryable } : {}),
      };
    }
    const text = typeof result.text === "string" ? normalizeSpokenYearDigits(normalizeSpokenEnglishCase(result.text)).slice(0, 600) : "";
    if (text) result.text = text;
    let audioResponse: UnknownRecord = { status: "unavailable", audioId: null, url: null, audioUrl: null };
    if (text && lockedAudio) {
      const id = randomUUID();
      const expiresAt = Date.now() + AUDIO_TTL_MS;
      audio.set(id, { data: lockedAudio.data, contentType: lockedAudio.contentType, expiresAt });
      audioResponse = { status: "ready", audioId: id, url: `/api/audio/${id}`, audioUrl: `/api/audio/${id}`, expiresAt: new Date(expiresAt).toISOString(), preparedAt: lockedAudio.preparedAt };
    } else if (text && ttsProvider && typeof ttsProvider.synthesize === "function") {
      const ttsController = new AbortController();
      const abortTtsFromCaller = () => ttsController.abort();
      signal?.addEventListener("abort", abortTtsFromCaller, { once: true });
      let ttsTimeout: ReturnType<typeof setTimeout> | null = null;
      try {
        const raw = await Promise.race([
          Promise.resolve(ttsProvider.synthesize({
            text: normalizeSpokenYearDigits(normalizeSpokenEnglishCase(text)),
            scenePreset: context.scenePreset,
            hostProfile,
            instruction: hostTtsInstruction(
              hostProfile,
              context.hostMoment,
              typeof rawHost.deliveryInstruction === "string" ? rawHost.deliveryInstruction.slice(0, 160) : undefined,
            ),
            signal: ttsController.signal,
          })),
          new Promise<never>((_, reject) => {
            ttsTimeout = setTimeout(() => {
              ttsController.abort();
              reject(new ServiceError("TTS_PROVIDER_ERROR", 504, "主持语音合成超时，请重试。"));
            }, lockedTtsTimeoutMs);
          }),
        ]);
        const ttsRecord = isRecord(raw) ? raw : {};
        const bytes = toBuffer(ttsRecord.audio ?? ttsRecord.buffer ?? ttsRecord.audioBuffer ?? ttsRecord.data ?? ttsRecord.audioBase64 ?? ttsRecord.base64);
        const ttsSucceeded = ttsRecord.success === true && ttsRecord.status === "ready";
        if (ttsSucceeded && bytes && hasSupportedAudioSignature(bytes)) {
          if (bytes.length > MAX_AUDIO_BYTES) throw new ServiceError("TTS_AUDIO_TOO_LARGE", 413, publicMessage("TTS_AUDIO_TOO_LARGE"));
          const id = randomUUID();
          const expiresAt = Date.now() + AUDIO_TTL_MS;
          audio.set(id, { data: bytes, contentType: audioContentType(ttsRecord, bytes), expiresAt });
          audioResponse = { status: "ready", audioId: id, url: `/api/audio/${id}`, audioUrl: `/api/audio/${id}`, expiresAt: new Date(expiresAt).toISOString() };
        } else {
          audioResponse = {
            status: ttsRecord.success === false || (bytes && !hasSupportedAudioSignature(bytes))
              ? "failed_technical"
              : typeof ttsRecord.status === "string" ? ttsRecord.status : providerConfigured(ttsProvider as unknown as UnknownRecord, ["DASHSCOPE_API_KEY"]) ? "failed_technical" : "blocked_by_credentials",
            audioId: null,
            url: null,
            audioUrl: null,
          };
        }
      } catch (error) {
        const serviceError = failFromUnknown(error, "TTS_PROVIDER_ERROR");
        audioResponse = { status: serviceError.code === "TTS_AUDIO_TOO_LARGE" ? serviceError.code : "failed_technical", audioId: null, url: null, audioUrl: null, errorCode: serviceError.code };
      } finally {
        if (ttsTimeout) clearTimeout(ttsTimeout);
        signal?.removeEventListener("abort", abortTtsFromCaller);
      }
    } else if (!ttsProvider || typeof ttsProvider.synthesize !== "function") {
      audioResponse = { status: "blocked_by_credentials", audioId: null, url: null, audioUrl: null };
    }
    pruneAudio(audio);
    return { host: result, audio: audioResponse };
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    applyCors(req, res);
    if (!requestOriginAllowed(req)) throw new ServiceError("CORS_ORIGIN_NOT_ALLOWED", 403, publicMessage("CORS_ORIGIN_NOT_ALLOWED"));
    const parsedUrl = asRequestPath(req);
    const pathname = parsedUrl.pathname;
    const method = req.method ?? "GET";
    if (method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }
    const segments = pathname.split("/").filter(Boolean);
    if (method === "GET" && segments.length === 3 && segments[0] === "api" && segments[1] === "fixtures") {
      const fixtureFile = segments[2];
      if (!/^fixture-[A-Za-z0-9_-]+\.wav$/.test(fixtureFile)) {
        throw new ServiceError("AUDIO_NOT_FOUND", 404, publicMessage("AUDIO_NOT_FOUND"));
      }
      const trackId = validateProgramId(fixtureFile.slice(0, -4));
      if (!FIXTURE_TRACK_IDS.has(trackId)) throw new ServiceError("AUDIO_NOT_FOUND", 404, publicMessage("AUDIO_NOT_FOUND"));
      const data = fixtureAudioFor(trackId);
      res.statusCode = 200;
      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.setHeader("X-Fixture-Audio", "true");
      res.setHeader("Content-Length", data.length);
      res.end(data);
      return;
    }
    if (method === "GET" && segments.length === 3 && segments[0] === "api" && (segments[1] === "audio" || segments[1] === "tts")) {
      handleAudio(res, validateProgramId(segments[2]));
      return;
    }
    if (method === "GET" && pathname === "/api/health") {
      const hostConfigured = providerConfigured(hostProvider as unknown as UnknownRecord | undefined, ["OPENAI_API_KEY"]);
      const ttsConfigured = providerConfigured(ttsProvider as unknown as UnknownRecord | undefined, ["DASHSCOPE_API_KEY"]);
      writeJson(res, 200, {
        ok: true,
        status: "ok",
        version,
        startedAt: new Date(startedAt).toISOString(),
        checkedAt: nowIso(),
        uptimeMs: Math.max(0, Date.now() - startedAt),
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        providers: {
          host: { configured: hostConfigured, state: providerState(hostProvider as unknown as UnknownRecord | undefined, hostConfigured, "blocked_by_credentials"), ...providerMetadata(hostProvider) },
          tts: { configured: ttsConfigured, state: providerState(ttsProvider as unknown as UnknownRecord | undefined, ttsConfigured, "blocked_by_credentials"), ...providerMetadata(ttsProvider) },
        },
      });
      return;
    }
    if (method === "GET" && pathname === "/api/ai/config") {
      assertPlayerControlAuthorized(req);
      writeJson(res, 200, { config: await aiConfigStore.status() });
      return;
    }
    if (method === "GET" && pathname === "/api/access/status") {
      assertPlayerControlAuthorized(req);
      writeJson(res, 200, { access: await cloudAccessStore.status({ verify: parsedUrl.searchParams.get("verify") === "1" }) });
      return;
    }
    if (method === "GET" && pathname === "/api/device/status") {
      assertPlayerControlAuthorized(req);
      writeJson(res, 200, {
        storage: { audio: audioStorageStats(), profiles: await profileStorageStats() },
        desktopPet: await readDesktopPetPreferences(),
      });
      return;
    }
    if (method === "GET" && pathname === "/api/device/diagnostics") {
      assertPlayerControlAuthorized(req);
      writeJson(res, 200, {
        generatedAt: nowIso(),
        application: { version, uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000), platform: process.platform, arch: process.arch },
        service: { ok: true, host: DEFAULT_HOST, port: actualPort },
        providers: { qq: await qqStatus(), netease: await neteaseStatus(), ai: await aiConfigStore.status() },
        storage: { audio: audioStorageStats(), profiles: await profileStorageStats() },
        desktopPet: await readDesktopPetPreferences(),
        recentRequests: diagnosticEvents.slice(-50),
      });
      return;
    }
    if (method === "GET" && pathname === "/api/programs/progress") {
      assertPlayerControlAuthorized(req);
      const operationId = nonEmptyString(parsedUrl.searchParams.get("operationId"), "operationId", MAX_OPERATION_ID_LENGTH);
      const progress = createProgress.get(operationId);
      if (!progress) throw new ServiceError("NOT_FOUND", 404, publicMessage("NOT_FOUND"));
      writeJson(res, 200, { progress });
      return;
    }
    if (method === "GET" && pathname === "/api/sources") {
      const sources = buildSourceDiagnostics();
      const qq = await qqStatus();
      const qqIndex = sources.findIndex((source) => source.sourceId === "qq_music");
      if (qqApiEnabled && qqIndex >= 0) {
        const configured = qq.configured === true;
        const authenticated = qq.authenticated === true;
        sources[qqIndex] = {
          ...sources[qqIndex]!,
          playbackReady: configured && authenticated,
          hostedProgramAllowed: configured && authenticated,
          accountConnected: authenticated,
          state: !configured ? "blocked_by_credentials" : !authenticated ? "missing_credentials" : "ready",
          detail: !configured ? "QQ 音乐 API 尚未配置。" : !authenticated ? "请使用手机 QQ 音乐 App 扫码连接账号。" : "QQ 音乐账号 API 可读取画像、创建歌单并提供网页播放地址。",
          checkedAt: nowIso(),
        };
      }
      writeJson(res, 200, { sources });
      return;
    }
    if ((pathname === "/api/netease/status" || pathname.startsWith("/api/netease/")) && !pathname.startsWith("/api/netease/audio/")) {
      assertPlayerControlAuthorized(req);
    }
    if ((pathname === "/api/qq/status" || pathname.startsWith("/api/qq/")) && !pathname.startsWith("/api/qq/audio/")) {
      assertPlayerControlAuthorized(req);
    }
    if (method === "GET" && (pathname === "/api/program" || /^\/api\/programs\/[^/]+$/.test(pathname))) {
      assertPlayerControlAuthorized(req);
    }
    if (method === "GET" && pathname === "/api/netease/status") {
      writeJson(res, 200, { status: await neteaseStatus(true) });
      return;
    }
    if (method === "GET" && pathname === "/api/qq/status") {
      writeJson(res, 200, { status: await qqStatus(true) });
      return;
    }
    if (method === "GET" && pathname === "/api/netease/preferences") {
      const requestedScene = parsedUrl.searchParams.get("scene") ?? "late_night";
      if (!SCENE_PRESETS.includes(requestedScene as ScenePreset)) throw new ServiceError("INVALID_INPUT", 400, "scene is invalid");
      const controller = new AbortController();
      const abort = () => controller.abort();
      req.once("aborted", abort);
      res.once("close", abort);
      try {
        writeJson(res, 200, { provider: "netease", preferences: await loadNeteasePreferences(requestedScene as ScenePreset, controller.signal) });
      } finally {
        req.off("aborted", abort);
        res.off("close", abort);
      }
      return;
    }
    if (method === "GET" && pathname === "/api/qq/preferences") {
      const requestedScene = parsedUrl.searchParams.get("scene") ?? "late_night";
      if (!SCENE_PRESETS.includes(requestedScene as ScenePreset)) throw new ServiceError("INVALID_INPUT", 400, "scene is invalid");
      const controller = new AbortController();
      const abort = () => controller.abort();
      req.once("aborted", abort);
      res.once("close", abort);
      try {
        writeJson(res, 200, { provider: "qq", preferences: await loadQqPreferences(requestedScene as ScenePreset, controller.signal) });
      } finally {
        req.off("aborted", abort);
        res.off("close", abort);
      }
      return;
    }
    if (method === "GET" && pathname === "/api/netease/search") {
      const provider = await requireNetease();
      if (typeof provider.search !== "function") throw new ServiceError("NETEASE_UNAVAILABLE", 503, publicMessage("NETEASE_UNAVAILABLE"));
      const keyword = nonEmptyString(parsedUrl.searchParams.get("keyword"), "keyword", 100);
      const controller = new AbortController();
      req.once("aborted", () => controller.abort());
      const result = await invokeNetease(() => provider.search!(keyword, { limit: 20, offset: 0, signal: controller.signal }));
      writeJson(res, 200, { provider: "netease", result });
      return;
    }
    if (method === "GET" && pathname === "/api/qq/search") {
      const provider = await requireQq();
      if (typeof provider.search !== "function") throw new ServiceError("QQ_UNAVAILABLE", 503, publicMessage("QQ_UNAVAILABLE"));
      const keyword = nonEmptyString(parsedUrl.searchParams.get("keyword"), "keyword", 100);
      const controller = new AbortController();
      req.once("aborted", () => controller.abort());
      const result = await invokeAccount("qq", () => provider.search!(keyword, { limit: 20, offset: 0, signal: controller.signal }));
      writeJson(res, 200, { provider: "qq", result });
      return;
    }
    if (method === "GET" && segments.length === 4 && segments[0] === "api" && segments[1] === "netease" && segments[2] === "playlist") {
      const provider = await requireNetease();
      if (typeof provider.playlistDetail !== "function") throw new ServiceError("NETEASE_UNAVAILABLE", 503, publicMessage("NETEASE_UNAVAILABLE"));
      const id = neteaseId(segments[3]);
      const controller = new AbortController();
      req.once("aborted", () => controller.abort());
      const playlist = await invokeNetease(() => provider.playlistDetail!(id, controller.signal));
      writeJson(res, 200, { provider: "netease", playlist });
      return;
    }
    if (method === "GET" && segments.length === 4 && segments[0] === "api" && segments[1] === "qq" && segments[2] === "playlist") {
      const provider = await requireQq();
      if (typeof provider.playlistDetail !== "function") throw new ServiceError("QQ_UNAVAILABLE", 503, publicMessage("QQ_UNAVAILABLE"));
      const id = qqId(segments[3]);
      const controller = new AbortController();
      req.once("aborted", () => controller.abort());
      const playlist = await invokeAccount("qq", () => provider.playlistDetail!(id, controller.signal));
      writeJson(res, 200, { provider: "qq", playlist });
      return;
    }
    if (method === "GET" && segments.length === 6 && segments[0] === "api" && segments[1] === "netease" && segments[2] === "audio") {
      const generation = Number(segments[4]);
      if (!Number.isSafeInteger(generation) || generation < 1) throw new ServiceError("INVALID_INPUT", 400, "generation is invalid");
      await handleAccountAudio(req, res, "netease", validateProgramId(segments[3]), generation, neteaseId(segments[5]));
      return;
    }
    if (method === "GET" && segments.length === 6 && segments[0] === "api" && segments[1] === "qq" && segments[2] === "audio") {
      const generation = Number(segments[4]);
      if (!Number.isSafeInteger(generation) || generation < 1) throw new ServiceError("INVALID_INPUT", 400, "generation is invalid");
      await handleAccountAudio(req, res, "qq", validateProgramId(segments[3]), generation, qqId(segments[5]));
      return;
    }
    if (method === "GET" && segments.length === 4 && segments[0] === "api" && segments[1] === "netease" && segments[2] === "song") {
      const provider = await requireNetease();
      if (typeof provider.songDetail !== "function" || typeof provider.songUrl !== "function") {
        throw new ServiceError("NETEASE_UNAVAILABLE", 503, publicMessage("NETEASE_UNAVAILABLE"));
      }
      const id = neteaseId(segments[3]);
      const controller = new AbortController();
      req.once("aborted", () => controller.abort());
      const result = await invokeNetease(async () => {
        const [songs, playback] = await Promise.all([
          Promise.resolve(provider.songDetail!([id], controller.signal)),
          Promise.resolve(provider.songUrl!(id, { signal: controller.signal })),
        ]);
        return {
          songs,
          playback: {
            available: isRecord(playback) && typeof playback.url === "string" && playback.url.length > 0,
            ...(isRecord(playback) && typeof playback.type === "string" ? { type: playback.type } : {}),
            ...(isRecord(playback) && typeof playback.level === "string" ? { level: playback.level } : {}),
            ...(isRecord(playback) && typeof playback.time === "number" ? { time: playback.time } : {}),
          },
        };
      });
      writeJson(res, 200, { provider: "netease", result });
      return;
    }
    if (method === "GET" && segments.length === 4 && segments[0] === "api" && segments[1] === "qq" && segments[2] === "song") {
      const provider = await requireQq();
      if (typeof provider.songDetail !== "function" || typeof provider.songUrl !== "function") throw new ServiceError("QQ_UNAVAILABLE", 503, publicMessage("QQ_UNAVAILABLE"));
      const id = qqId(segments[3]);
      const controller = new AbortController();
      req.once("aborted", () => controller.abort());
      const result = await invokeAccount("qq", async () => {
        const [songs, playback] = await Promise.all([
          Promise.resolve(provider.songDetail!([id], controller.signal)),
          Promise.resolve(provider.songUrl!(id, { signal: controller.signal })),
        ]);
        return {
          songs,
          playback: {
            available: isRecord(playback) && typeof playback.url === "string" && playback.url.length > 0,
            ...(isRecord(playback) && typeof playback.type === "string" ? { type: playback.type } : {}),
            ...(isRecord(playback) && typeof playback.level === "string" ? { level: playback.level } : {}),
            ...(isRecord(playback) && typeof playback.time === "number" ? { time: playback.time } : {}),
          },
        };
      });
      writeJson(res, 200, { provider: "qq", result });
      return;
    }
    if (method === "GET" && segments.length === 5 && segments[0] === "api" && segments[1] === "netease" && segments[2] === "login" && segments[3] === "qr") {
      const provider = await requireNetease();
      if (typeof provider.checkQrLogin !== "function") throw new ServiceError("NETEASE_UNAVAILABLE", 503, publicMessage("NETEASE_UNAVAILABLE"));
      const key = neteaseQrKey(segments[4]);
      const controller = new AbortController();
      req.once("aborted", () => controller.abort());
      const login = await invokeNetease(() => provider.checkQrLogin!(key, controller.signal));
      writeJson(res, 200, { provider: "netease", login });
      return;
    }
    if (method === "GET" && segments.length === 5 && segments[0] === "api" && segments[1] === "qq" && segments[2] === "login" && segments[3] === "qr") {
      const provider = await requireQq();
      if (typeof provider.checkQrLogin !== "function") throw new ServiceError("QQ_UNAVAILABLE", 503, publicMessage("QQ_UNAVAILABLE"));
      const key = qqQrKey(segments[4]);
      const requestedLoginType = parsedUrl.searchParams.get("loginType") ?? parsedUrl.searchParams.get("method");
      const loginType = requestedLoginType === null ? (qqQrLoginTypes.get(key) ?? "mobile") : qqLoginType(requestedLoginType);
      const controller = new AbortController();
      req.once("aborted", () => controller.abort());
      const login = await invokeAccount("qq", () => provider.checkQrLogin!(key, loginType, controller.signal));
      writeJson(res, 200, { provider: "qq", login });
      return;
    }
    if (method === "GET" && segments.length === 4 && segments[0] === "api" && segments[1] === "players" && segments[3] === "volume") {
      assertPlayerControlAuthorized(req);
      const sourceId = desktopPlayerSource(segments[2]);
      writeJson(res, 200, { player: await desktopPlayerController.inspect(sourceId) });
      return;
    }
    if (method === "GET" && pathname === "/api/program") {
      assertPlayerControlAuthorized(req);
      writeJson(res, 200, { program: responseProgram(stateNow()) });
      return;
    }
    if (method === "GET" && segments.length === 3 && segments[0] === "api" && segments[1] === "programs") {
      assertPlayerControlAuthorized(req);
      const programId = validateProgramId(segments[2]);
      writeJson(res, 200, { program: responseProgram(assertProgram(programId)) });
      return;
    }
    if (method === "POST" && pathname === "/api/netease/login/qr") {
      const provider = await requireNetease();
      if (typeof provider.createQrLogin !== "function") throw new ServiceError("NETEASE_UNAVAILABLE", 503, publicMessage("NETEASE_UNAVAILABLE"));
      const controller = new AbortController();
      req.once("aborted", () => controller.abort());
      const login = await invokeNetease(() => provider.createQrLogin!(controller.signal));
      const normalizedLogin = isRecord(login) && typeof login.qrImageDataUrl === "string"
        ? { ...login, dataUrl: login.qrImageDataUrl }
        : login;
      writeJson(res, 201, { provider: "netease", login: normalizedLogin });
      return;
    }
    if (method === "POST" && pathname === "/api/qq/login/qr") {
      const provider = await requireQq();
      if (typeof provider.createQrLogin !== "function") throw new ServiceError("QQ_UNAVAILABLE", 503, publicMessage("QQ_UNAVAILABLE"));
      const loginBody = await readJsonBody(req);
      const loginType = qqLoginType(loginBody.loginType ?? loginBody.method);
      const controller = new AbortController();
      req.once("aborted", () => controller.abort());
      const login = await invokeAccount("qq", () => provider.createQrLogin!(loginType, controller.signal));
      const normalizedLogin = isRecord(login) && typeof login.qrImageDataUrl === "string"
        ? { ...login, dataUrl: login.qrImageDataUrl, loginType }
        : isRecord(login) ? { ...login, loginType } : login;
      if (isRecord(login) && typeof login.key === "string") {
        qqQrLoginTypes.set(login.key, loginType);
        while (qqQrLoginTypes.size > 128) {
          const oldest = qqQrLoginTypes.keys().next().value;
          if (typeof oldest === "string") qqQrLoginTypes.delete(oldest);
          else break;
        }
      }
      writeJson(res, 201, { provider: "qq", login: normalizedLogin });
      return;
    }
    if (method !== "POST") {
      throw new ServiceError(method === "GET" ? "NOT_FOUND" : "METHOD_NOT_ALLOWED", method === "GET" ? 404 : 405, publicMessage(method === "GET" ? "NOT_FOUND" : "METHOD_NOT_ALLOWED"));
    }
    if (!pathname.startsWith("/api/")) throw new ServiceError("NOT_FOUND", 404, publicMessage("NOT_FOUND"));
    const body = await readJsonBody(req);
    if (pathname === "/api/device/cache/clear") {
      assertPlayerControlAuthorized(req);
      assertMaintenanceAllowed();
      writeJson(res, 200, { removedEntries: clearAudioStorage(), storage: audioStorageStats() });
      return;
    }
    if (pathname === "/api/device/profile/reset") {
      assertPlayerControlAuthorized(req);
      assertMaintenanceAllowed();
      writeJson(res, 200, { removedProfiles: await clearListeningProfiles(), profiles: await profileStorageStats() });
      return;
    }
    if (pathname === "/api/device/account/reset") {
      assertPlayerControlAuthorized(req);
      writeJson(res, 200, { reset: true, ...(await clearAllLocalAccountData()) });
      return;
    }
    if (pathname === "/api/device/pet") {
      assertPlayerControlAuthorized(req);
      const scale = body.scale === "small" || body.scale === "medium" || body.scale === "large" ? body.scale : undefined;
      const resetPosition = body.resetPosition === true;
      if (!scale && !resetPosition) throw new ServiceError("INVALID_INPUT", 400, "桌面人物设置没有变化。");
      try {
        writeJson(res, 200, { desktopPet: await writeDesktopPetPreferences({ scale, resetPosition }) });
      } catch {
        throw new ServiceError("DESKTOP_PET_SETTINGS_ERROR", 500, "桌面人物设置保存失败。");
      }
      return;
    }
    if (pathname === "/api/ai/secrets/delete") {
      assertPlayerControlAuthorized(req);
      assertMaintenanceAllowed();
      const target = body.target === "llm" || body.target === "tts" || body.target === "all" ? body.target : null;
      if (!target) throw new ServiceError("INVALID_INPUT", 400, "需要指定要删除的大模型或语音密钥。");
      writeJson(res, 200, { config: await aiConfigStore.deleteSecrets(target) });
      return;
    }
    if (pathname === "/api/access/claim") {
      assertPlayerControlAuthorized(req);
      assertMaintenanceAllowed();
      const inviteCode = nonEmptyString(body.inviteCode, "inviteCode", 40);
      const displayName = nonEmptyString(body.displayName, "displayName", 40);
      try {
        const access = await cloudAccessStore.claim(inviteCode, displayName);
        writeJson(res, 200, { access, config: await aiConfigStore.status() });
      } catch (error) {
        throw new ServiceError("INVITATION_FAILED", 401, error instanceof Error ? error.message : "邀请码连接失败。");
      }
      return;
    }
    if (pathname === "/api/access/disconnect") {
      assertPlayerControlAuthorized(req);
      assertMaintenanceAllowed();
      await cloudAccessStore.disconnect();
      writeJson(res, 200, { access: await cloudAccessStore.status(), config: await aiConfigStore.status() });
      return;
    }
    if (pathname === "/api/qq/logout" || pathname === "/api/netease/logout") {
      assertPlayerControlAuthorized(req);
      assertMaintenanceAllowed();
      const providerId = pathname.includes("/qq/") ? "qq" : "netease";
      const provider = providerId === "qq" ? await requireQq() : await requireNetease();
      if (typeof provider.logout !== "function") throw new ServiceError(providerId === "qq" ? "QQ_UNAVAILABLE" : "NETEASE_UNAVAILABLE", 409, "当前音乐连接器不支持撤销本机授权。");
      const status = await invokeAccount(providerId, () => provider.logout!());
      writeJson(res, 200, { provider: providerId, status });
      return;
    }
    if (pathname === "/api/ai/config") {
      assertPlayerControlAuthorized(req);
      if (aiConfigStore instanceof ManagedAiConfigStore) throw new ServiceError("MANAGED_AI", 409, "大模型和语音由 Open Music Radio 统一提供，无需填写 API Key。");
      if (!isRecord(body.llm) || !isRecord(body.tts)) throw new ServiceError("INVALID_INPUT", 400, "AI 配置不完整。");
      const llmProvider = typeof body.llm.provider === "string" && LLM_PROVIDER_IDS.includes(body.llm.provider as (typeof LLM_PROVIDER_IDS)[number]) ? body.llm.provider as (typeof LLM_PROVIDER_IDS)[number] : null;
      const ttsProviderId = typeof body.tts.provider === "string" && TTS_PROVIDER_IDS.includes(body.tts.provider as (typeof TTS_PROVIDER_IDS)[number]) ? body.tts.provider as (typeof TTS_PROVIDER_IDS)[number] : null;
      if (!llmProvider || !ttsProviderId) throw new ServiceError("INVALID_INPUT", 400, "AI 供应商无效。");
      const settings: LocalAiSettings = {
        llm: {
          provider: llmProvider,
          model: nonEmptyString(body.llm.model, "llm.model", 120),
          ...(typeof body.llm.reviewModel === "string" && body.llm.reviewModel.trim() ? { reviewModel: body.llm.reviewModel.trim() } : {}),
          ...(body.llm.reasoningEffort === "low" || body.llm.reasoningEffort === "medium" || body.llm.reasoningEffort === "high" ? { reasoningEffort: body.llm.reasoningEffort } : {}),
          ...(typeof body.llm.baseUrl === "string" && body.llm.baseUrl.trim() ? { baseUrl: body.llm.baseUrl.trim() } : {}),
        },
        tts: { provider: ttsProviderId, model: nonEmptyString(body.tts.model, "tts.model", 120), voice: nonEmptyString(body.tts.voice, "tts.voice", 120), ...(typeof body.tts.baseUrl === "string" && body.tts.baseUrl.trim() ? { baseUrl: body.tts.baseUrl.trim() } : {}), ...(typeof body.tts.region === "string" && body.tts.region.trim() ? { region: body.tts.region.trim() } : {}), ...(typeof body.tts.workspaceId === "string" && body.tts.workspaceId.trim() ? { workspaceId: body.tts.workspaceId.trim() } : {}) },
      };
      try {
        const config = await aiConfigStore.save(settings, { ...(typeof body.llmApiKey === "string" ? { llmApiKey: body.llmApiKey } : {}), ...(typeof body.ttsApiKey === "string" ? { ttsApiKey: body.ttsApiKey } : {}) });
        writeJson(res, 200, { config });
      } catch (error) {
        const safeMessage = error instanceof Error && /provider|model|voice|URL|region/i.test(error.message)
          ? error.message
          : "AI 配置保存失败，请检查本机钥匙串权限。";
        throw new ServiceError("AI_CONFIG_ERROR", 400, safeMessage);
      }
      return;
    }
    if (pathname === "/api/ai/test") {
      assertPlayerControlAuthorized(req);
      const target = body.target === "tts" ? "tts" : "llm";
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20_000);
      try {
        if (target === "llm") {
          if (!(hostProvider instanceof LocalConfiguredHostProvider)) throw new ServiceError("AI_CONNECTION_FAILED", 409, "当前大模型由测试或外部运行时接管，不能从设置页测试。");
          await hostProvider.test(controller.signal);
        } else {
          if (!(ttsProvider instanceof LocalConfiguredTtsProvider)) throw new ServiceError("AI_CONNECTION_FAILED", 409, "当前语音服务由测试或外部运行时接管，不能从设置页测试。");
          await ttsProvider.test(DEFAULT_HOST_PROFILE, "study", controller.signal);
        }
        writeJson(res, 200, { ok: true, target });
      } catch (error) {
        throw new ServiceError("AI_CONNECTION_FAILED", 502, error instanceof Error ? error.message : "连接测试失败。");
      } finally {
        clearTimeout(timeout);
      }
      return;
    }
    if (pathname === "/api/ai/voice-preview") {
      assertPlayerControlAuthorized(req);
      const hostProfile = typeof body.hostProfile === "string" && HOST_PROFILE_IDS.includes(body.hostProfile as HostProfileId) ? body.hostProfile as HostProfileId : null;
      if (!hostProfile) throw new ServiceError("INVALID_INPUT", 400, "主持声线无效。");
      const scenePreset = typeof body.scenePreset === "string" && SCENE_PRESETS.includes(body.scenePreset as ScenePreset) ? body.scenePreset as ScenePreset : null;
      if (!scenePreset) throw new ServiceError("INVALID_INPUT", 400, "音乐氛围无效。");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), lockedTtsTimeoutMs);
      try {
        if (!(ttsProvider instanceof LocalConfiguredTtsProvider)) throw new ServiceError("AI_CONNECTION_FAILED", 409, "当前语音服务不支持设置页试听。");
        const bytes = await ttsProvider.test(hostProfile, scenePreset, controller.signal);
        const id = randomUUID();
        audio.set(id, { data: bytes, contentType: audioContentType({}, bytes), expiresAt: Date.now() + AUDIO_TTL_MS });
        writeJson(res, 200, { audioUrl: `/api/audio/${id}` });
      } finally {
        clearTimeout(timeout);
      }
      return;
    }
    if (["/api/players/volume/duck", "/api/players/volume/restore", "/api/players/control/toggle", "/api/players/control/next"].includes(pathname)) {
      assertPlayerControlAuthorized(req);
      const sourceId = desktopPlayerSource(body.sourceId);
      const operationId = nonEmptyString(body.operationId, "operationId", MAX_OPERATION_ID_LENGTH);
      const player = pathname.endsWith("/duck")
        ? await desktopPlayerController.duck(sourceId, operationId)
        : pathname.endsWith("/restore")
          ? await desktopPlayerController.restore(sourceId, operationId)
          : pathname.endsWith("/toggle")
            ? await desktopPlayerController.toggle(sourceId, operationId)
            : await desktopPlayerController.next(sourceId, operationId);
      writeJson(res, 200, { player });
      return;
    }
    if (pathname === "/api/programs") {
      const operationId = operationIdFromBody(body, false);
      const spec = validateProgramSpec(body.spec);
      const qqApiSource = spec.sourceId === "qq_music" && qqApiEnabled;
      const accountSource = spec.sourceId === "netease_music" || qqApiSource;
      if (accountSource) assertPlayerControlAuthorized(req);
      const source = buildSourceDiagnostics().find((item) => item.sourceId === spec.sourceId);
      if (!source?.hostedProgramAllowed) throw new ServiceError("SOURCE_NOT_ALLOWED", 409, publicMessage("SOURCE_NOT_ALLOWED"));
      const createController = accountSource ? new AbortController() : null;
      const abortCreate = () => createController?.abort();
      if (createController) {
        req.once("aborted", abortCreate);
        res.once("close", abortCreate);
        if (req.aborted || res.destroyed) createController.abort();
      }
      const updateCreateProgress = (completedSteps: number, status: CreateProgressStatus = "running") => {
        if (!operationId) return;
        const previous = createProgress.get(operationId);
        createProgress.set(operationId, {
          completedSteps: Math.max(previous?.completedSteps ?? 0, Math.min(4, completedSteps)),
          status,
          updatedAt: nowIso(),
        });
        while (createProgress.size > 128) {
          const oldest = createProgress.keys().next().value;
          if (typeof oldest === "string") createProgress.delete(oldest);
          else break;
        }
      };
      updateCreateProgress(0);
      const hostRetryPayload = (state: ProgramState, message?: string) => ({
        state,
        hostRetryRequired: true,
        message: message || "口播审核没有通过，歌单已保留。请确认后单独重新生成口播。",
      });
      const rememberCreateResult = (state: ProgramState): void => {
        if (!operationId) return;
        createResults.set(operationId, { spec, state });
        while (createResults.size > 128) {
          const oldest = createResults.keys().next().value;
          if (typeof oldest === "string") createResults.delete(oldest);
          else break;
        }
      };
      const createProgram = async (): Promise<{ state: ProgramState; hostRetryRequired?: boolean; message?: string }> => {
        if (createController?.signal.aborted) throw new ServiceError("REQUEST_ABORTED", 499, "请求已取消。");
        const current = stateNow();
        if (current && ACTIVE_STATUSES.has(current.status)) throw new ServiceError("PROGRAM_ALREADY_ACTIVE", 409, publicMessage("PROGRAM_ALREADY_ACTIVE"));
        let plannedAccountRundown: ProgramRundownItem[] | undefined;
        let listenerProfile: ProgramListenerProfile | undefined;
        let accountUid: string | undefined;
        let accountPreferences: UnknownRecord | undefined;
        if (accountSource) {
          const signal = createController!.signal;
          const providerId = qqApiSource ? "qq" : "netease";
          const preferences = await loadAccountPreferences(providerId, spec.scenePreset, signal, spec.familiarityRatio ?? 40, spec.musicGenres ?? [], recommendationModeForSpec(spec));
          updateCreateProgress(1);
          accountPreferences = preferences;
          if (typeof preferences.accountUid === "string") accountUid = preferences.accountUid;
          if (isRecord(preferences.listenerProfile)) listenerProfile = preferences.listenerProfile as unknown as ProgramListenerProfile;
          plannedAccountRundown = await prepareAccountRundown(providerId, spec, preferences, signal, (step) => updateCreateProgress(step));
            const plannedSeconds = plannedAccountRundown.reduce((total, track) => total + track.durationSeconds, 0);
            if (plannedAccountRundown.length === 0 || plannedSeconds < minimumProgramDurationSeconds(spec.durationMinutes)) {
              const label = qqApiSource ? "QQ 音乐" : "网易云";
            throw new ServiceError(qqApiSource ? "QQ_PROVIDER_ERROR" : "NETEASE_NO_PLAYABLE_TRACKS", 409, plannedAccountRundown.length === 0
                ? `没有从你的听歌画像与当前场景中找到可播放的${label}歌曲。`
                : `可播放歌曲只有约 ${Math.floor(plannedSeconds / 60)} 分钟，不足以生成 ${spec.durationMinutes} 分钟节目。`);
            }
          if (signal.aborted) throw new ServiceError("REQUEST_ABORTED", 499, "请求已取消。");
        }
        const state = await invokeEngine("create", [spec]);
        if (!state) throw new ServiceError("ENGINE_INVALID_STATE", 500, publicMessage("INTERNAL_ERROR"));
        if (accountSource && !accountPlaylistNames.has(state.id)) {
          const existingNames = new Set(listenerProfile?.playlistNames ?? []);
          for (const usedName of accountPlaylistNames.values()) existingNames.add(usedName);
          accountPlaylistNames.set(state.id, programPlaylistName(state.id, spec, qqApiSource ? "qq" : "netease", existingNames));
        }
        if (plannedAccountRundown) {
          for (const previousId of accountRundowns.keys()) {
            if (previousId !== state.id) accountRundowns.delete(previousId);
          }
          accountRundowns.set(state.id, { items: plannedAccountRundown, index: 0, revision: 0, hostAudio: new Map(), hostScriptsPending: true, hostScriptsFinalized: false, ...(accountPreferences ? { preferences: accountPreferences } : {}), ...(listenerProfile ? { listenerProfile } : {}), ...(accountUid ? { accountUid } : {}) });
          try {
            const locked = await lockNeteaseHostScripts(spec, plannedAccountRundown, listenerProfile, createController!.signal);
            const artifact = accountRundowns.get(state.id);
            if (artifact) {
              artifact.items = locked;
              artifact.hostScriptsPending = false;
              artifact.hostScriptsFinalized = true;
              artifact.hostAudio.clear();
            }
          } catch (error) {
            if (isHostScriptQualityFailure(error)) {
              const locked = createFinalHostScriptVersion(spec, plannedAccountRundown);
              const artifact = accountRundowns.get(state.id);
              if (artifact) {
                artifact.items = locked;
                artifact.hostScriptsPending = false;
                artifact.hostScriptsFinalized = true;
                artifact.hostAudio.clear();
              }
            } else if (error instanceof ServiceError && error.code === "HOST_PROVIDER_ERROR") {
              const artifact = accountRundowns.get(state.id);
              if (artifact) {
                artifact.hostScriptsPending = true;
                artifact.hostScriptsFinalized = false;
              }
              updateCreateProgress(3, "action_required");
              rememberCreateResult(state);
              return hostRetryPayload(state, `${error.message} 请确认后单独重新生成口播。`);
            } else {
              throw error;
            }
          }
        }
        rememberCreateResult(state);
        updateCreateProgress(4, "completed");
        return { state };
      };
      let replayed = false;
      let result: { state: ProgramState; hostRetryRequired?: boolean; message?: string };
      try {
        result = await serializeCreateAction(async () => {
          if (createController?.signal.aborted) throw new ServiceError("REQUEST_ABORTED", 499, "请求已取消。");
          if (operationId) {
            const previous = createResults.get(operationId);
            if (previous) {
              if (JSON.stringify(previous.spec) !== JSON.stringify(spec)) throw new ServiceError("OPERATION_REUSED", 409, publicMessage("OPERATION_REUSED"));
              const current = stateNow();
              if (!current || current.id !== previous.state.id) throw new ServiceError("OPERATION_REUSED", 409, publicMessage("OPERATION_REUSED"));
              replayed = true;
              const artifact = accountRundowns.get(current.id);
              return artifact?.hostScriptsPending ? hostRetryPayload(current) : { state: current };
            }
          }
          return createProgram();
        });
        if (!result.hostRetryRequired) updateCreateProgress(4, "completed");
      } catch (error) {
        updateCreateProgress(createProgress.get(operationId ?? "")?.completedSteps ?? 0, "failed");
        throw error;
      } finally {
        req.off("aborted", abortCreate);
        res.off("close", abortCreate);
      }
      if (result.state.spec.desktopPetEnabled === true) updateDesktopPet(result.state);
      writeJson(res, result.hostRetryRequired ? 202 : replayed ? 200 : 201, {
        program: responseProgram(result.state),
        replayed,
        ...(result.hostRetryRequired ? { hostRetryRequired: true, message: result.message } : {}),
      });
      return;
    }
    if (pathname === "/api/desktop-pet/state") {
      assertPlayerControlAuthorized(req);
      const programId = validateProgramId(nonEmptyString(body.programId, "programId", 160));
      const generation = generationFromBody(body, true)!;
      const mood = typeof body.mood === "string" && DESKTOP_PET_MOODS.includes(body.mood as DesktopPetMood)
        ? body.mood as DesktopPetMood
        : null;
      if (!mood) throw new ServiceError("INVALID_INPUT", 400, "desktop pet mood is invalid");
      const revision = typeof body.revision === "number" && Number.isSafeInteger(body.revision) && body.revision > 0 ? body.revision : null;
      if (revision === null) throw new ServiceError("INVALID_INPUT", 400, "desktop pet revision is invalid");
      const clientId = nonEmptyString(body.clientId, "clientId", 80);
      if (!/^[A-Za-z0-9-]{8,80}$/.test(clientId)) throw new ServiceError("INVALID_INPUT", 400, "desktop pet client id is invalid");
      const clientStartedAt = typeof body.clientStartedAt === "number" && Number.isSafeInteger(body.clientStartedAt) ? body.clientStartedAt : null;
      if (clientStartedAt === null || clientStartedAt > Date.now() + 60_000 || clientStartedAt < Date.now() - 3 * 60 * 60 * 1_000) {
        throw new ServiceError("INVALID_INPUT", 400, "desktop pet client session is invalid");
      }
      const current = assertProgram(programId);
      assertGeneration(current, generation);
      const moodAllowed = (["preparing", "on_air", "closing"].includes(current.status) && !["ended", "error"].includes(mood))
        || (["completed", "stopped"].includes(current.status) && mood === "ended")
        || (["failed", "control_lost", "stop_unconfirmed"].includes(current.status) && mood === "error");
      if (!moodAllowed) throw new ServiceError("INVALID_INPUT", 409, "desktop pet mood does not match the program state");
      const publicProgram = responseProgram(current) ?? current;
      const requestedTrackId = typeof body.trackId === "string" ? body.trackId : null;
      if (requestedTrackId && publicProgram.currentTrack?.id !== requestedTrackId) throw new ServiceError("GENERATION_MISMATCH", 409, publicMessage("GENERATION_MISMATCH"));
      const previousRevision = desktopPetClientRevisions.get(programId);
      const now = Date.now();
      const activeMood = (value: DesktopPetMood) => ["speaking", "listening", "transition"].includes(value);
      const previousHasFreshPlaybackLease = previousRevision?.ownsPlayback === true && now - previousRevision.lastSeenAt < 5_000;
      const sessionIsNewer = !previousRevision
        || clientStartedAt > previousRevision.startedAt
        || (clientStartedAt === previousRevision.startedAt && clientId > previousRevision.clientId);
      const sameSession = previousRevision?.clientId === clientId && previousRevision.startedAt === clientStartedAt;
      if ((!sameSession && previousHasFreshPlaybackLease && (previousRevision?.mood !== "paused" || !activeMood(mood)))
        || (!sameSession && !sessionIsNewer && !activeMood(mood))
        || (sameSession && revision <= previousRevision.revision)) {
        writeJson(res, 200, { ok: true, stale: true });
        return;
      }
      desktopPetClientRevisions.set(programId, {
        clientId,
        startedAt: clientStartedAt,
        revision,
        mood,
        lastSeenAt: now,
        ownsPlayback: activeMood(mood) || (sameSession && previousRevision?.ownsPlayback === true),
      });
      updateDesktopPet(current, mood);
      writeJson(res, 200, { ok: true });
      return;
    }
    if (segments.length === 5 && segments[0] === "api" && segments[1] === "programs" && segments[3] === "current" && segments[4] === "like") {
      assertPlayerControlAuthorized(req);
      const programId = validateProgramId(segments[2]);
      const liked = body.liked;
      if (typeof liked !== "boolean") throw new ServiceError("INVALID_INPUT", 400, "喜欢状态无效。");
      const trackId = nonEmptyString(body.trackId, "trackId", 200);
      const generation = generationFromBody(body, true)!;
      const controller = new AbortController();
      const abort = () => controller.abort();
      req.once("aborted", abort);
      res.once("close", abort);
      try {
        const response = await serializeProgramAction(programId, async () => {
          const lockedState = assertProgram(programId);
          assertGeneration(lockedState, generation);
          const providerId = lockedState.spec.sourceId === "qq_music" && qqApiEnabled
            ? "qq"
            : lockedState.spec.sourceId === "netease_music"
              ? "netease"
              : null;
          if (!providerId) throw new ServiceError("INVALID_INPUT", 400, "当前音源不支持写入我喜欢。");
          if (lockedState.status !== "on_air") throw new ServiceError("PROGRAM_NOT_ACTIVE", 409, "只能在电台播出中操作当前歌曲。");
          const artifact = accountRundowns.get(programId);
          const current = artifact?.items[artifact.index];
          if (!artifact || !current || current.id !== trackId) throw new ServiceError("GENERATION_MISMATCH", 409, "当前歌曲已经变化，请刷新后重试。");
          if (!artifact.accountUid) throw new ServiceError("PROGRAM_ARTIFACT_MISSING", 409, "开播前锁定的账户资料已丢失，请重新创建节目。");
          if (providerId === "qq") {
            const provider = await requireQq();
            if (typeof provider.setSongLiked !== "function") throw new ServiceError("QQ_PROVIDER_ERROR", 503, "QQ 音乐暂不支持写入我喜欢。");
            const account = await invokeAccountStage("qq", "核对账号", () => provider.account!(controller.signal));
            if (!isRecord(account) || account.uid !== artifact.accountUid) throw new ServiceError("ACCOUNT_CHANGED", 409, "QQ 音乐账号已经变化，请退出本次节目后重新生成。");
            const readSongType = async (): Promise<number | undefined> => {
              if (typeof provider.songDetail !== "function") return undefined;
              try {
                const detail = await invokeAccount("qq", () => provider.songDetail!([current.id], controller.signal));
                const first = Array.isArray(detail) ? detail[0] : null;
                return isRecord(first) && typeof first.songType === "number" && Number.isSafeInteger(first.songType) && first.songType >= 0
                  ? first.songType
                  : undefined;
              } catch {
                return undefined;
              }
            };
            let songType = Number.isSafeInteger(current.songType) && (current.songType ?? -1) >= 0 ? current.songType : await readSongType();
            if (songType !== undefined) current.songType = songType;
            try {
              await invokeAccountStage("qq", liked ? "加入我喜欢" : "取消我喜欢", () => provider.setSongLiked!(current.id, liked, songType, controller.signal, { expectedUid: artifact.accountUid! }));
            } catch (error) {
              const refreshedSongType = await readSongType();
              if (refreshedSongType === undefined || refreshedSongType === songType) throw error;
              songType = refreshedSongType;
              current.songType = refreshedSongType;
              await invokeAccountStage("qq", liked ? "加入我喜欢" : "取消我喜欢", () => provider.setSongLiked!(current.id, liked, songType, controller.signal, { expectedUid: artifact.accountUid! }));
            }
          } else {
            const provider = await requireNetease();
            if (typeof provider.setSongLiked !== "function") throw new ServiceError("NETEASE_PROVIDER_ERROR", 503, "网易云暂不支持写入我喜欢。");
            const account = await invokeAccountStage("netease", "核对账号", () => provider.account!(controller.signal));
            if (!isRecord(account) || account.uid !== artifact.accountUid) throw new ServiceError("ACCOUNT_CHANGED", 409, "网易云账号已经变化，请退出本次节目后重新生成。");
            await invokeAccountStage("netease", liked ? "加入我喜欢" : "取消我喜欢", () => provider.setSongLiked!(current.id, liked, controller.signal));
          }
          current.liked = liked;
          if (liked) current.heard = true;
          artifact.revision += 1;
          return lockedState;
        });
        writeJson(res, 200, { program: responseProgram(response), track: { id: trackId, liked } });
      } finally {
        req.off("aborted", abort);
        res.off("close", abort);
      }
      return;
    }
    if (segments.length === 4 && segments[0] === "api" && segments[1] === "programs") {
      const programId = validateProgramId(segments[2]);
      const action = segments[3];
      const state = assertProgram(programId);
      if (["reorder", "regenerate", "adjust", "replace"].includes(action)) {
        assertPlayerControlAuthorized(req);
        const typedAction = action as "reorder" | "regenerate" | "adjust" | "replace";
        const operationId = operationIdFromBody(body, true)!;
        const baseRevision = typeof body.planRevision === "number" && Number.isSafeInteger(body.planRevision) && body.planRevision >= 0 ? body.planRevision : null;
        if (baseRevision === null) throw new ServiceError("INVALID_INPUT", 400, "节目计划版本无效，请刷新后重试。");
        const controller = new AbortController();
        const abort = () => controller.abort();
        req.once("aborted", abort);
        res.once("close", abort);
        try {
          const result = await serializeProgramAction(programId, async () => {
            if (controller.signal.aborted) throw new ServiceError("REQUEST_ABORTED", 499, "请求已取消，节目单未修改。");
            const lockedState = assertProgram(programId);
            assertGeneration(lockedState, generationFromBody(body, true));
            if (!["draft", "awaiting_confirmation"].includes(lockedState.status)) throw new ServiceError("PROGRAM_NOT_ACTIVE", 409, "节目已经开始，不能再修改计划。");
            const artifact = accountRundowns.get(programId);
            if (!artifact) throw new ServiceError("PROGRAM_ARTIFACT_MISSING", 409, "节目计划已丢失，请重新创建。");
            const operationKeyValue = operationKey(programId, operationId);
            const replay = planOperationResults.get(operationKeyValue);
            if (replay) {
              if (replay.action !== typedAction || replay.baseRevision !== baseRevision) throw new ServiceError("OPERATION_REUSED", 409, publicMessage("OPERATION_REUSED"));
              return { state: lockedState, message: null };
            }
            if (artifact.revision !== baseRevision) throw new ServiceError("GENERATION_MISMATCH", 409, "节目单已经变化，请刷新后再调整。");
            let actionMessage: string | null = null;
            let ordered: ProgramRundownItem[];
            if (typedAction === "regenerate") {
              if (!artifact.preferences) throw new ServiceError("PROGRAM_ARTIFACT_MISSING", 409, "选歌画像已丢失，请重新创建。");
              const providerId = lockedState.spec.sourceId === "qq_music" ? "qq" : "netease";
              const currentIds = new Set(artifact.items.map((track) => track.id));
              const programPlan = Array.isArray(artifact.preferences.programPlan) ? artifact.preferences.programPlan : [];
              const freshPreferences = { ...artifact.preferences, programPlan: programPlan.filter((track) => !isRecord(track) || !currentIds.has(String(track.id))) };
              const fresh = await prepareAccountRundown(providerId, lockedState.spec, freshPreferences, controller.signal);
              const freshSeconds = fresh.reduce((total, track) => total + track.durationSeconds, 0);
              ordered = freshSeconds >= minimumProgramDurationSeconds(lockedState.spec.durationMinutes)
                ? fresh
                : await prepareAccountRundown(providerId, lockedState.spec, artifact.preferences, controller.signal);
            } else if (typedAction === "replace") {
              if (!artifact.preferences) throw new ServiceError("PROGRAM_ARTIFACT_MISSING", 409, "选歌画像已丢失，请重新创建。");
              const trackId = nonEmptyString(body.trackId, "trackId", 200);
              const replaceIndex = artifact.items.findIndex((track) => track.id === trackId);
              if (replaceIndex < 0) throw new ServiceError("INVALID_INPUT", 400, "要删除的歌曲不在当前节目单中。");
              const programPlan = Array.isArray(artifact.preferences.programPlan) ? artifact.preferences.programPlan : [];
              const currentIds = new Set(artifact.items.map((track) => track.id));
              const replacementPreferences = { ...artifact.preferences, programPlan: programPlan.filter((track) => !isRecord(track) || !currentIds.has(String(track.id))) };
              const providerId = lockedState.spec.sourceId === "qq_music" ? "qq" : "netease";
              const candidates = await prepareAccountRundown(providerId, lockedState.spec, replacementPreferences, controller.signal, undefined, 1, 1);
              const replacement = candidates.find((track) => !currentIds.has(track.id));
              if (!replacement) throw new ServiceError("PROGRAM_ARTIFACT_MISSING", 409, "没有找到可播放的替补歌曲，请重新生成节目单。");
              ordered = artifact.items.map(({ hostScript: _hostScript, ...track }, index) => index === replaceIndex
                ? { ...replacement, hostMoment: track.hostMoment }
                : track);
            } else {
              const instruction = typedAction === "adjust" ? nonEmptyString(body.message, "message", 600) : "";
              const searchAdjustment = typedAction === "adjust" ? parseMusicSearchAdjustment(instruction) : null;
              if (searchAdjustment) {
                if (!artifact.preferences) throw new ServiceError("PROGRAM_ARTIFACT_MISSING", 409, "选歌画像已丢失，请重新创建。");
                const providerId = lockedState.spec.sourceId === "qq_music" ? "qq" : "netease";
                const provider = providerId === "qq" ? await requireQq() : await requireNetease();
                const requestedGenreTags = exactGenreQueryTags(searchAdjustment.query);
                let searchSongs: unknown[];
                if (requestedGenreTags.length > 0) {
                  if (typeof provider.searchPlaylists !== "function" || typeof provider.playlistDetail !== "function") {
                    throw new ServiceError("MUSIC_SEARCH_UNAVAILABLE", 503, `当前${providerId === "qq" ? "QQ 音乐" : "网易云"}连接不支持风格歌单搜索。`);
                  }
                  const playlistQueries = requestedGenreTags.flatMap((genre) => STYLE_PLAYLIST_QUERY_TERMS[genre].map((query) => ({ genre, query })));
                  const playlistResults = await Promise.allSettled(playlistQueries.map(({ query }) => invokeAccount(providerId, () => provider.searchPlaylists!(query, { limit: PUBLIC_PLAYLIST_SEARCH_LIMIT, offset: 0, signal: controller.signal }))));
                  const seenPlaylistIds = new Set<string>();
                  const playlistSeeds = playlistResults.flatMap((task, index) => {
                    const result = task.status === "fulfilled" ? task.value : null;
                    if (!isRecord(result) || !Array.isArray(result.playlists)) return [];
                    const queryEntry = playlistQueries[index];
                    if (!queryEntry) return [];
                    return result.playlists.flatMap((playlist) => {
                      if (!isRecord(playlist) || typeof playlist.id !== "string" || seenPlaylistIds.has(playlist.id) || isDisallowedRecommendationCandidate(playlist) || !playlistHasStyleEvidence(playlist, queryEntry.genre)) return [];
                      seenPlaylistIds.add(playlist.id);
                      return [{ id: playlist.id, query: queryEntry.query, genre: queryEntry.genre }];
                    });
                  }).slice(0, MAX_PUBLIC_PLAYLIST_DETAILS);
                  const playlistDetails = await Promise.all(playlistSeeds.map((playlist) => invokeAccount(providerId, () => provider.playlistDetail!(playlist.id, controller.signal))));
                  searchSongs = playlistDetails.flatMap((detail, index) => {
                    const seed = playlistSeeds[index];
                    if (!seed || !isRecord(detail) || !Array.isArray(detail.tracks) || !playlistHasStyleEvidence(detail, seed.genre)) return [];
                    return detail.tracks.map((track) => withSearchContext(track, seed.query, [seed.genre]));
                  });
                } else {
                  if (typeof provider.search !== "function") throw new ServiceError("MUSIC_SEARCH_UNAVAILABLE", 503, `当前${providerId === "qq" ? "QQ 音乐" : "网易云"}连接不支持搜索歌曲。`);
                  const searchResult = await invokeAccount(providerId, () => provider.search!(searchAdjustment.query, { limit: 100, offset: 0, signal: controller.signal }));
                  searchSongs = isRecord(searchResult) && Array.isArray(searchResult.songs) ? searchResult.songs : [];
                }
                if (searchSongs.length === 0) throw new ServiceError("MUSIC_SEARCH_EMPTY", 409, `没有找到“${searchAdjustment.query}”的可用歌曲，可以换一个歌手、歌名或风格试试。`);
                const currentIds = new Set(artifact.items.map((track) => track.id));
                const searchPreferences = { ...artifact.preferences, programPlan: searchSongs.filter((track) => !isRecord(track) || !currentIds.has(String(track.id))) };
                let candidates = await prepareAccountRundown(providerId, lockedState.spec, searchPreferences, controller.signal, undefined, 1, searchAdjustment.count);
                if (candidates.length === 0 && searchAdjustment.count > 1) {
                  candidates = await prepareAccountRundown(providerId, lockedState.spec, searchPreferences, controller.signal, undefined, 1, 1);
                }
                const additions = candidates.filter((track) => !currentIds.has(track.id)).slice(0, searchAdjustment.count);
                if (additions.length === 0) throw new ServiceError("MUSIC_SEARCH_NOT_PLAYABLE", 409, `找到了“${searchAdjustment.query}”的相关歌曲，但当前账号没有可完整播放的新曲目。`);
                const preferredIndexes = artifact.items.flatMap((track, index) => track.liked === true ? [] : [index]);
                const fallbackIndexes = artifact.items.map((_, index) => index).filter((index) => !preferredIndexes.includes(index));
                const replaceIndexes = [...preferredIndexes, ...fallbackIndexes].slice(0, additions.length);
                const replacementByIndex = new Map(replaceIndexes.map((index, additionIndex) => [index, additions[additionIndex]!]));
                ordered = artifact.items.map(({ hostScript: _hostScript, ...track }, index) => {
                  const replacement = replacementByIndex.get(index);
                  return replacement ? { ...replacement, hostMoment: track.hostMoment } : track;
                });
                const existingPlan = Array.isArray(artifact.preferences.programPlan) ? artifact.preferences.programPlan : [];
                artifact.preferences = { ...artifact.preferences, programPlan: [...searchSongs, ...existingPlan] };
                actionMessage = `已找到“${searchAdjustment.query}”的 ${additions.length} 首可播放歌曲，并更新节目单和相关口播。`;
              } else {
                const ids = typedAction === "adjust"
                  ? typeof hostProvider?.adjustRundown === "function"
                    ? await hostProvider.adjustRundown({
                        instruction,
                        tracks: artifact.items.map((track) => ({ id: track.id, title: track.title, artist: track.artist, mood: track.mood })),
                      }, controller.signal)
                    : (() => { throw new ServiceError("HOST_PROVIDER_ERROR", 503, "当前模型不支持节目顺序调整。"); })()
                  : Array.isArray(body.trackIds) ? body.trackIds : [];
                if (ids.length !== artifact.items.length || new Set(ids).size !== artifact.items.length || ids.some((id) => typeof id !== "string" || !artifact.items.some((track) => track.id === id))) {
                  throw new ServiceError("INVALID_INPUT", 400, "曲目顺序必须包含节目单中的全部歌曲且不能重复。");
                }
                ordered = ids.map((id) => artifact.items.find((track) => track.id === id)!).filter(Boolean);
              }
            }
            if (typedAction === "regenerate") ordered = ordered.map(({ hostScript: _hostScript, ...track }) => track);
            else if (typedAction !== "replace") {
              const moments = artifact.items.map((track) => track.hostMoment);
              ordered = ordered.map(({ hostScript: _hostScript, ...track }, index) => ({ ...track, hostMoment: moments[index] }));
            }
            const locked = await lockNeteaseHostScripts(lockedState.spec, ordered, artifact.listenerProfile, controller.signal);
            artifact.items = locked;
            artifact.hostAudio.clear();
            artifact.revision += 1;
            planOperationResults.set(operationKeyValue, { action: typedAction, baseRevision, revision: artifact.revision });
            while (planOperationResults.size > 256) {
              const oldest = planOperationResults.keys().next().value;
              if (typeof oldest === "string") planOperationResults.delete(oldest); else break;
            }
            return { state: lockedState, message: actionMessage };
          });
          writeJson(res, 200, { program: responseProgram(result.state), message: result.message ?? (typedAction === "adjust" ? "AI 已按要求调整节目单并重写口播。" : typedAction === "replace" ? "已在原位置补入一首新歌，并重写口播。" : typedAction === "regenerate" ? "已重新生成节目单和主持词。" : "已更新曲序并重写相邻口播。") });
        } finally {
          req.off("aborted", abort);
          res.off("close", abort);
        }
        return;
      }
      if (action === "regenerate-host") {
        assertPlayerControlAuthorized(req);
        const operationId = operationIdFromBody(body, true)!;
        const baseRevision = typeof body.planRevision === "number" && Number.isSafeInteger(body.planRevision) && body.planRevision >= 0 ? body.planRevision : null;
        if (baseRevision === null) throw new ServiceError("INVALID_INPUT", 400, "节目计划版本无效，请刷新后重试。");
        const controller = new AbortController();
        const abort = () => controller.abort();
        req.once("aborted", abort);
        res.once("close", abort);
        try {
          const result = await serializeProgramAction(programId, async () => {
            if (controller.signal.aborted) throw new ServiceError("REQUEST_ABORTED", 499, "请求已取消，主持词未修改。");
            const lockedState = assertProgram(programId);
            assertGeneration(lockedState, generationFromBody(body, true));
            if (!["draft", "awaiting_confirmation"].includes(lockedState.status)) throw new ServiceError("PROGRAM_NOT_ACTIVE", 409, "节目已经开始，不能再重写口播。");
            const artifact = accountRundowns.get(programId);
            if (!artifact) throw new ServiceError("PROGRAM_ARTIFACT_MISSING", 409, "节目歌单已丢失，请重新创建。");
            if (artifact.revision !== baseRevision) throw new ServiceError("GENERATION_MISMATCH", 409, "节目单已经变化，请刷新后再重写口播。");
            const operationKeyValue = operationKey(programId, operationId);
            const replay = planOperationResults.get(operationKeyValue);
            if (replay) {
              if (replay.action !== "regenerate-host" || replay.baseRevision !== baseRevision) throw new ServiceError("OPERATION_REUSED", 409, publicMessage("OPERATION_REUSED"));
              return lockedState;
            }
            let locked: ProgramRundownItem[];
            try {
              locked = await lockNeteaseHostScripts(lockedState.spec, artifact.items, artifact.listenerProfile, controller.signal, "上一轮口播未通过节目监制审核。请只重写主持口播，保留本次歌单和歌曲顺序。中间口播作为一组整体优化：减少重复句式，提升语气、用词和音乐信息密度。开场和结尾只修正固定硬伤。");
            } catch (error) {
              if (!(error instanceof ServiceError) || error.code !== "HOST_PROVIDER_ERROR") throw error;
              locked = createFinalHostScriptVersion(lockedState.spec, artifact.items);
            }
            artifact.items = locked;
            artifact.hostAudio.clear();
            artifact.hostScriptsPending = false;
            artifact.hostScriptsFinalized = true;
            artifact.revision += 1;
            planOperationResults.set(operationKeyValue, { action: "regenerate-host", baseRevision, revision: artifact.revision });
            while (planOperationResults.size > 256) {
              const oldest = planOperationResults.keys().next().value;
              if (typeof oldest === "string") planOperationResults.delete(oldest); else break;
            }
            return lockedState;
          });
          writeJson(res, 200, {
            program: responseProgram(result),
            message: "口播已生成最终可播版本，歌单和顺序没有变化。",
          });
        } finally {
          req.off("aborted", abort);
          res.off("close", abort);
        }
        return;
      }
      if (action === "confirm") {
        const qqApiSource = state.spec.sourceId === "qq_music" && qqApiEnabled;
        const desktopSource = state.spec.sourceId === "qq_music" && !qqApiSource;
        const accountWriteSource = state.spec.sourceId === "netease_music" || qqApiSource;
        if (desktopSource || accountWriteSource) assertPlayerControlAuthorized(req);
        const operationId = operationIdFromBody(body, desktopSource || accountWriteSource);
        const confirmController = accountWriteSource ? new AbortController() : null;
        const abortConfirm = () => {
          if (!res.writableEnded) confirmController?.abort();
        };
        if (confirmController) {
          req.once("aborted", abortConfirm);
          res.once("close", abortConfirm);
        }
        const response = await serializeProgramAction(programId, async () => {
          if (confirmController?.signal.aborted) throw new ServiceError("REQUEST_ABORTED", 499, "请求已取消，未继续写入网易云账号。");
          const lockedState = assertProgram(programId);
          if (operationId) {
            const previous = readOperationResult(operationKey(programId, operationId), "confirm");
            if (previous) return { state: lockedState, replayed: true };
          }
          if (lockedState.status !== "draft" && lockedState.status !== "awaiting_confirmation") {
            return { state: lockedState, replayed: true };
          }
          assertGeneration(lockedState, generationFromBody(body, false));
          if (lockedState.spec.sourceId === "netease_music" || (lockedState.spec.sourceId === "qq_music" && qqApiEnabled)) {
            if (body.keepPlaylist === true) accountPlaylistKeepRequests.add(programId);
            const accountArtifact = accountRundowns.get(programId);
            let exactAccountRundown = accountArtifact?.items;
            if (!exactAccountRundown || !accountArtifact?.accountUid) {
              throw new ServiceError("PROGRAM_ARTIFACT_MISSING", 409, "开播前锁定的节目资料已丢失，请退出本次节目后重新创建。");
            }
            const expectedPlanRevision = body.planRevision === undefined ? 0 : typeof body.planRevision === "number" && Number.isSafeInteger(body.planRevision) ? body.planRevision : null;
            if (expectedPlanRevision === null || accountArtifact?.revision !== expectedPlanRevision) {
              throw new ServiceError("GENERATION_MISMATCH", 409, "节目单已经变化，请先查看最新计划再确认。");
            }
            const hostTracks = exactAccountRundown.filter((item) => Boolean(item.hostScript));
            if (accountArtifact.hostScriptsPending || hostTracks.length === 0) throw new ServiceError("HOST_PROVIDER_ERROR", 409, "本次节目口播还没有通过审核，请先重新生成口播。");
            try {
              const providerId = lockedState.spec.sourceId === "qq_music" ? "qq" : "netease";
              const provider = providerId === "qq" ? await requireQq() : await requireNetease();
              const currentAccount = await invokeAccountStage(providerId, "核对账号", () => provider.account!(confirmController!.signal));
              if (!isRecord(currentAccount) || currentAccount.uid !== accountArtifact.accountUid) {
                throw new ServiceError("ACCOUNT_CHANGED", 409, `${providerId === "qq" ? "QQ 音乐" : "网易云"}账号已经变化，请退出本次节目后重新生成。`);
              }
              const revalidated = await revalidateAccountRundown(providerId, lockedState.spec, accountArtifact, confirmController!.signal);
              if (revalidated.replacedIndexes.length > 0) {
                const previousItems = exactAccountRundown;
                const affectedIndexes = new Set(revalidated.replacedIndexes.flatMap((index) => index > 0 ? [index - 1, index] : [index]));
                const relocked = await lockNeteaseHostScripts(lockedState.spec, revalidated.items, accountArtifact.listenerProfile, confirmController!.signal, "开播前发现个别歌曲无法由当前账号完整播放。请保持节目结构，只为替换后的免费可播歌曲修正相关衔接口播。");
                exactAccountRundown = relocked.map((item, index) => affectedIndexes.has(index)
                  ? item
                  : { ...item, hostMoment: previousItems[index]?.hostMoment, hostScript: previousItems[index]?.hostScript });
                accountArtifact.items = exactAccountRundown;
                for (const index of affectedIndexes) {
                  const previousId = previousItems[index]?.id;
                  const replacementId = exactAccountRundown[index]?.id;
                  if (previousId) accountArtifact.hostAudio.delete(previousId);
                  if (replacementId) accountArtifact.hostAudio.delete(replacementId);
                }
                accountArtifact.revision += 1;
              }
              const revalidatedHostTracks = exactAccountRundown.filter((item) => Boolean(item.hostScript));
              if (revalidatedHostTracks.some((item) => item.hostScript?.audioReady !== true || !accountArtifact.hostAudio.has(item.id))) {
                const prepared = await prepareLockedHostAudio(lockedState.spec, exactAccountRundown, confirmController!.signal);
                accountArtifact.items = prepared.items;
                accountArtifact.hostAudio = prepared.audio;
                exactAccountRundown = prepared.items;
              }
              if (lockedState.spec.sourceId === "qq_music" && qqApiEnabled) {
                await provisionQqPlaylist(programId, lockedState.spec, exactAccountRundown, accountArtifact.accountUid, confirmController!.signal);
              } else {
                await provisionNeteasePlaylist(programId, lockedState.spec, exactAccountRundown, confirmController!.signal);
              }
            } catch (error) {
              if (error instanceof ServiceError && error.code === "NETEASE_PROVIDER_ERROR" && error.message === "网易云 Cloud Music API request failed") {
                throw new ServiceError("NETEASE_PROVIDER_ERROR", 502, "网易云创建或写入节目歌单失败，请重试；已创建的歌单会自动复用。");
              }
              throw error;
            }
          } else if (desktopSource) {
            let personalizationTerms: string[] = [];
            await prepareExclusiveDesktopPlayback(lockedState.spec.sourceId as DesktopPlayerSource, operationId!);
            const prepared = await desktopProgramController.prepare(
              lockedState.spec.sourceId as DesktopPlayerSource,
              lockedState.spec.scenePreset,
              lockedState.spec.sceneDescription,
              operationId!,
              personalizationTerms,
            );
            if (!prepared.ok) {
              throw new ServiceError("DESKTOP_PROGRAM_FAILED", 409, prepared.detail || publicMessage("DESKTOP_PROGRAM_FAILED"));
            }
            desktopSelections.set(programId, prepared);
          }
          let nextState: ProgramState | null;
          try {
            if (confirmController?.signal.aborted) throw new ServiceError("REQUEST_ABORTED", 499, "请求已取消，节目未开播。");
            nextState = await invokeEngine("confirm", [programId]);
          } catch (error) {
            if (desktopSource) {
              await pauseDesktopProgram(lockedState, `rollback-${programId}-${operationId}`).catch(() => false);
              desktopProgramController.invalidate?.(lockedState.spec.sourceId as DesktopPlayerSource, operationId!);
              desktopSelections.delete(programId);
            }
            throw error;
          }
          if (!nextState) throw new ServiceError("ENGINE_INVALID_STATE", 500, publicMessage("INTERNAL_ERROR"));
          if (desktopSource && nextState.status === "failed") {
            await pauseDesktopProgram(nextState, `rollback-${programId}-${operationId}`).catch(() => false);
          }
          await stopDesktopForTerminal(lockedState, nextState);
          scheduleProgramDeadline(nextState);
          if (accountWriteSource && ACTIVE_STATUSES.has(nextState.status)) {
            const artifact = accountRundowns.get(programId);
            const providerId = lockedState.spec.sourceId === "qq_music" ? "qq" : "netease";
            await persistPlayedTrackSnapshot(providerId, artifact?.accountUid, artifact?.preferences, lockedState.spec, artifact?.items[artifact.index], programId).catch(() => undefined);
          }
          if (operationId) rememberOperationResult(operationKey(programId, operationId), "confirm", nextState);
          return { state: nextState, replayed: false };
        }).finally(() => {
          if (confirmController) {
            req.off("aborted", abortConfirm);
            res.off("close", abortConfirm);
          }
        });
        updateDesktopPet(response.state);
        writeJson(res, 200, { program: responseProgram(response.state), ...(response.replayed ? { replayed: true } : {}) });
        return;
      }
      if (action === "heartbeat") {
        const generation = generationFromBody(body, true)!;
        assertGeneration(state, generation);
        const nextState = await invokeEngine("heartbeat", [programId, generation]);
        if (!nextState) throw new ServiceError("ENGINE_INVALID_STATE", 500, publicMessage("INTERNAL_ERROR"));
        await stopDesktopForTerminal(state, nextState);
        if (TERMINAL_STATUSES.has(nextState.status)) updateDesktopPet(nextState);
        writeJson(res, 200, { program: responseProgram(nextState) });
        return;
      }
      if (action === "keep-playlist") {
        assertPlayerControlAuthorized(req);
        const response = await serializeProgramAction(programId, async () => {
          const lockedState = assertProgram(programId);
          if (lockedState.spec.sourceId !== "netease_music" && !(lockedState.spec.sourceId === "qq_music" && qqApiEnabled)) {
            throw new ServiceError("INVALID_INPUT", 400, "当前音源没有账户歌单。");
          }
          const receipt = keepAccountPlaylist(programId);
          if (receipt?.status === "deleted") throw new ServiceError("PROGRAM_ARTIFACT_MISSING", 409, "本次临时歌单已经清理，不能再保存到账户。");
          return lockedState;
        });
        writeJson(res, 200, { program: responseProgram(response), playlist: accountPlaylists.get(programId) });
        return;
      }
      if (action === "next" || action === "stop") {
        const operationId = operationIdFromBody(body, true)!;
        const generation = generationFromBody(body, true)!;
        const response = await serializeProgramAction(programId, async () => {
          const lockedState = assertProgram(programId);
          const desktopSource = lockedState.spec.sourceId === "qq_music" && !qqApiEnabled;
          if (desktopSource) assertPlayerControlAuthorized(req);
          const key = operationKey(programId, operationId);
          const previous = readOperationResult(key, action, generation);
          if (previous) return { state: lockedState, replayed: true };
          if (action === "next") assertGeneration(lockedState, generation);
          if (TERMINAL_STATUSES.has(lockedState.status)) throw new ServiceError("PROGRAM_TERMINAL", 409, publicMessage("PROGRAM_TERMINAL"));
          if (action === "next" && lockedState.status !== "on_air") throw new ServiceError("PROGRAM_NOT_ACTIVE", 409, "节目尚未开始或正在结束，不能切歌。");
          const exactNetease = lockedState.spec.sourceId === "netease_music" || (lockedState.spec.sourceId === "qq_music" && qqApiEnabled) ? accountRundowns.get(programId) : undefined;
          let exactNeteaseTargetIndex: number | null = null;
          let exhaustedNetease = false;
          if (exactNetease && action === "next") {
            if (exactNetease.index + 1 >= exactNetease.items.length) {
              exhaustedNetease = true;
            } else {
              exactNeteaseTargetIndex = exactNetease.index + 1;
            }
          } else if (desktopSource && action === "next") {
            const deadline = lockedState.deadlineAt ? Date.parse(lockedState.deadlineAt) : Number.POSITIVE_INFINITY;
            if (Date.now() + 5_500 < deadline) {
              const player = await desktopPlayerController.next(lockedState.spec.sourceId as DesktopPlayerSource, operationId);
              if (!player.ok) throw new ServiceError("DESKTOP_NEXT_UNCONFIRMED", 409, player.detail || publicMessage("DESKTOP_NEXT_UNCONFIRMED"));
            }
          }
          if (desktopSource && action === "stop") {
            const stopped = await pauseDesktopProgram(lockedState, operationId);
            if (!stopped) throw new ServiceError("DESKTOP_STOP_UNCONFIRMED", 409, publicMessage("DESKTOP_STOP_UNCONFIRMED"));
            terminalDesktopStops.add(lockedState.id);
          }
          const nextState = await invokeEngine(exhaustedNetease ? "stop" : action, [{ programId, operationId, generation: action === "stop" ? lockedState.generation : generation }]);
          if (!nextState) throw new ServiceError("ENGINE_INVALID_STATE", 500, publicMessage("INTERNAL_ERROR"));
          if (exactNeteaseTargetIndex !== null && exactNetease && ACTIVE_STATUSES.has(nextState.status)) exactNetease.index = exactNeteaseTargetIndex;
          if (exactNeteaseTargetIndex !== null && exactNetease && ACTIVE_STATUSES.has(nextState.status)) {
            const providerId = lockedState.spec.sourceId === "qq_music" ? "qq" : "netease";
            await persistPlayedTrackSnapshot(providerId, exactNetease.accountUid, exactNetease.preferences, lockedState.spec, exactNetease.items[exactNeteaseTargetIndex], programId).catch(() => undefined);
          }
          await stopDesktopForTerminal(lockedState, nextState);
          rememberOperationResult(key, action, nextState, generation);
          return { state: nextState, replayed: false };
        });
        updateDesktopPet(response.state, action === "next" && !TERMINAL_STATUSES.has(response.state.status) ? "transition" : undefined);
        writeJson(res, 200, { program: responseProgram(response.state), ...(response.replayed ? { replayed: true } : {}) });
        return;
      }
    }
    if (pathname === "/api/host/preview") {
      assertPlayerControlAuthorized(req);
      const controller = new AbortController();
      const abort = () => controller.abort();
      req.once("aborted", abort);
      res.once("close", abort);
      try {
        const lockedProgramId = typeof body.programId === "string" ? validateProgramId(body.programId) : null;
        const lockedTrackId = typeof body.trackId === "string" ? body.trackId : null;
        const lockedGeneration = lockedProgramId && lockedTrackId ? generationFromBody(body, true) : null;
        if (lockedProgramId && lockedTrackId && lockedGeneration !== null) {
          const key = `${lockedProgramId}:${lockedGeneration}:${lockedTrackId}`;
          // Validate status, generation and current track even for a cache hit.
          const state = assertProgram(lockedProgramId);
          assertGeneration(state, lockedGeneration);
          const rundown = accountRundowns.get(lockedProgramId);
          if (!["preparing", "on_air", "closing"].includes(state.status) || rundown?.items[rundown.index]?.id !== lockedTrackId) {
            throw new ServiceError("HOST_SCRIPT_NOT_CURRENT", 409, "只能播放当前曲目的已锁定主持文案。");
          }
          const cached = lockedHostPreviewResults.get(key);
          if (cached && cached.expiresAt > Date.now()) {
            writeJson(res, 200, cached.result);
            return;
          }
          if (cached) lockedHostPreviewResults.delete(key);
          let pending = pendingLockedHostPreviews.get(key);
          if (!pending) {
            const sharedController = new AbortController();
            const entry = {
              controller: sharedController,
              waiters: 0,
              promise: handleHostPreview(body, sharedController.signal).then((result) => {
              const audioResult = isRecord(result.audio) ? result.audio : {};
              const current = stateNow();
              const currentRundown = current ? accountRundowns.get(current.id) : undefined;
              if (audioResult.status === "ready" && current?.id === lockedProgramId && current.generation === lockedGeneration && currentRundown?.items[currentRundown.index]?.id === lockedTrackId) {
                lockedHostPreviewResults.set(key, { result, expiresAt: Date.now() + AUDIO_TTL_MS });
              }
              return result;
              }).finally(() => pendingLockedHostPreviews.delete(key)),
            };
            pending = entry;
            pendingLockedHostPreviews.set(key, entry);
          }
          pending.waiters += 1;
          try {
            const requestAborted = new Promise<never>((_, reject) => {
              if (controller.signal.aborted) {
                reject(new ServiceError("REQUEST_ABORTED", 499, "主持语音请求已取消。"));
                return;
              }
              controller.signal.addEventListener("abort", () => reject(new ServiceError("REQUEST_ABORTED", 499, "主持语音请求已取消。")), { once: true });
            });
            const previewResult = await Promise.race([pending.promise, requestAborted]);
            const latest = stateNow();
            const latestRundown = latest ? accountRundowns.get(latest.id) : undefined;
            if (latest?.id !== lockedProgramId
              || latest.generation !== lockedGeneration
              || !["preparing", "on_air", "closing"].includes(latest.status)
              || latestRundown?.items[latestRundown.index]?.id !== lockedTrackId) {
              throw new ServiceError("HOST_SCRIPT_NOT_CURRENT", 409, "主持语音合成完成时，当前曲目已经变化。");
            }
            writeJson(res, 200, previewResult);
          } finally {
            pending.waiters -= 1;
            if (pending.waiters === 0 && pendingLockedHostPreviews.get(key) === pending) pending.controller.abort();
          }
        } else {
          writeJson(res, 200, await handleHostPreview(body, controller.signal));
        }
      } finally {
        req.off("aborted", abort);
        res.off("close", abort);
      }
      return;
    }
    throw new ServiceError("NOT_FOUND", 404, publicMessage("NOT_FOUND"));
  };

  const server = createServer((req, res) => {
    const requestAt = nowIso();
    const method = req.method ?? "GET";
    const path = (req.url ?? "/").split("?", 1)[0]!.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":id");
    let failureCode: string | undefined;
    res.once("finish", () => rememberDiagnosticEvent({ at: requestAt, method, path, status: res.statusCode, ...(failureCode ? { code: failureCode } : {}) }));
    void handle(req, res).catch((error) => {
      const serviceError = failFromUnknown(error, "INTERNAL_ERROR");
      failureCode = serviceError.code;
      if (!res.headersSent) writeError(res, serviceError);
      else res.destroy();
    });
  });
  server.requestTimeout = 25_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));

  const service: LocalService = {
    server,
    get port() {
      return actualPort;
    },
    async start() {
      if (started) return { host, port: actualPort };
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          rejectPromise(error);
        };
        const onListening = () => {
          server.off("error", onError);
          const address = server.address();
          if (address && typeof address === "object") actualPort = address.port;
          resolvePromise();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(configuredPort, DEFAULT_HOST);
      });
      started = true;
      tickTimer = setInterval(() => {
        if (tickInFlight) return;
        tickInFlight = true;
        pruneAudio(audio);
        try {
          const before = stateNow();
          void Promise.resolve(engine.tick())
            .then((value) => asProgramState(value) ?? stateNow())
            .then(async (after) => {
              await stopDesktopForTerminal(before, after);
              if (after && before?.status !== after.status && TERMINAL_STATUSES.has(after.status)) updateDesktopPet(after);
              for (const pending of [...pendingTerminalStops.values()]) {
                await attemptTerminalDesktopStop(pending.state);
              }
            })
            .catch(() => undefined)
            .finally(() => {
              tickInFlight = false;
            });
        } catch {
          tickInFlight = false;
          // A tick failure is reflected by the next state read; do not log secrets.
        }
      }, 1000);
      return { host, port: actualPort };
    },
    async stop() {
      if (tickTimer) clearInterval(tickTimer);
      tickTimer = undefined;
      for (const timer of programDeadlineTimers.values()) clearTimeout(timer);
      programDeadlineTimers.clear();
      for (const programId of accountRundowns.keys()) releaseProgramHostAudio(programId);
      audio.clear();
      desktopPetController.stop();
      let active: ProgramState | null = null;
      try {
        active = stateNow();
      } catch {
        // Shutdown must still close the listener when engine state is unavailable.
      }
      if (active && ACTIVE_STATUSES.has(active.status)) {
        await pauseDesktopProgram(active, `service-stop-${active.id}-${active.generation}`).catch(() => false);
      }
      for (const pending of [...pendingTerminalStops.values()]) {
        if (active && active.id !== pending.state.id && ACTIVE_STATUSES.has(active.status) && active.spec.sourceId === pending.state.spec.sourceId) continue;
        while (pending.attempts < 3 && pendingTerminalStops.has(pending.state.id)) {
          await attemptTerminalDesktopStop(pending.state).catch(() => undefined);
        }
      }
      if (!started) return;
      await new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
      });
      started = false;
    },
  };
  return service;
}

export async function startServer(options: LocalServiceOptions = {}): Promise<LocalService> {
  const service = await createLocalService(options);
  const address = await service.start();
  process.stdout.write(`AI music radio server listening on http://${address.host}:${address.port}\n`);
  return service;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  void startServer().then((service) => {
    const stop = () => {
      void service.stop().finally(() => process.exit(0));
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  }).catch((error) => {
    const serviceError = failFromUnknown(error, "INTERNAL_ERROR");
    process.stderr.write(`${serviceError.code}: ${serviceError.message}\n`);
    process.exitCode = 1;
  });
}
