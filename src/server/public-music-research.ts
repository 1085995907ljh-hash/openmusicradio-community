import { createHash } from "node:crypto";
import { musicResearchTrackKey, requireCompletedMusicResearch, type MusicResearchTrack, type MusicResearchReport, type MusicResearchReceipt, type MusicResearchAttempt } from "../shared/music-research.js";

export type PublicMusicResearchTrack = MusicResearchTrack;
export type { ResearchedMusicFact as PublicMusicResearchFact } from "../shared/music-research.js";

interface WikimediaPage {
  pageid?: number;
  title?: string;
  extract?: string;
  fullurl?: string;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_CONCURRENCY = 6;
const MAX_EXTRACT_LENGTH = 500;
const CACHE_TTL_MS = 30 * 60_000;
const MAX_CACHE_ENTRIES = 256;

interface ResearchOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/** Keep successful per-song work when a later song or the writer fails. */
export class MusicResearchService {
  private readonly cache = new Map<string, { savedAt: number; receipt: MusicResearchReceipt }>();

  constructor(private readonly options: Omit<ResearchOptions, "signal"> = {}) {}

  async research(tracks: readonly MusicResearchTrack[], options: { signal?: AbortSignal } = {}): Promise<MusicResearchReport> {
    options.signal?.throwIfAborted();
    const rows = await mapWithConcurrency(tracks, MAX_CONCURRENCY, async (track) => {
      options.signal?.throwIfAborted();
      const key = musicResearchTrackKey(track);
      const cached = this.cache.get(key);
      if (cached && Date.now() - cached.savedAt < CACHE_TTL_MS) return structuredClone(cached.receipt);
      const receipt = await researchTrack(track, { ...this.options, signal: options.signal });
      options.signal?.throwIfAborted();
      if (receipt.status !== "failed") {
        this.cache.delete(key);
        this.cache.set(key, { savedAt: Date.now(), receipt: structuredClone(receipt) });
        while (this.cache.size > MAX_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
      }
      return receipt;
    });
    options.signal?.throwIfAborted();
    return { tracks: rows };
  }
}

export async function researchPublicMusicReport(tracks: readonly MusicResearchTrack[], options: ResearchOptions = {}): Promise<MusicResearchReport> {
  return new MusicResearchService(options).research(tracks, options);
}

/** Legacy fact-list API fails closed; production consumes the receipts above. */
export async function researchPublicMusicFacts(tracks: readonly MusicResearchTrack[], options: ResearchOptions = {}) {
  const report = requireCompletedMusicResearch(await researchPublicMusicReport(tracks, options), tracks);
  return report.tracks.flatMap((receipt) => receipt.facts);
}

async function researchTrack(track: MusicResearchTrack, options: ResearchOptions): Promise<MusicResearchReceipt> {
  const key = musicResearchTrackKey(track);
  const receipt: MusicResearchReceipt = { trackKey: key, status: "failed", completedAt: new Date().toISOString(), attempts: [], facts: [] };
  const title = track.title.trim();
  const artist = track.artist.trim();
  if (!title || !artist) return receipt;

  const quote = (text: string) => '"' + text.replace(/["\\]/g, " ") + '"';
  const album = track.album?.trim();
  const queries = [...new Set([
    `${quote(title)} ${quote(artist)}`,
    ...(album && album !== title && !/^(?:未知(?:专辑)?|unknown(?: album)?|n\/?a|null|-)$/i.test(album) ? [`${quote(album)} ${quote(artist)}`] : []),
    quote(artist),
  ])];
  const language = containsHan(`${title}${artist}`) ? "zh" : "en";
  for (const query of queries) {
    options.signal?.throwIfAborted();
    const attempt: MusicResearchAttempt = { query, status: "failed", sourceUrls: [] };
    receipt.attempts.push(attempt);
    const pages = await searchPages(query, language, options);
    if (pages === null) break;
    attempt.status = "completed";
    attempt.sourceUrls = pages.flatMap((page) => typeof page?.fullurl === "string" && page.fullurl.startsWith("https://") ? [page.fullurl] : []);
    const useful = pages.filter((page) => isUsefulPage(page, artist) && pageMatchesMusicSubject(page.title, track)).slice(0, 2);
    const facts = useful.map((page) => ({
      id: `web:wiki_${createHash("sha256").update(key + "\n" + page.fullurl).digest("hex").slice(0, 20)}`,
      // Preserve what the retrieved page actually describes. Matching to the
      // selected song uses its receipt, not an invented song label in this text.
      value: `资料页面《${page.title ?? artist}》：${cleanExtract(page.extract!)}`,
      sourceUrl: page.fullurl!,
    }));
    // A song page may contain only release metadata. Complete the album and
    // artist queries too, retaining their actual subjects and source URLs.
    for (const fact of facts) {
      if (!receipt.facts.some((existing) => existing.sourceUrl === fact.sourceUrl)) receipt.facts.push(fact);
    }
  }
  receipt.completedAt = new Date().toISOString();
  if (receipt.attempts.every((attempt) => attempt.status === "completed")) {
    receipt.status = receipt.facts.length > 0 ? "researched" : "no_results";
  }
  return receipt;
}

/** Each query has two bounded attempts. An API error is never an empty result. */
async function searchPages(query: string, language: string, options: ResearchOptions): Promise<WikimediaPage[] | null> {
  const url = new URL(`https://${language}.wikipedia.org/w/api.php`);
  url.search = new URLSearchParams({
    action: "query", generator: "search", gsrsearch: query, gsrlimit: "2",
    prop: "extracts|info", exintro: "1", explaintext: "1", inprop: "url",
    format: "json", formatversion: "2", origin: "*",
  }).toString();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    options.signal?.throwIfAborted();
    const controller = new AbortController();
    const abortFromParent = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abortFromParent, { once: true });
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const response = await (options.fetchImpl ?? globalThis.fetch)(url, {
        signal: controller.signal,
        headers: { "user-agent": "OneRadio/0.1 (music radio research)" },
      });
      if (!response.ok) throw new Error("research HTTP failure");
      const payload = await response.json() as { error?: unknown; batchcomplete?: boolean; query?: { pages?: WikimediaPage[] } };
      if (!payload || payload.error || (payload.query !== undefined && !Array.isArray(payload.query?.pages))
        || (payload.query === undefined && payload.batchcomplete !== true)) throw new Error("invalid research response");
      return payload.query?.pages ?? [];
    } catch {
      options.signal?.throwIfAborted();
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abortFromParent);
    }
  }
  return null;
}

