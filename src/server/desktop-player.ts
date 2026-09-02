import { execFile } from "node:child_process";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

export const DESKTOP_PLAYER_SOURCES = ["qq_music", "netease_music"] as const;
export type DesktopPlayerSource = (typeof DESKTOP_PLAYER_SOURCES)[number];

export type DesktopPlayerState =
  | "ready"
  | "connected_idle"
  | "ducked"
  | "restored"
  | "playing"
  | "paused"
  | "next_requested"
  | "command_unconfirmed"
  | "restore_incomplete"
  | "operation_reused"
  | "app_not_running"
  | "screen_locked"
  | "automation_denied"
  | "busy"
  | "stale_operation"
  | "failed";

export interface DesktopPlayerResult {
  sourceId: DesktopPlayerSource;
  state: DesktopPlayerState;
  ok: boolean;
  controlledElements: number;
  operationId: string | null;
  targetVolume: null;
  detail: string;
  appRunning: boolean | null;
  playing: boolean | null;
  replayed?: boolean;
}

export interface DesktopPlayerControllerLike {
  inspect(sourceId: DesktopPlayerSource): Promise<DesktopPlayerResult>;
  duck(sourceId: DesktopPlayerSource, operationId: string): Promise<DesktopPlayerResult>;
  restore(sourceId: DesktopPlayerSource, operationId: string): Promise<DesktopPlayerResult>;
  pause(sourceId: DesktopPlayerSource, operationId: string): Promise<DesktopPlayerResult>;
  emergencyPause?(sourceId: DesktopPlayerSource, operationId: string): Promise<DesktopPlayerResult>;
  toggle(sourceId: DesktopPlayerSource, operationId: string): Promise<DesktopPlayerResult>;
  next(sourceId: DesktopPlayerSource, operationId: string): Promise<DesktopPlayerResult>;
}

type AppleScriptRunner = (script: string) => Promise<string>;

interface PlayerConfig {
  processName: string;
  controlMenu: string;
  playItem: string;
  pauseItem: string;
  nextItem: string;
  volumeDownItem: string;
  volumeUpItem: string;
}

const execFileAsync = promisify(execFile);
const DUCK_STEPS = 3;
const LEASE_TTL_MS = 30_000;
const DEFAULT_LEASE_PATH = join(tmpdir(), `one-radio-volume-leases-${typeof process.getuid === "function" ? process.getuid() : "user"}.json`);
const PLAYER_CONFIG: Record<DesktopPlayerSource, PlayerConfig> = {
  qq_music: {
    processName: "QQMusic",
    controlMenu: "播放控制",
    playItem: "播放",
    pauseItem: "暂停",
    nextItem: "下一首",
    volumeDownItem: "音量减",
    volumeUpItem: "音量加",
  },
  netease_music: {
    processName: "NeteaseMusic",
    controlMenu: "控制",
    playItem: "播放",
    pauseItem: "暂停",
    nextItem: "下一个",
    volumeDownItem: "降低音量",
    volumeUpItem: "升高音量",
  },
};

const STATE_DETAILS: Record<DesktopPlayerState, string> = {
  ready: "桌面客户端已连接，且正在播放音乐。",
  connected_idle: "桌面客户端已连接，当前没有播放音乐。",
  ducked: "桌面客户端音量已降低，网页口播音量保持不变。",
  restored: "桌面客户端音量已恢复。",
  playing: "桌面客户端已开始播放。",
  paused: "桌面客户端已暂停播放。",
  next_requested: "已向桌面客户端发送下一首指令；客户端未提供曲目变更回执。",
  command_unconfirmed: "控制指令已发送，但桌面客户端的播放状态没有变化。",
  restore_incomplete: "桌面客户端音量只完成了部分恢复，系统将继续重试。",
  operation_reused: "同一个操作编号不能用于不同的播放器命令。",
  app_not_running: "桌面客户端当前未运行。",
  screen_locked: "Mac 当前处于锁屏状态；解锁后才能控制桌面音乐客户端。",
  automation_denied: "本地服务没有控制该桌面客户端所需的辅助功能权限。",
  busy: "另一段口播仍占用该播放器的音量控制。",
  stale_operation: "该请求不属于当前音量控制操作，已忽略。",
  failed: "桌面客户端控制失败。",
};

