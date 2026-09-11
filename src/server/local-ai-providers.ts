import { OpenAICompatibleHostProvider } from "../providers/openai-compatible.js";
import { QwenTtsProvider } from "../providers/qwen-tts.js";
import { HOST_TTS_VOLUME_BOOST_DB } from "../core/scenes.js";
import type { HostContextPack, ScenePreset } from "../shared/contracts.js";
import { hostPreviewText, hostTtsInstruction, MUSIC_GENRE_IDS, MUSIC_GENRES, type HostProfileId } from "../shared/program-options.js";
import type { RundownAdjustmentConversationMessage, RundownAdjustmentIntent, RundownAdjustmentTrack } from "../core/rundown-adjustment.js";
import { LocalAiConfigStore, type LlmProviderId, type TtsProviderId } from "./local-ai-config.js";
import { researchPublicMusicFacts } from "./public-music-research.js";

const OPENAI_VOICES: Record<HostProfileId, string> = { anxuan: "coral", anran: "nova", anya: "shimmer", xiaocheng: "onyx", longxin: "alloy", longhao: "echo" };
const AZURE_VOICES: Record<HostProfileId, string> = { anxuan: "zh-CN-XiaoxiaoNeural", anran: "zh-CN-XiaoyiNeural", anya: "zh-CN-XiaochenMultilingualNeural", xiaocheng: "zh-CN-YunxiNeural", longxin: "zh-CN-YunyangNeural", longhao: "zh-CN-YunjianNeural" };

export function llmApiMode(provider: LlmProviderId, model: string): "responses" | "chat_completions" {
  if (isDeepSeekModel(model)) return "chat_completions";
  return provider === "custom" || provider === "openai" ? "responses" : "chat_completions";
}

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
    this.state = result.success ? "ready" : result.error?.code === "unauthorized" ? "blocked_by_credentials" : "failed_technical";
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
    if (!result.success || result.names.length === 0) {
      this.state = "failed_technical";
      throw new Error("大模型连接失败");
    }
    this.state = "ready";
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

  async planRundownAdjustment(request: { instruction: string; conversation: RundownAdjustmentConversationMessage[]; tracks: RundownAdjustmentTrack[] }, signal?: AbortSignal): Promise<RundownAdjustmentIntent> {
    const settings = await this.store.read();
    const apiKey = await this.store.llmSecret(settings.llm.provider);
    if (!apiKey) throw new Error("请先配置大模型 API Key");
    const system = [
      "你是音乐电台确认页里的节目单调整主持人。先理解用户要做什么，再判断当前窗口能否完成；不要把所有消息都当成曲序调整。",
      "可执行能力只有：按歌曲语种、风格或歌手替换当前节目单中的歌曲；以及用户明确指定位置或顺序时重排现有歌曲。",
      `可靠的风格替换范围仅限：${MUSIC_GENRE_IDS.map((id) => MUSIC_GENRES[id].label).join("、")}。请求不在该范围时返回 unsupported，并说明可用范围。`,
      "节目歌曲数量、总时长、音乐平台、主持人、主持声线、口播频率、推荐模式、熟悉探索比例和桌面人物都不能在此窗口修改。播放控制、账号操作和保存歌单也不支持。",
      "系统没有歌曲 BPM。凡是要求按 BPM、节奏快慢、速度或能量自动排序，一律 unsupported，并明确说明缺少 BPM 数据，不能可靠执行。",
      "用户说换成英文歌时，目标是只替换当前列表里不是英文歌曲或无法确认是英文歌曲的曲目；已有明确英文歌曲必须保留。纯音乐不算英文歌曲。根据曲名、歌手和专辑谨慎判断，无法确认时列入 trackIds。",
      "如果当前曲目已经全部符合用户条件，返回 execute replace、specified_tracks、count=0、trackIds=[]，message 说明不需要替换。",
      "用户明确说全部、都是、全换时，selection=specified_tracks，trackIds 列出所有不符合目标的当前歌曲。",
      "用户说多来几首、加几首某歌手的歌，意图明确：selection=automatic，count=3，由系统优先替换探索歌曲，不追问位置。歌手按实际演唱者理解，不把作词或翻唱原作者混入。",
      "用户说换 N 首某风格，但没有说换哪 N 首时，必须 clarify，询问用户指定歌曲，或者确认由你优先替换探索歌曲。不能擅自执行。",
      "用户指定第几首、曲名或说你自己挑后，才能执行相应替换。结合 conversation 理解‘你自己挑’、‘那就三首’等追问回复。",
      "语义模糊、条件互相冲突、缺少替换范围时返回 clarify。请求包含支持和不支持的多个动作时不做部分执行，返回 clarify 并分别说明。",
      "不支持时返回 unsupported，并用自然中文说明当前窗口能做什么、为什么这条做不了。不要输出内部错误、接口、JSON、ID 或技术校验文案。",
      "execute replace 的 criteria 至少包含 language=english、genre 或 artist 之一。count 是需要替换的歌曲数；specified_tracks 的 count 必须等于 trackIds 数量；automatic 的 trackIds 为空。",
      "execute reorder 的 trackIds 必须把输入中的每个歌曲 ID 恰好返回一次。只有用户给出的顺序能由现有曲目信息确定时才能执行。",
      "只返回 JSON。替换：{\"decision\":\"execute\",\"action\":\"replace\",\"selection\":\"specified_tracks|automatic\",\"count\":1,\"trackIds\":[],\"criteria\":{\"language\":\"english\",\"genre\":\"\",\"artist\":\"\"},\"message\":\"\"}。",
      "重排：{\"decision\":\"execute\",\"action\":\"reorder\",\"trackIds\":[\"id\"],\"message\":\"\"}。追问或不支持：{\"decision\":\"clarify|unsupported\",\"message\":\"\"}。",
    ].join("\n");
    const user = JSON.stringify({ request: request.instruction, conversation: request.conversation.slice(-8), tracks: request.tracks });
    const text = await completeText(settings.llm.provider, apiKey, settings.llm.model, settings.llm.baseUrl, system, user, signal);
    return parseRundownAdjustmentIntent(text, request.tracks.map((track) => track.id));
  }

  async englishTrackIds(tracks: RundownAdjustmentTrack[], signal?: AbortSignal): Promise<string[]> {
    if (tracks.length === 0) return [];
    const settings = await this.store.read();
    const apiKey = await this.store.llmSecret(settings.llm.provider);
    if (!apiKey) throw new Error("请先配置大模型 API Key");
    const system = [
      "判断候选曲目中哪些可以明确视为英文歌曲。英文歌曲指主要演唱语言为英语。",
      "纯音乐、中文、粤语、日语、韩语和无法确认语种的歌曲都不要选。不能只因为曲名是英文就认定歌词是英文。",
      "只返回 JSON：{\"trackIds\":[\"id\"]}，不得新增或改写 ID。",
    ].join("\n");
    const text = await completeText(settings.llm.provider, apiKey, settings.llm.model, settings.llm.baseUrl, system, JSON.stringify({ tracks }), signal);
    const parsed = JSON.parse(stripJsonFence(text)) as { trackIds?: unknown };
    const allowed = new Set(tracks.map((track) => track.id));
    if (!Array.isArray(parsed.trackIds) || parsed.trackIds.some((id) => typeof id !== "string" || !allowed.has(id))) throw new Error("模型没有返回有效的英文歌曲判断");
    return [...new Set(parsed.trackIds as string[])];
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
      mode: llmApiMode(settings.llm.provider, settings.llm.model),
      timeoutMs: 0,
      enableWebSearch: settings.llm.provider === "custom" || settings.llm.provider === "openai",
      fetchImpl: translatedProvider ? nativeFormatFetch(translatedProvider, apiKey, settings.llm.model) : undefined,
    });
  }
}

