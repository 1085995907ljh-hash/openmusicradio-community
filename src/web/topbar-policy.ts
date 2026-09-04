import type { ProgramStatus } from "../shared/contracts.js";

const BROADCAST_NAVIGATION_LOCKED_STATUSES = new Set<ProgramStatus>(["preparing", "closing"]);

export function isBroadcastNavigationLocked(status?: ProgramStatus): boolean {
  return status !== undefined && BROADCAST_NAVIGATION_LOCKED_STATUSES.has(status);
}
