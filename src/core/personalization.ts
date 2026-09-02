/**
 * Deterministic, local-only ranking for candidates collected from NetEase
 * preference and recommendation endpoints.  This module deliberately does
 * not infer genre or energy when a candidate does not provide those fields.
 */

import { isDisallowedRecommendationCandidate } from "./recommendation-guards.js";

export const PERSONALIZATION_SOURCES = [
  "liked",
  "playlist",
  "history",
  "recent",
  "daily",
  "fm",
  "search",
] as const;

export type PersonalizationSource = (typeof PERSONALIZATION_SOURCES)[number];
export type CandidateId = string | number;

export interface PersonalizationArtist {
  id?: CandidateId;
  name?: string;
}

/**
 * The shape intentionally accepts both the app Track shape and NeteaseSong
 * (which uses `artists` and `durationMs`).  Extra provider fields are kept on
 * the returned clone but are never read for scoring.
 */
export interface PersonalizationCandidate {
  id: CandidateId;
  title?: string;
  artist?: string;
  artists?: readonly (string | PersonalizationArtist)[];
  durationSeconds?: number;
  durationMs?: number;
  energy?: number | null;
  genre?: string | null;
  album?: string | { name?: string | null; coverUrl?: string | null } | null;
  releaseYear?: number | null;
  mood?: readonly string[];
  styleTags?: readonly string[];
  source?: PersonalizationSource | string | readonly (PersonalizationSource | string)[];
  query?: string;
  searchQuery?: string;
  publicPlaylistId?: CandidateId;
  playlistSampleScore?: number;
  popularity?: number | null;
  [key: string]: unknown;
}

export interface PersonalizationScene {
  /** A scene name alone is context; it is not treated as a genre claim. */
  preset?: string;
  query?: string;
  genre?: string | null;
  styleTags?: readonly string[];
  targetEnergy?: number | null;
  energy?: number | null;
}

export type FeedbackAction = "skip" | "skipped" | "completed" | "liked";

export interface SessionFeedbackEvent {
  action?: FeedbackAction;
  type?: FeedbackAction;
  id?: CandidateId;
  trackId?: CandidateId;
  candidateId?: CandidateId;
}

export interface SessionFeedback {
  /** Repeated IDs are intentionally counted, so consecutive skips are stronger. */
  skipped?: readonly CandidateId[];
  skip?: readonly CandidateId[];
  completed?: readonly CandidateId[];
  liked?: readonly CandidateId[];
  events?: readonly SessionFeedbackEvent[];
  actions?: readonly SessionFeedbackEvent[];
  recentTrackIds?: readonly CandidateId[];
  recentArtistNames?: readonly string[];
  currentTrackId?: CandidateId | null;
  currentArtist?: string | null;
}

export interface PersonalizationPools {
  candidates?: readonly PersonalizationCandidate[];
  liked?: readonly PersonalizationCandidate[];
  playlist?: readonly PersonalizationCandidate[];
  playlists?: readonly PersonalizationCandidate[];
  history?: readonly PersonalizationCandidate[];
  recent?: readonly PersonalizationCandidate[];
  daily?: readonly PersonalizationCandidate[];
  dailyRecommendations?: readonly PersonalizationCandidate[];
  fm?: readonly PersonalizationCandidate[];
  personalFm?: readonly PersonalizationCandidate[];
  search?: readonly PersonalizationCandidate[];
  sources?: Partial<Record<PersonalizationSource, readonly PersonalizationCandidate[]>>;
}

export interface PersonalizationOptions extends PersonalizationPools {
  scene?: PersonalizationScene | string | null;
  sceneQuery?: string | null;
  query?: string | null;
  targetEnergy?: number | null;
  preferredArtists?: readonly string[] | Readonly<Record<string, number>>;
  preferredArtistNames?: readonly string[];
  recentTrackIds?: Iterable<CandidateId>;
  recentArtistNames?: Iterable<string>;
  feedback?: SessionFeedback | null;
  session?: SessionFeedback | null;
}

export type PersonalizationInput = PersonalizationOptions;

export interface RankedPersonalizationCandidate<T extends PersonalizationCandidate = PersonalizationCandidate> {
  candidate: T;
  /** Alias for callers that use the existing queue terminology. */
  track: T;
  score: number;
  reasons: string[];
  sources: PersonalizationSource[];
}

