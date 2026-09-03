import { fetchWithTimeout, httpError, providerErrorInfo, readResponseBody, safeUpstreamMessage } from "./http.js";
import { ProviderError } from "./types.js";
import { isIP } from "node:net";

const PROVIDER_NAME = "qqmusic-api";
const DEFAULT_BASE_URL = "http://127.0.0.1:4321";
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_PERSONALIZATION_ITEMS = 10_000;

export type QqMusicApiState = "blocked_by_configuration" | "unchecked" | "ready" | "blocked_by_auth" | "unavailable";
export type QqMusicLoginType = "wx" | "qq" | "mobile";
export type QqMusicQrLoginState = "expired" | "waiting_scan" | "waiting_confirm" | "authorized";

export interface QqMusicApiStatus {
  provider: typeof PROVIDER_NAME;
  configured: boolean;
  baseUrl: string;
  authenticated: boolean;
  timeoutMs: number;
  state: QqMusicApiState;
  persistentLogin: boolean;
  error?: ReturnType<ProviderError["toInfo"]>;
}

export interface QqMusicArtist { id: string; name: string }
export interface QqMusicAlbum { id: string; name: string; coverUrl?: string }
export interface QqMusicSong {
  id: string;
  title: string;
  artists: QqMusicArtist[];
  album: QqMusicAlbum;
  durationMs: number;
  mid?: string;
  songType?: number;
  mediaMid?: string;
  releaseYear?: number;
}
export interface QqMusicSearchResult { songs: QqMusicSong[]; total: number }
export interface QqMusicPlaylist {
  id: string;
  tid?: string;
  dirId?: string;
  name: string;
  description: string | null;
  trackCount: number;
  ownerUid?: string;
  tracks?: QqMusicSong[];
}
export interface QqMusicPlaylistCreateResult { id: string; name: string; dirId?: string }
export interface QqMusicPlaylistTracksResult { playlistId: string; trackIds: string[] }
export interface QqMusicPlaylistDeleteResult { playlistId: string; dirId: string; deleted: boolean; alreadyDeleted?: boolean }
export interface QqMusicSongLikeResult { trackId: string; liked: boolean }
export interface QqMusicAccount { uid: string; nickname: string | null }
export interface QqMusicPlayRecord {
  song: QqMusicSong;
  playCount?: number;
  score?: number;
  playedAt?: number;
}
export interface QqMusicQrLogin {
  key: string;
  loginType: QqMusicLoginType;
  qrImageDataUrl: string;
  expiresIn: number;
}
export interface QqMusicQrLoginCheck { code: 800 | 801 | 802 | 803; state: QqMusicQrLoginState; loginType: QqMusicLoginType }
export interface QqMusicSongUrl {
  id: string;
  url: string | null;
  durationMs: number | null;
  format?: string;
  complete?: boolean;
  authorizationCode?: number;
}
export interface QqMusicApiProviderOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  fetchImpl?: typeof globalThis.fetch;
}

export class QqMusicApiProvider {
  private readonly baseUrl: string;
  private readonly configured: boolean;
  private readonly capabilityToken: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private authenticated = false;
  private persistentLogin = false;
  private state: QqMusicApiState;
  private lastError?: ReturnType<ProviderError["toInfo"]>;

  constructor(options: QqMusicApiProviderOptions = {}) {
    const env = options.env ?? process.env;
    const configuredBaseUrl = env.QQMUSIC_API_BASE_URL?.trim() ?? "";
    this.capabilityToken = env.QQMUSIC_SIDECAR_TOKEN?.trim() ?? "";
    this.configured = configuredBaseUrl.length > 0 && this.capabilityToken.length >= 32;
    this.baseUrl = normalizeBaseUrl(configuredBaseUrl || DEFAULT_BASE_URL);
    this.timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.state = this.configured ? "unchecked" : "blocked_by_configuration";
  }

