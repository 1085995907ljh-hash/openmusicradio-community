import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { ProviderError, QqMusicApiProvider } from "../src/providers/index.js";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

const song = {
  id: "42",
  title: "夜航",
  artists: [{ id: "7", name: "测试歌手" }],
  album: { id: "9", name: "测试专辑", coverUrl: "https://y.gtimg.cn/music/photo_new/T002R500x500M000album42.jpg" },
  durationMs: 201_000,
  mid: "mid42",
  songType: 0,
  mediaMid: "media42",
  releaseYear: 1998,
};

function provider(fetchImpl: typeof globalThis.fetch): QqMusicApiProvider {
  return new QqMusicApiProvider({
    env: { QQMUSIC_API_BASE_URL: "http://127.0.0.1:4321", QQMUSIC_SIDECAR_TOKEN: "qq-sidecar-test-token-123456789012345" },
    fetchImpl,
  });
}

test("unconfigured QQ provider is blocked and never fetches", async () => {
  let calls = 0;
  const target = new QqMusicApiProvider({
    env: {},
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({});
    },
  });

  assert.deepEqual(target.getStatus(), {
    provider: "qqmusic-api",
    configured: false,
    baseUrl: "http://127.0.0.1:4321",
    authenticated: false,
    timeoutMs: 8_000,
    state: "blocked_by_configuration",
    persistentLogin: false,
  });
  await assert.rejects(target.search("测试"), (error: unknown) => error instanceof ProviderError && error.code === "missing_credentials");
  assert.equal(calls, 0);
});

test("configured URL without a sidecar token is blocked before any network request", async () => {
  let calls = 0;
  const target = new QqMusicApiProvider({
    env: { QQMUSIC_API_BASE_URL: "http://127.0.0.1:4321" },
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({});
    },
  });
  assert.equal(target.getStatus().configured, false);
  assert.equal((await target.health()).state, "blocked_by_configuration");
  assert.equal(calls, 0);
});

test("dev runner isolates the QQ sidecar and creates a fresh capability token", async () => {
  const source = await readFile(new URL("../scripts/dev.mjs", import.meta.url), "utf8");
  assert.match(source, /const qqSidecarToken = randomBytes\(32\)\.toString\("base64url"\)/);
  assert.match(source, /join\(homedir\(\), "\.local", "bin"\)/);
  const qqStart = source.indexOf("const qqEnv = {");
  const serverStart = source.indexOf("const serverEnv = {");
  assert.ok(qqStart >= 0 && serverStart > qqStart, "QQ child environment block is missing");
  const qqEnvironment = source.slice(qqStart, serverStart);
  assert.match(qqEnvironment, /QQMUSIC_SIDECAR_TOKEN: qqSidecarToken/);
  assert.match(qqEnvironment, /\.\.\.runtimeEnv/);
  assert.doesNotMatch(qqEnvironment, /OPENAI_API_KEY|DASHSCOPE_API_KEY|LOCAL_CONTROL_TOKEN|ANTHROPIC_API_KEY/);
});

test("QQ provider rejects a non-loopback sidecar URL before sending its token", async () => {
  assert.throws(
    () => new QqMusicApiProvider({ env: { QQMUSIC_API_BASE_URL: "https://sidecar.example", QQMUSIC_SIDECAR_TOKEN: "qq-sidecar-test-token-123456789012345" } }),
    (error: unknown) => error instanceof ProviderError && error.code === "invalid_input",
  );
});

