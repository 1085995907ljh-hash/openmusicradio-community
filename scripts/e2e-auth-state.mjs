import { chromium } from "playwright";

const APP_URL = "http://127.0.0.1:5173/?skipIntro=1";
const now = new Date().toISOString();
const readyAiConfig = {
  llm: { provider: "openai", model: "gpt-5.6-sol", hasKey: true },
  tts: { provider: "qwen", model: "cosyvoice-v2", voice: "longanxuan", hasKey: true },
};
const readyAccess = {
  configured: true,
  connected: true,
  state: "connected",
  user: { id: "visual-user", displayName: "Visual User" },
  device: { id: "visual-device", name: "Visual Device" },
  service: { llmModel: "gpt-5.5", ttsModel: "cosyvoice-v2", managed: true },
};
const viewports = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
];

const browser = await chromium.launch({ channel: "chrome", headless: true });

for (const viewport of viewports) {
  const context = await browser.newContext({ viewport, locale: "zh-CN" });
  const page = await context.newPage();
  let releaseCreate;
  let markCreateStarted;
  const createStarted = new Promise((resolve) => { markCreateStarted = resolve; });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (path === "/api/health") return json({ ok: true, providers: { host: { configured: true, state: "ready" }, tts: { configured: true, state: "ready" } } });
    if (path === "/api/ai/config") return json({ config: readyAiConfig });
    if (path === "/api/access/status") return json({ access: readyAccess });
    if (path === "/api/sources") return json({ sources: [
      { sourceId: "qq_music", label: "QQ 音乐", playbackReady: false, hostedProgramAllowed: false, accountConnected: false, state: "blocked", checkedAt: now },
      { sourceId: "netease_music", label: "网易云音乐", playbackReady: true, hostedProgramAllowed: true, accountConnected: true, state: "ready", checkedAt: now },
    ] });
    if (path === "/api/netease/status") return json({ status: { configured: true, state: "ready", authenticated: true, persistentLogin: true } });
    if (path.startsWith("/api/players/")) return json({ player: { sourceId: path.includes("qq_music") ? "qq_music" : "netease_music", state: "app_not_running", ok: false, appRunning: false, playing: false } });
    if (path === "/api/program" && request.method() === "GET") return json({ program: null });
    if (path === "/api/programs" && request.method() === "POST") {
      markCreateStarted();
      await new Promise((resolve) => { releaseCreate = resolve; });
      return json({ error: "test request released" }, 503);
    }
    return json({ error: `unhandled ${request.method()} ${path}` }, 404);
  });

  await page.goto(APP_URL, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /网易云音乐/ }).first().click();
  await page.getByText("网易云音乐已连接", { exact: true }).waitFor();
  await page.getByRole("button", { name: "进入节目设置" }).click();

  const viewPlan = page.getByRole("button", { name: "查看计划" });
  if (!(await viewPlan.isEnabled())) throw new Error(`${viewport.name}: persisted login did not enable planning`);
  await viewPlan.click();
  await createStarted;
  await page.getByRole("heading", { name: "正在生成节目计划" }).waitFor();
  if (await page.getByText("请先在本网页扫码连接网易云账号。", { exact: true }).count()) {
    throw new Error(`${viewport.name}: planning falsely reported that the persisted account was logged out`);
  }

  releaseCreate();
  await page.getByRole("button", { name: "查看计划" }).waitFor();
  await context.close();
}

await browser.close();
console.log("persisted NetEase auth UI passed at desktop and mobile widths");
