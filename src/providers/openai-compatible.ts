import type { HostContextPack } from "../shared/contracts.js";
import { hostCharacterBounds, normalizeSpokenEnglishCase, normalizeSpokenYearDigits, radioGreetingAt } from "../core/host-script-planning.js";
import { getSceneConfig } from "../core/scenes.js";
import { DEFAULT_HOST_PROFILE, HOST_PROFILES, hostOpeningIdentity, type HostProfileId } from "../shared/program-options.js";
import {
  OPENAI_API_MODES,
  ProviderError,
  SCENE_INSTRUCTIONS,
  isScenePreset,
  type HostGenerationOptions,
  type HostGenerationResult,
  type HostShowBreak,
  type HostShowGenerationRequest,
  type HostShowGenerationResult,
  type HostProvider,
  type HostProviderStatus,
  type MusicResearchFact,
  type MusicResearchRequest,
  type OpenAICompatibleHostProviderOptions,
  type OpenAIApiMode,
  type PlaylistNamingRequest,
  type PlaylistNamingResult,
  type ProviderErrorInfo,
  type ReasoningEffort,
} from "./types.js";
import {
  fetchWithTimeout,
  findBusinessFailure,
  httpError,
  isProviderError,
  providerErrorInfo,
  readResponseBody,
  safeUpstreamMessage,
} from "./http.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-5.4-mini";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_TEXT_LENGTH = 600;
const PROVIDER_NAME = "openai-compatible";
const MUSIC_RESEARCH_TIMEOUT_MS = 20_000;
const WHOLE_SHOW_BUDGET_MS = 185_000;
const WHOLE_SHOW_REVIEW_TIMEOUT_MS = 45_000;
const WHOLE_SHOW_REWRITE_TIMEOUT_MS = 45_000;
const WHOLE_SHOW_MAX_REWRITES = 2;

const GENERATOR_SYSTEM_PROMPT = [
  "你是本地音乐电台的中文主持人兼撰稿人。先考虑听众体验，再根据节目上下文和 allowedFacts 写候选口播。",
  "不得猜测用户的位置、心情、记忆、身体或私人经历，不得创造歌曲或艺人事实。",
  "熟悉歌曲通常安排 12 至 18 秒，只补一个新信息；探索歌曲通常安排 25 至 35 秒，优先介绍音乐人和作品来路。普通话自然播报按每秒约 2.8 至 3.7 个汉字估算，宁可缩短，也不准用空话补齐。",
  "整档节目轮换点评上一首、艺人聚焦和核验故事；不要同时报出两首未来歌曲，不要提及马上要播歌曲之后的任何曲目。",
  "艺人背景、长期风格、经典成就、奖项意义、近况、公众评价、制作、唱腔与歌曲逸事都必须引用明确支持该说法的 allowedFacts；没有证据就省略。",
  "把事实讲成人话，不逐条朗读资料。自然口语来自具体材料和清楚的词序，不来自网络流行词、口头禅、态度引导或故意俏皮。",
  "每段只讲一个重点。后一句接住前一句刚出现的人、作品或创作过程，不套固定的起承转合。",
  "探索歌曲优先介绍音乐人的职业与创作背景、歌曲的创作缘起和制作过程、作品或专辑的风格特色与创作理念。经典歌曲优先说明被记住的成就、影响或故事，不能只说经典或耳熟能详。奖项和轶事只有能帮助理解作品时才使用；事实不够就缩短，只介绍艺人和歌名。专辑与单曲同名时不要报专辑名。",
  "作词、作曲、编曲和制作人名单不是默认口播材料。只有名单本身能解释合作关系、创作缘起、声音风格或经典地位时才提；否则优先讲歌手背景、作品风格、成就或故事。",
  "第一段像专业音乐节目开场：先做一句时间问好，再逐字接上上下文里的 openingIdentity，然后马上交代第一首；不念流程、不喊口号。中段直接进入人物或故事，不重复欢迎。",
  "当 programPhase 是 closing 时，这段位于最后一首歌前，第一句用自然口语明确说这是最后一首；随后介绍歌曲，不做大会总结，不说正式告别词。",
  "不得把资料不足写进口播，不要说“没有资料”“无法核验”“不贴标签”“不补写”等幕后说明；缺少可靠背景事实时，只介绍艺人、歌名和专辑，不用场景陪伴或听感引导凑字数。",
  "如果启用了 web_search_preview，只搜索相邻歌曲、艺人或音乐行业的可靠公开资料；没有可靠结果就省略新闻和奇闻，不要用常识补写。",
  "口吻像做过功课的中文音乐节目主持人：说话自然，主语和动作尽早出现，一句话一口气能说完；不用播音腔、广告腔、固定模板或喊叫。",
  "口播正文不用冒号、破折号和“不是……而是……”式翻案句。报歌用“接下来听某某的《歌名》”这类自然句子，不说“马上播出”。",
  "英文歌名、专辑名和艺人名使用正常首字母大写；不要输出 BLUE、OPEN MUSIC RADIO、CINNAMON CURLS 这类连续全大写英文，以免中文 TTS 逐字母误读。",
  "年份必须使用阿拉伯数字加“年”，例如 2017年、2024年；绝对不要写二〇一七年、二零一七年这类中文数字年份。",
  "禁止“探索位”“背景有点东西”“先听完再说”“别急着下结论”“看看合不合拍”“顺手认识一下”以及同类没有音乐信息的填充表达。",
  "必须先写三个内容角度真正不同的候选，不得只换同义词或句序。每个候选都必须独立满足时长、事实和节目位置要求。",
  "只返回 JSON，不要 Markdown：{\"candidates\":[{\"angle\":\"切入点\",\"text\":\"口播\",\"factIds\":[\"事实ID\"],\"deliveryInstruction\":\"TTS演绎指令\"}]}。",
  "deliveryInstruction 不超过 80 字，只写语速、停顿、重音、情绪和句尾处理，不增加事实。",
].join("\n");

