import test from "node:test";
import assert from "node:assert/strict";

import { MusicResearchService, researchPublicMusicFacts, researchPublicMusicReport } from "../src/server/public-music-research.js";
import { requireCompletedMusicResearch } from "../src/shared/music-research.js";

function wikiResponse(pageCount: number, artist = "方大同"): Response {
  return new Response(JSON.stringify({
    query: {
      pages: Array.from({ length: pageCount }, (_, index) => ({
        pageid: 100 + index,
        title: index === 0 ? artist : `${artist} (musician)`,
        fullurl: `https://zh.wikipedia.org/wiki/music_${index + 1}`,
        extract: `方大同、Tom Misch、可用艺人的公开音乐资料，包含创作风格、职业经历与作品信息，用来帮助主持人写出有事实密度的自然口播。${index + 1}`,
      })),
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

test("sparse song research expands to album and artist and records completed empty searches", async () => {
  const queries: string[] = [];
  const tracks = [{ title: "二人游", artist: "方大同", album: "橙月" }];
  const report = await researchPublicMusicReport(tracks, { fetchImpl: async (input) => {
    queries.push(new URL(String(input)).searchParams.get("gsrsearch")!);
    return new Response(JSON.stringify({ batchcomplete: true }));
  } });
  assert.deepEqual(queries, ['"二人游" "方大同"', '"橙月" "方大同"', '"方大同"']);
  assert.equal(report.tracks[0]?.status, "no_results");
  assert.doesNotThrow(() => requireCompletedMusicResearch(report, tracks));
});

test("finding song metadata still researches the album concept and artist awards with separate sources", async () => {
  const queries: string[] = [];
  const track = { title: "新歌", artist: "测试歌手", album: "新专辑" };
  const subjects = ["新歌", "新专辑", "测试歌手"];
  const extracts = [
    "新歌由测试歌手演唱，收录于新专辑。这份歌曲资料只有曲目身份和发行记录，没有提到这首歌的创作故事、制作理念或者获奖经历。",
    "新专辑是测试歌手以城市生活为主题制作的专辑，使用爵士与流行音乐的元素来串联不同阶段的生活片段，作品围绕一个完整概念展开。",
    "测试歌手是一位创作歌手，曾在2020年获得某音乐奖的最佳歌手奖，这是授予歌手的个人奖项，不能因此推断新歌或新专辑获得了这个奖。",
  ];
  const report = await researchPublicMusicReport([track], { fetchImpl: async (input) => {
    const index = queries.length;
    queries.push(new URL(String(input)).searchParams.get("gsrsearch")!);
    return new Response(JSON.stringify({ query: { pages: [{ pageid: index + 1, title: subjects[index], extract: extracts[index], fullurl: `https://example.com/music/${index}` }] } }));
  } });
  assert.deepEqual(queries, ['"新歌" "测试歌手"', '"新专辑" "测试歌手"', '"测试歌手"']);
  const receipt = requireCompletedMusicResearch(report, [track]).tracks[0]!;
  assert.equal(receipt.facts.length, 3);
  assert.match(receipt.facts[1]!.value, /资料页面《新专辑》.*完整概念/);
  assert.match(receipt.facts[2]!.value, /资料页面《测试歌手》.*2020年/);
  assert.equal(new Set(receipt.facts.map((fact) => fact.sourceUrl)).size, 3);
});

test("a failed background query remains incomplete even when the song page was found", async () => {
  let calls = 0;
  const tracks = [{ title: "新歌", artist: "方大同", album: "橙月" }];
  const report = await researchPublicMusicReport(tracks, { fetchImpl: async () => ++calls === 1 ? wikiResponse(1) : new Response("unavailable", { status: 503 }) });
  assert.equal(report.tracks[0]?.facts.length, 1);
  assert.equal(report.tracks[0]?.status, "failed");
  assert.throws(() => requireCompletedMusicResearch(report, tracks));
});

test("disambiguation lists are not facts even when the title and artist match", async () => {
  const report = await researchPublicMusicReport([{ title: "稻香", artist: "周杰伦" }], { fetchImpl: async () => new Response(JSON.stringify({ query: { pages: [{
    pageid: 1, title: "稻香", fullurl: "https://example.com/disambiguation", extract: "稻香可以指：周杰伦的歌曲、其他音乐人的同名歌曲，以及不同城市中的餐厅名称。这是多个不同主题的列表，并不是有关当前歌曲的事实介绍。",
  }] } })) });
  assert.equal(report.tracks[0]?.status, "no_results");
  assert.deepEqual(report.tracks[0]?.facts, []);
});

test("research resumes failed songs without repeating completed work or stopping after four facts", async () => {
  const queries: string[] = [];
  let failing = true;
  const tracks = Array.from({ length: 14 }, (_, index) => ({ title: `歌曲${index}`, artist: "方大同" }));
  const service = new MusicResearchService({ fetchImpl: async (input) => {
    const query = new URL(String(input)).searchParams.get("gsrsearch")!;
    queries.push(query);
    if (query.includes('"歌曲13"') && failing) return new Response("unavailable", { status: 503 });
    return wikiResponse(2);
  } });
  const failed = await service.research(tracks);
  assert.equal(queries.length, 28);
  assert.equal(failed.tracks[13]?.status, "failed");
  assert.throws(() => requireCompletedMusicResearch(failed, tracks), /第 14 首/);
  failing = false;
  queries.length = 0;
  const recovered = requireCompletedMusicResearch(await service.research(tracks), tracks);
  assert.equal(queries.length, 2);
  assert.equal(recovered.tracks.flatMap((track) => track.facts).length, 28);
  assert.ok(recovered.tracks.every((track) => track.attempts.length > 0));
  recovered.tracks[0]!.facts.length = 0;
  assert.equal((await service.research(tracks)).tracks[0]?.facts.length, 2, "caller mutations cannot corrupt cached evidence");
});

test("HTTP failures, invalid JSON, and API business errors never count as no-results research", async () => {
  const tracks = [{ title: "二人游", artist: "方大同" }];
  for (const response of [() => new Response("bad", { status: 429 }), () => new Response("<html>error</html>"), () => new Response(JSON.stringify({ error: { code: "ratelimited" } })), () => new Response("{}")]) {
    let calls = 0;
    const report = await researchPublicMusicReport(tracks, { fetchImpl: async () => { calls++; return response(); } });
    assert.equal(calls, 2);
    assert.equal(report.tracks[0]?.status, "failed");
    assert.throws(() => requireCompletedMusicResearch(report, tracks));
  }
  await assert.rejects(researchPublicMusicFacts(tracks, { fetchImpl: async () => new Response("bad", { status: 503 }) }));
});

test("research cancellation stops retries and never yields completed receipts", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(researchPublicMusicReport([{ title: "二人游", artist: "方大同" }], {
    signal: controller.signal,
    fetchImpl: async () => { calls++; controller.abort(); throw new Error("aborted"); },
  }));
  assert.equal(calls, 1);
});

test("research receipts must cover the exact songs and retain evidence for each fact", async () => {
  const tracks = [{ title: "二人游", artist: "方大同" }];
  const report = await researchPublicMusicReport(tracks, { fetchImpl: async () => wikiResponse(1) });
  assert.throws(() => requireCompletedMusicResearch([], tracks));
  assert.throws(() => requireCompletedMusicResearch(report, [{ ...tracks[0]!, artist: "其他歌手" }]));
  const missingEvidence = structuredClone(report);
  for (const attempt of missingEvidence.tracks[0]!.attempts) attempt.sourceUrls = [];
  assert.throws(() => requireCompletedMusicResearch(missingEvidence, tracks));
});

test("a same-named film mentioning the artist cannot become a song fact", async () => {
  const report = await researchPublicMusicReport([{ title: "Yesterday", artist: "The Beatles" }], {
    fetchImpl: async () => new Response(JSON.stringify({ query: { pages: [
      { pageid: 1, title: "Yesterday (2019 film)", fullurl: "https://en.wikipedia.org/wiki/Yesterday_(2019_film)", extract: "Yesterday is a film featuring the music of The Beatles, with a fictional story and characters that must not be treated as the history of a song." },
      { pageid: 2, title: "Yesterday (Beatles song)", fullurl: "https://en.wikipedia.org/wiki/Yesterday_(song)", extract: "Yesterday is a song by The Beatles. The recording features Paul McCartney with a string quartet and was released on the album Help! in 1965." },
    ] } })),
  });
  assert.equal(report.tracks[0]?.facts.length, 1);
  assert.equal(report.tracks[0]?.facts[0]?.sourceUrl, "https://en.wikipedia.org/wiki/Yesterday_(song)");
  assert.equal(report.tracks[0]?.attempts[0]?.sourceUrls.length, 2, "record inspected pages even when rejected as evidence");
});

test("a query timeout is retried once and blocks research instead of returning an empty success", async () => {
  let calls = 0;
  const report = await researchPublicMusicReport([{ title: "二人游", artist: "方大同" }], {
    timeoutMs: 5,
    fetchImpl: async (_input, init) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("timeout")), { once: true }));
    },
  });
  assert.equal(calls, 2);
  assert.equal(report.tracks[0]?.status, "failed");
});

