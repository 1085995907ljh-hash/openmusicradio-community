/** Enforce a deadline even when an upstream operation ignores cancellation. */
export async function withDeadline<T>(work: (signal: AbortSignal) => Promise<T>, parent: AbortSignal | undefined, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(parent?.reason);
  if (parent?.aborted) cancel();
  else parent?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException("Operation timed out", "TimeoutError")), timeoutMs);
  let rejectAbort: () => void = () => {};
  try {
    controller.signal.throwIfAborted();
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    return await Promise.race([work(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", rejectAbort);
  }
}

export function isTimeoutError(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && (("name" in error && error.name === "TimeoutError") || ("code" in error && error.code === "timeout"));
}
