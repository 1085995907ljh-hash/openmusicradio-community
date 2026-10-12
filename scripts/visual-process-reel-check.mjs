import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const appUrl = process.env.APP_URL ?? "http://127.0.0.1:5173";
const outputDir = "test-results";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
const page = await context.newPage();

const fulfill = (route, body) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
await page.route("**/api/program", (route) => fulfill(route, { program: null }));
await page.route("**/api/health", (route) => fulfill(route, { ok: true, providers: { host: { configured: true, state: "ready" }, tts: { configured: true, state: "ready" } } }));
await page.route("**/api/sources", (route) => fulfill(route, { sources: [
  { sourceId: "qq_music", label: "QQ 音乐", playbackReady: true, hostedProgramAllowed: true, state: "ready", detail: "ready", checkedAt: new Date().toISOString() },
  { sourceId: "netease_music", label: "网易云音乐", playbackReady: true, hostedProgramAllowed: true, state: "ready", detail: "ready", checkedAt: new Date().toISOString() },
] }));
await page.route("**/api/qq/status", (route) => fulfill(route, { status: { configured: true, state: "ready", authenticated: true } }));
await page.route("**/api/netease/status", (route) => fulfill(route, { status: { configured: true, state: "ready", authenticated: true } }));
await page.route("**/api/ai/config", (route) => fulfill(route, { config: {
  llm: { provider: "openai", model: "gpt-5.6-sol", hasKey: true },
  tts: { provider: "qwen", model: "cosyvoice-v2", voice: "longanxuan", hasKey: true },
} }));
await page.route("**/api/programs/progress?*", (route) => fulfill(route, { progress: { completedSteps: 3, status: "running", updatedAt: new Date().toISOString() } }));
await page.route("**/api/programs", () => new Promise(() => {}));

try {
  await mkdir(outputDir, { recursive: true });
  await page.goto(`${appUrl}/?skipIntro=1`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "进入节目设置" }).click();
  await page.getByRole("button", { name: "查看计划" }).click();
  const progress = page.getByRole("progressbar");
  await progress.waitFor();
  await page.waitForFunction(() => document.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow") === "75");

  const firstTransform = await page.locator(".process-cassette-reel").evaluate((element) => getComputedStyle(element).transform);
  await page.waitForTimeout(420);
  const secondTransform = await page.locator(".process-cassette-reel").evaluate((element) => getComputedStyle(element).transform);
  if (firstTransform === secondTransform) throw new Error("cassette reel did not rotate between animation frames");
  if (await progress.getAttribute("aria-valuenow") !== "75") throw new Error("visual motion changed the real progress value");

  const desktopWidth = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
  if (desktopWidth.document > desktopWidth.viewport) throw new Error(`desktop process view overflows: ${JSON.stringify(desktopWidth)}`);
  await page.screenshot({ path: `${outputDir}/desktop-process-cassette-reel.png`, fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileWidth = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
  if (mobileWidth.document > mobileWidth.viewport) throw new Error(`mobile process view overflows: ${JSON.stringify(mobileWidth)}`);
  await page.screenshot({ path: `${outputDir}/mobile-process-cassette-reel.png`, fullPage: true });

  process.stdout.write(`${JSON.stringify({ ok: true, progress: 75, rotating: true, desktopWidth, mobileWidth }, null, 2)}\n`);
} finally {
  await browser.close();
}
