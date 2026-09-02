import test from "node:test";
import assert from "node:assert/strict";

import type { HostContextPack } from "../src/shared/contracts.js";
import {
  buildHostPrompt,
  OpenAICompatibleHostProvider,
  QwenTtsProvider,
} from "../src/providers/index.js";
import { findBusinessFailure, httpError, safeUpstreamMessage } from "../src/providers/http.js";

const NOW = new Date("2026-01-02T03:04:05.000Z");

function context(overrides: Partial<HostContextPack> = {}): HostContextPack {
  return {
    scenePreset: "study",
    programPhase: "building",
    timeRemainingSeconds: 900,
    previousTrack: null,
    currentTrack: {
      id: "fixture-01",
      title: "First Light",
      artist: "North Window",
      durationSeconds: 214,
      energy: 0.32,
      mood: ["calm"],
      color: "#8FA7B8",
      audioUrl: "http://127.0.0.1:9999/private-audio",
    },
    nextTrack: null,
    transitionReason: "continuing the selected program arc",
    recentHostLines: [],
    allowedFacts: [{ id: "track:fixture-01:title", value: "Title: First Light", source: "fixture" }],
    forbiddenClaims: ["Do not infer private listener facts."],
    ...overrides,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("host writer prompt prioritizes artist background and classic stories over routine credits", () => {
  const prompt = buildHostPrompt(context());

  assert.match(prompt.system, /音乐人/);
  assert.match(prompt.system, /经典歌曲优先说明/);
  assert.match(prompt.system, /作词、作曲、编曲和制作人名单不是默认口播材料/);
});

test("a host provider without a key degrades to deterministic mock without fetching", async () => {
  let calls = 0;
  const provider = new OpenAICompatibleHostProvider({
    apiKey: "",
    now: () => NOW,
    fetchImpl: async () => {
      calls += 1;
      throw new Error("network must not be used by the no-key path");
    },
  });

  const result = await provider.generate(context());

  assert.equal(calls, 0);
  assert.equal(result.status, "mock");
  assert.equal(result.configured, false);
  assert.equal(result.mock, true);
  assert.equal(result.success, true);
  assert.equal(result.apiMode, "mock");
  assert.equal(result.generatedAt, NOW.toISOString());
  assert.equal(result.text, "[mock] study/building");
});

test("a TTS provider without a key is explicit and does not fabricate audio", async () => {
  let calls = 0;
  const provider = new QwenTtsProvider({
    apiKey: "",
    fetchImpl: async () => {
      calls += 1;
      throw new Error("network must not be used by the no-key path");
    },
  });

  const result = await provider.synthesize({ text: "现在开始。", scenePreset: "study" });

  assert.equal(calls, 0);
  assert.equal(result.status, "disabled");
  assert.equal(result.configured, false);
  assert.equal(result.mock, true);
  assert.equal(result.success, false);
  assert.equal(result.error?.code, "missing_credentials");
  assert.equal(result.audio, null);
  assert.equal(result.buffer, null);
  assert.equal(result.model, "qwen3-tts-instruct-flash");
  assert.equal(result.voice, "Elias");
  assert.equal(result.language, "Chinese");
});

test("host output may reference only facts in allowedFacts", async () => {
  const provider = new OpenAICompatibleHostProvider({
    apiKey: "unit-test-key",
    mode: "chat_completions",
    fetchImpl: async () => jsonResponse({
      choices: [{ message: { content: JSON.stringify({ text: "这首歌适合现在的节奏。", factIds: ["not-allowed"] }) } }],
    }),
  });

  const result = await provider.generate(context());

  assert.equal(result.success, false);
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "invalid_facts");
});

const reviewedCandidates = (label: string) => ({
  candidates: [
    { angle: `${label}创作`, text: `${label}从创作背景进入，说明作品为什么会在这个阶段出现。现在听 North Window 的《First Light》。`, factIds: ["track:fixture-01:title"], deliveryInstruction: "自然交流，歌名重读。" },
    { angle: `${label}人物`, text: `${label}先认识音乐人，再把这首作品放回他的创作阶段。North Window 带来《First Light》。`, factIds: ["track:fixture-01:title"], deliveryInstruction: "中速，前句平实，歌名收稳。" },
    { angle: `${label}直入`, text: `${label}不绕弯，直接把这首歌交代清楚：North Window 的《First Light》，现在开始。`, factIds: ["track:fixture-01:title"], deliveryInstruction: "简洁直接，句尾自然落下。" },
  ],
});

test("reviewed host generation uses a separate producer request before selecting a draft", async () => {
  const bodies: Array<{ messages?: Array<{ role: string; content: string }> }> = [];
  const responses = [
    reviewedCandidates("第一轮"),
    { approved: true, selectedIndex: 1, issues: [], rationale: "人物角度最适合当前探索段落。" },
  ];
  const provider = new OpenAICompatibleHostProvider({
    apiKey: "unit-test-key",
    mode: "chat_completions",
    fetchImpl: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as { messages?: Array<{ role: string; content: string }> });
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(responses.shift()) } }] });
    },
  });

  const result = await provider.generate(context({ skillInstruction: "主持人撰稿契约", reviewInstruction: "节目监制审核契约" }));

  assert.equal(result.success, true);
  assert.match(result.text, /先认识音乐人/);
  assert.equal(bodies.length, 2);
  assert.match(bodies[0]?.messages?.[0]?.content ?? "", /主持人撰稿契约/);
  assert.match(bodies[1]?.messages?.[0]?.content ?? "", /节目监制审核契约/);
  assert.match(bodies[1]?.messages?.[1]?.content ?? "", /candidates/);
});

