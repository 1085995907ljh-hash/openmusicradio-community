export interface PublicMusicResearchTrack {
  title: string;
  artist: string;
  exploration?: boolean;
}

export interface PublicMusicResearchFact {
  id: string;
  value: string;
  sourceUrl: string;
}

interface WikimediaPage {
  pageid?: number;
  title?: string;
  extract?: string;
  fullurl?: string;
}

interface WikimediaPayload {
  query?: { pages?: WikimediaPage[] };
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TRACKS = 12;
const MAX_CONCURRENCY = 6;
const MAX_EXTRACT_LENGTH = 420;

export async function researchPublicMusicFacts(
  tracks: readonly PublicMusicResearchTrack[],
  options: { signal?: AbortSignal; fetchImpl?: typeof globalThis.fetch; timeoutMs?: number } = {},
): Promise<PublicMusicResearchFact[]> {
  const selected = tracks.slice(0, MAX_TRACKS);
  if (selected.length === 0 || options.signal?.aborted) return [];

  const controller = new AbortController();
  const abortFromParent = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error("public music research timed out")), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const rows = await mapWithConcurrency(selected, MAX_CONCURRENCY, (track, trackIndex) =>
      researchTrack(track, trackIndex, options.fetchImpl ?? globalThis.fetch, controller.signal),
    );
    const seen = new Set<string>();
    return rows.flat().filter((fact) => {
      const key = `${fact.sourceUrl}\n${fact.value}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromParent);
  }
}

async function researchTrack(
  track: PublicMusicResearchTrack,
  trackIndex: number,
  fetchImpl: typeof globalThis.fetch,
  signal: AbortSignal,
): Promise<PublicMusicResearchFact[]> {
  const title = String(track.title ?? "").trim().slice(0, 100);
  const artist = String(track.artist ?? "").trim().slice(0, 100);
  if (!title || !artist || signal.aborted) return [];

  const language = containsHan(`${title}${artist}`) ? "zh" : "en";
  const url = new URL(`https://${language}.wikipedia.org/w/api.php`);
  url.search = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrsearch: `"${title.replace(/["\\]/g, " ")}" "${artist.replace(/["\\]/g, " ")}"`,
    gsrlimit: track.exploration ? "2" : "1",
    prop: "extracts|info",
    exintro: "1",
    explaintext: "1",
    inprop: "url",
    format: "json",
    formatversion: "2",
    origin: "*",
  }).toString();

  try {
    const response = await fetchImpl(url, {
      signal,
      headers: { "user-agent": "OneRadio/0.1 (local music radio research)" },
    });
    if (!response.ok) return [];
    const payload = await response.json() as WikimediaPayload;
    return (payload.query?.pages ?? [])
      .filter((page) => isUsefulPage(page, artist))
      .slice(0, track.exploration ? 2 : 1)
      .map((page) => ({
        id: `web:wiki_${trackIndex + 1}_${page.pageid}`,
        value: `《${title}》/ ${artist} 公开资料：${cleanExtract(page.extract!)}`,
        sourceUrl: page.fullurl!,
      }));
  } catch {
    return [];
  }
}

function isUsefulPage(page: WikimediaPage, artist: string): page is Required<Pick<WikimediaPage, "pageid" | "extract" | "fullurl">> & WikimediaPage {
  const pageText = `${page.title ?? ""} ${page.extract ?? ""}`;
  return Number.isInteger(page.pageid)
    && typeof page.extract === "string"
    && cleanExtract(page.extract).length >= 40
    && typeof page.fullurl === "string"
    && page.fullurl.startsWith("https://")
    && !String(page.title ?? "").includes("消歧义")
    && artistAppearsInPage(pageText, artist);
}

function cleanExtract(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_EXTRACT_LENGTH);
}

function containsHan(value: string): boolean {
  return /[\u3400-\u9fff]/.test(value);
}

function normalizeForMatch(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, "");
}

function artistAppearsInPage(pageText: string, artist: string): boolean {
  if (containsHan(artist)) return normalizeForMatch(pageText).includes(normalizeForMatch(artist));
  const words = artist.normalize("NFKC").trim().split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length === 0) return false;
  const phrase = words.map(escapeRegex).join("[^A-Za-z0-9]+");
  return new RegExp(`(^|[^A-Za-z0-9])${phrase}($|[^A-Za-z0-9])`, "i").test(pageText);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(values[index]!, index);
    }
  }));
  return results;
}
