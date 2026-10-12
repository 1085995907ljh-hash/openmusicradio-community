import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const APP_URL = process.env.APP_URL ?? "http://127.0.0.1:5173";
const PAGE_URL = `${APP_URL}/?skipIntro=1`;
const API_URL = `${APP_URL}/api`;
const OUTPUT_DIR = "test-results";
const READY_AI_CONFIG = {
  llm: { provider: "openai", model: "gpt-5.6-sol", hasKey: true },
  tts: { provider: "qwen", model: "cosyvoice-v2", voice: "longanxuan", hasKey: true },
};
const READY_ACCESS = {
  configured: true,
  connected: true,
  state: "connected",
  user: { id: "e2e-user", displayName: "测试成员" },
  device: { id: "e2e-device", name: "测试 Mac" },
  service: { llmModel: "gpt-5.6-sol", ttsModel: "cosyvoice-v2", managed: true },
};
const TEST_QR_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
function makeTestWav() {
  const sampleRate = 8_000;
  const seconds = 1;
  const dataSize = sampleRate * 2 * seconds;
  const output = Buffer.alloc(44 + dataSize);
  output.write("RIFF", 0, "ascii");
  output.writeUInt32LE(36 + dataSize, 4);
  output.write("WAVE", 8, "ascii");
  output.write("fmt ", 12, "ascii");
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write("data", 36, "ascii");
  output.writeUInt32LE(dataSize, 40);
  return output;
}

async function stopActiveProgram() {
  const response = await fetch(`${API_URL}/program`).catch(() => null);
  if (!response?.ok || !response.headers.get("content-type")?.includes("application/json")) return;
  const body = await response.json();
  const program = body.program ?? body;
  if (!program?.id || !["draft", "awaiting_confirmation", "preparing", "on_air", "closing"].includes(program.status)) return;
  await fetch(`${API_URL}/programs/${program.id}/stop`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operationId: `e2e-reset-${Date.now()}` }),
  });
}

async function assertNoHorizontalOverflow(page, label) {
  const result = await page.evaluate(() => ({
    viewport: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }));
  if (result.documentWidth > result.viewport || result.bodyWidth > result.viewport) {
    throw new Error(`${label} overflows horizontally: ${JSON.stringify(result)}`);
  }
  return result;
}

async function assertFitsViewport(page, label) {
  const result = await page.evaluate(() => ({
    viewport: window.innerHeight,
    documentHeight: document.documentElement.scrollHeight,
    bodyHeight: document.body.scrollHeight,
  }));
  if (result.documentHeight > result.viewport + 1 || result.bodyHeight > result.viewport + 1) {
    throw new Error(`${label} requires vertical scrolling: ${JSON.stringify(result)}`);
  }
  return result;
}

async function assertElementInsideViewport(page, selector, label) {
  const result = await page.locator(selector).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, viewport: window.innerHeight };
  });
  if (result.top < 0 || result.bottom > result.viewport) {
    throw new Error(`${label} is clipped outside the viewport: ${JSON.stringify(result)}`);
  }
  return result;
}

async function assertElementContentFits(page, selector, label) {
  const result = await page.locator(selector).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      clientWidth: element.clientWidth,
      clientHeight: element.clientHeight,
      scrollWidth: element.scrollWidth,
      scrollHeight: element.scrollHeight,
      children: Array.from(element.children).map((child) => {
        const childRect = child.getBoundingClientRect();
        return { className: child.className, top: Math.round(childRect.top - rect.top), bottom: Math.round(childRect.bottom - rect.top), height: Math.round(childRect.height) };
      }),
    };
  });
  if (result.scrollWidth > result.clientWidth + 1 || result.scrollHeight > result.clientHeight + 1) {
    throw new Error(`${label} clips its contents: ${JSON.stringify(result)}`);
  }
  return result;
}

async function assertProgramControlsStack(page, label) {
  const result = await page.locator(".program-control-grid").evaluate((grid) => {
    const selectors = [".control-duration", ".control-host-settings", ".control-recommendation-mode", ".control-genres, .control-scene", ".control-familiarity"];
    const gridRect = grid.getBoundingClientRect();
    const groups = selectors.map((selector) => {
      const element = grid.querySelector(selector);
      const rect = element?.getBoundingClientRect();
      return rect ? { selector, top: rect.top, bottom: rect.bottom, width: rect.width } : null;
    });
    return { gridWidth: gridRect.width, groups };
  });
  if (result.groups.some((group) => !group)) throw new Error(`${label} is missing a program control group: ${JSON.stringify(result)}`);
  if (result.groups.some((group) => group.width / result.gridWidth < 0.96)) {
    throw new Error(`${label} squeezes a program control group into a partial row: ${JSON.stringify(result)}`);
  }
  for (let index = 1; index < result.groups.length; index += 1) {
    if (result.groups[index].top < result.groups[index - 1].bottom - 1) {
      throw new Error(`${label} program control groups overlap or are out of order: ${JSON.stringify(result)}`);
    }
  }
  return result;
}

async function assertProductShellAlignment(page, label) {
  const result = await page.evaluate(() => {
    const topbar = document.querySelector(".topbar");
    const main = document.querySelector(".main-content");
    if (!topbar || !main) return null;
    const topbarRect = topbar.getBoundingClientRect();
    const mainRect = main.getBoundingClientRect();
    const topbarStyle = getComputedStyle(topbar);
    const mainStyle = getComputedStyle(main);
    return {
      topbarLeft: topbarRect.left + Number.parseFloat(topbarStyle.paddingLeft),
      topbarRight: topbarRect.right - Number.parseFloat(topbarStyle.paddingRight),
      contentLeft: mainRect.left + Number.parseFloat(mainStyle.paddingLeft),
      contentRight: mainRect.right - Number.parseFloat(mainStyle.paddingRight),
    };
  });
  if (!result || Math.abs(result.topbarLeft - result.contentLeft) > 1.5 || Math.abs(result.topbarRight - result.contentRight) > 1.5) {
    throw new Error(`${label} does not share the product shell gutter: ${JSON.stringify(result)}`);
  }
  return result;
}

async function assertWorkflowStateColors(page, label) {
  const checksConnectorGeometry = await page.evaluate(() => window.innerWidth >= 960);
  const result = await page.locator(".top-stage-index").evaluateAll((plates) => plates.map((plate) => {
    const style = getComputedStyle(plate);
    const stage = plate.closest(".top-stage");
    const connector = stage ? getComputedStyle(stage, "::after") : null;
    const stageRect = stage?.getBoundingClientRect();
    const plateRect = plate.getBoundingClientRect();
    const connectorLeft = connector ? Number.parseFloat(connector.left) : 0;
    const connectorWidth = connector ? Number.parseFloat(connector.width) : 0;
    return {
      backgroundImage: style.backgroundImage,
      shadow: style.boxShadow,
      connector: connector?.backgroundColor ?? "",
      connectorStart: stageRect ? stageRect.left + connectorLeft : 0,
      connectorEnd: stageRect ? stageRect.left + connectorLeft + connectorWidth : 0,
      stageLeft: stageRect?.left ?? 0,
      stageRight: stageRect?.right ?? 0,
      stagePosition: stage ? getComputedStyle(stage).position : "",
      stageJustify: stage ? getComputedStyle(stage).justifyItems : "",
      plateLeft: plateRect.left,
      plateRight: plateRect.right,
      state: stage?.classList.contains("top-stage-done") ? "done" : stage?.classList.contains("top-stage-active") ? "active" : "upcoming",
    };
  }));
  if (result.length !== 5 || result.some((plate) => plate.backgroundImage !== "none")) {
    throw new Error(`${label} workflow plates still use decorative texture: ${JSON.stringify(result)}`);
  }
  const active = result.find((plate) => plate.state === "active");
  const done = result.find((plate) => plate.state === "done");
  const upcoming = result.find((plate) => plate.state === "upcoming");
  if (!active || active.shadow === "none") throw new Error(`${label} active workflow plate has no neon emphasis: ${JSON.stringify(result)}`);
  if (!done || !upcoming || done.connector === active.connector || active.connector !== upcoming.connector) {
    throw new Error(`${label} connector colors do not encode completed versus incomplete progress: ${JSON.stringify(result)}`);
  }
  for (let index = 0; checksConnectorGeometry && index < result.length - 1; index += 1) {
    const current = result[index];
    const next = result[index + 1];
    if (Math.abs(current.connectorStart - current.plateRight) > 2 || Math.abs(current.connectorEnd - next.plateLeft) > 2) {
      throw new Error(`${label} connector ${index + 1} does not join adjacent plates: ${JSON.stringify(result)}`);
    }
  }
}

