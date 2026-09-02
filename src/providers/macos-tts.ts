import { execFile as nodeExecFile, type ExecFileOptions } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ProviderError,
  SCENE_INSTRUCTIONS,
  isScenePreset,
  type TtsResult,
  type TtsSynthesisRequest,
  type TtsProviderStatus,
} from "./types.js";
import { isProviderError, providerErrorInfo, safeUpstreamMessage } from "./http.js";

const PROVIDER_NAME = "macos-tts" as const;
const SAY_COMMAND = "/usr/bin/say";
const AFCONVERT_COMMAND = "/usr/bin/afconvert";
const VOICE = "Reed (中文（中国大陆）)";
const MODEL = "macos-say-local-v1";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_INPUT_LENGTH = 600;
const SCENE_RATES: Readonly<Record<TtsSynthesisRequest["scenePreset"], number>> = Object.freeze({
  late_night: 150,
  study: 162,
  workout: 180,
  commute: 171,
  party: 186,
});

export interface MacOsTtsRunnerOptions {
  timeout: number;
  shell: false;
  signal?: AbortSignal;
}

/** The runner is injectable so tests can write a fake WAV without invoking say. */
export type MacOsTtsRunner = (
  command: string,
  args: readonly string[],
  options: MacOsTtsRunnerOptions,
) => Promise<unknown> | unknown;

export interface MacOsTtsProviderOptions {
  timeoutMs?: number;
  maxInputLength?: number;
  /** Alias retained for callers that use the cloud provider option name. */
  maxTextLength?: number;
  /** Alias useful to tests and existing child-process adapters. */
  runner?: MacOsTtsRunner;
  execFile?: MacOsTtsRunner;
}

export interface MacOsTtsProviderStatus extends Omit<TtsProviderStatus, "provider" | "model" | "voice" | "baseUrl" | "timeoutMs"> {
  provider: typeof PROVIDER_NAME;
  baseUrl: "local://say";
  model: typeof MODEL;
  voice: typeof VOICE;
  timeoutMs: number;
  state: "ready";
}

type MacOsTtsResult = Omit<TtsResult, "provider" | "model" | "voice"> & {
  provider: typeof PROVIDER_NAME;
  model: typeof MODEL;
  voice: typeof VOICE;
};

/**
 * macOS local TTS fallback. The fixed voice and command path are intentionally
 * part of this provider, so a program cannot silently change its host voice.
 */
export class MacOsTtsProvider {
  private readonly timeoutMs: number;
  private readonly maxInputLength: number;
  private readonly runner: MacOsTtsRunner;

  constructor(options: MacOsTtsProviderOptions = {}) {
    this.timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.maxInputLength = positiveInteger(options.maxInputLength ?? options.maxTextLength, DEFAULT_MAX_INPUT_LENGTH);
    this.runner = options.runner ?? options.execFile ?? defaultRunner;
  }

  get configured(): boolean {
    return true;
  }

  get state(): "ready" {
    return "ready";
  }

  getStatus(): MacOsTtsProviderStatus {
    return {
      provider: PROVIDER_NAME,
      configured: true,
      mock: false,
      baseUrl: "local://say",
      model: MODEL,
      voice: VOICE,
      language: "Chinese",
      timeoutMs: this.timeoutMs,
      state: "ready",
    };
  }

  async synthesize(request: TtsSynthesisRequest): Promise<MacOsTtsResult> {
    const scenePreset = request?.scenePreset;
    const instruction = isScenePreset(scenePreset) ? SCENE_INSTRUCTIONS[scenePreset] : "";
    try {
      if (!request || typeof request.text !== "string" || !request.text.trim()) {
        throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_input", "TTS text must not be empty", { retryable: false }));
      }
      if (!isScenePreset(scenePreset)) {
        throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_input", "scenePreset is not supported", { retryable: false }));
      }

      const text = request.text.trim();
      if (Array.from(text).length > this.maxInputLength) {
        throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_input", "TTS text exceeds the configured length limit", { retryable: false }));
      }
      if (request.signal?.aborted) {
        throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "timeout", "TTS synthesis was cancelled", { retryable: true }));
      }