function stripJsonFence(value: string): string {
  return value.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
}

function parseRundownAdjustmentIntent(value: string, currentTrackIds: string[]): RundownAdjustmentIntent {
  const parsed = JSON.parse(stripJsonFence(value)) as Record<string, unknown>;
  const message = typeof parsed.message === "string" ? parsed.message.trim().slice(0, 400) : "";
  if (parsed.decision === "clarify" || parsed.decision === "unsupported") {
    if (!message) throw new Error("模型没有返回有效的调整说明");
    return { decision: parsed.decision, message };
  }
  if (parsed.decision !== "execute") throw new Error("模型没有返回有效的调整意图");
  const allowedIds = new Set(currentTrackIds);
  if (!Array.isArray(parsed.trackIds) || parsed.trackIds.some((id) => typeof id !== "string" || !allowedIds.has(id))) throw new Error("模型返回了无效的歌曲范围");
  const trackIds = [...new Set(parsed.trackIds as string[])];
  if (parsed.action === "reorder") return { decision: "execute", action: "reorder", trackIds, message };
  if (parsed.action !== "replace" || (parsed.selection !== "specified_tracks" && parsed.selection !== "automatic")) throw new Error("模型返回了不支持的调整动作");
  const criteriaValue = parsed.criteria;
  if (typeof criteriaValue !== "object" || criteriaValue === null || Array.isArray(criteriaValue)) throw new Error("模型没有返回替换条件");
  const rawCriteria = criteriaValue as Record<string, unknown>;
  const criteria = {
    ...(rawCriteria.language === "english" ? { language: "english" as const } : {}),
    ...(typeof rawCriteria.genre === "string" && rawCriteria.genre.trim() ? { genre: rawCriteria.genre.trim().slice(0, 60) } : {}),
    ...(typeof rawCriteria.artist === "string" && rawCriteria.artist.trim() ? { artist: rawCriteria.artist.trim().slice(0, 100) } : {}),
  };
  if (!criteria.language && !criteria.genre && !criteria.artist) throw new Error("模型没有返回可执行的替换条件");
  const count = typeof parsed.count === "number" && Number.isSafeInteger(parsed.count) && parsed.count >= 0 ? parsed.count : -1;
  if (count < 0 || count > currentTrackIds.length) throw new Error("模型返回了无效的替换数量");
  if (parsed.selection === "specified_tracks" && trackIds.length !== count) throw new Error("模型返回的替换范围与数量不一致");
  if (parsed.selection === "automatic" && (trackIds.length !== 0 || count === 0)) throw new Error("模型返回了冲突的自动替换范围");
  return { decision: "execute", action: "replace", selection: parsed.selection, count, trackIds, criteria, message };
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
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, { method: "POST", signal, headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }], response_format: { type: "json_object" }, ...(isDeepSeekModel(model) ? { thinking: { type: "disabled" } } : {}) }) });
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

function isDeepSeekModel(model: string): boolean {
  return /^deepseek(?:[-_/]|$)/i.test(model.trim());
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