async function waitForHostPortraits(page) {
  await page.waitForFunction(() => {
    const portraits = Array.from(document.querySelectorAll(".host-avatar-portrait"));
    return portraits.length === 6 && portraits.every((portrait) => portrait.complete && portrait.naturalWidth > 0);
  });
}

async function assertProviderScope(page, label) {
  const sourceRows = page.locator(".source-row");
  if (await sourceRows.count() !== 2) throw new Error(`${label} must show exactly QQ 音乐 and 网易云音乐`);
  const sourceTexts = await sourceRows.allTextContents();
  if (!sourceTexts.some((text) => text.includes("网易云音乐")) || !sourceTexts.some((text) => text.includes("QQ 音乐"))) {
    throw new Error(`${label} has unexpected source rows: ${JSON.stringify(sourceTexts)}`);
  }
  if (sourceTexts.some((text) => text.includes("Spotify") || text.includes("Fixture") || text.includes("Apple Music") || text.includes("本地测试"))) {
    throw new Error(`${label} leaked hidden sources: ${JSON.stringify(sourceTexts)}`);
  }
  if (await page.getByText("API Key", { exact: true }).count()) throw new Error(`${label} exposes provider API keys during managed onboarding`);
  if (await page.locator(".ai-provider-card").count()) throw new Error(`${label} exposes provider selection during managed onboarding`);
  return sourceTexts;
}

async function mockEmptyProgram(page) {
  await page.route(`${API_URL}/program`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ program: null }),
  }));
}

async function mockReadyManagedAccess(page) {
  await page.route("**/api/access/status*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ access: READY_ACCESS }) }));
}

async function mockInvitationRequired(page) {
  await page.route("**/api/access/status*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ access: { configured: true, connected: false, state: "invitation_required" } }) }));
}

async function mockReadyConnection(page) {
  await mockReadyManagedAccess(page);
  await page.route("**/api/sources", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ sources: [
      { sourceId: "qq_music", label: "QQ 音乐", playbackReady: false, hostedProgramAllowed: false, state: "needs_login", detail: "needs_login", checkedAt: new Date().toISOString() },
      { sourceId: "netease_music", label: "网易云音乐", playbackReady: true, hostedProgramAllowed: true, state: "ready", detail: "ready", checkedAt: new Date().toISOString() },
    ] }),
  }));
  await page.route("**/api/health", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, version: "e2e" }),
  }));
  await page.route("**/api/qq/status", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ status: { configured: true, authenticated: false, state: "needs_login", playable: false, persistentLogin: false } }),
  }));
  await page.route("**/api/netease/status", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ status: { configured: true, authenticated: true, state: "ready", playable: true, persistentLogin: true } }),
  }));
  await page.route("**/api/ai/config", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ config: READY_AI_CONFIG }) });
    }
    return route.fallback();
  });
}

await mkdir(OUTPUT_DIR, { recursive: true });
await stopActiveProgram();

const browser = await chromium.launch({ channel: "chrome", headless: true });
const browserErrors = [];
const landingContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
const landingPage = await landingContext.newPage();
await mockEmptyProgram(landingPage);
await mockInvitationRequired(landingPage);
await landingPage.goto(APP_URL, { waitUntil: "domcontentloaded" });
if (await landingPage.getByRole("heading", { level: 1 }).count() !== 1) throw new Error("landing must expose one semantic h1");
const landingPlay = landingPage.getByRole("button", { name: "进入 OPEN MUSIC RADIO 连接平台" });
await landingPlay.waitFor();
await landingPage.screenshot({ path: `${OUTPUT_DIR}/desktop-landing.png`, fullPage: true });
await landingPlay.click();
await landingPage.getByRole("heading", { name: "加入 Open Music Radio" }).waitFor();
if (await landingPage.locator(".landing-fracture, .radio-landing.is-exiting").count()) throw new Error("landing still renders the removed fracture transition");
if (!(await landingPage.locator(".main-content").evaluate((element) => element === document.activeElement))) throw new Error("landing transition did not move focus to the application content");
const productWordmark = landingPage.locator(".brand-neon-wordmark");
if ((await productWordmark.innerText()).replace(/\s+/g, " ").trim() !== "OPEN MUSIC RADIO") throw new Error("product masthead must use the landing wordmark");
if (await productWordmark.evaluate((element) => getComputedStyle(element).animationName !== "none" || Array.from(element.children).some((child) => getComputedStyle(child).animationName !== "none"))) {
  throw new Error("product masthead wordmark must remain static");
}
await landingContext.close();

