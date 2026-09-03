import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { fetchWithTimeout, httpError, providerErrorInfo, readResponseBody } from "./http.js";
import { ProviderError } from "./types.js";

const PROVIDER_NAME = "netease-api";
const DEFAULT_BASE_URL = "http://127.0.0.1:3000";
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_PERSONALIZATION_ITEMS = 10_000;

export type NeteaseApiState =
  | "blocked_by_configuration"
  | "blocked_by_insecure_transport"
  | "unchecked"
  | "ready"
  | "unavailable";

export interface NeteaseApiStatus {
  provider: typeof PROVIDER_NAME;
  configured: boolean;
  baseUrl: string;
  authenticated: boolean;
  timeoutMs: number;
  state: NeteaseApiState;
  error?: ReturnType<ProviderError["toInfo"]>;
  persistentLogin: boolean;
}

export interface NeteaseArtist {
  id: string;
  name: string;
}

export interface NeteaseAlbum {
  id: string;
  name: string;
  coverUrl?: string;
}

export interface NeteaseSong {
  id: string;
  title: string;
  artists: NeteaseArtist[];
  album: NeteaseAlbum;
  durationMs: number;
  popularity?: number;
  releaseYear?: number;
}

export interface NeteaseSongCredits {
  lyricists: string[];
  composers: string[];
  arrangers: string[];
}

export interface NeteaseSearchResult {
  songs: NeteaseSong[];
  total: number;
}

export interface NeteasePlaylistSearchResult {
  playlists: NeteasePlaylistSummary[];
  total: number;
}

export interface NeteasePlaylist {
  id: string;
  name: string;
  description: string | null;
  trackCount: number;
  tracks: NeteaseSong[];
}

export interface NeteasePlaylistCreateResult {
  id: string;
  name: string;
}

export interface NeteasePlaylistTracksResult {
  playlistId: string;
  trackIds: string[];
}

export interface NeteasePlaylistDeleteResult {
  playlistId: string;
  deleted: boolean;
}

export interface NeteaseSongLikeResult {
  trackId: string;
  liked: boolean;
}

export interface NeteaseAccount {
  uid: string;
  nickname: string | null;
}

export interface NeteasePlaylistSummary {
  id: string;
  name: string;
  description: string | null;
  trackCount: number;
  ownerUid: string;
  subscribed: boolean | null;
}

export interface NeteasePlayRecord {
  song: NeteaseSong;
  playCount?: number;
  score?: number;
  playedAt?: number;
}

export interface NeteaseUserPlaylists {
  playlists: NeteasePlaylistSummary[];
  more: boolean;
}

export interface NeteaseSongUrl {
  id: string;
  url: string | null;
  bitrate: number | null;
  size: number | null;
  format: string | null;
  durationMs: number | null;
  isTrial?: boolean;
}

export interface NeteaseQrLogin {
  key: string;
  qrImageDataUrl: string;
}

export type NeteaseQrLoginCode = 800 | 801 | 802 | 803;
export type NeteaseQrLoginState = "expired" | "waiting_scan" | "waiting_confirm" | "authorized";

export interface NeteaseQrLoginCheck {
  code: NeteaseQrLoginCode;
  state: NeteaseQrLoginState;
}

export interface NeteasePlaylistOptions {
  limit?: number;
  offset?: number;
  signal?: AbortSignal;
}

export interface NeteaseRecentSongsOptions {
  limit?: number;
  signal?: AbortSignal;
}

export interface NeteaseListeningHistoryOptions {
  period?: "all" | "week";
  signal?: AbortSignal;
}

export interface NeteaseDailyRecommendationsOptions {
  refresh?: boolean;
  signal?: AbortSignal;
}

export interface NeteaseSimilarSongsOptions {
  limit?: number;
  offset?: number;
  signal?: AbortSignal;
}

export interface NeteaseApiProviderOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  fetchImpl?: typeof globalThis.fetch;
}

export class NeteaseApiProvider {
  private readonly baseUrl: string;
  private readonly configured: boolean;
  private cookie: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly secureTransport: boolean;
  private readonly cookieStorePath: string;
  private authenticated = false;
  private persistentLogin = false;
  private state: NeteaseApiState;
  private lastError?: ReturnType<ProviderError["toInfo"]>;

