import type { ProgramSpec } from "../shared/contracts.js";

type RecommendationContext = Pick<ProgramSpec, "scenePreset"> & Partial<Pick<ProgramSpec, "recommendationMode" | "musicGenres">>;

interface RecommendationTextCandidate {
  title?: unknown;
  name?: unknown;
  artist?: unknown;
  artists?: unknown;
  album?: unknown;
  genre?: unknown;
  mood?: unknown;
  styleTags?: unknown;
  query?: unknown;
  searchQuery?: unknown;
  description?: unknown;
}

const LOW_QUALITY_CHINESE_DANCE_RE = /土\s*(?:嗨|high)|喊麦|社会摇|车载\s*(?:dj|舞曲|串烧|慢摇)|(?:夜店|蹦迪).{0,4}(?:神曲|串烧)|(?:快手|抖音|douyin).{0,10}(?:热播|热门|神曲|remix|re-?mix|dj|版|bgm|串烧)|(?:热播|热门|神曲|remix|re-?mix|dj|版|bgm|串烧).{0,10}(?:快手|抖音|douyin)/i;
const DJ_VERSION_RE = /(?:^|[\s([（【《<])(?:dj|d\.j\.)(?:\s*)?(?:版|舞曲|串烧|慢摇|车载|加快|加速|抖音|快手|remix|re-?mix|mix|嗨曲)(?:$|[\s)\]）】》>])/i;
const CHINESE_REMIX_RE = /(?:remix|re-?mix|bootleg|mashup|mix版|混音版|加速版|加快版|降调版|升调版|slowed|sped\s*up|speed\s*up)/i;
const DJ_OR_CAR_AUDIO_RE = /车\s*载|(?:^|[^a-z0-9])d\.?\s*j\.?(?=$|[^a-z0-9])/i;
const EXPLORATION_VERSION_RE = /(?:remix|re-?mix|bootleg|mashup|mix版|混音版|加速版|加快版|降调版|升调版|slowed|sped\s*up|speed\s*up|\blive\b|\bconcert\b|演唱会|现场(?:版|录音)?|\bversion\b|\bver\.?(?=$|[\s)\]）】》>])|\bremaster(?:ed)?\b|\bradio\s+edit\b|\bextended\s+(?:mix|edit)\b|\bacoustic\b|(?:不插电|重制|重新录制|加长|剪辑|伴奏|纯音乐|翻唱|男声|女声|合唱|独唱|录音室|原声)\s*版)/i;

// Match functional/religious metadata, not generic words such as calm, piano,
// instrumental, dream, prayer or sleep that also occur in ordinary song titles.
const RELIGIOUS_MUSIC_RE = /宗教|佛教|佛乐|佛曲|佛音|梵音|念佛|诵经|颂经|经文|道教|道家|道乐|清心咒|大悲咒|金刚经|心经|神咒|赞美诗|圣歌|圣咏|\b(?:religious|worship|devotional|gospel|hymns?|christian music|gregorian chant|buddhist|taoist|mantra)\b/i;
const FUNCTIONAL_RELAXATION_RE = /催眠曲|催眠音乐|催眠音樂|助眠|安眠曲|睡眠音乐|睡眠音樂|深度睡眠|快速入睡|睡眠.{0,8}入睡|\d+分钟入睡|白噪音|白噪声|冥想|脑波|腦波|(?:减压|減壓|解压|解壓|疗愈|療癒|療愈|治愈|治癒).{0,12}(?:纯音乐|純音樂|器乐|器樂|音乐|音樂|音频|音頻)|(?:纯音乐|純音樂|器乐|器樂).{0,12}(?:减压|減壓|解压|解壓|疗愈|療癒|療愈)|\b(?:sleep(?:ing)? music|deep sleep|sleep aid|hypnosis|hypnotic music|meditation|binaural beats|white noise|stress relief|healing music)\b/i;

const MC_ARTIST_RE = /(?:^|[\s/&,、，])m\.?\s*c\.?(?=$|[^a-z0-9])/i;
const UNKNOWN_ALBUM_RE = /^(?:未知(?:专辑|專輯)?|不详|不詳|暂无(?:专辑|專輯)?|无专辑|無專輯|unknown(?:\s+album)?|untitled(?:\s+album)?|n\/?a|null|undefined|[-—]+)$/i;
const NON_SONG_AUDIO_RE = /(?:宝宝|寶寶|婴儿|嬰兒|婴幼儿|嬰幼兒).{0,4}(?:笑声|笑聲|哭声|哭聲)|\bbaby\s+(?:laugh(?:ter|ing)?|cry(?:ing)?)\b|(?:搞笑|魔性|整蛊|整蠱|提示|通知|来电|來電|手机|手機)(?:音效|铃声|鈴聲)|(?:社会|社會|精神小伙|情感|伤感|傷感)(?:语录|語錄)|喊麦|喊麥/i;

