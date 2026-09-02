import type { ProgramState } from "../shared/contracts";

export type RadioHostPetMood = "idle" | "preparing" | "speaking" | "listening" | "paused" | "transition" | "closing" | "ended" | "error";

export interface RadioHostPetState {
  view: "setup" | "confirm" | "on_air" | "ended";
  programStatus?: ProgramState["status"] | null;
  hostStatus?: string | null;
  creating?: boolean;
  hostPending?: boolean;
  audioPlaying?: boolean;
  nexting?: boolean;
}

const TERMINAL_STATUSES = new Set<ProgramState["status"]>(["completed", "stopped"]);
const ERROR_STATUSES = new Set<ProgramState["status"]>(["failed", "control_lost", "stop_unconfirmed"]);

export function resolveRadioHostPetMood(state: RadioHostPetState): RadioHostPetMood {
  if ((state.programStatus && ERROR_STATUSES.has(state.programStatus)) || state.hostStatus === "failed") return "error";
  if (state.programStatus && TERMINAL_STATUSES.has(state.programStatus)) return "ended";
  if (state.nexting) return "transition";
  if (state.hostStatus === "playing") return "speaking";
  if (state.programStatus === "closing") return "closing";
  if (state.creating || state.hostPending || state.view === "confirm" || state.programStatus === "preparing") return "preparing";
  if (state.view === "on_air" && state.audioPlaying) return "listening";
  if (state.view === "on_air" && state.programStatus === "on_air") return "paused";
  return "idle";
}

export const RADIO_HOST_PET_MOOD_LABELS: Readonly<Record<RadioHostPetMood, string>> = Object.freeze({
  idle: "随时可以开台",
  preparing: "正在准备节目",
  speaking: "正在主持",
  listening: "陪你听这一首",
  paused: "节目已暂停",
  transition: "正在接下一首",
  closing: "正在收尾",
  ended: "本档节目结束",
  error: "信号需要检查",
});
