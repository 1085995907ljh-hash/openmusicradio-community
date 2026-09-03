import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNeteaseProvider, NeteaseApiProvider, ProviderError } from "../src/providers/index.js";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

const song = {
  id: 42,
  name: "夜航",
  ar: [{ id: 7, name: "测试歌手" }],
  al: { id: 9, name: "测试专辑" },
  dt: 201_000,
};

test("unconfigured Netease provider is blocked and never fetches", async () => {
  let calls = 0;
  const provider = new NeteaseApiProvider({
    env: {},
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({});
    },
  });

  assert.deepEqual(provider.getStatus(), {
    provider: "netease-api",
    configured: false,
    baseUrl: "http://127.0.0.1:3000",
    authenticated: false,
    persistentLogin: false,
    timeoutMs: 8_000,
    state: "blocked_by_configuration",
  });
  await assert.rejects(provider.search("测试"), (error: unknown) => error instanceof ProviderError && error.code === "missing_credentials");
  assert.equal(calls, 0);
});

test("compatibility factory uses the supplied environment", () => {
  const provider = createNeteaseProvider({ NETEASE_API_BASE_URL: "http://127.0.0.1:3000" });
  assert.equal(provider.getStatus().configured, true);
});

test("search encodes input, sends an environment-only Cookie, and parses songs", async () => {
  const secret = "MUSIC_U=private-cookie";
  let requestedUrl = "";
  let requestedCookie = "";
  const provider = new NeteaseApiProvider({
    env: { NETEASE_API_BASE_URL: "http://127.0.0.1:3000/", NETEASE_COOKIE: secret },
    fetchImpl: async (input, init) => {
      requestedUrl = String(input);
      requestedCookie = new Headers(init?.headers).get("cookie") ?? "";
      return jsonResponse({ code: 200, result: { songs: [{ ...song, al: { ...song.al, picUrl: "http://p1.music.126.net/cover.jpg" } }], songCount: 1 } });
    },
  });

  const result = await provider.search("中文 摇滚", { limit: 5, offset: 10 });

  const url = new URL(requestedUrl);
  assert.equal(url.pathname, "/cloudsearch");
  assert.equal(url.searchParams.get("keywords"), "中文 摇滚");
  assert.equal(url.searchParams.get("limit"), "5");
  assert.equal(url.searchParams.get("offset"), "10");
  assert.equal(requestedCookie, secret);
  assert.deepEqual(result, {
    total: 1,
    songs: [{
      id: "42",
      title: "夜航",
      artists: [{ id: "7", name: "测试歌手" }],
      album: { id: "9", name: "测试专辑", coverUrl: "https://p1.music.126.net/cover.jpg" },
      durationMs: 201_000,
    }],
  });
  assert.equal(JSON.stringify(provider.getStatus()).includes(secret), false);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("playlist search uses cloudsearch playlist type and parses public playlists", async () => {
  let requestedUrl = "";
  const provider = new NeteaseApiProvider({
    env: { NETEASE_API_BASE_URL: "http://127.0.0.1:3000/" },
    fetchImpl: async (input) => {
      requestedUrl = String(input);
      return jsonResponse({
        code: 200,
        result: {
          playlistCount: 1,
          playlists: [{
            id: 66,
            name: "电子派对",
            description: "public playlist",
            trackCount: 32,
            creator: { userId: 99 },
            subscribed: false,
          }],
        },
      });
    },
  });

  const result = await provider.searchPlaylists("电子 说唱", { limit: 4, offset: 8 });

  const url = new URL(requestedUrl);
  assert.equal(url.pathname, "/cloudsearch");
  assert.equal(url.searchParams.get("keywords"), "电子 说唱");
  assert.equal(url.searchParams.get("type"), "1000");
  assert.equal(url.searchParams.get("limit"), "4");
  assert.equal(url.searchParams.get("offset"), "8");
  assert.deepEqual(result, {
    total: 1,
    playlists: [{ id: "66", name: "电子派对", description: "public playlist", trackCount: 32, ownerUid: "99", subscribed: false }],
  });
});

test("playlist detail, song detail, and song URL have validated typed results", async () => {
  const paths: string[] = [];
  const provider = new NeteaseApiProvider({
    env: { NETEASE_API_BASE_URL: "http://127.0.0.1:3000" },
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      paths.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/playlist/detail") {
        return jsonResponse({ code: 200, playlist: { id: 3, name: "学习", description: null, trackCount: 1, tracks: [{ ...song, ar: [{ id: 0, name: "未知歌手" }] }] } });
      }
      if (url.pathname === "/song/detail") return jsonResponse({ code: 200, songs: [{ ...song, publishTime: Date.UTC(1998, 0, 1) }] });
      return jsonResponse({ code: 200, data: [{ id: 42, url: "https://music.example/42.mp3", br: 320000, size: 123, type: "mp3", time: 201000, freeTrialInfo: null }] });
    },
  });

  const playlist = await provider.playlistDetail(3);
  const songs = await provider.songDetail([42]);
  const url = await provider.songUrl(42);

  assert.equal(playlist.name, "学习");
  assert.equal(playlist.tracks[0]?.title, "夜航");
  assert.equal(playlist.tracks[0]?.artists[0]?.id, "0");
  assert.equal(songs[0]?.id, "42");
  assert.equal(songs[0]?.releaseYear, 1998);
  assert.deepEqual(url, { id: "42", url: "https://music.example/42.mp3", bitrate: 320000, size: 123, format: "mp3", durationMs: 201000, isTrial: false });
  assert.match(paths[0] ?? "", /^\/playlist\/detail\?id=3$/);
  assert.match(paths[1] ?? "", /^\/song\/detail\?ids=42$/);
  assert.match(paths[2] ?? "", /^\/song\/url\/v1\?id=42&level=standard$/);
});

