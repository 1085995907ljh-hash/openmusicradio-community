import {
  ProviderError,
  SCENE_INSTRUCTIONS,
  isScenePreset,
  type QwenTtsProviderOptions,
  type TtsProvider,
  type TtsProviderStatus,
  type TtsResult,
  type TtsSynthesisRequest,
} from "./types.js";
import {
  fetchWithTimeout,
  findBusinessFailure,
  httpError,
  isProviderError,
  providerErrorInfo,
  readHeader,
  readResponseBody,
  safeUpstreamMessage,
} from "./http.js";
import WebSocket from "ws";
import { HOST_PROFILES, hostTtsInstruction } from "../shared/program-options.js";
import { boostedHostTtsVolume, getSceneConfig } from "../core/scenes.js";

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/api/v1";
const DEFAULT_WEBSOCKET_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
const DEFAULT_MODEL = "qwen3-tts-instruct-flash";
const DEFAULT_VOICE = "Elias";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const ENDPOINT_PATH = "/services/aigc/multimodal-generation/generation";
const SPEECH_SYNTHESIZER_PATH = "/services/audio/tts/SpeechSynthesizer";
const PROVIDER_NAME = "qwen-tts";
const RADIO_VOICE_INSTRUCTION = "中文电台主持。";
const COMPACT_SCENE_INSTRUCTIONS: Readonly<Record<TtsSynthesisRequest["scenePreset"], string>> = Object.freeze({
  late_night: "温暖舒展，句尾放松。",
  study: "清楚克制，重音准确。",
  workout: "明快有力，不要喊。",
  commute: "自然利落，轻微律动。",
  party: "热情紧凑，不要叫喊。",
});
const MAX_INSTRUCTION_WEIGHT = 100;
type VoiceParameters = { rate: number; pitch: number; volume: number };

function instructionWeight(value: string): number {
  return Array.from(value).reduce((total, character) => total + (character.codePointAt(0)! > 0x7f ? 2 : 1), 0);
}

function boundedInstruction(scenePreset: TtsSynthesisRequest["scenePreset"], deliveryInstruction?: string): string {
  const prefix = `${RADIO_VOICE_INSTRUCTION}${COMPACT_SCENE_INSTRUCTIONS[scenePreset]}`;
  const dynamic = sanitizeInstruction(deliveryInstruction ?? "");
  if (!dynamic) return prefix;
  let result = `${prefix}演绎：`;
  for (const character of dynamic) {
    if (instructionWeight(result + character) > MAX_INSTRUCTION_WEIGHT) break;
    result += character;
  }
  return result;
}