test("producer rejection is returned to the writer for one final rewrite without another review", async () => {
  const bodies: Array<{ messages?: Array<{ role: string; content: string }> }> = [];
  const responses = [
    reviewedCandidates("初稿"),
    { approved: false, selectedIndex: null, issues: ["三个候选都是报歌，没有提供不同的信息中心。"], rationale: "听众没有获得新的内容。" },
    { text: "重写后先把音乐人讲清楚，再自然落到 North Window 的《First Light》，这次不绕弯，直接把歌交给你。", factIds: ["track:fixture-01:title"], deliveryInstruction: "年轻自然，歌名说清楚。" },
  ];
  const provider = new OpenAICompatibleHostProvider({
    apiKey: "unit-test-key",
    mode: "chat_completions",
    fetchImpl: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as { messages?: Array<{ role: string; content: string }> });
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(responses.shift()) } }] });
    },
  });

  const result = await provider.generate(context({ skillInstruction: "主持人撰稿契约", reviewInstruction: "节目监制审核契约" }));

  assert.equal(result.success, true);
  assert.match(result.text, /重写后/);
  assert.equal(bodies.length, 3);
  assert.match(bodies[2]?.messages?.[1]?.content ?? "", /三个候选都是报歌/);
  assert.match(bodies[2]?.messages?.[0]?.content ?? "", /不再返回 candidates/);
  assert.match(bodies[2]?.messages?.[1]?.content ?? "", /finalRound/);
});

test("whole-show generation and review use gpt-5.5 with high reasoning without an internal timeout", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const requestSignals: Array<AbortSignal | null | undefined> = [];
  const longText = (label: string) => `${label}这首作品把音乐人的创作背景和声音方向放在一起讲清楚，也把作品来路交代完整，接下来听音乐本身怎样展开。`;
  const draft = {
    frequency: "low",
    breaks: [
      { id: "break-01", beforeTrackIndex: 1, type: "opening", targetSeconds: 22, text: longText("开场"), sourceIds: ["track:1:metadata"], deliveryInstruction: "自然，中速。" },
      { id: "break-02", beforeTrackIndex: 2, type: "middle", targetSeconds: 25, text: longText("中段"), sourceIds: ["track:2:metadata"], deliveryInstruction: "自然，中速。" },
      { id: "break-03", beforeTrackIndex: 3, type: "closing", targetSeconds: 30, text: `这是今天的最后一首。${longText("收尾")}`, sourceIds: ["track:3:metadata"], deliveryInstruction: "自然，中速。" },
    ],
  };
  const responses = [draft, { approved: true, issues: [], rationale: "整档可播。" }];
  const provider = new OpenAICompatibleHostProvider({
    apiKey: "unit-test-key",
    model: "gpt-5.5",
    reviewModel: "gpt-5.5",
    reasoningEffort: "high",
    mode: "responses",
    timeoutMs: 0,
    fetchImpl: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      requestSignals.push(init?.signal);
      return jsonResponse({ output_text: JSON.stringify(responses.shift()) });
    },
  });
  const tracks = [1, 2, 3].map((id) => ({
    trackIndex: id,
    title: `歌曲${id}`,
    artist: `音乐人${id}`,
    exploration: false,
    allowedFacts: [{ id: `track:${id}:metadata`, value: `歌曲${id}由音乐人${id}演唱。`, source: "user" as const }],
  }));

  const controller = new AbortController();
  const result = await provider.generateShow({ scenePreset: "study", frequency: "low", tracks, skillInstruction: "整档撰稿契约", reviewInstruction: "整档监制契约" }, { signal: controller.signal });

  assert.equal(result.success, true);
  assert.equal(provider.getStatus().timeoutMs, 0);
  assert.equal(result.breaks.length, 3);
  assert.equal(bodies.length, 2);
  assert.ok(requestSignals.every((signal) => signal === controller.signal));
  assert.ok(bodies.every((body) => body.model === "gpt-5.5"));
  assert.ok(bodies.every((body) => (body.reasoning as { effort?: string }).effort === "high"));
  assert.match(JSON.stringify(bodies[0]), /整档撰稿契约/);
  assert.match(JSON.stringify(bodies[1]), /整档监制契约/);
  assert.ok(bodies.every((body) => /musicAtmosphere.*专注/.test(JSON.stringify(body))));
  assert.ok(bodies.every((body) => /hostLanguageDirection/.test(JSON.stringify(body))));
  assert.ok(bodies.every((body) => /ttsDirection/.test(JSON.stringify(body))));
});

test("whole-show copy accepts natural duration estimates and repairs unknown source ids", async () => {
  const draft = {
    frequency: "low",
    breaks: [
      { id: "break-01", beforeTrackIndex: 1, type: "opening", targetSeconds: 15, text: "晚上好，先从音乐人一的《歌曲一》开始。", sourceIds: ["track:1:metadata"], deliveryInstruction: "自然。" },
      { id: "break-02", beforeTrackIndex: 2, type: "middle", targetSeconds: 18, text: "接下来是音乐人二的《歌曲二》，这首歌发行于二〇一七年，换了一种更松弛的声音。", sourceIds: ["mistyped:web-source"], deliveryInstruction: "自然。" },
      { id: "break-03", beforeTrackIndex: 3, type: "closing", targetSeconds: 27, text: "今天的最后一首留给音乐人三的《歌曲三》。", sourceIds: [], deliveryInstruction: "自然。" },
    ],
  };
  const responses = [draft, { approved: true, issues: [], rationale: "整档可播。" }];
  const provider = new OpenAICompatibleHostProvider({
    apiKey: "unit-test-key",
    model: "gpt-5.5",
    reviewModel: "gpt-5.5",
    reasoningEffort: "high",
    mode: "responses",
    fetchImpl: async () => jsonResponse({ output_text: JSON.stringify(responses.shift()) }),
  });
  const tracks = [1, 2, 3].map((id) => ({
    trackIndex: id,
    title: `歌曲${id}`,
    artist: `音乐人${id}`,
    exploration: id === 2,
    allowedFacts: [{ id: `track:${id}:metadata`, value: `歌曲${id}由音乐人${id}演唱。`, source: "user" as const }],
  }));

  const result = await provider.generateShow({ scenePreset: "study", frequency: "low", openingGreeting: "下午好", tracks, skillInstruction: "整档撰稿契约", reviewInstruction: "整档监制契约" });

  assert.equal(result.fallback, undefined);
  assert.match(result.breaks[0]?.text ?? "", /^下午好，欢迎收听 Open Music Radio 电台，我是主持人龙浩。/);
  assert.doesNotMatch(result.breaks[0]?.text ?? "", /晚上好/);
  assert.deepEqual(result.breaks.map((item) => item.targetSeconds), [15, 18, 27]);
  assert.match(result.breaks[1]?.text ?? "", /2017年/);
  assert.doesNotMatch(result.breaks[1]?.text ?? "", /二[〇零]一七年/);
  assert.deepEqual(result.breaks[1]?.sourceIds, ["track:2:metadata"]);
  assert.deepEqual(result.breaks[2]?.sourceIds, ["track:3:metadata"]);
});

