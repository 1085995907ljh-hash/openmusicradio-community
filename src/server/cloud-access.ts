import { execFile as nodeExecFile, spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { LocalAiSettings, LocalAiStatus } from "./local-ai-config.js";
import { LocalAiConfigStore } from "./local-ai-config.js";

const DEFAULT_CONFIG_PATH = join(homedir(), ".one-radio", "cloud-access.json");
const DEFAULT_KEYCHAIN_SERVICE = "dev.openmusicradio.cloud-access";
const LOCAL_PREVIEW_BASE_URL = "local-preview://managed";
const LOCAL_PREVIEW_CODES = new Set([
  "OMR-NEON01",
  "OMR-RADIO02",
  "OMR-STUDIO3",
  "OMR-CASSETTE4",
  "OMR-SIGNAL05",
  "OMR-ANALOG06",
  "OMR-STEREO07",
  "OMR-FADER08",
  "OMR-REWIND09",
  "OMR-MIXER10",
  "OMR-ANTENNA11",
  "OMR-CHANNEL12",
  "OMR-AIRWAVE13",
]);
const execFile = promisify(nodeExecFile);

export interface CloudAccessStatus {
  configured: boolean;
  connected: boolean;
  state: "unconfigured" | "invitation_required" | "connected" | "unreachable";
  user?: { id: string; displayName: string };
  device?: { id: string; name: string };
  service?: { llmModel: string; ttsModel: string; managed: true };
  detail?: string;
}

interface PersistedCloudAccess {
  baseUrl: string;
  user: { id: string; displayName: string };
  device: { id: string; name: string };
  connectedAt: string;
}

interface ClaimResponse {
  token?: string;
  user?: { id?: string; displayName?: string };
  device?: { id?: string; name?: string };
}

export class CloudAccessStore {
  private readonly configPath: string;
  private readonly keychainService: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(
    configPath = process.env.ONE_RADIO_CLOUD_ACCESS_PATH?.trim() || DEFAULT_CONFIG_PATH,
    keychainService = DEFAULT_KEYCHAIN_SERVICE,
    fetchImpl: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
  ) {
    this.configPath = configPath;
    this.keychainService = keychainService;
    this.fetchImpl = fetchImpl;
  }

  async status(options: { verify?: boolean } = {}): Promise<CloudAccessStatus> {
    const [record, token] = await Promise.all([this.readRecord(), this.readToken()]);
    if (record?.baseUrl === LOCAL_PREVIEW_BASE_URL && token && process.env.NODE_ENV !== "production") {
      return {
        configured: true,
        connected: true,
        state: "connected",
        user: record.user,
        device: record.device,
        service: this.serviceMetadata(),
        detail: "正在使用仅限本机开发的邀请测试模式。",
      };
    }
    const baseUrl = this.configuredBaseUrl();
    if (!baseUrl) return { configured: false, connected: false, state: "unconfigured", detail: "托管服务地址尚未配置。" };
    if (!record || !token) return { configured: true, connected: false, state: "invitation_required", detail: "请输入团队邀请码连接这台设备。" };
    const connected: CloudAccessStatus = {
      configured: true,
      connected: true,
      state: "connected",
      user: record.user,
      device: record.device,
      service: this.serviceMetadata(),
    };
    if (options.verify !== true) return connected;
    try {
      const response = await this.fetchImpl(`${record.baseUrl}/auth/session`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal: AbortSignal.timeout(8_000),
      });
      if (response.status === 401 || response.status === 403) {
        await this.disconnect();
        return { configured: true, connected: false, state: "invitation_required", detail: "设备授权已经失效，请重新输入邀请码。" };
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return connected;
    } catch {
      return { ...connected, state: "unreachable", detail: "已保存设备授权，但当前无法连接托管服务。" };
    }
  }

  async claim(inviteCode: string, displayName: string, deviceName = hostname()): Promise<CloudAccessStatus> {
    const code = inviteCode.trim().toUpperCase();
    const name = displayName.trim();
    const normalizedDeviceName = deviceName.trim() || hostname();
    if (!/^[A-Z0-9-]{6,40}$/.test(code)) throw new Error("邀请码格式不正确。");
    if (!name || name.length > 40) throw new Error("请输入 1 到 40 个字符的名字。");
    const baseUrl = this.configuredBaseUrl();
    if (!baseUrl) {
      if (process.env.NODE_ENV === "production" || !LOCAL_PREVIEW_CODES.has(code)) throw new Error("邀请码无效，或托管服务尚未配置。");
      const record: PersistedCloudAccess = {
        baseUrl: LOCAL_PREVIEW_BASE_URL,
        user: { id: `preview-${code.toLowerCase()}`, displayName: name },
        device: { id: `preview-${code.toLowerCase()}-${process.pid}`, name: normalizedDeviceName },
        connectedAt: new Date().toISOString(),
      };
      await Promise.all([this.writeRecord(record), this.writeToken(`preview-${code}-${process.pid}`)]);
      return { configured: true, connected: true, state: "connected", user: record.user, device: record.device, service: this.serviceMetadata(), detail: "正在使用仅限本机开发的邀请测试模式。" };
    }
    const response = await this.fetchImpl(`${baseUrl}/auth/invite/claim`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ inviteCode: code, displayName: name, deviceName: normalizedDeviceName.slice(0, 80) }),
      signal: AbortSignal.timeout(12_000),
    });
    const payload = await response.json().catch(() => ({})) as ClaimResponse & { error?: { message?: string } };
    if (!response.ok || !payload.token || !payload.user?.id || !payload.device?.id) {
      throw new Error(payload.error?.message || (response.status === 401 ? "邀请码无效或已经用完。" : `邀请码连接失败（${response.status}）。`));
    }
    const record: PersistedCloudAccess = {
      baseUrl,
      user: { id: payload.user.id, displayName: payload.user.displayName?.trim() || name },
      device: { id: payload.device.id, name: payload.device.name?.trim() || normalizedDeviceName },
      connectedAt: new Date().toISOString(),
    };
    await Promise.all([this.writeRecord(record), this.writeToken(payload.token)]);
    return { configured: true, connected: true, state: "connected", user: record.user, device: record.device, service: this.serviceMetadata() };
  }

  async token(): Promise<string> {
    return this.readToken();
  }

  async baseUrl(): Promise<string> {
    const stored = (await this.readRecord())?.baseUrl;
    return stored === LOCAL_PREVIEW_BASE_URL ? "" : stored ?? this.configuredBaseUrl() ?? "";
  }

  async localPreview(): Promise<boolean> {
    return (await this.readRecord())?.baseUrl === LOCAL_PREVIEW_BASE_URL && process.env.NODE_ENV !== "production";
  }

  async disconnect(): Promise<void> {
    await Promise.all([rm(this.configPath, { force: true }), this.deleteToken()]);
  }

  serviceMetadata() {
    return {
      llmModel: process.env.ONE_RADIO_MANAGED_LLM_MODEL?.trim() || "gpt-5.4-mini",
      ttsModel: process.env.ONE_RADIO_MANAGED_TTS_MODEL?.trim() || "cosyvoice-v2",
      managed: true as const,
    };
  }

  private configuredBaseUrl(): string | null {
    const value = process.env.ONE_RADIO_CLOUD_BASE_URL?.trim();
    if (!value) return null;
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname))) return null;
      return url.toString().replace(/\/$/, "");
    } catch {
      return null;
    }
  }

  private async readRecord(): Promise<PersistedCloudAccess | null> {
    try {
      const value = JSON.parse(await readFile(this.configPath, "utf8")) as PersistedCloudAccess;
      if (!value.baseUrl || !value.user?.id || !value.device?.id) return null;
      return value;
    } catch {
      return null;
    }
  }

  private async writeRecord(record: PersistedCloudAccess): Promise<void> {
    await mkdir(dirname(this.configPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.configPath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.configPath);
  }

  private async readToken(): Promise<string> {
    const environmentToken = process.env.ONE_RADIO_DEVICE_TOKEN?.trim();
    if (environmentToken) return environmentToken;
    if (process.platform !== "darwin") return "";
    try {
      const { stdout } = await execFile("/usr/bin/security", ["find-generic-password", "-s", this.keychainService, "-a", "device-token", "-w"], { timeout: 5_000 });
      return stdout.trim();
    } catch {
      return "";
    }
  }

  private async writeToken(token: string): Promise<void> {
    if (process.platform !== "darwin") throw new Error("当前版本只支持 macOS 钥匙串保存设备凭证。");
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/usr/bin/security", ["add-generic-password", "-U", "-s", this.keychainService, "-a", "device-token", "-w", token], { stdio: "ignore" });
      const timer = setTimeout(() => { child.kill(); reject(new Error("无法保存设备凭证。")); }, 5_000);
      child.once("error", () => { clearTimeout(timer); reject(new Error("无法保存设备凭证。")); });
      child.once("exit", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error("无法保存设备凭证。")); });
    });
  }

  private async deleteToken(): Promise<void> {
    if (process.platform !== "darwin") return;
    try {
      await execFile("/usr/bin/security", ["delete-generic-password", "-s", this.keychainService, "-a", "device-token"], { timeout: 5_000 });
    } catch {
      // Missing credentials are already disconnected.
    }
  }
}