const inviteQrContext = await browser.newContext({ viewport: { width: 1366, height: 768 }, locale: "zh-CN" });
const inviteQrPage = await inviteQrContext.newPage();
let invitationClaimed = false;
let qrAuthorized = false;
await mockEmptyProgram(inviteQrPage);
await inviteQrPage.route("**/api/access/status*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ access: invitationClaimed ? READY_ACCESS : { configured: true, connected: false, state: "invitation_required" } }) }));
await inviteQrPage.route("**/api/access/claim", (route) => {
  if (route.request().postDataJSON()?.inviteCode !== "OMR-NEON01") {
    return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "邀请码无效或已过期，请向管理员获取新的邀请码。" }) });
  }
  invitationClaimed = true;
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ access: READY_ACCESS, config: READY_AI_CONFIG }) });
});
await inviteQrPage.route("**/api/ai/config", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ config: READY_AI_CONFIG }) }));
await inviteQrPage.route("**/api/health", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }));
await inviteQrPage.route("**/api/sources", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sources: [
  { sourceId: "qq_music", label: "QQ 音乐", playbackReady: true, hostedProgramAllowed: true, state: "ready", detail: "ready", checkedAt: new Date().toISOString() },
  { sourceId: "netease_music", label: "网易云音乐", playbackReady: true, hostedProgramAllowed: true, state: "ready", detail: "ready", checkedAt: new Date().toISOString() },
] }) }));
await inviteQrPage.route("**/api/qq/status", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: { configured: true, authenticated: qrAuthorized, state: qrAuthorized ? "ready" : "needs_login", persistentLogin: qrAuthorized } }) }));
await inviteQrPage.route("**/api/netease/status", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: { configured: true, authenticated: false, state: "needs_login", persistentLogin: false } }) }));
await inviteQrPage.route("**/api/qq/login/qr**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(route.request().method() === "POST" ? { login: { key: "e2e-qq-qr", qrImageDataUrl: TEST_QR_DATA_URL } } : { login: { state: qrAuthorized ? "authorized" : "waiting_scan" } }) }));
await inviteQrPage.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
await inviteQrPage.getByLabel("你的名字").fill("测试成员");
await inviteQrPage.getByLabel("团队邀请码").fill("OMR-BAD01");
await inviteQrPage.getByRole("button", { name: "验证邀请码" }).click();
const invitationError = inviteQrPage.getByRole("alert");
await invitationError.waitFor();
const invitationErrorGeometry = await invitationError.evaluate((element) => {
  const rect = element.getBoundingClientRect();
  const main = element.closest("main")?.getBoundingClientRect();
  return { position: getComputedStyle(element).position, top: rect.top, left: rect.left, right: rect.right, mainLeft: main?.left, mainRight: main?.right };
});
if (invitationErrorGeometry.position === "fixed" || invitationErrorGeometry.mainLeft === undefined || invitationErrorGeometry.left < invitationErrorGeometry.mainLeft || invitationErrorGeometry.right > invitationErrorGeometry.mainRight) {
  throw new Error(`invitation error is detached from the current task: ${JSON.stringify(invitationErrorGeometry)}`);
}
await inviteQrPage.screenshot({ path: `${OUTPUT_DIR}/desktop-invite-inline-error.png`, fullPage: true });
await inviteQrPage.getByRole("button", { name: "关闭错误提示" }).click();
await inviteQrPage.getByLabel("团队邀请码").fill("OMR-NEON01");
await inviteQrPage.getByRole("button", { name: "验证邀请码" }).click();
await inviteQrPage.getByRole("button", { name: "下一步，音乐授权" }).click();
await inviteQrPage.getByRole("heading", { name: "连接你的音乐平台" }).waitFor();
if (await inviteQrPage.locator(".feedback-toast").count()) throw new Error("invitation success creates a redundant global toast");
await inviteQrPage.getByRole("region", { name: "QQ 音乐扫码登录" }).waitFor();
if (!(await inviteQrPage.getByAltText("QQ 音乐登录二维码").isVisible())) throw new Error("invitation completion did not expose the music client QR code");
await inviteQrPage.screenshot({ path: `${OUTPUT_DIR}/desktop-invite-to-qq-qr.png`, fullPage: true });
qrAuthorized = true;
await inviteQrPage.getByText("QQ 音乐已连接", { exact: true }).waitFor({ timeout: 5000 });
if (await inviteQrPage.locator(".feedback-toast, .inline-alert-notice").count()) throw new Error("music authorization success creates a redundant global notification");
await inviteQrContext.close();

const mobileLandingContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
const mobileLandingPage = await mobileLandingContext.newPage();
await mobileLandingPage.goto(APP_URL, { waitUntil: "domcontentloaded" });
await mobileLandingPage.getByRole("button", { name: "进入 OPEN MUSIC RADIO 连接平台" }).waitFor();
await assertNoHorizontalOverflow(mobileLandingPage, "mobile landing");
await mobileLandingPage.screenshot({ path: `${OUTPUT_DIR}/mobile-landing.png`, fullPage: true });
await mobileLandingContext.close();
const reducedLandingContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN", reducedMotion: "reduce" });
const reducedLandingPage = await reducedLandingContext.newPage();
await mockEmptyProgram(reducedLandingPage);
await reducedLandingPage.goto(APP_URL, { waitUntil: "domcontentloaded" });
await reducedLandingPage.getByRole("button", { name: "进入 OPEN MUSIC RADIO 连接平台" }).click();
await reducedLandingPage.locator(".app-shell").waitFor({ timeout: 1000 });
await reducedLandingContext.close();
const delayedTerminalContext = await browser.newContext({ viewport: { width: 800, height: 700 }, locale: "zh-CN" });
const delayedTerminalPage = await delayedTerminalContext.newPage();
await mockInvitationRequired(delayedTerminalPage);
await delayedTerminalPage.route(`${API_URL}/program`, async (route) => {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ program: { id: "old-terminal", generation: 1, status: "stopped", spec: { sourceId: "qq_music" } } }) });
});
await delayedTerminalPage.goto(APP_URL, { waitUntil: "domcontentloaded" });
await delayedTerminalPage.getByRole("button", { name: "进入 OPEN MUSIC RADIO 连接平台" }).click();
await delayedTerminalPage.getByRole("heading", { name: "加入 Open Music Radio" }).waitFor();
await delayedTerminalPage.waitForTimeout(1100);
if (await delayedTerminalPage.getByRole("heading", { name: "加入 Open Music Radio" }).count() !== 1) throw new Error("a delayed terminal restore overrode the landing choice");
await delayedTerminalContext.close();
const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
const page = await desktop.newPage();
await mockEmptyProgram(page);
await mockReadyConnection(page);
page.on("console", (message) => {
  if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
});
page.on("pageerror", (error) => browserErrors.push(`page: ${error.message}`));

await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
await page.getByRole("button", { name: "2 音乐授权", exact: true }).click();
await page.getByRole("heading", { name: "连接你的音乐平台" }).waitFor();
await assertProductShellAlignment(page, "desktop connection setup");
const sourceTexts = await assertProviderScope(page, "desktop");
if (sourceTexts.some((text) => text.includes("请打开桌面客户端") && text.endsWith("可用"))) {
  throw new Error(`an unopened desktop client is mislabeled as available: ${JSON.stringify(sourceTexts)}`);
}
await page.screenshot({ path: `${OUTPUT_DIR}/desktop-setup-music.png`, fullPage: true });
const desktopSizing = await assertNoHorizontalOverflow(page, "desktop");
await assertFitsViewport(page, "desktop connection setup");
await assertElementContentFits(page, ".connection-onboarding .music-onboarding-card", "desktop connection music card");
await page.setViewportSize({ width: 1366, height: 768 });
await assertNoHorizontalOverflow(page, "1366 connection setup");
await assertFitsViewport(page, "1366 connection setup");
await assertElementContentFits(page, ".connection-onboarding .music-onboarding-card", "1366 connection music card");
await page.screenshot({ path: `${OUTPUT_DIR}/desktop-setup-1366.png`, fullPage: true });
await page.getByRole("button", { name: /验证邀请/ }).click();
await page.getByRole("heading", { name: "加入 Open Music Radio" }).waitFor();
await assertElementContentFits(page, ".invitation-access-card", "1366 invitation card");
await page.screenshot({ path: `${OUTPUT_DIR}/desktop-setup-invite-1366.png`, fullPage: true });

const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
const mobilePage = await mobile.newPage();
await mockEmptyProgram(mobilePage);
await mockReadyConnection(mobilePage);
mobilePage.on("console", (message) => {
  if (message.type() === "error") browserErrors.push(`mobile console: ${message.text()}`);
});
mobilePage.on("pageerror", (error) => browserErrors.push(`mobile page: ${error.message}`));
await mobilePage.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
await mobilePage.getByRole("button", { name: "2 音乐授权", exact: true }).click();
await mobilePage.getByRole("heading", { name: "连接你的音乐平台" }).waitFor();
await assertProviderScope(mobilePage, "mobile");
await mobilePage.screenshot({ path: `${OUTPUT_DIR}/mobile-setup.png`, fullPage: true });
const mobileSizing = await assertNoHorizontalOverflow(mobilePage, "mobile");

const tablet = await browser.newContext({ viewport: { width: 768, height: 1024 }, locale: "zh-CN" });
const tabletPage = await tablet.newPage();
await mockEmptyProgram(tabletPage);
await mockReadyConnection(tabletPage);
await tabletPage.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
await tabletPage.getByRole("button", { name: "2 音乐授权", exact: true }).click();
await tabletPage.getByRole("heading", { name: "连接你的音乐平台" }).waitFor();
await assertProviderScope(tabletPage, "tablet");
await tabletPage.screenshot({ path: `${OUTPUT_DIR}/tablet-setup.png`, fullPage: true });
const tabletSizing = await assertNoHorizontalOverflow(tabletPage, "tablet");

const readyContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
const readyPage = await readyContext.newPage();
await mockEmptyProgram(readyPage);
await mockReadyManagedAccess(readyPage);
await readyPage.route("**/api/health", (route) => route.fulfill({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ ok: true, providers: { host: { configured: true, state: "ready" }, tts: { configured: true, state: "ready" } } }),
}));
await readyPage.route("**/api/sources", (route) => route.fulfill({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ sources: [
    { sourceId: "qq_music", label: "QQ 音乐", playbackReady: true, hostedProgramAllowed: true, state: "ready", detail: "ready", checkedAt: new Date().toISOString() },
    { sourceId: "netease_music", label: "网易云音乐", playbackReady: true, hostedProgramAllowed: true, state: "ready", detail: "ready", checkedAt: new Date().toISOString() },
  ] }),
}));
await readyPage.route("**/api/qq/status", (route) => route.fulfill({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ status: { configured: true, state: "ready", authenticated: true, persistentLogin: true } }),
}));
await readyPage.route("**/api/netease/status", (route) => route.fulfill({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ status: { configured: true, state: "ready", authenticated: true, persistentLogin: true } }),
}));
await readyPage.route("**/api/ai/config", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ config: READY_AI_CONFIG }) }));
let submittedProgramSpec = null;
let progressPolls = 0;
let allowProgramCompletion = false;
let finishProgramRequest;
const programCompletionGate = new Promise((resolve) => { finishProgramRequest = resolve; });
const previewRundown = [
  ["qq-e2e-island", "Island", "Nujabes", 280, "Free Soul Nujabes", 2014, true],
  ["qq-e2e-moonlight", "Moonlight Sonata", "Piano Chill", 362, "Classics of Heart", 2021, false],
  ["qq-e2e-autumn", "Autumn Breeze", "Milt Jackson", 180, "Cool Jazz Essentials", 1997, false],
  ["qq-e2e-slam", "Slam Slam Blues", "Charlie Parker", 267, "The Complete Savoy Sessions", 1945, true],
  ["qq-e2e-blue", "Blue in Green", "Miles Davis", 337, "Kind of Blue", 1959, true],
  ["qq-e2e-trouble", "Trouble in Mind", "Nina Simone", 338, "Pastel Blues", 1965, false],
  ["qq-e2e-rain", "After the Rain", "John Coltrane", 273, "Impressions", 1963, false],
].map(([id, title, artist, durationSeconds, album, releaseYear, liked]) => ({
  id, title, artist, durationSeconds, album, releaseYear, energy: 0.5, mood: ["study"], color: "#5f806b", sourceId: "qq_music", reasons: [liked ? "熟悉收藏" : "风格匹配"], liked, heard: liked,
}));
const makePreviewProgram = (planRevision = 0) => ({
  id: "e2e-ready-program", generation: 1, status: "awaiting_confirmation",
  spec: submittedProgramSpec,
  startedAt: null, deadlineAt: null, remainingSeconds: 1800, currentTrack: null, nextTrack: null, queue: [], host: null, recentHostLines: [], error: null,
  rundown: previewRundown,
  rundownIndex: 0,
  planRevision,
  planSummary: { totalTracks: 7, likedTracks: 3, heardTracks: 3, familiarTracks: 3, unheardTracks: 4, targetFamiliarityRatio: 40, actualFamiliarityRatio: 43 },
  listenerProfile: { favoriteArtists: [{ name: "Miles Davis", score: 10 }], topSongs: [{ title: "Blue in Green", artists: ["Miles Davis"] }], playlistNames: ["夜间爵士"], inferredThemes: ["专注"], evidence: ["我喜欢歌曲"] },
  plannedPlaylistName: "OMR电台-蓝夜拾光",
});
let finishSingleReplacement;
const singleReplacementGate = new Promise((resolve) => { finishSingleReplacement = resolve; });
await readyPage.route("**/api/programs/progress?*", (route) => {
  progressPolls += 1;
  const completedSteps = allowProgramCompletion ? 4 : Math.min(3, progressPolls);
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ progress: { completedSteps, status: completedSteps === 4 ? "completed" : "running", updatedAt: new Date().toISOString() } }),
  });
});
await readyPage.route("**/api/programs", async (route) => {
  submittedProgramSpec = route.request().postDataJSON()?.spec ?? null;
  await programCompletionGate;
  return route.fulfill({
    status: 201,
    contentType: "application/json",
    body: JSON.stringify({ program: makePreviewProgram() }),
  });
});
await readyPage.route("**/api/programs/e2e-ready-program/replace", async (route) => {
  await singleReplacementGate;
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ program: makePreviewProgram(1), message: "歌曲已替换。" }),
  });
});
await readyPage.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
await readyPage.getByRole("button", { name: "2 音乐授权", exact: true }).click();
await readyPage.getByRole("button", { name: "进入节目设置" }).click();
await readyPage.waitForFunction(() => window.scrollY === 0 && document.activeElement?.textContent?.includes("设定这档节目的声音与节奏"));
await waitForHostPortraits(readyPage);
await readyPage.screenshot({ path: `${OUTPUT_DIR}/mobile-program-settings.png`, fullPage: true });
await assertNoHorizontalOverflow(readyPage, "mobile program settings");
await assertWorkflowStateColors(readyPage, "mobile program settings");
await readyPage.setViewportSize({ width: 1440, height: 900 });
await readyPage.evaluate(() => window.scrollTo(0, 0));
await readyPage.screenshot({ path: `${OUTPUT_DIR}/desktop-program-settings.png`, fullPage: true });
await assertNoHorizontalOverflow(readyPage, "desktop program settings");
await assertFitsViewport(readyPage, "desktop program settings");
await assertProductShellAlignment(readyPage, "desktop program settings");
await assertWorkflowStateColors(readyPage, "desktop program settings");
await assertElementInsideViewport(readyPage, ".form-submit-row", "desktop program settings action row");
await assertElementContentFits(readyPage, ".program-host-console", "desktop host console");
await assertElementContentFits(readyPage, ".program-control-console", "desktop program controls");
await assertProgramControlsStack(readyPage, "desktop program settings");
await readyPage.getByRole("radio", { name: /按风格推荐/ }).click();
for (const genre of ["流行", "R&B/Soul", "说唱"]) {
  await readyPage.getByRole("button", { name: genre, exact: true }).click();
}
await readyPage.getByText("已选 3 / 3", { exact: true }).waitFor();
if (await readyPage.getByRole("button", { name: "摇滚", exact: true }).isEnabled()) throw new Error("a fourth music genre can be selected");
await readyPage.getByRole("button", { name: "流行", exact: true }).click();
if (!(await readyPage.getByRole("button", { name: "摇滚", exact: true }).isEnabled())) throw new Error("music genre choices stay disabled after removing one selection");
const hostCardGeometry = await readyPage.locator(".host-option").first().evaluate((card) => {
  const preview = card.querySelector(".host-preview-button");
  const avatar = card.querySelector(".host-avatar");
  const cardRect = card.getBoundingClientRect();
  const previewRect = preview?.getBoundingClientRect();
  const avatarRect = avatar?.getBoundingClientRect();
  return { card: cardRect.toJSON(), preview: previewRect?.toJSON(), avatar: avatarRect?.toJSON() };
});
if (!hostCardGeometry.preview || hostCardGeometry.preview.left < hostCardGeometry.card.left || hostCardGeometry.preview.right > hostCardGeometry.card.right) {
  throw new Error(`host preview control is clipped: ${JSON.stringify(hostCardGeometry)}`);
}
if (!hostCardGeometry.avatar || hostCardGeometry.avatar.height < 120 || hostCardGeometry.avatar.bottom > hostCardGeometry.card.bottom) {
  throw new Error(`host artwork is not composed inside its card: ${JSON.stringify(hostCardGeometry)}`);
}
if (hostCardGeometry.avatar.top - hostCardGeometry.card.top > 24) {
  throw new Error(`host artwork is not aligned to the top of its card: ${JSON.stringify(hostCardGeometry)}`);
}
const hostCardSizes = await readyPage.locator(".host-option").evaluateAll((cards) => cards.map((card) => {
  const rect = card.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}));