function defaultRunner(script: string): Promise<string> {
  return execFileAsync("osascript", ["-e", script], { timeout: 5_000, maxBuffer: 64 * 1024 })
    .then(({ stdout }) => stdout.trim());
}

function escapeAppleScript(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function actionScript(sourceId: DesktopPlayerSource, action: "inspect" | "duck" | "restore" | "pause" | "toggle" | "next", volumeSteps = DUCK_STEPS): string {
  const config = PLAYER_CONFIG[sourceId];
  const processName = escapeAppleScript(config.processName);
  const menuName = escapeAppleScript(config.controlMenu);
  const playItem = escapeAppleScript(config.playItem);
  const pauseItem = escapeAppleScript(config.pauseItem);
  const nextItem = escapeAppleScript(config.nextItem);
  const volumeDownItem = escapeAppleScript(config.volumeDownItem);
  const volumeUpItem = escapeAppleScript(config.volumeUpItem);

  const command = action === "inspect"
    ? `if exists menu item "${pauseItem}" of controlMenu then return "READY"
      if exists menu item "${playItem}" of controlMenu then return "CONNECTED_IDLE"
      return "FAILED"`
    : action === "duck"
      ? `if not (exists menu item "${pauseItem}" of controlMenu) then return "CONNECTED_IDLE"
      set changedSteps to 0
      repeat ${volumeSteps} times
        if not (enabled of menu item "${volumeDownItem}" of controlMenu) then exit repeat
        try
          click menu item "${volumeDownItem}" of controlMenu
          set changedSteps to changedSteps + 1
        on error
          exit repeat
        end try
        delay 0.03
      end repeat
      if changedSteps is 0 then return "FAILED"
      return "OK|" & (changedSteps as text)`
      : action === "restore"
        ? `set changedSteps to 0
      repeat ${volumeSteps} times
        if not (enabled of menu item "${volumeUpItem}" of controlMenu) then exit repeat
        try
          click menu item "${volumeUpItem}" of controlMenu
          set changedSteps to changedSteps + 1
        on error
          exit repeat
        end try
        delay 0.03
      end repeat
      if changedSteps is 0 then return "FAILED"
      return "OK|" & (changedSteps as text)`
        : action === "pause"
          ? `if exists menu item "${pauseItem}" of controlMenu then
        click menu item "${pauseItem}" of controlMenu
        delay 0.2
        set controlMenu to menu 1 of menu bar item "${menuName}" of menu bar 1
        if exists menu item "${playItem}" of controlMenu then return "PAUSED"
        return "COMMAND_UNCONFIRMED"
      end if
      if exists menu item "${playItem}" of controlMenu then return "PAUSED"
      return "FAILED"`
        : action === "toggle"
      ? `if exists menu item "${pauseItem}" of controlMenu then
        click menu item "${pauseItem}" of controlMenu
        delay 0.2
        set controlMenu to menu 1 of menu bar item "${menuName}" of menu bar 1
        if exists menu item "${playItem}" of controlMenu then return "PAUSED"
        return "COMMAND_UNCONFIRMED"
      end if
      if exists menu item "${playItem}" of controlMenu then
        click menu item "${playItem}" of controlMenu
        delay 0.2
        set controlMenu to menu 1 of menu bar item "${menuName}" of menu bar 1
        if exists menu item "${pauseItem}" of controlMenu then return "PLAYING"
        return "COMMAND_UNCONFIRMED"
      end if
      return "FAILED"`
          : `click menu item "${nextItem}" of controlMenu
      return "NEXT_REQUESTED"`;

  const screenLockGuard = action === "inspect"
    ? `if exists process "loginwindow" then
      if frontmost of process "loginwindow" then return "SCREEN_LOCKED"
    end if`
    : "";

  return `try
  tell application "System Events"
    ${screenLockGuard}
    if not (exists process "${processName}") then return "APP_NOT_RUNNING"
    tell process "${processName}"
      set controlMenu to menu 1 of menu bar item "${menuName}" of menu bar 1
      ${command}
    end tell
  end tell
on error errorMessage number errorNumber
  if errorNumber is -1743 or errorNumber is -1719 or errorNumber is -1002 or errorNumber is -25211 then return "AUTOMATION_DENIED"
  return "FAILED"
end try`;
}

function result(
  sourceId: DesktopPlayerSource,
  state: DesktopPlayerState,
  operationId: string | null,
  controlledElements = 0,
): DesktopPlayerResult {
  const ok = ["ready", "ducked", "restored", "playing", "paused", "next_requested"].includes(state);
  const appRunning = state === "app_not_running"
    ? false
    : ["automation_denied", "busy", "stale_operation", "operation_reused", "failed"].includes(state)
      ? null
      : true;
  return {
    sourceId,
    state,
    ok,
    controlledElements,
    operationId,
    targetVolume: null,
    detail: state === "ducked"
      ? `桌面客户端音量已降低 ${controlledElements} 档，网页口播音量保持不变。`
      : state === "restored"
        ? `桌面客户端音量已恢复 ${controlledElements} 档。`
        : STATE_DETAILS[state],
    appRunning,
    playing: state === "ready" || state === "playing" || state === "ducked"
      ? true
      : state === "connected_idle" || state === "paused"
        ? false
        : null,
  };
}

function parseScriptResult(
  sourceId: DesktopPlayerSource,
  output: string,
  successState: "ducked" | "restored" | null,
  operationId: string | null,
  expectedVolumeSteps = DUCK_STEPS,
): DesktopPlayerResult {
  const normalized = output.trim();
  if (normalized.startsWith("OK|")) {
    const parts = normalized.split("|");
    const countText = parts[1];
    const count = Number.parseInt(countText, 10);
    if (parts.length !== 2 || !/^\d+$/.test(countText) || count < 1 || count > expectedVolumeSteps || !successState) {
      return result(sourceId, "failed", operationId);
    }
    return result(sourceId, successState, operationId, count);
  }
  const states: Record<string, DesktopPlayerState> = {
    READY: "ready",
    CONNECTED_IDLE: "connected_idle",
    PLAYING: "playing",
    PAUSED: "paused",
    NEXT_REQUESTED: "next_requested",
    COMMAND_UNCONFIRMED: "command_unconfirmed",
    APP_NOT_RUNNING: "app_not_running",
    SCREEN_LOCKED: "screen_locked",
    AUTOMATION_DENIED: "automation_denied",
    FAILED: "failed",
  };
  return result(sourceId, states[normalized] ?? "failed", operationId);
}

export class DesktopPlayerController implements DesktopPlayerControllerLike {
  private static readonly leaseOwners = new Map<string, DesktopPlayerController>();
  private static readonly sharedOperationChains = new Map<string, Promise<void>>();
  private readonly runner: AppleScriptRunner;
  private readonly leasePath: string | null;
  private readonly activeOperations = new Map<DesktopPlayerSource, { operationId: string; result: DesktopPlayerResult; expiresAt: number }>();
  private readonly operationChains = new Map<string, Promise<void>>();
  private readonly inspectInFlight = new Map<DesktopPlayerSource, Promise<DesktopPlayerResult>>();
  private readonly leaseTimers = new Map<DesktopPlayerSource, NodeJS.Timeout>();
  private readonly controlResults = new Map<string, { action: "pause" | "toggle" | "next"; result: DesktopPlayerResult }>();
  private leaseHeldByAnotherProcess = false;

  constructor(runner: AppleScriptRunner = defaultRunner, leasePath: string | null = runner === defaultRunner ? DEFAULT_LEASE_PATH : null) {
    this.runner = runner;
    this.leasePath = leasePath;
    if (leasePath) {
      DesktopPlayerController.leaseOwners.get(leasePath)?.relinquishLeaseOwnership();
      DesktopPlayerController.leaseOwners.set(leasePath, this);
      const persistedState = this.loadPersistedLeases();
      if (persistedState === "foreign_active") this.leaseHeldByAnotherProcess = true;
      else if (this.activeOperations.size > 0) void this.recoverPersistedLeases();
      else this.persistLeases();
    }
  }

  inspect(sourceId: DesktopPlayerSource): Promise<DesktopPlayerResult> {
    const current = this.inspectInFlight.get(sourceId);
    if (current) return current;
    const pending = this.serialize(sourceId, () => this.run(sourceId, "inspect", null, null));
    this.inspectInFlight.set(sourceId, pending);
    const clear = () => {
      if (this.inspectInFlight.get(sourceId) === pending) this.inspectInFlight.delete(sourceId);
    };
    void pending.then(clear, clear);
    return pending;
  }

  duck(sourceId: DesktopPlayerSource, operationId: string): Promise<DesktopPlayerResult> {
    return this.serialize(sourceId, async () => {
      if (!this.ownsLeasePath() || this.leaseHeldByAnotherProcess) return result(sourceId, "busy", operationId);
      const active = this.activeOperations.get(sourceId);
      if (active?.operationId === operationId) return { ...active.result, replayed: true };
      if (active) return result(sourceId, "busy", operationId);
      const response = await this.run(sourceId, "duck", "ducked", operationId);
      if (response.ok) {
        if (!this.ownsLeasePath()) {
          await this.run(sourceId, "restore", "restored", operationId, response.controlledElements);
          return result(sourceId, "failed", operationId);
        }
        this.activeOperations.set(sourceId, { operationId, result: response, expiresAt: Date.now() + LEASE_TTL_MS });
        if (!this.persistLeases()) {
          let remaining = response.controlledElements;
          while (remaining > 0) {
            const rollback = await this.run(sourceId, "restore", "restored", operationId, remaining);
            if (!rollback.ok) break;
            remaining -= rollback.controlledElements;
          }
          if (remaining === 0) this.activeOperations.delete(sourceId);
          else {
            this.activeOperations.set(sourceId, {
              operationId,
              result: result(sourceId, "ducked", operationId, remaining),
              expiresAt: Date.now() + LEASE_TTL_MS,
            });
            this.scheduleLeaseRecovery(sourceId);
          }
          return result(sourceId, "failed", operationId);
        }
        this.scheduleLeaseRecovery(sourceId);
      }
      return response;
    });
  }

  restore(sourceId: DesktopPlayerSource, operationId: string): Promise<DesktopPlayerResult> {
    return this.serialize(sourceId, async () => {
      if (!this.ownsLeasePath() || this.leaseHeldByAnotherProcess) return result(sourceId, "busy", operationId);
      const active = this.activeOperations.get(sourceId);
      if (!active || active.operationId !== operationId) return result(sourceId, "stale_operation", operationId);
      const response = await this.run(sourceId, "restore", "restored", operationId, active.result.controlledElements);
      if (response.ok) {
        const remaining = active.result.controlledElements - response.controlledElements;
        if (remaining === 0) {
          this.activeOperations.delete(sourceId);
          this.clearLeaseTimer(sourceId);
          if (!this.persistLeases()) return this.rollbackFailedRestore(sourceId, active, response.controlledElements);
          return response;
        }
        this.activeOperations.set(sourceId, {
          ...active,
          result: result(sourceId, "ducked", operationId, remaining),
          expiresAt: Date.now() + LEASE_TTL_MS,
        });
        if (!this.persistLeases()) return this.rollbackFailedRestore(sourceId, active, response.controlledElements);
        this.scheduleLeaseRecovery(sourceId);
        const incomplete = result(sourceId, "restore_incomplete", operationId, response.controlledElements);
        incomplete.detail = `桌面客户端已恢复 ${response.controlledElements} 档，仍有 ${remaining} 档等待恢复。`;
        return incomplete;
      }
      active.expiresAt = Date.now() + LEASE_TTL_MS;
      this.persistLeases();
      this.scheduleLeaseRecovery(sourceId);
      return response;
    });
  }

  pause(sourceId: DesktopPlayerSource, operationId: string): Promise<DesktopPlayerResult> {
    return this.control(sourceId, "pause", operationId);
  }

  async emergencyPause(sourceId: DesktopPlayerSource, operationId: string): Promise<DesktopPlayerResult> {
    await this.run(sourceId, "pause", null, `${operationId}-immediate`).catch(() => undefined);
    return this.serialize(sourceId, () => this.run(sourceId, "pause", null, `${operationId}-fence`));
  }

  toggle(sourceId: DesktopPlayerSource, operationId: string): Promise<DesktopPlayerResult> {
    return this.control(sourceId, "toggle", operationId);
  }

  next(sourceId: DesktopPlayerSource, operationId: string): Promise<DesktopPlayerResult> {
    return this.control(sourceId, "next", operationId);
  }

  private control(sourceId: DesktopPlayerSource, action: "pause" | "toggle" | "next", operationId: string): Promise<DesktopPlayerResult> {
    return this.serialize(sourceId, async () => {
      const key = `${sourceId}:${operationId}`;
      const previous = this.controlResults.get(key);
      if (previous) {
        if (previous.action !== action) return result(sourceId, "operation_reused", operationId);
        return { ...previous.result, replayed: true };
      }
      if (action !== "pause" && this.activeOperations.has(sourceId)) return result(sourceId, "busy", operationId);
      const response = await this.run(sourceId, action, null, operationId);
      this.controlResults.set(key, { action, result: response });
      while (this.controlResults.size > 128) {
        const oldest = this.controlResults.keys().next().value;
        if (typeof oldest === "string") this.controlResults.delete(oldest);
        else break;
      }
      return response;
    });
  }

  private loadPersistedLeases(): "loaded" | "none" | "foreign_active" {
    if (!this.leasePath) return "none";
    try {
      const parsed = JSON.parse(readFileSync(this.leasePath, "utf8")) as { leases?: unknown; ownerPid?: unknown };
      if (typeof parsed.ownerPid === "number" && parsed.ownerPid !== process.pid && this.processIsAlive(parsed.ownerPid)) {
        return "foreign_active";
      }
      if (!Array.isArray(parsed.leases)) return "none";
      for (const value of parsed.leases) {
        if (!value || typeof value !== "object") continue;
        const lease = value as { sourceId?: unknown; operationId?: unknown; steps?: unknown };
        if (typeof lease.sourceId !== "string" || !DESKTOP_PLAYER_SOURCES.includes(lease.sourceId as DesktopPlayerSource)) continue;
        if (typeof lease.operationId !== "string" || lease.operationId.length === 0 || lease.operationId.length > 128) continue;
        if (!Number.isInteger(lease.steps) || (lease.steps as number) < 1 || (lease.steps as number) > DUCK_STEPS) continue;
        const sourceId = lease.sourceId as DesktopPlayerSource;
        this.activeOperations.set(sourceId, {
          operationId: lease.operationId,
          result: result(sourceId, "ducked", lease.operationId, lease.steps as number),
          expiresAt: Date.now(),
        });
      }
      return this.activeOperations.size > 0 ? "loaded" : "none";
    } catch {
      // A missing or corrupt recovery file must not create a synthetic lease.
      return "none";
    }
  }

  private persistLeases(): boolean {
    if (!this.leasePath) return true;
    try {
      if (this.activeOperations.size === 0) {
        try {
          unlinkSync(this.leasePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
        }
        return true;
      }
      const leases = [...this.activeOperations.entries()].map(([sourceId, lease]) => ({
        sourceId,
        operationId: lease.operationId,
        steps: lease.result.controlledElements,
      }));
      const temporaryPath = `${this.leasePath}.tmp`;
      writeFileSync(temporaryPath, JSON.stringify({ version: 1, ownerPid: process.pid, leases }), { mode: 0o600 });
      renameSync(temporaryPath, this.leasePath);
      return true;
    } catch {
      return false;
    }
  }

  private async recoverPersistedLeases(): Promise<void> {
    for (const [sourceId, lease] of [...this.activeOperations]) {
      await this.restore(sourceId, lease.operationId);
    }
  }

  private scheduleLeaseRecovery(sourceId: DesktopPlayerSource): void {
    this.clearLeaseTimer(sourceId);
    const active = this.activeOperations.get(sourceId);
    if (!active) return;
    const timer = setTimeout(() => {
      void this.restore(sourceId, active.operationId);
    }, Math.max(0, active.expiresAt - Date.now()));
    timer.unref();
    this.leaseTimers.set(sourceId, timer);
  }

  private clearLeaseTimer(sourceId: DesktopPlayerSource): void {
    const timer = this.leaseTimers.get(sourceId);
    if (timer) clearTimeout(timer);
    this.leaseTimers.delete(sourceId);
  }

  private relinquishLeaseOwnership(): void {
    for (const sourceId of this.leaseTimers.keys()) this.clearLeaseTimer(sourceId);
    this.activeOperations.clear();
  }

  private ownsLeasePath(): boolean {
    return !this.leasePath || DesktopPlayerController.leaseOwners.get(this.leasePath) === this;
  }

  private processIsAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  private async rollbackFailedRestore(
    sourceId: DesktopPlayerSource,
    active: { operationId: string; result: DesktopPlayerResult; expiresAt: number },
    restoredSteps: number,
  ): Promise<DesktopPlayerResult> {
    const rollback = await this.run(sourceId, "duck", "ducked", active.operationId, restoredSteps);
    this.activeOperations.set(sourceId, {
      ...active,
      expiresAt: Date.now() + LEASE_TTL_MS,
    });
    this.scheduleLeaseRecovery(sourceId);
    const failed = result(sourceId, "failed", active.operationId);
    failed.detail = rollback.ok && rollback.controlledElements === restoredSteps
      ? "恢复记录无法安全保存，已撤销本次恢复并保留稍后重试。"
      : "恢复记录无法安全保存，播放器音量状态可能不完整。";
    return failed;
  }

  private async serialize<T>(sourceId: DesktopPlayerSource, action: () => Promise<T>): Promise<T> {
    const sharedKey = this.leasePath ? `${this.leasePath}:${sourceId}` : null;
    const chains = sharedKey ? DesktopPlayerController.sharedOperationChains : this.operationChains;
    const key = sharedKey ?? sourceId;
    const previous = chains.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(action);
    const tail = pending.then(() => undefined, () => undefined);
    chains.set(key, tail);
    try {
      return await pending;
    } finally {
      if (chains.get(key) === tail) chains.delete(key);
    }
  }

  private async run(
    sourceId: DesktopPlayerSource,
    action: "inspect" | "duck" | "restore" | "pause" | "toggle" | "next",
    successState: "ducked" | "restored" | null,
    operationId: string | null,
    volumeSteps = DUCK_STEPS,
  ): Promise<DesktopPlayerResult> {
    try {
      const output = await this.runner(actionScript(sourceId, action, volumeSteps));
      return parseScriptResult(sourceId, output, successState, operationId, volumeSteps);
    } catch {
      return result(sourceId, "failed", operationId);
    }
  }
}

export function assertDesktopPlayerSource(value: string): DesktopPlayerSource {
  if (!DESKTOP_PLAYER_SOURCES.includes(value as DesktopPlayerSource)) {
    throw new TypeError("sourceId must be qq_music or netease_music");
  }
  return value as DesktopPlayerSource;
}
