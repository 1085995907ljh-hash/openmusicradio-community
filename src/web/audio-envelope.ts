export function envelopeVolume(start: number, target: number, elapsedMs: number, durationMs: number): number {
  if (!Number.isFinite(start) || !Number.isFinite(target)) return 1;
  if (durationMs <= 0 || elapsedMs >= durationMs) return target;
  if (elapsedMs <= 0) return start;
  const progress = elapsedMs / durationMs;
  const eased = progress * progress * (3 - 2 * progress);
  return start + (target - start) * eased;
}

export function advanceEnvelopeElapsed(elapsedMs: number, stepMs: number, durationMs: number): number {
  if (durationMs <= 0) return 0;
  return Math.min(durationMs, Math.max(0, elapsedMs) + Math.max(1, stepMs));
}

export function musicBedDelayRemainingMs(hostElapsedSeconds: number, delaySeconds: number): number {
  const elapsed = Number.isFinite(hostElapsedSeconds) ? Math.max(0, hostElapsedSeconds) : 0;
  const delay = Number.isFinite(delaySeconds) ? Math.max(0, delaySeconds) : 0;
  return Math.max(0, Math.ceil(((delay - elapsed) * 1_000) - 1e-6));
}
