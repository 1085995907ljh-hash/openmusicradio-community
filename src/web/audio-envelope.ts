export function musicBedDelayRemainingMs(hostElapsedSeconds: number, delaySeconds: number): number {
  const elapsed = Number.isFinite(hostElapsedSeconds) ? Math.max(0, hostElapsedSeconds) : 0;
  const delay = Number.isFinite(delaySeconds) ? Math.max(0, delaySeconds) : 0;
  return Math.max(0, Math.ceil(((delay - elapsed) * 1_000) - 1e-6));
}
