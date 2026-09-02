import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import {
  SCENE_PRESETS,
  type ScenePreset,
} from "../shared/contracts.js";
import {
  DESKTOP_PLAYER_SOURCES,
  type DesktopPlayerControllerLike,
  type DesktopPlayerResult,
  type DesktopPlayerSource,
  type DesktopPlayerState,
  DesktopPlayerController,
} from "./desktop-player.js";

const execFileAsync = promisify(execFile);

/** The only music vocabulary that may be copied out of a scene description. */
export const ALLOWLISTED_MUSIC_TAGS = [
  "pop",
  "rock",
  "folk",
  "electronic",
  "dance",
  "hip hop",
  "easy listening",
  "jazz",
  "country",
  "r&b soul",
  "classical",
  "ethnic",
  "britpop",
  "metal",
  "punk",
  "blues",
  "reggae",
  "world music",
  "latin",
  "new age",
  "gufeng",
  "post rock",
  "bossa nova",
] as const;

export type AllowlistedMusicTag = (typeof ALLOWLISTED_MUSIC_TAGS)[number];

/** Fixed terms keep the provider query useful without trusting user prose. */
export const DESKTOP_SCENE_QUERY_TERMS: Record<ScenePreset, string> = {
  late_night: "relax chill easy listening",
  study: "focus concentration",
  workout: "workout",
  commute: "groove rhythm upbeat",
  party: "party",
};

const MAX_QUERY_LENGTH = 64;
export const DESKTOP_PROGRAM_OPERATION_CACHE_LIMIT = 128;
const DEFAULT_HELPER_TIMEOUT_MS = 15_000;
const DEFAULT_HELPER_MAX_BUFFER = 16 * 1024;
const HELPER_PATH = join(dirname(fileURLToPath(import.meta.url)), "desktop-automation.swift");
const VALID_PLAYER_STATES: ReadonlySet<string> = new Set([
  "ready",
  "connected_idle",
  "ducked",
  "restored",
  "playing",
  "paused",
  "next_requested",
  "command_unconfirmed",
  "restore_incomplete",
  "operation_reused",
  "app_not_running",
  "screen_locked",
  "automation_denied",
  "busy",
  "stale_operation",
  "failed",
]);

export type DesktopAutomationOutput =
  | "READY"
  | "APP_NOT_RUNNING"
  | "SCREEN_LOCKED"
  | "WINDOW_UNAVAILABLE"
  | "AUTOMATION_FAILED";

export type DesktopProgramState =
  | "ready"
  | "app_not_running"
  | "screen_locked"
  | "window_unavailable"
  | "automation_failed"
  | "player_inspection_failed"
  | "player_already_playing"
  | "invalid_source"
  | "invalid_scene"
  | "invalid_operation"
  | "operation_cache_full"
  | "operation_reused"
  | DesktopPlayerState;

export interface DesktopProgramResult {
  sourceId: DesktopPlayerSource;
  operationId: string;
  query: string;
  state: DesktopProgramState;
  ok: boolean;
  detail: string;
  replayed?: boolean;
}

export interface DesktopProgramControllerLike {
  prepare(
    sourceId: DesktopPlayerSource,
    scenePreset: ScenePreset,
    sceneDescription: string,
    operationId: string,
  ): Promise<DesktopProgramResult>;
  invalidate?(sourceId: DesktopPlayerSource, operationId: string): void;
}

export type DesktopAutomationRunner = (
  sourceId: DesktopPlayerSource,
  query: string,
) => Promise<string>;

export interface DesktopProgramControllerOptions {
  playerController?: DesktopPlayerControllerLike;
  player?: DesktopPlayerControllerLike;
  runner?: DesktopAutomationRunner;
}

type StoredOperation = {
  sourceId: DesktopPlayerSource;
  scenePreset: ScenePreset;
  query: string;
  promise: Promise<DesktopProgramResult>;
  result?: DesktopProgramResult;
};

const HELPER_STATE_DETAILS: Record<DesktopAutomationOutput, string> = {
  READY: "桌面搜索与播放操作已发送；播放状态已通过桌面客户端回执确认。",
  APP_NOT_RUNNING: "桌面音乐客户端未运行。",
  SCREEN_LOCKED: "Mac 当前处于锁屏状态；解锁后才能自动搜索并开始播放。",
  WINDOW_UNAVAILABLE: "未找到满足尺寸要求的桌面音乐客户端窗口。",
  AUTOMATION_FAILED: "桌面音乐客户端自动化失败。",
};

