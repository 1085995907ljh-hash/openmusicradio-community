import { ProviderError, type ProviderErrorCode, type ProviderErrorInfo } from "./types.js";

export interface ReadBodyResult {
  text: string;
  json: unknown;
  contentType: string;
}

export async function readResponseBody(response: Response, maxBytes = 4 * 1024 * 1024): Promise<ReadBodyResult> {
  const contentType = readHeader(response.headers, "content-type") ?? "";
  const contentLength = Number(readHeader(response.headers, "content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new RangeError("provider response is too large");
  let text = "";

  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new RangeError("provider response is too large");
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
  } else if (typeof response.text === "function") {
    const bodyText = await response.text();
    text = typeof bodyText === "string" ? bodyText : "";
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw new RangeError("provider response is too large");
  }

  let json: unknown = undefined;
  if (text.trim()) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  } else if (typeof response.json === "function") {
    try {
      json = await response.json();
      text = JSON.stringify(json);
    } catch {
      json = undefined;
    }
  }

  return { text, json, contentType };
}

export function readHeader(headers: Headers | Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) ?? undefined;
  }
  const entries = Object.entries(headers as Record<string, string>);
  const match = entries.find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match?.[1];
}

export function retryAfterMilliseconds(headers: Headers | Record<string, string> | undefined): number | undefined {
  const value = readHeader(headers, "retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - Date.now());
}

export function safeUpstreamMessage(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const clean = value
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[upstream-url]")
    .replace(/\bauthorization\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, "authorization=[redacted]")
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|password|secret|token)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  return clean.slice(0, 240) || fallback;
}

export function providerErrorInfo(
  provider: string,
  code: ProviderErrorCode,
  message: string,
  options: Partial<Pick<ProviderErrorInfo, "status" | "retryable" | "retryAfterMs">> = {},
): ProviderErrorInfo {
  return {
    code,
    message,
    provider,
    retryable: options.retryable ?? false,
    ...(options.status === undefined ? {} : { status: options.status }),
    ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
  };
}

export function httpError(provider: string, status: number, headers?: Headers | Record<string, string>): ProviderError {
  if (status === 401 || status === 403) {
    return new ProviderError(providerErrorInfo(provider, "unauthorized", "provider credentials were rejected", {
      status,
      retryable: false,
    }));
  }
  if (status === 429) {
    return new ProviderError(providerErrorInfo(provider, "rate_limited", "provider rate limit reached", {
      status,
      retryable: true,
      retryAfterMs: retryAfterMilliseconds(headers),
    }));
  }
  if (status === 408 || status === 504) {
    return new ProviderError(providerErrorInfo(provider, "timeout", "provider request timed out", {
      status,
      retryable: true,
    }));
  }
  if (status === 404 || status === 405 || status === 501) {
    return new ProviderError(providerErrorInfo(provider, "unsupported", "provider endpoint is unsupported", {
      status,
      retryable: false,
    }));
  }
  return new ProviderError(providerErrorInfo(provider, status >= 500 ? "network_error" : "business_error", "provider request failed", {
    status,
    retryable: status >= 500,
  }));
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}

export interface BusinessFailure {
  message: string;
  code?: string | number;
}

export function findBusinessFailure(payload: unknown): BusinessFailure | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;

  if (record.success === false || record.ok === false) {
    return {
      code: typeof record.code === "string" || typeof record.code === "number" ? record.code : undefined,
      message: safeUpstreamMessage(record.message ?? record.error, "provider rejected the request"),
    };
  }

  if (record.error !== undefined && record.error !== null) {
    const error = record.error;
    if (typeof error === "string") return { message: safeUpstreamMessage(error, "provider returned an error") };
    if (typeof error === "object") {
      const errorRecord = error as Record<string, unknown>;
      return {
        code: typeof errorRecord.code === "string" || typeof errorRecord.code === "number" ? errorRecord.code : undefined,
        message: safeUpstreamMessage(errorRecord.message ?? errorRecord.type, "provider returned an error"),
      };
    }
    return { message: "provider returned an error" };
  }

  if (record.status === "error" || record.status === "failed" || record.status === "failure") {
    return {
      code: typeof record.code === "string" || typeof record.code === "number" ? record.code : undefined,
      message: safeUpstreamMessage(record.message, "provider returned a failed result"),
    };
  }

  if (record.code !== undefined && !isSuccessCode(record.code)) {
    return {
      code: typeof record.code === "string" || typeof record.code === "number" ? record.code : undefined,
      message: safeUpstreamMessage(record.message, "provider returned a business error"),
    };
  }

  for (const key of ["output", "data", "result", "response"]) {
    const child = record[key];
    if (!child || typeof child !== "object" || Array.isArray(child)) continue;
    const nested = findBusinessFailure(child);
    if (nested) return nested;
  }
  return undefined;
}

function isSuccessCode(value: unknown): boolean {
  if (typeof value === "number") return value === 0 || value === 200;
  if (typeof value !== "string") return false;
  return value === "0" || value === "200" || value.toLowerCase() === "ok" || value.toLowerCase() === "success";
}

export async function fetchWithTimeout(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  options: { timeoutMs: number; signal?: AbortSignal; provider: string },
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs));
  if (options.signal?.aborted) {
    throw new ProviderError(providerErrorInfo(options.provider, "timeout", "provider request timed out", { retryable: true }));
  }
  let rejectTimeout: ((error: ProviderError) => void) | undefined;
  const timeoutPromise = new Promise<Response>((_, reject) => {
    rejectTimeout = reject;
  });
  let rejectCallerAbort: ((error: ProviderError) => void) | undefined;
  const callerAbortPromise = new Promise<Response>((_, reject) => {
    rejectCallerAbort = reject;
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectTimeout?.(new ProviderError(providerErrorInfo(options.provider, "timeout", "provider request timed out", { retryable: true })));
  }, timeoutMs);
  const abortFromCaller = () => {
    controller.abort();
    rejectCallerAbort?.(new ProviderError(providerErrorInfo(options.provider, "timeout", "provider request timed out", { retryable: true })));
  };
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", abortFromCaller, { once: true });
  }

  try {
    return await Promise.race([
      fetchImpl(url, { ...init, signal: controller.signal }),
      timeoutPromise,
      callerAbortPromise,
    ]);
  } catch (error) {
    const isAbortError = typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError";
    if (timedOut || options.signal?.aborted || isAbortError) {
      throw new ProviderError(providerErrorInfo(options.provider, "timeout", "provider request timed out", { retryable: true }), { cause: error });
    }
    throw new ProviderError(providerErrorInfo(options.provider, "network_error", "provider request failed before receiving a response", {
      retryable: true,
    }), { cause: error });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}
