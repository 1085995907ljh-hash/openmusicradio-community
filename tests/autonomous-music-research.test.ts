import test from "node:test";
import assert from "node:assert/strict";
import { AutonomousMusicResearchService, type ResearchCompletion } from "../src/server/autonomous-music-research.js";
import { PublicMusicWebAccess, extractWebPage, isPublicAddress, parseSearchResults, publicWebUrl, searchExa, type MusicWebAccess } from "../src/server/music-web-access.js";
import { musicResearchFactText, requireCompletedMusicResearch } from "../src/shared/music-research.js";

const track = { title: "三人游", artist: "方大同", album: "橙月" };
const url = "https://music.example.com/interview";
const quote = "这张专辑以日落时分为创作概念，使用温暖的音色来呈现完整的音乐主题。";
const finish = { action: "finish", reason: "已从原文核实专辑理念，可以自然介绍当前歌曲的专辑背景", facts: [{ subject: "album", claim: `方大同的《橙月》${quote}`, url, quote }] };
const page = { url, title: "方大同专辑访谈", text: quote.repeat(4), links: [], via: "direct" as const };
const web: MusicWebAccess = { search: async () => [{ title: page.title, url, snippet: "搜索摘要不能证明任何事实" }], read: async () => page };
const completeActions = (actions: unknown[]): ResearchCompletion => async () => JSON.stringify(actions.shift());

test("autonomous research reads a non-Wiki source and preserves subject plus original evidence", async () => {
  const service = new AutonomousMusicResearchService(web);
  const report = await service.research([track], { complete: completeActions([{ action: "search", query: "方大同 橙月 创作理念 访谈", scope: "album" }, { action: "read", url }, finish]) });
  const receipt = requireCompletedMusicResearch(report, [track]).tracks[0]!;
  assert.equal(receipt.status, "researched");
  assert.equal(receipt.facts[0]?.subject, "album");
  assert.equal(receipt.facts[0]?.evidenceQuote, quote);
  assert.equal(receipt.facts[0]?.sourceUrl, url);
  assert.match(musicResearchFactText(receipt.facts[0]!), /事实主体：专辑.*\n.*\n原文证据/);
  assert.deepEqual(receipt.steps?.map((step) => step.action), ["search", "search", "read"]);
});

test("search snippets and invented quotations cannot be promoted into facts", async () => {
  for (const actions of [[finish, finish, finish], [{ action: "read", url }, ...Array(3).fill({ ...finish, facts: [{ ...finish.facts[0], quote: "不存在的原文证据，这首歌获得过某个奖项。" }] })]]) {
    const report = await new AutonomousMusicResearchService(web).research([track], { complete: completeActions(actions) });
    assert.equal(report.tracks[0]?.status, "failed");
    assert.deepEqual(report.tracks[0]?.facts, []);
    assert.throws(() => requireCompletedMusicResearch(report, [track]));
  }
});

test("the researcher can follow article links and continue reading beyond the first text page", async () => {
  const original = "https://label.example.com/original";
  const text = "资料段落。".repeat(2400) + quote;
  const report = await new AutonomousMusicResearchService({ ...web, read: async (requested) => requested === url ? { ...page, links: [{ title: "原始访谈", url: original }] } : { ...page, url: original, text } }).research([track], { complete: completeActions([
    { action: "read", url }, { action: "read", url: original }, { action: "read", url: original, offset: 12000 },
    { ...finish, facts: [{ ...finish.facts[0], url: original }] },
  ]) });
  assert.equal(report.tracks[0]?.status, "researched");
  assert.equal(report.tracks[0]?.facts[0]?.sourceUrl, original);
});

test("one unsupported candidate does not discard other facts with verified original evidence", async () => {
  const report = await new AutonomousMusicResearchService(web).research([track], { complete: completeActions([
    { action: "read", url },
    { ...finish, facts: [{ ...finish.facts[0], quote: "原文里不存在的获奖经历不能进入口播。" }, ...finish.facts] },
  ]) });
  const receipt = requireCompletedMusicResearch(report, [track]).tracks[0]!;
  assert.equal(receipt.facts.length, 1);
  assert.equal(receipt.facts[0]?.evidenceQuote, quote);
  assert.match(receipt.completionReason!, /剔除 1 条/);
});