test("whole-show middle review stops after two rewrites and returns the final draft", async () => {
  const makeDraft = (label: string) => ({
    frequency: "low",
    breaks: [
      { id: "break-01", beforeTrackIndex: 1, type: "opening", targetSeconds: 18, text: "下午好，先从音乐人一的《歌曲一》开始。", sourceIds: ["track:1:metadata"], deliveryInstruction: "自然。" },
      { id: "break-02", beforeTrackIndex: 3, type: "middle", targetSeconds: 24, text: `${label}，接下来听音乐人三的《歌曲三》，这段介绍把音乐人的背景和作品线索放在一起。`, sourceIds: ["track:3:metadata"], deliveryInstruction: "自然。" },
      { id: "break-03", beforeTrackIndex: 4, type: "closing", targetSeconds: 22, text: "这是今天的最后一首，音乐人四的《歌曲四》。", sourceIds: ["track:4:metadata"], deliveryInstruction: "自然。" },
    ],
  });
  const bodies: Array<Record<string, unknown>> = [];
  const responses = [
    makeDraft("初稿"),
    { approved: false, issues: [{ breakId: "middle", problem: "中段句式重复", direction: "整组减少模板开头，增加音乐人背景。" }], rationale: "中段不够自然。" },
    makeDraft("第一次修改"),
    { approved: false, issues: [{ breakId: "middle", problem: "中段信息仍少", direction: "保留一条清楚的音乐信息主线。" }], rationale: "还需要修改。" },
    makeDraft("第二次最终修改"),
  ];
  const provider = new OpenAICompatibleHostProvider({
    apiKey: "unit-test-key",
    mode: "responses",
    fetchImpl: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse({ output_text: JSON.stringify(responses.shift()) });
    },
  });
  const tracks = [1, 2, 3, 4].map((id) => ({
    trackIndex: id,
    title: `歌曲${id}`,
    artist: `音乐人${id}`,
    exploration: id === 3,
    allowedFacts: [{ id: `track:${id}:metadata`, value: `歌曲《歌曲${id}》，艺术家是音乐人${id}。`, source: "user" as const }],
  }));

  const result = await provider.generateShow({ scenePreset: "study", frequency: "low", openingGreeting: "下午好", tracks, skillInstruction: "整档撰稿契约", reviewInstruction: "整档监制契约" });

  assert.equal(result.success, true);
  assert.equal(result.breaks.length, 3);
  assert.match(result.breaks[1]?.text ?? "", /第二次最终修改/);
  assert.equal(bodies.length, 5);
  assert.match(JSON.stringify(bodies[1]), /reviewScope/);
  assert.match(JSON.stringify(bodies[4]), /finalRound.*true/);
});

test("whole-show generation retries one malformed stage before returning the reviewed copy", async () => {
  let calls = 0;
  const draft = {
    frequency: "low",
    breaks: [
      { id: "break-01", beforeTrackIndex: 1, type: "opening", targetSeconds: 20, text: "晚上好，先从音乐人一的《歌曲一》开始，听听这位创作者如何展开今天的第一段声音。", sourceIds: ["track:1:metadata"], deliveryInstruction: "自然，中速。" },
      { id: "break-02", beforeTrackIndex: 2, type: "middle", targetSeconds: 22, text: "接下来听音乐人二的《歌曲二》，这首作品把他的创作方向交代得很清楚。", sourceIds: ["track:2:metadata"], deliveryInstruction: "自然，中速。" },
      { id: "break-03", beforeTrackIndex: 3, type: "closing", targetSeconds: 24, text: "这是今天的最后一首，音乐人三的《歌曲三》，最后把时间留给音乐本身。", sourceIds: ["track:3:metadata"], deliveryInstruction: "自然，中速。" },
    ],
  };
  const provider = new OpenAICompatibleHostProvider({
    apiKey: "unit-test-key",
    mode: "responses",
    fetchImpl: async () => {
      calls += 1;
      const payload = calls === 1 ? { unexpected: true } : calls === 2 ? draft : { approved: true, issues: [], rationale: "可播。" };
      return jsonResponse({ output_text: JSON.stringify(payload) });
    },
  });
  const tracks = [1, 2, 3].map((id) => ({
    trackIndex: id,
    title: `歌曲${id}`,
    artist: `音乐人${id}`,
    exploration: false,
    allowedFacts: [{ id: `track:${id}:metadata`, value: `歌曲《歌曲${id}》，艺术家是音乐人${id}。`, source: "user" as const }],
  }));

  const result = await provider.generateShow({ scenePreset: "study", frequency: "low", openingGreeting: "晚上好", hostProfile: "anya", tracks, skillInstruction: "整档撰稿契约", reviewInstruction: "整档监制契约" });

  assert.equal(result.fallback, undefined);
  assert.equal(result.breaks.length, 3);
  assert.match(result.breaks[0]?.text ?? "", /^晚上好，欢迎收听 Open Music Radio 电台，我是主持人龙安雅。/);
  assert.equal(calls, 3);
});

