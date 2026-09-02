import { execFile as nodeExecFile, spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { REASONING_EFFORTS, type ReasoningEffort } from "../providers/types.js";

export const LLM_PROVIDER_IDS = ["openai", "deepseek", "qwen", "anthropic", "gemini", "custom"] as const;
export type LlmProviderId = (typeof LLM_PROVIDER_IDS)[number];
export const TTS_PROVIDER_IDS = ["qwen", "openai", "azure"] as const;
export type TtsProviderId = (typeof TTS_PROVIDER_IDS)[number];

export interface LocalAiSettings {
  llm: { provider: LlmProviderId; model: string; reviewModel?: string; reasoningEffort?: ReasoningEffort; baseUrl?: string };
  tts: { provider: TtsProviderId; model: string; voice: string; baseUrl?: string; region?: string; workspaceId?: string };
}

export interface LocalAiStatus extends LocalAiSettings {
  llm: LocalAiSettings["llm"] & { hasKey: boolean };
  tts: LocalAiSettings["tts"] & { hasKey: boolean };
}

const environmentLlmBaseUrl = process.env.OPENAI_BASE_URL?.trim();
const environmentCustomBaseUrl = (() => {
  if (!environmentLlmBaseUrl) return undefined;
  try {
    const parsed = new URL(environmentLlmBaseUrl);
    const secure = parsed.protocol === "https:" || (parsed.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
    if (!secure || parsed.username || parsed.password || parsed.search || parsed.hash) return undefined;
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
})();
const environmentLlmProvider: LlmProviderId = environmentLlmBaseUrl?.includes("deepseek")
  ? "deepseek"
  : environmentLlmBaseUrl?.includes("dashscope")
    ? "qwen"
    : environmentCustomBaseUrl && !/^https:\/\/api\.openai\.com(?:\/v1)?\/?$/i.test(environmentCustomBaseUrl)
      ? "custom"
      : "openai";

const DEFAULTS: LocalAiSettings = {
  llm: {
    provider: environmentLlmProvider,
    model: process.env.OPENAI_MODEL?.trim() || "gpt-5.4-mini",
    reviewModel: process.env.OPENAI_REVIEW_MODEL?.trim() || process.env.OPENAI_MODEL?.trim() || "gpt-5.4-mini",
    reasoningEffort: REASONING_EFFORTS.includes(process.env.OPENAI_REASONING_EFFORT as ReasoningEffort)
      ? process.env.OPENAI_REASONING_EFFORT as ReasoningEffort
      : "high",
    ...(environmentLlmProvider === "custom" && environmentCustomBaseUrl ? { baseUrl: environmentCustomBaseUrl } : {}),
  },
  tts: {
    provider: "qwen",
    model: process.env.QWEN_TTS_MODEL?.trim() || "cosyvoice-v2",
    voice: process.env.QWEN_TTS_VOICE?.trim() || "longanxuan",
    ...(process.env.DASHSCOPE_WORKSPACE_ID?.trim() ? { workspaceId: process.env.DASHSCOPE_WORKSPACE_ID.trim() } : {}),
  },
};

const KEYCHAIN_SERVICE = "dev.one-radio.local-ai";
const execFile = promisify(nodeExecFile);

export class LocalAiConfigStore {
  private readonly configPath: string;
  private readonly keychainService: string;
  private readonly useEnvironmentSecrets: boolean;

  constructor(configPath = process.env.ONE_RADIO_AI_CONFIG_PATH?.trim() || join(homedir(), ".one-radio", "ai-config.json"), keychainService = KEYCHAIN_SERVICE, useEnvironmentSecrets = true) {
    this.configPath = configPath;
    this.keychainService = keychainService;
    this.useEnvironmentSecrets = useEnvironmentSecrets;
  }

  async read(): Promise<LocalAiSettings> {
    try {
      const raw = JSON.parse(await readFile(this.configPath, "utf8")) as Partial<LocalAiSettings>;
      return validateSettings({ llm: { ...DEFAULTS.llm, ...raw.llm }, tts: { ...DEFAULTS.tts, ...raw.tts } });
    } catch {
      return structuredClone(DEFAULTS);
    }
  }

  async status(): Promise<LocalAiStatus> {
    const settings = await this.read();
    const [llmKey, ttsKey] = await Promise.all([this.readSecret(`llm:${settings.llm.provider}`), this.readSecret(`tts:${settings.tts.provider}`)]);
    return { ...settings, llm: { ...settings.llm, hasKey: Boolean(llmKey) }, tts: { ...settings.tts, hasKey: Boolean(ttsKey) } };
  }

  async save(next: LocalAiSettings, secrets: { llmApiKey?: string; ttsApiKey?: string }): Promise<LocalAiStatus> {
    const settings = validateSettings(next);
    await mkdir(dirname(this.configPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.configPath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.configPath);
    await Promise.all([
      secrets.llmApiKey?.trim() ? this.writeSecret(`llm:${settings.llm.provider}`, secrets.llmApiKey.trim()) : Promise.resolve(),
      secrets.ttsApiKey?.trim() ? this.writeSecret(`tts:${settings.tts.provider}`, secrets.ttsApiKey.trim()) : Promise.resolve(),
    ]);
    return this.status();
  }

  async llmSecret(provider: LlmProviderId): Promise<string> {
    return this.readSecret(`llm:${provider}`);
  }

  async ttsSecret(provider: TtsProviderId): Promise<string> {
    return this.readSecret(`tts:${provider}`);
  }

  async deleteSecrets(target: "llm" | "tts" | "all"): Promise<LocalAiStatus> {
    const accounts = [
      ...(target === "tts" ? [] : LLM_PROVIDER_IDS.map((provider) => `llm:${provider}`)),
      ...(target === "llm" ? [] : TTS_PROVIDER_IDS.map((provider) => `tts:${provider}`)),
    ];
    await Promise.all(accounts.map((account) => this.deleteSecret(account)));
    return this.status();
  }

  async reset(): Promise<LocalAiStatus> {
    await rm(this.configPath, { force: true });
    return this.deleteSecrets("all");
  }

  private async readSecret(account: string): Promise<string> {
    const envFallback = this.useEnvironmentSecrets ? environmentSecret(account) : undefined;
    if (process.platform !== "darwin") return envFallback ?? "";
    try {
      const { stdout } = await execFile("/usr/bin/security", ["find-generic-password", "-s", this.keychainService, "-a", account, "-w"], { timeout: 5_000 });
      return stdout.trim();
    } catch {
      return envFallback ?? "";
    }
  }

  private async writeSecret(account: string, value: string): Promise<void> {
    if (process.platform !== "darwin") throw new Error("当前版本只支持 macOS 钥匙串保存 API Key。");
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/usr/bin/security", ["add-generic-password", "-U", "-s", this.keychainService, "-a", account, "-w", value], { stdio: "ignore" });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("无法写入 macOS 钥匙串。"));
      }, 5_000);
      child.once("error", () => {
        clearTimeout(timer);
        reject(new Error("无法写入 macOS 钥匙串。"));
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error("无法写入 macOS 钥匙串。"));
      });
    });
  }

  private async deleteSecret(account: string): Promise<void> {
    if (process.platform !== "darwin") return;
    try {
      await execFile("/usr/bin/security", ["delete-generic-password", "-s", this.keychainService, "-a", account], { timeout: 5_000 });
    } catch {
      // Missing keychain entries are already in the requested state.
    }
  }
}

