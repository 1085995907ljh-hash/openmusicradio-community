import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

// Exercise actual HTML audio and the app's mixing graph; no live account/backend calls.
const server = await createServer({ server: { port: 5186, strictPort: true, host: "127.0.0.1" } });
await server.listen();
const requireGesture = process.env.HOST_AUDIO_REQUIRE_GESTURE === "1";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: [`--autoplay-policy=${requireGesture ? "document-user-activation-required" : "no-user-gesture-required"}`] });
function tone(seconds, frequency) {
  const rate = 16000, samples = seconds * rate;
  const out = Buffer.alloc(44 + samples * 2);
  out.write("RIFF"); out.writeUInt32LE(out.length - 8, 4); out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24); out.writeUInt32LE(rate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write("data", 36); out.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) out.writeInt16LE(Math.round(16384 * Math.sin(i / rate * 2 * Math.PI * frequency)), 44 + i * 2);
  return out;
}
try {
  for (const { shortHost, busyUI } of [{ shortHost: false, busyUI: false }, { shortHost: false, busyUI: true }, { shortHost: true, busyUI: true }]) {
    const page = await browser.newPage({ reducedMotion: shortHost ? "reduce" : "no-preference" });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    if (requireGesture) await page.addInitScript(() => {
      // Chrome headless may grant autoplay; deterministically exercise the recovery button.
      let unlocked = false;
      document.addEventListener("pointerdown", () => { unlocked = true; }, { once: true });
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        if (!unlocked) return Promise.reject(new DOMException("User activation required", "NotAllowedError"));
        return play.call(this);
      };
    });
    await page.addInitScript(() => {
      window.outputMeters = [];
      const connect = AudioNode.prototype.connect;
      AudioNode.prototype.connect = function (target, ...args) {
        if (target instanceof AudioDestinationNode && !(this instanceof ScriptProcessorNode)) {
          const meter = this.context.createAnalyser();
          meter.fftSize = 2048;
          connect.call(this, meter);
          window.outputMeters.push(meter);
        }
        return connect.call(this, target, ...args);
      };
      window.readMusicLevel = () => {
        const meter = window.outputMeters[0];
        if (!meter) return null;
        const data = new Float32Array(meter.fftSize);
        meter.getFloatTimeDomainData(data);
        return Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
      };
    });
    const now = new Date().toISOString();
    const track = { id: "duck-song", title: "音量回归测试", artist: "测试音频", sourceId: "qq_music", durationSeconds: 60, energy: .5, mood: [], color: "#66806d", audioUrl: "/api/music.wav", hostMoment: "opening", hostScript: { id: "duck-host", text: "这段测试验证主持人口播时音乐降低，结束后恢复。", factIds: [], instruction: "自然", hostMoment: "opening", generatedAt: now, musicBedDelaySeconds: 5 } };
    const program = { id: "duck-program", generation: 1, status: "on_air", spec: { sourceId: "qq_music", durationMinutes: 30, scenePreset: "study", hostDensity: "low", familiarityRatio: 50, avoid: [], recommendationMode: "genre", musicGenres: ["rnb_soul"] }, startedAt: now, deadlineAt: new Date(Date.now() + 1800000).toISOString(), remainingSeconds: 1800, currentTrack: track, nextTrack: null, queue: [], rundown: [track], rundownIndex: 0, recentHostLines: [], host: null, error: null };
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      const json = (value) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
      if (path === "/api/music.wav" || path === "/api/host.wav") return route.fulfill({ status: 200, contentType: "audio/wav", body: tone(path.includes("music") ? 60 : shortHost ? 1 : 9, path.includes("music") ? 440 : 880) });
      if (path === "/api/host/preview") return json({ host: { success: true, status: "ready", text: track.hostScript.text, generatedAt: now }, audio: { status: "ready", url: "/api/host.wav" } });
      if (path === "/api/program" || path.startsWith("/api/programs/")) return json({ program });
      if (path === "/api/health") return json({ ok: true });
      if (path === "/api/access/status") return json({ connected: true, configured: true });
      if (path === "/api/ai/config") return json({ config: { llm: { provider: "deepseek", model: "deepseek-v4-flash", hasKey: true }, tts: { provider: "qwen", hasKey: true } } });
      if (path === "/api/sources") return json({ sources: [] });
      return json({ ok: true });
    });
    await page.goto("http://127.0.0.1:5186/?skipIntro=1", { waitUntil: "domcontentloaded" });
    if (requireGesture) await page.getByRole("button", { name: "开启声音", exact: true }).click();
    await page.waitForFunction(() => { const a = document.querySelector('audio[aria-label="主持人口播音频"]'); return a && !a.paused; });
    await page.evaluate((busyUI) => {
      const host = document.querySelector('audio[aria-label="主持人口播音频"]');
      host.addEventListener("ended", () => {
        window.hostEndedAt = performance.now();
        // Simulate a busy/background UI after the restore has been scheduled.
        if (busyUI) setTimeout(() => { const until = performance.now() + 2200; while (performance.now() < until) {} }, 100);
      }, { once: true });
    }, busyUI);
    let ducked = null;
    if (!shortHost) {
      await page.waitForFunction(() => { const a = document.querySelector('audio[aria-label="当前曲目音频"]'); return a && !a.paused && a.currentTime > .3; });
      ducked = await page.evaluate(() => ({ rms: window.readMusicLevel(), volume: document.querySelector('audio[aria-label="当前曲目音频"]').volume }));
    }
    await page.waitForFunction((delay) => window.hostEndedAt && performance.now() - window.hostEndedAt > delay, busyUI ? 2350 : 2050);
    const restored = await page.evaluate(() => ({ rms: window.readMusicLevel(), volume: document.querySelector('audio[aria-label="当前曲目音频"]').volume, delay: performance.now() - window.hostEndedAt, playing: !document.querySelector('audio[aria-label="当前曲目音频"]').paused }));
    console.log(JSON.stringify({ shortHost, busyUI, ducked, restored, errors }));
    assert.deepEqual(errors, []);
    if (ducked) assert.ok(ducked.rms > .02 && ducked.rms < .055, `music must be an audible -18 dB bed: ${JSON.stringify(ducked)}`);
    assert.ok(restored.rms > .32 && restored.rms < .38, `music must restore even while UI timers are blocked: ${JSON.stringify(restored)}`);
    assert.equal(restored.playing, true);
    if (!shortHost && !busyUI) {
      // A second announcement must cancel an in-flight restore, with no duplicate output path.
      await page.evaluate(async () => {
        const { setMusicVolume } = await import("/src/web/music-audio.ts");
        const music = document.querySelector('audio[aria-label="当前曲目音频"]');
        setMusicVolume(music, .1258925);
        setMusicVolume(music, 1, 1000);
      });
      await page.waitForTimeout(350);
      await page.evaluate(async () => {
        const { setMusicVolume } = await import("/src/web/music-audio.ts");
        setMusicVolume(document.querySelector('audio[aria-label="当前曲目音频"]'), .1258925);
      });
      await page.waitForTimeout(1100);
      const interruptedRms = await page.evaluate(() => window.readMusicLevel());
      assert.ok(interruptedRms > .02 && interruptedRms < .055, `old restore must not override a new duck: ${interruptedRms}`);
    }
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