test("whole-show generation failure is explicit and never returns automatic fallback copy", async () => {
  const provider = new OpenAICompatibleHostProvider({
    apiKey: "unit-test-key",
    mode: "responses",
    timeoutMs: 0,
    fetchImpl: async () => { throw new Error("upstream unavailable"); },
  });
  const result = await provider.generateShow({
    scenePreset: "study",
    frequency: "medium",
    tracks: [{
      trackIndex: 1,
      title: "歌曲一",
      artist: "音乐人一",
      exploration: false,
      allowedFacts: [{ id: "track:1:metadata", value: "歌曲《歌曲一》，艺术家是音乐人一。", source: "user" }],
    }],
    skillInstruction: "整档撰稿契约",
    reviewInstruction: "整档监制契约",
  });

  assert.equal(result.success, false);
  assert.equal(result.status, "failed");
  assert.deepEqual(result.breaks, []);
  assert.equal(result.fallback, undefined);
});

test("whole-show prompts bound profile and fact payloads", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const draft = {
    frequency: "low",
    breaks: [
      { beforeTrackIndex: 1, type: "opening", targetSeconds: 20, text: "晚上好，先从音乐人一的《歌曲一》开始，作品资料已经准备好了。", sourceIds: ["track:1:metadata"], deliveryInstruction: "自然。" },
      { beforeTrackIndex: 2, type: "closing", targetSeconds: 20, text: "这是今天的最后一首，音乐人二的《歌曲二》，把结尾交给作品本身。", sourceIds: ["track:2:metadata"], deliveryInstruction: "自然。" },
    ],
  };
  const responses = [draft, { approved: true, issues: [], rationale: "可播。" }];
  const provider = new OpenAICompatibleHostProvider({
    apiKey: "unit-test-key",
    mode: "responses",
    fetchImpl: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse({ output_text: JSON.stringify(responses.shift()) });
    },
  });
  const facts = Array.from({ length: 12 }, (_, index) => ({ id: `track:1:fact-${index}`, value: `事实 ${index} ${"很长的资料".repeat(100)}`, source: "web" as const, sourceUrl: `https://source.example/${index}` }));
  const tracks = [1, 2].map((id) => ({ trackIndex: id, title: `歌曲${id}`, artist: `音乐人${id}`, exploration: true, allowedFacts: id === 1 ? facts : [{ id: "track:2:metadata", value: "歌曲二由音乐人二演唱。", source: "user" as const }] }));
  const listenerProfile = { favoriteArtists: [{ name: "音乐人", score: 1 }], topSongs: [{ title: "歌曲", artists: ["音乐人"] }], playlistNames: ["不应发送的私人歌单名"], inferredThemes: ["主题"], evidence: ["证据"] };

  await provider.generateShow({ scenePreset: "study", frequency: "low", tracks, skillInstruction: "整档撰稿契约", reviewInstruction: "整档监制契约", listenerProfile });

  const payload = JSON.stringify(bodies);
  assert.doesNotMatch(payload, /不应发送的私人歌单名|source\.example/);
  assert.ok(payload.length < 20_000, `bounded whole-show payload was ${payload.length} bytes`);
});

test("an invalid final rewrite still returns a fact-safe local on-air script", async () => {
  let calls = 0;
  const provider = new OpenAICompatibleHostProvider({
    apiKey: "unit-test-key",
    mode: "chat_completions",
    fetchImpl: async () => {
      calls += 1;
      const payload = calls === 1
        ? reviewedCandidates("初稿")
        : calls === 2
          ? { approved: false, selectedIndex: null, issues: ["口吻仍像模板，需要改成自然聊天。"], rationale: "不适合直接播出。" }
          : { unexpected: true };
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(payload) } }] });
    },
  });

  const result = await provider.generate(context({ skillInstruction: "主持人撰稿契约", reviewInstruction: "节目监制审核契约" }));

  assert.equal(result.success, true);
  assert.equal(result.status, "ready");
  assert.match(result.text, /North Window|First Light/);
  assert.deepEqual(result.factIds, ["track:fixture-01:title"]);
  assert.equal(calls, 3);
});

test("reviewed host fallback stays concise and uses available music facts instead of filler", async () => {
  const cases = [
    { seconds: 10, isExploration: false, programPhase: "opening" as const, max: 67 },
    { seconds: 20, isExploration: true, programPhase: "building" as const, max: 74 },
    { seconds: 30, isExploration: true, programPhase: "closing" as const, max: 111 },
  ];
  for (const item of cases) {
    const provider = new OpenAICompatibleHostProvider({
      apiKey: "unit-test-key",
      mode: "chat_completions",
      fetchImpl: async () => { throw new Error("upstream unavailable"); },
    });
    const result = await provider.generate(context({
      programPhase: item.programPhase,
      hostLengthSeconds: item.seconds,
      isExploration: item.isExploration,
      skillInstruction: "主持人撰稿契约",
      reviewInstruction: "节目监制审核契约",
      currentTrack: { id: "track-1", title: "夜航信号", artist: "林澈", durationSeconds: 240, energy: 0.4, mood: [], color: "#000000" },
      allowedFacts: [
        { id: "track:track-1:metadata", value: "马上要播的歌曲《夜航信号》，艺术家是林澈。", source: "user" },
        { id: "fact:story", value: "《夜航信号》的制作从一段深夜公交报站采样开始。", source: "web" },
      ],
    }));
    const length = Array.from(result.text).length;
    assert.equal(result.success, true);
    assert.ok(length > 0 && length <= item.max, `${item.seconds}s fallback length ${length}`);
    assert.match(result.text, /夜航信号|林澈/);
    assert.doesNotMatch(result.text, /探索位|背景有点东西|先听完再说|下结论|合不合拍|顺手认识/);
    if (item.isExploration) assert.ok(result.factIds.includes("fact:story"));
    if (item.programPhase === "closing") assert.match(result.text, /最后一首/);
  }
});

