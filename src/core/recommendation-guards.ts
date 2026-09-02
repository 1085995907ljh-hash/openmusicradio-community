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

export function disallowedRecommendationReason(value: unknown): string | null {
  const text = recommendationText(value);
  if (!text) return null;
  if (DJ_OR_CAR_AUDIO_RE.test(recommendationContentText(value))) return "DJ or car audio signal";
  if (LOW_QUALITY_CHINESE_DANCE_RE.test(text)) return "low quality Chinese dance/remix signal";
  if (DJ_VERSION_RE.test(text)) return "DJ version/remix signal";
  if (CHINESE_REMIX_RE.test(text) && /[\p{Script=Han}]/u.test(text)) return "Chinese remix signal";
  return null;
}

export function isDisallowedRecommendationCandidate(value: unknown): boolean {
  return disallowedRecommendationReason(value) !== null;
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