const REVIEWER_SYSTEM_PROMPT = [
  "你是这档音乐节目的独立监制。你只审核主持人候选，不能代写、补句或润色。",
  "从听众体验出发判断：这段是否真的提供了值得听的信息，是否像真实主持人在说话，是否适合此刻的节目位置。",
  "逐项检查事实均有 factIds 支持、没有幕后说明或虚构、长度合规、歌手歌名清楚、没有百科履历或空泛抒情、没有广告腔播音腔短视频腔。",
  "检查每句话是否增加音乐信息。网络流行词、口头禅、听歌建议、让听众下结论或判断合不合拍的句子都应退回删除。",
  "正文出现冒号、破折号、翻案句或“马上播出”时退回，要求改成正常说话顺序。",
  "年份必须写成阿拉伯数字加“年”，例如 2017年；出现二〇一七年、二零一七年等中文数字年份时退回。",
  "探索歌曲应优先讲音乐人背景、创作过程、音乐风格、专辑特色或创作理念；经典歌曲应说明成就、影响或故事；事实不足时允许缩短，不能用气氛句补足长度。",
  "作词、作曲、编曲名单不能成为主要内容。除非候选解释了这些人为什么影响作品来路、风格或经典地位，否则退回要求改写为歌手背景、作品风格、成就或故事。",
  "结合 recentHostLines 检查是否重复开头、句式、信息类型和结尾。closing 必须在第一句明确这是最后一首；非 closing 不得提前告别。",
  "opening 必须在时间问好后出现上下文里的 openingIdentity，然后再介绍第一首；middle 和 closing 不得重复欢迎收听和主持人身份。",
  "三个候选必须有真实不同的叙述角度。只要存在硬伤就全部打回，并给撰稿人具体可执行的问题；不要因为其中一稿相对较好就降低标准。",
  "只有至少一稿完全合格时才批准并选择一稿。只返回 JSON：{\"approved\":true,\"selectedIndex\":0,\"issues\":[],\"rationale\":\"选择理由\"}。",
  "不通过时返回：{\"approved\":false,\"selectedIndex\":null,\"issues\":[\"具体问题和明确修改方向\"],\"rationale\":\"退回原因\"}。这些反馈会交给主持人修改；最多两轮修改，最后一轮直接作为可播版本输出。",
].join("\n");

const PLAYLIST_NAMING_PROMPT = [
  "你为一档中文 AI 音乐电台命名本次节目歌单。",
  "根据场景、能量走势以及本次实际入选的曲名和艺术家，概括整张歌单独有的听感。",
  "返回 3 个不同候选，每个必须是 3 至 6 个汉字组成的自然中文名词或意象短语。",
  "不要包含日期、时间、数字、标点、空格、AI、电台或场景名称，不要解释。",
  "只返回 JSON：{\"names\":[\"月下慢行\",\"微光回声\",\"夜色漫游\"]}",
].join("\n");

export interface HostPrompt {
  system: string;
  user: string;
}