test("public research uses Chinese and English Wikimedia endpoints and preserves source evidence", async () => {
  const urls: string[] = [];
  const facts = await researchPublicMusicFacts([
    { title: "二人游", artist: "方大同", exploration: true },
    { title: "Cinnamon Curls", artist: "Tom Misch", exploration: false },
  ], {
    fetchImpl: async (input) => {
      urls.push(String(input));
      return String(input).includes("zh.wikipedia.org") ? wikiResponse(2) : wikiResponse(1, "Tom Misch");
    },
  });

  assert.equal(urls.length, 4);
  assert.match(urls[0]!, /^https:\/\/zh\.wikipedia\.org/);
  assert.match(urls[1]!, /^https:\/\/en\.wikipedia\.org/);
  assert.equal(facts.length, 3);
  assert.ok(facts.every((fact) => /^web:[A-Za-z0-9_-]+$/.test(fact.id)));
  assert.ok(facts.every((fact) => fact.sourceUrl.startsWith("https://")));
  assert.match(facts[0]!.value, /资料页面《方大同》/);
  assert.doesNotMatch(facts[2]!.value, /《Cinnamon Curls》/);
  assert.equal(new Set(facts.map((fact) => fact.id)).size, facts.length);
});

test("public research isolates failed tracks and forwards cancellation signals", async () => {
  const signals: AbortSignal[] = [];
  const report = await researchPublicMusicReport([
    { title: "失败歌曲", artist: "失败艺人", exploration: true },
    { title: "可用歌曲", artist: "可用艺人", exploration: false },
  ], {
    fetchImpl: async (input, init) => {
      signals.push(init?.signal as AbortSignal);
      if (String(input).includes(encodeURIComponent("失败歌曲"))) throw new Error("network failure");
      return wikiResponse(1, "可用艺人");
    },
  });

  assert.equal(signals.length, 4);
  assert.equal(report.tracks[0]?.status, "failed");
  assert.equal(report.tracks[1]?.status, "researched");
  assert.equal(report.tracks[1]?.facts.length, 1);
  assert.ok(signals.every(Boolean));
});