export class QwenTtsProvider implements TtsProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly websocketUrl: string;
  private readonly workspaceId: string;
  private readonly model: string;
  private readonly voice: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly websocketFactory: NonNullable<QwenTtsProviderOptions["websocketFactory"]>;
  private readonly secureTransport: boolean;

  constructor(options: QwenTtsProviderOptions = {}) {
    const env = options.env ?? process.env;
    this.apiKey = (options.apiKey ?? env.DASHSCOPE_API_KEY ?? "").trim();
    this.workspaceId = (options.workspaceId ?? env.DASHSCOPE_WORKSPACE_ID ?? "").trim();
    this.websocketUrl = normalizeWebsocketUrl(options.websocketUrl ?? env.DASHSCOPE_WEBSOCKET_BASE_URL ?? DEFAULT_WEBSOCKET_URL);
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? env.DASHSCOPE_BASE_URL ?? workspaceHttpBaseUrl(this.websocketUrl, this.workspaceId) ?? DEFAULT_BASE_URL);
    this.secureTransport = isCredentialTransportSecure(this.baseUrl, options.allowInsecureLoopback === true);
    this.model = (options.model ?? env.QWEN_TTS_MODEL ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
    this.voice = (options.voice ?? env.QWEN_TTS_VOICE ?? DEFAULT_VOICE).trim() || DEFAULT_VOICE;
    this.timeoutMs = positiveInteger(options.timeoutMs ?? env.QWEN_TTS_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    this.fetchImpl = options.fetchImpl ?? options.fetch ?? globalThis.fetch.bind(globalThis);
    this.websocketFactory = options.websocketFactory ?? ((url, wsOptions) => new WebSocket(url, wsOptions));
  }

  getStatus(): TtsProviderStatus {
    return {
      provider: PROVIDER_NAME,
      configured: this.configured,
      mock: !this.apiKey,
      baseUrl: this.baseUrl,
      model: this.model,
      voice: this.voice,
      language: "Chinese",
      timeoutMs: this.timeoutMs,
    };
  }

  get configured(): boolean {
    return Boolean(this.apiKey) && this.secureTransport;
  }

  get state(): string {
    if (!this.apiKey) return "blocked_by_credentials";
    return this.secureTransport ? "ready" : "blocked_by_insecure_transport";
  }

  async synthesize(request: TtsSynthesisRequest): Promise<TtsResult> {
    const scenePreset = request?.scenePreset;
    const instruction = isScenePreset(scenePreset) ? SCENE_INSTRUCTIONS[scenePreset] : "";
    const selectedProfile = request?.hostProfile ? HOST_PROFILES[request.hostProfile] : null;
    const selectedProfileId = selectedProfile?.id;
    const ttsInstruction = compactDeliveryInstruction([
      selectedProfileId ? hostTtsInstruction(selectedProfileId) : "",
      request?.instruction ?? "",
    ].filter(Boolean).join(" "));
    const personaFallbackInstruction = selectedProfileId ? compactDeliveryInstruction(hostTtsInstruction(selectedProfileId)) : undefined;
    const model = selectedProfile?.model ?? this.model;
    const voice = selectedProfile?.voice ?? this.voice;
    try {
      if (!request || typeof request.text !== "string" || !request.text.trim()) {
        throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_input", "TTS text must not be empty", { retryable: false }));
      }
      if (!isScenePreset(scenePreset)) {
        throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_input", "scenePreset is not supported", { retryable: false }));
      }
      if (!this.apiKey) {
        return {
          provider: PROVIDER_NAME,
          status: "disabled",
          configured: false,
          mock: true,
          success: false,
          model,
          voice,
          language: "Chinese",
          scenePreset,
          instruction,
          audio: null,
          buffer: null,
          audioBuffer: null,
          error: providerErrorInfo(PROVIDER_NAME, "missing_credentials", "DASHSCOPE_API_KEY is not configured", { retryable: false }),
        };
      }
      if (!this.secureTransport) {
        throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_input", "provider credentials require HTTPS; HTTP is allowed only for an explicitly opted-in loopback endpoint", { retryable: false }));
      }

      let audio: Buffer;
      const baseVoiceParameters = getSceneConfig(scenePreset).ttsParameters;
      const voiceParameters = {
        ...baseVoiceParameters,
        volume: boostedHostTtsVolume(baseVoiceParameters.volume),
        ...(selectedProfile?.ttsRate === undefined ? {} : { rate: selectedProfile.ttsRate }),
      };
      try {
        audio = await this.requestAudio(request.text.trim(), scenePreset, request.signal, ttsInstruction, model, voice, voiceParameters);
      } catch (error) {
        const failure = asProviderError(error);
        if (model.startsWith("cosyvoice-") || !request.instruction || failure.code !== "business_error" || request.signal?.aborted) throw failure;
        // Qwen Audio 3 can reject otherwise valid text when an instruction is
        // too specific. Preserve the script and fixed voice by retrying with a
        // compact host persona instead of dropping to a generic scene voice.
        audio = await this.requestAudio(request.text.trim(), scenePreset, request.signal, personaFallbackInstruction, model, voice, voiceParameters);
      }
      return {
        provider: PROVIDER_NAME,
        status: "ready",
        configured: true,
        mock: false,
        success: true,
        model,
        voice,
        language: "Chinese",
        scenePreset,
        instruction: ttsInstruction ?? instruction,
        audio,
        buffer: audio,
        audioBuffer: audio,
      };
    } catch (error) {
      const failure = asProviderError(error).toInfo();
      return {
        provider: PROVIDER_NAME,
        status: "failed",
        configured: this.configured,
        mock: false,
        success: false,
        model,
        voice,
        language: "Chinese",
        scenePreset: isScenePreset(scenePreset) ? scenePreset : "study",
        instruction,
        audio: null,
        buffer: null,
        audioBuffer: null,
        error: failure,
      };
    }
  }

  /** Throws the typed error instead of returning a failed result for lower-level callers. */
  async synthesizeOrThrow(request: TtsSynthesisRequest): Promise<TtsResult> {
    const result = await this.synthesize(request);
    if (!result.success && result.error) throw new ProviderError(result.error);
    return result;
  }

  private async requestAudio(text: string, scenePreset: TtsSynthesisRequest["scenePreset"], signal?: AbortSignal, deliveryInstruction?: string, model = this.model, voice = this.voice, voiceParameters: VoiceParameters = getSceneConfig(scenePreset).ttsParameters): Promise<Buffer> {
    const qwenAudioNonRealtime = model === "qwen-audio-3.0-tts-plus";
    if (model.startsWith("qwen-audio-3.0-tts") && !qwenAudioNonRealtime) {
      return this.requestWebsocketAudio(text, scenePreset, signal, deliveryInstruction, model, voice, voiceParameters);
    }
    const cosyVoice = model.startsWith("cosyvoice-");
    const speechSynthesizer = cosyVoice || qwenAudioNonRealtime;
    const endpoint = `${this.baseUrl}${speechSynthesizer ? SPEECH_SYNTHESIZER_PATH : ENDPOINT_PATH}`;
    const response = await fetchWithTimeout(this.fetchImpl, endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(speechSynthesizer ? {
        model,
        input: {
          text,
          voice,
          format: "mp3",
          sample_rate: 24_000,
          ...voiceParameters,
          ...(qwenAudioNonRealtime ? { instruction: boundedInstruction(scenePreset, deliveryInstruction) } : {}),
        },
      } : {
        model,
        input: {
          text,
          voice,
          language_type: "Chinese",
          instructions: deliveryInstruction || SCENE_INSTRUCTIONS[scenePreset],
          optimize_instructions: true,
        },
      }),
    }, { timeoutMs: this.timeoutMs, signal, provider: PROVIDER_NAME });

    const status = Number(response.status ?? 200);
    if (status < 200 || status >= 300 || response.ok === false) {
      throw httpError(PROVIDER_NAME, status, response.headers);
    }

    const contentType = readHeader(response.headers, "content-type") ?? "";
    if (contentType.toLowerCase().startsWith("audio/")) {
      return validateAudio(await readBinaryResponse(response));
    }

    const body = await readResponseBody(response);
    if (body.json === undefined) {
      throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_response", "TTS provider returned invalid JSON", { retryable: false }));
    }
    const businessFailure = findBusinessFailure(body.json);
    if (businessFailure) {
      throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "business_error", businessFailure.message, { retryable: false }));
    }

    const descriptor = findAudioDescriptor(body.json);
    if (!descriptor) {
      throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_audio", "TTS response did not contain audio", { retryable: false }));
    }
    if (descriptor.kind === "base64") return validateAudio(decodeBase64(descriptor.value));
    return this.downloadAudio(descriptor.value, signal);
  }

  private requestWebsocketAudio(text: string, scenePreset: TtsSynthesisRequest["scenePreset"], signal?: AbortSignal, deliveryInstruction?: string, model = this.model, voice = this.voice, voiceParameters: VoiceParameters = getSceneConfig(scenePreset).ttsParameters): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let settled = false;
      const taskId = `oneradio-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const socket = this.websocketFactory(this.websocketUrl, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(this.workspaceId ? { "X-DashScope-WorkSpace": this.workspaceId } : {}),
        },
      });
      const timer = setTimeout(() => finish(new ProviderError(providerErrorInfo(PROVIDER_NAME, "timeout", "TTS WebSocket request timed out", { retryable: true }))), this.timeoutMs);
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { socket.close(); } catch { /* best effort */ }
        if (error) reject(error);
        else {
          try { resolve(validateAudio(Buffer.concat(chunks))); }
          catch (validationError) { reject(validationError); }
        }
      };
      const send = (payload: unknown) => socket.send(JSON.stringify(payload));
      const start = () => {
        send({ header: { action: "run-task", task_id: taskId, streaming: "duplex" }, payload: {
          model,
          task_group: "audio",
          task: "tts",
          function: "SpeechSynthesizer",
          input: {},
          parameters: {
            voice,
            volume: voiceParameters.volume,
            text_type: "PlainText",
            sample_rate: 22050,
            rate: voiceParameters.rate,
            format: "mp3",
            pitch: voiceParameters.pitch,
            seed: 0,
            type: 0,
            instruction: boundedInstruction(scenePreset, deliveryInstruction),
          },
        }});
      };
      socket.on("open", start);
      const handleEvent = (event: any) => {
        const eventName = event?.header?.event;
        if (eventName === "task-failed" || eventName === "error") {
          finish(new ProviderError(providerErrorInfo(PROVIDER_NAME, "business_error", safeUpstreamMessage(event?.header?.error_message ?? event?.payload?.message, "TTS WebSocket task failed"), { retryable: false })));
        } else if (eventName === "task-started") {
          send({ header: { action: "continue-task", task_id: taskId, streaming: "duplex" }, payload: {
            model,
            task_group: "audio",
            task: "tts",
            function: "SpeechSynthesizer",
            input: { text },
          }});
          send({ header: { action: "finish-task", task_id: taskId, streaming: "duplex" }, payload: { input: {} }});
        } else if (eventName === "task-finished") {
          finish();
        }
      };
      socket.on("message", (data: unknown) => {
        if (Buffer.isBuffer(data) || data instanceof Uint8Array) {
          const bytes = Buffer.from(data);
          if (bytes[0] === 0x7b) {
            try { handleEvent(JSON.parse(bytes.toString("utf8"))); } catch { /* binary audio */ }
          } else {
            chunks.push(bytes);
          }
          return;
        }
        try { handleEvent(JSON.parse(String(data))); } catch { /* ignore malformed control frames */ }
      });
      socket.on("error", (error: unknown) => finish(new ProviderError(providerErrorInfo(PROVIDER_NAME, "network_error", safeUpstreamMessage(error instanceof Error ? error.message : undefined, "TTS WebSocket request failed"), { retryable: true }))));
      socket.on("close", () => { if (!settled) finish(new ProviderError(providerErrorInfo(PROVIDER_NAME, "network_error", "TTS WebSocket closed before audio completed", { retryable: true }))); });
      if (signal) {
        if (signal.aborted) finish(new ProviderError(providerErrorInfo(PROVIDER_NAME, "network_error", "TTS request was aborted", { retryable: true })));
        else signal.addEventListener("abort", () => finish(new ProviderError(providerErrorInfo(PROVIDER_NAME, "network_error", "TTS request was aborted", { retryable: true }))), { once: true });
      }
    });
  }

  private async downloadAudio(url: string, signal?: AbortSignal): Promise<Buffer> {
    let resolved: URL;
    try {
      resolved = new URL(url, `${this.baseUrl}/`);
    } catch {
      throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_audio", "TTS audio URL is invalid", { retryable: false }));
    }
    if (!isAllowedAudioHost(resolved.hostname)) {
      throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_audio", "TTS audio URL is outside the trusted provider hosts", { retryable: false }));
    }
    if (resolved.protocol === "http:") {
      resolved.protocol = "https:";
      resolved.port = "";
    }
    if (resolved.protocol !== "https:") {
      throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_audio", "TTS audio URL must use HTTPS", { retryable: false }));
    }

    const response = await fetchWithTimeout(this.fetchImpl, resolved.toString(), {
      method: "GET",
      redirect: "error",
      headers: { Accept: "audio/*, application/octet-stream" },
    }, { timeoutMs: this.timeoutMs, signal, provider: PROVIDER_NAME });
    const status = Number(response.status ?? 200);
    if (status < 200 || status >= 300 || response.ok === false) {
      throw httpError(PROVIDER_NAME, status, response.headers);
    }
    return validateAudio(await readBinaryResponse(response));
  }
}

function sanitizeInstruction(value: string): string {
  return value
    .replace(/[“”„‟"'‘’]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function compactDeliveryInstruction(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = sanitizeInstruction(value);
  const patterns = [
    /(?:声线|声调|声音)[^，。；]{0,12}/g,
    /语速[^，。；]{0,12}/g,
    /(?:情绪|语气)[^，。；]{0,12}/g,
    /[^，。；]{0,8}深情[^，。；]{0,8}/g,
    /(?:呼吸|笑意|咬字|节奏|力度)[^，。；]{0,12}/g,
    /(?:句间|停顿|稍停)[^，。；]{0,12}/g,
    /(?:重读|重音)[^，。；]{0,12}/g,
    /(?:句尾|末句)[^，。；]{0,12}/g,
  ];
  const clauses: string[] = [];
  for (const pattern of patterns) {
    for (const match of normalized.match(pattern) ?? []) {
      if (!clauses.includes(match)) clauses.push(match);
      if (clauses.join("，").length >= 64) break;
    }
    if (clauses.join("，").length >= 64) break;
  }
  return (clauses.length > 0 ? clauses.join("，") : "自然口语").slice(0, 72) + "。";
}

function isAllowedAudioHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return normalized === "aliyuncs.com" || normalized.endsWith(".aliyuncs.com");
}

function isCredentialTransportSecure(baseUrl: string, allowInsecureLoopback: boolean): boolean {
  try {
    const url = new URL(baseUrl);
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:" || !allowInsecureLoopback) return false;
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

function workspaceHttpBaseUrl(websocketUrl: string, workspaceId: string): string | undefined {
  try {
    const url = new URL(websocketUrl);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (url.protocol === "wss:" && hostname.endsWith(".maas.aliyuncs.com")) {
      return `https://${hostname}/api/v1`;
    }
  } catch {
    // Fall through to the validated workspace id.
  }
  return /^[a-zA-Z0-9-]+$/.test(workspaceId)
    ? `https://${workspaceId}.cn-beijing.maas.aliyuncs.com/api/v1`
    : undefined;
}