test("song URL preserves the Netease trial marker", async () => {
  const provider = new NeteaseApiProvider({
    env: { NETEASE_API_BASE_URL: "http://127.0.0.1:3000" },
    fetchImpl: async () => jsonResponse({ code: 200, data: [{ id: 42, url: "https://music.example/42-trial.mp3", br: 128000, size: 480000, type: "mp3", time: 30000, freeTrialInfo: { start: 0, end: 30 } }] }),
  });
  assert.equal((await provider.songUrl(42)).isTrial, true);
});

test("song credits are read from structured lyric metadata", async () => {
  const provider = new NeteaseApiProvider({
    env: { NETEASE_API_BASE_URL: "http://127.0.0.1:3000" },
    fetchImpl: async (input) => {
      assert.equal(new URL(String(input)).pathname, "/lyric/new");
      return jsonResponse({
        code: 200,
        yrc: {
          lyric: [
            JSON.stringify({ t: 0, c: [{ tx: "作词: " }, { tx: "词作者" }] }),
            JSON.stringify({ t: 1_000, c: [{ tx: "作曲：" }, { tx: "曲作者" }] }),
            JSON.stringify({ t: 2_000, c: [{ tx: "编曲: " }, { tx: "编曲甲 / 编曲乙" }] }),
            "[3000,500]歌词正文",
          ].join("\n"),
        },
      });
    },
  });

  assert.deepEqual(await provider.songCredits(42), {
    lyricists: ["词作者"],
    composers: ["曲作者"],
    arrangers: ["编曲甲", "编曲乙"],
  });
});

