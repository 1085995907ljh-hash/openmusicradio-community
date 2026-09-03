export interface MusicSearchAdjustment {
  query: string;
  count: number;
}

export function parseMusicSearchAdjustment(instruction: string): MusicSearchAdjustment | null {
  const normalized = instruction.trim().replace(/\s+/g, " ");
  if (!normalized || !/(?:找|搜索|想听|加入|加进|加上|加|来|放)(?:一下|点|一些|几首|一首)?/.test(normalized)) return null;
  const match = normalized.match(/(?:找|搜索|想听|加入|加进|加上|加|来|放)(?:一下|点)?(?:一些|几首|一首)?\s*([^，。！？]{1,40}?)(?:的)?(?:歌|歌曲|音乐)(?:[，。！？]|$)/);
  const query = match?.[1]?.trim().replace(/^(?:一下|点|一些|几首|一首)\s*/, "").replace(/的$/, "") ?? "";
  if (!query) return null;
  const count = /一首/.test(normalized) ? 1 : /几首|一些|多首/.test(normalized) ? 3 : 2;
  return { query, count };
}