test("OpenAI Responses host uses the requested Sol model without repeating program research", async () => {
  let body: Record<string, unknown> | undefined;
  const provider = new OpenAICompatibleHostProvider({
    apiKey: "relay-key",
    baseUrl: "http://198.51.100.10:8080/v1",
    model: "gpt-5.6-sol",
    mode: "responses",
    enableWebSearch: true,
    allowInsecureHttp: true,
      fetchImpl: async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ output_text: JSON.stringify({ text: "下一段会把节奏轻轻推近，先听开场怎样留出空间，再让拍点自然接住这一程的情绪。别急着判断，声音很快会给出答案。", factIds: [], deliveryInstruction: "语速稍慢，第二句前停半拍，句尾放松。" }) });
    },
  });

  const result = await provider.generate(context({ hostMoment: "scene_boost", hostLengthSeconds: 16 }));
  assert.equal(result.success, true);
  assert.equal(result.deliveryInstruction, "语速稍慢，第二句前停半拍，句尾放松。");
  assert.ok(body);
  assert.equal(body.model, "gpt-5.6-sol");
  assert.equal(body.tools, undefined);
});

test("OpenAI Responses host does not retry a failed script request with a duplicate search", async () => {
  let calls = 0;
  const provider = new OpenAICompatibleHostProvider({
    apiKey: "relay-key",
    baseUrl: "http://198.51.100.10:8080/v1",
    model: "gpt-5.6-sol",
    mode: "responses",
    enableWebSearch: true,
    allowInsecureHttp: true,
    fetchImpl: async (_input, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return body.tools
        ? jsonResponse({ error: { message: "unexpected web search" } }, 502)
        : jsonResponse({ error: { message: "upstream unavailable" } }, 502);
    },
  });
  const result = await provider.generate(context({ hostMoment: "scene_boost" }));
  assert.equal(result.success, false);
  assert.equal(calls, 1);
});

test("music research prioritizes verified context for exploration tracks without rumor fallback", async () => {
  let body: Record<string, unknown> | undefined;
  const provider = new OpenAICompatibleHostProvider({
    apiKey: "unit-test-key",
    mode: "responses",
    enableWebSearch: true,
    fetchImpl: async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ output: [] });
    },
  });

  await provider.research({
    scenePreset: "late_night",
    tracks: [{ title: "陌生的歌", artist: "陌生音乐人", exploration: true }],
  });

  const input = body?.input as Array<{ role?: string; content?: Array<{ text?: string }> }>;
  const prompt = input.flatMap((message) => message.content ?? []).map((item) => item.text ?? "").join("\n");
  assert.match(prompt, /exploration=true/);
  assert.match(prompt, /创作时期和制作故事/);
  assert.match(prompt, /奖项或公开成就/);
  assert.match(prompt, /不返回匿名爆料/);
  assert.match(prompt, /"exploration":true/);
});

test("playlist naming uses the selected tracks and accepts only short Chinese content names", async () => {
  let body: Record<string, unknown> | undefined;
  const provider = new OpenAICompatibleHostProvider({
    apiKey: "unit-test-key",
    mode: "chat_completions",
    fetchImpl: async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ choices: [{ message: { content: JSON.stringify({ names: ["月下慢行", "too-long-name", "微光回声"] }) } }] });
    },
  });

  const result = await provider.generatePlaylistNames({
    scenePreset: "late_night",
    energyCurve: "低到轻柔提升",
    tracks: [{ title: "Best Part", artist: "Daniel Caesar" }],
  });

  assert.deepEqual(result, { success: true, names: ["月下慢行", "微光回声"] });
  const messages = body?.messages as Array<{ content: string }>;
  assert.match(messages[1]?.content ?? "", /Best Part/);
  assert.match(messages[1]?.content ?? "", /Daniel Caesar/);
});

test("cloud host prompts omit unallowlisted track and derived metadata", () => {
  const prompt = buildHostPrompt(context({
    currentTrack: {
      id: "private-current",
      title: "Private title must stay local",
      artist: "Private artist must stay local",
      durationSeconds: 201,
      energy: 0.91,
      mood: ["private-mood"],
      color: "#000000",
    },
    nextTrack: {
      id: "private-next",
      title: "Private next title must stay local",
      artist: "Private next artist must stay local",
      durationSeconds: 202,
      energy: 0.87,
      mood: ["private-next-mood"],
      color: "#111111",
    },
    allowedFacts: [{ id: "fact:tempo", value: "节奏已确认偏轻快", source: "fixture" }],
  }));

  const payload = JSON.parse(prompt.user) as Record<string, unknown>;
  assert.deepEqual(payload.allowedFacts, [{ id: "fact:tempo", value: "节奏已确认偏轻快", source: "fixture" }]);
  assert.equal("previousTrack" in payload, false);
  assert.equal("currentTrack" in payload, false);
  assert.equal("nextTrack" in payload, false);
  assert.equal("emotionProfile" in payload, false);
  assert.equal(prompt.user.includes("Private title must stay local"), false);
  assert.equal(prompt.user.includes("Private next artist must stay local"), false);
  assert.equal(prompt.user.includes("private-mood"), false);
});

test("valid allowedFacts survive response parsing and duplicate fact ids are rejected", async () => {
  let response = { text: "从这首歌继续保持稳定节奏。", factIds: ["track:fixture-01:title"] };
  const provider = new OpenAICompatibleHostProvider({
    apiKey: "unit-test-key",
    mode: "chat_completions",
    fetchImpl: async () => jsonResponse({
      choices: [{ message: { content: JSON.stringify(response) } }],
    }),
  });

  const valid = await provider.generate(context());
  assert.equal(valid.success, true);
  assert.deepEqual(valid.factIds, ["track:fixture-01:title"]);

  response = { text: "仍然只说已知内容。", factIds: ["track:fixture-01:title", "track:fixture-01:title"] };
  const duplicate = await provider.generate(context());
  assert.equal(duplicate.success, false);
  assert.equal(duplicate.error?.code, "invalid_facts");
});

test("HTTP 200 business failures are failures, not transport successes", async () => {
  const secret = "unit-test-secret-do-not-leak";
  const provider = new OpenAICompatibleHostProvider({
    apiKey: secret,
    mode: "chat_completions",
    fetchImpl: async () => jsonResponse({ code: 701, message: `Request rejected api_key=${secret}` }),
  });

  const result = await provider.generate(context());
  const serialized = JSON.stringify(result);

  assert.equal(result.success, false);
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "business_error");
  assert.match(result.error?.message ?? "", /redacted/);
  assert.equal(serialized.includes(secret), false);
});

