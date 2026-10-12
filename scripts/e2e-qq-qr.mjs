import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const appUrl = process.env.APP_URL ?? "http://127.0.0.1:5173/?skipIntro=1";
const outputDir = "test-results";
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const loginRequests = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.includes("/api/qq/login/qr")) {
      loginRequests.push({ method: request.method(), url, body: request.postDataJSON?.() });
    }
  });

  await page.goto(appUrl, { waitUntil: "networkidle" });
  const connect = page.getByRole("button", { name: /使用 QQ 音乐 App 扫码/ });
  if (!(await connect.isEnabled())) throw new Error("QQ QR login must be available while the API is connected but the account is logged out");
  await connect.click();

  const qr = page.getByAltText("QQ 音乐 App 登录二维码");
  await qr.waitFor({ timeout: 15_000 });
  const initialSource = await qr.getAttribute("src");
  if (!initialSource?.startsWith("data:image/")) throw new Error("QQ Music App login did not return a QR image");
  const qrRegionText = await page.getByRole("region", { name: "QQ 音乐扫码登录" }).innerText();
  if (!qrRegionText.replace(/\s+/g, " ").includes("手机 QQ 音乐 App")) throw new Error("QQ Music App QR prompt is missing");
  if (await page.getByRole("radio", { name: /微信扫码|QQ 扫码/ }).count()) throw new Error("Legacy WeChat/QQ QR selector must not be rendered");
  await page.waitForTimeout(2_500);
  const createRequest = loginRequests.find((request) => request.method === "POST");
  if (createRequest?.body?.loginType !== "mobile") throw new Error(`QQ QR create must use mobile login: ${JSON.stringify(createRequest)}`);
  const pollRequest = loginRequests.find((request) => request.method === "GET");
  if (pollRequest?.url.searchParams.get("method") !== "mobile") throw new Error("QQ QR polling must stay bound to mobile login");

  const sizing = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  if (sizing.scrollWidth > sizing.clientWidth) throw new Error(`QQ QR layout overflows on mobile: ${JSON.stringify(sizing)}`);
  await page.screenshot({ path: `${outputDir}/qq-music-app-qr-mobile.png`, fullPage: true });
  if (errors.length > 0) throw new Error(`Browser errors: ${errors.join(" | ")}`);
} finally {
  await browser.close();
}
