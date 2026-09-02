import { OpenAICompatibleHostProvider } from "../providers/openai-compatible.js";
import { QwenTtsProvider } from "../providers/qwen-tts.js";
import { HOST_TTS_VOLUME_BOOST_DB } from "../core/scenes.js";
import type { HostContextPack, ScenePreset } from "../shared/contracts.js";
import { hostPreviewText, hostTtsInstruction, type HostProfileId } from "../shared/program-options.js";
import { LocalAiConfigStore, type LlmProviderId, type TtsProviderId } from "./local-ai-config.js";
import { researchPublicMusicFacts } from "./public-music-research.js";

const OPENAI_VOICES: Record<HostProfileId, string> = { anxuan: "coral", anran: "nova", anya: "shimmer", xiaocheng: "onyx", longxin: "alloy", longhao: "echo" };
const AZURE_VOICES: Record<HostProfileId, string> = { anxuan: "zh-CN-XiaoxiaoNeural", anran: "zh-CN-XiaoyiNeural", anya: "zh-CN-XiaochenMultilingualNeural", xiaocheng: "zh-CN-YunxiNeural", longxin: "zh-CN-YunyangNeural", longhao: "zh-CN-YunjianNeural" };

export class LocalConfiguredHostProvider {
  configured = true;
  state = "configured_unverified";
  constructor(private readonly store: LocalAiConfigStore) {}
  getStatus() { return { provider: "local-configured", configured: true, mock: false, state: this.state }; }

  async generate(context: HostContextPack, options: { signal?: AbortSignal } = {}) {
    const provider = await this.provider();
    const result = await provider.generate(context, options);
    this.state = result.success ? "ready" : result.error?.code === "unauthorized" ? "blocked_by_credentials" : "failed_technical";
    return result;
  }

  async generateShow(request: Parameters<OpenAICompatibleHostProvider["generateShow"]>[0], options: { signal?: AbortSignal } = {}) {
    const result = await (await this.provider()).generateShow(request, options);
    this.state = result.fallback ? "ready_with_fallback" : result.success ? "ready" : result.error?.code === "unauthorized" ? "blocked_by_credentials" : "failed_technical";
    return result;
  }