const TAG_PATTERNS: ReadonlyArray<readonly [AllowlistedMusicTag, RegExp]> = [
  ["pop", /(?:^|[^a-z0-9])pop(?:$|[^a-z0-9])/i],
  ["rock", /(?:^|[^a-z0-9])(?:rock|alternative|indie[\s-]+rock)(?:$|[^a-z0-9])/i],
  ["folk", /(?:^|[^a-z0-9])(?:folk|acoustic)(?:$|[^a-z0-9])/i],
  ["electronic", /(?:^|[^a-z0-9])(?:electronic|edm|techno|house|trance|synth)(?:$|[^a-z0-9])/i],
  ["dance", /(?:^|[^a-z0-9])(?:dance|club|dj|disco)(?:$|[^a-z0-9])/i],
  ["hip hop", /(?:^|[^a-z0-9])(?:hip[\s-]+hop|rap|trap|urban)(?:$|[^a-z0-9])/i],
  ["easy listening", /(?:^|[^a-z0-9])(?:easy[\s-]+listening|lofi|lo[\s-]+fi|instrumental|piano)(?:$|[^a-z0-9])/i],
  ["jazz", /(?:^|[^a-z0-9])jazz(?:$|[^a-z0-9])/i],
  ["country", /(?:^|[^a-z0-9])country(?:$|[^a-z0-9])/i],
  ["r&b soul", /(?:^|[^a-z0-9])(?:r&b|rnb|soul|neo[\s-]+soul|funk)(?:$|[^a-z0-9])/i],
  ["classical", /(?:^|[^a-z0-9])classical(?:$|[^a-z0-9])/i],
  ["ethnic", /(?:^|[^a-z0-9])ethnic(?:$|[^a-z0-9])/i],
  ["britpop", /(?:^|[^a-z0-9])(?:britpop|british)(?:$|[^a-z0-9])/i],
  ["metal", /(?:^|[^a-z0-9])metal(?:$|[^a-z0-9])/i],
  ["punk", /(?:^|[^a-z0-9])punk(?:$|[^a-z0-9])/i],
  ["blues", /(?:^|[^a-z0-9])blues(?:$|[^a-z0-9])/i],
  ["reggae", /(?:^|[^a-z0-9])reggae(?:$|[^a-z0-9])/i],
  ["world music", /(?:^|[^a-z0-9])world[\s-]+music(?:$|[^a-z0-9])/i],
  ["latin", /(?:^|[^a-z0-9])latin(?:$|[^a-z0-9])/i],
  ["new age", /(?:^|[^a-z0-9])(?:new[\s-]+age|ambient|drone)(?:$|[^a-z0-9])/i],
  ["gufeng", /(?:^|[^a-z0-9])gufeng(?:$|[^a-z0-9])/i],
  ["post rock", /(?:^|[^a-z0-9])post[\s-]+rock(?:$|[^a-z0-9])/i],
  ["bossa nova", /(?:^|[^a-z0-9])bossa[\s-]+nova(?:$|[^a-z0-9])/i],
];

export function extractAllowlistedMusicTags(sceneDescription: string): AllowlistedMusicTag[] {
  const normalized = sceneDescription.toLocaleLowerCase("en-US");
  const tags: AllowlistedMusicTag[] = [];
  const seen = new Set<AllowlistedMusicTag>();
  for (const [tag, pattern] of TAG_PATTERNS) {
    if (!seen.has(tag) && pattern.test(normalized)) {
      seen.add(tag);
      tags.push(tag);
    }
  }
  return tags;
}

export function buildDesktopSearchQuery(scenePreset: ScenePreset, sceneDescription: string, personalizationTerms: readonly string[] = []): string {
  if (!SCENE_PRESETS.includes(scenePreset)) throw new TypeError("scenePreset is invalid");
  if (typeof sceneDescription !== "string") throw new TypeError("sceneDescription must be a string");

  const personalized = personalizationTerms
    .filter((term): term is string => typeof term === "string")
    .map(normalizeQueryTerm)
    .filter(Boolean);
  const terms = personalized.length > 0
    ? [...extractAllowlistedMusicTags(sceneDescription), ...personalized]
    : [DESKTOP_SCENE_QUERY_TERMS[scenePreset], ...extractAllowlistedMusicTags(sceneDescription)];
  let query = "";
  const seen = new Set<string>();
  for (const term of terms) {
    if (!term || seen.has(term)) continue;
    seen.add(term);
    const candidate = query.length > 0 ? `${query} ${term}` : term;
    if (candidate.length > MAX_QUERY_LENGTH) break;
    query = candidate;
  }
  return query;
}

