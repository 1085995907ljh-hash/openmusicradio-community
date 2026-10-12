import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";

const root = process.cwd();
const binary = resolve(root, "native/OneRadioPet/.build/release/OneRadioPet");
const assets = resolve(root, "public/hosts");
const directory = mkdtempSync(join(tmpdir(), "one-radio-pet-visual-"));
const statePath = join(directory, "state.json");
const instanceId = `visual-${process.pid}`;
const scale = process.env.ONE_RADIO_VISUAL_SCALE ?? "small";
const preferencesSuite = `one-radio-visual-${process.pid}`;
if (!["small", "medium", "large"].includes(scale)) throw new Error(`Unsupported visual scale: ${scale}`);
const defaultsResult = spawnSync("defaults", ["write", preferencesSuite, "desktopPetScale", "-string", scale]);
if (defaultsResult.status !== 0) throw new Error(`Unable to configure ${scale} desktop pet scale`);
const child = spawn(binary, ["--state-file", statePath, "--assets-dir", assets, "--instance-id", instanceId], {
  stdio: "ignore",
  env: {
    ...process.env,
    ONE_RADIO_PET_PREFERENCES_SUITE: preferencesSuite,
    ONE_RADIO_PET_VISUAL_TEST: "1",
    ONE_RADIO_WEB_URL: "http://127.0.0.1:5173/",
  },
});

const wait = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
let revision = 0;
let currentVisualMessage = "";
const writeState = (mood, message, profileId = "anya", ownerPid = process.pid) => {
  currentVisualMessage = message;
  writeFileSync(statePath, `${JSON.stringify({
    version: 1,
    programId: "visual-program",
    generation: 1,
    profileId,
    mood,
    message,
    speechDurationSeconds: mood === "speaking" ? 8 : undefined,
    revision: ++revision,
    updatedAt: new Date().toISOString(),
    ownerPid,
    instanceId,
  })}\n`, { mode: 0o600 });
};

