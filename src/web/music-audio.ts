interface MusicAudioGraph {
  context: AudioContext;
  source: MediaElementAudioSourceNode;
  output: GainNode;
}

// Keep one media source per element across React remounts and hot updates.
const audioGlobal = globalThis as typeof globalThis & {
  __openMusicRadioMixerV1?: {
    context: AudioContext | null;
    graphs: WeakMap<HTMLMediaElement, MusicAudioGraph>;
  };
};
const runtime = audioGlobal.__openMusicRadioMixerV1 ??= { context: null, graphs: new WeakMap() };

function musicContext(): AudioContext {
  return runtime.context ??= new AudioContext();
}

export function musicAudioGraph(audio: HTMLMediaElement): MusicAudioGraph {
  const existing = runtime.graphs.get(audio);
  if (existing) return existing;
  const context = musicContext();
  const output = context.createGain();
  output.gain.value = audio.volume;
  const source = context.createMediaElementSource(audio);
  source.connect(output);
  output.connect(context.destination);
  // The gain node owns the music level, including on browsers with read-only media volume.
  audio.volume = 1;
  const graph = { context, source, output };
  runtime.graphs.set(audio, graph);
  return graph;
}

export function setMusicVolume(audio: HTMLMediaElement, target: number, durationMs = 0): void {
  const { context, output } = musicAudioGraph(audio);
  const gain = output.gain;
  const now = context.currentTime;
  const current = gain.value;
  const next = Math.max(0, Math.min(1, target));
  // Cancel an old restore before another host segment ducks the same music.
  gain.cancelScheduledValues(now);
  gain.setValueAtTime(durationMs > 0 ? current : next, now);
  if (durationMs > 0) gain.linearRampToValueAtTime(next, now + durationMs / 1000);
}

export function resumeMusicContext(): void {
  void musicContext().resume().catch(() => undefined);
}

export async function playMusic(audio: HTMLMediaElement): Promise<void> {
  const { context } = musicAudioGraph(audio);
  resumeMusicContext();
  await audio.play();
  // Media autoplay and Web Audio have separate activation gates. Surface the
  // existing "enable sound" recovery instead of showing silent playback.
  if (context.state !== "running") {
    audio.pause();
    throw new DOMException("Audio output requires user activation", "NotAllowedError");
  }
}

export async function setMusicOutputDevice(sinkId: string): Promise<void> {
  const context = musicContext() as AudioContext & { setSinkId?: (id: string) => Promise<void> };
  if (typeof context.setSinkId === "function") await context.setSinkId(sinkId);
}
