import { lookup } from "node:dns";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";
import { parseHTML } from "linkedom";
import { setTimeout as delay } from "node:timers/promises";

export interface WebSearchResult { title: string; url: string; snippet: string }
export interface WebPage { url: string; title: string; text: string; links: Array<{ title: string; url: string }>; via: "direct" | "reader" }
export interface MusicWebAccess {
  search(query: string, signal: AbortSignal): Promise<WebSearchResult[]>;
  read(url: string, signal: AbortSignal): Promise<WebPage>;
}
export type PublicGet = (url: string, signal: AbortSignal) => Promise<{ url: string; text: string; contentType: string }>;
export type SearchDiscovery = (query: string, signal: AbortSignal) => Promise<WebSearchResult[]>;

/** Exa's hosted MCP supports anonymous discovery; an optional key raises its service quota. */
export async function searchExa(query: string, signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<WebSearchResult[]> {
  const response = await fetchImpl("https://mcp.exa.ai/mcp", {
    method: "POST", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(process.env.EXA_API_KEY ? { "x-api-key": process.env.EXA_API_KEY } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "web_search_exa", arguments: { query, objective: "为音乐电台寻找可核验的歌曲创作背景、对应专辑理念和风格、音乐人背景。优先官方资料、原始访谈、可信媒体和音乐平台专辑介绍，排除歌词全文、粉丝评论和无来源解读。" } } }),
  });
  if (!response.ok) throw new Error(`Exa 搜索失败 HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Exa 搜索没有返回正文");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > 3 * 1024 * 1024) { await reader.cancel(); throw new Error("Exa 搜索响应过大"); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const text = Buffer.concat(chunks).toString("utf8");
  const messages = response.headers.get("content-type")?.includes("text/event-stream")
    ? text.split(/\r?\n\r?\n/).flatMap((event) => { const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n"); return data ? [JSON.parse(data)] : []; })
    : [JSON.parse(text)];
  const message = messages.find((item) => item.id === 1);
  if (!message?.result || message.error || message.result.isError) throw new Error("Exa 搜索暂时不可用或已限流");
  const content = (message.result.content ?? []).filter((item: { type: string }) => item.type === "text").map((item: { text: string }) => item.text).join("\n");
  const results = content.split(/\n---\n/).flatMap((part: string) => {
    const title = /^Title:\s*(.+)$/m.exec(part)?.[1];
    const url = /^URL:\s*(https?:\/\/\S+)$/m.exec(part)?.[1];
    return title && url ? safeLink(url, title, "https://exa.ai").map((link) => ({ ...link, snippet: (part.split(/Highlights:\s*\n/)[1] ?? "").slice(0, 1200) })) : [];
  });
  if (!results.length && !/no (?:search )?results (?:found|returned)/i.test(content)) throw new Error("Exa 搜索未返回可识别的来源记录");
  return results;
}

const privateV4 = new BlockList();
for (const [address, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16], ["192.0.0.0", 24], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) privateV4.addSubnet(address, prefix);
const publicV6 = new BlockList();
publicV6.addSubnet("2000::", 3, "ipv6");

export function isPublicAddress(address: string): boolean {
  return isIP(address) === 4 ? !privateV4.check(address) : isIP(address) === 6 && publicV6.check(address, "ipv6");
}

export function publicWebUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol === "http:") url.protocol = "https:";
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")
    || !hostname.includes(".") || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(hostname)
    || (isIP(hostname) && !isPublicAddress(hostname))) throw new Error("只能读取公开网页");
  url.hash = "";
  return url.toString();
}

/** Validate the addresses in the actual socket lookup, including every redirect. */
export async function getPublicPage(value: string, signal: AbortSignal): Promise<{ url: string; text: string; contentType: string }> {
  let url = publicWebUrl(value);
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const result = await new Promise<{ location?: string; text: string; contentType: string }>((resolve, reject) => {
      const req = httpsRequest(url, {
        signal: boundedSignal,
        headers: { "user-agent": "Mozilla/5.0 (compatible; OpenMusicRadio/0.1)", accept: "text/html,application/xhtml+xml,text/plain;q=0.9", "accept-encoding": "identity" },
        lookup(hostname, options, callback) {
          lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
            if (error) return callback(error, [], 4);
            if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) return callback(new Error("网页指向非公开地址"), [], 4);
            if (options.all) callback(null, addresses);
            else callback(null, addresses[0]!.address, addresses[0]!.family);
          });
        },
      }, (response) => {
        if ((response.statusCode ?? 0) >= 300 && (response.statusCode ?? 0) < 400 && response.headers.location) {
          response.resume();
          resolve({ location: response.headers.location, text: "", contentType: "" });
          return;
        }
        if (response.statusCode !== 200) { response.resume(); reject(new Error(`网页访问失败 HTTP ${response.statusCode}`)); return; }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 3 * 1024 * 1024) { response.destroy(new Error("网页响应过大")); return; }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          try {
            let buffer = Buffer.concat(chunks);
            const encoding = response.headers["content-encoding"];
            const options = { maxOutputLength: 6 * 1024 * 1024 };
            if (encoding === "gzip") buffer = gunzipSync(buffer, options);
            else if (encoding === "deflate") buffer = inflateSync(buffer, options);
            else if (encoding === "br") buffer = brotliDecompressSync(buffer, options);
            const contentType = response.headers["content-type"] ?? "";
            if (!/text\/|application\/(?:xhtml\+xml|xml|json)/i.test(contentType)) throw new Error("当前来源不是可读取的网页正文");
            const charset = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1]
              ?? /charset\s*=\s*["']?([\w-]+)/i.exec(buffer.subarray(0, 4096).toString())?.[1] ?? "utf-8";
            resolve({ text: new TextDecoder(charset).decode(buffer), contentType });
          } catch (error) { reject(error); }
        });
      });
      req.on("error", reject);
      req.end();
    });
    if (!result.location) return { ...result, url };
    url = publicWebUrl(new URL(result.location, url).toString());
  }
  throw new Error("网页重定向过多");
}

export class PublicMusicWebAccess implements MusicWebAccess {
  private readonly cooldowns = new Map<string, number>();
  private searchQueue: Promise<unknown> = Promise.resolve();
  private nextSearchAt = 0;
  constructor(private readonly get: PublicGet = getPublicPage, private readonly searchSpacingMs = 1200, private readonly semanticSearch: SearchDiscovery | null = searchExa) {}

  async search(query: string, signal: AbortSignal): Promise<WebSearchResult[]> {
    if (!query.trim()) throw new Error("搜索词不能为空");
    const run = this.searchQueue.catch(() => {}).then(async () => {
      signal.throwIfAborted();
      const wait = this.nextSearchAt - Date.now();
      if (wait > 0) await delay(wait, undefined, { signal });
      try { return await this.searchChannels(query, signal); }
      finally { this.nextSearchAt = Date.now() + this.searchSpacingMs; }
    });
    this.searchQueue = run.catch(() => {});
    return run;
  }

  private async searchChannels(query: string, signal: AbortSignal): Promise<WebSearchResult[]> {
    const failures: string[] = [];
    // Search engines discover sources; their snippets are never evidence.
    for (const engine of ["exa", "brave", "so", "duckduckgo"] as const) {
      signal.throwIfAborted();
      if (engine === "exa" && !this.semanticSearch) continue;
      if ((this.cooldowns.get(engine) ?? 0) > Date.now()) { failures.push(`${engine}: 暂时限流或不可用`); continue; }
      try {
        if (engine === "exa") return await this.semanticSearch!(query, signal);
        const url = engine === "brave" ? `https://search.brave.com/search?q=${encodeURIComponent(query)}` : engine === "so" ? `https://www.so.com/s?q=${encodeURIComponent(query)}` : `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const response = await this.get(url, signal);
        const results = parseSearchResults(response.text, engine);
        if (results.length > 0) return results;
        if (/No results found|No results were found|No results\.|找不到任何结果|没有找到相关结果/i.test(response.text)) return [];
        failures.push(`${engine}: 未取得搜索结果页面`);
        this.cooldowns.set(engine, Date.now() + 60_000);
      } catch (error) { signal.throwIfAborted(); failures.push(`${engine}: ${error instanceof Error ? error.message : "访问失败"}`); this.cooldowns.set(engine, Date.now() + 60_000); }
    }
    throw new Error(`搜索服务未返回可验证的结果，不能当作没有资料（${failures.join("；")}）`);
  }

  async read(value: string, signal: AbortSignal): Promise<WebPage> {
    const url = publicWebUrl(value);
    try {
      const response = await this.get(url, signal);
      return extractWebPage(response.url, response.text);
    } catch { signal.throwIfAborted(); }
    // Web Access's reader channel helps with script-heavy or blocked pages.
    const response = await this.get(`https://r.jina.ai/${url}`, signal);
    const body = response.text.split("Markdown Content:")[1]?.trim();
    if (!body || body.length < 100 || /Warning: Target URL returned error|SecurityCompromiseError|verify you are human|captcha challenge|Title:.*(?:安全验证|安全驗證|访问验证|验证码|登录|登入|Access Denied)/i.test(response.text)) throw new Error("原文暂时不可读取，请换来源或继续搜索");
    const links = [...body.matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g)].flatMap((match) => safeLink(match[2]!, match[1]!, url));
    return { url, title: /^Title:\s*(.+)$/m.exec(response.text)?.[1] ?? url, text: body, links, via: "reader" };
  }
}