  constructor(options: NeteaseApiProviderOptions = {}) {
    const env = options.env ?? process.env;
    const configuredBaseUrl = env.NETEASE_API_BASE_URL?.trim() ?? "";
    this.configured = configuredBaseUrl.length > 0;
    this.baseUrl = normalizeBaseUrl(configuredBaseUrl || DEFAULT_BASE_URL);
    this.cookieStorePath = env.NETEASE_COOKIE_STORE_PATH?.trim() ?? "";
    const storedCookie = readStoredCookie(this.cookieStorePath);
    this.cookie = normalizeCookie(env.NETEASE_COOKIE ?? storedCookie, "NETEASE_COOKIE");
    if (!env.NETEASE_COOKIE && storedCookie && this.cookie !== storedCookie) persistCookie(this.cookieStorePath, this.cookie);
    this.persistentLogin = Boolean(!env.NETEASE_COOKIE && storedCookie);
    this.timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.secureTransport = isSecureCredentialTransport(this.baseUrl, this.cookie);
    this.state = !this.configured
      ? "blocked_by_configuration"
      : this.secureTransport
        ? "unchecked"
        : "blocked_by_insecure_transport";
  }

  getStatus(): NeteaseApiStatus {
    return {
      provider: PROVIDER_NAME,
      configured: this.configured,
      baseUrl: this.baseUrl,
      authenticated: this.authenticated,
      persistentLogin: this.persistentLogin,
      timeoutMs: this.timeoutMs,
      state: this.state,
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  async health(signal?: AbortSignal): Promise<NeteaseApiStatus> {
    try {
      const payload = await this.request("/login/status", {}, signal);
      const root = asRecord(payload, "health response");
      const data = asRecord(root.data, "health data");
      if (requireNumber(data.code, "health data.code") !== 200) throw invalidResponse("login status is not successful");
      const account = isRecordValue(data.account) ? data.account : null;
      const profile = isRecordValue(data.profile) ? data.profile : null;
      const anonymous = account?.anonymousUser === true || account?.anonimousUser === true;
      this.authenticated = Boolean(this.cookie && (profile || (account && !anonymous)));
      this.state = "ready";
      this.lastError = undefined;
    } catch (error) {
      const failure = asProviderError(error);
      this.authenticated = false;
      this.lastError = failure.toInfo();
      if (this.state !== "blocked_by_configuration" && this.state !== "blocked_by_insecure_transport") {
        this.state = "unavailable";
      }
    }
    return this.getStatus();
  }

  async search(keywords: string, options: { limit?: number; offset?: number; signal?: AbortSignal } = {}): Promise<NeteaseSearchResult> {
    const cleanKeywords = keywords.trim();
    if (!cleanKeywords) throw invalidInput("search keywords must not be empty");
    const limit = boundedInteger(options.limit, 30, 1, 100, "search limit");
    const offset = boundedInteger(options.offset, 0, 0, Number.MAX_SAFE_INTEGER, "search offset");
    const root = asRecord(await this.request("/cloudsearch", {
      keywords: cleanKeywords,
      type: "1",
      limit: String(limit),
      offset: String(offset),
    }, options.signal), "search response");
    const result = asRecord(root.result, "search result");
    return {
      songs: asArray(result.songs, "search result.songs").map(parseSong),
      total: requireNonNegativeNumber(result.songCount, "search result.songCount"),
    };
  }

  async searchPlaylists(keywords: string, options: { limit?: number; offset?: number; signal?: AbortSignal } = {}): Promise<NeteasePlaylistSearchResult> {
    const cleanKeywords = keywords.trim();
    if (!cleanKeywords) throw invalidInput("playlist search keywords must not be empty");
    const limit = boundedInteger(options.limit, 12, 1, 50, "playlist search limit");
    const offset = boundedInteger(options.offset, 0, 0, Number.MAX_SAFE_INTEGER, "playlist search offset");
    const root = asRecord(await this.request("/cloudsearch", {
      keywords: cleanKeywords,
      type: "1000",
      limit: String(limit),
      offset: String(offset),
    }, options.signal), "playlist search response");
    const result = asRecord(root.result, "playlist search result");
    return {
      playlists: boundedArray(result.playlists, "playlist search result.playlists", MAX_PERSONALIZATION_ITEMS).map(parsePlaylistSummary),
      total: requireNonNegativeNumber(result.playlistCount, "playlist search result.playlistCount"),
    };
  }

  async playlistDetail(id: string | number, signal?: AbortSignal): Promise<NeteasePlaylist> {
    const playlistId = requireInputId(id, "playlist id");
    const root = asRecord(await this.request("/playlist/detail", { id: playlistId }, signal), "playlist response");
    const playlist = asRecord(root.playlist, "playlist");
    return {
      id: requireResponseId(playlist.id, "playlist.id"),
      name: requireString(playlist.name, "playlist.name"),
      description: optionalString(playlist.description, "playlist.description"),
      trackCount: requireNonNegativeNumber(playlist.trackCount, "playlist.trackCount"),
      tracks: asArray(playlist.tracks, "playlist.tracks").map(parseSong),
    };
  }

  async createPlaylist(name: string, signal?: AbortSignal): Promise<NeteasePlaylistCreateResult> {
    const playlistName = requirePlaylistName(name);
    const root = await this.request("/playlist/create", {
      name: playlistName,
      timestamp: String(Date.now()),
    }, signal);
    const body = requireMutationSuccess(root, "create playlist");
    const playlist = isRecordValue(body.playlist) ? body.playlist : null;
    const id = [body.id, playlist?.id]
      .map((value) => normalizeNumericId(value))
      .find((value): value is string => value !== null);
    if (id === undefined) throw invalidResponse("created playlist.id is invalid");
    return {
      id,
      name: playlistName,
    };
  }

  async addSongsToPlaylist(
    playlistId: string | number,
    trackIds: readonly (string | number)[],
    signal?: AbortSignal,
  ): Promise<NeteasePlaylistTracksResult> {
    const cleanPlaylistId = requireInputId(playlistId, "playlist id");
    const cleanTrackIds = requireUniqueTrackIds(trackIds);
    const root = await this.request("/playlist/tracks", {
      op: "add",
      pid: cleanPlaylistId,
      tracks: cleanTrackIds.join(","),
      timestamp: String(Date.now()),
    }, signal);
    requireMutationSuccess(root, "add songs to playlist");
    return { playlistId: cleanPlaylistId, trackIds: cleanTrackIds };
  }

  async deletePlaylist(playlistId: string | number, signal?: AbortSignal): Promise<NeteasePlaylistDeleteResult> {
    const cleanPlaylistId = requireInputId(playlistId, "playlist id");
    const root = await this.request("/playlist/delete", {
      id: cleanPlaylistId,
      timestamp: String(Date.now()),
    }, signal);
    requireMutationSuccess(root, "delete playlist");
    return { playlistId: cleanPlaylistId, deleted: true };
  }

  async setSongLiked(id: string | number, liked: boolean, signal?: AbortSignal): Promise<NeteaseSongLikeResult> {
    const cleanId = requireInputId(id, "song id");
    if (typeof liked !== "boolean") throw invalidInput("liked must be a boolean");
    const root = await this.request("/like", {
      id: cleanId,
      like: String(liked),
      timestamp: String(Date.now()),
    }, signal);
    requireMutationSuccess(root, liked ? "like song" : "unlike song");
    return { trackId: cleanId, liked };
  }

  async songDetail(ids: readonly (string | number)[], signal?: AbortSignal): Promise<NeteaseSong[]> {
    if (ids.length === 0) throw invalidInput("song ids must not be empty");
    if (ids.length > 500) throw invalidInput("song ids must contain at most 500 items");
    const cleanIds = ids.map((id) => requireInputId(id, "song id"));
    const root = asRecord(await this.request("/song/detail", { ids: cleanIds.join(",") }, signal), "song detail response");
    return asArray(root.songs, "song detail songs").map(parseSong);
  }

  async songCredits(id: string | number, signal?: AbortSignal): Promise<NeteaseSongCredits> {
    const songId = requireInputId(id, "song id");
    const root = asRecord(await this.request("/lyric/new", { id: songId }, signal), "song lyric response");
    return parseSongCredits(root);
  }

  async songUrl(id: string | number, options: { level?: string; signal?: AbortSignal } = {}): Promise<NeteaseSongUrl> {
    const songId = requireInputId(id, "song id");
    const level = options.level?.trim() || "standard";
    if (!/^[a-zA-Z0-9_]+$/.test(level)) throw invalidInput("song quality level is invalid");
    const root = asRecord(await this.request("/song/url/v1", { id: songId, level }, options.signal), "song URL response");
    const entries = asArray(root.data, "song URL data");
    if (entries.length !== 1) throw invalidResponse("song URL data must contain exactly one item");
    const entry = asRecord(entries[0], "song URL item");
    const url = optionalString(entry.url, "song URL item.url");
    if (url !== null && !isSafePlaybackUrl(url)) throw invalidResponse("song URL item.url is not a safe public HTTP(S) URL");
    return {
      id: requireResponseId(entry.id, "song URL item.id"),
      url,
      bitrate: optionalNonNegativeNumber(entry.br, "song URL item.br"),
      size: optionalNonNegativeNumber(entry.size, "song URL item.size"),
      format: optionalString(entry.type, "song URL item.type"),
      durationMs: optionalNonNegativeNumber(entry.time, "song URL item.time"),
      ...(entry.freeTrialInfo === undefined ? {} : { isTrial: entry.freeTrialInfo !== null }),
    };
  }

  async account(signal?: AbortSignal): Promise<NeteaseAccount> {
    const root = asRecord(await this.request("/user/account", {}, signal), "account response");
    const account = isRecordValue(root.account) ? root.account : null;
    const profile = isRecordValue(root.profile) ? root.profile : null;
    const uid = profile?.userId ?? profile?.id ?? account?.id;
    if (profile === null && account?.anonymousUser === true) throw businessError("Netease account is not authenticated");
    if (profile === null && account?.anonimousUser === true) throw businessError("Netease account is not authenticated");
    return {
      uid: requireResponseId(uid, "account uid"),
      nickname: optionalString(profile?.nickname, "account nickname"),
    };
  }

  async userPlaylists(uid: string | number, options: NeteasePlaylistOptions = {}): Promise<NeteaseUserPlaylists> {
    const userId = requireInputId(uid, "user id");
    const limit = boundedInteger(options.limit, 30, 1, 100, "playlist limit");
    const offset = boundedInteger(options.offset, 0, 0, Number.MAX_SAFE_INTEGER, "playlist offset");
    const root = asRecord(await this.request("/user/playlist", {
      uid: userId,
      limit: String(limit),
      offset: String(offset),
    }, options.signal), "user playlists response");
    const playlists = boundedArray(root.playlist, "user playlists", MAX_PERSONALIZATION_ITEMS);
    return {
      playlists: playlists.map(parsePlaylistSummary),
      more: requireBoolean(root.more, "user playlists.more"),
    };
  }

  async likedSongIds(uid: string | number, signal?: AbortSignal): Promise<string[]> {
    const userId = requireInputId(uid, "user id");
    const root = asRecord(await this.request("/likelist", { uid: userId }, signal), "liked songs response");
    return boundedArray(root.ids, "liked songs ids", MAX_PERSONALIZATION_ITEMS).map((id) => requireResponseId(id, "liked song id"));
  }

  async recentSongs(options: NeteaseRecentSongsOptions = {}): Promise<NeteasePlayRecord[]> {
    const limit = boundedInteger(options.limit, 100, 1, 100, "recent songs limit");
    const root = asRecord(await this.request("/record/recent/song", { limit: String(limit) }, options.signal), "recent songs response");
    const data = asRecord(root.data, "recent songs data");
    return boundedArray(data.list, "recent songs list", MAX_PERSONALIZATION_ITEMS).map(parseRecentSongRecord);
  }

  async listeningHistory(uid: string | number, options: NeteaseListeningHistoryOptions = {}): Promise<NeteasePlayRecord[]> {
    const userId = requireInputId(uid, "user id");
    const period = options.period ?? "all";
    if (period !== "all" && period !== "week") throw invalidInput("listening history period is invalid");
    const root = asRecord(await this.request("/user/record", {
      uid: userId,
      type: period === "week" ? "1" : "0",
    }, options.signal), "listening history response");
    const entries = period === "week" ? root.weekData : root.allData;
    return boundedArray(entries, `listening history ${period} data`, MAX_PERSONALIZATION_ITEMS).map(parseHistoryRecord);
  }

  async dailyRecommendations(options: NeteaseDailyRecommendationsOptions = {}): Promise<NeteaseSong[]> {
    if (options.refresh !== undefined && typeof options.refresh !== "boolean") {
      throw invalidInput("daily recommendations refresh must be a boolean");
    }
    const query: Record<string, string> = {};
    if (options.refresh !== undefined) query.afresh = String(options.refresh);
    if (options.refresh === true) query.timestamp = String(Date.now());
    const root = asRecord(await this.request("/recommend/songs", query, options.signal), "daily recommendations response");
    const data = asRecord(root.data, "daily recommendations data");
    return boundedArray(data.dailySongs, "daily recommendations songs", MAX_PERSONALIZATION_ITEMS).map(parseSong);
  }

  async personalFm(signal?: AbortSignal): Promise<NeteaseSong[]> {
    const root = asRecord(await this.request("/personal_fm", { timestamp: String(Date.now()) }, signal), "personal FM response");
    return boundedArray(root.data, "personal FM songs", MAX_PERSONALIZATION_ITEMS).map(parseSong);
  }

  async similarSongs(id: string | number, options: NeteaseSimilarSongsOptions = {}): Promise<NeteaseSong[]> {
    const songId = requireInputId(id, "song id");
    const limit = boundedInteger(options.limit, 50, 1, 100, "similar songs limit");
    const offset = boundedInteger(options.offset, 0, 0, Number.MAX_SAFE_INTEGER, "similar songs offset");
    const root = asRecord(await this.request("/simi/song", {
      id: songId,
      limit: String(limit),
      offset: String(offset),
    }, options.signal), "similar songs response");
    return boundedArray(root.songs, "similar songs", MAX_PERSONALIZATION_ITEMS).map(parseSong);
  }

  async createQrLogin(signal?: AbortSignal): Promise<NeteaseQrLogin> {
    const timestamp = String(Date.now());
    const keyRoot = asRecord(await this.request("/login/qr/key", { timestamp }, signal), "QR login key response");
    const keyData = asRecord(keyRoot.data, "QR login key data");
    const key = requireString(keyData.unikey, "QR login key");
    if (key.length > 512) throw invalidResponse("QR login key is too long");

    const imageRoot = asRecord(await this.request("/login/qr/create", {
      key,
      qrimg: "true",
      timestamp: String(Date.now()),
    }, signal), "QR login image response");
    const imageData = asRecord(imageRoot.data, "QR login image data");
    const qrImageDataUrl = requireString(imageData.qrimg, "QR login image");
    if (!isQrImageDataUrl(qrImageDataUrl)) throw invalidResponse("QR login image must be a valid PNG or JPEG data URL");
    return { key, qrImageDataUrl };
  }

  async checkQrLogin(key: string, signal?: AbortSignal): Promise<NeteaseQrLoginCheck> {
    const cleanKey = key.trim();
    if (!cleanKey || cleanKey.length > 512) throw invalidInput("QR login key is invalid");
    const root = asRecord(await this.request("/login/qr/check", {
      key: cleanKey,
      timestamp: String(Date.now()),
    }, signal, [800, 801, 802, 803]), "QR login check response");
    const code = requireQrLoginCode(root.code);
    if (code === 803) {
      const cookie = normalizeCookie(requireString(root.cookie, "QR login cookie"), "QR login cookie");
      if (!isSecureCredentialTransport(this.baseUrl, cookie)) {
        throw invalidInput("QR login Cookie requires HTTPS unless the API is on loopback");
      }
      this.cookie = cookie;
      this.persistentLogin = persistCookie(this.cookieStorePath, cookie);
      this.authenticated = true;
      this.state = "ready";
      this.lastError = undefined;
    }
    return { code, state: qrLoginState(code) };
  }

  async logout(): Promise<NeteaseApiStatus> {
    this.cookie = "";
    this.authenticated = false;
    this.persistentLogin = false;
    this.lastError = undefined;
    this.state = this.configured ? "unchecked" : "blocked_by_configuration";
    if (this.cookieStorePath) {
      try {
        const entry = lstatSync(this.cookieStorePath);
        if (!entry.isSymbolicLink() && entry.isFile()) unlinkSync(this.cookieStorePath);
      } catch {
        // A missing local authorization file is already logged out.
      }
    }
    return this.getStatus();
  }

  private async request(
    path: string,
    query: Record<string, string>,
    signal?: AbortSignal,
    acceptedCodes: readonly number[] = [200],
  ): Promise<unknown> {
    this.assertAvailable();
    const endpoint = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) endpoint.searchParams.set(key, value);
    const headers = new Headers({ accept: "application/json" });
    if (this.cookie) headers.set("cookie", this.cookie);
    const response = await fetchWithTimeout(this.fetchImpl, endpoint.toString(), {
      method: "GET",
      headers,
      redirect: "error",
    }, { timeoutMs: this.timeoutMs, signal, provider: PROVIDER_NAME });
    if (!response.ok) throw httpError(PROVIDER_NAME, response.status, response.headers);
    let body;
    try {
      body = await readResponseBody(response, 2 * 1024 * 1024);
    } catch {
      throw invalidResponse("Netease API response is too large or unreadable");
    }
    if (body.json === undefined) throw invalidResponse("Netease API returned invalid JSON");
    const root = asRecord(body.json, "Netease API response");
    if (root.code !== undefined && (typeof root.code !== "number" || !acceptedCodes.includes(root.code))) {
      throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "business_error", "Netease API rejected the request", {
        retryable: false,
      }));
    }
    return root;
  }

  private assertAvailable(): void {
    if (!this.configured) {
      throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "missing_credentials", "NETEASE_API_BASE_URL is not configured", {
        retryable: false,
      }));
    }
    if (!this.secureTransport || !isSecureCredentialTransport(this.baseUrl, this.cookie)) {
      throw invalidInput("NETEASE_COOKIE requires HTTPS unless the API is on loopback");
    }
  }
}

