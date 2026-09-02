import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { LocalAiConfigStore } from "../src/server/local-ai-config.js";

const tts = { provider: "qwen" as const, model: "cosyvoice-v2", voice: "longanxuan" };
const run = promisify(execFile);

test("local AI settings reject credential-bearing custom endpoints", async () => {
  const directory = await mkdtemp(join(tmpdir(), "one-radio-ai-config-"));
  const store = new LocalAiConfigStore(join(directory, "ai-config.json"));
  try {
    await assert.rejects(
      store.save({ llm: { provider: "custom", model: "model", baseUrl: "https://user:secret@example.test/v1?token=secret" }, tts }, {}),
      /cannot contain credentials/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local AI settings persist only normalized non-secret provider metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "one-radio-ai-config-"));
  const configPath = join(directory, "ai-config.json");
  const store = new LocalAiConfigStore(configPath);
  try {
    await store.save({ llm: { provider: "custom", model: "model", reviewModel: "review-model", reasoningEffort: "high", baseUrl: "https://gateway.example/v1/" }, tts }, {});
    const persisted = await readFile(configPath, "utf8");
    const llm = JSON.parse(persisted).llm;
    assert.equal(llm.baseUrl, "https://gateway.example/v1");
    assert.equal(llm.reviewModel, "review-model");
    assert.equal(llm.reasoningEffort, "high");
    assert.doesNotMatch(persisted, /apiKey|secret|token/i);
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local AI settings accept a secure server-side TTS gateway", async () => {
  const directory = await mkdtemp(join(tmpdir(), "one-radio-ai-config-"));
  const configPath = join(directory, "ai-config.json");
  const store = new LocalAiConfigStore(configPath);
  try {
    await store.save({
      llm: { provider: "custom", model: "model", baseUrl: "https://gateway.example/v1" },
      tts: { ...tts, baseUrl: "https://gateway.example/qwen/api/v1/" },
    }, {});
    assert.equal((await store.read()).tts.baseUrl, "https://gateway.example/qwen/api/v1");
    await assert.rejects(
      store.save({ llm: { provider: "custom", model: "model", baseUrl: "https://gateway.example/v1" }, tts: { ...tts, baseUrl: "http://gateway.example/qwen/api/v1" } }, {}),
      /must use HTTPS/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an OpenAI-compatible environment endpoint keeps its matching environment key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "one-radio-ai-env-"));
  try {
    const script = `import { LocalAiConfigStore, environmentSecret } from ${JSON.stringify(new URL("../src/server/local-ai-config.ts", import.meta.url).href)}; const store = new LocalAiConfigStore(${JSON.stringify(join(directory, "missing.json"))}); const settings = await store.read(); console.log(JSON.stringify({ provider: settings.llm.provider, baseUrl: settings.llm.baseUrl, keyMatches: environmentSecret("llm:custom") === "test-gateway-key" }));`;
    const { stdout } = await run(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      env: { ...process.env, OPENAI_BASE_URL: "https://gateway.example/v1", OPENAI_API_KEY: "test-gateway-key", ONE_RADIO_AI_CONFIG_PATH: join(directory, "missing.json") },
    });
    assert.deepEqual(JSON.parse(stdout.trim()), { provider: "custom", baseUrl: "https://gateway.example/v1", keyMatches: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local AI settings delete stored secrets without exposing their values", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "one-radio-ai-delete-"));
  const service = `dev.one-radio.test.${randomUUID()}`;
  const store = new LocalAiConfigStore(join(directory, "ai-config.json"), service, false);
  try {
    await store.save({ llm: { provider: "openai", model: "test-model" }, tts }, { llmApiKey: "test-llm-secret", ttsApiKey: "test-tts-secret" });
    assert.equal((await store.status()).llm.hasKey, true);
    assert.equal((await store.status()).tts.hasKey, true);
    const afterLlm = await store.deleteSecrets("llm");
    assert.equal(afterLlm.llm.hasKey, false);
    assert.equal(afterLlm.tts.hasKey, true);
    const afterAll = await store.deleteSecrets("all");
    assert.equal(afterAll.tts.hasKey, false);
  } finally {
    await store.deleteSecrets("all");
    await rm(directory, { recursive: true, force: true });
  }
});