  getStatus(): QqMusicApiStatus {
    return {
      provider: PROVIDER_NAME,
      configured: this.configured,
      baseUrl: this.baseUrl,
      authenticated: this.authenticated,
      timeoutMs: this.timeoutMs,
      state: this.state,
      persistentLogin: this.persistentLogin,
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  async health(signal?: AbortSignal): Promise<QqMusicApiStatus> {
    try {
      const status = parseStatus(await this.request("/health", { method: "GET", signal }));
      this.authenticated = status.authenticated;
      this.persistentLogin = status.persistentLogin;
      this.state = status.state === "ready" && this.authenticated ? "ready" : status.state;
      this.lastError = undefined;
    } catch (error) {
      const failure = asProviderError(error);
      this.authenticated = false;
      this.lastError = failure.toInfo();
      if (this.configured) this.state = "unavailable";
    }
    return this.getStatus();
  }

  async createQrLogin(loginType: QqMusicLoginType = "mobile", signal?: AbortSignal): Promise<QqMusicQrLogin> {
    const selected = requireLoginType(loginType);
    const value = await this.request("/login/qr", {
      method: "POST",
      body: JSON.stringify({ loginType: selected }),
      signal,
      headers: { "content-type": "application/json" },
    });
    const root = asRecord(value, "QQ QR login response");
    const key = requireString(root.key, "QR login key");
    const qrImageDataUrl = requireQrImageDataUrl(root.qrImageDataUrl);
    const responseLoginType = requireLoginType(root.loginType);
    if (responseLoginType !== selected) throw invalidResponse("QR login type does not match request");
    const expiresIn = boundedNumber(root.expiresIn, 1, 600, "QR login expiration");
    return { key, loginType: responseLoginType, qrImageDataUrl, expiresIn };
  }

  async checkQrLogin(key: string, loginType?: QqMusicLoginType, signal?: AbortSignal): Promise<QqMusicQrLoginCheck> {
    const cleanKey = requireOpaqueKey(key);
    const selected = loginType === undefined ? undefined : requireLoginType(loginType);
    const query = selected ? `?loginType=${encodeURIComponent(selected)}` : "";
    const value = await this.request(`/login/qr/${encodeURIComponent(cleanKey)}${query}`, { method: "GET", signal });
    const root = asRecord(value, "QQ QR status response");
    const code = requireQrCode(root.code);
    const responseLoginType = requireLoginType(root.loginType);
    if (selected !== undefined && selected !== responseLoginType) throw invalidResponse("QR login type does not match session");
    const state = qrLoginState(code);
    if (code === 803) {
      this.authenticated = true;
      this.persistentLogin = true;
      this.state = "ready";
      this.lastError = undefined;
    }
    return { code, state, loginType: responseLoginType };
  }

  async logout(signal?: AbortSignal): Promise<QqMusicApiStatus> {
    await this.request("/logout", { method: "POST", body: "{}", signal, headers: { "content-type": "application/json" } });
    this.authenticated = false;
    this.persistentLogin = false;
    this.state = "blocked_by_auth";
    this.lastError = undefined;
    return this.getStatus();
  }

  async account(signal?: AbortSignal): Promise<QqMusicAccount> {
    return parseAccount(await this.request("/account", { method: "GET", signal }));
  }

  async preferences(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return asRecord(await this.request("/preferences", { method: "GET", signal }), "QQ preferences");
  }

  async search(keywords: string, options: { limit?: number; offset?: number; signal?: AbortSignal } = {}): Promise<QqMusicSearchResult> {
    const cleanKeywords = keywords.trim();
    if (!cleanKeywords) throw invalidInput("search keywords must not be empty");
    const limit = boundedInteger(options.limit, 20, 1, 100, "search limit");
    const offset = boundedInteger(options.offset, 0, 0, Number.MAX_SAFE_INTEGER, "search offset");
    const query = new URLSearchParams({ keyword: cleanKeywords, limit: String(limit), offset: String(offset) });
    return parseSearch(await this.request(`/search?${query}`, { method: "GET", signal: options.signal }));
  }

  async userPlaylists(_uid?: string | number, options: { limit?: number; offset?: number; signal?: AbortSignal } = {}): Promise<{ playlists: QqMusicPlaylist[]; more: boolean }> {
    const limit = boundedInteger(options.limit, 100, 1, 100, "playlist limit");
    const offset = boundedInteger(options.offset, 0, 0, Number.MAX_SAFE_INTEGER, "playlist offset");
    const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    const root = asRecord(await this.request(`/playlists?${query}`, { method: "GET", signal: options.signal }), "QQ playlists");
    const values = boundedArray(root.playlists, "QQ playlists", MAX_PERSONALIZATION_ITEMS).map(parsePlaylist);
    const more = root.more === undefined ? false : requireBoolean(root.more, "QQ playlists.more");
    return { playlists: values, more };
  }

  async likedSongIds(_uid?: string | number, signal?: AbortSignal): Promise<string[]> {
    const root = asRecord(await this.request("/liked", { method: "GET", signal }), "QQ liked songs");
    const songs = boundedArray(root.songs, "QQ liked songs", MAX_PERSONALIZATION_ITEMS);
    return songs.map((song) => parseSong(song).id);
  }

  async likedSongs(options: { limit?: number; signal?: AbortSignal } = {}): Promise<QqMusicSong[]> {
    const limit = boundedInteger(options.limit, 100, 1, 500, "liked songs limit");
    const query = new URLSearchParams({ limit: String(limit) });
    const root = asRecord(await this.request(`/liked?${query}`, { method: "GET", signal: options.signal }), "QQ liked songs");
    return boundedArray(root.songs, "QQ liked songs", MAX_PERSONALIZATION_ITEMS).map(parseSong);
  }

  /**
   * QQMusicApi currently exposes the durable "我喜欢" list but not a stable
   * public play-history endpoint.  The sidecar therefore returns an explicit
   * empty history when it cannot provide one; it must never relabel liked
   * tracks as recently played data.
   */
  async recentSongs(options: { limit?: number; signal?: AbortSignal } = {}): Promise<QqMusicPlayRecord[]> {
    const limit = boundedInteger(options.limit, 100, 1, 100, "recent songs limit");
    const query = new URLSearchParams({ limit: String(limit) });
    const root = asRecord(await this.request(`/recent?${query}`, { method: "GET", signal: options.signal }), "QQ recent songs");
    return parsePlayRecords(root.records, "QQ recent songs");
  }

  async listeningHistory(_uid: string | number, options: { period?: "all" | "week"; signal?: AbortSignal } = {}): Promise<QqMusicPlayRecord[]> {
    const period = options.period ?? "all";
    if (period !== "all" && period !== "week") throw invalidInput("listening history period is invalid");
    const root = asRecord(await this.request(`/history?period=${encodeURIComponent(period)}`, { method: "GET", signal: options.signal }), "QQ listening history");
    return parsePlayRecords(root.records, "QQ listening history");
  }

  async playlistDetail(id: string | number, signal?: AbortSignal): Promise<QqMusicPlaylist> {
    const cleanId = requireNumericId(id, "playlist id");
    return parsePlaylist(await this.request(`/playlist/${encodeURIComponent(cleanId)}`, { method: "GET", signal }));
  }

  async songDetail(ids: readonly (string | number)[], signal?: AbortSignal): Promise<QqMusicSong[]> {
    if (ids.length < 1 || ids.length > 100) throw invalidInput("song ids must contain between 1 and 100 items");
    const results = await Promise.allSettled(ids.map(async (id) => {
      const cleanId = requireSongId(id);
      const root = asRecord(await this.request(`/song/${encodeURIComponent(cleanId)}`, { method: "GET", signal }), "QQ song detail");
      const values = boundedArray(root.songs, "QQ song detail songs", 100).map(parseSong);
      return values[0];
    }));
    const songs = results.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
    if (songs.length === 0) {
      const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failure) throw failure.reason;
    }
    return songs;
  }

  async songUrl(id: string | number, options: { signal?: AbortSignal } = {}): Promise<QqMusicSongUrl> {
    const cleanId = requireSongId(id);
    const root = asRecord(await this.request(`/song/${encodeURIComponent(cleanId)}/url`, { method: "GET", signal: options.signal }), "QQ song URL");
    const url = root.url === null || root.url === undefined ? null : normalizeQqPlaybackUrl(requireSafePlaybackUrl(root.url));
    return {
      id: requireString(root.id, "song URL id"),
      url,
      durationMs: root.durationMs === null || root.durationMs === undefined ? null : boundedNumber(root.durationMs, 0, Number.MAX_SAFE_INTEGER, "song URL duration"),
      ...(root.format === undefined ? {} : { format: requireString(root.format, "song URL format") }),
      ...(root.complete === undefined ? {} : { complete: root.complete === true }),
      ...(root.authorizationCode === undefined ? {} : { authorizationCode: boundedNumber(root.authorizationCode, 0, Number.MAX_SAFE_INTEGER, "song URL authorization code") }),
    };
  }

  async similarSongs(id: string | number, options: { limit?: number; offset?: number; signal?: AbortSignal } = {}): Promise<QqMusicSong[]> {
    const cleanId = requireNumericId(id, "song id");
    const root = asRecord(await this.request(`/song/${encodeURIComponent(cleanId)}/similar`, { method: "GET", signal: options.signal }), "QQ similar songs");
    const limit = boundedInteger(options.limit, 50, 1, 100, "similar songs limit");
    return boundedArray(root.songs, "QQ similar songs", MAX_PERSONALIZATION_ITEMS).map(parseSong).slice(0, limit);
  }

  async dailyRecommendations(options: { signal?: AbortSignal } = {}): Promise<QqMusicSong[]> {
    const root = asRecord(await this.request("/recommendations", { method: "GET", signal: options.signal }), "QQ recommendations");
    return boundedArray(root.songs, "QQ recommendations songs", MAX_PERSONALIZATION_ITEMS).map(parseSong);
  }

  async personalFm(signal?: AbortSignal): Promise<QqMusicSong[]> {
    const root = asRecord(await this.request("/fm", { method: "GET", signal }), "QQ personal FM");
    return boundedArray(root.songs, "QQ personal FM songs", MAX_PERSONALIZATION_ITEMS).map(parseSong);
  }

  async createPlaylist(name: string, signal?: AbortSignal, identity?: { expectedUid: string }): Promise<QqMusicPlaylistCreateResult> {
    const cleanName = requirePlaylistName(name);
    const expectedUid = requireAccountUid(identity?.expectedUid);
    const root = asRecord(await this.request("/playlist", { method: "POST", body: JSON.stringify({ name: cleanName, expectedUid }), headers: { "content-type": "application/json" }, signal }), "QQ create playlist");
    const id = requireNumericId(root.id, "created playlist id");
    return { id, name: cleanName, ...(root.dirId === undefined ? {} : { dirId: requireNumericId(root.dirId, "created playlist dir id") }) };
  }

  async addSongsToPlaylist(
    playlistId: string | number,
    trackIds: readonly (string | number)[],
    signal?: AbortSignal,
    identity?: { dirId: string | number; expectedUid: string },
  ): Promise<QqMusicPlaylistTracksResult> {
    const cleanPlaylistId = requireNumericId(playlistId, "playlist id");
    const cleanDirId = requireNumericId(identity?.dirId, "playlist dir id");
    const expectedUid = requireAccountUid(identity?.expectedUid);
    if (trackIds.length < 1 || trackIds.length > 500) throw invalidInput("track ids must contain between 1 and 500 items");
    const cleanTrackIds = trackIds.map(requireSongId);
    if (new Set(cleanTrackIds).size !== cleanTrackIds.length) throw invalidInput("track ids must be unique");
    const value = await this.request(`/playlist/${encodeURIComponent(cleanPlaylistId)}/tracks`, {
      method: "POST",
      // QQ inserts each batch at the head of the playlist. Submit the locked
      // order backwards so the persisted playlist reads back in program order.
      body: JSON.stringify({ trackIds: [...cleanTrackIds].reverse(), dirId: cleanDirId, expectedUid }),
      headers: { "content-type": "application/json" },
      signal,
    });
    const root = asRecord(value, "QQ add songs response");
    const responseIds = boundedArray(root.trackIds, "QQ added track ids", 500).map((id) => requireSongId(id));
    return { playlistId: requireNumericId(root.playlistId ?? cleanPlaylistId, "playlist id"), trackIds: responseIds };
  }

  async replacePlaylistTracks(
    playlistId: string | number,
    trackIds: readonly (string | number)[],
    signal?: AbortSignal,
    identity?: { dirId: string | number; expectedUid: string },
  ): Promise<QqMusicPlaylistTracksResult> {
    const cleanPlaylistId = requireNumericId(playlistId, "playlist id");
    const cleanDirId = requireNumericId(identity?.dirId, "playlist dir id");
    const expectedUid = requireAccountUid(identity?.expectedUid);
    if (trackIds.length < 1 || trackIds.length > 500) throw invalidInput("track ids must contain between 1 and 500 items");
    const cleanTrackIds = trackIds.map(requireSongId);
    if (new Set(cleanTrackIds).size !== cleanTrackIds.length) throw invalidInput("track ids must be unique");
    const value = await this.request(`/playlist/${encodeURIComponent(cleanPlaylistId)}/tracks/replace`, {
      method: "POST",
      body: JSON.stringify({ trackIds: [...cleanTrackIds].reverse(), dirId: cleanDirId, expectedUid }),
      headers: { "content-type": "application/json" },
      signal,
    });
    const root = asRecord(value, "QQ replace songs response");
    const responseIds = boundedArray(root.trackIds, "QQ replaced track ids", 500).map((id) => requireSongId(id));
    return { playlistId: requireNumericId(root.playlistId ?? cleanPlaylistId, "playlist id"), trackIds: responseIds };
  }

  async deletePlaylist(
    playlistId: string | number,
    signal?: AbortSignal,
    identity?: { dirId: string | number; expectedUid: string },
  ): Promise<QqMusicPlaylistDeleteResult> {
    const cleanPlaylistId = requireNumericId(playlistId, "playlist id");
    const cleanDirId = requireNumericId(identity?.dirId, "playlist dir id");
    const expectedUid = requireAccountUid(identity?.expectedUid);
    const root = asRecord(await this.request(`/playlist/${encodeURIComponent(cleanPlaylistId)}`, {
      method: "DELETE",
      body: JSON.stringify({ dirId: cleanDirId, expectedUid }),
      headers: { "content-type": "application/json" },
      signal,
    }), "QQ delete playlist response");
    return {
      playlistId: requireNumericId(root.playlistId ?? cleanPlaylistId, "playlist id"),
      dirId: requireNumericId(root.dirId ?? cleanDirId, "playlist dir id"),
      deleted: root.deleted === true,
      ...(root.alreadyDeleted === true ? { alreadyDeleted: true } : {}),
    };
  }

  async setSongLiked(
    id: string | number,
    liked: boolean,
    songType: number | undefined,
    signal?: AbortSignal,
    identity?: { expectedUid: string },
  ): Promise<QqMusicSongLikeResult> {
    const cleanId = requireNumericId(id, "song id");
    if (typeof liked !== "boolean") throw invalidInput("liked must be a boolean");
    const cleanSongType = boundedInteger(songType, 0, 0, Number.MAX_SAFE_INTEGER, "song type");
    const expectedUid = requireAccountUid(identity?.expectedUid);
    const root = asRecord(await this.request(`/song/${encodeURIComponent(cleanId)}/like`, {
      method: "POST",
      body: JSON.stringify({ liked, songType: cleanSongType, expectedUid }),
      headers: { "content-type": "application/json" },
      signal,
    }), "QQ like song response");
    return {
      trackId: requireNumericId(root.trackId ?? cleanId, "liked song id"),
      liked: requireBoolean(root.liked, "liked song state"),
    };
  }

  private async request(path: string, options: { method: "GET" | "POST" | "DELETE"; body?: string; headers?: Record<string, string>; signal?: AbortSignal }): Promise<unknown> {
    this.assertAvailable();
    const endpoint = new URL(`${this.baseUrl}${path}`);
    const response = await fetchWithTimeout(this.fetchImpl, endpoint.toString(), {
      method: options.method,
      headers: {
        accept: "application/json",
        "x-one-radio-qq-token": this.capabilityToken,
        ...(options.headers ?? {}),
      },
      ...(options.body === undefined ? {} : { body: options.body }),
      redirect: "error",
    }, { timeoutMs: this.timeoutMs, signal: options.signal, provider: PROVIDER_NAME });
    if (!response.ok) throw httpError(PROVIDER_NAME, response.status, response.headers);
    let body;
    try {
      body = await readResponseBody(response, 2 * 1024 * 1024);
    } catch {
      throw invalidResponse("QQ Music sidecar response is too large or unreadable");
    }
    if (body.json === undefined) throw invalidResponse("QQ Music sidecar returned invalid JSON");
    const root = asRecord(body.json, "QQ Music sidecar response");
    if (root.error !== undefined) throw businessError(safeUpstreamMessage(root.error, "QQ Music request failed"));
    return root;
  }

  private assertAvailable(): void {
    if (!this.configured) throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "missing_credentials", "QQMUSIC_API_BASE_URL and QQMUSIC_SIDECAR_TOKEN are not configured", { retryable: false }));
  }
}