test("QR login defaults to the QQ Music mobile app, keeps legacy methods typed, and never exposes credentials", async () => {
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  const wxKey = "wx-session-key-1234567890";
  const qqKey = "qq-session-key-1234567890";
  const mobileKey = "mobile-session-key-1234567890";
  const secret = "musickey=private-credential";
  const target = provider(async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    if (url.pathname === "/login/qr" && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      const key = body.loginType === "mobile" ? mobileKey : body.loginType === "qq" ? qqKey : wxKey;
      return jsonResponse({ key, loginType: body.loginType, qrImageDataUrl: "data:image/png;base64,AA==", expiresIn: 180, credential: secret });
    }
    if (url.pathname === `/login/qr/${mobileKey}`) return jsonResponse({ code: 803, loginType: "mobile", credential: secret });
    if (url.pathname === `/login/qr/${wxKey}` && url.searchParams.get("loginType") === "qq") {
      return jsonResponse({ code: 803, loginType: "wx", credential: secret });
    }
    if (url.pathname === `/login/qr/${wxKey}`) return jsonResponse({ code: 803, loginType: "wx", credential: secret });
    throw new Error(`unexpected ${url.pathname}`);
  });

  const mobile = await target.createQrLogin();
  assert.equal(mobile.loginType, "mobile");
  assert.equal(mobile.qrImageDataUrl, "data:image/png;base64,AA==");
  assert.equal(JSON.stringify(mobile).includes(secret), false);
  const mobileRequest = requests.find((request) => request.url.pathname === "/login/qr" && request.init?.method === "POST");
  assert.deepEqual(JSON.parse(String(mobileRequest?.init?.body)), { loginType: "mobile" });
  assert.equal(new Headers(mobileRequest?.init?.headers).get("x-one-radio-qq-token"), "qq-sidecar-test-token-123456789012345");
  const mobileAuthorized = await target.checkQrLogin(mobile.key, "mobile");
  assert.deepEqual(mobileAuthorized, { code: 803, state: "authorized", loginType: "mobile" });

  const wx = await target.createQrLogin("wx");
  assert.equal(wx.loginType, "wx");
  const wxRequest = requests.filter((request) => request.url.pathname === "/login/qr" && request.init?.method === "POST").at(-1);
  assert.deepEqual(JSON.parse(String(wxRequest?.init?.body)), { loginType: "wx" });

  const qq = await target.createQrLogin("qq");
  assert.equal(qq.loginType, "qq");
  const qqRequest = requests.filter((request) => request.url.pathname === "/login/qr" && request.init?.method === "POST").at(-1);
  assert.deepEqual(JSON.parse(String(qqRequest?.init?.body)), { loginType: "qq" });

  await assert.rejects(target.checkQrLogin(wx.key, "qq"), (error: unknown) => error instanceof ProviderError && error.code === "invalid_response");
  const authorized = await target.checkQrLogin(wx.key);
  assert.deepEqual(authorized, { code: 803, state: "authorized", loginType: "wx" });
  const status = target.getStatus();
  assert.equal(status.authenticated, true);
  assert.equal(status.persistentLogin, true);
  assert.equal(status.state, "ready");
  assert.equal(JSON.stringify(status).includes(secret), false);
  assert.equal(JSON.stringify(status).includes(wx.key), false);
  assert.equal(JSON.stringify(status).includes(qq.key), false);
  assert.equal(JSON.stringify(status).includes(mobile.key), false);
});

test("QQ logout clears provider authorization through the protected sidecar", async () => {
  const requests: Array<{ path: string; method: string; body: string | null }> = [];
  const target = provider(async (input, init) => {
    const url = new URL(String(input));
    requests.push({ path: url.pathname, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : null });
    if (url.pathname === "/health") return jsonResponse({ configured: true, state: "ready", authenticated: true, persistentLogin: true });
    return jsonResponse({ configured: true, state: "blocked_by_auth", authenticated: false, persistentLogin: false });
  });
  assert.equal((await target.health()).authenticated, true);
  const status = await target.logout();
  assert.equal(status.authenticated, false);
  assert.equal(status.persistentLogin, false);
  assert.deepEqual(requests.at(-1), { path: "/logout", method: "POST", body: "{}" });
});

