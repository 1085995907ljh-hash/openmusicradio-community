import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { EventEmitter } from "node:events";

import type { HostProfileId } from "../shared/program-options.js";
import type { ProgramState } from "../shared/contracts.js";

export const DESKTOP_PET_MOODS = ["preparing", "speaking", "listening", "paused", "transition", "closing", "ended", "error"] as const;
export type DesktopPetMood = (typeof DESKTOP_PET_MOODS)[number];

export interface DesktopPetState {
  version: 1;
  programId: string;
  generation: number;
  profileId: HostProfileId;
  mood: DesktopPetMood;
  message: string;
  speechDurationSeconds?: number;
  revision: number;
  updatedAt: string;
}

interface DesktopPetProcess extends EventEmitter {
  kill(signal?: NodeJS.Signals): boolean;
}

export interface DesktopPetControllerLike {
  update(state: DesktopPetState): void;
  hide?(): void;
  stop(): void;
}

interface DesktopPetControllerOptions {
  enabled?: boolean;
  binaryPath?: string;
  assetsPath?: string;
  statePath?: string;
  spawnProcess?: (binary: string, args: string[]) => DesktopPetProcess;
}

const DEFAULT_STATE_PATH = join(homedir(), "Library", "Application Support", "OneRadio", "desktop-pet-state.json");

export function desktopPetStateForProgram(state: ProgramState, mood?: DesktopPetMood, message?: string, revision = 0, speechDurationSeconds?: number): DesktopPetState {
  const resolvedMood = mood ?? (state.status === "closing"
    ? "closing"
    : ["completed", "stopped"].includes(state.status)
      ? "ended"
      : ["failed", "control_lost", "stop_unconfirmed"].includes(state.status)
        ? "error"
        : ["draft", "awaiting_confirmation", "preparing"].includes(state.status)
          ? "preparing"
          : "listening");
  const currentMessage = resolvedMood === "speaking" ? (message ?? "") : "";
  return {
    version: 1,
    programId: state.id,
    generation: state.generation,
    profileId: state.spec.hostProfile ?? "anxuan",
    mood: resolvedMood,
    message: currentMessage.slice(0, 600),
    ...(resolvedMood === "speaking" && typeof speechDurationSeconds === "number" && Number.isFinite(speechDurationSeconds) && speechDurationSeconds > 0 ? { speechDurationSeconds } : {}),
    revision,
    updatedAt: new Date().toISOString(),
  };
}

export class DesktopPetController implements DesktopPetControllerLike {
  private readonly binaryPath: string;
  private readonly assetsPath: string;
  private readonly statePath: string;
  private readonly spawnProcess: (binary: string, args: string[]) => DesktopPetProcess;
  private readonly enabled: boolean;
  private child: DesktopPetProcess | null = null;
  private currentProgramId: string | null = null;
  private dismissedProgramId: string | null = null;
  private stopping = false;
  private closed = false;
  private lastRevision = -1;
  private readonly instanceId = randomUUID();
  private latestState: DesktopPetState | null = null;

  constructor(options: DesktopPetControllerOptions = {}) {
    this.enabled = options.enabled ?? Boolean(options.binaryPath ?? process.env.ONE_RADIO_PET_BINARY);
    this.binaryPath = resolve(options.binaryPath ?? process.env.ONE_RADIO_PET_BINARY ?? "native/OneRadioPet/.build/release/OneRadioPet");
    this.assetsPath = resolve(options.assetsPath ?? process.env.ONE_RADIO_PET_ASSETS ?? "public/hosts");
    this.statePath = resolve(options.statePath ?? process.env.ONE_RADIO_PET_STATE_PATH ?? DEFAULT_STATE_PATH);
    this.spawnProcess = options.spawnProcess ?? ((binary, args) => spawn(binary, args, { stdio: "ignore" }) as DesktopPetProcess);
  }

  update(state: DesktopPetState): void {
    if (!this.enabled || this.closed || state.revision <= this.lastRevision) return;
    this.lastRevision = state.revision;
    this.latestState = state;
    const programChanged = this.currentProgramId !== state.programId;
    if (programChanged) {
      this.currentProgramId = state.programId;
      this.dismissedProgramId = null;
      if (this.child) {
        const previousChild = this.child;
        this.child = null;
        previousChild.kill("SIGTERM");
      }
    }
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.statePath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify({ ...state, ownerPid: process.pid, instanceId: this.instanceId })}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, this.statePath);
    if (this.child || this.dismissedProgramId === state.programId) return;
    this.launch(state.programId);
  }

  hide(): void {
    if (!this.enabled || this.closed) return;
    this.latestState = null;
    this.currentProgramId = null;
    this.dismissedProgramId = null;
    this.stopping = true;
    if (this.child) this.child.kill("SIGTERM");
    this.child = null;
    rmSync(this.statePath, { force: true });
  }

  private launch(programId: string): void {
    this.stopping = false;
    const child = this.spawnProcess(this.binaryPath, ["--state-file", this.statePath, "--assets-dir", this.assetsPath, "--instance-id", this.instanceId]);
    this.child = child;
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      if (!this.stopping && signal === null && code === 0) this.dismissedProgramId = programId;
      const latestProgramId = this.latestState?.programId;
      if (!this.closed && latestProgramId && latestProgramId !== programId && this.dismissedProgramId !== latestProgramId) this.launch(latestProgramId);
    });
    child.once("error", () => {
      if (this.child === child) this.child = null;
    });
  }

  stop(): void {
    if (!this.enabled) return;
    this.closed = true;
    this.latestState = null;
    this.stopping = true;
    if (this.child) this.child.kill("SIGTERM");
    this.child = null;
    rmSync(this.statePath, { force: true });
  }
}