export function createQqMusicApiProvider(env: NodeJS.ProcessEnv = process.env): QqMusicApiProvider {
  return new QqMusicApiProvider({ env });
}
export const createQqMusicProvider = createQqMusicApiProvider;
export const createQqProvider = createQqMusicApiProvider;

function parseStatus(value: unknown): QqMusicApiStatus {
  const root = asRecord(value, "QQ status");
  const state = typeof root.state === "string" && ["blocked_by_configuration", "unchecked", "ready", "blocked_by_auth", "unavailable"].includes(root.state)
    ? root.state as QqMusicApiState
    : "unavailable";
  return {
    provider: PROVIDER_NAME,
    configured: root.configured === true,
    baseUrl: "",
    authenticated: root.authenticated === true,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    state,
    persistentLogin: root.persistentLogin === true,
  };
}

function parseAccount(value: unknown): QqMusicAccount {
  const root = asRecord(value, "QQ account");
  return { uid: requireString(root.uid, "account uid"), nickname: root.nickname === null || root.nickname === undefined ? null : requireString(root.nickname, "account nickname") };
}
function parseSearch(value: unknown): QqMusicSearchResult {
  const root = asRecord(value, "QQ search");
  return { songs: boundedArray(root.songs, "QQ search songs", MAX_PERSONALIZATION_ITEMS).map(parseSong), total: boundedNumber(root.total, 0, Number.MAX_SAFE_INTEGER, "QQ search total") };
}
function parsePlayRecords(value: unknown, field: string): QqMusicPlayRecord[] {
  return boundedArray(value, `${field} records`, MAX_PERSONALIZATION_ITEMS).map((item) => {
    const root = asRecord(item, `${field} record`);
    const song = parseSong(root.song ?? root);
    const record: QqMusicPlayRecord = { song };
    if (root.playCount !== undefined) record.playCount = boundedNumber(root.playCount, 0, Number.MAX_SAFE_INTEGER, `${field} play count`);
    if (root.score !== undefined) record.score = boundedNumber(root.score, 0, Number.MAX_SAFE_INTEGER, `${field} score`);
    if (root.playedAt !== undefined) record.playedAt = boundedNumber(root.playedAt, 0, Number.MAX_SAFE_INTEGER, `${field} played at`);
    return record;
  });
}
function parseSong(value: unknown): QqMusicSong {
  const root = asRecord(value, "QQ song");
  const artists = boundedArray(root.artists, "QQ song artists", 50).map((item) => {
    const artist = asRecord(item, "QQ artist");
    return { id: requireString(artist.id, "artist id"), name: requireString(artist.name, "artist name") };
  });
  const album = asRecord(root.album, "QQ album");
  const coverUrl = normalizeQqCoverUrl(album.coverUrl);
  const result: QqMusicSong = {
    id: requireSongId(root.id),
    title: requireString(root.title, "song title"),
    artists,
    album: {
      id: requireString(album.id, "album id"),
      name: requireString(album.name, "album name"),
      ...(coverUrl ? { coverUrl } : {}),
    },
    durationMs: boundedNumber(root.durationMs, 0, Number.MAX_SAFE_INTEGER, "song duration"),
    ...(root.mid === undefined ? {} : { mid: requireString(root.mid, "song mid") }),
    ...(root.songType === undefined ? {} : { songType: boundedNumber(root.songType, 0, Number.MAX_SAFE_INTEGER, "song type") }),
    ...(root.mediaMid === undefined ? {} : { mediaMid: requireString(root.mediaMid, "media mid") }),
    ...(root.releaseYear === undefined ? {} : { releaseYear: boundedNumber(root.releaseYear, 1900, 2200, "release year") }),
  };
  return result;
}

function normalizeQqCoverUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== "y.gtimg.cn") return undefined;
    if (!/^\/music\/photo_new\/T002R\d+x\d+M000[A-Za-z0-9]+\.jpg$/.test(url.pathname)) return undefined;
    url.protocol = "https:";
    url.port = "";
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return undefined;
  }
}
function parsePlaylist(value: unknown): QqMusicPlaylist {
  const root = asRecord(value, "QQ playlist");
  return {
    id: requireNumericId(root.id, "playlist id"),
    ...(root.tid === undefined ? {} : { tid: requireNumericId(root.tid, "playlist tid") }),
    ...(root.dirId === undefined ? {} : { dirId: requireNumericId(root.dirId, "playlist dir id") }),
    name: requireString(root.name, "playlist name"),
    description: root.description === null || root.description === undefined ? null : requireString(root.description, "playlist description"),
    trackCount: boundedNumber(root.trackCount, 0, Number.MAX_SAFE_INTEGER, "playlist track count"),
    ...(root.ownerUid === undefined ? {} : { ownerUid: requireString(root.ownerUid, "playlist owner") }),
    ...(root.tracks === undefined ? {} : { tracks: boundedArray(root.tracks, "playlist tracks", MAX_PERSONALIZATION_ITEMS).map(parseSong) }),
  };
}
function asRecord(value: unknown, field: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse(`${field} must be an object`); return value as Record<string, unknown> }
function boundedArray(value: unknown, field: string, max: number): unknown[] { if (!Array.isArray(value) || value.length > max) throw invalidResponse(`${field} is invalid`); return value }
function requireString(value: unknown, field: string): string { if (typeof value !== "string" || !value.trim() || value.length > 2_000) throw invalidResponse(`${field} is invalid`); return value.trim() }
function requireBoolean(value: unknown, field: string): boolean { if (typeof value !== "boolean") throw invalidResponse(`${field} is invalid`); return value }
function boundedNumber(value: unknown, min: number, max: number, field: string): number { if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw invalidResponse(`${field} is invalid`); return value }
function boundedInteger(value: number | undefined, fallback: number, min: number, max: number, field: string): number { const result = value ?? fallback; if (!Number.isSafeInteger(result) || result < min || result > max) throw invalidInput(`${field} is invalid`); return result }
function positiveInteger(value: number | undefined, fallback: number): number { return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback }
function requireNumericId(value: unknown, field: string): string { if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value); if (typeof value === "string" && /^[1-9]\d*$/.test(value.trim())) return value.trim(); throw invalidInput(`${field} is invalid`) }
function requireAccountUid(value: unknown): string { if (typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value.trim())) return value.trim(); throw invalidInput("expected account uid is invalid") }
function requireSongId(value: unknown): string { if (typeof value === "string" && /^[A-Za-z0-9_-]{2,128}$/.test(value.trim())) return value.trim(); if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value); throw invalidInput("song id is invalid") }
function requireOpaqueKey(value: unknown): string { if (typeof value !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) throw invalidInput("QR login key is invalid"); return value }
function requireLoginType(value: unknown): QqMusicLoginType {
  if (value === "wx" || value === "qq" || value === "mobile") return value;
  throw invalidInput("loginType must be wx, qq, or mobile");
}
function requireQrCode(value: unknown): 800 | 801 | 802 | 803 { if (value === 800 || value === 801 || value === 802 || value === 803) return value; throw invalidResponse("QR login code is invalid") }
function qrLoginState(code: 800 | 801 | 802 | 803): QqMusicQrLoginState { return code === 800 ? "expired" : code === 801 ? "waiting_scan" : code === 802 ? "waiting_confirm" : "authorized" }
function requireQrImageDataUrl(value: unknown): string { if (typeof value !== "string" || value.length > 2_000_000 || !/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) throw invalidResponse("QR image is invalid"); return value }
function requireSafePlaybackUrl(value: unknown): string {
  if (typeof value !== "string") throw invalidResponse("playback URL is invalid");
  let url: URL;
  try { url = new URL(value) } catch { throw invalidResponse("playback URL is invalid") }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) throw invalidResponse("playback URL is invalid");
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isPrivateHostname(hostname)) throw invalidResponse("playback URL is private");
  return url.toString();
}
function normalizeQqPlaybackUrl(value: string): string {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const officialHostname = hostname === "qq.com"
    || hostname.endsWith(".qq.com")
    || hostname === "gtimg.cn"
    || hostname.endsWith(".gtimg.cn")
    || hostname.endsWith(".music.qq.com")
    || hostname.endsWith(".qqmusic.qq.com");
  if (isIP(hostname) === 0) {
    if (officialHostname) {
      url.protocol = "https:";
      url.port = "";
    }
    return url.toString();
  }
  const filename = url.pathname.split("/").at(-1) ?? "";
  if (!/^[A-Z][A-Z0-9]{2,5}[A-Za-z0-9_-]{8,128}\.(?:mp3|m4a|flac|ogg)$/i.test(filename)) {
    throw invalidResponse("QQ playback IP URL has an invalid media path");
  }
  // QQ's vkey service may randomly return a literal edge IP or an official
  // stream hostname for the same signed path. Pin literal-IP results to QQ's
  // canonical CDN host so the main service can keep a strict host allowlist.
  url.protocol = "https:";
  url.hostname = "isure.stream.qqmusic.qq.com";
  url.port = "";
  return url.toString();
}
function isPrivateHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "0.0.0.0" || hostname === "::1" || hostname === "0:0:0:0:0:0:0:1") return true;
  if (/^127\./.test(hostname) || /^10\./.test(hostname) || /^192\.168\./.test(hostname) || /^169\.254\./.test(hostname) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)) return true;
  if (hostname.includes(":")) {
    const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (normalized === "::" || normalized === "0:0:0:0:0:0:0:0" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
    const mapped = normalized.match(/^(?:::|0:0:0:0:0:)?ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1] && isPrivateHostname(mapped[1])) return true;
  }
  return false;
}
function requirePlaylistName(value: unknown): string { if (typeof value !== "string" || !value.trim() || value.trim().length > 100) throw invalidInput("playlist name is invalid"); return value.trim() }
function normalizeBaseUrl(value: string): string { let url: URL; try { url = new URL(value) } catch { throw invalidInput("QQMUSIC_API_BASE_URL must be a valid URL") } if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) throw invalidInput("QQMUSIC_API_BASE_URL must be an HTTP(S) origin without credentials, query, or fragment"); const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, ""); if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1") throw invalidInput("QQMUSIC_API_BASE_URL must point to the local sidecar"); return url.toString().replace(/\/$/, "") }
function invalidInput(message: string): ProviderError { return new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_input", message, { retryable: false })) }
function invalidResponse(message: string): ProviderError { return new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_response", message, { retryable: false })) }
function businessError(message: string): ProviderError { return new ProviderError(providerErrorInfo(PROVIDER_NAME, "business_error", message, { retryable: false })) }
function asProviderError(error: unknown): ProviderError { return error instanceof ProviderError ? error : new ProviderError(providerErrorInfo(PROVIDER_NAME, "network_error", "QQ Music sidecar request failed", { retryable: true }), { cause: error }) }
