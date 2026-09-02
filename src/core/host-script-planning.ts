import type { ScenePreset, Track } from "../shared/contracts.js";

export type HostBreakMode = "previous_review" | "artist_spotlight" | "verified_story" | "mystery_tease";

export interface HostBreakPlan {
  durationSeconds: number;
  musicBedDelaySeconds: number;
}

export const HOST_MUSIC_START_DELAY_SECONDS = 5;
export const HOST_MUSIC_DUCK_DB = -6;
export const HOST_MUSIC_DUCK_VOLUME = dbToGain(HOST_MUSIC_DUCK_DB);
export const HOST_MUSIC_RESTORE_DURATION_MS = 2_000;

export function dbToGain(db: number): number {
  if (!Number.isFinite(db)) return 1;
  return Math.max(0, Math.min(1, 10 ** (db / 20)));
}

export function radioGreetingAt(date: Date): "早上好" | "下午好" | "晚上好" | "夜深了" {
  const hour = date.getHours();
  if (hour >= 5 && hour < 12) return "早上好";
  if (hour >= 12 && hour < 18) return "下午好";
  if (hour >= 18) return "晚上好";
  return "夜深了";
}

export type HostDurationSeconds = number;
export type HostFrequency = "low" | "medium" | "high";

interface HostBreakPlanInput {
  mode: HostBreakMode;
  scenePreset: ScenePreset;
  programPhase: "opening" | "building" | "peak" | "cooldown" | "closing";
  previousTrack: Track | null;
  currentTrack: Track;
  facts?: readonly string[];
  targetDurationSeconds?: HostDurationSeconds;
}

const LONG_INTRO_PATTERN = /(?:长前奏|前奏.{0,8}(?:较长|很长|缓慢|渐进|铺陈)|long\s+intro|extended\s+intro)/i;
const FAST_MOOD_PATTERN = /(?:高能|强劲|热烈|快节奏|躁动|舞曲|说唱|摇滚|朋克|电子|dance|rap|rock|punk|electronic|energetic)/i;

export function planHostBreak(input: HostBreakPlanInput): HostBreakPlan {
  const baseByMode: Record<HostBreakMode, number> = {
    previous_review: 22,
    artist_spotlight: 24,
    verified_story: 30,
    mystery_tease: 20,
  };
  let seconds = input.targetDurationSeconds ?? baseByMode[input.mode];
  const energy = clamp(input.currentTrack.energy, 0, 1);
  const previousEnergy = input.previousTrack ? clamp(input.previousTrack.energy, 0, 1) : energy;
  const moodText = input.currentTrack.mood.join(" ");

  if (input.targetDurationSeconds === undefined) {
    if (input.programPhase === "opening") seconds += 1;
    if (input.scenePreset === "late_night" || input.scenePreset === "study") seconds += 2;
    if (input.scenePreset === "workout" || input.scenePreset === "party") seconds -= 2;
    if (energy >= 0.72 || FAST_MOOD_PATTERN.test(moodText)) seconds -= 4;
    else if (energy <= 0.34) seconds += 3;
    if (energy - previousEnergy >= 0.25) seconds -= 2;
    else if (previousEnergy - energy >= 0.25) seconds += 2;
    if ((input.facts ?? []).some((fact) => LONG_INTRO_PATTERN.test(fact))) seconds += 4;
  }

  const minimumSeconds = input.targetDurationSeconds === undefined ? 20 : 5;
  const durationSeconds = Math.round(clamp(seconds, minimumSeconds, 35));
  const musicBedDelaySeconds = HOST_MUSIC_START_DELAY_SECONDS;
  return { durationSeconds, musicBedDelaySeconds };
}

export function planHostDurationTargets(explorationFlags: readonly boolean[]): HostDurationSeconds[] {
  let familiarIndex = 0;
  let explorationIndex = 0;
  return explorationFlags.map((isExploration) => {
    if (isExploration) {
      const duration = [28, 34][explorationIndex % 2]!;
      explorationIndex += 1;
      return duration;
    }
    const duration = [14, 18][familiarIndex % 2]!;
    familiarIndex += 1;
    return duration;
  });
}

export function middleHostBreakCount(trackCount: number, frequency: HostFrequency): number {
  const candidates = Math.max(Math.floor(trackCount) - 2, 0);
  if (candidates === 0) return 0;
  const ratio = frequency === "low" ? 0.4 : frequency === "medium" ? 0.6 : 0.8;
  return Math.max(frequency === "low" ? 1 : 0, Math.round(candidates * ratio));
}