  async research(request: Parameters<OpenAICompatibleHostProvider["research"]>[0], options: { signal?: AbortSignal } = {}) {
    const provider = await this.provider();
    const publicFacts = await researchPublicMusicFacts(request.tracks, { signal: options.signal }).catch(() => []);
    const modelFacts = publicFacts.length >= 4 ? [] : await provider.research(request, options).catch(() => []);
    const seen = new Set<string>();
    return [...modelFacts, ...publicFacts].filter((fact) => {
      const key = `${fact.sourceUrl}\n${fact.value}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 24);
  }

  async generatePlaylistNames(request: Parameters<OpenAICompatibleHostProvider["generatePlaylistNames"]>[0], options: { signal?: AbortSignal } = {}) {
    return (await this.provider()).generatePlaylistNames(request, options);
  }

  async test(signal?: AbortSignal): Promise<void> {
    const result = await this.generatePlaylistNames({
      scenePreset: "study",
      energyCurve: "平稳",
      tracks: [{ title: "测试曲目", artist: "测试音乐人" }],
    }, { signal });
    if (!result.success || result.names.length === 0) throw new Error("大模型连接失败");
  }

  async adjustRundown(request: { instruction: string; tracks: Array<{ id: string; title: string; artist: string; mood: string[] }> }, signal?: AbortSignal): Promise<string[]> {
    const settings = await this.store.read();
    const apiKey = await this.store.llmSecret(settings.llm.provider);
    if (!apiKey) throw new Error("请先配置大模型 API Key");
    const system = "你只负责调整一档已生成音乐电台节目的歌曲顺序，不编辑口播。必须把输入中的每个歌曲 ID 恰好返回一次，不得新增、删除、重复或改写 ID。根据用户要求返回新的曲序。只返回 JSON：{\"trackIds\":[\"id\"]}。";
    const user = JSON.stringify({ request: request.instruction, tracks: request.tracks });
    const text = await completeText(settings.llm.provider, apiKey, settings.llm.model, settings.llm.baseUrl, system, user, signal);
    const parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")) as { trackIds?: unknown };
    if (!Array.isArray(parsed.trackIds) || parsed.trackIds.some((id) => typeof id !== "string")) throw new Error("模型没有返回有效曲序");
    return parsed.trackIds;
  }

  private async provider(): Promise<OpenAICompatibleHostProvider> {
    const settings = await this.store.read();
    const apiKey = await this.store.llmSecret(settings.llm.provider);
    const details = llmDetails(settings.llm.provider, settings.llm.baseUrl);
    const translatedProvider = settings.llm.provider === "anthropic" || settings.llm.provider === "gemini" ? settings.llm.provider : null;
    return new OpenAICompatibleHostProvider({
      apiKey,
      baseUrl: details.baseUrl,
      model: settings.llm.model,
      reviewModel: settings.llm.reviewModel ?? settings.llm.model,
      reasoningEffort: settings.llm.reasoningEffort ?? "high",
      mode: settings.llm.provider === "custom" || settings.llm.provider === "openai" ? "responses" : "chat_completions",
      timeoutMs: 0,
      enableWebSearch: settings.llm.provider === "custom" || settings.llm.provider === "openai",
      fetchImpl: translatedProvider ? nativeFormatFetch(translatedProvider, apiKey, settings.llm.model) : undefined,
    });
  }
}

async function completeText(provider: LlmProviderId, apiKey: string, model: string, customBaseUrl: string | undefined, system: string, user: string, signal?: AbortSignal): Promise<string> {
  if (provider === "anthropic") {
    const response = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", signal, headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model, max_tokens: 1200, system, messages: [{ role: "user", content: user }] }) });
    if (!response.ok) throw new Error(`Anthropic 连接失败 (${response.status})`);
    const payload = await response.json() as { content?: Array<{ text?: string }> };
    return payload.content?.map((part) => part.text ?? "").join("") ?? "";
  }
  if (provider === "gemini") {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { method: "POST", signal, headers: { "content-type": "application/json", "x-goog-api-key": apiKey }, body: JSON.stringify({ system_instruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: user }] }] }) });
    if (!response.ok) throw new Error(`Gemini 连接失败 (${response.status})`);
    const payload = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    return payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
  }
  const { baseUrl } = llmDetails(provider, customBaseUrl);
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, { method: "POST", signal, headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }], response_format: { type: "json_object" } }) });
  if (!response.ok) throw new Error(`大模型连接失败 (${response.status})`);
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return payload.choices?.[0]?.message?.content ?? "";
}

export class LocalConfiguredTtsProvider {
  configured = true;
  state = "configured_unverified";
  constructor(private readonly store: LocalAiConfigStore) {}
  getStatus() { return { provider: "local-configured-tts", configured: true, mock: false, state: this.state }; }

  async synthesize(input: { text: string; scenePreset: ScenePreset; hostProfile?: HostProfileId; instruction?: string; signal?: AbortSignal }) {
    const snapshot = await this.snapshot();
    return snapshot.synthesize(input);
  }

  async snapshot() {
    const settings = await this.store.read();
    const apiKey = await this.store.ttsSecret(settings.tts.provider);
    const fingerprint = JSON.stringify(settings.tts);
    return {
      fingerprint,
      synthesize: (input: { text: string; scenePreset: ScenePreset; hostProfile?: HostProfileId; instruction?: string; signal?: AbortSignal }) => this.synthesizeWith(settings, apiKey, input),
      isCurrent: async () => {
        const current = await this.store.read();
        const currentKey = await this.store.ttsSecret(current.tts.provider);
        return JSON.stringify(current.tts) === fingerprint && currentKey === apiKey;
      },
    };
  }

  private async synthesizeWith(settings: Awaited<ReturnType<LocalAiConfigStore["read"]>>, apiKey: string, input: { text: string; scenePreset: ScenePreset; hostProfile?: HostProfileId; instruction?: string; signal?: AbortSignal }) {
    if (!apiKey) return failedTts(settings.tts.provider, settings.tts.model, settings.tts.voice, input.scenePreset, "missing_credentials", "请先保存语音 API Key");
    if (settings.tts.provider === "qwen") {
      const provider = new QwenTtsProvider({ apiKey, baseUrl: settings.tts.baseUrl, model: settings.tts.model, voice: settings.tts.voice, workspaceId: settings.tts.workspaceId });
      const result = await provider.synthesize(input);
      this.state = result.success ? "ready" : result.error?.code === "unauthorized" ? "blocked_by_credentials" : "failed_technical";
      return result;
    }
    try {
      const audio = settings.tts.provider === "openai"
        ? await openAiSpeech(apiKey, settings.tts.model, OPENAI_VOICES[input.hostProfile ?? "anxuan"], input, settings.tts.voice)
        : await azureSpeech(apiKey, settings.tts.region ?? "eastasia", AZURE_VOICES[input.hostProfile ?? "anxuan"], input, settings.tts.voice);
      this.state = "ready";
      return { provider: settings.tts.provider, status: "ready" as const, configured: true, mock: false, success: true as const, model: settings.tts.model, voice: settings.tts.voice, language: "Chinese", scenePreset: input.scenePreset, instruction: input.instruction ?? "", audio, buffer: audio, audioBuffer: audio };
    } catch (error) {
      this.state = "failed_technical";
      return failedTts(settings.tts.provider, settings.tts.model, settings.tts.voice, input.scenePreset, "network_error", error instanceof Error ? error.message : "语音生成失败");
    }
  }

  async test(hostProfile: HostProfileId, scenePreset: ScenePreset = "study", signal?: AbortSignal): Promise<Buffer> {
    const result = await this.synthesize({ text: hostPreviewText(hostProfile), scenePreset, hostProfile, instruction: hostTtsInstruction(hostProfile, "opening", "试听声音，保留主持人的个人气质。"), signal });
    if (!result.success || !result.audio) throw new Error(result.error?.message ?? "语音连接失败");
    return result.audio;
  }
}

function llmDetails(provider: LlmProviderId, custom?: string): { baseUrl: string; translate: boolean } {
  if (provider === "deepseek") return { baseUrl: "https://api.deepseek.com", translate: false };
  if (provider === "qwen") return { baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", translate: false };
  if (provider === "anthropic") return { baseUrl: "https://api.anthropic.com/v1", translate: true };
  if (provider === "gemini") return { baseUrl: "https://generativelanguage.googleapis.com/v1beta", translate: true };
  if (provider === "custom") return { baseUrl: custom!, translate: false };
  return { baseUrl: "https://api.openai.com/v1", translate: false };
}

function nativeFormatFetch(provider: "anthropic" | "gemini", apiKey: string, model: string): typeof globalThis.fetch {
  return async (_url, init) => {
    const request = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ role: string; content: string }> };
    const system = request.messages?.filter((m) => m.role === "system").map((m) => m.content).join("\n") ?? "";
    const messages = request.messages?.filter((m) => m.role !== "system") ?? [];
    if (provider === "anthropic") {
      const response = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", signal: init?.signal, headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model, max_tokens: 1200, system, messages }) });
      const payload = await response.json() as { content?: Array<{ text?: string }> };
      return new Response(JSON.stringify({ choices: [{ message: { content: payload.content?.map((part) => part.text ?? "").join("") ?? "" } }] }), { status: response.status, headers: { "content-type": "application/json" } });
    }
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { method: "POST", signal: init?.signal, headers: { "content-type": "application/json", "x-goog-api-key": apiKey }, body: JSON.stringify({ system_instruction: { parts: [{ text: system }] }, contents: messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })) }) });
    const payload = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    return new Response(JSON.stringify({ choices: [{ message: { content: payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "" } }] }), { status: response.status, headers: { "content-type": "application/json" } });
  };
}

async function openAiSpeech(apiKey: string, model: string, profileVoice: string, input: { text: string; instruction?: string; signal?: AbortSignal }, configuredVoice: string): Promise<Buffer> {
  const voice = configuredVoice === "auto" ? profileVoice : configuredVoice;
  const response = await fetch("https://api.openai.com/v1/audio/speech", { method: "POST", signal: input.signal, headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model, voice, input: input.text, response_format: "mp3", ...(input.instruction ? { instructions: input.instruction } : {}) }) });
  if (!response.ok) throw new Error(`OpenAI TTS 连接失败 (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

async function azureSpeech(apiKey: string, region: string, profileVoice: string, input: { text: string; signal?: AbortSignal }, configuredVoice: string): Promise<Buffer> {
  const voice = configuredVoice === "auto" ? profileVoice : configuredVoice;
  const text = input.text.replace(/[<>&'\"]/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", "\"": "&quot;" })[char]!);
  const response = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, { method: "POST", signal: input.signal, headers: { "Ocp-Apim-Subscription-Key": apiKey, "Content-Type": "application/ssml+xml", "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3" }, body: `<speak version="1.0" xml:lang="zh-CN"><voice name="${voice}"><prosody volume="+${HOST_TTS_VOLUME_BOOST_DB}dB">${text}</prosody></voice></speak>` });
  if (!response.ok) throw new Error(`Azure Speech 连接失败 (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

function failedTts(provider: TtsProviderId, model: string, voice: string, scenePreset: ScenePreset, code: string, message: string) {
  return { provider, status: "failed" as const, configured: false, mock: false, success: false as const, model, voice, language: "Chinese", scenePreset, instruction: "", audio: null, buffer: null, audioBuffer: null, error: { provider, code, message, retryable: false } };
}