export function createNeteaseApiProvider(env: NodeJS.ProcessEnv = process.env): NeteaseApiProvider {
  return new NeteaseApiProvider({ env });
}

export const createNeteaseProvider = createNeteaseApiProvider;

function parseSong(value: unknown): NeteaseSong {
  const song = asRecord(value, "song");
  const albumValue = song.al ?? song.album;
  const artistValue = song.ar ?? song.artists;
  const durationValue = song.dt ?? song.duration;
  const album = asRecord(albumValue, "song album");
  const publishedAt = song.publishTime ?? album.publishTime;
  const coverUrl = normalizeNeteaseCoverUrl(album.picUrl);
  const releaseYear = typeof publishedAt === "number" && Number.isFinite(publishedAt) && publishedAt > 0
    ? new Date(publishedAt).getUTCFullYear()
    : undefined;
  return {
    id: requireResponseId(song.id, "song.id"),
    title: requireString(song.name, "song.name"),
    artists: asArray(artistValue, "song artists").map((artistValue) => {
      const artist = asRecord(artistValue, "song artist");
      return { id: requireResponseId(artist.id, "artist.id"), name: requireString(artist.name, "artist.name") };
    }),
    album: {
      id: requireResponseId(album.id, "album.id"),
      name: requireString(album.name, "album.name"),
      ...(coverUrl ? { coverUrl } : {}),
    },
    durationMs: requireNonNegativeNumber(durationValue, "song duration"),
    ...(typeof song.pop === "number" && Number.isFinite(song.pop) ? { popularity: Math.max(0, Math.min(100, song.pop)) } : {}),
    ...(releaseYear && releaseYear >= 1900 && releaseYear <= 2200 ? { releaseYear } : {}),
  };
}