export function createTtsProvider(env: NodeJS.ProcessEnv = process.env): QwenTtsProvider {
  return new QwenTtsProvider({ env });
}

interface AudioDescriptor {
  kind: "url" | "base64";
  value: string;
}

function findAudioDescriptor(payload: unknown): AudioDescriptor | undefined {
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number): AudioDescriptor | undefined => {
    if (depth > 8 || value === null || value === undefined) return undefined;
    if (typeof value === "string") {
      if (/^https?:\/\//i.test(value)) return { kind: "url", value };
      return undefined;
    }
    if (typeof value !== "object") return undefined;
    if (seen.has(value)) return undefined;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item, depth + 1);
        if (found) return found;
      }
      return undefined;
    }
    const record = value as Record<string, unknown>;
    for (const key of ["url", "audio_url", "audioUrl"]) {
      const candidate = record[key];
      if (typeof candidate === "string" && /^https?:\/\//i.test(candidate)) return { kind: "url", value: candidate };
    }
    for (const key of ["data", "base64", "audio_base64"]) {
      const candidate = record[key];
      if (typeof candidate === "string" && candidate.length > 0 && !/^https?:\/\//i.test(candidate)) return { kind: "base64", value: candidate };
    }
    const audioCandidate = record.audio;
    if (typeof audioCandidate === "string" && audioCandidate.length > 0 && !/^https?:\/\//i.test(audioCandidate)) {
      return { kind: "base64", value: audioCandidate };
    }
    for (const child of Object.values(record)) {
      const found = visit(child, depth + 1);
      if (found) return found;
    }
    return undefined;
  };
  return visit(payload, 0);
}

