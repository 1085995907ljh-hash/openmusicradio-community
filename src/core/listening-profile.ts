export interface ListeningProfileSong {
  id: string;
  title: string;
  artists: string[];
  tags?: string[];
}

export interface ListeningProfileInput {
  likedSongs: readonly ListeningProfileSong[];
  recentSongs: readonly ListeningProfileSong[];
  historySongs: readonly ListeningProfileSong[];
  playlistSongs?: readonly ListeningProfileSong[];
  playlists: readonly string[];
}

export interface ListeningProfile {
  topSongs: ListeningProfileSong[];
  playlistNames: string[];
  inferredThemes: string[];
  styleTags: string[];
  styleAffinities: ListeningProfileStyleAffinity[];
  taggedSongs: Array<ListeningProfileSong & { tags: string[]; sources: string[] }>;
  evidence: string[];
}

export interface ListeningProfileStyleAffinity {
  style: string;
  score: number;
  artists: Array<{ name: string; score: number; songs: string[] }>;
  familiarSongs: Array<{ id: string; title: string; artists: string[]; sources: string[] }>;
  evidence: string[];
}

const THEME_RULES: ReadonlyArray<readonly [string, string, RegExp]> = [
  ["放松舒缓", "chill", /深夜|夜猫|放松|舒缓|late.?night|night|ambient|sleep|relax|chill/i],
  ["专注陪伴", "focus", /学习|专注|study|focus|工作|work|lofi|轻音乐/i],
  ["运动节奏", "workout", /运动|健身|跑步|workout|run|gym|edm|training/i],
  ["律动流行", "groove", /通勤|驾车|律动|commute|drive|groove|pop|流行/i],
  ["聚会高能", "party", /派对|聚会|party|dance|电音|edm|hip.?hop/i],
];

const STYLE_RULES: ReadonlyArray<readonly [string, RegExp]> = [
  ["pop", /流行|pop|华语|k-?pop|j-?pop|city.?pop|城市流行|独立流行/i],
  ["rock", /摇滚|rock|indie rock|alternative/i],
  ["folk", /民谣|folk|acoustic/i],
  ["electronic", /电子|电音|electronic|edm|techno|house|trance|synth/i],
  ["dance", /舞曲|dance|club|派对|dj|迪斯科|disco/i],
  ["hiphop", /说唱|嘻哈|hip.?hop|rap|trap/i],
  ["easy_listening", /轻音乐|easy.?listening|lo-?fi|lofi|低保真|纯音乐|instrumental|piano/i],
  ["jazz", /爵士|jazz|swing|bebop/i],
  ["country", /乡村|country/i],
  ["rnb_soul", /r&b|rnb(?:_soul)?|节奏布鲁斯|灵魂|soul|neo.?soul|放克|funk/i],
  ["classical", /古典|classical|piano|orchestra/i],
  ["ethnic", /民族|中国传统|民族音乐|ethnic|蒙古|藏族|彝族|陕北民歌/i],
  ["britpop", /英伦|britpop|uk indie/i],
  ["metal", /金属|metal/i],
  ["punk", /朋克|punk/i],
  ["blues", /蓝调|布鲁斯|blues/i],
  ["reggae", /雷鬼|reggae/i],
  ["world", /世界音乐|world music|加勒比|印度|巴西|泰国/i],
  ["latin", /拉丁|latin|salsa/i],
  ["new_age", /new.?age|新世纪|氛围|ambient|drone|冥想|禅修/i],
  ["gufeng", /古风|国风|中国风|gufeng/i],
  ["post_rock", /后摇|post.?rock/i],
  ["bossa_nova", /bossa.?nova|巴萨诺瓦/i],
];
const STYLE_TAGS = new Set(STYLE_RULES.map(([tag]) => tag));
const SOURCE_WEIGHTS: Readonly<Record<string, number>> = {
  liked: 8,
  history: 5,
  playlist: 3,
  recent: 2,
};