test("QQ profile, history contract, recommendation, and playlist operations are parsed and bounded", async () => {
  const paths: string[] = [];
  let playlistCreateBody: unknown;
  let playlistMutationBody: unknown;
  let playlistReplacementBody: unknown;
  let playlistDeleteBody: unknown;
  let likeSongBody: unknown;
  let unlikeSongBody: unknown;
  const target = provider(async (input, init) => {
    const url = new URL(String(input));
    paths.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    if (url.pathname === "/search") return jsonResponse({ songs: [song], total: 1 });
    if (url.pathname === "/search/playlists") return jsonResponse({ playlists: [{ id: "3", tid: "3", dirId: "30", name: "摇滚精选", description: null, trackCount: 1, ownerUid: "88" }], total: 1 });
    if (url.pathname === "/playlists") return jsonResponse({ playlists: [{ id: "3", tid: "3", dirId: "30", name: "学习", description: null, trackCount: 1, ownerUid: "88" }], more: false });
    if (url.pathname === "/liked") return jsonResponse({ songs: [song] });
    if (url.pathname === "/recent") return jsonResponse({ records: [{ song, playedAt: 1234 }] });
    if (url.pathname === "/history") return jsonResponse({ records: [{ song, playCount: 7, score: 99 }] });
    if (url.pathname === "/recommendations" || url.pathname === "/fm") return jsonResponse({ songs: [song] });
    if (url.pathname === "/song/42") return jsonResponse({ songs: [song] });
    if (url.pathname === "/song/42/similar") return jsonResponse({ songs: [song] });
    if (url.pathname === "/song/42/url") return jsonResponse({ id: "42", url: "https://qqmusic.example/42.mp3", durationMs: 201_000, format: "mp3", complete: true, authorizationCode: 0 });
    if (url.pathname === "/playlist/3") return jsonResponse({ id: "3", dirId: "3", name: "学习", description: null, trackCount: 1, tracks: [song] });
    if (url.pathname === "/playlist" && init?.method === "POST") {
      playlistCreateBody = JSON.parse(String(init.body));
      return jsonResponse({ id: "78", dirId: "77", name: "ai电台-深夜-夜航" });
    }
    if (url.pathname === "/playlist/78/tracks" && init?.method === "POST") {
      playlistMutationBody = JSON.parse(String(init.body));
      return jsonResponse({ playlistId: "78", trackIds: ["42"] });
    }
    if (url.pathname === "/playlist/78/tracks/replace" && init?.method === "POST") {
      playlistReplacementBody = JSON.parse(String(init.body));
      return jsonResponse({ playlistId: "78", trackIds: ["43", "42"] });
    }
    if (url.pathname === "/playlist/78" && init?.method === "DELETE") {
      playlistDeleteBody = JSON.parse(String(init.body));
      return jsonResponse({ playlistId: "78", dirId: "77", deleted: true });
    }
    if (url.pathname === "/song/42/like" && init?.method === "POST") {
      const parsed = JSON.parse(String(init.body));
      if (parsed.liked === true) likeSongBody = parsed;
      else unlikeSongBody = parsed;
      return jsonResponse({ trackId: "42", liked: parsed.liked });
    }
    throw new Error(`unexpected ${url.pathname}`);
  });

  assert.deepEqual((await target.search("中文 摇滚", { limit: 5, offset: 10 })).songs[0], song);
  assert.deepEqual(await target.searchPlaylists("摇滚精选 歌单", { limit: 4, offset: 8 }), { playlists: [{ id: "3", tid: "3", dirId: "30", name: "摇滚精选", description: null, trackCount: 1, ownerUid: "88" }], total: 1 });
  assert.deepEqual(await target.userPlaylists("88"), { playlists: [{ id: "3", tid: "3", dirId: "30", name: "学习", description: null, trackCount: 1, ownerUid: "88" }], more: false });
  assert.deepEqual(await target.likedSongIds("88"), ["42"]);
  assert.deepEqual(await target.likedSongs({ limit: 500 }), [song]);
  assert.deepEqual(await target.recentSongs(), [{ song, playedAt: 1234 }]);
  assert.deepEqual(await target.listeningHistory("88", { period: "week" }), [{ song, playCount: 7, score: 99 }]);
  assert.deepEqual(await target.dailyRecommendations(), [song]);
  assert.deepEqual(await target.personalFm(), [song]);
  assert.deepEqual(await target.songDetail(["42"]), [song]);
  assert.deepEqual(await target.similarSongs(42, { limit: 3 }), [song]);
  assert.deepEqual(await target.songUrl(42), { id: "42", url: "https://qqmusic.example/42.mp3", durationMs: 201_000, format: "mp3", complete: true, authorizationCode: 0 });
  assert.deepEqual(await target.playlistDetail(3), { id: "3", dirId: "3", name: "学习", description: null, trackCount: 1, tracks: [song] });
  assert.deepEqual(await target.createPlaylist("ai电台-深夜-夜航", undefined, { expectedUid: "88" }), { id: "78", name: "ai电台-深夜-夜航", dirId: "77" });
  assert.deepEqual(playlistCreateBody, { name: "ai电台-深夜-夜航", expectedUid: "88" });
  assert.deepEqual(await target.addSongsToPlaylist(78, [42], undefined, { dirId: 77, expectedUid: "88" }), { playlistId: "78", trackIds: ["42"] });
  assert.deepEqual(playlistMutationBody, { trackIds: ["42"], dirId: "77", expectedUid: "88" });
  assert.deepEqual(await target.replacePlaylistTracks(78, [42, 43], undefined, { dirId: 77, expectedUid: "88" }), { playlistId: "78", trackIds: ["43", "42"] });
  assert.deepEqual(playlistReplacementBody, { trackIds: ["43", "42"], dirId: "77", expectedUid: "88" });
  assert.deepEqual(await target.deletePlaylist(78, undefined, { dirId: 77, expectedUid: "88" }), { playlistId: "78", dirId: "77", deleted: true });
  assert.deepEqual(playlistDeleteBody, { dirId: "77", expectedUid: "88" });
  assert.deepEqual(await target.setSongLiked(42, true, song.songType, undefined, { expectedUid: "88" }), { trackId: "42", liked: true });
  assert.deepEqual(likeSongBody, { liked: true, songType: 0, expectedUid: "88" });
  assert.deepEqual(await target.setSongLiked(42, false, song.songType, undefined, { expectedUid: "88" }), { trackId: "42", liked: false });
  assert.deepEqual(unlikeSongBody, { liked: false, songType: 0, expectedUid: "88" });
  assert.match(paths.find((path) => path.startsWith("GET /search")) ?? "", /keyword=%E4%B8%AD%E6%96%87\+%E6%91%87%E6%BB%9A/);
  assert.match(paths.find((path) => path.startsWith("GET /search/playlists")) ?? "", /keyword=%E6%91%87%E6%BB%9A%E7%B2%BE%E9%80%89\+%E6%AD%8C%E5%8D%95/);
  assert.ok(paths.includes("GET /recent?limit=100"));
  assert.ok(paths.includes("GET /liked?limit=500"));
  assert.ok(paths.includes("GET /history?period=week"));
  assert.ok(paths.includes("GET /recommendations"));
  assert.ok(paths.includes("GET /fm"));
});