function safeLink(value: string, title: string, base: string): Array<{ title: string; url: string }> {
  try { return [{ title: title.trim().slice(0, 200), url: publicWebUrl(new URL(value, base).toString()) }]; } catch { return []; }
}

export function parseSearchResults(html: string, engine: "brave" | "duckduckgo" | "so"): WebSearchResult[] {
  const { document } = parseHTML(html);
  const containers = document.querySelectorAll(engine === "brave" ? '[data-type="web"]' : engine === "so" ? "li.res-list" : ".result");
  const results: WebSearchResult[] = [];
  for (const container of containers) {
    const anchor = container.querySelector(engine === "brave" ? "a[href]" : engine === "so" ? "h3 a[href]" : "a.result__a");
    if (!anchor) continue;
    let href = anchor.getAttribute("data-mdurl") ?? anchor.getAttribute("href") ?? "";
    if (engine === "duckduckgo") href = new URL(href, "https://duckduckgo.com").searchParams.get("uddg") ?? href;
    const title = container.querySelector(engine === "brave" ? ".search-snippet-title" : engine === "so" ? "h3" : ".result__a")?.textContent ?? anchor.textContent ?? "";
    for (const link of safeLink(href, title, "https://search.brave.com")) {
      if (results.some((item) => item.url === link.url)) continue;
      results.push({ ...link, snippet: (container.querySelector(engine === "brave" ? ".generic-snippet" : engine === "so" ? ".res-desc,.res-list-summary" : ".result__snippet")?.textContent ?? "").trim().slice(0, 1200) });
    }
  }
  return results;
}

export function extractWebPage(url: string, html: string): WebPage {
  const { document } = parseHTML(html);
  const title = document.title;
  document.querySelectorAll("script,style,noscript,svg,nav,footer,header,form,iframe").forEach((node) => node.remove());
  const root = document.querySelector("article") ?? document.querySelector("main") ?? document.body;
  const text = (root?.textContent ?? "").replace(/\s+/g, " ").trim();
  if (text.length < 100 || /^(?:Just a moment|Access Denied)|verify you are human|enable javascript and cookies to continue|captcha challenge|^(?:安全验证|安全驗證|访问验证|验证码|登录|登入)/i.test(title + " " + text.slice(0, 600))) throw new Error("网页正文不可用");
  const links = [...(root?.querySelectorAll("a[href]") ?? [])].flatMap((anchor) => safeLink(anchor.getAttribute("href")!, anchor.textContent ?? "", url));
  return { url, title, text, links, via: "direct" };
}