test("read-only personalization contract maps account, preferences, history, and recommendations", async () => {
  const requests: Array<URL> = [];
  const provider = new NeteaseApiProvider({
    env: { NETEASE_API_BASE_URL: "http://127.0.0.1:3000", NETEASE_COOKIE: "MUSIC_U=private" },
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.pathname === "/user/account") return jsonResponse({ code: 200, account: { id: 88 }, profile: { userId: 88, nickname: "听众" } });
      if (url.pathname === "/user/playlist") return jsonResponse({ code: 200, more: true, playlist: [{ id: 3, name: "学习", description: null, trackCount: 1, userId: 88, subscribed: false }] });
      if (url.pathname === "/likelist") return jsonResponse({ code: 200, ids: [42, "43"] });
      if (url.pathname === "/record/recent/song") return jsonResponse({ code: 200, data: { total: 1, list: [{ resourceId: 42, playTime: 1234, data: song }] } });
      if (url.pathname === "/user/record") {
        return jsonResponse({ code: 200, allData: [{ playCount: 7, score: 99, song }], weekData: [{ playCount: 2, score: 80, song }] });
      }
      if (url.pathname === "/recommend/songs") return jsonResponse({ code: 200, data: { dailySongs: [song] } });
      if (url.pathname === "/personal_fm") return jsonResponse({ code: 200, data: [song] });
      if (url.pathname === "/simi/song") return jsonResponse({ code: 200, songs: [song] });
      throw new Error(`unexpected path ${url.pathname}`);
    },
  });

  assert.deepEqual(await provider.account(), { uid: "88", nickname: "听众" });
  assert.deepEqual(await provider.userPlaylists(88, { limit: 5, offset: 10 }), {
    playlists: [{ id: "3", name: "学习", description: null, trackCount: 1, ownerUid: "88", subscribed: false }],
    more: true,
  });
  assert.deepEqual(await provider.likedSongIds(88), ["42", "43"]);
  assert.deepEqual(await provider.recentSongs({ limit: 2 }), [{ song: {
    id: "42", title: "夜航", artists: [{ id: "7", name: "测试歌手" }], album: { id: "9", name: "测试专辑" }, durationMs: 201_000,
  }, playedAt: 1234 }]);
  assert.deepEqual(await provider.listeningHistory(88), [{ song: {
    id: "42", title: "夜航", artists: [{ id: "7", name: "测试歌手" }], album: { id: "9", name: "测试专辑" }, durationMs: 201_000,
  }, playCount: 7, score: 99 }]);
  assert.deepEqual(await provider.listeningHistory(88, { period: "week" }), [{ song: {
    id: "42", title: "夜航", artists: [{ id: "7", name: "测试歌手" }], album: { id: "9", name: "测试专辑" }, durationMs: 201_000,
  }, playCount: 2, score: 80 }]);
  assert.deepEqual(await provider.dailyRecommendations({ refresh: true }), [{
    id: "42", title: "夜航", artists: [{ id: "7", name: "测试歌手" }], album: { id: "9", name: "测试专辑" }, durationMs: 201_000,
  }]);
  assert.deepEqual(await provider.personalFm(), [{
    id: "42", title: "夜航", artists: [{ id: "7", name: "测试歌手" }], album: { id: "9", name: "测试专辑" }, durationMs: 201_000,
  }]);
  assert.deepEqual(await provider.similarSongs(42, { limit: 3, offset: 1 }), [{
    id: "42", title: "夜航", artists: [{ id: "7", name: "测试歌手" }], album: { id: "9", name: "测试专辑" }, durationMs: 201_000,
  }]);

  assert.equal(requests[0]?.pathname, "/user/account");
  assert.equal(requests[1]?.searchParams.toString(), "uid=88&limit=5&offset=10");
  assert.equal(requests[2]?.searchParams.toString(), "uid=88");
  assert.equal(requests[3]?.searchParams.toString(), "limit=2");
  assert.equal(requests[4]?.searchParams.toString(), "uid=88&type=0");
  assert.equal(requests[5]?.searchParams.toString(), "uid=88&type=1");
  assert.equal(requests[6]?.searchParams.get("afresh"), "true");
  assert.ok(requests[6]?.searchParams.get("timestamp"));
  assert.ok(requests[7]?.searchParams.get("timestamp"));
  assert.equal(requests[8]?.searchParams.toString(), "id=42&limit=3&offset=1");
});