function parseSongCredits(value: Record<string, unknown>): NeteaseSongCredits {
  const lyricSources = [value.yrc, value.lrc]
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
    .map((entry) => entry.lyric)
    .filter((entry): entry is string => typeof entry === "string");
  const credits: NeteaseSongCredits = { lyricists: [], composers: [], arrangers: [] };
  for (const source of lyricSources) {
    for (const rawLine of source.split(/\r?\n/).slice(0, 40)) {
      const line = readCreditLine(rawLine);
      if (!line) continue;
      const match = line.match(/^(作词|词|lyricist|lyrics|作曲|曲|composer|编曲|arranger)\s*[:：]\s*(.+)$/i);
      if (!match) continue;
      const names = match[2].split(/[、/，,&；;]+/).map((name) => name.trim()).filter(Boolean).slice(0, 12);
      const role = match[1].toLowerCase();
      const target = role === "作词" || role === "词" || role === "lyricist" || role === "lyrics"
        ? credits.lyricists
        : role === "作曲" || role === "曲" || role === "composer"
          ? credits.composers
          : credits.arrangers;
      for (const name of names) if (!target.includes(name)) target.push(name);
    }
    if (credits.lyricists.length > 0 || credits.composers.length > 0 || credits.arrangers.length > 0) break;
  }
  return credits;
}