export class ManagedAiConfigStore extends LocalAiConfigStore {
  private readonly localFallback = new LocalAiConfigStore();
  constructor(private readonly access: CloudAccessStore) {
    super();
  }

  override async read(): Promise<LocalAiSettings> {
    if (await this.access.localPreview()) return this.localFallback.read();
    const baseUrl = await this.access.baseUrl();
    const service = this.access.serviceMetadata();
    return {
      llm: { provider: "custom", model: service.llmModel, reviewModel: service.llmModel, reasoningEffort: "high", baseUrl: `${baseUrl}/v1` },
      tts: { provider: "qwen", model: service.ttsModel, voice: "managed", baseUrl: `${baseUrl}/qwen/api/v1` },
    };
  }

  override async status(): Promise<LocalAiStatus> {
    if (await this.access.localPreview()) return this.localFallback.status();
    const settings = await this.read();
    const connected = (await this.access.status()).connected;
    return { llm: { ...settings.llm, hasKey: connected }, tts: { ...settings.tts, hasKey: connected } };
  }

  override async llmSecret(provider: Parameters<LocalAiConfigStore["llmSecret"]>[0]): Promise<string> {
    return await this.access.localPreview() ? this.localFallback.llmSecret(provider) : this.access.token();
  }
  override async ttsSecret(provider: Parameters<LocalAiConfigStore["ttsSecret"]>[0]): Promise<string> {
    return await this.access.localPreview() ? this.localFallback.ttsSecret(provider) : this.access.token();
  }
  override async save(): Promise<LocalAiStatus> { throw new Error("托管 AI 服务不接受本机 API Key。"); }
  override async deleteSecrets(): Promise<LocalAiStatus> { await this.access.disconnect(); return this.status(); }
  override async reset(): Promise<LocalAiStatus> { await this.access.disconnect(); return this.status(); }
}