test("personalization rejects anonymous/business failures, malformed payloads, and unsafe boundaries", async () => {
  const businessProvider = new NeteaseApiProvider({
    env: { NETEASE_API_BASE_URL: "http://127.0.0.1:3000" },
    fetchImpl: async () => jsonResponse({ code: 301, message: "需要登录" }),
  });
  await assert.rejects(businessProvider.dailyRecommendations(), (error: unknown) => error instanceof ProviderError && error.code === "business_error");

  const anonymousProvider = new NeteaseApiProvider({
    env: { NETEASE_API_BASE_URL: "http://127.0.0.1:3000", NETEASE_COOKIE: "expired" },
    fetchImpl: async () => jsonResponse({ code: 200, account: { id: 0, anonimousUser: true }, profile: null }),
  });
  await assert.rejects(anonymousProvider.account(), (error: unknown) => error instanceof ProviderError && error.code === "business_error");

  const malformedProvider = new NeteaseApiProvider({
    env: { NETEASE_API_BASE_URL: "http://127.0.0.1:3000" },
    fetchImpl: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/user/account") return jsonResponse({ code: 200, account: {}, profile: { userId: "bad" } });
      if (path === "/user/playlist") return jsonResponse({ code: 200, more: "yes", playlist: [] });
      if (path === "/record/recent/song") return jsonResponse({ code: 200, data: { list: "bad" } });
      return jsonResponse({ code: 200, data: { dailySongs: "bad" } });
    },
  });
  await assert.rejects(malformedProvider.account(), (error: unknown) => error instanceof ProviderError && error.code === "invalid_response");
  await assert.rejects(malformedProvider.userPlaylists(1), (error: unknown) => error instanceof ProviderError && error.code === "invalid_response");
  await assert.rejects(malformedProvider.recentSongs(), (error: unknown) => error instanceof ProviderError && error.code === "invalid_response");
  await assert.rejects(malformedProvider.dailyRecommendations(), (error: unknown) => error instanceof ProviderError && error.code === "invalid_response");

  const provider = new NeteaseApiProvider({ env: { NETEASE_API_BASE_URL: "http://127.0.0.1:3000" }, fetchImpl: async () => jsonResponse({ code: 200, ids: [] }) });
  await assert.rejects(provider.userPlaylists(0), (error: unknown) => error instanceof ProviderError && error.code === "invalid_input");
  await assert.rejects(provider.userPlaylists(1, { limit: 101 }), (error: unknown) => error instanceof ProviderError && error.code === "invalid_input");
  await assert.rejects(provider.likedSongIds("1,2"), (error: unknown) => error instanceof ProviderError && error.code === "invalid_input");
  await assert.rejects(provider.recentSongs({ limit: 0 }), (error: unknown) => error instanceof ProviderError && error.code === "invalid_input");
  await assert.rejects(provider.listeningHistory(1, { period: "month" as "all" }), (error: unknown) => error instanceof ProviderError && error.code === "invalid_input");
  await assert.rejects(provider.dailyRecommendations({ refresh: "true" as unknown as boolean }), (error: unknown) => error instanceof ProviderError && error.code === "invalid_input");
  await assert.rejects(provider.similarSongs(-1), (error: unknown) => error instanceof ProviderError && error.code === "invalid_input");
  await assert.rejects(provider.similarSongs(1, { limit: 101 }), (error: unknown) => error instanceof ProviderError && error.code === "invalid_input");

  const oversizedProvider = new NeteaseApiProvider({
    env: { NETEASE_API_BASE_URL: "http://127.0.0.1:3000" },
    fetchImpl: async () => jsonResponse({ code: 200, ids: Array.from({ length: 10_001 }, (_, index) => index + 1) }),
  });
  await assert.rejects(oversizedProvider.likedSongIds(1), (error: unknown) => error instanceof ProviderError && error.code === "invalid_response");
});

test("health reports readiness without returning upstream identity data", async () => {
  const provider = new NeteaseApiProvider({
    env: { NETEASE_API_BASE_URL: "http://127.0.0.1:3000", NETEASE_COOKIE: "private" },
    fetchImpl: async () => jsonResponse({ data: { code: 200, account: { id: 88 }, profile: { nickname: "private user" } } }),
  });

  const status = await provider.health();

  assert.equal(status.state, "ready");
  assert.equal(status.authenticated, true);
  assert.equal(JSON.stringify(status).includes("private user"), false);
  assert.equal(JSON.stringify(status).includes("88"), false);

  const expiredCookie = new NeteaseApiProvider({
    env: { NETEASE_API_BASE_URL: "http://127.0.0.1:3000", NETEASE_COOKIE: "expired" },
    fetchImpl: async () => jsonResponse({ data: { code: 200, account: { anonymousUser: true }, profile: null } }),
  });
  assert.equal((await expiredCookie.health()).authenticated, false);

  const misspelledAnonymous = new NeteaseApiProvider({
    env: { NETEASE_API_BASE_URL: "http://127.0.0.1:3000", NETEASE_COOKIE: "expired" },
    fetchImpl: async () => jsonResponse({ data: { code: 200, account: { anonimousUser: true }, profile: null } }),
  });
  assert.equal((await misspelledAnonymous.health()).authenticated, false);
});