if (hostCardSizes.length !== 6 || hostCardSizes.some((size) => Math.abs(size.width - hostCardSizes[0].width) > 1 || Math.abs(size.height - hostCardSizes[0].height) > 1)) {
  throw new Error(`host cards are not equal-sized: ${JSON.stringify(hostCardSizes)}`);
}
const portraitRatios = await readyPage.locator(".host-avatar-portrait").evaluateAll((portraits) => portraits.map((portrait) => {
  const rect = portrait.getBoundingClientRect();
  return rect.width / rect.height;
}));
if (portraitRatios.length !== 6 || portraitRatios.some((ratio) => ratio < 1.45 || ratio > 1.85 || Math.abs(ratio - portraitRatios[0]) > 0.03)) {
  throw new Error(`host portraits do not share the intended half-body composition: ${JSON.stringify(portraitRatios)}`);
}
const consoleAlignment = await readyPage.locator(".program-console").evaluateAll((panels) => panels.map((panel) => {
  const rect = panel.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom };
}));
if (consoleAlignment.length !== 2 || Math.abs(consoleAlignment[0].top - consoleAlignment[1].top) > 1 || Math.abs(consoleAlignment[0].bottom - consoleAlignment[1].bottom) > 1) {
  throw new Error(`program panels are not aligned: ${JSON.stringify(consoleAlignment)}`);
}
if (await readyPage.locator("#source-choice").count()) throw new Error("settings must not repeat the source selector from the connection step");
const firstHostRadio = readyPage.locator('.host-option > button[role="radio"]').first();
await firstHostRadio.focus();
const hostFocusOutline = await firstHostRadio.locator("..").evaluate((card) => {
  const style = getComputedStyle(card);
  const borderColor = style.borderTopColor;
  const borderTransparent = borderColor === "transparent" || /^rgba\(.*,[\s]*0\)$/.test(borderColor) || /\/[\s]*0\)$/.test(borderColor);
  return { style: style.outlineStyle, width: style.outlineWidth, borderColor, borderTransparent };
});
if (hostFocusOutline.style === "none" || hostFocusOutline.width === "0px") throw new Error("host radio has no visible keyboard focus indicator");
if (!hostFocusOutline.borderTransparent) throw new Error(`focused host card still stacks its selection border: ${JSON.stringify(hostFocusOutline)}`);
await readyPage.keyboard.press("ArrowRight");
const secondHostRadio = readyPage.locator('.host-option > button[role="radio"]').nth(1);
if (await secondHostRadio.getAttribute("aria-checked") !== "true" || !(await secondHostRadio.evaluate((button) => document.activeElement === button))) {
  throw new Error("host radiogroup does not move selection and focus with arrow keys");
}
await readyPage.setViewportSize({ width: 1920, height: 1080 });
await readyPage.screenshot({ path: `${OUTPUT_DIR}/full-hd-program-settings.png`, fullPage: true });
await assertNoHorizontalOverflow(readyPage, "full HD program settings");
await assertFitsViewport(readyPage, "full HD program settings");
await assertProductShellAlignment(readyPage, "full HD program settings");
await assertElementInsideViewport(readyPage, ".form-submit-row", "full HD program settings action row");
await assertElementContentFits(readyPage, ".program-host-console", "full HD host console");
await assertElementContentFits(readyPage, ".program-control-console", "full HD program controls");
const controlRhythm = await readyPage.locator(".program-control-grid").evaluate((grid) => {
  const blocks = Array.from(grid.children).map((element) => element.getBoundingClientRect()).sort((left, right) => left.top - right.top);
  const gaps = blocks.slice(1).map((rect, index) => rect.top - blocks[index].bottom);
  const selector = grid.querySelector(".familiarity-select")?.getBoundingClientRect();
  const familiarity = grid.querySelector(".control-familiarity")?.getBoundingClientRect();
  return { gaps, selectorWidth: selector?.width ?? 0, familiarityWidth: familiarity?.width ?? 0 };
});
if (controlRhythm.gaps.some((gap) => gap < -1)) {
  throw new Error(`program control groups overlap: ${JSON.stringify(controlRhythm)}`);
}
if (controlRhythm.familiarityWidth === 0 || controlRhythm.selectorWidth / controlRhythm.familiarityWidth < 0.96) {
  throw new Error(`familiarity selector does not fill its row: ${JSON.stringify(controlRhythm)}`);
}
await readyPage.setViewportSize({ width: 1440, height: 900 });
await readyPage.route("**/hosts/previews/anxuan.mp3*", (route) => route.fulfill({ status: 502, contentType: "text/plain", body: "preview unavailable" }));
await readyPage.getByRole("button", { name: "试听龙安宣" }).click();
await readyPage.getByRole("alert").waitFor();
await assertElementInsideViewport(readyPage, ".form-submit-row", "desktop program settings action row with error banner");
await readyPage.setViewportSize({ width: 1512, height: 828 });
await assertNoHorizontalOverflow(readyPage, "1512x828 program settings");
await assertFitsViewport(readyPage, "1512x828 program settings");
await assertElementContentFits(readyPage, ".program-control-console", "1512x828 program controls");
await assertProgramControlsStack(readyPage, "1512x828 program settings");
await readyPage.screenshot({ path: `${OUTPUT_DIR}/program-settings-1512x828.png`, fullPage: true });
await readyPage.setViewportSize({ width: 1366, height: 768 });
await assertNoHorizontalOverflow(readyPage, "1366 full-screen program settings");
await assertFitsViewport(readyPage, "1366 full-screen program settings");
await assertElementInsideViewport(readyPage, ".form-submit-row", "1366 full-screen action row");
await assertElementContentFits(readyPage, ".program-host-console", "1366 full-screen host console");
await assertElementContentFits(readyPage, ".program-control-console", "1366 full-screen program controls");
await assertProgramControlsStack(readyPage, "1366 full-screen program settings");
await readyPage.setViewportSize({ width: 1300, height: 800 });
await assertNoHorizontalOverflow(readyPage, "program settings breakpoint edge");
await readyPage.setViewportSize({ width: 1200, height: 800 });
await readyPage.evaluate(() => window.scrollTo(0, 0));
await readyPage.screenshot({ path: `${OUTPUT_DIR}/compact-desktop-program-settings.png`, fullPage: true });
await assertNoHorizontalOverflow(readyPage, "compact desktop program settings");
await readyPage.setViewportSize({ width: 1024, height: 768 });
await assertNoHorizontalOverflow(readyPage, "compact desktop header");
for (const width of [320, 375, 414, 768]) {
  await readyPage.setViewportSize({ width, height: width === 768 ? 1024 : 900 });
  await assertNoHorizontalOverflow(readyPage, `${width}px program settings`);
  await assertElementContentFits(readyPage, ".program-host-console", `${width}px host console`);
  await readyPage.screenshot({ path: `${OUTPUT_DIR}/program-settings-${width}.png`, fullPage: true });
}
await readyPage.setViewportSize({ width: 390, height: 844 });
const companionToggle = readyPage.locator(".desktop-companion-toggle");
await companionToggle.click();
if ((await companionToggle.getAttribute("aria-pressed")) !== "true") throw new Error("desktop companion selection did not become active");
const viewPlan = readyPage.getByRole("button", { name: "查看计划" });
if (!(await viewPlan.isEnabled())) throw new Error("ready account API provider cannot create a plan");
await viewPlan.click();
if (submittedProgramSpec?.desktopPetEnabled !== true) throw new Error("desktop companion preference was not saved in the program spec");
await readyPage.waitForFunction(() => document.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow") === "75");
if (await readyPage.locator(".process-view li.done").count() !== 3) throw new Error("75% progress does not mark exactly three completed stages");
if (await readyPage.locator(".process-view li.active").count() !== 1) throw new Error("75% progress does not show one active stage");
await readyPage.waitForTimeout(380);
await readyPage.screenshot({ path: `${OUTPUT_DIR}/mobile-generation-progress-75.png`, fullPage: true });
await readyPage.setViewportSize({ width: 1440, height: 900 });
await assertNoHorizontalOverflow(readyPage, "desktop generation progress");
await readyPage.screenshot({ path: `${OUTPUT_DIR}/desktop-generation-progress-75.png`, fullPage: true });
allowProgramCompletion = true;
finishProgramRequest();
await readyPage.waitForFunction(() => document.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow") === "100");
if (await readyPage.locator(".process-view li.done").count() !== 4) throw new Error("100% progress does not mark all stages complete");
await readyPage.waitForTimeout(380);
await readyPage.screenshot({ path: `${OUTPUT_DIR}/desktop-generation-progress-100.png`, fullPage: true });
await readyPage.setViewportSize({ width: 390, height: 844 });
const confirmStart = readyPage.getByRole("button", { name: "确认并生成" });
await confirmStart.waitFor();
if (!(await confirmStart.isEnabled())) throw new Error("fully ready account API plan cannot be confirmed");
if (await readyPage.getByText("节目摘要", { exact: true }).count()) throw new Error("confirmation still renders the removed summary card");
  if (await readyPage.getByRole("button", { name: "节目设置" }).count()) throw new Error("confirmation allows program settings before exiting the program");
  if (await readyPage.getByRole("tab", { name: "批量调整" }).count() !== 1) throw new Error("confirmation is missing batch adjustment");
  if (await readyPage.getByRole("tab", { name: "调整顺序" }).count() !== 1) throw new Error("confirmation is missing order editing");
  if (await readyPage.getByRole("button", { name: "重新推荐" }).count() !== 1) throw new Error("confirmation is missing the full recommendation action");
  if (await readyPage.getByRole("button", { name: /锁定/ }).count()) throw new Error("confirmation still exposes per-track locking");
  if (await readyPage.getByRole("button", { name: "替换", exact: true }).count() !== previewRundown.length) throw new Error("confirmation is missing per-track replacement actions");
  await readyPage.getByRole("tab", { name: "调整顺序" }).click();
  if (await readyPage.getByRole("button", { name: /将《Island》上移/ }).count() !== 1) throw new Error("order mode does not expose move controls");
  await readyPage.getByRole("button", { name: "将《Island》下移" }).click();
  if (await readyPage.locator(".confirm-actions").getByRole("button", { name: "保存顺序", exact: true }).count() !== 1) throw new Error("an unsaved visible order can still start playback");
  if (await readyPage.getByText("顺序尚未保存，保存后才能启动节目。", { exact: true }).count() !== 1) throw new Error("pending order is not explained before playback");
  await assertNoHorizontalOverflow(readyPage, "mobile order editor");
  await readyPage.screenshot({ path: `${OUTPUT_DIR}/mobile-confirm-order.png`, fullPage: true });
  await readyPage.getByRole("tab", { name: "批量调整" }).click();
  if (await readyPage.getByRole("checkbox").count() !== previewRundown.length) throw new Error("batch adjustment does not expose track selection");
  await readyPage.getByLabel("选择《Island》").check();
  await readyPage.getByLabel("选择《Moonlight Sonata》").check();
  if (await readyPage.getByRole("button", { name: "替换所选（2）" }).count() !== 1) throw new Error("batch replacement does not reflect the selected track count");
  if (await readyPage.getByRole("button", { name: /英文歌曲|指定风格|指定歌手/ }).count()) throw new Error("batch adjustment still exposes semantic replacement filters");
  await assertNoHorizontalOverflow(readyPage, "mobile batch editor");
  await readyPage.setViewportSize({ width: 1440, height: 900 });
  await assertNoHorizontalOverflow(readyPage, "desktop batch editor");
  await readyPage.screenshot({ path: `${OUTPUT_DIR}/desktop-confirm-batch.png`, fullPage: true });
  await readyPage.setViewportSize({ width: 390, height: 844 });
  await readyPage.getByRole("tab", { name: "浏览" }).click();
  if (await readyPage.locator(".ai-chat-panel, .ai-chat-identity, .ai-chat-input-shell").count()) throw new Error("confirmation still renders the removed host chat");
  if (await readyPage.getByText("Radio Operator", { exact: true }).count()) throw new Error("confirmation still exposes the generic radio operator identity");
  if (await readyPage.getByText("OMR电台-蓝夜拾光", { exact: true }).count() !== 1) throw new Error("rundown heading does not show the playlist name");
  if (await readyPage.getByText("主持口播", { exact: true }).count()) throw new Error("confirmation exposes host copy before the playlist is frozen");
  if (await readyPage.getByRole("button", { name: "退出节目" }).count() !== 1) throw new Error("confirmation renders a duplicate exit action");
  if (await readyPage.getByRole("button", { name: "重做", exact: true }).count()) throw new Error("confirmation still exposes redo");
  if (await readyPage.locator(".confirm-topbar .section-intro p:not(.eyebrow)").count()) throw new Error("confirmation keeps the removed supporting paragraph");
  if (await readyPage.locator(".top-stage-copy small").count()) throw new Error("global steps still render English subtitles");
  if (await readyPage.locator(".outline-track blockquote").count()) throw new Error("host script still uses a nested quote card");
  if (await readyPage.locator(".outline-host-script").count()) throw new Error("confirmation still renders host script manuscripts");
  if (await readyPage.locator(".ai-host-signal").count()) throw new Error("host header still renders decorative signal bars");
await assertNoHorizontalOverflow(readyPage, "mobile confirmation");
await readyPage.screenshot({ path: `${OUTPUT_DIR}/mobile-confirm-plan.png`, fullPage: true });
await readyPage.setViewportSize({ width: 1440, height: 900 });
await assertNoHorizontalOverflow(readyPage, "desktop confirmation");
  await readyPage.getByRole("button", { name: "替换", exact: true }).first().click();
  const replacingRow = readyPage.locator(".outline-item.is-replacing");
  await replacingRow.waitFor();
  if (await replacingRow.count() !== 1) throw new Error("single replacement does not highlight exactly one row");
  if (await replacingRow.getAttribute("aria-busy") !== "true") throw new Error("replacing row does not expose its busy state");
  if (await replacingRow.getByRole("button", { name: "替换中", exact: true }).count() !== 1) throw new Error("replacing action does not show its active label");
  const replacingColors = await replacingRow.evaluate((row) => {
    const normalRow = row.nextElementSibling;
    const rowRect = row.getBoundingClientRect();
    const indexRect = row.querySelector(".outline-index")?.getBoundingClientRect();
    const actionsRect = row.querySelector(".outline-track-actions")?.getBoundingClientRect();
    const style = getComputedStyle(row);
    return {
      activeBackground: style.backgroundColor,
      normalBackground: normalRow ? getComputedStyle(normalRow).backgroundColor : "",
      borderWidth: Number.parseFloat(style.borderInlineStartWidth),
      borderColor: style.borderInlineStartColor,
      indexClearance: indexRect ? indexRect.left - rowRect.left : 0,
      actionClearance: actionsRect ? rowRect.right - actionsRect.right : 0,
    };
  });
  if (replacingColors.activeBackground === replacingColors.normalBackground || replacingColors.borderWidth < 2 || replacingColors.borderColor === "transparent") {
    throw new Error(`replacing row has no visible highlight: ${JSON.stringify(replacingColors)}`);
  }
  if (replacingColors.indexClearance < 12 || replacingColors.actionClearance < 12) throw new Error(`replacing row content lacks edge clearance: ${JSON.stringify(replacingColors)}`);
  await readyPage.screenshot({ path: `${OUTPUT_DIR}/desktop-confirm-replacing.png`, fullPage: true });
  finishSingleReplacement();
  await replacingRow.waitFor({ state: "detached" });
  const confirmationGeometry = await readyPage.evaluate(() => {
    const outline = document.querySelector(".program-outline")?.getBoundingClientRect();
    const grid = document.querySelector(".plan-editor-grid")?.getBoundingClientRect();
    const list = document.querySelector(".program-outline ol");
  const title = document.querySelector(".outline-track-heading strong");
  const artist = document.querySelector(".outline-track-heading > div:first-child > span");
  const duration = document.querySelector(".outline-track-actions time");
  const summary = document.querySelector(".program-spec-summary");
  const topbar = document.querySelector(".confirm-topbar");
    const topStageCopy = document.querySelector(".top-stage-copy");
    const outlineHeading = document.querySelector(".outline-heading");
    return {
      outline: outline?.toJSON(),
      grid: grid?.toJSON(),
      listClientHeight: list?.clientHeight ?? 0,
    titleSize: title ? Number.parseFloat(getComputedStyle(title).fontSize) : 0,
    artistSize: artist ? Number.parseFloat(getComputedStyle(artist).fontSize) : 0,
    durationSize: duration ? Number.parseFloat(getComputedStyle(duration).fontSize) : 0,
    summaryBorders: summary ? [getComputedStyle(summary).borderTopWidth, getComputedStyle(summary).borderBottomWidth] : [],
    summaryHeight: summary?.getBoundingClientRect().height ?? 0,
    topbarBorder: topbar ? getComputedStyle(topbar).borderBottomWidth : "",
      topStageTextAlign: topStageCopy ? getComputedStyle(topStageCopy).textAlign : "",
      outlineDecoration: outlineHeading ? getComputedStyle(outlineHeading, "::before").content : "",
    };
  });
  if (!confirmationGeometry.outline || !confirmationGeometry.grid || Math.abs(confirmationGeometry.outline.width - confirmationGeometry.grid.width) > 1.5) {
    throw new Error(`rundown does not fill the editor width: ${JSON.stringify(confirmationGeometry)}`);
  }
if (confirmationGeometry.listClientHeight < 400) throw new Error(`rundown viewport is too short: ${JSON.stringify(confirmationGeometry)}`);
if (confirmationGeometry.titleSize < 16 || confirmationGeometry.artistSize < 12 || confirmationGeometry.durationSize < 12) throw new Error(`rundown metadata remains too small: ${JSON.stringify(confirmationGeometry)}`);
if (confirmationGeometry.summaryBorders.some((width) => width !== "0px") || confirmationGeometry.topbarBorder !== "0px") throw new Error(`removed confirmation rules are still visible: ${JSON.stringify(confirmationGeometry)}`);
if (confirmationGeometry.summaryHeight > 90) throw new Error(`program parameters remain too tall: ${JSON.stringify(confirmationGeometry)}`);
  if (confirmationGeometry.topStageTextAlign !== "center") throw new Error(`Chinese step labels are not centered: ${JSON.stringify(confirmationGeometry)}`);
  if (!["none", "normal"].includes(confirmationGeometry.outlineDecoration)) throw new Error(`confirmation keeps decorative top traces: ${JSON.stringify(confirmationGeometry)}`);
await readyPage.screenshot({ path: `${OUTPUT_DIR}/desktop-confirm-plan.png`, fullPage: true });

const diagnosticFailureContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
const diagnosticFailurePage = await diagnosticFailureContext.newPage();
await mockEmptyProgram(diagnosticFailurePage);
await mockInvitationRequired(diagnosticFailurePage);
let sourceDiagnosticsUnavailable = true;
await diagnosticFailurePage.route("**/api/sources", async (route) => {
  if (sourceDiagnosticsUnavailable) {
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "音源诊断服务暂不可用。" }) });
    return;
  }
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ sources: [
      { sourceId: "qq_music", label: "QQ 音乐", playbackReady: true, hostedProgramAllowed: true, state: "ready", detail: "ready", checkedAt: new Date().toISOString() },
      { sourceId: "netease_music", label: "网易云音乐", playbackReady: true, hostedProgramAllowed: true, state: "ready", detail: "ready", checkedAt: new Date().toISOString() },
    ] }),
  });
});
await diagnosticFailurePage.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
await diagnosticFailurePage.getByRole("heading", { name: "加入 Open Music Radio" }).waitFor();
const diagnosticEnter = diagnosticFailurePage.getByRole("button", { name: "进入节目设置" });
if (await diagnosticEnter.count() && await diagnosticEnter.isEnabled()) throw new Error("diagnostic transport failure can still enter program settings");

const hostFailureContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
const hostFailurePage = await hostFailureContext.newPage();
await mockEmptyProgram(hostFailurePage);
await mockReadyManagedAccess(hostFailurePage);
const hostContexts = [];
const hostProgram = {
  id: "e2e-host-failure-program",
  generation: 1,
  status: "awaiting_confirmation",
  spec: { sourceId: "qq_music", durationMinutes: 30, scenePreset: "study", sceneDescription: "只保留安静、简洁的背景", hostDensity: "low", energyCurve: "稳定 · 低波动", avoid: [] },
  startedAt: null,
  deadlineAt: null,
  remainingSeconds: 1800,
  currentTrack: null,
  nextTrack: null,
  queue: [],
  host: null,
  recentHostLines: [],
  listenerProfile: {
    favoriteArtists: [{ name: "测试歌手", score: 10 }],
    topSongs: [{ title: "场景歌单：study jazz", artists: ["测试歌手"] }],
    playlistNames: ["学习收藏"],
    inferredThemes: ["专注"],
    evidence: ["已验证账号画像"],
  },
  planSummary: { totalTracks: 1, familiarTracks: 1, likedTracks: 1, heardTracks: 1, unheardTracks: 0, targetFamiliarityRatio: 60, actualFamiliarityRatio: 100 },
  planRevision: 1,
  rundownIndex: 0,
  rundown: [{
    id: "synthetic-current",
    title: "场景歌单：study jazz",
    artist: "测试歌手",
    durationSeconds: 1800,
    energy: 0.3,
    mood: ["稳定"],
    color: "#66836d",
    sourceId: "qq_music",
    reasons: ["符合专注氛围"],
    liked: true,
    heard: true,
    hostMoment: "opening",
    hostScript: { id: "locked-host", text: "学习时段已开始，先把注意力交给这一段声音。", factIds: ["program:scene"], instruction: "locked", hostMoment: "opening", generatedAt: new Date().toISOString() },
  }],
  error: null,
};
const onAirHostProgram = {
  ...hostProgram,
  status: "on_air",
  startedAt: new Date().toISOString(),
  deadlineAt: new Date(Date.now() + 1_800_000).toISOString(),
  currentTrack: { id: "synthetic-current", title: "场景歌单：study jazz", artist: "客户端队列", durationSeconds: 240, energy: 0.3, mood: ["稳定"], color: "#66836d", audioUrl: "/api/audio/e2e-music" },
  nextTrack: { id: "synthetic-next", title: "下一首由客户端队列决定", artist: "客户端队列", durationSeconds: 240, energy: 0.4, mood: ["平稳"], color: "#708979" },
};
await hostFailurePage.route("**/api/health", (route) => route.fulfill({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ ok: true, providers: { host: { configured: true, state: "ready" }, tts: { configured: true, state: "ready" } } }),
}));
await hostFailurePage.route("**/api/sources", (route) => route.fulfill({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ sources: [
    { sourceId: "qq_music", label: "QQ 音乐", playbackReady: true, hostedProgramAllowed: true, state: "ready", detail: "ready", checkedAt: new Date().toISOString() },
    { sourceId: "netease_music", label: "网易云音乐", playbackReady: true, hostedProgramAllowed: true, state: "ready", detail: "ready", checkedAt: new Date().toISOString() },
  ] }),
}));
await hostFailurePage.route("**/api/qq/status", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: { configured: true, state: "ready", authenticated: true, persistentLogin: true } }) }));
await hostFailurePage.route("**/api/netease/status", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: { configured: true, state: "ready", authenticated: true, persistentLogin: true } }) }));
await hostFailurePage.route("**/api/ai/config", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ config: READY_AI_CONFIG }) }));
await hostFailurePage.route("**/api/players/*/volume", (route) => {
  const sourceId = route.request().url().includes("netease_music") ? "netease_music" : "qq_music";
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ player: { sourceId, state: "connected_idle", ok: false, appRunning: true, playing: false, detail: "客户端已连接。" } }) });
});
await hostFailurePage.route("**/api/programs", (route) => route.fulfill({
  status: 201,
  contentType: "application/json",
  body: JSON.stringify({ program: hostProgram }),
}));
await hostFailurePage.route("**/api/programs/e2e-host-failure-program/confirm", (route) => route.fulfill({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ program: onAirHostProgram }),
}));
await hostFailurePage.route("**/api/programs/e2e-host-failure-program", (route) => route.fulfill({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ program: onAirHostProgram }),
}));
await hostFailurePage.route("**/api/programs/e2e-host-failure-program/heartbeat", (route) => route.fulfill({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ program: onAirHostProgram }),
}));
await hostFailurePage.route("**/api/host/preview", async (route) => {
  const requestBody = JSON.parse(route.request().postData() || "{}");
  hostContexts.push(requestBody);
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      host: { success: false, status: "failed", text: "这段失败文案不应播出。", factIds: [], error: { code: "HOST_PROVIDER_ERROR" } },
      audio: { status: "ready", url: "/api/audio/should-not-play" },
    }),
  });
});
await hostFailurePage.route("**/api/audio/e2e-music", (route) => route.fulfill({ status: 200, contentType: "audio/wav", body: makeTestWav() }));
await hostFailurePage.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
await hostFailurePage.getByRole("button", { name: "2 音乐授权", exact: true }).click();
await hostFailurePage.getByRole("button", { name: "进入节目设置" }).click();
await hostFailurePage.getByRole("button", { name: "查看计划" }).click();
await hostFailurePage.getByRole("button", { name: "确认并生成" }).click();
await hostFailurePage.getByRole("button", { name: "不保存，播完删除" }).click();
await hostFailurePage.getByText("无片段", { exact: true }).waitFor();
if (await hostFailurePage.getByText("这段失败文案不应播出。", { exact: true }).count()) throw new Error("failed host text was rendered");
const hostAudioSrc = await hostFailurePage.getByLabel("主持人口播音频").evaluate((element) => element.getAttribute("src") || "");
if (hostAudioSrc) throw new Error(`failed host audio was loaded: ${hostAudioSrc}`);
if (hostContexts.length === 0) throw new Error("host preview was not requested");
const [desktopHostContext] = hostContexts;
if (desktopHostContext.programId !== hostProgram.id || desktopHostContext.trackId !== "synthetic-current") throw new Error("locked API host preview lost its program or track identity");
if (desktopHostContext.context) throw new Error("locked API host preview sent a mutable runtime context");