function isUsefulPage(page: WikimediaPage, artist: string): page is Required<Pick<WikimediaPage, "pageid" | "extract" | "fullurl">> & WikimediaPage {
  if (!page || typeof page !== "object") return false;
  const pageText = `${page.title ?? ""} ${page.extract ?? ""}`;
  return Number.isInteger(page.pageid)
    && typeof page.extract === "string"
    && cleanExtract(page.extract).length >= 40
    && typeof page.fullurl === "string"
    && page.fullurl.startsWith("https://")
    && !/消歧义|消歧義|disambiguation|可以指|可指[：:]|may refer to|can refer to/i.test(pageText)
    && artistAppearsInPage(pageText, artist);
}

function cleanExtract(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_EXTRACT_LENGTH);
}

function pageMatchesMusicSubject(pageTitle: string | undefined, track: MusicResearchTrack): boolean {
  if (!pageTitle) return false;
  // Strip music disambiguators only. A same-named film mentioning the artist
  // is not evidence about the song, even when it ranks highly in search.
  const title = pageTitle.replace(/\s*[（(]([^()（）]+)[）)]$/, (suffix, qualifier: string) =>
    /(?:\bsong\b|\balbum\b|\bsingle\b|\bmusician\b|\bsinger\b|\bband\b|\brapper\b|歌曲|專輯|专辑|歌手|樂團|乐队)/i.test(qualifier) ? "" : suffix);
  return [track.title, track.artist, track.album].some((subject) => subject && normalizeForMatch(subject) === normalizeForMatch(title));
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

async function mapWithConcurrency<T, R>(values: readonly T[], concurrency: number, worker: (value: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await worker(values[index]!, index);
    }
  }));
  return results;
}
