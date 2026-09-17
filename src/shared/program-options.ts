import type { ScenePreset } from "./contracts.js";

export const HOST_PROFILE_IDS = ["longhao", "xiaocheng", "longxin", "anxuan", "anya", "anran"] as const;
export type HostProfileId = (typeof HOST_PROFILE_IDS)[number];

export interface HostProfileOption {
  id: HostProfileId;
  name: string;
  genderSymbol: "♀" | "♂";
  trait: string;
  age: number;
  mbti: string;
  scenePreset: ScenePreset;
  model: "qwen-audio-3.0-tts-plus";
  voice: string;
  /** Stable speaking rate; independent of playlist atmosphere and script length. */
  ttsRate: number;
}

export const HOST_PROFILES: Readonly<Record<HostProfileId, HostProfileOption>> = Object.freeze({
  longhao: { id: "longhao", name: "龙浩", genderSymbol: "♂", trait: "温和细腻", age: 29, mbti: "INFJ", scenePreset: "late_night", model: "qwen-audio-3.0-tts-plus", voice: "qwen-audio-3.0-tts-plus-longhuifengyi", ttsRate: 0.98 },
  xiaocheng: { id: "xiaocheng", name: "龙小诚", genderSymbol: "♂", trait: "沉稳理性", age: 31, mbti: "ISTJ", scenePreset: "study", model: "qwen-audio-3.0-tts-plus", voice: "qwen-audio-3.0-tts-plus-longchengyiwei", ttsRate: 1.08 },
  longxin: { id: "longxin", name: "龙鑫", genderSymbol: "♂", trait: "清新有活力", age: 23, mbti: "ESFP", scenePreset: "commute", model: "qwen-audio-3.0-tts-plus", voice: "qwen-audio-3.0-tts-plus-longhexuanlan", ttsRate: 0.95 },
  anxuan: { id: "anxuan", name: "龙安宣", genderSymbol: "♀", trait: "爽朗坚定", age: 27, mbti: "ENFJ", scenePreset: "workout", model: "qwen-audio-3.0-tts-plus", voice: "qwen-audio-3.0-tts-plus-longhongxiaoxiao", ttsRate: 1.03 },
  anya: { id: "anya", name: "龙安雅", genderSymbol: "♀", trait: "知性从容", age: 30, mbti: "INTJ", scenePreset: "commute", model: "qwen-audio-3.0-tts-plus", voice: "qwen-audio-3.0-tts-plus-longchenghongling", ttsRate: 1.00 },
  anran: { id: "anran", name: "龙安燃", genderSymbol: "♀", trait: "热情外向", age: 25, mbti: "ENFP", scenePreset: "party", model: "qwen-audio-3.0-tts-plus", voice: "qwen-audio-3.0-tts-plus-longfengxindie", ttsRate: 1.06 },
});

export type HostTtsMoment = "opening" | "song_note" | "next_preview" | "scene_boost" | "music_news";

const HOST_TTS_PERSONAS: Readonly<Record<HostProfileId, string>> = Object.freeze({
  longhao: "温暖柔和，真诚亲近，像和熟人聊音乐，语速舒缓自然。",
  xiaocheng: "沉稳清楚，笃定亲切，像朋友认真分享发现，语速稍快利落。",
  longxin: "清爽阳光，带轻微笑意，像朋友轻松分享，语速从容自然。",
  anxuan: "爽朗自信，热忱有力，像朋友干脆地推荐好歌，语速明快。",
  anya: "知性从容，温和有兴味，像朋友娓娓分享见解，语速自然。",
  anran: "热情灵动，开心好奇，像发现好歌就想分享的朋友，语速轻快。",
});

export function hostTtsPersona(profileId: HostProfileId): string {
  return HOST_TTS_PERSONAS[profileId] ?? HOST_TTS_PERSONAS[DEFAULT_HOST_PROFILE];
}

export function hostTtsInstruction(profileId: HostProfileId, _moment?: HostTtsMoment, _deliveryInstruction?: string): string {
  // Personality and pace belong to the host. Generated stage/duration directions
  // must not override them; the text supplies the local meaning and emphasis.
  return `${hostTtsPersona(profileId)}按语意自然起伏和停顿，读完即止。`;
}

/** Discard timing directives before they can override the host's normal pace. */
export function naturalHostDeliveryInstruction(instruction?: string): string {
  const value = instruction?.trim() ?? "";
  return /凑(?:满|够|足|时)|补(?:满|够|足|齐).{0,8}(?:秒|时)|拖音|补静音|(?:拉长|拖长).{0,8}(?:秒|时间|时长)|(?:至少|不少于|达到|控制在|保持|持续|保证|延长到|为了|目标).{0,12}(?:秒|\d\s*s\b|seconds)|\b(?:stretch|pad|fill).{0,25}(?:second|duration|time)/i.test(value) ? "" : value;
}

