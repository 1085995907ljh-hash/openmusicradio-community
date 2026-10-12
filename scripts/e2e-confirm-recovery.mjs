import { chromium } from "playwright";

const APP_URL = "http://127.0.0.1:5173/?skipIntro=1";
const now = new Date().toISOString();
const readyAiConfig = {
  llm: { provider: "openai", model: "gpt-5.6-sol", hasKey: true },
  tts: { provider: "qwen", model: "cosyvoice-v2", voice: "longanxuan", hasKey: true },
};
let stopped = false;

const draft = {
  id: "e2e-locked-draft",
  generation: 1,
  status: "awaiting_confirmation",
  spec: {
    sourceId: "netease_music",
    durationMinutes: 30,
    scenePreset: "late_night",
    sceneDescription: "安静陪伴",
    hostDensity: "low",
    energyCurve: "低到轻柔提升",
    avoid: [],
    familiarityRatio: 20,
  },
  startedAt: null,
  deadlineAt: null,
  remainingSeconds: 1800,
  currentTrack: null,
  nextTrack: null,
  queue: [],
  host: null,
  recentHostLines: [],
  error: null,
  listenerProfile: {
    favoriteArtists: [{ name: "测试艺术家", score: 10 }],
    topSongs: [{ title: "测试歌曲", artists: ["测试艺术家"] }],
    playlistNames: ["测试歌单"],
    inferredThemes: ["深夜陪伴"],
    evidence: ["1 首喜欢的歌曲"],
  },
  planSummary: {
    totalTracks: 1,
    familiarTracks: 0,
    likedTracks: 0,
    heardTracks: 0,
    unheardTracks: 1,
    targetFamiliarityRatio: 20,
    actualFamiliarityRatio: 0,
  },
  rundownIndex: 0,
  rundown: [{
    id: "test-track",
    title: "测试歌曲",
    artist: "测试艺术家",
    durationSeconds: 1800,
    energy: 0.5,
    mood: ["late_night"],
    color: "#5f806b",
    sourceId: "netease_music",
    album: null,
    popularity: null,
    reasons: ["场景匹配"],
    liked: false,
    heard: false,
    hostMoment: "opening",
    hostScript: {
      id: "locked-script",
      text: "夜色慢下来，测试艺术家的《测试歌曲》，一起听。",
      factIds: ["host-script:test-track:1"],
      instruction: "locked",
      hostMoment: "opening",
      generatedAt: now,
    },
  }],
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "zh-CN" });
const page = await context.newPage();

await page.route("**/api/**", async (route) => {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  if (path === "/api/health") return json({ ok: true, providers: { host: { configured: true, state: "failed_technical" }, tts: { configured: true, state: "ready" } } });
  if (path === "/api/ai/config") return json({ config: readyAiConfig });
  if (path === "/api/sources") return json({ sources: [
    { sourceId: "qq_music", label: "QQ 音乐", playbackReady: false, hostedProgramAllowed: false, accountConnected: false, state: "blocked", checkedAt: now },
    { sourceId: "netease_music", label: "网易云音乐", playbackReady: true, hostedProgramAllowed: true, accountConnected: true, state: "ready", checkedAt: now },
  ] });
  if (path === "/api/netease/status") return json({ status: { configured: true, state: "ready", authenticated: true } });
  if (path.startsWith("/api/players/")) return json({ player: { sourceId: path.includes("qq_music") ? "qq_music" : "netease_music", state: "app_not_running", ok: false, appRunning: false, playing: false } });
  if (path === "/api/program" && request.method() === "GET") return json({ program: stopped ? null : draft });
  if (path === `/api/programs/${draft.id}` && request.method() === "GET") return json({ program: stopped ? { ...draft, status: "stopped" } : draft });
  if (path === `/api/programs/${draft.id}/stop` && request.method() === "POST") {
    stopped = true;
    return json({ error: "response lost" }, 503);
  }
  return json({ error: `unhandled ${request.method()} ${path}` }, 404);
});

await page.goto(APP_URL, { waitUntil: "networkidle" });
const confirm = page.getByRole("button", { name: "确认并启动" });
await confirm.waitFor();
if (!(await confirm.isEnabled())) throw new Error("Locked NetEase draft cannot be confirmed while the live host provider is offline");
await page.getByRole("button", { name: "退出节目" }).first().click();
await page.getByRole("heading", { name: "初始化这台本机电台。" }).waitFor();
if (!stopped) throw new Error("Exit recovery did not issue the stop request");

await browser.close();
console.log("locked-host-offline and lost-exit-response recovery passed");
