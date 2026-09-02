import test from "node:test";
import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";

import type { HostContextPack } from "../src/shared/contracts.js";
import { LocalHostProvider, MacOsTtsProvider } from "../src/providers/index.js";

const NOW = new Date("2026-01-02T03:04:05.000Z");

function wavFixture(payload = "fake-wav"): Buffer {
  return Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.alloc(4),
    Buffer.from("WAVE"),
    Buffer.from(payload),
  ]);
}

function context(overrides: Partial<HostContextPack> = {}): HostContextPack {
  return {
    scenePreset: "study",
    programPhase: "building",
    timeRemainingSeconds: 900,
    previousTrack: {
      id: "private-previous",
      title: "Unknown Song Title",
      artist: "Unknown Artist",
      durationSeconds: 200,
      energy: 0.5,
      mood: ["secret-mood"],
      color: "#ffffff",
    },
    currentTrack: {
      id: "private-current",
      title: "Never Claim This Title",
      artist: "Never Claim This Artist",
      durationSeconds: 200,
      energy: 0.5,
      mood: ["secret-mood"],
      color: "#ffffff",
    },
    nextTrack: null,
    transitionReason: "private transition detail",
    recentHostLines: [],
    allowedFacts: [],
    forbiddenClaims: ["Do not infer private listener facts."],
    ...overrides,
  };
}

test("local host uses materially different copy for all five scenes", async () => {
  const provider = new LocalHostProvider({ now: () => NOW });
  const scenes = ["late_night", "study", "workout", "commute", "party"] as const;
  const lines = await Promise.all(scenes.map((scenePreset) => provider.generate(context({ scenePreset }))));

  assert.equal(new Set(lines.map((line) => line.text)).size, scenes.length);
  assert.deepEqual(lines.map((line) => line.status), scenes.map(() => "ready"));
  assert.deepEqual(lines.map((line) => line.factIds), scenes.map(() => []));
  for (const line of lines) {
    assert.equal(line.configured, true);
    assert.equal(line.provider, "local-host");
    assert.equal(line.model, "local-host-template-v1");
    assert.equal(line.generatedAt, NOW.toISOString());
  }
});

test("local host only cites supplied facts and never emits track metadata", async () => {
  const provider = new LocalHostProvider({ now: () => NOW });
  const result = await provider.generate(context({
    allowedFacts: [{ id: "fact:tempo", value: "节奏已确认偏轻快", source: "fixture" }],
  }));

  assert.equal(result.success, true);
  assert.deepEqual(result.factIds, ["fact:tempo"]);
  assert.match(result.text, /节奏已确认偏轻快/);
  assert.equal(result.text.includes("Never Claim This Title"), false);
  assert.equal(result.text.includes("Never Claim This Artist"), false);
  assert.equal(result.text.includes("secret-mood"), false);
  assert.equal(result.text.includes("private transition detail"), false);
});

test("local host avoids the recent line on the next request", async () => {
  const provider = new LocalHostProvider({ now: () => NOW });
  const first = await provider.generate(context({ scenePreset: "late_night" }));
  const second = await provider.generate(context({ scenePreset: "late_night", recentHostLines: [first.text] }));

  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.notEqual(second.text, first.text);
});

test("local opening host identifies Open Music Radio and the selected host after the time greeting", async () => {
  const provider = new LocalHostProvider({ now: () => NOW });
  const result = await provider.generate(context({ programPhase: "opening", hostMoment: "opening", hostProfile: "anya" }));

  assert.equal(result.success, true);
  assert.match(result.text, /^早上好，欢迎收听 Open Music Radio 电台，我是主持人龙安雅。/);
});

test("local fallback status is explicitly ready", () => {
  const provider = new LocalHostProvider();
  assert.deepEqual(provider.getStatus(), {
    provider: "local-host",
    configured: true,
    mock: false,
    baseUrl: "local://template",
    model: "local-host-template-v1",
    mode: "local",
    timeoutMs: 0,
    state: "ready",
  });
  assert.equal(provider.state, "ready");
});