test("QR login returns an image and keeps an authorized Cookie only in provider memory", async () => {
  const authorizedCookie = "MUSIC_U=qr-authorized-secret";
  const requests: Array<{ path: string; cookie: string }> = [];
  let step = 0;
  const provider = new NeteaseApiProvider({
    env: { NETEASE_API_BASE_URL: "http://127.0.0.1:3000" },
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      requests.push({ path: url.pathname, cookie: new Headers(init?.headers).get("cookie") ?? "" });
      step += 1;
      if (step === 1) return jsonResponse({ code: 200, data: { unikey: "qr-key-1" } });
      if (step === 2) return jsonResponse({ code: 200, data: { qrimg: "data:image/png;base64,aGVsbG8=" } });
      if (step === 3) return jsonResponse({ code: 801, message: "waiting" });
      if (step === 4) return jsonResponse({ code: 803, cookie: authorizedCookie, message: "ok" });
      return jsonResponse({ code: 200, result: { songs: [song], songCount: 1 } });
    },
  });

  const created = await provider.createQrLogin();
  const waiting = await provider.checkQrLogin(created.key);
  assert.equal(provider.getStatus().authenticated, false);
  const authorized = await provider.checkQrLogin(created.key);
  assert.equal(provider.getStatus().authenticated, true);
  await provider.search("测试");

  assert.deepEqual(created, { key: "qr-key-1", qrImageDataUrl: "data:image/png;base64,aGVsbG8=" });
  assert.deepEqual(waiting, { code: 801, state: "waiting_scan" });
  assert.deepEqual(authorized, { code: 803, state: "authorized" });
  assert.deepEqual(requests.map(({ path }) => path), ["/login/qr/key", "/login/qr/create", "/login/qr/check", "/login/qr/check", "/cloudsearch"]);
  assert.equal(requests.slice(0, 4).every(({ cookie }) => cookie === ""), true);
  assert.equal(requests[4]?.cookie, authorizedCookie);
  assert.equal(JSON.stringify(created).includes(authorizedCookie), false);
  assert.equal(JSON.stringify(authorized).includes(authorizedCookie), false);
  assert.equal(JSON.stringify(provider.getStatus()).includes(authorizedCookie), false);
});

test("QR login maps all nonterminal states and rejects malformed success responses", async () => {
  const codes = [800, 802] as const;
  let index = 0;
  const provider = new NeteaseApiProvider({
    env: { NETEASE_API_BASE_URL: "http://127.0.0.1:3000" },
    fetchImpl: async () => jsonResponse({ code: codes[index++] }),
  });

  assert.deepEqual(await provider.checkQrLogin("key"), { code: 800, state: "expired" });
  assert.deepEqual(await provider.checkQrLogin("key"), { code: 802, state: "waiting_confirm" });

  const missingCookie = new NeteaseApiProvider({
    env: { NETEASE_API_BASE_URL: "http://127.0.0.1:3000" },
    fetchImpl: async () => jsonResponse({ code: 803 }),
  });
  await assert.rejects(missingCookie.checkQrLogin("key"), (error: unknown) => error instanceof ProviderError && error.code === "invalid_response");
  assert.equal(missingCookie.getStatus().authenticated, false);
});

test("QR authorization persists only to a permission-restricted local store", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "one-radio-cookie-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const storePath = join(directory, "private", "netease-cookie");
  const cookie = "MUSIC_U=persisted-local-secret";
  const writer = new NeteaseApiProvider({
    env: { NETEASE_API_BASE_URL: "http://127.0.0.1:3000", NETEASE_COOKIE_STORE_PATH: storePath },
    fetchImpl: async () => jsonResponse({ code: 803, cookie }),
  });
  assert.deepEqual(await writer.checkQrLogin("key"), { code: 803, state: "authorized" });
  assert.equal(await readFile(storePath, "utf8"), cookie);
  assert.equal((await stat(storePath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, "private"))).mode & 0o777, 0o700);

  let sentCookie = "";
  const reader = new NeteaseApiProvider({
    env: { NETEASE_API_BASE_URL: "http://127.0.0.1:3000", NETEASE_COOKIE_STORE_PATH: storePath },
    fetchImpl: async (_input, init) => {
      sentCookie = new Headers(init?.headers).get("cookie") ?? "";
      return jsonResponse({ code: 200, result: { songs: [song], songCount: 1 } });
    },
  });
  await reader.search("测试");
  assert.equal(sentCookie, cookie);
  assert.equal(JSON.stringify(reader.getStatus()).includes(cookie), false);
});