export function hostPreviewText(profileId: HostProfileId): string {
  return `欢迎收听 Open Music Radio 电台，我是主持人${HOST_PROFILES[profileId].name}。`;
}

export function hostPreviewUrl(profileId: HostProfileId): string {
  return `/hosts/previews/${profileId}.mp3?v=20260917-2`;
}

export const HOST_DURATION_REACHED_TEXT = "本档节目设定的时间到了，听完这首歌，我们就结束今天的节目。";

export function hostDurationReachedCueUrl(profileId: HostProfileId): string {
  const resolvedProfileId = HOST_PROFILES[profileId] ? profileId : DEFAULT_HOST_PROFILE;
  return `/hosts/cues/duration-reached/${resolvedProfileId}.mp3?v=20260917-2`;
}

export function hostOpeningIdentity(profileId: HostProfileId): string {
  return `欢迎收听 Open Music Radio 电台，我是主持人${HOST_PROFILES[profileId].name}。`;
}

export const DEFAULT_HOST_PROFILE: HostProfileId = "longhao";

export const MUSIC_GENRE_IDS = [
  "pop", "rock", "folk", "electronic", "dance", "hiphop", "easy_listening", "jazz",
  "country", "rnb_soul", "classical", "ethnic", "britpop", "metal", "punk", "blues",
  "reggae", "world", "latin", "new_age", "gufeng", "post_rock", "bossa_nova",
] as const;

export const MAX_MUSIC_GENRES = 3;
export const PLAYLIST_NAME_MAX_CHARACTERS = 20;
export type MusicGenreId = (typeof MUSIC_GENRE_IDS)[number];

export interface MusicGenreOption {
  id: MusicGenreId;
  label: string;
  searchTerm: string;
}

export const MUSIC_GENRES: Readonly<Record<MusicGenreId, MusicGenreOption>> = Object.freeze({
  pop: { id: "pop", label: "流行", searchTerm: "流行 Pop City Pop 独立流行 华语 K-Pop J-Pop" },
  rock: { id: "rock", label: "摇滚", searchTerm: "摇滚 Rock Alternative Indie Rock" },
  folk: { id: "folk", label: "民谣", searchTerm: "民谣 Folk Acoustic" },
  electronic: { id: "electronic", label: "电子", searchTerm: "电子 Electronic EDM Techno House Synth" },
  dance: { id: "dance", label: "舞曲", searchTerm: "舞曲 Dance DJ Club 迪斯科 Disco" },
  hiphop: { id: "hiphop", label: "说唱", searchTerm: "说唱 嘻哈 Hip-Hop Rap Trap" },
  easy_listening: { id: "easy_listening", label: "轻音乐", searchTerm: "轻音乐 Easy Listening Lo-Fi 纯音乐 Instrumental Piano" },
  jazz: { id: "jazz", label: "爵士", searchTerm: "爵士 Jazz Swing Bebop" },
  country: { id: "country", label: "乡村", searchTerm: "乡村 Country" },
  rnb_soul: { id: "rnb_soul", label: "R&B/Soul", searchTerm: "R&B Soul 节奏布鲁斯 灵魂 Neo Soul Funk 放克" },
  classical: { id: "classical", label: "古典", searchTerm: "古典 Classical" },
  ethnic: { id: "ethnic", label: "民族", searchTerm: "民族 中国传统 民族音乐 Ethnic" },
  britpop: { id: "britpop", label: "英伦", searchTerm: "英伦摇滚 Britpop UK Indie" },
  metal: { id: "metal", label: "金属", searchTerm: "金属 Metal" },
  punk: { id: "punk", label: "朋克", searchTerm: "朋克 Punk" },
  blues: { id: "blues", label: "蓝调", searchTerm: "蓝调 布鲁斯 Blues" },
  reggae: { id: "reggae", label: "雷鬼", searchTerm: "雷鬼 Reggae" },
  world: { id: "world", label: "世界音乐", searchTerm: "世界音乐 World Music" },
  latin: { id: "latin", label: "拉丁", searchTerm: "拉丁 Latin Salsa" },
  new_age: { id: "new_age", label: "New Age", searchTerm: "New Age 新世纪 氛围 Ambient Drone 冥想" },
  gufeng: { id: "gufeng", label: "古风", searchTerm: "古风 国风 中国风" },
  post_rock: { id: "post_rock", label: "后摇", searchTerm: "后摇 Post-Rock" },
  bossa_nova: { id: "bossa_nova", label: "Bossa Nova", searchTerm: "Bossa Nova 巴萨诺瓦" },
});