test("macOS TTS fixes a Chinese male voice, applies scene pace, uses safe args, and cleans the temp directory", async () => {
  const commands: Array<{ command: string; args: readonly string[] }> = [];
  let capturedOptions: { timeout: number; shell: false } | undefined;
  let outputPath = "";
  const provider = new MacOsTtsProvider({
    timeoutMs: 12_345,
    runner: async (command, args, options) => {
      commands.push({ command, args });
      capturedOptions = options;
      if (command === "/usr/bin/say") {
        await writeFile(String(args[5]), Buffer.from("FORM-fake-aiff"));
      } else {
        outputPath = String(args[5]);
        await writeFile(outputPath, wavFixture());
      }
    },
  });
  const text = "测试 $(touch /tmp/should-not-run); 中文";
  const result = await provider.synthesize({ text, scenePreset: "study" });

  assert.equal(result.success, true);
  assert.deepEqual(result.audio, wavFixture());
  assert.equal(result.provider, "macos-tts");
  assert.equal(result.model, "macos-say-local-v1");
  assert.equal(result.voice, "Reed (中文（中国大陆）)");
  assert.deepEqual(commands.map((command) => command.command), ["/usr/bin/say", "/usr/bin/afconvert"]);
  assert.deepEqual(commands[0]?.args.slice(0, 5), ["-v", "Reed (中文（中国大陆）)", "-r", "162", "-o"]);
  assert.equal(commands[0]?.args[6], text);
  assert.deepEqual(commands[1]?.args.slice(0, 4), ["-f", "WAVE", "-d", "LEI16"]);
  assert.equal(capturedOptions?.timeout, 12_345);
  assert.equal(capturedOptions?.shell, false);
  await assert.rejects(access(outputPath));
});

test("macOS TTS keeps one male voice while varying pace across all five scenes", async () => {
  const sayArgs: Array<readonly string[]> = [];
  const provider = new MacOsTtsProvider({
    runner: async (command, args) => {
      if (command === "/usr/bin/say") {
        sayArgs.push(args);
        await writeFile(String(args[5]), Buffer.from("FORM-fake-aiff"));
      } else {
        await writeFile(String(args[5]), wavFixture());
      }
    },
  });

  for (const scenePreset of ["late_night", "study", "workout", "commute", "party"] as const) {
    const result = await provider.synthesize({ text: "下一首歌马上开始。", scenePreset });
    assert.equal(result.success, true);
    assert.equal(result.voice, "Reed (中文（中国大陆）)");
  }

  assert.deepEqual(sayArgs.map((args) => args[3]), ["150", "162", "180", "171", "186"]);
});

test("macOS TTS enforces max input and returns typed runner failures", async () => {
  let calls = 0;
  const tooLong = new MacOsTtsProvider({ maxInputLength: 3, runner: () => { calls += 1; } });
  const invalid = await tooLong.synthesize({ text: "超过限制", scenePreset: "study" });
  assert.equal(calls, 0);
  assert.equal(invalid.success, false);
  assert.equal(invalid.error?.code, "invalid_input");

  const timedOut = new MacOsTtsProvider({
    runner: () => {
      const error = Object.assign(new Error("say timed out"), { code: "ETIMEDOUT" });
      throw error;
    },
  });
  const failure = await timedOut.synthesize({ text: "测试", scenePreset: "study" });
  assert.equal(failure.success, false);
  assert.equal(failure.status, "failed");
  assert.equal(failure.error?.code, "timeout");
});

test("macOS TTS rejects empty generated audio and keeps ready status", async () => {
  const provider = new MacOsTtsProvider({
    runner: async (command, args) => {
      if (command === "/usr/bin/say") await writeFile(String(args[5]), Buffer.from("FORM-fake-aiff"));
      else await writeFile(String(args[5]), Buffer.alloc(0));
    },
  });
  const result = await provider.synthesize({ text: "测试", scenePreset: "party" });
  assert.equal(result.success, false);
  assert.equal(result.error?.code, "invalid_audio");
  assert.equal(provider.configured, true);
  assert.equal(provider.state, "ready");
});

test("macOS TTS rejects non-WAV output even when it is non-empty", async () => {
  const provider = new MacOsTtsProvider({
    runner: async (command, args) => {
      if (command === "/usr/bin/say") await writeFile(String(args[5]), Buffer.from("FORM-fake-aiff"));
      else await writeFile(String(args[5]), Buffer.from("RIFF-but-not-wave"));
    },
  });
  const result = await provider.synthesize({ text: "测试", scenePreset: "party" });
  assert.equal(result.success, false);
  assert.equal(result.error?.code, "invalid_audio");
});

test("macOS TTS checks AbortSignal between say and afconvert stages", async () => {
  for (const abortStage of ["say", "afconvert"] as const) {
    const controller = new AbortController();
    const commands: string[] = [];
    const provider = new MacOsTtsProvider({
      runner: async (command, args) => {
        commands.push(command);
        if (command === "/usr/bin/say") {
          await writeFile(String(args[5]), Buffer.from("FORM-fake-aiff"));
          if (abortStage === "say") controller.abort();
        } else {
          await writeFile(String(args[5]), wavFixture());
          if (abortStage === "afconvert") controller.abort();
        }
      },
    });

    const result = await provider.synthesize({ text: "测试", scenePreset: "study", signal: controller.signal });
    assert.equal(result.success, false);
    assert.equal(result.error?.code, "timeout");
    assert.deepEqual(commands, abortStage === "say" ? ["/usr/bin/say"] : ["/usr/bin/say", "/usr/bin/afconvert"]);
  }
});
