import test from "node:test";
import assert from "node:assert/strict";

import { researchPublicMusicFacts } from "../src/server/public-music-research.js";

function wikiResponse(pageCount: number): Response {
  return new Response(JSON.stringify({
    query: {
      pages: Array.from({ length: pageCount }, (_, index) => ({
        pageid: 100 + index,
        title: `音乐资料 ${index + 1}`,
        fullurl: `https://zh.wikipedia.org/wiki/music_${index + 1}`,
        extract: `方大同、Tom Misch、可用艺人的公开音乐资料，包含创作风格、职业经历与作品信息，用来帮助主持人写出有事实密度的自然口播。${index + 1}`,
      })),
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

test("public research uses Chinese and English Wikimedia endpoints and preserves source evidence", async () => {
  const urls: string[] = [];
  const facts = await researchPublicMusicFacts([
    { title: "二人游", artist: "方大同", exploration: true },
    { title: "Cinnamon Curls", artist: "Tom Misch", exploration: false },
  ], {
    fetchImpl: async (input) => {
      urls.push(String(input));
      return wikiResponse(String(input).includes("zh.wikipedia.org") ? 2 : 1);
    },
  });

  assert.equal(urls.length, 2);
  assert.match(urls[0]!, /^https:\/\/zh\.wikipedia\.org/);
  assert.match(urls[1]!, /^https:\/\/en\.wikipedia\.org/);
  assert.equal(facts.length, 3);
  assert.ok(facts.every((fact) => /^web:[A-Za-z0-9_-]+$/.test(fact.id)));
  assert.ok(facts.every((fact) => fact.sourceUrl.startsWith("https://")));
  assert.match(facts[0]!.value, /《二人游》\/ 方大同 公开资料/);
  assert.match(facts[2]!.value, /《Cinnamon Curls》\/ Tom Misch 公开资料/);
});

test("public research isolates failed tracks and forwards cancellation signals", async () => {
  const signals: AbortSignal[] = [];
  const facts = await researchPublicMusicFacts([
    { title: "失败歌曲", artist: "失败艺人", exploration: true },
    { title: "可用歌曲", artist: "可用艺人", exploration: false },
  ], {
    fetchImpl: async (input, init) => {
      signals.push(init?.signal as AbortSignal);
      if (String(input).includes(encodeURIComponent("失败歌曲"))) throw new Error("network failure");
      return wikiResponse(1);
    },
  });

  assert.equal(signals.length, 2);
  assert.equal(facts.length, 1);
  assert.match(facts[0]!.value, /可用歌曲/);
  assert.ok(signals.every(Boolean));
});

test("public research respects the twelve-track request cap", async () => {
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
  assert.equal(calls, 12);
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