test("TTS HTTP 200 business failures never become audio or leak upstream secrets", async () => {
  const secret = "dashscope-secret-for-test";
  let calls = 0;
  const provider = new QwenTtsProvider({
    apiKey: secret,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ code: 701, message: `Request rejected access_token=${secret}` });
    },
  });

  const result = await provider.synthesize({ text: "测试业务失败。", scenePreset: "study" });
  const serialized = JSON.stringify(result);

  assert.equal(calls, 1);
  assert.equal(result.status, "failed");
  assert.equal(result.success, false);
  assert.equal(result.error?.code, "business_error");
  assert.equal(result.audio, null);
  assert.equal(result.buffer, null);
  assert.equal(serialized.includes(secret), false);
});

test("Qwen TTS enables instruction optimization for natural delivery", async () => {
  let requestBody: Record<string, unknown> | null = null;
  const provider = new QwenTtsProvider({
    apiKey: "dashscope-test-key",
    fetchImpl: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(Buffer.from("RIFFxxxxWAVE"), { status: 200, headers: { "content-type": "audio/wav" } });
    },
  });

  const result = await provider.synthesize({ text: "这是一段自然的电台过场。", scenePreset: "late_night" });
  const input = (requestBody as Record<string, unknown> | null)?.input as Record<string, unknown> | undefined;
  assert.equal(result.success, true);
  assert.equal(input?.voice, "Elias");
  assert.equal(input?.language_type, "Chinese");
  assert.equal(input?.optimize_instructions, true);
});

test("selected Mandarin host uses its exact CosyVoice v2 model and voice", async () => {
  let requestUrl = "";
  let requestBody: Record<string, any> | null = null;
  const provider = new QwenTtsProvider({
    apiKey: "dashscope-test-key",
    baseUrl: "https://workspace.cn-beijing.maas.aliyuncs.com/api/v1",
    fetchImpl: async (input, init) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body)) as Record<string, any>;
      return new Response(Buffer.from("ID3-radio-audio"), { status: 200, headers: { "content-type": "audio/mpeg" } });
    },
  });

  const result = await provider.synthesize({ text: "接下来，把这一段旋律交给夜色。", scenePreset: "late_night", hostProfile: "xiaocheng", instruction: "语速稍慢。" });

  assert.equal(result.success, true);
  assert.equal(result.model, "cosyvoice-v2");
  assert.equal(result.voice, "longxiaocheng_v2");
  assert.match(requestUrl, /\/services\/audio\/tts\/SpeechSynthesizer$/);
  const capturedBody = requestBody as Record<string, any> | null;
  assert.equal(capturedBody?.model, "cosyvoice-v2");
  assert.deepEqual(capturedBody?.input, {
    text: "接下来，把这一段旋律交给夜色。",
    voice: "longxiaocheng_v2",
    format: "mp3",
    sample_rate: 24_000,
    rate: 0.82,
    pitch: 0.96,
    volume: 54,
  });

  const longxinResult = await provider.synthesize({ text: "下一首我们换成更明亮的节奏。", scenePreset: "commute", hostProfile: "longxin", instruction: "清爽自然。" });
  assert.equal(longxinResult.success, true);
  assert.equal(longxinResult.model, "qwen-audio-3.0-tts-plus");
  assert.equal(longxinResult.voice, "qwen-audio-3.0-tts-plus-longhexuanlan");
  const longxinBody = requestBody as Record<string, any> | null;
  assert.equal(longxinBody?.input.voice, "qwen-audio-3.0-tts-plus-longhexuanlan");
  assert.equal(longxinBody?.input.rate, 1.02);
});

test("CosyVoice applies distinct pace, pitch, and volume for all five music atmospheres", async () => {
  const inputs: Array<Record<string, unknown>> = [];
  const provider = new QwenTtsProvider({
    apiKey: "dashscope-test-key",
    baseUrl: "https://workspace.cn-beijing.maas.aliyuncs.com/api/v1",
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { input: Record<string, unknown> };
      inputs.push(body.input);
      return new Response(Buffer.from("ID3-radio-audio"), { status: 200, headers: { "content-type": "audio/mpeg" } });
    },
  });

  for (const scenePreset of ["late_night", "study", "workout", "commute", "party"] as const) {
    const result = await provider.synthesize({ text: "测试音乐氛围。", scenePreset, hostProfile: "xiaocheng" });
    assert.equal(result.success, true);
  }

  assert.deepEqual(inputs.map(({ rate, pitch, volume }) => ({ rate, pitch, volume })), [
    { rate: 0.82, pitch: 0.96, volume: 54 },
    { rate: 0.90, pitch: 1, volume: 55 },
    { rate: 1.00, pitch: 1.02, volume: 59 },
    { rate: 0.96, pitch: 1, volume: 57 },
    { rate: 1.06, pitch: 1.04, volume: 61 },
  ]);
});