export class OpenAICompatibleHostProvider implements HostProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly reviewModel: string;
  private readonly reasoningEffort: ReasoningEffort;
  private readonly mode: OpenAIApiMode;
  private readonly enableWebSearch: boolean;
  private readonly timeoutMs: number;
  private readonly maxTextLength: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => Date;
  private readonly secureTransport: boolean;
  private runtimeState: string;

  constructor(options: OpenAICompatibleHostProviderOptions = {}) {
    const env = options.env ?? process.env;
    this.apiKey = (options.apiKey ?? env.OPENAI_API_KEY ?? "").trim();
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL);
    this.secureTransport = isCredentialTransportSecure(this.baseUrl, options.allowInsecureHttp === true || env.OPENAI_ALLOW_INSECURE_HTTP === "1");
    this.runtimeState = !this.apiKey
      ? "blocked_by_credentials"
      : this.secureTransport
        ? "configured_unverified"
        : "blocked_by_insecure_transport";
    this.model = (options.model ?? env.OPENAI_MODEL ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
    this.reviewModel = (options.reviewModel ?? env.OPENAI_REVIEW_MODEL ?? this.model).trim() || this.model;
    this.reasoningEffort = options.reasoningEffort ?? (env.OPENAI_REASONING_EFFORT === "low" || env.OPENAI_REASONING_EFFORT === "medium" ? env.OPENAI_REASONING_EFFORT : "high");
    this.mode = normalizeMode(options.mode ?? env.OPENAI_API_MODE ?? "auto");
    this.enableWebSearch = options.enableWebSearch === true || env.OPENAI_ENABLE_WEB_SEARCH === "1";
    this.timeoutMs = options.timeoutMs === 0 || env.OPENAI_TIMEOUT_MS === "0"
      ? 0
      : positiveInteger(options.timeoutMs ?? env.OPENAI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    this.maxTextLength = positiveInteger(options.maxTextLength, DEFAULT_MAX_TEXT_LENGTH);
    this.fetchImpl = options.fetchImpl ?? options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? (() => new Date());
  }

  getStatus(): HostProviderStatus {
    return {
      provider: PROVIDER_NAME,
      configured: this.configured,
      mock: !this.apiKey,
      baseUrl: this.baseUrl,
      model: this.model,
      mode: this.mode,
      timeoutMs: this.timeoutMs,
    };
  }

  get configured(): boolean {
    return Boolean(this.apiKey) && this.secureTransport;
  }

  get state(): string {
    return this.runtimeState;
  }

  async generate(context: HostContextPack, options: HostGenerationOptions = {}): Promise<HostGenerationResult> {
    const generatedAt = this.now().toISOString();
    try {
      const scenePreset = validateContext(context);
      const instruction = SCENE_INSTRUCTIONS[scenePreset];
      if (!this.apiKey) {
        return {
          provider: PROVIDER_NAME,
          status: "mock",
          configured: false,
          mock: true,
          success: true,
          text: deterministicMockText(context),
          factIds: [],
          instruction,
          generatedAt,
          model: this.model,
          apiMode: "mock",
        };
      }
      if (!this.secureTransport) {
        throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_input", "provider credentials require HTTPS; HTTP is allowed only on loopback", { retryable: false }));
      }

      const modes = this.mode === "auto" ? (["responses", "chat_completions"] as const) : ([this.mode] as const);
      let lastError: ProviderError | undefined;
      for (const mode of modes) {
        try {
          const reviewEnabled = Boolean(context.reviewInstruction?.trim());
          // Research is completed before this flow. The writer and reviewer
          // consume only the locked context and never launch another search.
          const firstPayload = await this.request(mode, buildHostPrompt(context), options.signal, false, reviewEnabled ? 1_800 : 800);
          let parsed: ParsedHostPayload;
          if (reviewEnabled) {
            const reviewOutcome = await this.reviewCandidates(mode, context, firstPayload, options.signal);
            if (reviewOutcome.parsed) {
              parsed = reviewOutcome.parsed;
            } else {
              const finalPayload = await this.request(mode, buildHostFinalRewritePrompt(context, reviewOutcome.feedback), options.signal, false, 1_000);
              parsed = parseHostPayload(finalPayload, context, this.maxTextLength);
            }
          } else {
            parsed = parseHostPayload(firstPayload, context, this.maxTextLength);
          }
          this.runtimeState = "ready";
          return readyHostResult(parsed, instruction, generatedAt, this.model, mode);
        } catch (error) {
          const providerError = asProviderError(error);
          lastError = providerError;
          if (this.mode !== "auto" || mode !== "responses" || providerError.code !== "unsupported") {
            throw providerError;
          }
        }
      }
      throw lastError ?? new ProviderError(providerErrorInfo(PROVIDER_NAME, "network_error", "provider request failed", { retryable: true }));
    } catch (error) {
      const failure = asProviderError(error).toInfo();
      if (context.reviewInstruction?.trim() && context.currentTrack) {
        this.runtimeState = "ready_with_fallback";
        const fallback = createGuaranteedHostFallback(context);
        return readyHostResult(fallback, safeInstruction(context), generatedAt, this.model, this.apiKey ? this.mode : "mock", true);
      }
      if (failure.code === "unauthorized") this.runtimeState = "blocked_by_credentials";
      else if (this.apiKey && !this.secureTransport) this.runtimeState = "blocked_by_insecure_transport";
      else if (this.apiKey) this.runtimeState = "failed_technical";
      return {
        provider: PROVIDER_NAME,
        status: "failed",
        configured: this.configured,
        mock: false,
        success: false,
        text: "",
        factIds: [],
        instruction: safeInstruction(context),
        generatedAt,
        model: this.model,
        apiMode: this.apiKey ? this.mode : "mock",
        error: failure,
      };
    }
  }

  async generateShow(request: HostShowGenerationRequest, options: HostGenerationOptions = {}): Promise<HostShowGenerationResult> {
    const generatedAt = this.now().toISOString();
    try {
      if (!this.configured || !isScenePreset(request.scenePreset) || request.tracks.length === 0) {
        throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_input", "whole-show host request is not configured", { retryable: false }));
      }
      const mode = this.mode === "chat_completions" ? "chat_completions" : "responses";
      const deadlineAt = this.timeoutMs === 0 ? Number.POSITIVE_INFINITY : Date.now() + WHOLE_SHOW_BUDGET_MS;
      const timeoutFor = (capMs: number): number => {
        if (this.timeoutMs === 0) return 0;
        const remainingMs = deadlineAt - Date.now();
        if (remainingMs <= 0) {
          throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "timeout", "whole-show generation exceeded its time budget", { retryable: false }));
        }
        return Math.max(1, Math.min(capMs, remainingMs));
      };
      const runStage = async <T>(operation: (timeoutMs: number) => Promise<T>, capMs = this.timeoutMs): Promise<T> => {
        let firstError: ProviderError | undefined;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            return await operation(timeoutFor(capMs));
          } catch (error) {
            const providerError = asProviderError(error);
            firstError ??= providerError;
            if (attempt > 0 || providerError.code === "timeout" || (!providerError.retryable && providerError.code !== "invalid_response")) throw providerError;
          }
        }
        throw firstError ?? new ProviderError(providerErrorInfo(PROVIDER_NAME, "network_error", "whole-show stage failed", { retryable: true }));
      };
      let breaks = await runStage(async (timeoutMs) => {
        const payload = await this.request(mode, buildHostShowPrompt(request), options.signal, false, 4_000, timeoutMs);
        return parseHostShowPayload(payload, request, false);
      });
      for (let rewrite = 0; rewrite < WHOLE_SHOW_MAX_REWRITES; rewrite += 1) {
        const review = await runStage(async (timeoutMs) => {
          const payload = await this.request(mode, buildHostShowReviewPrompt(request, breaks), options.signal, false, 2_400, timeoutMs, this.reviewModel);
          return parseHostShowReviewPayload(payload);
        }, WHOLE_SHOW_REVIEW_TIMEOUT_MS);
        if (review.approved) break;
        breaks = await runStage(async (timeoutMs) => {
          const payload = await this.request(mode, buildHostShowPrompt(request, review.feedback, rewrite + 1), options.signal, false, 4_000, timeoutMs);
          return parseHostShowPayload(payload, request, false);
        }, WHOLE_SHOW_REWRITE_TIMEOUT_MS);
      }
      this.runtimeState = "ready";
      return { success: true, provider: PROVIDER_NAME, status: "ready", model: this.model, reviewModel: this.reviewModel, apiMode: mode, breaks, generatedAt };
    } catch (error) {
      const failure = asProviderError(error).toInfo();
      this.runtimeState = failure.code === "unauthorized" ? "blocked_by_credentials" : "failed_technical";
      return {
        success: false,
        provider: PROVIDER_NAME,
        status: "failed",
        model: this.model,
        reviewModel: this.reviewModel,
        apiMode: this.apiKey ? this.mode : "mock",
        breaks: [],
        generatedAt,
        error: failure,
      };
    }
  }

  private async reviewCandidates(
    mode: Exclude<OpenAIApiMode, "auto">,
    context: HostContextPack,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<{ parsed: ParsedHostPayload | null; feedback: string }> {
    const candidates = parseHostCandidates(payload, context, this.maxTextLength);
    const reviewPayload = await this.request(mode, buildHostReviewPrompt(context, candidates), signal, false, 800, this.timeoutMs, this.reviewModel);
    const review = parseHostReviewPayload(reviewPayload, candidates.length);
    if (!review.approved || review.selectedIndex === null) {
      return {
        parsed: null,
        feedback: [...review.issues, review.rationale].filter(Boolean).join("；").slice(0, 1_200),
      };
    }
    return { parsed: candidates[review.selectedIndex]!, feedback: "" };
  }

  /** Throws the typed error instead of returning a failed result for lower-level callers. */
  async generateOrThrow(context: HostContextPack, options: HostGenerationOptions = {}): Promise<HostGenerationResult> {
    const result = await this.generate(context, options);
    if (!result.success && result.error) throw new ProviderError(result.error);
    return result;
  }

  async research(request: MusicResearchRequest, options: HostGenerationOptions = {}): Promise<MusicResearchFact[]> {
    if (!this.configured || !this.enableWebSearch || !isScenePreset(request.scenePreset)) return [];
    const trackBatches = chunk(request.tracks.slice(0, 12), 4);
    const batches = await Promise.all(trackBatches.map(async (tracks) => {
      const prompt: HostPrompt = {
        system: [
          "你是音乐电台的资料编辑，只做有限的公开网页检索。",
          "为中文音乐电台寻找与给定歌曲和艺术家直接相关的可核验资料。优先覆盖：艺人成长与职业背景、长期音乐风格、歌曲创作时期和制作故事、作品或专辑的声音特色与创作理念、经典地位、重要奖项或公开成就，以及该作品对艺人生涯的公开意义。",
          "作词、作曲、编曲名单只在来源说明其合作关系、创作缘起、风格形成或经典意义时返回；不要把普通制作名单当成主要事实。",
          "公开轶事、合作关系、争议或趣闻只能来自艺人采访、唱片公司、奖项机构、主流媒体等可靠来源；不返回匿名爆料、粉丝猜测、私人关系推断或未经证实的传闻。",
          "输入中 exploration=true 的歌曲是用户不熟悉的探索曲目，优先为它们寻找 2-3 条互补事实；其他歌曲每位艺人最多 1-2 条。",
          "每条事实单独一行，格式为 FACT: 可直接用于口播的一句事实，并在该行末尾保留 Responses 网页搜索生成的 URL 引用标注。不要输出 JSON。",
          "关键：没有工具引用标注的事实不要返回；一行只写一条事实和一个来源。",
          "每条必须明确写出对应歌名或艺人名，20-200 个中文字符，并附公开 HTTPS 来源；单批最多 8 条，找不到可靠资料时不返回该项。",
          "不要推测用户隐私，不要返回歌词、下载链接或无法核验的营销文案。",
        ].join("\n"),
        user: JSON.stringify({
          scenePreset: request.scenePreset,
          musicAtmosphere: getSceneConfig(request.scenePreset).label,
          tracks,
        }),
      };
      try {
        const payload = await this.request("responses", prompt, options.signal, true, 1_600, this.timeoutMs === 0 ? 0 : Math.min(this.timeoutMs, MUSIC_RESEARCH_TIMEOUT_MS));
        return parseResearchFacts(payload);
      } catch {
        return [];
      }
    }));
    return batches
      .flat()
      .filter((fact, index, facts) => facts.findIndex((candidate) => candidate.value === fact.value && candidate.sourceUrl === fact.sourceUrl) === index)
      .slice(0, 18)
      .map((fact, index) => ({ ...fact, id: `web:${index + 1}` }));
  }

  async generatePlaylistNames(request: PlaylistNamingRequest, options: HostGenerationOptions = {}): Promise<PlaylistNamingResult> {
    if (!this.configured || !isScenePreset(request.scenePreset) || !Array.isArray(request.tracks) || request.tracks.length === 0) {
      return { success: false, names: [] };
    }
    const prompt: HostPrompt = {
      system: PLAYLIST_NAMING_PROMPT,
      user: JSON.stringify({
        scenePreset: request.scenePreset,
        musicAtmosphere: getSceneConfig(request.scenePreset).label,
        energyCurve: String(request.energyCurve ?? "").slice(0, 120),
        tracks: request.tracks.slice(0, 16).map((track) => ({
          title: String(track.title ?? "").trim().slice(0, 80),
          artist: String(track.artist ?? "").trim().slice(0, 80),
        })),
      }),
    };
    const modes = this.mode === "auto" ? (["responses", "chat_completions"] as const) : ([this.mode] as const);
    for (const mode of modes) {
      try {
        const payload = await this.request(mode, prompt, options.signal, false);
        const names = parsePlaylistNames(payload);
        if (names.length > 0) return { success: true, names };
      } catch (error) {
        const providerError = asProviderError(error);
        if (this.mode !== "auto" || mode !== "responses" || providerError.code !== "unsupported") break;
      }
    }
    return { success: false, names: [] };
  }

  private async request(mode: Exclude<OpenAIApiMode, "auto">, prompt: HostPrompt, signal?: AbortSignal, includeWebSearch = this.enableWebSearch, maxOutputTokens = 800, timeoutMs = this.timeoutMs, model = this.model): Promise<unknown> {
    const endpoint = `${this.baseUrl}/${mode === "responses" ? "responses" : "chat/completions"}`;
    const body = mode === "responses"
      ? {
          model,
          input: [
            { role: "system", content: [{ type: "input_text", text: prompt.system }] },
            { role: "user", content: [{ type: "input_text", text: prompt.user }] },
          ],
          max_output_tokens: maxOutputTokens,
          reasoning: { effort: this.reasoningEffort },
          ...(includeWebSearch ? { tools: [{ type: "web_search" }] } : {}),
        }
      : {
          model,
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
          ],
          max_tokens: maxOutputTokens,
          reasoning_effort: this.reasoningEffort,
          response_format: { type: "json_object" },
        };

    const init: RequestInit = {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    };
    const response = timeoutMs === 0
      ? await this.fetchImpl(endpoint, init)
      : await fetchWithTimeout(this.fetchImpl, endpoint, init, { timeoutMs, signal, provider: PROVIDER_NAME });

    const status = Number(response.status ?? 200);
    const bodyResult = await readResponseBody(response);
    if (status < 200 || status >= 300 || response.ok === false) {
      throw httpError(PROVIDER_NAME, status, response.headers);
    }
    if (bodyResult.json === undefined) {
      throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_response", "provider returned invalid JSON", { retryable: false }));
    }
    const businessFailure = findBusinessFailure(bodyResult.json);
    if (businessFailure) {
      throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "business_error", businessFailure.message, { retryable: false }));
    }
    return bodyResult.json;
  }
}

