export interface MusicSearchAdjustment {
  query: string;
  count: number;
}

export interface RundownAdjustmentTrack {
  id: string;
  title: string;
  artist: string;
  album?: string | null;
  mood: string[];
  liked: boolean;
}

export interface RundownAdjustmentConversationMessage {
  role: "user" | "assistant";
  text: string;
}

export interface RundownReplacementCriteria {
  language?: "english";
  genre?: string;
  artist?: string;
}

export type RundownAdjustmentIntent =
  | {
      decision: "execute";
      action: "replace";
      selection: "specified_tracks" | "automatic";
      count: number;
      trackIds: string[];
      criteria: RundownReplacementCriteria;
      message: string;
    }
  | {
      decision: "execute";
      action: "reorder";
      trackIds: string[];
      message: string;
    }
  | {
      decision: "clarify" | "unsupported";
      message: string;
    };

export function parseMusicSearchAdjustment(instruction: string): MusicSearchAdjustment | null {
  const normalized = instruction.trim().replace(/\s+/g, " ");
  if (!normalized || !/(?:找|搜索|想听|加入|加进|加上|加|来|放)(?:一下|点|一些|几首|一首)?/.test(normalized)) return null;
  const match = normalized.match(/(?:找|搜索|想听|加入|加进|加上|加|来|放)(?:一下|点)?(?:一些|几首|一首)?\s*([^，。！？]{1,40}?)(?:的)?(?:歌|歌曲|音乐)(?:[，。！？]|$)/);
  const query = match?.[1]?.trim().replace(/^(?:一下|点|一些|几首|一首)\s*/, "").replace(/的$/, "") ?? "";
  if (!query) return null;
  const count = /一首/.test(normalized) ? 1 : /几首|一些|多首/.test(normalized) ? 3 : 2;
  return { query, count };
}
