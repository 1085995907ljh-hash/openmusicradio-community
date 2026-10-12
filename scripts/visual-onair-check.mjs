import { chromium } from "playwright";

const APP_URL = process.env.APP_URL ?? "http://127.0.0.1:5173/?skipIntro=1";
const hostPanelOnly = process.argv.includes("--host-panel-only");
const readmeCapture = process.argv.includes("--readme-capture");

const now = Date.now();
const toneWav = (() => {
  const sampleRate = 8_000;
  const samples = sampleRate * 60;
  const buffer = Buffer.alloc(44 + samples);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate, 28);
  buffer.writeUInt16LE(1, 32);
  buffer.writeUInt16LE(8, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples, 40);
  for (let index = 0; index < samples; index += 1) {
    const carrier = Math.sin(index / sampleRate * Math.PI * 2 * 220);
    const pulse = Math.sin(index / sampleRate * Math.PI * 2 * 2) > 0 ? 1 : .35;
    buffer[44 + index] = Math.max(0, Math.min(255, Math.round(128 + carrier * 92 * pulse)));
  }
  return buffer;
})();
const track = (id, title, artist, durationSeconds, coverUrl) => ({
  id,
  title,
  artist,
  durationSeconds,
  energy: 0.62,
  mood: ["深夜", "R&B"],
  color: "#66806d",
  audioUrl: "/api/fixtures/fixture-01.wav",
  coverUrl,
});
const current = track("visual-01", "夜航", "测试歌手", 238, "/radio-fixture-cover.png");
const next = track("visual-02", "下一站月光", "另一位歌手", 204, "/radio-fixture-cover.png");
const program = {
  id: "visual-program",
  generation: 1,
  status: "on_air",
  spec: { sourceId: "qq_music", durationMinutes: 30, recommendationMode: "genre", scenePreset: "late_night", sceneDescription: "", hostDensity: "medium", energyCurve: "low-rise", avoid: [], familiarityRatio: 40, hostProfile: "anya", musicGenres: ["rnb_soul"] },
  startedAt: new Date(now - 56_000).toISOString(),
  deadlineAt: new Date(now + 29 * 60_000).toISOString(),
  remainingSeconds: 1_744,
  currentTrack: current,
  nextTrack: next,
  queue: [track("visual-03", "凌晨三点", "第三位歌手", 221)],
  host: { text: "刚才那一段把鼓点收得很克制，留出了呼吸，也让人更容易听见歌手尾音里的细节。接下来这首会把节奏稍微推近一点，但不会打破这一段的从容。", status: "playing", audioUrl: "/api/fixtures/fixture-01.wav", generatedAt: new Date(now - 20_000).toISOString() },
  recentHostLines: [],
  listenerProfile: { favoriteArtists: [{ name: "测试歌手", score: 10 }], topSongs: [{ title: "夜航", artists: ["测试歌手"] }], playlistNames: ["放松收藏"], inferredThemes: ["放松舒缓"], evidence: ["1 首喜欢的歌曲"] },
  planSummary: { totalTracks: 3, familiarTracks: 1, likedTracks: 1, heardTracks: 1, unheardTracks: 2, targetFamiliarityRatio: 40, actualFamiliarityRatio: 33 },
  planRevision: 1,
  rundownIndex: 0,
  playlist: { provider: "qq_music", id: "912345", idKind: "tid", name: "OMR电台-夜色回声", trackCount: 3, status: "ready", retention: "kept" },
  rundown: [
    { ...current, sourceId: "qq_music", liked: false, album: "夜航专辑", releaseYear: 2024, credits: { lyricists: ["词作者"], composers: ["曲作者"], arrangers: [] }, reasons: ["符合放松氛围"], hostMoment: "opening", hostScript: { id: "visual-host", text: "刚才那一段把鼓点收得很克制，留出了呼吸，也让人更容易听见歌手尾音里的细节。接下来这首会把节奏稍微推近一点，但不会打破这一段的从容。", factIds: [], instruction: "放松", hostMoment: "opening", generatedAt: new Date(now - 20_000).toISOString() } },
    { ...next, sourceId: "qq_music", album: "月光", releaseYear: 2022, reasons: ["承接当前节奏"] },
    { ...track("visual-03", "凌晨三点", "第三位歌手", 221), sourceId: "qq_music", album: "凌晨三点", releaseYear: 2021, reasons: ["节目收尾"] },
  ],
  error: null,
  report: [],
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
const viewports = readmeCapture
  ? [["desktop", { width: 1440, height: 900 }]]
  : [["desktop", { width: 1440, height: 1000 }], ["mobile", { width: 390, height: 844 }]];
for (const [name, viewport] of viewports) {
  console.log(`checking on-air ${name}`);
  const page = await browser.newPage({ viewport });
  let liked = false;
  program.rundown[0].liked = false;
  program.currentTrack = { ...current, liked: false };
  page.on("pageerror", (error) => console.error(`${name} page error:`, error.stack ?? error.message));
  page.on("requestfailed", (request) => console.error(`${name} request failed:`, request.url(), request.failure()?.errorText));
  await page.setViewportSize(viewport);
  await page.route(/\/api\/program(?:s\/visual-program)?(?:\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ program }) }));
  await page.route(/\/api\/programs\/visual-program\/.+$/, (route) => {
    if (new URL(route.request().url()).pathname.endsWith("/current/like")) {
      liked = route.request().postDataJSON()?.liked === true;
      program.rundown[0].liked = liked;
      program.currentTrack = { ...program.currentTrack, liked };
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ program }) });
  });
  await page.route(/\/api\/fixtures\/fixture-01\.wav$/, (route) => route.fulfill({ status: 200, contentType: "audio/wav", body: toneWav }));
  await page.route(/\/api\/host\/preview$/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ host: { success: true, status: "ready", text: program.host.text, audioUrl: "/api/fixtures/fixture-01.wav", generatedAt: program.host.generatedAt } }) }));
  await page.route(/\/api\/desktop-pet\/state$/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }));
  await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);
  console.log(`${name} body:`, (await page.locator("body").innerText()).slice(0, 240));
  await page.getByText("主持人口播", { exact: true }).waitFor();
  if (await page.locator(".inline-alert-notice").count()) throw new Error(`${name}: non-actionable on-air notice is visible`);
  const enableAudio = page.getByRole("button", { name: "开启声音" });
  if (await enableAudio.count()) await enableAudio.click();
  await page.getByText("正在口播", { exact: true }).waitFor();
  const stream = page.locator(".host-line-streaming > span[aria-hidden='true']");
  await page.waitForFunction(() => (document.querySelector(".host-line-streaming > span[aria-hidden='true']")?.textContent?.length ?? 0) > 0);
  const earlyText = await stream.textContent();
  const earlyAvatarBox = await page.locator(".host-panel .host-avatar").boundingBox();
  await page.waitForFunction((minimum) => (document.querySelector(".host-line-streaming > span[aria-hidden='true']")?.textContent?.length ?? 0) > minimum, earlyText?.length ?? 0, { timeout: 2_500 });
  const laterText = await stream.textContent();
  if (!earlyText || !laterText || laterText.length <= earlyText.length) throw new Error(`${name}: host copy did not stream progressively`);
  const hostAvatar = page.locator(".host-panel .host-avatar");
  const laterAvatarBox = await hostAvatar.boundingBox();
  if (!earlyAvatarBox || !laterAvatarBox || Math.abs(earlyAvatarBox.y - laterAvatarBox.y) > 1) throw new Error(`${name}: host avatar moved while copy streamed`);
  const hostAvatarFrame = page.locator(".on-air-host-avatar");
  const avatarFrameStyle = await hostAvatarFrame.evaluate((node) => ({ borderRadius: getComputedStyle(node).borderRadius, width: node.clientWidth, height: node.clientHeight }));
  if (
    avatarFrameStyle.borderRadius !== "50%"
    || avatarFrameStyle.width < 44
    || avatarFrameStyle.width > 56
    || Math.abs(avatarFrameStyle.width - avatarFrameStyle.height) > 1
  ) throw new Error(`${name}: host portrait is not presented as a compact circle`);
  if (!(await hostAvatar.evaluate((node) => node.classList.contains("host-avatar-portrait")))) throw new Error(`${name}: on-air host is not using the portrait asset`);
  await page.waitForFunction(() => {
    const node = document.querySelector(".host-panel .host-avatar");
    return node instanceof HTMLImageElement && node.complete && node.naturalWidth > 0;
  }, undefined, { timeout: 5_000 });
  if (!(await hostAvatar.evaluate((node) => node.complete && node.naturalWidth > 0))) throw new Error(`${name} host avatar did not load`);
  if (readmeCapture) {
    await page.waitForFunction(() => (document.querySelector(".host-line-streaming > span[aria-hidden='true']")?.textContent?.length ?? 0) >= 48, undefined, { timeout: 8_000 });
    const closeNotice = page.getByRole("button", { name: "关闭提示" });
    if (await closeNotice.count()) await closeNotice.click();
    await page.screenshot({ path: "docs/screenshots/openmusicradio-program.png", fullPage: true });
    await page.close();
    continue;
  }
  const hostPanel = page.locator(".host-panel");
  const hostPanelBeforeOverflow = await hostPanel.boundingBox();
  const scrollResult = await page.locator(".host-script-scroll").evaluate((node) => {
    const visibleText = node.querySelector(".host-line-streaming > span[aria-hidden='true']");
    if (visibleText) visibleText.textContent = `${visibleText.textContent ?? ""}${"这是一段用于验证长口播滚动行为的主持人文案。".repeat(40)}`;
    const overflowY = getComputedStyle(node).overflowY;
    const clientHeight = node.clientHeight;
    const scrollHeight = node.scrollHeight;
    node.scrollTop = scrollHeight;
    return { overflowY, clientHeight, scrollHeight, scrollTop: node.scrollTop };
  });
  const hostPanelAfterOverflow = await hostPanel.boundingBox();
  if (!hostPanelBeforeOverflow || !hostPanelAfterOverflow || Math.abs(hostPanelBeforeOverflow.height - hostPanelAfterOverflow.height) > 1 || Math.abs(hostPanelBeforeOverflow.y - hostPanelAfterOverflow.y) > 1) throw new Error(`${name}: long host copy changed the host panel geometry`);
  if (!['auto', 'scroll'].includes(scrollResult.overflowY) || scrollResult.scrollHeight <= scrollResult.clientHeight || scrollResult.scrollTop <= 0) throw new Error(`${name}: long host copy is not internally scrollable`);
  const hostTextWidth = await page.locator(".host-script-scroll").evaluate((node) => ({ width: node.clientWidth, panelWidth: node.closest(".host-panel")?.clientWidth ?? 0 }));
  if (hostTextWidth.width < hostTextWidth.panelWidth * .8) throw new Error(`${name}: host copy does not use the full panel width`);
  await hostPanel.screenshot({ path: `/tmp/one-radio-host-panel-${name}.png` });
  if (hostPanelOnly) {
    await page.close();
    continue;
  }
  if (await page.locator(".radio-host-pet").count()) throw new Error(`${name}: desktop companion leaked back into the web layout`);
  const circular = await page.locator(".track-art-circular").evaluate((node) => getComputedStyle(node).borderRadius);
  if (circular !== "50%") throw new Error(`${name}: current cover is not circular`);
  const ringAlignment = await page.locator(".signal-canvas canvas").evaluate((canvas) => {
    const canvasRect = canvas.getBoundingClientRect();
    const coverRect = canvas.closest(".broadcast-stage")?.querySelector(".track-art-circular")?.getBoundingClientRect();
    if (!coverRect) return null;
    const coverCenterX = coverRect.left - canvasRect.left + coverRect.width / 2;
    const coverCenterY = coverRect.top - canvasRect.top + coverRect.height / 2;
    return {
      centerError: Math.hypot(Number(canvas.dataset.ringCenterX) - coverCenterX, Number(canvas.dataset.ringCenterY) - coverCenterY),
      coverRadius: Number(canvas.dataset.coverRadius),
      innerRadius: Number(canvas.dataset.innerRadius),
      outerRadius: Number(canvas.dataset.outerRadius),
      safeRadius: Math.min(coverCenterX, canvasRect.width - coverCenterX, coverCenterY, canvasRect.height - coverCenterY),
    };
  });
  if (!ringAlignment || ringAlignment.centerError > 1) throw new Error(`${name}: circular spectrum is not centered on the cover`);
  if (ringAlignment.innerRadius - ringAlignment.coverRadius < 10) throw new Error(`${name}: circular spectrum overlaps the cover`);
  if (ringAlignment.outerRadius > ringAlignment.safeRadius - 8) throw new Error(`${name}: circular spectrum exceeds its safe drawing area`);
  const canvasHasSignal = await page.locator(".signal-canvas canvas").evaluate((node) => {
    const canvas = node;
    const context = canvas.getContext("2d");
    if (!context || canvas.width < 2 || canvas.height < 2) return false;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let colored = 0;
    for (let index = 0; index < pixels.length; index += 16) if (pixels[index + 1] > 20 && pixels[index + 3] > 0) colored += 1;
    return colored > 100;
  });
  if (!canvasHasSignal) throw new Error(`${name}: audio particle canvas is blank`);
  if (await page.locator(".signal-canvas canvas").getAttribute("data-particle-count")) throw new Error(`${name}: obsolete particle field is still enabled`);
  const signalBounds = await page.locator(".signal-canvas canvas").evaluate((node) => {
    const canvas = node;
    const context = canvas.getContext("2d");
    if (!context) return null;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let minX = canvas.width;
    let minY = canvas.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < canvas.height; y += 1) for (let x = 0; x < canvas.width; x += 1) {
      if (pixels[(y * canvas.width + x) * 4 + 3] === 0) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    return { minX, minY, maxX, maxY, width: canvas.width, height: canvas.height };
  });
  if (!signalBounds || signalBounds.minX <= 2 || signalBounds.minY <= 2 || signalBounds.maxX >= signalBounds.width - 3 || signalBounds.maxY >= signalBounds.height - 3) throw new Error(`${name}: circular spectrum is clipped by the canvas`);
  if (await page.getByText("曲目氛围未标注", { exact: true }).count()) throw new Error(`${name}: obsolete mood placeholder is visible`);
  if (await page.getByText(/本段目标/).count()) throw new Error(`${name}: internal arrangement target is visible`);
  if (await page.getByRole("button", { name: /保存本次歌单|保存中|已保存/ }).count()) throw new Error(`${name}: on-air controls still expose playlist saving`);
  const likeSong = page.getByRole("button", { name: "喜欢《夜航》" });
  await likeSong.waitFor();
  if (await page.locator(".track-title-row .track-like-button").count()) throw new Error(`${name}: like action is still hidden beside the title`);
  if (!(await likeSong.getByText("喜欢歌曲", { exact: true }).isVisible())) throw new Error(`${name}: like action does not expose a clear text label`);
  await likeSong.click();
  await page.getByRole("button", { name: "确认喜欢" }).click();
  await page.getByRole("button", { name: "取消喜欢《夜航》" }).waitFor();
  if (!(await page.getByText("已喜欢", { exact: true }).isVisible()) || !liked) throw new Error(`${name}: confirmed platform like is not reflected in the playback control`);
  await page.getByRole("button", { name: "查看歌单" }).click();
  await page.getByRole("dialog", { name: "OMR电台-夜色回声" }).waitFor();
  await page.getByText("已保存到你的账户歌单。", { exact: true }).waitFor();
  if (await page.getByRole("button", { name: "报告" }).count()) throw new Error(`${name}: report action is still visible`);
  if (await page.locator(".playlist-tracks li").count() !== 3) throw new Error(`${name}: playlist dialog does not show all tracks`);
  await page.screenshot({ path: `/tmp/one-radio-playlist-${name}.png`, fullPage: true });
  await page.getByRole("button", { name: "关闭歌单" }).click();
  await page.waitForFunction(() => Number(document.querySelector(".signal-canvas canvas")?.getAttribute("data-signal-level")) > .01, undefined, { timeout: 6_000 });
  const signalLevel = Number(await page.locator(".signal-canvas canvas").getAttribute("data-signal-level"));
  if (!Number.isFinite(signalLevel) || signalLevel <= .01) throw new Error(`${name}: visualizer did not respond to non-silent audio`);
  const featureFrames = Number(await page.locator(".signal-canvas canvas").getAttribute("data-feature-frames"));
  const measuredRms = Number(await page.locator(".signal-canvas canvas").getAttribute("data-rms"));
  if (!Number.isFinite(featureFrames) || featureFrames < 2 || !Number.isFinite(measuredRms) || measuredRms <= 0) throw new Error(`${name}: Meyda is running without receiving playable audio frames`);
  const analyserMode = await page.locator(".signal-canvas canvas").getAttribute("data-analyser-mode");
  if (!analyserMode || analyserMode === "fallback") throw new Error(`${name}: visualizer is not connected to the playing audio stream`);
  if (await page.locator(".signal-canvas canvas").getAttribute("data-analyser-engine") !== "meyda") throw new Error(`${name}: visualizer is not using Meyda audio features`);
  const beatSamples = [];
  const renderedRadiusSamples = [];
  const spectrumSpanSamples = [];
  const spectrumRangeSamples = [];
  for (let index = 0; index < 8; index += 1) {
    beatSamples.push(Number(await page.locator(".signal-canvas canvas").getAttribute("data-beat-level")));
    renderedRadiusSamples.push(Number(await page.locator(".signal-canvas canvas").getAttribute("data-inner-radius")));
    spectrumSpanSamples.push(Number(await page.locator(".signal-canvas canvas").getAttribute("data-spectrum-span")));
    spectrumRangeSamples.push(Number(await page.locator(".signal-canvas canvas").getAttribute("data-spectrum-range")));
    await page.waitForTimeout(90);
  }
  const finiteBeatSamples = beatSamples.filter(Number.isFinite);
  if (finiteBeatSamples.length < 4 || Math.max(...finiteBeatSamples) - Math.min(...finiteBeatSamples) < .01) throw new Error(`${name}: visualizer does not pulse with the audio signal`);
  if (Math.max(...finiteBeatSamples) < .18) throw new Error(`${name}: visualizer pulse is too weak to be perceptible`);
  if (Math.max(...renderedRadiusSamples) - Math.min(...renderedRadiusSamples) < 2) throw new Error(`${name}: circular spectrum radius does not visibly pulse`);
  const requiredSpectrumSpan = Math.min(18, Math.max(10, (ringAlignment.outerRadius - ringAlignment.innerRadius) * .55));
  if (Math.max(...spectrumSpanSamples) < requiredSpectrumSpan) throw new Error(`${name}: circular spectrum bars remain visually flat`);
  if (Math.max(...spectrumRangeSamples) < 6) throw new Error(`${name}: circular spectrum bars do not separate audible frequency bands`);
  if (Math.max(...spectrumSpanSamples) - Math.min(...spectrumSpanSamples) < 1.5) throw new Error(`${name}: circular spectrum bars do not react across frames`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  if (overflow) {
    const offenders = await page.evaluate(() => [...document.querySelectorAll("body *")].flatMap((node) => {
      const rect = node.getBoundingClientRect();
      return rect.right > window.innerWidth + 1 || rect.left < -1 ? [`${node.tagName.toLowerCase()}.${node.className}: ${Math.round(rect.left)}..${Math.round(rect.right)}`] : [];
    }).slice(0, 12));
    throw new Error(`${name} page overflows horizontally: ${offenders.join(" | ")}`);
  }
  await page.screenshot({ path: `/tmp/one-radio-onair-${name}.png`, fullPage: true });
  program.host.status = "ready";
  await page.waitForTimeout(1_150);
  if ((await stream.textContent()) !== program.host.text) throw new Error(`${name}: host copy was not completed when speech ended`);
  const frameBeforeReduce = Number(await page.locator(".signal-canvas canvas").getAttribute("data-frame"));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForTimeout(120);
  const frameAfterReduce = Number(await page.locator(".signal-canvas canvas").getAttribute("data-frame"));
  await page.waitForTimeout(180);
  const frameAfterSettling = Number(await page.locator(".signal-canvas canvas").getAttribute("data-frame"));
  if (frameAfterSettling !== frameAfterReduce || frameAfterReduce < frameBeforeReduce) throw new Error(`${name}: visualizer kept animating after reduced motion was enabled`);
  program.host.status = "playing";
  await page.close();
}
await browser.close();
console.log("on-air visual checks passed");