test("empty research requires actual album and artist searches, and failures are never no-results", async () => {
  const empty = { action: "finish", reason: "歌曲、专辑、歌手查询都没有匹配结果", facts: [] };
  const report = await new AutonomousMusicResearchService({ ...web, search: async () => [] }).research([track], { complete: completeActions([
    empty, { action: "search", query: "方大同 橙月", scope: "album" }, { action: "search", query: "方大同", scope: "artist" }, empty,
  ]) });
  assert.equal(requireCompletedMusicResearch(report, [track]).tracks[0]?.status, "no_results");
  const failed = await new AutonomousMusicResearchService({ ...web, read: async () => { throw new Error("HTTP 403"); } }).research([track], { complete: completeActions([
    { action: "read", url }, { action: "search", query: "方大同 橙月", scope: "album" }, { action: "search", query: "方大同", scope: "artist" }, empty, { action: "blocked", reason: "原文访问失败" },
  ]) });
  assert.equal(failed.tracks[0]?.status, "failed");
  assert.ok(failed.tracks[0]?.steps?.some((step) => step.status === "failed"));
});

test("an unavailable source can be replaced by another source with genuine evidence", async () => {
  const blocked = "https://blocked.example.com/interview";
  const report = await new AutonomousMusicResearchService({ ...web, search: async () => [{ title: "blocked", url: blocked, snippet: "" }, { title: page.title, url, snippet: "" }], read: async (requested) => { if (requested === blocked) throw new Error("HTTP 403"); return page; } }).research([track], { complete: completeActions([{ action: "read", url: blocked }, { action: "read", url }, finish]) });
  assert.equal(requireCompletedMusicResearch(report, [track]).tracks[0]?.status, "researched");
  assert.equal(report.tracks[0]?.steps?.filter((step) => step.status === "failed").length, 1);
});

test("all songs are researched beyond twelve and successful receipts are isolated cached copies", async () => {
  let searches = 0;
  const service = new AutonomousMusicResearchService({ ...web, search: async (...args) => { searches++; return web.search(...args); } });
  const tracks = Array.from({ length: 15 }, (_, index) => ({ ...track, title: `歌曲${index}` }));
  const complete: ResearchCompletion = async (_system, user) => JSON.stringify(JSON.parse(user).history.some((step: { action: string }) => step.action === "read") ? finish : { action: "read", url });
  const report = requireCompletedMusicResearch(await service.research(tracks, { complete }), tracks);
  assert.equal(searches, 15);
  assert.equal(report.tracks.length, 15);
  report.tracks[0]!.facts.length = 0;
  assert.equal((await service.research(tracks, { complete })).tracks[0]?.facts.length, 1);
  assert.equal(searches, 15);
});

test("cancellation and repeated unavailable search channels stop work without fabricated success", async () => {
  const controller = new AbortController();
  const service = new AutonomousMusicResearchService({ ...web, search: async () => { controller.abort(); throw new Error("cancelled"); } });
  await assert.rejects(service.research([track], { signal: controller.signal, complete: async () => { throw new Error("must not run"); } }));
  let calls = 0;
  const failed = await new AutonomousMusicResearchService({ ...web, search: async () => { throw new Error("all engines offline"); } }).research([track], { complete: async () => JSON.stringify({ action: "search", query: `新词${++calls}`, scope: "artist" }) });
  assert.equal(failed.tracks[0]?.status, "failed");
  assert.ok(calls <= 5);
});

test("search adapters extract actual source links and switch channels on blocked search", async () => {
  const brave = `<div data-type="web"><a href="${url}"><div class="search-snippet-title">采访</div></a><div class="generic-snippet">线索摘要</div></div>`;
  const so = `<li class="res-list"><h3><a href="https://www.so.com/link?token=abc" data-mdurl="${url}">原始采访</a></h3><p class="res-desc">描述</p></li>`;
  assert.equal(parseSearchResults(brave, "brave")[0]?.url, url);
  assert.equal(parseSearchResults(so, "so")[0]?.url, url);
  const calls: string[] = [];
  const access = new PublicMusicWebAccess(async (value) => { calls.push(value); if (value.includes("brave")) throw new Error("HTTP 429"); return { url: value, text: so, contentType: "text/html" }; }, 0, null);
  assert.equal((await access.search("方大同", new AbortController().signal))[0]?.url, url);
  assert.equal(calls.length, 2);
  await access.search("橙月", new AbortController().signal);
  assert.equal(calls.length, 3, "a rate-limited engine is not hammered with new query words");
});