test("logout removes only the local NetEase authorization file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "one-radio-netease-logout-"));
  const storePath = join(directory, "cookie");
  await writeFile(storePath, "MUSIC_U=local-secret\n", { mode: 0o600 });
  const provider = new NeteaseApiProvider({
    env: { NETEASE_API_BASE_URL: "http://127.0.0.1:4320", NETEASE_COOKIE_STORE_PATH: storePath },
    fetchImpl: async () => jsonResponse({ data: { code: 200, account: { id: 7 }, profile: { userId: 7 } } }),
  });
  try {
    assert.equal((await provider.health()).authenticated, true);
    const status = await provider.logout();
    assert.equal(status.authenticated, false);
    assert.equal(status.persistentLogin, false);
    await assert.rejects(readFile(storePath, "utf8"), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stored Set-Cookie attributes are normalized before account requests", async () => {
  const rawCookie = "MUSIC_U=account-secret; Max-Age=999; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/; MUSIC_A_T=token-secret; Path=/";
  let sentCookie = "";
  const provider = new NeteaseApiProvider({
    env: { NETEASE_API_BASE_URL: "http://127.0.0.1:3000", NETEASE_COOKIE: rawCookie },
    fetchImpl: async (_input, init) => {
      sentCookie = new Headers(init?.headers).get("cookie") ?? "";
      return jsonResponse({ code: 200, result: { songs: [], songCount: 0 } });
    },
  });
  await provider.search("测试");
  assert.equal(sentCookie, "MUSIC_U=account-secret; MUSIC_A_T=token-secret");
});

test("timeouts and malformed upstream responses are typed failures", async () => {
  const timeoutProvider = new NeteaseApiProvider({
    env: { NETEASE_API_BASE_URL: "http://127.0.0.1:3000" },
    timeoutMs: 5,
    fetchImpl: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }),
  });
  await assert.rejects(timeoutProvider.search("测试"), (error: unknown) => error instanceof ProviderError && error.code === "timeout");

  const malformedProvider = new NeteaseApiProvider({
    env: { NETEASE_API_BASE_URL: "http://127.0.0.1:3000" },
    fetchImpl: async () => jsonResponse({ code: 200, result: { songs: "not-an-array", songCount: 1 } }),
  });
  await assert.rejects(malformedProvider.search("测试"), (error: unknown) => error instanceof ProviderError && error.code === "invalid_response");

  const oversizedProvider = new NeteaseApiProvider({
    env: { NETEASE_API_BASE_URL: "http://127.0.0.1:3000" },
    fetchImpl: async () => new Response("x".repeat(2 * 1024 * 1024 + 1), { status: 200, headers: { "content-type": "application/json" } }),
  });
  await assert.rejects(oversizedProvider.search("测试"), (error: unknown) => error instanceof ProviderError && error.code === "invalid_response");
});

test("credentialed remote HTTP is blocked before Cookie disclosure", async () => {
  let calls = 0;
  const provider = new NeteaseApiProvider({
    env: { NETEASE_API_BASE_URL: "http://music.example", NETEASE_COOKIE: "private-cookie" },
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({});
    },
  });

  assert.equal(provider.getStatus().state, "blocked_by_insecure_transport");
  await assert.rejects(provider.search("测试"), (error: unknown) => error instanceof ProviderError && error.code === "invalid_input");
  assert.equal(calls, 0);
});

test("QR login cannot turn an anonymous remote HTTP provider into a plaintext credential sender", async () => {
  let calls = 0;
  const provider = new NeteaseApiProvider({
    env: { NETEASE_API_BASE_URL: "http://music.example" },
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ code: 803, cookie: "MUSIC_U=must-not-be-sent" });
    },
  });
  await assert.rejects(provider.checkQrLogin("key"), (error: unknown) => error instanceof ProviderError && error.code === "invalid_input");
  assert.equal(calls, 1);
  assert.equal(provider.getStatus().authenticated, false);
});