test("host profiles can select Qwen Audio 3 Plus voices and override an individual speaking rate", async () => {
  let plusUrl = "";
  let plusBody: Record<string, any> | null = null;
  const provider = new QwenTtsProvider({
    apiKey: "dashscope-test-key",
    baseUrl: "https://workspace.cn-beijing.maas.aliyuncs.com/api/v1",
    fetchImpl: async (input, init) => {
      plusUrl = String(input);
      plusBody = JSON.parse(String(init?.body)) as Record<string, any>;
      return new Response(Buffer.from("ID3-radio-audio"), { status: 200, headers: { "content-type": "audio/mpeg" } });
    },
  });

  const plusResult = await provider.synthesize({ text: "这里是OpenMusicRadio。", scenePreset: "late_night", hostProfile: "longhao", instruction: "温和自然。" });
  const capturedPlusBody = plusBody as Record<string, any> | null;

  assert.equal(plusResult.model, "qwen-audio-3.0-tts-plus");
  assert.equal(plusResult.voice, "qwen-audio-3.0-tts-plus-longhuifengyi");
  assert.match(plusUrl, /\/services\/audio\/tts\/SpeechSynthesizer$/);
  assert.equal(capturedPlusBody?.model, "qwen-audio-3.0-tts-plus");
  assert.equal(capturedPlusBody?.input.voice, "qwen-audio-3.0-tts-plus-longhuifengyi");
  assert.match(capturedPlusBody?.input.instruction, /中文电台主持/);
  assert.match(capturedPlusBody?.input.instruction, /情绪稳定/);
  assert.match(capturedPlusBody?.input.instruction, /语速中等/);
  assert.match(capturedPlusBody?.input.instruction, /深情/);

  let anranInput: Record<string, any> | null = null;
  const cosyProvider = new QwenTtsProvider({
    apiKey: "dashscope-test-key",
    baseUrl: "https://workspace.cn-beijing.maas.aliyuncs.com/api/v1",
    fetchImpl: async (_input, init) => {
      anranInput = (JSON.parse(String(init?.body)) as Record<string, any>).input;
      return new Response(Buffer.from("ID3-radio-audio"), { status: 200, headers: { "content-type": "audio/mpeg" } });
    },
  });
  await cosyProvider.synthesize({ text: "欢迎你的到来。", scenePreset: "party", hostProfile: "anran" });
  assert.equal((anranInput as Record<string, any> | null)?.rate, 1.01);
});

test("CosyVoice derives the workspace HTTP endpoint and does not repeat a rejected request", async () => {
  let calls = 0;
  let requestUrl = "";
  const provider = new QwenTtsProvider({
    env: {
      DASHSCOPE_API_KEY: "dashscope-test-key",
      DASHSCOPE_WEBSOCKET_BASE_URL: "wss://workspace-123.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference",
      DASHSCOPE_WORKSPACE_ID: "workspace-123",
    },
    fetchImpl: async (input) => {
      calls += 1;
      requestUrl = String(input);
      return Response.json({ code: "InvalidParameter", message: "request rejected" });
    },
  });

  const result = await provider.synthesize({ text: "这一段只请求一次。", scenePreset: "study", hostProfile: "anran", instruction: "语速稍快。" });

  assert.equal(result.success, false);
  assert.equal(calls, 1);
  assert.equal(requestUrl, "https://workspace-123.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer");
});

test("CosyVoice upgrades a trusted temporary OSS audio URL to HTTPS", async () => {
  const requestUrls: string[] = [];
  const provider = new QwenTtsProvider({
    apiKey: "dashscope-test-key",
    baseUrl: "https://workspace.cn-beijing.maas.aliyuncs.com/api/v1",
    fetchImpl: async (input) => {
      requestUrls.push(String(input));
      if (requestUrls.length === 1) {
        return Response.json({ output: { audio: { url: "http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/result.mp3?token=temporary" } } });
      }
      return new Response(Buffer.from("ID3-radio-audio"), { status: 200, headers: { "content-type": "audio/mpeg" } });
    },
  });

  const result = await provider.synthesize({ text: "安全下载临时音频。", scenePreset: "study", hostProfile: "anxuan" });

  assert.equal(result.success, true);
  assert.equal(requestUrls[1], "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/result.mp3?token=temporary");
});

test("Qwen Audio 3 TTS uses the official WebSocket task flow", async () => {
  const sent: string[] = [];
  const listeners = new Map<string, (...args: any[]) => void>();
  const provider = new QwenTtsProvider({
    apiKey: "dashscope-test-key",
    model: "qwen-audio-3.0-tts-flash",
    voice: "longanhuan_v3.6",
    websocketFactory: (_url, options) => {
      assert.equal(options.headers.Authorization, "Bearer dashscope-test-key");
      return {
        on(event, listener) { listeners.set(event, listener); },
        send(data) { sent.push(data); },
        close() {},
      };
    },
  });

  const pending = provider.synthesize({ text: "下一首歌即将开始。", scenePreset: "commute", instruction: "语速稍慢，停顿半拍，重读歌名，句尾放松。" });
  listeners.get("open")?.();
  listeners.get("message")?.(JSON.stringify({ header: { event: "task-started" } }));
  listeners.get("message")?.(Buffer.from("ID3-radio-audio"));
  listeners.get("message")?.(JSON.stringify({ header: { event: "task-finished" } }));
  const result = await pending;

  assert.equal(result.success, true);
  assert.equal(sent.length, 3);
  const start = JSON.parse(sent[0]) as Record<string, any>;
  assert.equal(start.header.action, "run-task");
  assert.equal(start.payload.parameters.voice, "longanhuan_v3.6");
  assert.equal(start.payload.parameters.rate, 0.96);
  assert.equal(start.payload.parameters.pitch, 1.0);
  assert.equal(start.payload.parameters.volume, 57);
  assert.match(start.payload.parameters.instruction, /中文电台主持/);
  assert.match(start.payload.parameters.instruction, /语速稍慢/);
  assert.match(start.payload.parameters.instruction, /重读歌名/);
  const instructionWeight = Array.from(start.payload.parameters.instruction as string).reduce((total, character) => total + (character.codePointAt(0)! > 0x7f ? 2 : 1), 0);
  assert.ok(instructionWeight <= 100);
  assert.equal("optimize_instructions" in start.payload.parameters, false);
});

test("Qwen Audio sanitizes punctuation that makes delivery instructions invalid", async () => {
  const sent: string[] = [];
  const listeners = new Map<string, (...args: any[]) => void>();
  const provider = new QwenTtsProvider({
    apiKey: "dashscope-test-key",
    model: "qwen-audio-3.0-tts-flash",
    voice: "longanhuan_v3.6",
    websocketFactory: () => ({
      on(event, listener) { listeners.set(event, listener); },
      send(data) { sent.push(data); },
      close() {},
    }),
  });
  const pending = provider.synthesize({ text: "下一首歌。", scenePreset: "commute", instruction: "语速中等，“下一首”稍加重，句尾收住。" });
  listeners.get("open")?.();
  listeners.get("message")?.(JSON.stringify({ header: { event: "task-started" } }));
  listeners.get("message")?.(Buffer.from("ID3-radio-audio"));
  listeners.get("message")?.(JSON.stringify({ header: { event: "task-finished" } }));
  const result = await pending;
  assert.equal(result.success, true);
  assert.doesNotMatch(JSON.parse(sent[0]).payload.parameters.instruction, /[“”]/);
});

