import { chromium } from "playwright";

const sources = [
  { sourceId: "qq_music", label: "QQ 音乐", state: "ready", hostedProgramAllowed: true, playbackReady: true, accountConnected: true },
  { sourceId: "netease_music", label: "网易云音乐", state: "ready", hostedProgramAllowed: true, playbackReady: true, accountConnected: true },
];
const status = { status: { configured: true, state: "ready", authenticated: true, persistentLogin: true } };
const profileNames = ["龙安宣", "龙安燃", "龙安雅", "龙小诚", "龙浩"];

const browser = await chromium.launch({ channel: "chrome", headless: true });
for (const [name, viewport] of [["desktop", { width: 1440, height: 1000 }], ["mobile", { width: 390, height: 844 }]]) {
  const page = await browser.newPage({ viewport });
  await page.route(/\/api\/program$/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ program: null }) }));
  await page.route(/\/api\/health$/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, providers: { host: { configured: true, state: "ready" }, tts: { configured: true, state: "ready" } } }) }));
  await page.route(/\/api\/sources$/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sources }) }));
  await page.route(/\/api\/(qq|netease)\/status$/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(status) }));
  await page.goto("http://127.0.0.1:5173/?skipIntro=1", { waitUntil: "networkidle" });
  await page.getByRole("radiogroup", { name: "主持声线" }).waitFor();
  for (const profileName of profileNames) {
    const option = page.getByRole("radio", { name: new RegExp(profileName) });
    await option.click();
    const image = option.locator("img");
    if (!(await image.evaluate((node) => node.complete && node.naturalWidth > 0))) throw new Error(`${name}: ${profileName} asset did not load`);
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  if (overflow) throw new Error(`${name}: setup page overflows horizontally`);
  if (await page.locator(".radio-host-pet").count()) throw new Error(`${name}: desktop companion leaked back into the web layout`);
  await page.screenshot({ path: `/tmp/one-radio-host-pets-${name}.png`, fullPage: true });
  await page.close();
}
await browser.close();
