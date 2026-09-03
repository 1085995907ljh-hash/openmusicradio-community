export interface CompleteAccountPlayback {
  url: string;
  [key: string]: unknown;
}

export function isCompleteAccountPlayback(playback: unknown, expectedDurationMs?: number | null): playback is CompleteAccountPlayback {
  if (typeof playback !== "object" || playback === null || Array.isArray(playback)) return false;
  const value = playback as Record<string, unknown>;
  if (typeof value.url !== "string" || value.url.length === 0) return false;
  if (value.isTrial === true || value.complete === false) return false;
  if (typeof value.authorizationCode === "number" && value.authorizationCode !== 0) return false;
  if (
    typeof expectedDurationMs === "number"
    && expectedDurationMs > 0
    && typeof value.durationMs === "number"
    && value.durationMs > 0
    && value.durationMs < expectedDurationMs * 0.9
  ) return false;
  return true;
}