function isCredentialTransportSecure(baseUrl: string, allowInsecureHttp: boolean): boolean {
  try {
    const url = new URL(baseUrl);
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    if (allowInsecureHttp) return true;
    return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  } catch {
    return false;
  }
}

export function createHostProvider(env: NodeJS.ProcessEnv = process.env): OpenAICompatibleHostProvider {
  return new OpenAICompatibleHostProvider({ env });
}

function safeHostContext(context: HostContextPack): Record<string, unknown> {
  const recentHostLines = Array.isArray(context.recentHostLines) ? context.recentHostLines : [];
  const allowedFacts = Array.isArray(context.allowedFacts) ? context.allowedFacts : [];
  const forbiddenClaims = Array.isArray(context.forbiddenClaims) ? context.forbiddenClaims : [];
  const targetSeconds = context.hostLengthSeconds ?? 16;
  const characterBounds = hostCharacterBounds(targetSeconds);
  const hostProfileId = normalizeHostProfile(context.hostProfile);
  const hostProfile = HOST_PROFILES[hostProfileId];
  const safeContext: Record<string, unknown> = {
    scenePreset: context.scenePreset,
    musicAtmosphere: getSceneConfig(context.scenePreset).label,
    host: {
      id: hostProfile.id,
      name: hostProfile.name,
      trait: hostProfile.trait,
    },
    openingIdentity: hostOpeningIdentity(hostProfileId),
    programPhase: context.programPhase,
    timeRemainingSeconds: context.timeRemainingSeconds,
    transitionReason: context.transitionReason,
    hostMoment: context.hostMoment ?? "opening",
    familiarity: context.isExploration === true ? "exploration" : "familiar",
    hostLengthSeconds: targetSeconds,
    hostCharacterRange: characterBounds,
    recentHostLines: recentHostLines.slice(-8),
    allowedFacts: allowedFacts.map(({ id, value, source, sourceUrl }) => ({ id, value, source, ...(sourceUrl ? { sourceUrl } : {}) })),
    forbiddenClaims,
  };
  if (context.listenerProfile) {
    safeContext.listenerProfile = {
      favoriteArtists: context.listenerProfile.favoriteArtists.slice(0, 8).map((item) => item.name),
      topSongs: context.listenerProfile.topSongs.slice(0, 8).map((item) => `${item.title} - ${item.artists.join("、")}`),
      inferredThemes: context.listenerProfile.inferredThemes.slice(0, 8),
    };
  }
  if (context.skillInstruction) {
    const publicTrack = (track: HostContextPack["currentTrack"]) => track ? {
      title: track.title,
      artist: track.artist,
      durationSeconds: track.durationSeconds,
    } : null;
    safeContext.musicContext = {
      previous: publicTrack(context.previousTrack),
      current: publicTrack(context.currentTrack),
      next: publicTrack(context.nextTrack),
    };
  }
  return safeContext;
}

