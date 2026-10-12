import { chromium } from "playwright";

const APP_URL = process.env.APP_URL ?? "http://127.0.0.1:5173/?skipIntro=1";
const now = new Date().toISOString();
const track = {
  id: "preparing-track",
  title: "微光慢行",
  artist: "测试歌手",
  durationSeconds: 1_800,
  energy: 0.42,
  mood: ["放松"],
  color: "#5f806b",
  sourceId: "netease_music",
  reasons: ["符合放松氛围"],
  hostMoment: "opening",
  hostScript: { id: "host-script", text: "欢迎来到 ONE RADIO，让这一段音乐慢慢铺开。", factIds: [], instruction: "放松", hostMoment: "opening", generatedAt: now },
};
const draft = {
  id: "preparing-program",
  generation: 1,
  status: "awaiting_confirmation",
  spec: { sourceId: "netease_music", durationMinutes: 30, scenePreset: "late_night", sceneDescription: "放松", hostDensity: "low", energyCurve: "舒缓", avoid: [], familiarityRatio: 40, hostProfile: "anya", musicGenres: ["rnb_soul"] },
  startedAt: null,
  deadlineAt: null,
  remainingSeconds: 1_800,
  currentTrack: null,
  nextTrack: null,
  queue: [],
  host: null,
  recentHostLines: [],
  error: null,
  listenerProfile: { favoriteArtists: [{ name: "测试歌手", score: 10 }], topSongs: [{ title: "微光慢行", artists: ["测试歌手"] }], playlistNames: ["放松收藏"], inferredThemes: ["放松舒缓"], evidence: ["1 首喜欢的歌曲"] },
  planSummary: { totalTracks: 1, familiarTracks: 1, likedTracks: 1, heardTracks: 1, unheardTracks: 0, targetFamiliarityRatio: 40, actualFamiliarityRatio: 100 },
  planRevision: 1,
  rundownIndex: 0,
  rundown: [track],
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
for (const [name, viewport] of [["desktop", { width: 1440, height: 1000 }], ["mobile", { width: 390, height: 844 }]]) {
  console.log(`checking preparation ${name}`);
  const page = await browser.newPage({ viewport, locale: "zh-CN" });
  await page.addInitScript(() => window.localStorage.setItem("openmusicradio.onboarding-complete.v1", "true"));
  let pendingConfirmRoute;
  let progressPolls = 0;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/health") return json({ ok: true, providers: { host: { configured: true, state: "ready" }, tts: { configured: true, state: "ready" } } });
    if (path === "/api/access/status") return json({ access: { configured: true, connected: true, state: "connected", user: { id: "visual-user", displayName: "视觉测试" }, device: { id: "visual-device", name: "Playwright" }, service: { llmModel: "deepseek-flash", ttsModel: "qwen3-tts-flash", managed: true } } });
    if (path === "/api/sources") return json({ sources: [{ sourceId: "netease_music", label: "网易云音乐", playbackReady: true, hostedProgramAllowed: true, accountConnected: true, state: "ready", checkedAt: now }] });
    if (path === "/api/netease/status") return json({ status: { configured: true, state: "ready", authenticated: true } });
    if (path === "/api/ai/config") return json({ config: { llm: { provider: "openai", model: "gpt", hasKey: true }, tts: { provider: "qwen", model: "cosyvoice-v2", voice: "longanya", hasKey: true } } });
    if (path === "/api/program" || path === `/api/programs/${draft.id}`) return json({ program: draft });
    if (path === "/api/programs/progress") {
      progressPolls += 1;
      return json({ progress: { completedSteps: Math.min(2, progressPolls), status: "running", updatedAt: new Date().toISOString() } });
    }
    if (path === `/api/programs/${draft.id}/confirm`) { pendingConfirmRoute = route; return; }
    if (path === "/api/programs/cancel-generation") {
      if (pendingConfirmRoute) await pendingConfirmRoute.fulfill({ status: 499, contentType: "application/json", body: JSON.stringify({ error: "cancelled" }) });
      return json({ cancelled: true, program: draft });
    }
    if (path.startsWith("/api/players/")) return json({ player: { sourceId: "netease_music", state: "ready", ok: true, appRunning: true, playing: false } });
    return json({ error: `unhandled ${request.method()} ${path}` }, 404);
  });
  await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
  const confirm = page.getByRole("button", { name: "确认并生成" });
  await confirm.waitFor();
  if (!(await confirm.isEnabled())) throw new Error(`${name}: locked draft cannot enter preparation`);
  await confirm.click();
  await page.getByRole("button", { name: "不保存，播完删除" }).click();
  await page.getByRole("heading", { name: "正在完成开播准备" }).waitFor();
  await page.waitForFunction(() => document.querySelector(".generation-progress")?.getAttribute("aria-valuenow") === "50");
  if (await page.locator(".generation-progress li.done").count() !== 2) throw new Error(`${name}: preparation does not expose completed backend stages`);
  const progress = page.getByRole("progressbar", { name: "开播准备进度" });
  if (await progress.getAttribute("aria-valuenow") !== "50") throw new Error(`${name}: incorrect accessible progress`);
  if (await page.locator(".generation-note, .process-orbit").count()) throw new Error(`${name}: old loading decorations remain`);
  const wave = await page.locator(".generation-sculpture").evaluate(node => ({
    width: node.getBoundingClientRect().width,
    animated: getComputedStyle(node.querySelector(".generation-trace")).animationName !== "none",
  }));
  if (Math.abs(wave.width - viewport.width) > 1 || !wave.animated) throw new Error(`${name}: full-width wave is missing or static`);
  if (!(await page.getByText("正在合成语音并准备播放队列", { exact: true }).isVisible())) throw new Error(`${name}: current loading information is not prominent`);
  if (await page.getByText("创建本次平台歌单", { exact: true }).count()) throw new Error(`${name}: preparation implies the playlist will always be saved`);
  for (const label of ["核对最终节目单", "准备主持内容", "合成语音并准备播放队列", "校验首曲并开始播放"]) {
    if (await page.locator(".generation-step-label").filter({ hasText: label }).count() !== 1) throw new Error(`${name}: preparation step is missing: ${label}`);
  }
  if (await page.locator(".topbar").count() !== 1) throw new Error(`${name}: preparation is missing the product top bar`);
  if (await page.locator(".top-stage-nav").count() !== 1) throw new Error(`${name}: preparation is missing workflow navigation`);
  const activeStage = page.locator(".top-stage-active");
  if (await activeStage.getByText("确认计划", { exact: true }).count() !== 1) throw new Error(`${name}: confirmation stage is not active during preparation`);
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error(`${name}: preparation page overflows horizontally`);
  await page.screenshot({ path: `/tmp/one-radio-preparing-${name}.png`, fullPage: true });
  await page.getByRole("button", { name: "取消生成，返回歌单" }).click();
  await page.getByRole("heading", { name: "请确认你的歌单", exact: true }).waitFor();
  if (!(await confirm.isEnabled())) throw new Error(`${name}: cancelled draft cannot retry`);
  await page.close();
}
await browser.close();
console.log("preparation visual checks passed");