test("QQ song details preserve valid liked songs when one item fails", async () => {
  const target = provider(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/song/42") return jsonResponse({ songs: [song] });
    if (path === "/song/43") return jsonResponse({ error: "temporarily unavailable" }, 502);
    throw new Error(`unexpected ${path}`);
  });

  assert.deepEqual(await target.songDetail(["42", "43"]), [song]);
});

test("playback URLs reject credentials, loopback, private IPv4, and private IPv6", async () => {
  const responses = [
    { id: "42", url: "http://127.0.0.1/track.mp3", durationMs: 1 },
    { id: "42", url: "http://[::1]/track.mp3", durationMs: 1 },
    { id: "42", url: "http://media.localhost/track.mp3", durationMs: 1 },
    { id: "42", url: "https://user:pass@music.example/track.mp3", durationMs: 1 },
  ];
  for (const response of responses) {
    const target = provider(async () => jsonResponse(response));
    await assert.rejects(target.songUrl(42), (error: unknown) => error instanceof ProviderError && error.code === "invalid_response");
  }
});

test("QQ literal CDN playback IPs are pinned to the official stream host", async () => {
  const target = provider(async () => jsonResponse({
    id: "42",
    url: "http://118.116.5.40/M500001t9kf83BCKAU.mp3?vkey=signed-value",
    durationMs: 201_000,
    format: "mp3",
  }));

  const playback = await target.songUrl(42);
  assert.equal(playback.url, "https://isure.stream.qqmusic.qq.com/M500001t9kf83BCKAU.mp3?vkey=signed-value");

  const customPort = provider(async () => jsonResponse({
    id: "42",
    url: "http://118.116.5.40:8080/M500001t9kf83BCKAU.mp3?vkey=signed-value",
    durationMs: 201_000,
  }));
  assert.equal((await customPort.songUrl(42)).url, "https://isure.stream.qqmusic.qq.com/M500001t9kf83BCKAU.mp3?vkey=signed-value");

  const officialHttpHost = provider(async () => jsonResponse({
    id: "42",
    url: "http://sjy6.stream.qqmusic.qq.com:8080/M500001t9kf83BCKAU.mp3?vkey=signed-value",
    durationMs: 201_000,
  }));
  assert.equal((await officialHttpHost.songUrl(42)).url, "https://sjy6.stream.qqmusic.qq.com/M500001t9kf83BCKAU.mp3?vkey=signed-value");

  const invalid = provider(async () => jsonResponse({
    id: "42",
    url: "http://118.116.5.40/arbitrary/path",
    durationMs: 201_000,
  }));
  await assert.rejects(invalid.songUrl(42), (error: unknown) => error instanceof ProviderError && error.code === "invalid_response");
});