export interface PersonalizationResult<T extends PersonalizationCandidate = PersonalizationCandidate> {
  ranked: RankedPersonalizationCandidate<T>[];
  next: T | null;
  /** Alias for queue consumers that call the selected item `selected`. */
  selected: T | null;
  nextReasons: string[];
  reason: string;
  /** False means there was no account-derived preference data to use. */
  hasAccountData: boolean;
  /** True when ranking fell back to deterministic non-personal signals. */
  usedFallback: boolean;
}

interface InternalCandidate {
  id: string;
  candidate: PersonalizationCandidate;
  title: string;
  artist: string;
  genre?: string;
  energy?: number;
  sources: Set<PersonalizationSource>;
  sourceSignature: string;
}

interface FeedbackState {
  skipped: Map<string, number>;
  completed: Map<string, number>;
  liked: Map<string, number>;
  recentTrackIds: Set<string>;
  recentArtists: Set<string>;
  currentTrackId: string | null;
  currentArtist: string;
}

interface ScoreEntry {
  candidate: InternalCandidate;
  score: number;
  reasons: string[];
}

const SOURCE_ALIASES: Record<string, PersonalizationSource | undefined> = {
  liked: "liked",
  like: "liked",
  playlist: "playlist",
  playlists: "playlist",
  history: "history",
  record: "history",
  recent: "recent",
  daily: "daily",
  recommend: "daily",
  recommendation: "daily",
  recommendations: "daily",
  fm: "fm",
  personal_fm: "fm",
  personalfm: "fm",
  search: "search",
};

const SOURCE_WEIGHTS: Record<PersonalizationSource, number> = {
  liked: 0,
  playlist: 7,
  history: 4,
  recent: 0,
  daily: 11,
  fm: 8,
  search: 0,
};

const SKIP_PENALTY = 200;
const LIKED_FEEDBACK_REWARD = 56;
const COMPLETED_FEEDBACK_REWARD = 4;
const COMPLETED_TRACK_PENALTY = 30;
const RECENT_TRACK_PENALTY = 34;
const REPEAT_ARTIST_PENALTY = 15;
const SCENE_SEARCH_REWARD = 18;
const SCENE_GENRE_REWARD = 9;
const SCENE_STYLE_REWARD = 26;
const SCENE_QUERY_STYLE_REWARD = 18;
const MAX_AFFINITY_REWARD = 30;

/**
 * Rank candidates from a direct list and/or source pools.  The function is
 * pure: no input arrays or candidate objects are mutated, and each result is
 * cloned before being returned.
 */
export function personalizeCandidates<T extends PersonalizationCandidate>(
  input: readonly T[] | PersonalizationInput,
  options: PersonalizationOptions = {},
): PersonalizationResult<T> {
  const mergedOptions = Array.isArray(input)
    ? { ...options, candidates: [...(options.candidates ?? []), ...input] }
    : { ...input, ...options };
  const entries = collectCandidates(mergedOptions);
  const feedback = readFeedback(mergedOptions.feedback ?? mergedOptions.session);
  const recentTrackIds = new Set(feedback.recentTrackIds);
  for (const id of iterableToArray(mergedOptions.recentTrackIds)) {
    const normalized = normalizeId(id);
    if (normalized) recentTrackIds.add(normalized);
  }
  const recentArtists = new Set(feedback.recentArtists);
  for (const artist of iterableToArray(mergedOptions.recentArtistNames)) {
    const normalized = normalizeText(artist);
    if (normalized) recentArtists.add(normalized);
  }

  const preference = buildArtistPreference(entries, mergedOptions, feedback);
  const scene = readScene(mergedOptions);
  const scored: ScoreEntry[] = entries.map((entry) => scoreCandidate(
    entry,
    preference,
    feedback,
    recentTrackIds,
    recentArtists,
    scene,
  ));

  scored.sort(compareScoreEntries);
  const ranked = scored.map((entry) => {
    const candidate = cloneCandidate(entry.candidate.candidate) as T;
    return {
      candidate,
      track: cloneCandidate(entry.candidate.candidate) as T,
      score: entry.score,
      reasons: [...entry.reasons],
      sources: [...entry.candidate.sources].sort(compareText),
    };
  });
  const next = ranked[0]?.candidate ?? null;
  const nextReasons = ranked[0] ? [...ranked[0].reasons] : [];
  const hasAccountData = hasPreferenceData(mergedOptions, entries);
  return {
    ranked,
    next: next ? cloneCandidate(next) as T : null,
    selected: next ? cloneCandidate(next) as T : null,
    nextReasons,
    reason: nextReasons.join("; ") || (next ? "deterministic baseline" : "no candidates"),
    hasAccountData,
    usedFallback: !hasAccountData,
  };
}