export function buildHostPrompt(context: HostContextPack, reviewFeedback = ""): HostPrompt {
  const safeContext = safeHostContext(context);
  if (reviewFeedback) {
    safeContext.rewrite = {
      required: true,
      producerFeedback: reviewFeedback.slice(0, 1_200),
      instruction: "上一轮全部候选被节目监制退回。针对问题重新构思三个候选，不要只局部改词。",
    };
  }
  return {
    system: [GENERATOR_SYSTEM_PROMPT, context.skillInstruction?.trim().slice(0, 16_000)].filter(Boolean).join("\n\n"),
    user: JSON.stringify(safeContext),
  };
}

function safeHostShowRequest(request: HostShowGenerationRequest): Record<string, unknown> {
  const scene = getSceneConfig(request.scenePreset);
  const hostProfileId = normalizeHostProfile(request.hostProfile);
  const hostProfile = HOST_PROFILES[hostProfileId];
  return {
    frequency: request.frequency,
    scenePreset: request.scenePreset,
    ...(request.openingGreeting ? { openingGreeting: request.openingGreeting } : {}),
    host: {
      id: hostProfile.id,
      name: hostProfile.name,
      trait: hostProfile.trait,
    },
    openingIdentity: hostOpeningIdentity(hostProfileId),
    musicAtmosphere: scene.label,
    hostLanguageDirection: scene.hostLanguageDirection,
    ttsDirection: scene.ttsDirection,
    tracks: request.tracks.map((track) => ({
      trackIndex: track.trackIndex,
      title: track.title,
      artist: track.artist,
      ...(track.album ? { album: track.album } : {}),
      familiarity: track.exploration ? "exploration" : "familiar",
      listenerRelationship: track.exploration ? "not_yet_familiar" : "liked_by_listener",
      allowedFacts: track.allowedFacts.slice(0, 8).map(({ id, value, source }) => ({ id, value: value.slice(0, 360), source })),
    })),
    ...(request.listenerProfile ? { listenerProfile: {
      favoriteArtists: request.listenerProfile.favoriteArtists.slice(0, 8).map((item) => ({ name: item.name, score: item.score })),
      topSongs: request.listenerProfile.topSongs.slice(0, 8),
      inferredThemes: request.listenerProfile.inferredThemes.slice(0, 8),
      evidence: request.listenerProfile.evidence.slice(0, 8),
    } } : {}),
    ...(request.userAdjustment ? { userAdjustment: request.userAdjustment.slice(0, 500) } : {}),
  };
}

function buildHostShowPrompt(request: HostShowGenerationRequest, reviewFeedback = "", rewriteAttempt = 0): HostPrompt {
  const user = safeHostShowRequest(request);
  if (reviewFeedback) {
    user.rewrite = {
      required: true,
      attempt: rewriteAttempt,
      maxAttempts: WHOLE_SHOW_MAX_REWRITES,
      finalRound: rewriteAttempt >= WHOLE_SHOW_MAX_REWRITES,
      producerFeedback: reviewFeedback.slice(0, 2_000),
      instruction: rewriteAttempt >= WHOLE_SHOW_MAX_REWRITES
        ? "这是最后一次整档修改。修正监制意见后直接返回完整 breaks，本轮不会再因中段整体审查退回。"
        : "这是第一次整档修改。优先解决中间口播组的重复、语气和信息密度问题，重新返回完整 breaks，不得只返回局部。",
    };
  }
  return {
    system: [
      request.skillInstruction.slice(0, 48_000),
      "开场 opening 口播必须按顺序包含：时间问好、openingIdentity、第一首歌曲介绍。收尾 closing 必须在第一句自然说明这是最后一首。中段和收尾不得再次介绍电台或主持人身份。",
      "所有口播里的年份统一写阿拉伯数字，例如 2017年；禁止二〇一七年、二零一七年等中文数字年份。",
    ].join("\n\n"),
    user: JSON.stringify(user),
  };
}

function buildHostShowReviewPrompt(request: HostShowGenerationRequest, breaks: HostShowBreak[]): HostPrompt {
  return {
    system: request.reviewInstruction.slice(0, 48_000),
    user: JSON.stringify({
      context: safeHostShowRequest(request),
      reviewScope: "opening 和 closing 只检查固定硬伤；middle 作为一组整体审核语气、用词、信息密度、重复和衔接，不逐段打分。",
      completeShowDraft: { frequency: request.frequency, breaks },
    }),
  };
}

function withOpeningGreetingAndIdentity(
  text: string,
  greeting: NonNullable<HostShowGenerationRequest["openingGreeting"]>,
  profileId: HostProfileId | undefined,
): string {
  const identity = hostOpeningIdentity(normalizeHostProfile(profileId));
  const greetingPattern = /^(?:早上好|上午好|中午好|下午好|傍晚好|晚上好|夜深了|你好)[，,。！!\s]*/;
  const stationPattern = /^(?:(?:欢迎收听|这里是)\s*)?(?:Open\s*Music\s*Radio|OpenMusicRadio)\s*电台?[，,。！!\s]*/i;
  const hostPattern = /^我是主持人[\p{Script=Han}A-Za-z0-9_-]{1,16}[，,。！!\s]*/u;
  let rest = text
    .replace(greetingPattern, "")
    .replace(stationPattern, "")
    .replace(hostPattern, "")
    .trim();
  if (rest && !/[。！？!?]$/.test(identity)) rest = `。${rest}`;
  return rest ? `${greeting}，${identity}${rest}` : `${greeting}，${identity}`;
}

