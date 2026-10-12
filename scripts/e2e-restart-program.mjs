import { chromium } from "playwright";

const APP_URL = `${process.env.APP_URL ?? "http://127.0.0.1:5173"}/?skipIntro=1`;
const now = new Date().toISOString();
const readyAiConfig = {
  llm: { provider: "openai", model: "gpt-5.6-sol", hasKey: true },
  tts: { provider: "qwen", model: "cosyvoice-v2", voice: "longanxuan", hasKey: true },
};


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
try {
  for (const scenario of ["success", "lost-response", "control-lost", "control-lost-race", "failure", "recommendation-ready", "recommendation-failed", "recommendation-missing", "recommendation-empty", "recommendation-researching", "regeneration"]) {
    let stopped = false;
    let recommendationStatus = scenario === "recommendation-failed" ? "failed" : scenario === "recommendation-missing" ? undefined : scenario === "recommendation-empty" ? "ready" : scenario === "recommendation-researching" ? "researching" : scenario === "recommendation-ready" ? "writing" : "ready";
    let emptyCopy = scenario === "recommendation-empty";
    const currentDraft = () => ({ ...draft, ...(recommendationStatus ? { playlistRecommendation: { status: recommendationStatus, ...(recommendationStatus === "ready" ? { text: emptyCopy ? "  " : "这份歌单的推荐语已经准备好了。", sources: [] } : {}) } } : {}) });
    let stopRequests = 0;
    const mutations = [];
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.addInitScript(() => {
      localStorage.setItem("openmusicradio.onboarding-complete.v1", "true");
      localStorage.setItem("openmusicradio.program-defaults.v1", JSON.stringify({ sourceId: "netease_music" }));
    });
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      if (request.method() !== "GET") mutations.push(path);
      if (path === "/api/health") return json({ ok: true, providers: { host: { configured: true, state: "ready" }, tts: { configured: true, state: "ready" } } });
      if (path === "/api/access/status") return json({ access: { connected: true, configured: true, state: "connected", user: { id: "restart-user", displayName: "保留的用户" }, device: { id: "restart-device", name: "浏览器" } } });
      if (path === "/api/ai/config") return json({ config: readyAiConfig });
      if (path === "/api/sources") return json({ sources: [{ sourceId: "netease_music", label: "网易云音乐", accountConnected: true, playbackReady: true, hostedProgramAllowed: true, state: "ready", checkedAt: now }] });
      if (path === "/api/netease/status") return json({ status: { configured: true, state: "ready", authenticated: true } });
      if (path === "/api/program") return json({ program: stopped ? null : currentDraft() });
      if (path === `/api/programs/${draft.id}`) return json({ program: stopped ? { ...draft, status: scenario.startsWith("control-lost") ? "control_lost" : "stopped" } : currentDraft() });
      if (path === `/api/programs/${draft.id}/regenerate`) {
        recommendationStatus = "writing";
        return json({ program: currentDraft() });
      }
      if (path === `/api/programs/${draft.id}/stop`) {
        stopRequests++;
        const payload = request.postDataJSON();
        if (payload.generation !== draft.generation || !payload.operationId) throw new Error("Missing cancellation identity");
        stopped = scenario !== "failure";
        if (scenario === "control-lost-race") return json({ error: "Program is already in a terminal state", code: "PROGRAM_TERMINAL" }, 409);
        if (scenario === "control-lost") return json({ program: { ...draft, status: "control_lost" } });
        return !["lost-response", "failure"].includes(scenario) ? json({ program: { ...draft, status: "stopped" } }) : json({ error: "取消请求未收到确认" }, 503);
      }
      return json({});
    });
    await page.goto(APP_URL);
    if (scenario.startsWith("recommendation-")) {
      await page.locator(".generation-room[data-complete=false]").waitFor();
      await page.locator(".generation-status").filter({ hasText: "撰写歌单推荐语" }).waitFor();
      if (await page.locator(".confirm-view").count()) throw new Error("Confirmation must stay hidden until recommendation text is ready");
      await page.reload();
      await page.locator(".generation-room[data-complete=false]").waitFor();
      if (await page.locator(".confirm-view").count()) throw new Error("Reload must preserve the recommendation gate");
      emptyCopy = false;
      recommendationStatus = "ready";
    }
    await page.locator(".confirm-view").waitFor();
    await page.getByRole("heading", { name: "请确认你的歌单", exact: true }).waitFor();
    if (await page.locator(".confirm-topbar .workflow-heading-step, .confirm-topbar .workflow-heading-description").count()) throw new Error("Removed confirmation captions remain");
    if (recommendationStatus === "ready") await page.getByText("这份歌单的推荐语已经准备好了。", { exact: true }).waitFor();
    if (scenario === "regeneration") {
      await page.getByRole("button", { name: "重新推荐", exact: true }).click();
      await page.locator(".generation-room[data-complete=false]").waitFor();
      if (await page.locator(".confirm-view").count()) throw new Error("Regenerated playlist appeared before its new introduction");
      recommendationStatus = "ready";
      await page.locator(".confirm-view").waitFor();
      await page.getByText("这份歌单的推荐语已经准备好了。", { exact: true }).waitFor();
    }
    if (await page.locator(".playlist-recommendation").getByRole("button", { name: "更换主持人", exact: true }).count()) throw new Error("Confirmation must not allow host changes");
    const storageBefore = await page.evaluate(() => localStorage.getItem("openmusicradio.onboarding-complete.v1"));
    await page.getByRole("button", { name: "回首页", exact: true }).click();
    if (scenario === "failure") {
      await page.getByText("取消请求未收到确认", { exact: true }).waitFor();
      if (!(await page.locator(".confirm-view").isVisible())) throw new Error("Failed cancellation discarded the draft");
      if (!(await page.getByRole("button", { name: "回首页", exact: true }).isEnabled())) throw new Error("Cannot retry cancellation");
    } else {
      await page.getByRole("heading", { name: "选择电台主持人", exact: true }).waitFor();
      if (await page.locator(".setup-program-step-host .workflow-heading-step").count()) throw new Error("Host step still shows the removed caption");
      await page.getByRole("button", { name: "确定主持人，继续" }).click();
      await page.getByRole("heading", { name: "设置你的节目", exact: true }).waitFor();
      await page.getByRole("button", { name: "回首页", exact: true }).click();
      await page.getByRole("heading", { name: "选择电台主持人", exact: true }).waitFor();
      if (await page.locator(".confirm-view").count()) throw new Error("Old plan remains visible");
      if (await page.evaluate(() => localStorage.getItem("openmusicradio.onboarding-complete.v1")) !== storageBefore) throw new Error("Onboarding state was reset");
      await page.reload();
      await page.getByRole("heading", { name: "选择电台主持人", exact: true }).waitFor();
    }
    if (stopRequests !== 1) throw new Error("Expected one cancellation");
    if (mutations.some((path) => /logout|disconnect|revoke|verify/.test(path))) throw new Error("Account connection was modified");
    console.log(`restart from home: ${scenario} passed`);
    await page.close();
  }
} finally {
  await browser.close();
}