/** Stable aliases for callers that use either queue or candidate terminology. */
export const rankPersonalizedCandidates = personalizeCandidates;
export const rankPersonalizedTracks = personalizeCandidates;

export function selectNextPersonalizedTrack<T extends PersonalizationCandidate>(
  input: readonly T[] | PersonalizationInput,
  options: PersonalizationOptions = {},
): T | null {
  return personalizeCandidates(input, options).next;
}

function collectCandidates(options: PersonalizationOptions): InternalCandidate[] {
  const byId = new Map<string, InternalCandidate>();
  const addPool = (
    source: PersonalizationSource | undefined,
    candidates: readonly PersonalizationCandidate[] | undefined,
  ): void => {
    if (!candidates) return;
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object") continue;
      if (isDisallowedRecommendationCandidate(candidate)) continue;
      const id = normalizeId(candidate.id);
      if (!id) continue;
      const sources = new Set<PersonalizationSource>();
      if (source) sources.add(source);
      for (const candidateSource of candidateSources(candidate.source)) sources.add(candidateSource);
      const existing = byId.get(id);
      if (existing) {
        for (const item of sources) existing.sources.add(item);
        // Prefer the more informative representation without changing input.
        if (candidateInformationScore(candidate) > candidateInformationScore(existing.candidate)) {
          existing.candidate = cloneCandidate(candidate);
          existing.title = candidateTitle(existing.candidate);
          existing.artist = candidateArtist(existing.candidate);
          existing.genre = candidateGenre(existing.candidate);
          existing.energy = candidateEnergy(existing.candidate);
        }
        existing.sourceSignature = sourceSignature(existing.sources);
        continue;
      }
      const clone = cloneCandidate(candidate);
      byId.set(id, {
        id,
        candidate: clone,
        title: candidateTitle(clone),
        artist: candidateArtist(clone),
        genre: candidateGenre(clone),
        energy: candidateEnergy(clone),
        sources,
        sourceSignature: sourceSignature(sources),
      });
    }
  };

  addPool(undefined, options.candidates);
  addPool("liked", options.liked);
  addPool("playlist", options.playlist);
  addPool("playlist", options.playlists);
  addPool("history", options.history);
  addPool("recent", options.recent);
  addPool("daily", options.daily);
  addPool("daily", options.dailyRecommendations);
  addPool("fm", options.fm);
  addPool("fm", options.personalFm);
  addPool("search", options.search);
  if (options.sources) {
    for (const source of PERSONALIZATION_SOURCES) addPool(source, options.sources[source]);
  }
  return [...byId.values()];
}

