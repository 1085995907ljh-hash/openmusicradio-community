import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

const server = await createServer({ server: { port: 5188, strictPort: true, host: "127.0.0.1" } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  for (const failureCode of ["HOST_PROVIDER_ERROR", "TTS_PROVIDER_ERROR", "NETEASE_UNAVAILABLE"]) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let confirms = 0;
    let phase = "awaiting_confirmation";
    const requests = [];
    const now = new Date().toISOString();
    const tracks = [1, 2].map((index) => ({ id: `track-${index}`, title: `测试歌曲${index}`, artist: "测试音乐人", sourceId: "netease_music", durationSeconds: 300, energy: .5, mood: [], color: "#66806d" }));
    const program = () => ({ id: "host-recovery", generation: 1, planRevision: 3, status: phase,
      spec: { sourceId: "netease_music", durationMinutes: 30, scenePreset: "study", hostDensity: "low", familiarityRatio: 20, avoid: [] },
      startedAt: phase === "on_air" ? now : null, deadlineAt: null, remainingSeconds: 1800,
      currentTrack: phase === "on_air" ? tracks[0] : null, nextTrack: null, queue: [], rundown: tracks, rundownIndex: 0, recentHostLines: [], host: null, error: null,
      listenerProfile: { favoriteArtists: [], topSongs: [], playlistNames: [], inferredThemes: [], evidence: [] },
      planSummary: { totalTracks: 2, familiarTracks: 0, likedTracks: 0, heardTracks: 0, unheardTracks: 2, targetFamiliarityRatio: 20, actualFamiliarityRatio: 0 },
    });
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      if (path === "/api/programs/host-recovery/confirm") {
        confirms++;
        requests.push(request.postDataJSON());
        if (confirms === 1) return json({ code: failureCode, error: failureCode === "TTS_PROVIDER_ERROR" ? "主持语音预生成失败。" : "当前服务暂时无法连接。" }, 502);
        await new Promise((resolve) => setTimeout(resolve, 250));
        phase = "on_air";
        return json({ program: program() });
      }
      if (path === "/api/program" || path === "/api/programs/host-recovery") return json({ program: program() });
      if (path === "/api/programs/progress") return json({ progress: { completedSteps: phase === "on_air" ? 4 : 1, status: phase === "on_air" ? "completed" : "running" } });
      if (path === "/api/health") return json({ ok: true, providers: { host: { configured: true, state: "ready" }, tts: { configured: true, state: "ready" } } });
      if (path === "/api/access/status") return json({ configured: true, connected: true });
      if (path === "/api/ai/config") return json({ config: { llm: { provider: "deepseek", model: "deepseek-v4-flash", hasKey: true }, tts: { provider: "qwen", hasKey: true } } });
      if (path === "/api/sources") return json({ sources: [] });
      if (path === "/api/netease/status") return json({ status: { configured: true, authenticated: true, state: "ready" } });
      if (path === "/api/host/preview") return json({ host: null, audio: { status: "unavailable" } });
      return json({ ok: true });
    });
    await page.goto("http://127.0.0.1:5188/?skipIntro=1", { waitUntil: "domcontentloaded" });
    const initialButton = page.getByRole("button", { name: "完成选歌并生成口播", exact: true });
    await initialButton.click();
    await page.getByRole("button", { name: "不保存，播完删除", exact: true }).click();
    const retry = page.getByRole("button", { name: "重新生成口播", exact: true });
    if (failureCode === "NETEASE_UNAVAILABLE") {
      await initialButton.waitFor();
      assert.equal(await retry.count(), 0, "account failures must not be mislabeled as host failures");
    } else {
      await retry.waitFor();
      assert.ok(await retry.isEnabled());
      for (const track of tracks) assert.ok((await page.locator("body").innerText()).includes(track.title));
      if (failureCode === "HOST_PROVIDER_ERROR") await page.screenshot({ path: "/tmp/openmusicradio-host-retry-button.png", fullPage: true });
      await retry.click();
      await page.getByRole("button", { name: "下一首", exact: true }).waitFor();
      assert.equal(confirms, 2);
      assert.equal(await retry.count(), 0);
      assert.deepEqual(requests.map(({ generation, planRevision, keepPlaylist }) => ({ generation, planRevision, keepPlaylist })), Array(2).fill({ generation: 1, planRevision: 3, keepPlaylist: false }));
      assert.notEqual(requests[0].operationId, requests[1].operationId);
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ failureCode, confirms, phase, errors }));
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