function readCreditLine(rawLine: string): string {
  const trimmed = rawLine.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
      const fragments = (parsed as Record<string, unknown>).c;
      if (!Array.isArray(fragments)) return "";
      return fragments.map((fragment) => fragment && typeof fragment === "object" && !Array.isArray(fragment)
        ? (fragment as Record<string, unknown>).tx
        : "").filter((text): text is string => typeof text === "string").join("").trim();
    } catch {
      return "";
    }
  }
  return trimmed.replace(/^(?:\[[^\]]+\])+\s*/, "");
}

function normalizeNeteaseCoverUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (hostname !== "music.126.net" && !hostname.endsWith(".music.126.net")) return undefined;
    url.protocol = "https:";
    url.port = "";
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function parsePlaylistSummary(value: unknown): NeteasePlaylistSummary {
  const playlist = asRecord(value, "playlist summary");
  const creator = isRecordValue(playlist.creator) ? playlist.creator : null;
  return {
    id: requireResponseId(playlist.id, "playlist summary.id"),
    name: requireString(playlist.name, "playlist summary.name"),
    description: optionalString(playlist.description, "playlist summary.description"),
    trackCount: requireNonNegativeNumber(playlist.trackCount, "playlist summary.trackCount"),
    ownerUid: requireResponseId(playlist.userId ?? creator?.userId ?? creator?.id, "playlist summary.ownerUid"),
    subscribed: optionalBoolean(playlist.subscribed, "playlist summary.subscribed"),
  };
}