function parseHostShowPayload(payload: unknown, request: HostShowGenerationRequest, enforceDuration: boolean): HostShowBreak[] {
  for (const candidate of collectResponseCandidates(payload)) {
    const object = extractJsonObject(candidate);
    if (!object || !Array.isArray(object.breaks)) continue;
    const breaks = object.breaks.map((entry, index) => parseHostShowBreak(entry, request, index, enforceDuration));
    return breaks.sort((left, right) => left.beforeTrackIndex - right.beforeTrackIndex);
  }
  throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_response", "provider response did not contain a complete show draft", { retryable: false }));
}

function parseHostShowBreak(value: unknown, request: HostShowGenerationRequest, index: number, enforceDuration: boolean): HostShowBreak {
  if (!isPlainRecord(value)) throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_response", "show break is invalid", { retryable: false }));
  const beforeTrackIndex = Number(value.beforeTrackIndex);
  const track = request.tracks[beforeTrackIndex - 1];
  const rawText = typeof value.text === "string" ? value.text.trim() : "";
  const type = value.type === "opening" || value.type === "middle" || value.type === "closing" ? value.type : null;
  const targetSeconds = Number.isFinite(Number(value.targetSeconds)) && Number(value.targetSeconds) >= 5 && Number(value.targetSeconds) <= 35
    ? Math.round(Number(value.targetSeconds))
    : null;
  const rawSourceIds = Array.isArray(value.sourceIds) ? value.sourceIds.filter((id): id is string => typeof id === "string") : [];
  const allowedIds = new Set(track?.allowedFacts.map((fact) => fact.id) ?? []);
  if (!track || !rawText || !type || !targetSeconds) {
    throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_response", `show break ${index + 1} is incomplete`, { retryable: false }));
  }
  const text = normalizeSpokenYearDigits(normalizeSpokenEnglishCase(type === "opening" && request.openingGreeting
    ? withOpeningGreetingAndIdentity(rawText, request.openingGreeting, request.hostProfile)
    : rawText));
  const sourceIds = rawSourceIds.filter((id, sourceIndex) => allowedIds.has(id) && rawSourceIds.indexOf(id) === sourceIndex);
  if (sourceIds.length === 0) {
    const metadata = track.allowedFacts.find((fact) => fact.id.includes(":metadata")) ?? track.allowedFacts[0];
    if (metadata) sourceIds.push(metadata.id);
  }
  const bounds = hostCharacterBounds(targetSeconds);
  const count = Array.from(text).length;
  if (enforceDuration && (count < 12 || count > bounds.max)) {
    throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_response", `show break ${index + 1} does not match its duration`, { retryable: false }));
  }
  return {
    id: typeof value.id === "string" && value.id.trim() ? value.id.trim().slice(0, 80) : `break-${String(index + 1).padStart(2, "0")}`,
    beforeTrackIndex,
    type,
    targetSeconds,
    text: text.slice(0, DEFAULT_MAX_TEXT_LENGTH),
    sourceIds,
    deliveryInstruction: typeof value.deliveryInstruction === "string" ? value.deliveryInstruction.trim().slice(0, 160) : "自然口语，中速，音乐人和歌名说清楚。",
  };
}

function normalizeHostProfile(profileId: HostProfileId | undefined): HostProfileId {
  return profileId && HOST_PROFILES[profileId] ? profileId : DEFAULT_HOST_PROFILE;
}

function parseHostShowReviewPayload(payload: unknown): { approved: boolean; feedback: string } {
  for (const candidate of collectResponseCandidates(payload)) {
    const object = extractJsonObject(candidate);
    if (!object || typeof object.approved !== "boolean") continue;
    if (object.approved) return { approved: true, feedback: "" };
    const issues = Array.isArray(object.issues)
      ? object.issues.map((issue) => isPlainRecord(issue) ? `${String(issue.breakId ?? "整档")}: ${String(issue.problem ?? "")}；${String(issue.direction ?? "")}` : String(issue)).filter(Boolean)
      : [];
    if (issues.length === 0) throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_response", "producer rejection did not include actionable issues", { retryable: false }));
    return { approved: false, feedback: issues.join("\n").slice(0, 2_000) };
  }
  throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_response", "provider response did not contain a whole-show review", { retryable: false }));
}

function buildHostFinalRewritePrompt(context: HostContextPack, reviewFeedback: string): HostPrompt {
  const safeContext = safeHostContext(context);
  safeContext.rewrite = {
    required: true,
    finalRound: true,
    producerFeedback: reviewFeedback.slice(0, 1_200),
    instruction: "这是唯一一次重写。逐条解决监制意见，直接交付一份最终可播稿，不再生成候选。",
  };
  return {
    system: [
      GENERATOR_SYSTEM_PROMPT,
      context.skillInstruction?.trim().slice(0, 16_000),
      "本轮只返回最终 JSON，不再返回 candidates：{\"text\":\"最终口播\",\"factIds\":[\"事实ID\"],\"deliveryInstruction\":\"TTS演绎指令\"}。",
    ].filter(Boolean).join("\n\n"),
    user: JSON.stringify(safeContext),
  };
}

function buildHostReviewPrompt(context: HostContextPack, candidates: ParsedHostPayload[]): HostPrompt {
  return {
    system: [REVIEWER_SYSTEM_PROMPT, context.reviewInstruction?.trim().slice(0, 16_000)].filter(Boolean).join("\n\n"),
    user: JSON.stringify({
      context: safeHostContext(context),
      candidates: candidates.map((candidate, index) => ({ index, ...candidate })),
    }),
  };
}

export function extractJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const isContentPart = typeof record.type === "string" || typeof record.role === "string";
    if (!isContentPart && (typeof record.text === "string" || typeof record.approved === "boolean" || Array.isArray(record.candidates) || Array.isArray(record.breaks) || Array.isArray(record.factIds) || Array.isArray(record.fact_ids) || Array.isArray(record.facts))) return record;
  }
  if (typeof value !== "string") return undefined;
  const source = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    const parsed: unknown = JSON.parse(source);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Try the first balanced JSON object below. Models occasionally add one sentence around it.
  }

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "{") continue;
    const end = matchingBrace(source, index);
    if (end < 0) continue;
    try {
      const parsed: unknown = JSON.parse(source.slice(index, end + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Keep searching in case a prose brace appeared before the JSON object.
    }
  }
  return undefined;
}

interface ParsedHostPayload {
  text: string;
  factIds: string[];
  deliveryInstruction: string;
  angle?: string;
}