function normalizeQueryTerm(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f"'“”‘’]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24);
}

// These aliases make the query contract explicit to callers that use either verb.
export const generateDesktopSearchQuery = buildDesktopSearchQuery;
export const buildPlaylistSearchQuery = buildDesktopSearchQuery;
export const buildSearchQuery = buildDesktopSearchQuery;
export const extractMusicTags = extractAllowlistedMusicTags;

export const defaultDesktopAutomationRunner: DesktopAutomationRunner = async (sourceId, query) => {
  const { stdout } = await execFileAsync(
    "/usr/bin/swift",
    [HELPER_PATH, sourceId, query],
    { timeout: DEFAULT_HELPER_TIMEOUT_MS, maxBuffer: DEFAULT_HELPER_MAX_BUFFER },
  );
  return stdout.trim();
};

function helperOutput(value: string): DesktopAutomationOutput {
  const output = value.trim();
  return output === "READY" || output === "APP_NOT_RUNNING" || output === "SCREEN_LOCKED" || output === "WINDOW_UNAVAILABLE" || output === "AUTOMATION_FAILED"
    ? output
    : "AUTOMATION_FAILED";
}

function result(
  sourceId: DesktopPlayerSource,
  operationId: string,
  query: string,
  state: DesktopProgramState,
  ok: boolean,
  detail: string,
  replayed = false,
): DesktopProgramResult {
  return {
    sourceId,
    operationId,
    query,
    state,
    ok,
    detail,
    ...(replayed ? { replayed: true } : {}),
  };
}

function isDesktopSource(value: string): value is DesktopPlayerSource {
  return DESKTOP_PLAYER_SOURCES.includes(value as DesktopPlayerSource);
}

function isScenePreset(value: string): value is ScenePreset {
  return SCENE_PRESETS.includes(value as ScenePreset);
}

function isPlayerResult(value: DesktopPlayerResult): value is DesktopPlayerResult {
  if (!value || typeof value !== "object" || typeof value.ok !== "boolean") return false;
  return typeof value.state === "string" && VALID_PLAYER_STATES.has(value.state);
}

export class DesktopProgramController implements DesktopProgramControllerLike {
  private readonly playerController: DesktopPlayerControllerLike;
  private readonly runner: DesktopAutomationRunner;
  private readonly operations = new Map<string, StoredOperation>();
  private operationChain: Promise<void> = Promise.resolve();

  constructor(
    playerOrOptions: DesktopPlayerControllerLike | DesktopProgramControllerOptions = new DesktopPlayerController(),
    runner: DesktopAutomationRunner = defaultDesktopAutomationRunner,
  ) {
    if ("inspect" in playerOrOptions) {
      this.playerController = playerOrOptions;
      this.runner = runner;
      return;
    }
    this.playerController = playerOrOptions.playerController ?? playerOrOptions.player ?? new DesktopPlayerController();
    this.runner = playerOrOptions.runner ?? runner;
  }

  prepare(
    sourceId: DesktopPlayerSource,
    scenePreset: ScenePreset,
    sceneDescription: string,
    operationId: string,
    personalizationTerms?: readonly string[],
  ): Promise<DesktopProgramResult> {
    const safeSourceId = sourceId as string;
    const safeOperationId = typeof operationId === "string" ? operationId : "";
    if (!isDesktopSource(safeSourceId)) {
      return Promise.resolve(result("qq_music", safeOperationId, "", "invalid_source", false, "sourceId is invalid."));
    }
    if (!isScenePreset(scenePreset as string)) {
      return Promise.resolve(result(sourceId, safeOperationId, "", "invalid_scene", false, "scenePreset is invalid."));
    }
    if (safeOperationId.trim().length === 0 || safeOperationId.length > 128) {
      return Promise.resolve(result(sourceId, safeOperationId, buildDesktopSearchQuery(scenePreset, typeof sceneDescription === "string" ? sceneDescription : "", personalizationTerms), "invalid_operation", false, "operationId must be a non-empty string up to 128 characters."));
    }

    let query: string;
    try {
      query = buildDesktopSearchQuery(scenePreset, sceneDescription, personalizationTerms);
    } catch {
      return Promise.resolve(result(sourceId, safeOperationId, "", "invalid_scene", false, "sceneDescription is invalid."));
    }

    const key = `${sourceId}:${safeOperationId}`;
    const previous = this.operations.get(key);
    if (previous) {
      if (previous.scenePreset !== scenePreset || previous.query !== query) {
        return Promise.resolve(result(sourceId, safeOperationId, query, "operation_reused", false, "operationId was already used for a different playlist preparation."));
      }
      if (previous.result) return Promise.resolve({ ...previous.result, replayed: true });
      return previous.promise.then((prepared) => ({ ...prepared, replayed: true }));
    }

    if (!this.makeRoomForOperation()) {
      return Promise.resolve(result(
        sourceId,
        safeOperationId,
        query,
        "operation_cache_full",
        false,
        "桌面自动选歌操作缓存已满；请稍后重试。",
      ));
    }

    const promise = this.enqueue(() => this.execute(sourceId, scenePreset, query, safeOperationId));
    const operation: StoredOperation = { sourceId, scenePreset, query, promise };
    this.operations.set(key, operation);
    void promise.then(
      (prepared) => {
        operation.result = prepared;
      },
      () => {
        operation.result = result(sourceId, safeOperationId, query, "automation_failed", false, HELPER_STATE_DETAILS.AUTOMATION_FAILED);
      },
    );
    return promise;
  }