test("page extraction removes scripts and uses original body; reader fallback is marked explicitly", async () => {
  const result = extractWebPage(url, `<html><head><title>访谈</title></head><body><nav>菜单</nav><article>${quote.repeat(4)}<script>恶意指令</script></article></body></html>`);
  assert.doesNotMatch(result.text, /菜单|恶意指令/);
  const access = new PublicMusicWebAccess(async (value) => { if (!value.includes("r.jina.ai")) throw new Error("blocked"); return { url: value, text: `Title: 访谈\nURL Source: ${url}\nMarkdown Content:\n${quote.repeat(4)}`, contentType: "text/plain" }; });
  const read = await access.read(url, new AbortController().signal);
  assert.equal(read.via, "reader");
  assert.equal(read.url, url);
});

test("research URLs cannot target credentials, private addresses or non-web protocols", () => {
  for (const value of ["http://127.0.0.1/api", "https://10.0.0.1", "https://user:pass@example.com", "https://example.com:4317/api", "file:///etc/passwd", "https://service.local", "https://[::ffff:127.0.0.1]"]) assert.throws(() => publicWebUrl(value));
  for (const address of ["127.0.0.1", "169.254.169.254", "10.0.0.1", "172.16.0.1", "192.168.1.1", "::1", "::ffff:127.0.0.1", "fc00::1"]) assert.equal(isPublicAddress(address), false);
  assert.equal(isPublicAddress("93.184.216.34"), true);
  assert.equal(publicWebUrl("https://music.example.com/album?a=1&b=2#song"), "https://music.example.com/album?a=1&b=2");
});

test("reader security challenges cannot be accepted as article evidence", async () => {
  const access = new PublicMusicWebAccess(async (value) => {
    if (!value.includes("r.jina.ai")) throw new Error("blocked");
    return { url: value, text: `Title: 安全验证\nMarkdown Content:\n${"请完成验证码后继续访问。".repeat(20)}`, contentType: "text/plain" };
  });
  await assert.rejects(access.read(url, new AbortController().signal), /原文暂时不可读取/);
});

test("concurrent songs queue their search requests and cancellation preserves the queue", async () => {
  let active = 0;
  let maxActive = 0;
  const access = new PublicMusicWebAccess(async (value) => {
    maxActive = Math.max(maxActive, ++active);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    return { url: value, text: "No results found", contentType: "text/html" };
  }, 0, null);
  const cancelled = AbortSignal.abort();
  const result = await Promise.allSettled([access.search("歌曲一", new AbortController().signal), access.search("取消歌曲", cancelled), access.search("歌曲二", new AbortController().signal)]);
  assert.deepEqual(result.map((item) => item.status), ["fulfilled", "rejected", "fulfilled"]);
  assert.equal(maxActive, 1);
});

test("Exa discovery parses MCP events and fails over without treating service errors as no results", async () => {
  const envelope = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: `Title: 专辑访谈\nURL: ${url}\nHighlights:\n只作为搜索线索` }] } };
  const results = await searchExa("方大同", new AbortController().signal, async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    assert.equal(request.params.name, "web_search_exa");
    assert.ok(request.params.arguments.objective);
    return new Response(`event: message\ndata: ${JSON.stringify(envelope)}\n\n`, { headers: { "content-type": "text/event-stream" } });
  });
  assert.deepEqual(results, [{ title: "专辑访谈", url, snippet: "只作为搜索线索" }]);
  await assert.rejects(searchExa("方大同", new AbortController().signal, async () => new Response(JSON.stringify({ id: 1, result: { isError: true } }), { headers: { "content-type": "application/json" } })));
  const access = new PublicMusicWebAccess(async (value) => ({ url: value, text: `<div data-type="web"><a href="${url}"><div class="search-snippet-title">采访</div></a></div>`, contentType: "text/html" }), 0, async () => { throw new Error("Exa rate limited"); });
  assert.equal((await access.search("方大同", new AbortController().signal))[0]?.url, url);
});