// A desktop host segment is fetched after the confirmation click, so the
// browser may reject its first unmuted play attempt. The recovery control must
// start the local TTS element, not toggle the external music client.
const hostSuccessContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
const hostSuccessPage = await hostSuccessContext.newPage();
await mockEmptyProgram(hostSuccessPage);
await mockReadyManagedAccess(hostSuccessPage);
await hostSuccessPage.addInitScript(() => {
  window.__hostPlayAttempts = 0;
  const nativePlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function playWithAutoplayFailure() {
    const source = this.getAttribute("src") || "";
    if (source.includes("e2e-host-success")) {
      window.__hostPlayAttempts += 1;
      if (window.__hostPlayAttempts === 1) {
        return Promise.reject(new DOMException("Autoplay blocked", "NotAllowedError"));
      }
    }
    // Keep the original reference available for browser implementations that
    // require it, while returning a resolved promise for deterministic E2E.
    void nativePlay;
    return Promise.resolve();
  };
});
const hostSuccessProgram = {
  ...hostProgram,
  id: "e2e-host-success-program",
};
const onAirHostSuccessProgram = {
  ...hostSuccessProgram,
  ...onAirHostProgram,
  id: hostSuccessProgram.id,
  status: "on_air",
  startedAt: new Date().toISOString(),
  deadlineAt: new Date(Date.now() + 1_800_000).toISOString(),
};
const hostSuccessCalls = [];
const hostSuccessAudio = makeTestWav();
await hostSuccessPage.route("**/api/health", (route) => route.fulfill({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ ok: true, providers: { host: { configured: true, state: "ready" }, tts: { configured: true, state: "ready" } } }),
}));
await hostSuccessPage.route("**/api/sources", (route) => route.fulfill({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ sources: [
    { sourceId: "qq_music", label: "QQ 音乐", playbackReady: true, hostedProgramAllowed: true, state: "ready", detail: "ready", checkedAt: new Date().toISOString() },
    { sourceId: "netease_music", label: "网易云音乐", playbackReady: true, hostedProgramAllowed: true, state: "ready", detail: "ready", checkedAt: new Date().toISOString() },
  ] }),
}));
await hostSuccessPage.route("**/api/qq/status", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: { configured: true, state: "ready", authenticated: true, persistentLogin: true } }) }));
await hostSuccessPage.route("**/api/netease/status", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: { configured: true, state: "ready", authenticated: true, persistentLogin: true } }) }));
await hostSuccessPage.route("**/api/ai/config", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ config: READY_AI_CONFIG }) }));
await hostSuccessPage.route("**/api/players/**", async (route) => {
  const request = route.request();
  const pathname = new URL(request.url()).pathname;
  hostSuccessCalls.push({ method: request.method(), pathname });
  const sourceId = pathname.includes("netease_music") ? "netease_music" : "qq_music";
  if (request.method() === "GET" && pathname.endsWith("/volume")) {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ player: { sourceId, state: "connected_idle", ok: false, appRunning: true, playing: false, detail: "客户端已连接。" } }) });
    return;
  }
  if (pathname.endsWith("/duck")) {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ player: { sourceId, state: "ducked", ok: true, appRunning: true, playing: true, detail: "已降低播放器音量。" } }) });
    return;
  }
  if (pathname.endsWith("/restore")) {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ player: { sourceId, state: "restored", ok: true, appRunning: true, playing: true, detail: "已恢复播放器音量。" } }) });
    return;
  }
  await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "不应调用桌面播放器播放控制。" }) });
});
await hostSuccessPage.route("**/api/audio/e2e-host-success", (route) => route.fulfill({
  status: 200,
  contentType: "audio/wav",
  body: hostSuccessAudio,
}));
await hostSuccessPage.route("**/api/audio/e2e-music", (route) => route.fulfill({ status: 200, contentType: "audio/wav", body: hostSuccessAudio }));
await hostSuccessPage.route("**/api/program", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ program: null }) }));
await hostSuccessPage.route("**/api/programs", (route) => route.fulfill({
  status: 201,
  contentType: "application/json",
  body: JSON.stringify({ program: hostSuccessProgram }),
}));
await hostSuccessPage.route("**/api/programs/e2e-host-success-program/confirm", (route) => route.fulfill({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ program: onAirHostSuccessProgram }),
}));
await hostSuccessPage.route("**/api/programs/e2e-host-success-program", (route) => route.fulfill({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ program: onAirHostSuccessProgram }),
}));
await hostSuccessPage.route("**/api/programs/e2e-host-success-program/heartbeat", (route) => route.fulfill({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ program: onAirHostSuccessProgram }),
}));
await hostSuccessPage.route("**/api/host/preview", (route) => route.fulfill({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({
    host: { success: true, status: "generated", text: "学习时段已开始，先把注意力交给这一段声音。", factIds: ["program:scene"], instruction: "fact-bounded transition", generatedAt: new Date().toISOString() },
    audio: { status: "ready", url: "/api/audio/e2e-host-success" },
  }),
}));
await hostSuccessPage.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
await hostSuccessPage.getByRole("button", { name: "2 音乐授权", exact: true }).click();
await hostSuccessPage.getByRole("button", { name: "进入节目设置" }).click();
await hostSuccessPage.getByRole("button", { name: "查看计划" }).click();
await hostSuccessPage.getByRole("button", { name: "确认并生成" }).click();
await hostSuccessPage.getByRole("button", { name: "不保存，播完删除" }).click();
await hostSuccessPage.getByText("学习时段已开始，先把注意力交给这一段声音。", { exact: true }).first().waitFor();
await hostSuccessPage.getByRole("button", { name: "开启声音", exact: true }).waitFor();
await hostSuccessPage.getByRole("button", { name: "开启声音", exact: true }).click();
await hostSuccessPage.waitForFunction(() => window.__hostPlayAttempts >= 2);
await hostSuccessPage.getByLabel("主持人口播音频").dispatchEvent("ended");
if (hostSuccessCalls.length > 0) {
  throw new Error(`API music host recovery touched desktop player controls: ${JSON.stringify(hostSuccessCalls)}`);
}

await desktop.close();
await mobile.close();
await tablet.close();
await readyContext.close();
await diagnosticFailureContext.close();
await hostFailureContext.close();
await hostSuccessContext.close();
await browser.close();

if (browserErrors.length > 0) {
  throw new Error(`Browser errors:\n${browserErrors.join("\n")}`);
}

console.log(JSON.stringify({
  ok: true,
  visibleSources: sourceTexts,
  readyDesktopSourceCanStart: true,
  desktopSizing,
  mobileSizing,
  tabletSizing,
  hostAutoplayRecovery: true,
  apiHostRecoveryAvoidedDesktopControls: true,
  browserErrors,
}, null, 2));