function readyHostResult(
  parsed: ParsedHostPayload,
  instruction: string,
  generatedAt: string,
  model: string,
  apiMode: OpenAIApiMode | "mock",
  fallback = false,
): HostGenerationResult {
  return {
    provider: PROVIDER_NAME,
    status: "ready",
    configured: true,
    mock: false,
    success: true,
    text: parsed.text,
    factIds: parsed.factIds,
    instruction,
    deliveryInstruction: parsed.deliveryInstruction,
    generatedAt,
    model,
    apiMode,
    ...(fallback ? { fallback: true } : {}),
  };
}

export function createGuaranteedHostFallback(context: HostContextPack): ParsedHostPayload {
  const requestedTargetSeconds = context.hostLengthSeconds ?? (context.isExploration ? 28 : 22);
  const targetSeconds = context.programPhase === "opening" ? Math.max(18, requestedTargetSeconds) : requestedTargetSeconds;
  const bounds = hostCharacterBounds(targetSeconds);
  const metadataFact = context.allowedFacts.find((fact) => /《[^》]+》.*艺术家是/.test(fact.value)) ?? context.allowedFacts[0];
  const metadata = metadataFact?.value.match(/《([^》]+)》.*?艺术家是([^。；]+)/);
  const title = metadata?.[1]?.trim() || context.currentTrack?.title || "这首歌";
  const artist = metadata?.[2]?.trim() || context.currentTrack?.artist || "这位音乐人";
  const isExploration = context.isExploration === true;
  const factIds = metadataFact ? [metadataFact.id] : [];
  const backgroundFacts = context.allowedFacts.filter((fact) => fact.id !== metadataFact?.id && !fact.id.startsWith("profile:") && fact.value.length >= 12);
  let text: string;
  if (context.programPhase === "opening") {
    text = `${radioGreetingAt(new Date())}，${hostOpeningIdentity(normalizeHostProfile(context.hostProfile))}今天的第一首是${artist}的《${title}》。`;
  } else if (context.programPhase === "closing") {
    text = `接下来是今天的最后一首，${artist}的《${title}》。`;
  } else {
    text = `接下来听${artist}的《${title}》。`;
  }
  const factLimit = isExploration ? (targetSeconds >= 30 ? 3 : 2) : (targetSeconds >= 20 ? 1 : 0);
  for (const fact of backgroundFacts.slice(0, factLimit)) {
    const sentence = `${fact.value.replace(/[。！？]+$/, "")}。`;
    if (Array.from(`${text}${sentence}`).length > bounds.max) continue;
    text += sentence;
    factIds.push(fact.id);
  }
  if (Array.from(text).length > bounds.max) text = `${Array.from(text).slice(0, bounds.max - 1).join("")}。`;
  return {
    text,
    factIds,
    deliveryInstruction: "自然口语，中速，音乐人和歌名说清楚；背景信息按正常叙述处理，不用播音腔。",
  };
}

function parseHostPayload(payload: unknown, context: HostContextPack, maxTextLength: number): ParsedHostPayload {
  const candidates = collectResponseCandidates(payload);
  for (const candidate of candidates) {
    const object = extractJsonObject(candidate);
    if (!object) continue;
    if (typeof object.text !== "string" || !object.text.trim()) continue;
    return parseHostObject(object, context, maxTextLength);
  }
  throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_response", "provider response did not contain the required host JSON", { retryable: false }));
}

