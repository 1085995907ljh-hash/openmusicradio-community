import type { HostContextPack } from "../shared/contracts.js";
import { DEFAULT_HOST_PROFILE, HOST_PROFILES, hostOpeningIdentity } from "../shared/program-options.js";
import { radioGreetingAt } from "../core/host-script-planning.js";
import {
  ProviderError,
  SCENE_INSTRUCTIONS,
  isScenePreset,
  type HostGenerationOptions,
  type HostGenerationResult,
  type HostProviderStatus,
  type PlaylistNamingRequest,
  type PlaylistNamingResult,
} from "./types.js";
import { isProviderError, providerErrorInfo, safeUpstreamMessage } from "./http.js";

const PROVIDER_NAME = "local-host" as const;
const DEFAULT_MODEL = "local-host-template-v1";
const DEFAULT_MAX_TEXT_LENGTH = 180;

const PROGRAM_PHASES = ["opening", "building", "peak", "cooldown", "closing"] as const;
type ProgramPhase = (typeof PROGRAM_PHASES)[number];

type LocalHostResult = Omit<HostGenerationResult, "provider" | "model"> & {
  provider: typeof PROVIDER_NAME;
  model: string;
};

export interface LocalHostProviderOptions {
  model?: string;
  maxTextLength?: number;
  now?: () => Date;
}

export interface LocalHostProviderStatus extends Omit<HostProviderStatus, "provider" | "model" | "baseUrl" | "mode" | "timeoutMs"> {
  provider: typeof PROVIDER_NAME;
  baseUrl: "local://template";
  model: string;
  mode: "local";
  timeoutMs: 0;
  state: "ready";
}

interface LocalFact {
  id: string;
  value: string;
}

interface StyleCopy {
  withFacts: readonly string[];
  withoutFacts: readonly string[];
}

const STYLE_COPY: Readonly<Record<NonNullable<HostContextPack["scenePreset"]>, StyleCopy>> = Object.freeze({
  late_night: {
    withFacts: [
      "先把节奏慢下来，{phase}，还剩{time}。已知信息：{fact}。陪你把这一段从容地听完。",
      "把节奏放松一些，{phase}，还剩{time}。记住这一条已知信息：{fact}。让旋律留一点呼吸。",
      "把声音放轻，{phase}，还剩{time}。目前确认的是：{fact}。让这一段保持舒展。",
      "现在适合慢一点，{phase}，还剩{time}。只播报已知内容：{fact}。安静听下去就好。",
    ],
    withoutFacts: [
      "先把节奏慢下来，{phase}，还剩{time}。陪你把这一段从容地听完。",
      "把节奏放松一些，{phase}，还剩{time}。让旋律留一点呼吸。",
      "把声音放轻，{phase}，还剩{time}。让这一段保持舒展。",
      "现在适合慢一点，{phase}，还剩{time}。安静听下去就好。",
    ],
  },
  study: {
    withFacts: [
      "专注时段保持清晰，{phase}，还剩{time}。已知信息：{fact}。把注意力留给眼前这一小段。",
      "继续稳住专注节奏，{phase}，还剩{time}。记录一条已知信息：{fact}。不急，专注就好。",
      "现在适合专心向前，{phase}，还剩{time}。目前确认的是：{fact}。让背景保持安静。",
      "专注陪伴继续，{phase}，还剩{time}。只根据已知内容播报：{fact}。把思路留在当下。",
    ],
    withoutFacts: [
      "专注时段保持清晰，{phase}，还剩{time}。把注意力留给眼前这一小段。",
      "继续稳住专注节奏，{phase}，还剩{time}。不急，专注就好。",
      "现在适合专心向前，{phase}，还剩{time}。让背景保持安静。",
      "专注陪伴继续，{phase}，还剩{time}。把思路留在当下。",
    ],
  },
  workout: {
    withFacts: [
      "训练节奏正在推进，{phase}，还剩{time}。已知信息：{fact}。跟着拍子继续向前，稳住呼吸。",
      "运动状态保持在线，{phase}，还剩{time}。记住这条已知信息：{fact}。一步一步完成这一段。",
      "把动力接上，{phase}，还剩{time}。目前确认的是：{fact}。保持节奏，不必抢拍。",
      "继续完成训练，{phase}，还剩{time}。只播报已知内容：{fact}。让动作和音乐对齐。",
    ],
    withoutFacts: [
      "训练节奏正在推进，{phase}，还剩{time}。跟着拍子继续向前，稳住呼吸。",
      "运动状态保持在线，{phase}，还剩{time}。一步一步完成这一段。",
      "把动力接上，{phase}，还剩{time}。保持节奏，不必抢拍。",
      "继续完成训练，{phase}，还剩{time}。让动作和音乐对齐。",
    ],
  },
  commute: {
    withFacts: [
      "律动继续往前，{phase}，还剩{time}。已知信息：{fact}。让节拍自然接上。",
      "清楚的节拍继续，{phase}，还剩{time}。记录一条已知信息：{fact}。保持舒适步调。",
      "律动陪伴正在进行，{phase}，还剩{time}。目前确认的是：{fact}。把注意力交回节拍。",
      "这一段听得轻松些，{phase}，还剩{time}。只播报已知内容：{fact}。下一段也保持清楚。",
    ],
    withoutFacts: [
      "律动继续往前，{phase}，还剩{time}。让节拍自然接上。",
      "清楚的节拍继续，{phase}，还剩{time}。保持舒适步调。",
      "律动陪伴正在进行，{phase}，还剩{time}。把注意力交回节拍。",
      "这一段听得轻松些，{phase}，还剩{time}。下一段也保持清楚。",
    ],
  },
  party: {
    withFacts: [
      "聚会节拍正在升温，{phase}，还剩{time}。已知信息：{fact}。把快乐留在这一拍。",
      "轻松的氛围继续，{phase}，还剩{time}。记住这条已知信息：{fact}。让节奏自然流动。",
      "现在把情绪交给音乐，{phase}，还剩{time}。目前确认的是：{fact}。一起享受这一段声音。",
      "聚会陪伴不间断，{phase}，还剩{time}。只播报已知内容：{fact}。让下一拍接得漂亮。",
    ],
    withoutFacts: [
      "聚会节拍正在升温，{phase}，还剩{time}。把快乐留在这一拍。",
      "轻松的氛围继续，{phase}，还剩{time}。让节奏自然流动。",
      "现在把情绪交给音乐，{phase}，还剩{time}。一起享受这一段声音。",
      "聚会陪伴不间断，{phase}，还剩{time}。让下一拍接得漂亮。",
    ],
  },
});