export function environmentSecret(account: string): string | undefined {
  const values: Record<string, string | undefined> = {
    "llm:openai": process.env.OPENAI_API_KEY,
    "llm:deepseek": process.env.DEEPSEEK_API_KEY,
    "llm:qwen": process.env.DASHSCOPE_API_KEY,
    "llm:anthropic": process.env.ANTHROPIC_API_KEY,
    "llm:gemini": process.env.GEMINI_API_KEY,
    "llm:custom": process.env.OPENAI_API_KEY,
    "tts:qwen": process.env.DASHSCOPE_API_KEY,
    "tts:openai": process.env.OPENAI_API_KEY,
    "tts:azure": process.env.AZURE_SPEECH_KEY,
  };
  return values[account]?.trim() || undefined;
}

function validateSettings(value: LocalAiSettings): LocalAiSettings {
  if (!LLM_PROVIDER_IDS.includes(value.llm.provider) || !TTS_PROVIDER_IDS.includes(value.tts.provider)) throw new Error("AI provider is invalid");
  const model = value.llm.model.trim();
  const reviewModel = value.llm.reviewModel?.trim() || model;
  const reasoningEffort = value.llm.reasoningEffort ?? "high";
  const ttsModel = value.tts.model.trim();
  const voice = value.tts.voice.trim();
  if (!model || model.length > 120 || !reviewModel || reviewModel.length > 120 || !REASONING_EFFORTS.includes(reasoningEffort) || !ttsModel || ttsModel.length > 120 || !voice || voice.length > 120) throw new Error("AI model, reasoning effort, or voice is invalid");
  const baseUrl = value.llm.baseUrl?.trim();
  if (value.llm.provider === "custom") {
    const parsed = new URL(baseUrl ?? "");
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname))) throw new Error("Custom provider URL must use HTTPS or loopback HTTP");
    if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("Custom provider URL cannot contain credentials, query, or fragment");
    value = { ...value, llm: { ...value.llm, baseUrl: parsed.toString().replace(/\/$/, "") } };
  }
  const region = value.tts.region?.trim();
  const ttsBaseUrl = value.tts.baseUrl?.trim();
  if (ttsBaseUrl) {
    const parsed = new URL(ttsBaseUrl);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname))) throw new Error("TTS provider URL must use HTTPS or loopback HTTP");
    if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("TTS provider URL cannot contain credentials, query, or fragment");
    value = { ...value, tts: { ...value.tts, baseUrl: parsed.toString().replace(/\/$/, "") } };
  }
  if (region && !/^[a-z0-9-]{2,40}$/i.test(region)) throw new Error("Azure region is invalid");
  return {
    llm: { provider: value.llm.provider, model, reviewModel, reasoningEffort, ...(value.llm.provider === "custom" && value.llm.baseUrl ? { baseUrl: value.llm.baseUrl } : {}) },
    tts: { provider: value.tts.provider, model: ttsModel, voice, ...(value.tts.baseUrl ? { baseUrl: value.tts.baseUrl } : {}), ...(region ? { region } : {}), ...(value.tts.workspaceId?.trim() ? { workspaceId: value.tts.workspaceId.trim().slice(0, 160) } : {}) },
  };
}