test("malformed sidecar payloads and invalid user input fail closed", async () => {
  const target = provider(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/search") return jsonResponse({ songs: "not-an-array", total: 0 });
    if (path === "/song/42/url") return jsonResponse({ id: "42", url: null, durationMs: null });
    return jsonResponse({});
  });
  await assert.rejects(target.search("test"), (error: unknown) => error instanceof ProviderError && error.code === "invalid_response");
  await assert.rejects(target.search(""), (error: unknown) => error instanceof ProviderError && error.code === "invalid_input");
  await assert.rejects(target.searchPlaylists(""), (error: unknown) => error instanceof ProviderError && error.code === "invalid_input");
  await assert.rejects(target.addSongsToPlaylist(1, [1, 1], undefined, { dirId: 2, expectedUid: "88" }), (error: unknown) => error instanceof ProviderError && error.code === "invalid_input");
  await assert.rejects(target.addSongsToPlaylist(1, [1], undefined), (error: unknown) => error instanceof ProviderError && error.code === "invalid_input");
  await assert.rejects(target.setSongLiked("mid42", true, 0, undefined, { expectedUid: "88" }), (error: unknown) => error instanceof ProviderError && error.code === "invalid_input");
  await assert.rejects(target.setSongLiked(1, true, -1, undefined, { expectedUid: "88" }), (error: unknown) => error instanceof ProviderError && error.code === "invalid_input");
  await assert.rejects(target.setSongLiked(1, true, 0, undefined), (error: unknown) => error instanceof ProviderError && error.code === "invalid_input");
  assert.deepEqual(await target.songUrl(42), { id: "42", url: null, durationMs: null });
});