function decodeBase64(value: string): Buffer {
  const normalized = value.trim().replace(/^data:audio\/[^;]+;base64,/i, "");
  if (!normalized || normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_audio", "TTS returned invalid base64 audio", { retryable: false }));
  }
  return Buffer.from(normalized, "base64");
}

async function readBinaryResponse(response: Response): Promise<Buffer> {
  try {
    const declaredLength = Number(response.headers?.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_AUDIO_BYTES) {
      throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_audio", "TTS audio exceeded the size limit", { retryable: false }));
    }
    if (response.body && typeof response.body.getReader === "function") {
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_AUDIO_BYTES) {
          await reader.cancel();
          throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_audio", "TTS audio exceeded the size limit", { retryable: false }));
        }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks, total);
    }
    if (typeof response.arrayBuffer === "function") {
      const audio = Buffer.from(await response.arrayBuffer());
      if (audio.length > MAX_AUDIO_BYTES) throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_audio", "TTS audio exceeded the size limit", { retryable: false }));
      return audio;
    }
  } catch {
    throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_audio", "TTS audio could not be downloaded", { retryable: false }));
  }
  throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_audio", "TTS response did not contain downloadable audio", { retryable: false }));
}

function validateAudio(audio: Buffer): Buffer {
  if (!audio || audio.byteLength === 0) {
    throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_audio", "TTS returned an empty audio payload", { retryable: false }));
  }
  const ascii4 = audio.subarray(0, 4).toString("ascii");
  const supported = audio.length >= 12 && (
    (ascii4 === "RIFF" && audio.subarray(8, 12).toString("ascii") === "WAVE")
    || ascii4 === "OggS"
    || ascii4 === "fLaC"
    || audio.subarray(0, 3).toString("ascii") === "ID3"
    || (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0)
    || audio.subarray(4, 8).toString("ascii") === "ftyp"
  );
  if (!supported) {
    throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_audio", "TTS returned a non-audio payload", { retryable: false }));
  }
  return audio;
}

function normalizeBaseUrl(value: string): string {
  const fallback = DEFAULT_BASE_URL;
  try {
    const parsed = new URL(value || fallback);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return fallback;
  }
}

function normalizeWebsocketUrl(value: string): string {
  try {
    const parsed = new URL(value || DEFAULT_WEBSOCKET_URL);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return DEFAULT_WEBSOCKET_URL;
  }
}

function positiveInteger(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function asProviderError(error: unknown): ProviderError {
  if (isProviderError(error)) return error;
  const message = safeUpstreamMessage(error instanceof Error ? error.message : undefined, "TTS request failed");
  return new ProviderError(providerErrorInfo(PROVIDER_NAME, "network_error", message, { retryable: true }), { cause: error });
}