test("public research covers songs beyond twelve without a global fact cap", async () => {
  let calls = 0;
  await researchPublicMusicFacts(Array.from({ length: 20 }, (_, index) => ({
    title: `歌曲${index}`,
    artist: "方大同",
  })), {
    fetchImpl: async () => {
      calls += 1;
      return wikiResponse(1);
    },
  });
  assert.equal(calls, 40);
});

test("public research rejects pages that do not mention the complete artist name", async () => {
  const facts = await researchPublicMusicFacts([
    { title: "Tear", artist: "Rich Brian", exploration: true },
  ], {
    fetchImpl: async () => new Response(JSON.stringify({ query: { pages: [{
      pageid: 10,
      title: "Brian May",
      fullurl: "https://en.wikipedia.org/wiki/Brian_May",
      extract: "Brian May is an English musician whose long career includes performance, songwriting, production and extensive public recognition.",
    }] } }), { status: 200 }),
  });
  assert.deepEqual(facts, []);
});

test("public research does not match a short artist name inside an unrelated word", async () => {
  const facts = await researchPublicMusicFacts([{ title: "FOGGY", artist: "DEN", exploration: true }], {
    fetchImpl: async () => new Response(JSON.stringify({ query: { pages: [{
      pageid: 11,
      title: "Fog",
      fullurl: "https://en.wikipedia.org/wiki/Fog",
      extract: "Fog can be considered a type of low-lying cloud, and this article describes its physical formation in enough detail for a long encyclopedia introduction.",
    }] } }), { status: 200 }),
  });
  assert.deepEqual(facts, []);
});