      const audio = await this.synthesizeWav(text, scenePreset, request.signal);
      return {
        provider: PROVIDER_NAME,
        status: "ready",
        configured: true,
        mock: false,
        success: true,
        model: MODEL,
        voice: VOICE,
        language: "Chinese",
        scenePreset,
        instruction,
        audio,
        buffer: audio,
        audioBuffer: audio,
      };
    } catch (error) {
      const failure = asProviderError(error).toInfo();
      return {
        provider: PROVIDER_NAME,
        status: "failed",
        configured: true,
        mock: false,
        success: false,
        model: MODEL,
        voice: VOICE,
        language: "Chinese",
        scenePreset: isScenePreset(scenePreset) ? scenePreset : "study",
        instruction,
        audio: null,
        buffer: null,
        audioBuffer: null,
        error: failure,
      };
    }
  }

  async synthesizeOrThrow(request: TtsSynthesisRequest): Promise<MacOsTtsResult> {
    const result = await this.synthesize(request);
    if (!result.success && result.error) throw new ProviderError(result.error);
    return result;
  }

  private async synthesizeWav(text: string, scenePreset: TtsSynthesisRequest["scenePreset"], signal?: AbortSignal): Promise<Buffer> {
    const directory = await mkdtemp(join(tmpdir(), "one-radio-macos-tts-"));
    const sourcePath = join(directory, "speech.aiff");
    const outputPath = join(directory, "speech.wav");
    try {
      throwIfAborted(signal);
      await this.runner(SAY_COMMAND, ["-v", VOICE, "-r", String(SCENE_RATES[scenePreset]), "-o", sourcePath, text], {
        timeout: this.timeoutMs,
        shell: false,
        ...(signal ? { signal } : {}),
      });
      throwIfAborted(signal);
      await this.runner(AFCONVERT_COMMAND, ["-f", "WAVE", "-d", "LEI16", sourcePath, outputPath], {
        timeout: this.timeoutMs,
        shell: false,
        ...(signal ? { signal } : {}),
      });
      throwIfAborted(signal);
      const audio = await readFile(outputPath);
      throwIfAborted(signal);
      validateWav(audio);
      return audio;
    } catch (error) {
      throw asProviderError(error);
    } finally {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch {
        // Cleanup must not hide the synthesis result or its typed failure.
      }
    }
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "timeout", "TTS synthesis was cancelled", { retryable: true }));
}

function validateWav(audio: Buffer): void {
  if (audio.byteLength < 12) {
    throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_audio", "macOS say returned an invalid WAV file", { retryable: false }));
  }
  const riff = audio.subarray(0, 4).toString("ascii");
  const wave = audio.subarray(8, 12).toString("ascii");
  if (riff !== "RIFF" || wave !== "WAVE") {
    throw new ProviderError(providerErrorInfo(PROVIDER_NAME, "invalid_audio", "macOS say returned an invalid WAV file", { retryable: false }));
  }
}

export function createMacOsTtsProvider(options: MacOsTtsProviderOptions = {}): MacOsTtsProvider {
  return new MacOsTtsProvider(options);
}

const defaultRunner: MacOsTtsRunner = (command, args, options) => new Promise<void>((resolve, reject) => {
  const childOptions: ExecFileOptions = {
    timeout: options.timeout,
    shell: false,
    ...(options.signal ? { signal: options.signal } : {}),
  };
  nodeExecFile(command, [...args], childOptions, (error) => {
    if (error) reject(error);
    else resolve();
  });
});

function positiveInteger(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function asProviderError(error: unknown): ProviderError {
  if (isProviderError(error)) return error;
  if (isAbortOrTimeout(error)) {
    return new ProviderError(providerErrorInfo(PROVIDER_NAME, "timeout", "macOS say timed out", { retryable: true }), { cause: error });
  }
  const message = safeUpstreamMessage(error instanceof Error ? error.message : undefined, "macOS say failed");
  return new ProviderError(providerErrorInfo(PROVIDER_NAME, "network_error", message, { retryable: false }), { cause: error });
}

function isAbortOrTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  return record.name === "AbortError" || record.code === "ABORT_ERR" || record.code === "ETIMEDOUT" || record.killed === true || record.signal === "SIGTERM";
}

export type { MacOsTtsResult };