export function middleHostBreakCountIsAcceptable(trackCount: number, frequency: HostFrequency, actual: number): boolean {
  const candidates = Math.max(Math.floor(trackCount) - 2, 0);
  if (!Number.isInteger(actual) || actual < 0 || actual > candidates) return false;
  if (candidates === 0) return actual === 0;
  const target = middleHostBreakCount(trackCount, frequency);
  return actual >= Math.max(1, target - 1) && actual <= Math.min(candidates, target + 1);
}

export function evenlySpacedHostBreakIndices(trackCount: number, frequency: HostFrequency): number[] {
  const count = Math.max(0, Math.floor(trackCount));
  if (count === 0) return [];
  if (count === 1) return [0];
  const middleCount = middleHostBreakCount(count, frequency);
  const middle = Array.from({ length: middleCount }, (_, index) => {
    const slot = Math.round(((index + 1) * (count - 1)) / (middleCount + 1));
    return Math.min(count - 2, Math.max(1, slot));
  });
  return [0, ...new Set(middle), count - 1];
}

export function hostCharacterBounds(durationSeconds: number): { min: number; max: number } {
  const seconds = clamp(Math.round(durationSeconds), 5, 35);
  return {
    min: Math.floor(seconds * 2.8),
    max: Math.ceil(seconds * 3.7),
  };
}

export function releaseTitlesMatch(trackTitle: string, albumTitle: string): boolean {
  const normalize = (value: string) => value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\b(?:single|ep)\b/g, "")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
  const track = normalize(trackTitle);
  return track.length > 0 && track === normalize(albumTitle);
}

export function spokenArtistName(value: string): string {
  const artist = value.replace(/\s+/g, " ").trim();
  if (!artist) return artist;
  const hanRuns = artist.match(/[\p{Script=Han}]{2,12}/gu) ?? [];
  const latinLength = (artist.match(/[A-Za-z]/g) ?? []).length;
  if (hanRuns.length > 0 && latinLength >= 6) {
    return [...hanRuns].sort((left, right) => right.length - left.length)[0]!;
  }
  return artist;
}

export function normalizeSpokenEnglishCase(value: string): string {
  return value.replace(/\b(?:[A-Z]{2,}|[A-Z]+(?:['’][A-Z]+)+)\b/g, (word) => {
    const lower = word.toLocaleLowerCase("en-US");
    return `${lower.charAt(0).toLocaleUpperCase("en-US")}${lower.slice(1)}`;
  });
}

export function normalizeSpokenYearDigits(value: string): string {
  const digits: Record<string, string> = {
    "零": "0",
    "〇": "0",
    "○": "0",
    "一": "1",
    "二": "2",
    "三": "3",
    "四": "4",
    "五": "5",
    "六": "6",
    "七": "7",
    "八": "8",
    "九": "9",
  };
  return value.replace(/([零〇○一二三四五六七八九]{4})\s*年/g, (_, year: string) => `${Array.from(year).map((character) => digits[character] ?? character).join("")}年`);
}

export function hostScriptRepeats(text: string, previousLines: readonly string[]): boolean {
  const normalized = normalizeHostText(text);
  if (!normalized) return true;
  const prefix = normalized.slice(0, 12);
  const suffix = normalized.slice(-10);
  const grams = trigrams(normalized);
  return previousLines.some((line) => {
    const previous = normalizeHostText(line);
    if (!previous) return false;
    if (previous === normalized) return true;
    if (prefix.length >= 8 && previous.startsWith(prefix)) return true;
    if (suffix.length >= 8 && previous.endsWith(suffix)) return true;
    return jaccard(grams, trigrams(previous)) >= 0.68;
  });
}

function normalizeHostText(value: string): string {
  return value
    .replace(/《[^》]+》/g, "《曲目》")
    .replace(/^(这一段由|马上要播的是|刚刚听完的是)[^，。！？；]{1,36}/, "$1对象")
    .replace(/[\s，。！？、,.!?；;:："“”‘’'「」『』《》—-]/g, "")
    .toLocaleLowerCase();
}

function trigrams(value: string): Set<string> {
  const characters = Array.from(value);
  const result = new Set<string>();
  for (let index = 0; index <= characters.length - 3; index += 1) result.add(characters.slice(index, index + 3).join(""));
  return result;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const item of left) if (right.has(item)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}