const PHASE_COPY: Readonly<Record<ProgramPhase, string>> = Object.freeze({
  opening: "节目刚开始",
  building: "节目正在展开",
  peak: "节目进入高点",
  cooldown: "节目逐步放松",
  closing: "节目接近尾声",
});

/**
 * A deterministic, fact-constrained host used only as the credential-free
 * local fallback. It deliberately ignores track objects and other metadata.
 */
export class LocalHostProvider {
  private readonly model: string;
  private readonly maxTextLength: number;
  private readonly now: () => Date;

  constructor(options: LocalHostProviderOptions = {}) {
    this.model = normalizeModel(options.model);
    this.maxTextLength = positiveInteger(options.maxTextLength, DEFAULT_MAX_TEXT_LENGTH);
    this.now = options.now ?? (() => new Date());
  }

  get configured(): boolean {
    return true;
  }

  get state(): "ready" {
    return "ready";
  }

  getStatus(): LocalHostProviderStatus {
    return {
      provider: PROVIDER_NAME,
      configured: true,
      mock: false,
      baseUrl: "local://template",
      model: this.model,
      mode: "local",
      timeoutMs: 0,
      state: "ready",
    };
  }

  async generate(context: HostContextPack, options: HostGenerationOptions = {}): Promise<LocalHostResult> {
    const generatedAt = this.now().toISOString();
    const scenePreset = context?.scenePreset;
    const instruction = isScenePreset(scenePreset) ? SCENE_INSTRUCTIONS[scenePreset] : "";
    try {
      validateContext(context);
      if (options.signal?.aborted) {
        throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "timeout", "local host generation was cancelled", { retryable: false }));
      }

      const facts = normalizeFacts(context.allowedFacts);
      const recentHostLines = normalizeRecentLines(context.recentHostLines);
      const phase = PHASE_COPY[context.programPhase];
      const time = timePhrase(context.timeRemainingSeconds);
      const style = STYLE_COPY[context.scenePreset];
      const templates = momentTemplates(context, facts.length > 0 ? style.withFacts : style.withoutFacts, facts.length > 0);
      const fact = facts.length > 0 ? facts[hashText(`${context.scenePreset}:${context.programPhase}:${context.timeRemainingSeconds}`) % facts.length] : undefined;
      const candidates = templates.map((template) => {
        const text = template
          .replace("{phase}", phase)
          .replace("{time}", time)
          .replace("{fact}", fact?.value ?? "");
        return {
          text: limitText(text, this.maxTextLength),
          factIds: fact ? [fact.id] : [],
        };
      });
      const selected = selectNonRepeating(
        candidates,
        recentHostLines,
        hashText(`${context.scenePreset}|${context.programPhase}|${context.timeRemainingSeconds}|${recentHostLines.join("|")}`),
        this.maxTextLength,
      );