function parseRecentSongRecord(value: unknown): NeteasePlayRecord {
  const record = asRecord(value, "recent song record");
  const song = parseSong(record.data ?? record.song);
  return {
    song,
    ...(record.playCount === undefined ? {} : { playCount: requireNonNegativeNumber(record.playCount, "recent song playCount") }),
    ...(record.playTime === undefined ? {} : { playedAt: requireNonNegativeNumber(record.playTime, "recent song playTime") }),
  };
}

function parseHistoryRecord(value: unknown): NeteasePlayRecord {
  const record = asRecord(value, "listening history record");
  return {
    song: parseSong(record.song),
    ...(record.playCount === undefined ? {} : { playCount: requireNonNegativeNumber(record.playCount, "listening history playCount") }),
    ...(record.score === undefined ? {} : { score: requireNonNegativeNumber(record.score, "listening history score") }),
  };
}

function readStoredCookie(path: string): string {
  if (!path) return "";
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || (typeof process.getuid === "function" && info.uid !== process.getuid())) return "";
    chmodSync(path, 0o600);
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function persistCookie(path: string, cookie: string): boolean {
  if (!path) return false;
  let temporary = "";
  try {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const directoryInfo = lstatSync(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || (typeof process.getuid === "function" && directoryInfo.uid !== process.getuid())) return false;
    chmodSync(directory, 0o700);
    temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, cookie, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    return true;
  } catch {
    if (temporary) {
      try { unlinkSync(temporary); } catch { /* no temporary file to remove */ }
    }
    return false;
  }
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidInput("NETEASE_API_BASE_URL must be a valid URL");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
    throw invalidInput("NETEASE_API_BASE_URL must be an HTTP(S) origin without credentials, query, or fragment");
  }
  return url.toString().replace(/\/$/, "");
}