function scoreCandidate(
  entry: InternalCandidate,
  preference: ReadonlyMap<string, number>,
  feedback: FeedbackState,
  recentTrackIds: ReadonlySet<string>,
  recentArtists: ReadonlySet<string>,
  scene: SceneState,
): ScoreEntry {
  let score = 0;
  const reasons: string[] = [];
  const add = (value: number, reason: string): void => {
    if (!Number.isFinite(value) || value === 0) return;
    score += value;
    reasons.push(`${reason} ${formatSigned(value)}`);
  };

  const sourceScore = [...entry.sources].reduce((total, source) => total + SOURCE_WEIGHTS[source], 0);
  add(sourceScore, sourceScore >= 0 ? "source preference" : "recent source penalty");

  const likedSource = entry.sources.has("liked");
  if (likedSource) add(34, "liked track reward");

  const likedCount = feedback.liked.get(entry.id) ?? 0;
  add(Math.min(120, likedCount * LIKED_FEEDBACK_REWARD), "explicit liked feedback");

  const completedCount = feedback.completed.get(entry.id) ?? 0;
  add(Math.min(24, completedCount * COMPLETED_FEEDBACK_REWARD), "completed feedback");
  add(-Math.min(180, completedCount * COMPLETED_TRACK_PENALTY), "completed track repeat penalty");

  const skippedCount = feedback.skipped.get(entry.id) ?? 0;
  add(-Math.min(720, skippedCount * SKIP_PENALTY), skippedCount > 1 ? `repeated skip penalty x${skippedCount}` : "skip penalty");

  const affinity = Math.max(0, ...candidateArtistNames(entry.candidate).map((artist) => preference.get(normalizeText(artist)) ?? 0));
  add(Math.min(MAX_AFFINITY_REWARD, affinity), "preferred artist reward");

  if (recentTrackIds.has(entry.id) || entry.sources.has("recent")) {
    add(-RECENT_TRACK_PENALTY, "recent track penalty");
  }
  const artistKeys = candidateArtistNames(entry.candidate).map(normalizeText).filter(Boolean);
  if (artistKeys.some((artist) => recentArtists.has(artist))) add(-REPEAT_ARTIST_PENALTY, "repeat artist penalty");

  if (scene.hasContext && entry.sources.has("search")) add(SCENE_SEARCH_REWARD, "scene search reward");
  if (entry.candidate.publicPlaylistId !== undefined) add(16, "public playlist reward");
  const popularity = candidatePopularity(entry.candidate);
  if (popularity !== undefined) add(Math.min(18, popularity * 18), "popularity reward");

  const styleMatches = candidateStyleTags(entry.candidate).filter((tag) => scene.styleTags.has(tag));
  if (styleMatches.length > 0) {
    add(Math.min(52, styleMatches.length * SCENE_STYLE_REWARD), "scene style match");
  }
  const queryMatches = searchQueryTags(entry.candidate).filter((tag) => scene.styleTags.has(tag));
  if (entry.sources.has("search") && queryMatches.length > 0) {
    add(Math.min(36, queryMatches.length * SCENE_QUERY_STYLE_REWARD), "scene query style match");
  }

  if (scene.genre && entry.genre && scene.genre === normalizeText(entry.genre)) {
    add(SCENE_GENRE_REWARD, "scene genre match");
  }
  if (scene.targetEnergy !== undefined && entry.energy !== undefined) {
    const distance = Math.abs(entry.energy - scene.targetEnergy);
    const reward = Math.max(0, 12 * (1 - distance));
    add(reward, "scene energy match");
  }

  if (reasons.length === 0) reasons.push("deterministic baseline");
  return { candidate: entry, score, reasons };
}

interface SceneState {
  hasContext: boolean;
  genre?: string;
  styleTags: Set<string>;
  targetEnergy?: number;
}

function readScene(options: PersonalizationOptions): SceneState {
  const rawScene = options.scene;
  const scene: PersonalizationScene = typeof rawScene === "string"
    ? { preset: rawScene }
    : rawScene && typeof rawScene === "object"
      ? rawScene
      : {};
  const query = normalizeText(options.sceneQuery ?? options.query ?? scene.query);
  const genre = normalizeText(scene.genre);
  const styleTags = new Set((scene.styleTags ?? []).map(normalizeText).filter(Boolean));
  if (genre) styleTags.add(genre);
  const targetEnergy = finiteEnergy(options.targetEnergy ?? scene.targetEnergy ?? scene.energy);
  return {
    hasContext: Boolean(query || normalizeText(scene.preset) || styleTags.size > 0),
    styleTags,
    ...(genre ? { genre } : {}),
    ...(targetEnergy !== undefined ? { targetEnergy } : {}),
  };
}