test("Cookie values with header control characters are rejected before fetching", () => {
  assert.throws(
    () => new NeteaseApiProvider({
      env: { NETEASE_API_BASE_URL: "http://127.0.0.1:3000", NETEASE_COOKIE: "MUSIC_U=ok\r\nx-injected: true" },
      fetchImpl: async () => jsonResponse({}),
    }),
    (error: unknown) => error instanceof ProviderError && error.code === "invalid_input",
  );
});

test("invalid inputs and unsafe playback URLs fail before consumption", async () => {
  const provider = new NeteaseApiProvider({
    env: { NETEASE_API_BASE_URL: "http://127.0.0.1:3000" },
    fetchImpl: async () => jsonResponse({ code: 200, data: [{ id: 42, url: "file:///private/audio.mp3" }] }),
  });

  await assert.rejects(provider.search("  "), (error: unknown) => error instanceof ProviderError && error.code === "invalid_input");
  await assert.rejects(provider.songDetail([]), (error: unknown) => error instanceof ProviderError && error.code === "invalid_input");
  await assert.rejects(provider.songDetail(["1,2"]), (error: unknown) => error instanceof ProviderError && error.code === "invalid_input");
  await assert.rejects(provider.songUrl(42), (error: unknown) => error instanceof ProviderError && error.code === "invalid_response");

  const privateUrlProvider = new NeteaseApiProvider({
    env: { NETEASE_API_BASE_URL: "http://127.0.0.1:3000" },
    fetchImpl: async () => jsonResponse({ code: 200, data: [{ id: 42, url: "http://127.0.0.1/private.mp3" }] }),
  });
  await assert.rejects(privateUrlProvider.songUrl(42), (error: unknown) => error instanceof ProviderError && error.code === "invalid_response");
  for (const unsafeUrl of ["http://[::]/private.mp3", "http://[::1]/private.mp3", "http://[::127.0.0.1]/private.mp3", "http://[fc00::1]/private.mp3", "http://[::ffff:127.0.0.1]/private.mp3"]) {
    const ipv6Provider = new NeteaseApiProvider({
      env: { NETEASE_API_BASE_URL: "http://127.0.0.1:3000" },
      fetchImpl: async () => jsonResponse({ code: 200, data: [{ id: 42, url: unsafeUrl }] }),
    });
    await assert.rejects(ipv6Provider.songUrl(42), (error: unknown) => error instanceof ProviderError && error.code === "invalid_response");
  }
});

test("playlist mutations validate and return normalized typed results", async () => {
  const requests: URL[] = [];
  const provider = new NeteaseApiProvider({
    env: { NETEASE_API_BASE_URL: "http://127.0.0.1:3000" },
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.pathname === "/playlist/create") return jsonResponse({ code: 200, id: 123, playlist: { id: 123 } });
      return jsonResponse({ status: 200, body: { code: 200 } });
    },
  });

  assert.deepEqual(await provider.createPlaylist("  深夜收藏  "), { id: "123", name: "深夜收藏" });
  assert.deepEqual(await provider.addSongsToPlaylist("123", [42, "43", 44]), {
    playlistId: "123",
    trackIds: ["42", "43", "44"],
  });
  assert.deepEqual(await provider.deletePlaylist("123"), { playlistId: "123", deleted: true });
  assert.deepEqual(await provider.setSongLiked(42, true), { trackId: "42", liked: true });
  assert.deepEqual(await provider.setSongLiked(42, false), { trackId: "42", liked: false });
  assert.equal(requests[0]?.pathname, "/playlist/create");
  assert.equal(requests[0]?.searchParams.get("name"), "深夜收藏");
  assert.ok(requests[0]?.searchParams.get("timestamp"));
  assert.equal(requests[1]?.pathname, "/playlist/tracks");
  assert.equal(requests[1]?.searchParams.get("op"), "add");
  assert.equal(requests[1]?.searchParams.get("pid"), "123");
  assert.equal(requests[1]?.searchParams.get("tracks"), "42,43,44");
  assert.ok(requests[1]?.searchParams.get("timestamp"));
  assert.equal(requests[2]?.pathname, "/playlist/delete");
  assert.equal(requests[2]?.searchParams.get("id"), "123");
  assert.equal(requests[3]?.pathname, "/like");
  assert.equal(requests[3]?.searchParams.get("id"), "42");
  assert.equal(requests[3]?.searchParams.get("like"), "true");
  assert.equal(requests[4]?.pathname, "/like");
  assert.equal(requests[4]?.searchParams.get("id"), "42");
  assert.equal(requests[4]?.searchParams.get("like"), "false");
  assert.ok(requests[2]?.searchParams.get("timestamp"));

  const playlistIdProvider = new NeteaseApiProvider({
    env: { NETEASE_API_BASE_URL: "http://127.0.0.1:3000" },
    fetchImpl: async () => jsonResponse({ code: 200, playlist: { id: "124" } }),
  });
  assert.deepEqual(await playlistIdProvider.createPlaylist("另一歌单"), { id: "124", name: "另一歌单" });
});