      return {
        provider: PROVIDER_NAME,
        status: "ready",
        configured: true,
        mock: false,
        success: true,
        text: openingTextWithIdentity(selected.text, context, this.maxTextLength, this.now()),
        factIds: selected.factIds,
        instruction,
        deliveryInstruction: deliveryInstructionFor(context.scenePreset, context.hostMoment),
        generatedAt,
        model: this.model,
        apiMode: "mock",
      };
    } catch (error) {
      const failure = asProviderError(error).toInfo();
      return {
        provider: PROVIDER_NAME,
        status: "failed",
        configured: true,
        mock: false,
        success: false,
        text: "",
        factIds: [],
        instruction,
        generatedAt,
        model: this.model,
        apiMode: "mock",
        error: failure,
      };
    }
  }

  async generateOrThrow(context: HostContextPack, options: HostGenerationOptions = {}): Promise<LocalHostResult> {
    const result = await this.generate(context, options);
    if (!result.success && result.error) throw new ProviderError(result.error);
    return result;
  }

  async generatePlaylistNames(request: PlaylistNamingRequest, options: HostGenerationOptions = {}): Promise<PlaylistNamingResult> {
    if (options.signal?.aborted || !isScenePreset(request.scenePreset) || !Array.isArray(request.tracks) || request.tracks.length === 0) {
      return { success: false, names: [] };
    }
    const choices: Record<PlaylistNamingRequest["scenePreset"], readonly string[]> = {
      late_night: ["微光慢行", "舒展回声", "松弛漫游", "清风低语", "轻柔潮汐", "慢拍来信"],
      study: ["书页微风", "静心流光", "专注回廊", "思绪漫游", "窗边光影", "清醒时分"],
      workout: ["热力脉冲", "燃动时刻", "节拍冲线", "能量跃动", "心跳加速", "热汗节奏"],
      commute: ["律动前行", "节拍声景", "明亮脉冲", "轻快流光", "沿拍回声", "流动旋律"],
      party: ["霓虹热浪", "欢聚脉冲", "舞池升温", "闪耀节拍", "狂欢声浪", "热场时刻"],
    };
    const signature = request.tracks.map((track) => `${track.title}|${track.artist}`).join("|");
    const sceneChoices = choices[request.scenePreset];
    const start = hashText(`${request.scenePreset}|${request.energyCurve}|${signature}`) % sceneChoices.length;
    return { success: true, names: sceneChoices.map((_, index) => sceneChoices[(start + index) % sceneChoices.length]) };
  }
}

function deliveryInstructionFor(scenePreset: HostContextPack["scenePreset"], moment: HostContextPack["hostMoment"]): string {
  const scene = {
    late_night: "声音放轻，语速偏慢，句尾下沉，句间留一点呼吸。",
    study: "语速稳定清晰，重音克制，句间短停，不打断专注。",
    workout: "语气有能量但不喊叫，节奏利落，重点词轻微加重。",
    commute: "自然亲切，语速中等，跟着节拍推进，转折处轻停。",
    party: "语气明亮有弹性，节奏稍快，带一点笑意但不要夸张。",
  }[scenePreset];
  const momentHint = moment === "scene_boost" ? "这次更像一句短陪伴。" : "内容说完后自然收尾。";
  return `${scene}${momentHint}`;
}

function openingTextWithIdentity(text: string, context: HostContextPack, maxLength: number, now: Date): string {
  if (context.programPhase !== "opening" && context.hostMoment !== "opening") return text;
  const profileId = context.hostProfile && HOST_PROFILES[context.hostProfile] ? context.hostProfile : DEFAULT_HOST_PROFILE;
  const greetingPattern = /^(?:早上好|上午好|中午好|下午好|傍晚好|晚上好|夜深了|你好)[，,。！!\s]*/;
  const timeGreeting = text.match(greetingPattern)?.[0]?.replace(/[，,。！!\s]+$/g, "") || radioGreetingAt(now);
  const body = text.replace(greetingPattern, "").trim();
  return limitText(`${timeGreeting ? `${timeGreeting}，` : ""}${hostOpeningIdentity(profileId)}${body}`, maxLength);
}