function buildArtistPreference(
  entries: readonly InternalCandidate[],
  options: PersonalizationOptions,
  feedback: FeedbackState,
): Map<string, number> {
  const scores = new Map<string, number>();
  const addArtist = (artist: string, weight: number): void => {
    const key = normalizeText(artist);
    if (!key || !Number.isFinite(weight)) return;
    scores.set(key, Math.min(MAX_AFFINITY_REWARD, (scores.get(key) ?? 0) + weight));
  };
  const addPoolArtists = (pool: readonly PersonalizationCandidate[] | undefined, weight: number): void => {
    for (const candidate of pool ?? []) {
      for (const artist of candidateArtistNames(candidate)) addArtist(artist, weight);
    }
  };
  addPoolArtists(options.liked, 12);
  addPoolArtists(options.playlist, 4);
  addPoolArtists(options.playlists, 4);
  addPoolArtists(options.history, 2);
  for (const entry of entries) {
    if (feedback.liked.has(entry.id)) addArtist(entry.artist, 10 * (feedback.liked.get(entry.id) ?? 0));
    if (feedback.completed.has(entry.id)) addArtist(entry.artist, 2 * (feedback.completed.get(entry.id) ?? 0));
  }
  for (const name of options.preferredArtistNames ?? []) addArtist(name, 15);
  if (Array.isArray(options.preferredArtists)) {
    for (const name of options.preferredArtists) addArtist(name, 15);
  } else if (options.preferredArtists) {
    for (const [name, weight] of Object.entries(options.preferredArtists)) addArtist(name, weight);
  }
  return scores;
}

function readFeedback(input: SessionFeedback | null | undefined): FeedbackState {
  const skipped = new Map<string, number>();
  const completed = new Map<string, number>();
  const liked = new Map<string, number>();
  const add = (target: Map<string, number>, id: CandidateId): void => {
    const normalized = normalizeId(id);
    if (normalized) target.set(normalized, (target.get(normalized) ?? 0) + 1);
  };
  if (input) {
    for (const id of input.skipped ?? []) add(skipped, id);
    for (const id of input.skip ?? []) add(skipped, id);
    for (const id of input.completed ?? []) add(completed, id);
    for (const id of input.liked ?? []) add(liked, id);
    for (const event of [...(input.events ?? []), ...(input.actions ?? [])]) {
      const id = event.trackId ?? event.candidateId ?? event.id;
      if (id === undefined) continue;
      const action = event.action ?? event.type;
      if (action === "skip" || action === "skipped") add(skipped, id);
      if (action === "completed") add(completed, id);
      if (action === "liked") add(liked, id);
    }
  }
  const recentTrackIds = new Set<string>();
  for (const id of input?.recentTrackIds ?? []) {
    const normalized = normalizeId(id);
    if (normalized) recentTrackIds.add(normalized);
  }
  const recentArtists = new Set<string>();
  for (const artist of input?.recentArtistNames ?? []) {
    const normalized = normalizeText(artist);
    if (normalized) recentArtists.add(normalized);
  }
  const currentArtist = normalizeText(input?.currentArtist);
  if (currentArtist) recentArtists.add(currentArtist);
  const currentTrackId = normalizeId(input?.currentTrackId);
  if (currentTrackId) recentTrackIds.add(currentTrackId);
  return {
    skipped,
    completed,
    liked,
    recentTrackIds,
    recentArtists,
    currentTrackId,
    currentArtist,
  };
}

function hasPreferenceData(options: PersonalizationOptions, entries: readonly InternalCandidate[]): boolean {
  return Boolean(
    (options.liked?.length ?? 0) > 0 ||
    (options.playlist?.length ?? 0) > 0 ||
    (options.playlists?.length ?? 0) > 0 ||
    (options.history?.length ?? 0) > 0 ||
    (options.recent?.length ?? 0) > 0 ||
    entries.some((entry) => entry.sources.has("liked") || entry.sources.has("playlist") || entry.sources.has("history") || entry.sources.has("recent")),
  );
}

function compareScoreEntries(left: ScoreEntry, right: ScoreEntry): number {
  const delta = right.score - left.score;
  if (Math.abs(delta) > 1e-9) return delta;
  const idDelta = compareText(left.candidate.id, right.candidate.id);
  if (idDelta !== 0) return idDelta;
  const titleDelta = compareText(left.candidate.title, right.candidate.title);
  if (titleDelta !== 0) return titleDelta;
  const artistDelta = compareText(left.candidate.artist, right.candidate.artist);
  if (artistDelta !== 0) return artistDelta;
  return compareText(left.candidate.sourceSignature, right.candidate.sourceSignature);
}

function candidateSources(source: PersonalizationCandidate["source"]): PersonalizationSource[] {
  const values = Array.isArray(source) ? source : source === undefined ? [] : [source];
  const result = new Set<PersonalizationSource>();
  for (const value of values) {
    const normalized = SOURCE_ALIASES[normalizeText(value)];
    if (normalized) result.add(normalized);
  }
  return [...result];
}