export function hasKnownRecommendationAlbum(value: unknown): boolean {
  const record = unwrapRecord(value);
  const album = isRecord(record?.album) ? record.album.name : record?.album;
  return typeof album === "string" && album.trim().length > 0
    && !UNKNOWN_ALBUM_RE.test(album.normalize("NFKC").trim());
}

export function disallowedRecommendationReason(value: unknown, context?: RecommendationContext): string | null {
  const text = recommendationText(value);
  if (!text) return null;
  const record = unwrapRecord(value);
  const artists: string[] = [];
  addString(artists, record?.artist);
  if (Array.isArray(record?.artists)) {
    for (const artist of record.artists) addString(artists, isRecord(artist) ? artist.name : artist);
  }
  if (artists.some((artist) => MC_ARTIST_RE.test(artist.normalize("NFKC")))) return "MC artist";
  if (record && "album" in record && !hasKnownRecommendationAlbum(record)) return "unknown album";
  if (NON_SONG_AUDIO_RE.test(text)) return "non-song audio or spoken internet content";
  if (DJ_OR_CAR_AUDIO_RE.test(recommendationContentText(value))) return "DJ or car audio signal";
  if (LOW_QUALITY_CHINESE_DANCE_RE.test(text)) return "low quality Chinese dance/remix signal";
  if (DJ_VERSION_RE.test(text)) return "DJ version/remix signal";
  if (CHINESE_REMIX_RE.test(text) && /[\p{Script=Han}]/u.test(text)) return "Chinese remix signal";
  const isRelaxationAtmosphere = context?.scenePreset === "late_night"
    && context.recommendationMode !== "genre"
    && (context.recommendationMode === "atmosphere" || !context.musicGenres?.length);
  if (isRelaxationAtmosphere && RELIGIOUS_MUSIC_RE.test(text)) return "religious music in relaxation atmosphere";
  if (isRelaxationAtmosphere && FUNCTIONAL_RELAXATION_RE.test(text)) return "sleep or functional relaxation audio";
  return null;
}

export function isDisallowedRecommendationCandidate(value: unknown, context?: RecommendationContext): boolean {
  return disallowedRecommendationReason(value, context) !== null;
}

export function isExplorationVersionCandidate(value: unknown): boolean {
  const record = unwrapRecord(value);
  if (!record) return false;
  const fields: string[] = [];
  addString(fields, record.title);
  addString(fields, record.name);
  if (isRecord(record.album)) addString(fields, record.album.name);
  else addString(fields, record.album);
  return EXPLORATION_VERSION_RE.test(fields.join(" ").normalize("NFKC").replace(/\s+/g, " ").trim());
}

function recommendationText(value: unknown): string {
  return recommendationTextFields(value, true);
}

function recommendationContentText(value: unknown): string {
  return recommendationTextFields(value, false);
}

function recommendationTextFields(value: unknown, includeArtists: boolean): string {
  const record = unwrapRecord(value);
  if (!record) return "";
  const fields: string[] = [];
  addString(fields, record.title);
  addString(fields, record.name);
  addString(fields, record.genre);
  addString(fields, record.query);
  addString(fields, record.searchQuery);
  addString(fields, record.description);
  addList(fields, record.mood);
  addList(fields, record.styleTags);
  if (isRecord(record.album)) addString(fields, record.album.name);
  else addString(fields, record.album);
  if (includeArtists) addString(fields, record.artist);
  if (includeArtists && Array.isArray(record.artists)) {
    for (const artist of record.artists) {
      if (typeof artist === "string") addString(fields, artist);
      else if (isRecord(artist)) addString(fields, artist.name);
    }
  }
  return fields.join(" ").normalize("NFKC").replace(/\s+/g, " ").trim();
}

function unwrapRecord(value: unknown): RecommendationTextCandidate | null {
  if (isRecord(value) && isRecord(value.song)) return value.song as RecommendationTextCandidate;
  return isRecord(value) ? value as RecommendationTextCandidate : null;
}

function addString(fields: string[], value: unknown): void {
  if (typeof value === "string" && value.trim()) fields.push(value.trim());
}

function addList(fields: string[], value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const item of value) addString(fields, item);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