export function buildListeningProfile(input: ListeningProfileInput): ListeningProfile {
  const uniqueSongs = new Map<string, ListeningProfileSong>();
  const tagged = new Map<string, ListeningProfileSong & { tags: string[]; sources: string[] }>();
  const playlistSongs = input.playlistSongs ?? [];
  const addSong = (song: ListeningProfileSong, source: string): void => {
    if (!song.id || !song.title) return;
    const clean = {
      id: song.id,
      title: song.title,
      artists: [...song.artists].filter(Boolean),
      ...(song.tags?.length ? { tags: [...song.tags].filter(Boolean) } : {}),
    };
    uniqueSongs.set(song.id, clean);
    const tags = inferSongTags(clean);
    if (tags.length === 0) return;
    const previous = tagged.get(song.id);
    if (previous) {
      previous.tags = [...new Set([...previous.tags, ...tags])];
      previous.sources = [...new Set([...previous.sources, source])];
      return;
    }
    tagged.set(song.id, { ...clean, tags, sources: [source] });
  };
  for (const song of input.likedSongs) addSong(song, "liked");
  for (const song of input.recentSongs) addSong(song, "recent");
  for (const song of input.historySongs) addSong(song, "history");
  for (const song of playlistSongs) addSong(song, "playlist");
  const topSongs = [...uniqueSongs.values()].slice(0, 20);
  const searchable = input.playlists.join(" ");
  const inferredThemes = THEME_RULES.filter(([, , rule]) => rule.test(searchable)).map(([theme]) => theme);
  const styleTags = [...new Set([
    ...THEME_RULES.filter(([, , rule]) => rule.test(searchable)).map(([, tag]) => tag),
    ...STYLE_RULES.filter(([, rule]) => rule.test(searchable)).map(([tag]) => tag),
    ...[...tagged.values()].flatMap((song) => song.tags),
  ])];
  const styleAffinities = buildStyleAffinities([...tagged.values()]);
  const evidence = [
    `${input.likedSongs.length} 首喜欢的歌曲`,
    `${input.recentSongs.length} 首最近播放`,
    `${input.historySongs.length} 条听歌记录`,
    `${playlistSongs.length} 首歌单歌曲`,
    `${input.playlists.length} 个歌单名称`,
    `${[...tagged.values()].length} 首歌曲带有可用风格标签`,
  ];
  return {
    topSongs,
    playlistNames: [...input.playlists].slice(0, 20),
    inferredThemes,
    styleTags,
    styleAffinities,
    taggedSongs: [...tagged.values()].slice(0, 80).map((song) => ({ ...song, tags: [...song.tags], sources: [...song.sources] })),
    evidence,
  };
}

export function inferSongTags(song: ListeningProfileSong): string[] {
  const searchable = (song.tags ?? []).join(" ");
  return [...new Set([
    ...THEME_RULES.filter(([, , rule]) => rule.test(searchable)).map(([, tag]) => tag),
    ...STYLE_RULES.filter(([, rule]) => rule.test(searchable)).map(([tag]) => tag),
  ])];
}

function buildStyleAffinities(taggedSongs: Array<ListeningProfileSong & { tags: string[]; sources: string[] }>): ListeningProfileStyleAffinity[] {
  const byStyle = new Map<string, {
    score: number;
    artists: Map<string, { name: string; score: number; songs: Set<string> }>;
    songs: Map<string, { song: ListeningProfileSong & { sources: string[] }; score: number }>;
  }>();
  for (const song of taggedSongs) {
    const sourceScore = Math.max(1, song.sources.reduce((total, source) => total + (SOURCE_WEIGHTS[source] ?? 1), 0));
    for (const style of song.tags) {
      if (!STYLE_TAGS.has(style)) continue;
      const bucket = byStyle.get(style) ?? { score: 0, artists: new Map(), songs: new Map() };
      bucket.score += sourceScore;
      const previousSong = bucket.songs.get(song.id);
      bucket.songs.set(song.id, { song: { ...song, sources: [...song.sources] }, score: Math.max(previousSong?.score ?? 0, sourceScore) });
      for (const artist of song.artists) {
        const cleanArtist = artist.trim();
        if (!cleanArtist) continue;
        const current = bucket.artists.get(cleanArtist) ?? { name: cleanArtist, score: 0, songs: new Set<string>() };
        current.score += sourceScore;
        current.songs.add(song.title);
        bucket.artists.set(cleanArtist, current);
      }
      byStyle.set(style, bucket);
    }
  }
  return [...byStyle.entries()]
    .map(([style, bucket]) => ({
      style,
      score: bucket.score,
      artists: [...bucket.artists.values()]
        .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
        .slice(0, 6)
        .map((artist) => ({ name: artist.name, score: artist.score, songs: [...artist.songs].slice(0, 4) })),
      familiarSongs: [...bucket.songs.values()]
        .sort((left, right) => right.score - left.score || left.song.title.localeCompare(right.song.title))
        .slice(0, 8)
        .map(({ song }) => ({ id: song.id, title: song.title, artists: [...song.artists], sources: [...song.sources] })),
      evidence: [`${bucket.songs.size} 首熟悉歌曲`, `${bucket.artists.size} 位相关艺术家`],
    }))
    .sort((left, right) => right.score - left.score || left.style.localeCompare(right.style));
}