function sourceSignature(sources: ReadonlySet<PersonalizationSource>): string {
  return [...sources].sort(compareText).join(",");
}

function candidateInformationScore(candidate: PersonalizationCandidate): number {
  let score = 0;
  if (normalizeText(candidate.title)) score += 2;
  if (candidateArtist(candidate)) score += 3;
  if (candidateGenre(candidate)) score += 1;
  if (candidateEnergy(candidate) !== undefined) score += 1;
  if (Array.isArray(candidate.mood) && candidate.mood.length > 0) score += 1;
  if (Array.isArray(candidate.styleTags) && candidate.styleTags.length > 0) score += 2;
  if (normalizeText(candidate.searchQuery ?? candidate.query)) score += 1;
  if (candidate.durationSeconds !== undefined || candidate.durationMs !== undefined) score += 1;
  return score;
}

function candidateTitle(candidate: PersonalizationCandidate): string {
  return typeof candidate.title === "string" ? candidate.title.trim() : "";
}

function candidateArtist(candidate: PersonalizationCandidate): string {
  if (typeof candidate.artist === "string" && candidate.artist.trim()) return candidate.artist.trim();
  if (Array.isArray(candidate.artists)) {
    return candidate.artists
      .map((artist) => typeof artist === "string" ? artist : artist?.name)
      .filter((artist): artist is string => typeof artist === "string" && artist.trim().length > 0)
      .map((artist) => artist.trim())
      .join(", ");
  }
  return "";
}

function candidateArtistNames(candidate: PersonalizationCandidate): string[] {
  if (Array.isArray(candidate.artists)) {
    const names = candidate.artists
      .map((artist) => typeof artist === "string" ? artist : artist?.name)
      .filter((artist): artist is string => typeof artist === "string" && artist.trim().length > 0)
      .map((artist) => artist.trim());
    if (names.length > 0) return names;
  }
  return typeof candidate.artist === "string" && candidate.artist.trim() ? [candidate.artist.trim()] : [];
}

function candidateGenre(candidate: PersonalizationCandidate): string | undefined {
  return normalizeText(candidate.genre) || undefined;
}

function candidateStyleTags(candidate: PersonalizationCandidate): string[] {
  return Array.isArray(candidate.styleTags)
    ? [...new Set(candidate.styleTags.map(normalizeText).filter(Boolean))]
    : [];
}

function searchQueryTags(candidate: PersonalizationCandidate): string[] {
  const query = normalizeText(candidate.searchQuery ?? candidate.query);
  if (!query) return [];
  const tags = new Set<string>();
  for (const tag of candidateStyleTags(candidate)) {
    if (query.includes(tag)) tags.add(tag);
  }
  for (const token of query.split(/[\s,，/|+·]+/)) {
    const normalized = normalizeText(token);
    if (normalized) tags.add(normalized);
  }
  return [...tags];
}

function candidateEnergy(candidate: PersonalizationCandidate): number | undefined {
  return finiteEnergy(candidate.energy);
}

function candidatePopularity(candidate: PersonalizationCandidate): number | undefined {
  const value = candidate.popularity;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(1, value > 1 ? value / 100 : value);
}

function finiteEnergy(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

function normalizeId(value: unknown): string | null {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  return null;
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function iterableToArray<T>(value: Iterable<T> | undefined): T[] {
  return value ? [...value] : [];
}

function formatSigned(value: number): string {
  return `${value >= 0 ? "+" : ""}${Number(value.toFixed(2))}`;
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function cloneCandidate<T extends PersonalizationCandidate>(candidate: T): T {
  const clone: PersonalizationCandidate = { ...candidate };
  if (Array.isArray(candidate.mood)) clone.mood = [...candidate.mood];
  if (Array.isArray(candidate.styleTags)) clone.styleTags = [...candidate.styleTags];
  if (Array.isArray(candidate.artists)) {
    clone.artists = candidate.artists.map((artist) => typeof artist === "string" ? artist : { ...artist });
  }
  if (Array.isArray(candidate.source)) clone.source = [...candidate.source];
  return clone as T;
}