  invalidate(sourceId: DesktopPlayerSource, operationId: string): void {
    const key = `${sourceId}:${operationId}`;
    const operation = this.operations.get(key);
    if (operation?.result) this.operations.delete(key);
  }

  private makeRoomForOperation(): boolean {
    if (this.operations.size < DESKTOP_PROGRAM_OPERATION_CACHE_LIMIT) return true;
    for (const [key, operation] of this.operations) {
      if (!operation.result) continue;
      this.operations.delete(key);
      if (this.operations.size < DESKTOP_PROGRAM_OPERATION_CACHE_LIMIT) return true;
    }
    return false;
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.operationChain;
    const pending = previous.catch(() => undefined).then(action);
    this.operationChain = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private async execute(
    sourceId: DesktopPlayerSource,
    _scenePreset: ScenePreset,
    query: string,
    operationId: string,
  ): Promise<DesktopProgramResult> {
    let before: DesktopPlayerResult;
    try {
      before = await this.playerController.inspect(sourceId);
    } catch {
      return result(sourceId, operationId, query, "player_inspection_failed", false, "桌面客户端初始播放状态检查失败。");
    }
    if (!isPlayerResult(before)) {
      return result(sourceId, operationId, query, "player_inspection_failed", false, "桌面客户端初始播放状态检查返回无效结果。");
    }
    if (before.state === "ready" || before.state === "playing" || before.state === "ducked") {
      return result(sourceId, operationId, query, "player_already_playing", false, "自动选歌前必须先暂停当前桌面音乐，以验证新节目确实启动。");
    }
    if (before.state !== "connected_idle" && before.state !== "paused") {
      return result(sourceId, operationId, query, before.state, false, before.detail || "桌面客户端尚不能执行自动选歌。");
    }

    let output: DesktopAutomationOutput;
    try {
      output = helperOutput(await this.runner(sourceId, query));
    } catch {
      return result(sourceId, operationId, query, "automation_failed", false, HELPER_STATE_DETAILS.AUTOMATION_FAILED);
    }

    if (output !== "READY") {
      const state: DesktopProgramState = output === "APP_NOT_RUNNING"
        ? "app_not_running"
        : output === "SCREEN_LOCKED"
          ? "screen_locked"
          : output === "WINDOW_UNAVAILABLE"
            ? "window_unavailable"
            : "automation_failed";
      return result(sourceId, operationId, query, state, false, HELPER_STATE_DETAILS[output]);
    }

    let inspected: DesktopPlayerResult;
    try {
      inspected = await this.playerController.inspect(sourceId);
    } catch {
      return result(sourceId, operationId, query, "player_inspection_failed", false, "桌面客户端播放状态检查失败。");
    }
    if (!isPlayerResult(inspected)) {
      return result(sourceId, operationId, query, "player_inspection_failed", false, "桌面客户端播放状态检查返回无效结果。");
    }
    if (inspected.state !== "ready") {
      return result(sourceId, operationId, query, inspected.state, false, inspected.detail || "桌面客户端尚未确认播放。 ".trim());
    }
    return result(sourceId, operationId, query, "ready", true, HELPER_STATE_DETAILS.READY);
  }
}