test("Qwen Audio retries valid host text without a rejected delivery instruction", async () => {
  const sockets: Array<{ listeners: Map<string, (...args: any[]) => void>; sent: string[] }> = [];
  const provider = new QwenTtsProvider({
    apiKey: "dashscope-test-key",
    model: "qwen-audio-3.0-tts-flash",
    voice: "longanhuan_v3.6",
    websocketFactory: () => {
      const socket = { listeners: new Map<string, (...args: any[]) => void>(), sent: [] as string[] };
      sockets.push(socket);
      return { on(event, listener) { socket.listeners.set(event, listener); }, send(data) { socket.sent.push(data); }, close() {} };
    },
  });
  const pending = provider.synthesize({ text: "这是一段完整且已核验的主持词。", scenePreset: "late_night", instruction: "语速舒缓，歌名稍作重音，破折号前略停。" });
  await new Promise((resolve) => setImmediate(resolve));
  sockets[0]!.listeners.get("open")?.();
  sockets[0]!.listeners.get("message")?.(JSON.stringify({ header: { event: "task-failed", error_message: "instruction rejected" } }));
  await new Promise((resolve) => setImmediate(resolve));
  sockets[1]!.listeners.get("open")?.();
  sockets[1]!.listeners.get("message")?.(JSON.stringify({ header: { event: "task-started" } }));
  sockets[1]!.listeners.get("message")?.(Buffer.from("ID3-radio-audio"));
  sockets[1]!.listeners.get("message")?.(JSON.stringify({ header: { event: "task-finished" } }));
  const result = await pending;
  assert.equal(result.success, true);
  assert.equal(sockets.length, 2);
  const retryStart = JSON.parse(sockets[1]!.sent[0]) as Record<string, any>;
  assert.doesNotMatch(retryStart.payload.parameters.instruction, /演绎要求/);
});

test("HTTP status mapping distinguishes auth and rate-limit failures", () => {
  const unauthorized = httpError("test-provider", 401);
  assert.equal(unauthorized.code, "unauthorized");
  assert.equal(unauthorized.retryable, false);
  assert.equal(unauthorized.status, 401);

  const limited = httpError("test-provider", 429, { "Retry-After": "3" });
  assert.equal(limited.code, "rate_limited");
  assert.equal(limited.retryable, true);
  assert.equal(limited.retryAfterMs, 3000);
});

test("upstream messages redact URLs and common secret fields", () => {
  const secret = "unit-test-secret-redact-me";
  const message = safeUpstreamMessage(
    `Request rejected api_key=${secret} authorization=Bearer-${secret} https://provider.test/token`,
    "fallback",
  );

  assert.equal(message.includes(secret), false);
  assert.equal(message.includes("provider.test"), false);
  assert.match(message, /api_key=\[redacted\]/);
  assert.match(message, /authorization=\[redacted\]/);

  const business = findBusinessFailure({ success: false, code: 701, message: `secret=${secret}` });
  assert.equal(business?.code, 701);
  assert.equal(business?.message.includes(secret), false);
});

test("authorization bearer values are fully redacted", () => {
  const secret = "unit-test-secret-bearer-must-not-leak";
  const message = safeUpstreamMessage(`Authorization: Bearer ${secret} password=${secret}`, "fallback");
  assert.equal(message.includes(secret), false);
  assert.match(message, /authorization=\[redacted\]/i);
});

test("credentialed remote HTTP endpoints are blocked before fetch", async () => {
  let calls = 0;
  const provider = new OpenAICompatibleHostProvider({
    apiKey: "unit-test-key",
    baseUrl: "http://198.51.100.10/v1",
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({});
    },
  });

  const result = await provider.generate(context());
  assert.equal(calls, 0);
  assert.equal(provider.state, "blocked_by_insecure_transport");
  assert.equal(result.success, false);
  assert.equal(result.error?.code, "invalid_input");
});

test("credentialed Qwen HTTP endpoints are blocked unless an explicit loopback opt-in is used", async () => {
  let calls = 0;
  const remote = new QwenTtsProvider({
    apiKey: "unit-test-key",
    baseUrl: "http://198.51.100.10/api/v1",
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ output: { audio: "ignored" } });
    },
  });

  assert.equal(remote.configured, false);
  assert.equal(remote.state, "blocked_by_insecure_transport");
  const blocked = await remote.synthesize({ text: "测试。", scenePreset: "study" });
  assert.equal(calls, 0);
  assert.equal(blocked.success, false);
  assert.equal(blocked.error?.code, "invalid_input");

  const loopback = new QwenTtsProvider({
    apiKey: "unit-test-key",
    baseUrl: "http://127.0.0.1:4317/api/v1",
    allowInsecureLoopback: true,
    fetchImpl: async () => new Response(Buffer.from("RIFF0000WAVEfake-audio"), {
      status: 200,
      headers: { "content-type": "audio/wav" },
    }),
  });

  assert.equal(loopback.configured, true);
  assert.equal(loopback.state, "ready");
  const allowed = await loopback.synthesize({ text: "测试。", scenePreset: "study" });
  assert.equal(allowed.success, true);
  assert.deepEqual(allowed.audio, Buffer.from("RIFF0000WAVEfake-audio"));
});

test("Qwen audio downloads reject private and non-provider hosts", async () => {
  let calls = 0;
  const provider = new QwenTtsProvider({
    apiKey: "unit-test-key",
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ output: { audio: { url: "http://127.0.0.1:4317/api/health" } } });
    },
  });

  const result = await provider.synthesize({ text: "测试。", scenePreset: "study" });
  assert.equal(calls, 1);
  assert.equal(result.success, false);
  assert.equal(result.error?.code, "invalid_audio");
});