function parseHostCandidates(payload: unknown, context: HostContextPack, maxTextLength: number): ParsedHostPayload[] {
  for (const candidate of collectResponseCandidates(payload)) {
    const object = extractJsonObject(candidate);
    if (!object || !Array.isArray(object.candidates)) continue;
    const entries = object.candidates.filter((item): item is Record<string, unknown> => isPlainRecord(item));
    if (entries.length !== 3) {
      throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_response", "writer must return exactly three host candidates", { retryable: false }));
    }
    const parsed = entries.map((entry) => parseHostObject(entry, context, maxTextLength, true));
    const normalizedAngles = parsed.map((entry) => entry.angle!.replace(/[\s，。！？、,.!?；;:："“”‘’'「」『』《》—-]/g, "").toLocaleLowerCase());
    const normalizedTexts = parsed.map((entry) => entry.text.replace(/\s/g, ""));
    if (new Set(normalizedAngles).size !== 3 || new Set(normalizedTexts).size !== 3) {
      throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_response", "host candidates must use three distinct angles", { retryable: false }));
    }
    return parsed;
  }
  throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_response", "provider response did not contain three host candidates", { retryable: false }));
}

function parseHostObject(object: Record<string, unknown>, context: HostContextPack, maxTextLength: number, requireAngle = false): ParsedHostPayload {
  const text = typeof object.text === "string" ? normalizeSpokenYearDigits(normalizeSpokenEnglishCase(object.text.trim())) : "";
  const angle = typeof object.angle === "string" ? object.angle.trim().slice(0, 100) : "";
  if (!text || (requireAngle && !angle)) {
    throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_response", "host candidate is incomplete", { retryable: false }));
  }
  if (text.length > maxTextLength) {
    throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_response", "host text exceeds the configured length limit", { retryable: false }));
  }
  if (context.hostLengthSeconds !== undefined) {
    const bounds = hostCharacterBounds(context.hostLengthSeconds);
    const characterCount = Array.from(text).length;
    if (characterCount < bounds.min || characterCount > bounds.max) {
      throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_response", "host text does not match the planned speaking duration", { retryable: false }));
    }
  }
  const rawFactIds = object.factIds ?? object.fact_ids ?? object.facts;
  const factIds = Array.isArray(rawFactIds) ? rawFactIds.filter((item): item is string => typeof item === "string") : [];
  if (factIds.length !== (Array.isArray(rawFactIds) ? rawFactIds.length : 0)) {
    throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_facts", "factIds must be an array of strings", { retryable: false }));
  }
  const allowedIds = new Set((Array.isArray(context.allowedFacts) ? context.allowedFacts : []).map((fact) => fact.id));
  const unknownIds = factIds.filter((id, index) => !allowedIds.has(id) || factIds.indexOf(id) !== index);
  if (unknownIds.length > 0) {
    throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_facts", "host output referenced a fact outside allowedFacts", { retryable: false }));
  }
  const deliveryInstruction = typeof object.deliveryInstruction === "string"
    ? object.deliveryInstruction.trim().slice(0, 120)
    : "自然口语，语速舒缓，句间轻停，像中文音乐电台主持人一样，不要播音腔。";
  return { text, factIds, deliveryInstruction, ...(angle ? { angle } : {}) };
}

interface HostReviewPayload {
  approved: boolean;
  selectedIndex: number | null;
  issues: string[];
  rationale: string;
}

function parseHostReviewPayload(payload: unknown, candidateCount: number): HostReviewPayload {
  for (const candidate of collectResponseCandidates(payload)) {
    const object = extractJsonObject(candidate);
    if (!object || typeof object.approved !== "boolean") continue;
    const issues = Array.isArray(object.issues)
      ? object.issues.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim().slice(0, 300)).slice(0, 8)
      : [];
    const rationale = typeof object.rationale === "string" ? object.rationale.trim().slice(0, 500) : "";
    const selectedIndex = Number.isInteger(object.selectedIndex) ? Number(object.selectedIndex) : null;
    if (object.approved === true && (selectedIndex === null || selectedIndex < 0 || selectedIndex >= candidateCount || issues.length > 0)) {
      throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_response", "producer approval is inconsistent", { retryable: false }));
    }
    if (object.approved === false && (selectedIndex !== null || issues.length === 0)) {
      throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_response", "producer rejection must include actionable issues", { retryable: false }));
    }
    return { approved: object.approved, selectedIndex, issues, rationale };
  }
  throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_response", "provider response did not contain a valid producer review", { retryable: false }));
}

function parseResearchFacts(payload: unknown): MusicResearchFact[] {
  const citedFacts = collectCitedResearchFacts(payload);
  if (citedFacts.length > 0) return citedFacts.slice(0, 12).map((fact, index) => ({ ...fact, id: `web:${index + 1}` }));
  const citationUrls = collectCitationUrls(payload);
  for (const candidate of collectResponseCandidates(payload)) {
    const object = extractJsonObject(candidate);
    const rawFacts = object?.facts;
    if (!Array.isArray(rawFacts)) continue;
    const facts = rawFacts
      .filter((fact): fact is Record<string, unknown> => isPlainRecord(fact))
      .map((fact, index) => ({
        id: `web-${index + 1}`,
        value: typeof fact.value === "string" ? fact.value.replace(/\s*\(\[[^\]]+\]\(https:\/\/[^)]+\)\)\s*$/u, "").trim() : "",
        sourceUrl: typeof fact.sourceUrl === "string" ? fact.sourceUrl.trim() : "",
      }))
      .filter((fact) => fact.value.length >= 20 && fact.value.length <= 500 && /^https:\/\//.test(fact.sourceUrl) && citationUrls.has(fact.sourceUrl))
      .slice(0, 12)
      .map((fact, index) => ({ id: `web:${index + 1}`, value: fact.value, sourceUrl: fact.sourceUrl }));
    return facts;
  }
  return [];
}

function collectCitedResearchFacts(payload: unknown): Array<{ id: string; value: string; sourceUrl: string }> {
  const facts: Array<{ id: string; value: string; sourceUrl: string }> = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 10 || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string" && Array.isArray(record.annotations)) {
      for (const annotation of record.annotations) {
        if (!isPlainRecord(annotation) || annotation.type !== "url_citation" || typeof annotation.url !== "string" || !/^https:\/\//.test(annotation.url)) continue;
        const start = typeof annotation.start_index === "number" ? annotation.start_index : record.text.length;
        const lineStart = Math.max(record.text.lastIndexOf("\n", Math.max(0, start - 1)) + 1, 0);
        const lineEndCandidate = record.text.indexOf("\n", start);
        const lineEnd = lineEndCandidate < 0 ? record.text.length : lineEndCandidate;
        const factText = record.text.slice(lineStart, lineEnd)
          .replace(/^\s*(?:[-*]|\d+[.)、])?\s*(?:FACT|事实)\s*[:：]\s*/iu, "")
          .replace(/\s*\(\[[^\]]+\]\(https:\/\/[^)]+\)\)/gu, "")
          .trim();
        if (factText.length < 20 || factText.length > 500) continue;
        facts.push({ id: "", value: factText, sourceUrl: annotation.url });
      }
    }
    Object.values(record).forEach((item) => visit(item, depth + 1));
  };
  visit(payload, 0);
  return facts.filter((fact, index, all) => all.findIndex((candidate) => candidate.value === fact.value) === index);
}

function collectCitationUrls(payload: unknown): Set<string> {
  const urls = new Set<string>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 10 || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if ((record.type === "url_citation" || record.type === "citation") && typeof record.url === "string" && /^https:\/\//.test(record.url)) {
      urls.add(record.url);
    }
    Object.values(record).forEach((item) => visit(item, depth + 1));
  };
  visit(payload, 0);
  return urls;
}

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function collectResponseCandidates(payload: unknown): unknown[] {
  const result: unknown[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 8 || value === null || value === undefined) return;
    if (typeof value === "string") {
      result.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string" || Array.isArray(record.factIds) || Array.isArray(record.fact_ids) || Array.isArray(record.facts)) result.push(record);
    for (const [key, child] of Object.entries(record)) {
      if (["output", "output_text", "choices", "message", "content", "data", "result", "response", "text", "factIds", "fact_ids", "facts"].includes(key)) visit(child, depth + 1);
    }
  };
  visit(payload, 0);
  return result;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parsePlaylistNames(payload: unknown): string[] {
  for (const candidate of collectResponseCandidates(payload)) {
    const object = extractJsonObject(candidate);
    if (!object || !Array.isArray(object.names)) continue;
    const names = object.names
      .filter((name): name is string => typeof name === "string")
      .map((name) => name.trim())
      .filter((name, index, values) => /^[\p{Script=Han}]{3,6}$/u.test(name) && values.indexOf(name) === index)
      .slice(0, 3);
    if (names.length > 0) return names;
  }
  return [];
}

function matchingBrace(source: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function validateContext(context: HostContextPack): HostContextPack["scenePreset"] {
  if (!context || typeof context !== "object" || !isScenePreset(context.scenePreset)) {
    throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_input", "scenePreset is not supported", { retryable: false }));
  }
  return context.scenePreset;
}

function safeInstruction(context: HostContextPack): string {
  return context && isScenePreset(context.scenePreset) ? SCENE_INSTRUCTIONS[context.scenePreset] : "";
}

function deterministicMockText(context: HostContextPack): string {
  return `[mock] ${context.scenePreset}/${context.programPhase}`;
}

function normalizeMode(value: unknown): OpenAIApiMode {
  if (typeof value === "string" && (OPENAI_API_MODES as readonly string[]).includes(value)) return value as OpenAIApiMode;
  return "auto";
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

function positiveInteger(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function asProviderError(error: unknown): ProviderError {
  if (isProviderError(error)) return error;
  const message = safeUpstreamMessage(error instanceof Error ? error.message : undefined, "provider request failed");
  return new ProviderError(providerErrorInfo(PROVIDER_NAME, "network_error", message, { retryable: true }), { cause: error });
}

export type { ProviderErrorInfo };
