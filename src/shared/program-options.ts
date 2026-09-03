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
  model: "cosyvoice-v2" | "qwen-audio-3.0-tts-plus";
  voice: string;
  ttsRate?: number;
}

export const HOST_PROFILES: Readonly<Record<HostProfileId, HostProfileOption>> = Object.freeze({
  longhao: { id: "longhao", name: "龙浩", genderSymbol: "♂", trait: "温和细腻", age: 29, mbti: "INFJ", scenePreset: "late_night", model: "qwen-audio-3.0-tts-plus", voice: "qwen-audio-3.0-tts-plus-longhuifengyi" },
  xiaocheng: { id: "xiaocheng", name: "龙小诚", genderSymbol: "♂", trait: "沉稳理性", age: 31, mbti: "ISTJ", scenePreset: "study", model: "cosyvoice-v2", voice: "longxiaocheng_v2" },
  longxin: { id: "longxin", name: "龙鑫", genderSymbol: "♂", trait: "清新有活力", age: 23, mbti: "ESFP", scenePreset: "commute", model: "qwen-audio-3.0-tts-plus", voice: "qwen-audio-3.0-tts-plus-longhexuanlan", ttsRate: 1.02 },
  anxuan: { id: "anxuan", name: "龙安宣", genderSymbol: "♀", trait: "爽朗坚定", age: 27, mbti: "ENFJ", scenePreset: "workout", model: "cosyvoice-v2", voice: "longanxuan" },
  anya: { id: "anya", name: "龙安雅", genderSymbol: "♀", trait: "知性从容", age: 30, mbti: "INTJ", scenePreset: "commute", model: "qwen-audio-3.0-tts-plus", voice: "qwen-audio-3.0-tts-plus-longchenghongling" },
  anran: { id: "anran", name: "龙安燃", genderSymbol: "♀", trait: "热情外向", age: 25, mbti: "ENFP", scenePreset: "party", model: "cosyvoice-v2", voice: "longanran", ttsRate: 1.01 },
});

export type HostTtsMoment = "opening" | "song_note" | "next_preview" | "scene_boost" | "music_news";

const HOST_TTS_PERSONAS: Readonly<Record<HostProfileId, string>> = Object.freeze({
  longhao: "主持人龙浩，像深夜熟人坐在旁边聊音乐；声音温暖，声调柔和，语速中等，情绪稳定，表达深情，句尾轻轻落下。",
  xiaocheng: "主持人龙小诚，声线低稳清楚，像做过功课的音乐编辑；语气沉稳理性，咬字干净，语速中等，停顿短而利落，情绪克制但不要冷。",
  longxin: "主持人龙鑫，声线清亮年轻，像二十三岁的大学生音乐博主；语气清爽阳光，有一点笑意和活力但不油，语速略快，句尾自然上扬。",
  anxuan: "主持人龙安宣，声线明亮有劲，像舞台边很会带节奏的朋友；语气爽朗坚定，重点词说得干脆，语速中等，情绪有力量但不要喊。",
  anya: "主持人龙安雅，声线干净偏冷，像审美很准的独立音乐专栏作者；语气知性从容，轻微笑意，语速中等，停顿干净，信息点轻轻抛出。",
  anran: "主持人龙安燃，声线明快灵动，像刚发现好歌就想分享的朋友；语气热情外向，好奇感强但不过火，语速略快，句间停顿短，情绪自然往前推。",
});

const HOST_TTS_MOMENTS: Readonly<Record<HostTtsMoment, string>> = Object.freeze({
  opening: "这是节目开场，第一句要有进入电台的感觉，后面自然落到第一首歌。",
  next_preview: "这是节目中段串联，不要重新开场，不要播音腔，像顺着上一首自然聊到下一首。",
  song_note: "这是最后一首歌前的口播，语气有收束感，让听众知道节目快结束，但不要正式告别。",
  scene_boost: "这是中段提气口播，语气比普通串联更有推进感，但不要喊。",
  music_news: "这是音乐信息口播，语气像分享一条有用的音乐博客内容，信息说清楚。",
});

export function hostTtsPersona(profileId: HostProfileId): string {
  return HOST_TTS_PERSONAS[profileId] ?? HOST_TTS_PERSONAS[DEFAULT_HOST_PROFILE];
}

export function hostTtsInstruction(profileId: HostProfileId, moment?: HostTtsMoment, deliveryInstruction?: string): string {
  return [
    hostTtsPersona(profileId),
    moment ? HOST_TTS_MOMENTS[moment] : "",
    deliveryInstruction?.trim() ?? "",
  ].filter(Boolean).join(" ");
}

export function hostPreviewText(profileId: HostProfileId): string {
  return `欢迎收听 Open Music Radio 电台，我是主持人${HOST_PROFILES[profileId].name}。`;
}

export const HOST_DURATION_REACHED_TEXT = "本档节目设定的时间到了，听完这首歌，我们就结束今天的节目。";

export function hostDurationReachedCueUrl(profileId: HostProfileId): string {
  const resolvedProfileId = HOST_PROFILES[profileId] ? profileId : DEFAULT_HOST_PROFILE;
  return `/hosts/cues/duration-reached/${resolvedProfileId}.mp3`;
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
  britpop: { id: "britpop", label: "英伦", searchTerm: "英伦 Britpop British Rock" },
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