const baseGeometry = {
  small: { windowWidth: 280, normalHeight: 310, characterWidth: 118, characterHeight: 176, speakingExtraWidth: 44 },
  medium: { windowWidth: 340, normalHeight: 370, characterWidth: 158, characterHeight: 228, speakingExtraWidth: 46 },
  large: { windowWidth: 410, normalHeight: 445, characterWidth: 200, characterHeight: 286, speakingExtraWidth: 48 },
}[scale];
const displayUnits = (message) => Array.from(message).reduce((total, character) => {
  if (/\s/.test(character)) return total + 0.35;
  return /^[\x00-\x7F]$/.test(character) ? total + 0.55 : total + 1;
}, 0);
const bubbleSize = (message) => {
  const units = displayUnits(message);
  if (scale === "small") {
    const width = units > 80 ? 300 : (units > 38 ? 260 : 210);
    const rows = Math.min(8, Math.max(2, Math.ceil(units / (width > 280 ? 25 : (width > 230 ? 21 : 16)))));
    return { width, height: Math.min(158, Math.max(74, 24 + rows * 16)) };
  }
  if (scale === "medium") {
    const width = units > 80 ? 360 : (units > 38 ? 310 : 248);
    const rows = Math.min(8, Math.max(2, Math.ceil(units / (width > 330 ? 28 : (width > 280 ? 24 : 18)))));
    return { width, height: Math.min(184, Math.max(90, 28 + rows * 18)) };
  }
  const width = units > 80 ? 420 : (units > 38 ? 360 : 286);
  const rows = Math.min(8, Math.max(2, Math.ceil(units / (width > 390 ? 31 : (width > 330 ? 27 : 21)))));
  return { width, height: Math.min(214, Math.max(106, 32 + rows * 21)) };
};
const geometryForState = (state) => {
  const speaking = state.startsWith("speaking");
  if (!speaking) return { ...baseGeometry, speakingWindowWidth: baseGeometry.windowWidth, speakingHeight: baseGeometry.normalHeight };
  const bubble = bubbleSize(currentVisualMessage);
  return {
    ...baseGeometry,
    speakingWindowWidth: bubble.width + baseGeometry.characterWidth + baseGeometry.speakingExtraWidth,
    speakingHeight: baseGeometry.normalHeight,
    bubbleX: 12,
    bubbleWidth: bubble.width,
    bubbleHeight: bubble.height,
  };
};
const captureRegion = () => {
  let windowGeometry;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    windowGeometry = spawnSync("osascript", [
      "-e",
      `tell application "System Events" to tell (first process whose unix id is ${child.pid}) to get {position, size} of window 1`,
    ], { encoding: "utf8" });
    if (windowGeometry.status === 0) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  if (!windowGeometry || windowGeometry.status !== 0) throw new Error(`Unable to locate desktop-pet window: ${windowGeometry?.stderr.trim() ?? "unknown error"}`);
  const [x, y, windowWidth, windowHeight] = windowGeometry.stdout.trim().split(/,\s*/).map(Number);
  if (![x, y, windowWidth, windowHeight].every(Number.isFinite)) throw new Error("Desktop-pet window returned invalid geometry");
  const padding = 24;
  return `${x - padding},${y - padding},${windowWidth + (padding * 2)},${windowHeight + (padding * 2)}`;
};
const hostMessage = "下午好，今天先从 Buddy Guy 的《Let My Guitar Do The Talking》开始，这首歌录在他创作状态很松弛的一段时期，吉他和人声都保留了现场感。接下来让节奏慢慢往前走，也留意制作中那些不抢镜却很耐听的层次。";
const locateVisualTestWindow = (png) => {
  let count = 0;
  let minX = png.width;
  let maxX = 0;
  let minY = png.height;
  let maxY = 0;
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const offset = (y * png.width + x) * 4;
      const red = png.data[offset];
      const green = png.data[offset + 1];
      const blue = png.data[offset + 2];
      if (red >= 245 && green <= 80 && blue >= 245) {
        count += 1;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (count < 2_000) throw new Error("Unable to locate the deterministic desktop-pet test window");
  return { minX, maxX, minY, maxY };
};
const inspectCapture = (output, state) => {
  const png = PNG.sync.read(readFileSync(output));
  const windowBounds = locateVisualTestWindow(png);
  const speaking = state.startsWith("speaking");
  const bubbleExpected = speaking;
  const geometry = geometryForState(state);
  const expectedWindowWidth = speaking ? geometry.speakingWindowWidth : geometry.windowWidth;
  if (windowBounds.maxX - windowBounds.minX < expectedWindowWidth - 4) {
    throw new Error(`${output} does not contain the complete desktop-pet window`);
  }
  const characterRect = {
    minX: windowBounds.minX + (speaking ? expectedWindowWidth - geometry.characterWidth - 12 : Math.round((expectedWindowWidth - geometry.characterWidth) / 2)),
    maxX: windowBounds.minX + (speaking ? expectedWindowWidth - 13 : Math.round((expectedWindowWidth + geometry.characterWidth) / 2) - 1),
    minY: windowBounds.minY + (speaking ? geometry.speakingHeight : geometry.normalHeight) - geometry.characterHeight - 8,
  };
  characterRect.maxY = characterRect.minY + geometry.characterHeight - 1;
  let characterPixels = 0;
  for (let y = characterRect.minY; y <= characterRect.maxY; y += 1) {
    for (let x = characterRect.minX; x <= characterRect.maxX; x += 1) {
      const offset = (y * png.width + x) * 4;
      const red = png.data[offset];
      const green = png.data[offset + 1];
      const blue = png.data[offset + 2];
      if (!(red >= 240 && green <= 90 && blue >= 240)) characterPixels += 1;
    }
  }
  if (characterPixels < 400) {
    throw new Error(`${output} does not contain a visibly rendered host (character=${characterPixels})`);
  }
  if (!bubbleExpected) {
    let extraPixels = 0;
    for (let y = windowBounds.minY; y <= windowBounds.maxY; y += 1) {
      for (let x = windowBounds.minX; x <= windowBounds.maxX; x += 1) {
        if (x >= characterRect.minX && x <= characterRect.maxX && y >= characterRect.minY && y <= characterRect.maxY) continue;
        const offset = (y * png.width + x) * 4;
        const red = png.data[offset];
        const green = png.data[offset + 1];
        const blue = png.data[offset + 2];
        if (!(red >= 240 && green <= 90 && blue >= 240)) extraPixels += 1;
      }
    }
    if (extraPixels > 40) throw new Error(`${output} renders extra text or chrome while the host is silent (${extraPixels} pixels)`);
  }
  let bubbleTextPixels = 0;
  let bubbleFillPixels = 0;
  let bubblePixelCount = 0;
  let bubbleRect;
  if (bubbleExpected) {
    const characterMaxYFromBottom = 8 + geometry.characterHeight;
    const bubbleYFromBottom = Math.min(
      Math.max(12, characterMaxYFromBottom - geometry.bubbleHeight * 0.62),
      Math.max(12, geometry.speakingHeight - geometry.bubbleHeight - 12),
    );
    bubbleRect = {
      minX: Math.round(windowBounds.minX + geometry.bubbleX),
      maxX: Math.round(windowBounds.minX + geometry.bubbleX + geometry.bubbleWidth - 1),
      minY: Math.round(windowBounds.minY + geometry.speakingHeight - bubbleYFromBottom - geometry.bubbleHeight),
      maxY: Math.round(windowBounds.minY + geometry.speakingHeight - bubbleYFromBottom - 1),
    };
    for (let y = bubbleRect.minY + 5; y <= bubbleRect.maxY - 5; y += 1) {
      for (let x = bubbleRect.minX + 5; x <= bubbleRect.maxX - 5; x += 1) {
        const offset = (y * png.width + x) * 4;
        const red = png.data[offset];
        const green = png.data[offset + 1];
        const blue = png.data[offset + 2];
        bubblePixelCount += 1;
        if (red > 235 && green > 235 && blue > 235) bubbleFillPixels += 1;
        if (red < 100 && green < 100 && blue < 100) bubbleTextPixels += 1;
      }
    }
    if ((bubbleFillPixels + bubbleTextPixels) / bubblePixelCount < 0.72 || bubbleTextPixels < 4) {
      throw new Error(`${output} does not contain the fixed speaking bubble and its text (fill=${(bubbleFillPixels / bubblePixelCount).toFixed(3)}, text=${bubbleTextPixels}, window=${JSON.stringify(windowBounds)}, bubble=${JSON.stringify(bubbleRect)})`);
    }
    const tailRect = {
      minX: bubbleRect.maxX,
      maxX: bubbleRect.maxX + 28,
      minY: Math.round((bubbleRect.minY + bubbleRect.maxY) / 2) - 14,
      maxY: Math.round((bubbleRect.minY + bubbleRect.maxY) / 2) + 14,
    };
    let tailPixels = 0;
    let tailFillPixels = 0;
    for (let y = tailRect.minY; y <= tailRect.maxY; y += 1) {
      for (let x = tailRect.minX; x <= tailRect.maxX; x += 1) {
        const offset = (y * png.width + x) * 4;
        const red = png.data[offset];
        const green = png.data[offset + 1];
        const blue = png.data[offset + 2];
        if (!(red >= 240 && green <= 90 && blue >= 240)) tailPixels += 1;
        if (red > 225 && green > 225 && blue > 225) tailFillPixels += 1;
      }
    }
    if (tailPixels < 180 || tailFillPixels < 110) {
      throw new Error(`${output} does not contain the integrated comic-bubble tail (rendered=${tailPixels}, fill=${tailFillPixels})`);
    }
    const tailMinX = bubbleRect.maxX - 2;
    const tailMaxX = tailMinX + 36;
    let occupiedGapPixels = 0;
    for (let y = bubbleRect.maxY + 1; y < characterRect.minY; y += 1) {
      for (let x = bubbleRect.minX; x <= bubbleRect.maxX; x += 1) {
        if (x >= tailMinX && x <= tailMaxX) continue;
        const offset = (y * png.width + x) * 4;
        const red = png.data[offset];
        const green = png.data[offset + 1];
        const blue = png.data[offset + 2];
        if (!(red >= 240 && green <= 90 && blue >= 240)) occupiedGapPixels += 1;
      }
    }
    if (occupiedGapPixels > 20) throw new Error(`${output} places rendered content in the bubble-to-character safety gap`);
  }
  return { png, bubbleRect, bubbleTextPixels, characterRect };
};
const changedPixelRatioInRect = (first, second, rect) => {
  if (first.png.width !== second.png.width || first.png.height !== second.png.height) return 0;
  let changed = 0;
  let pixels = 0;
  for (let y = rect.minY; y <= rect.maxY; y += 1) {
    for (let x = rect.minX; x <= rect.maxX; x += 1) {
      const offset = (y * first.png.width + x) * 4;
      const distance = Math.abs(first.png.data[offset] - second.png.data[offset])
        + Math.abs(first.png.data[offset + 1] - second.png.data[offset + 1])
        + Math.abs(first.png.data[offset + 2] - second.png.data[offset + 2]);
      if (distance > 45) changed += 1;
      pixels += 1;
    }
  }
  return changed / pixels;
};
const changedPixelRatio = (firstCapture, secondCapture) => {
  const { png: first, bubbleRect } = firstCapture;
  const { png: second } = secondCapture;
  if (!bubbleRect || first.width !== second.width || first.height !== second.height) return 0;
  let changed = 0;
  let pixels = 0;
  for (let y = bubbleRect.minY + 5; y <= bubbleRect.maxY - 5; y += 1) {
    for (let x = bubbleRect.minX + 5; x <= bubbleRect.maxX - 5; x += 1) {
      const offset = (y * first.width + x) * 4;
      const distance = Math.abs(first.data[offset] - second.data[offset])
        + Math.abs(first.data[offset + 1] - second.data[offset + 1])
        + Math.abs(first.data[offset + 2] - second.data[offset + 2]);
      if (distance > 45) changed += 1;
      pixels += 1;
    }
  }
  return changed / pixels;
};
const capture = (profileId, state) => {
  if (child.exitCode !== null) throw new Error(`Desktop pet exited before ${profileId} ${state} with ${child.exitCode}`);
  const output = `/tmp/one-radio-desktop-pet-${scale}-${profileId}-${state}.png`;
  const result = spawnSync("screencapture", ["-x", "-R", captureRegion(), output], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Unable to capture ${scale} ${profileId} ${state} state: ${result.stderr.trim()}`);
  return inspectCapture(output, state);
};

try {
  const requestedProfile = process.env.ONE_RADIO_VISUAL_PROFILE;
  const profiles = requestedProfile ? [requestedProfile] : ["anxuan", "anran", "anya", "xiaocheng", "longxin", "longhao"];
  for (const [index, profileId] of profiles.entries()) {
    if (index > 0) {
      writeState("preparing", "", profiles[index - 1]);
      await wait(350);
    }
    writeState("listening", "陪你听这一首", profileId);
    await wait(index === 0 ? 1_200 : 700);
    const idleEarly = capture(profileId, "listening-early");
    await wait(1_800);
    const idleProgressed = capture(profileId, "listening-progressed");
    if (changedPixelRatioInRect(idleEarly, idleProgressed, idleEarly.characterRect) < 0.001) {
      throw new Error(`${profileId} idle loop did not visibly progress`);
    }

    writeState("speaking", hostMessage, profileId);
    await wait(350);
    const early = capture(profileId, "speaking-early");
    if (profileId === "anya") {
      await wait(700);
      const progressed = capture(profileId, "speaking-progressed");
      if (changedPixelRatio(early, progressed) < 0.002) {
        throw new Error("Streaming speech text did not visibly progress");
      }
      await wait(4_000);
      capture(profileId, "speaking-held-after-text");
    }
  }

  if (process.env.ONE_RADIO_VISUAL_LONG_TEXT === "1") {
    const sentenceMessage = "第一句先把城市的灯光和节奏慢慢铺开，让你听见这段旋律里比较松弛的呼吸。第二句再把注意力交给下一层鼓点，保持电台陪伴感，但不要让气泡提前消失。";
    writeState("speaking", sentenceMessage, "anya");
    await wait(350);
    const earlyText = capture("anya", "speaking-text-early");
    await wait(1_400);
    const progressedText = capture("anya", "speaking-text-progressed");
    if (changedPixelRatio(earlyText, progressedText) < 0.001) {
      throw new Error("The desktop-pet bubble did not stream the full speech text");
    }
    await wait(2_000);
    capture("anya", "speaking-held-after-text");
  }

  writeState("paused", "", profiles.at(-1) ?? "anya");
  await wait(350);
  writeState("error", "角色资源缺失回退", "missing-profile");
  await wait(1_200);
  capture("fallback", "error");

  if (child.exitCode !== null) throw new Error(`Desktop pet exited early with ${child.exitCode}`);

  const temporaryOwner = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  writeState("listening", "服务进程存活检查", "anya", temporaryOwner.pid);
  await wait(300);
  temporaryOwner.kill("SIGTERM");
  await new Promise((resolvePromise) => temporaryOwner.once("exit", resolvePromise));
  await wait(500);
  if (child.exitCode === null) throw new Error("Desktop pet stayed alive after its owner process exited");
} finally {
  if (child.exitCode === null) child.kill("SIGTERM");
  spawnSync("defaults", ["delete", preferencesSuite]);
  rmSync(directory, { recursive: true, force: true });
}