test("playlist mutations reject business and unauthenticated failures", async () => {
  const createFailure = new NeteaseApiProvider({
    env: { NETEASE_API_BASE_URL: "http://127.0.0.1:3000" },
    fetchImpl: async () => jsonResponse({ code: 301, msg: "需要登录" }),
  });
  await assert.rejects(createFailure.createPlaylist("收藏"), (error: unknown) => error instanceof ProviderError && error.code === "business_error");

  const addFailure = new NeteaseApiProvider({
    env: { NETEASE_API_BASE_URL: "http://127.0.0.1:3000" },
    fetchImpl: async () => jsonResponse({ status: 200, body: { code: 512, msg: "歌单不存在" } }),
  });
  await assert.rejects(addFailure.addSongsToPlaylist(123, [42]), (error: unknown) => error instanceof ProviderError && error.code === "business_error");

  const malformed = new NeteaseApiProvider({
    env: { NETEASE_API_BASE_URL: "http://127.0.0.1:3000" },
    fetchImpl: async () => jsonResponse({ playlist: { id: 123 } }),
  });
  await assert.rejects(malformed.createPlaylist("收藏"), (error: unknown) => error instanceof ProviderError && error.code === "invalid_response");

  const zeroId = new NeteaseApiProvider({
    env: { NETEASE_API_BASE_URL: "http://127.0.0.1:3000" },
    fetchImpl: async () => jsonResponse({ code: 200, id: 0 }),
  });
  await assert.rejects(zeroId.createPlaylist("收藏"), (error: unknown) => error instanceof ProviderError && error.code === "invalid_response");
});

test("playlist mutations reject invalid and duplicate IDs before fetching, and support the 500-item batch", async () => {
  let calls = 0;
  const provider = new NeteaseApiProvider({
    env: { NETEASE_API_BASE_URL: "http://127.0.0.1:3000" },
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ code: 200, id: 999 });
    },
  });

  await assert.rejects(provider.createPlaylist("   "), (error: unknown) => error instanceof ProviderError && error.code === "invalid_input");
  await assert.rejects(provider.createPlaylist(42 as unknown as string), (error: unknown) => error instanceof ProviderError && error.code === "invalid_input");
  await assert.rejects(provider.addSongsToPlaylist(0, [1]), (error: unknown) => error instanceof ProviderError && error.code === "invalid_input");
  await assert.rejects(provider.addSongsToPlaylist(1, []), (error: unknown) => error instanceof ProviderError && error.code === "invalid_input");
  await assert.rejects(provider.addSongsToPlaylist(1, [1, "1"]), (error: unknown) => error instanceof ProviderError && error.code === "invalid_input");
  await assert.rejects(provider.addSongsToPlaylist(1, Array.from({ length: 501 }, (_, index) => index + 1)), (error: unknown) => error instanceof ProviderError && error.code === "invalid_input");
  await assert.rejects(provider.addSongsToPlaylist(1, ["1,2"]), (error: unknown) => error instanceof ProviderError && error.code === "invalid_input");
  assert.equal(calls, 0);

  let requestedTracks = "";
  const batchProvider = new NeteaseApiProvider({
    env: { NETEASE_API_BASE_URL: "http://127.0.0.1:3000" },
    fetchImpl: async (input) => {
      requestedTracks = new URL(String(input)).searchParams.get("tracks") ?? "";
      return jsonResponse({ code: 200 });
    },
  });
  const trackIds = Array.from({ length: 500 }, (_, index) => index + 1);
  const result = await batchProvider.addSongsToPlaylist(7, trackIds);
  assert.equal(result.trackIds.length, 500);
  assert.equal(requestedTracks, trackIds.join(","));
});