function isSecureCredentialTransport(baseUrl: string, cookie: string): boolean {
  if (!cookie) return true;
  const url = new URL(baseUrl);
  return url.protocol === "https:" || url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function asArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw invalidResponse(`${field} must be an array`);
  return value;
}

function boundedArray(value: unknown, field: string, max: number): unknown[] {
  const values = asArray(value, field);
  if (values.length > max) throw invalidResponse(`${field} contains too many items`);
  return values;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw invalidResponse(`${field} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw invalidResponse(`${field} must be a string or null`);
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "boolean") throw invalidResponse(`${field} must be a boolean or null`);
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw invalidResponse(`${field} must be a boolean`);
  return value;
}

function requireInputId(value: unknown, field: string): string {
  const id = normalizeNumericId(value);
  if (id === null) throw invalidInput(`${field} is invalid`);
  return id;
}

function requirePlaylistName(value: unknown): string {
  if (typeof value !== "string") throw invalidInput("playlist name is invalid");
  const name = value.trim();
  if (!name) throw invalidInput("playlist name is invalid");
  return name;
}

function requireUniqueTrackIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw invalidInput("track ids must be an array");
  if (value.length < 1 || value.length > 500) throw invalidInput("track ids must contain between 1 and 500 items");
  const ids = value.map((id) => requireInputId(id, "track id"));
  if (new Set(ids).size !== ids.length) throw invalidInput("track ids must be unique");
  return ids;
}

function requireResponseId(value: unknown, field: string): string {
  const id = normalizeNumericId(value, true);
  if (id === null) throw invalidResponse(`${field} is invalid`);
  return id;
}

function normalizeNumericId(value: unknown, allowZero = false): string | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && (allowZero ? value >= 0 : value > 0) ? String(value) : null;
  if (typeof value !== "string") return null;
  const id = value.trim();
  return (allowZero ? /^(?:0|[1-9]\d*)$/ : /^[1-9]\d*$/).test(id) ? id : null;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalidResponse(`${field} must be a finite number`);
  return value;
}

function requireNonNegativeNumber(value: unknown, field: string): number {
  const number = requireNumber(value, field);
  if (number < 0) throw invalidResponse(`${field} must be non-negative`);
  return number;
}

function optionalNonNegativeNumber(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  return requireNonNegativeNumber(value, field);
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) throw invalidInput(`${field} is invalid`);
  return resolved;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function isSafePlaybackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return false;
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "::1" || hostname === "0.0.0.0") return false;
    if (/^127\./.test(hostname) || /^10\./.test(hostname) || /^192\.168\./.test(hostname) || /^169\.254\./.test(hostname)) return false;
    const private172 = /^172\.(\d{1,2})\./.exec(hostname);
    if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return false;
    const compactIpv6 = hostname.replaceAll(":", "");
    if (hostname.startsWith("::")) return false;
    if (/^(?:fc|fd|fe8|fe9|fea|feb)/i.test(compactIpv6)) return false;
    if (/^::ffff:/i.test(hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isQrImageDataUrl(value: string): boolean {
  if (value.length > 2_000_000) return false;
  const match = /^data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return false;
  const payload = match[1] ?? "";
  return payload.length > 0 && payload.length % 4 === 0;
}

function normalizeCookie(value: string, field: string): string {
  const raw = value.trim();
  if (!raw) return "";
  if (!raw.includes("=")) {
    if (raw.length > 32_768 || /[\u0000-\u001f\u007f]/.test(raw)) throw invalidInput(`${field} is invalid`);
    return raw;
  }
  const attributes = new Set(["max-age", "expires", "path", "domain", "secure", "httponly", "samesite"]);
  const pairs: string[] = [];
  const pairPattern = /(?:^|[;,]\s*)([A-Za-z0-9_]+)=([^;,]*?)(?=\s*(?:;|,|$))/g;
  for (const match of raw.matchAll(pairPattern)) {
    const name = match[1];
    const normalizedName = name.toLowerCase();
    const cookieValue = (match[2] ?? "").trim();
    if (!name || attributes.has(normalizedName) || !cookieValue) continue;
    pairs.push(`${name}=${cookieValue}`);
  }
  const cookie = pairs.join("; ");
  if (cookie.length > 32_768 || /[\u0000-\u001f\u007f]/.test(cookie)) throw invalidInput(`${field} is invalid`);
  if (!cookie) throw invalidInput(`${field} is invalid`);
  return cookie;
}

function requireQrLoginCode(value: unknown): NeteaseQrLoginCode {
  if (value === 800 || value === 801 || value === 802 || value === 803) return value;
  throw invalidResponse("QR login status code is invalid");
}

function qrLoginState(code: NeteaseQrLoginCode): NeteaseQrLoginState {
  if (code === 800) return "expired";
  if (code === 801) return "waiting_scan";
  if (code === 802) return "waiting_confirm";
  return "authorized";
}

function invalidInput(message: string): ProviderError {
  return new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_input", message, { retryable: false }));
}

function invalidResponse(message: string): ProviderError {
  return new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_response", message, { retryable: false }));
}

function businessError(message: string): ProviderError {
  return new ProviderError(providerErrorInfo(PROVIDER_NAME, "business_error", message, { retryable: false }));
}

function requireMutationSuccess(value: unknown, operation: string): Record<string, unknown> {
  const root = asRecord(value, `${operation} response`);
  const body = isRecordValue(root.body) ? root.body : null;
  const codes = [root.code, body?.code].filter((code): code is unknown => code !== undefined);
  if (codes.length === 0) throw invalidResponse(`${operation} response code is missing`);
  for (const code of codes) {
    if (typeof code !== "number" || !Number.isFinite(code)) throw invalidResponse(`${operation} response code is invalid`);
    if (code !== 200) throw businessError(`${operation} was rejected by Netease`);
  }
  return body ? { ...root, ...body } : root;
}

function asProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  return new ProviderError(providerErrorInfo(PROVIDER_NAME, "network_error", "Netease API request failed", { retryable: true }), { cause: error });
}