function momentTemplates(context: HostContextPack, fallback: readonly string[], hasFacts: boolean): readonly string[] {
  const moment = context.hostMoment ?? "opening";
  if (moment === "song_note" && hasFacts) return [
    "刚才这一段的已知信息是：{fact}。不急着解释太多，让旋律自己把情绪说完，也给耳朵留一点空间。",
    "把刚才这首的已知信息记下来：{fact}。这一段适合慢慢听，下一次换气时，我们再把故事接上。",
  ];
  if (moment === "next_preview" && hasFacts) return [
    "下一段准备接入一首已确认的候选：{fact}。先把当前的情绪收稳，再让新的节拍自然进来。",
    "接下来会靠近这首已确认的候选：{fact}。不用急着切换，给前一段一个完整的落点。",
  ];
  if (moment === "scene_boost") {
    const copy: Record<string, readonly string[]> = {
      late_night: ["先让呼吸和节奏都慢一点，不急着给这一刻下结论。把这一段听完，让旋律把空间慢慢铺开。"],
      study: ["把注意力放回眼前这一小步。今天不需要一次完成所有事情，先把这一段稳定地做完，下一步自然会清楚。"],
      workout: ["这里可以稍微调整一下呼吸。下一组不用抢，稳住节奏，把力气留给真正需要发力的地方。"],
      commute: ["节拍还在继续，先让这一段律动带着你往前。别急着填满每一秒，给旋律留一点空间。"],
      party: ["气氛先别降下来，下一拍继续往前推。把声音打开一点，把今天的好心情留在现场。"],
    };
    return copy[context.scenePreset] ?? fallback;
  }
  if (moment === "music_news" && hasFacts) return [
    "这一段只分享已经确认的信息：{fact}。音乐之外的小故事，等有可靠资料的时候再慢慢讲给你听。",
  ];
  return fallback;
}

export function createLocalHostProvider(options: LocalHostProviderOptions = {}): LocalHostProvider {
  return new LocalHostProvider(options);
}

function validateContext(context: HostContextPack): asserts context is HostContextPack & { programPhase: ProgramPhase } {
  if (!context || typeof context !== "object" || !isScenePreset(context.scenePreset)) {
    throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_input", "scenePreset is not supported", { retryable: false }));
  }
  if (!(PROGRAM_PHASES as readonly string[]).includes(context.programPhase)) {
    throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_input", "programPhase is not supported", { retryable: false }));
  }
}

function normalizeFacts(value: unknown): LocalFact[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const facts: LocalFact[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    const factValue = typeof record.value === "string" ? record.value.trim() : "";
    const dedupeId = id.trim();
    if (!dedupeId || !factValue || seen.has(dedupeId)) continue;
    seen.add(dedupeId);
    facts.push({ id, value: limitText(factValue, 72) });
  }
  return facts;
}

function normalizeRecentLines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((line): line is string => typeof line === "string" && line.trim().length > 0).map((line) => line.trim());
}

function selectNonRepeating<T extends { text: string }>(candidates: readonly T[], recentLines: readonly string[], startIndex: number, maxTextLength: number): T {
  if (candidates.length === 0) throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_response", "local host has no available template", { retryable: false }));
  const recent = new Set(recentLines.map(normalizeLine));
  for (let offset = 0; offset < candidates.length; offset += 1) {
    const candidate = candidates[(startIndex + offset) % candidates.length];
    if (!recent.has(normalizeLine(candidate.text))) return candidate;
  }
  // Keep a bounded, style-neutral variation if the caller supplied every
  // normal template as a recent line. This still avoids repeating history.
  const base = candidates[startIndex % candidates.length];
  const suffixes = [" 换一段新的播报。", " 继续保持当下。", " 留一点新的空间。"];
  for (const suffix of suffixes) {
    const variant = { ...base, text: limitText(`${base.text}${suffix}`, maxTextLength) };
    if (!recent.has(normalizeLine(variant.text))) return variant;
  }
  return base;
}

function timePhrase(value: unknown): string {
  const seconds = typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  if (seconds < 60) return "不到1分钟";
  return `约${Math.ceil(seconds / 60)}分钟`;
}

function limitText(value: string, maxLength: number): string {
  const normalized = value.trim();
  return Array.from(normalized).slice(0, maxLength).join("");
}

function normalizeLine(value: string): string {
  return value.replace(/[\s，。！？、,.!?；;:"“”‘’'「」『』]/g, "").toLowerCase();
}

function hashText(value: string): number {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normalizeModel(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : DEFAULT_MODEL;
}

function positiveInteger(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function asProviderError(error: unknown): ProviderError {
  if (isProviderError(error)) return error;
  const message = safeUpstreamMessage(error instanceof Error ? error.message : undefined, "local host generation failed");
  return new ProviderError(providerErrorInfo(PROVIDER_NAME, "network_error", message, { retryable: false }), { cause: error });
}

export type { LocalHostResult };
