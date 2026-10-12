import type { ProgramRundownItem, ScenePreset } from "../shared/contracts.js";
import { energyRangeForPhase, getSceneConfig, phaseForElapsedSeconds } from "./scenes.js";

/** Arrange an already selected set; familiarity affects spacing, never membership. */
export function arrangeRundown(
  tracks: readonly ProgramRundownItem[],
  scene: ScenePreset,
  mode: "genre" | "atmosphere" = "atmosphere",
): ProgramRundownItem[] {
  const remaining = [...tracks];
  const ordered: ProgramRundownItem[] = [];
  const familiarShare = tracks.filter((track) => track.liked === true).length / Math.max(1, tracks.length);
  const mixed = familiarShare > 0 && familiarShare < 1;
  const duration = tracks.reduce((sum, track) => sum + track.durationSeconds, 0);
  let elapsed = 0;
  let familiarCount = 0;
  let runLength = 0;

  while (remaining.length > 0) {
    const previous = ordered.at(-1);
    const phase = phaseForElapsedSeconds(elapsed, Math.max(1, duration));
    const range = energyRangeForPhase(scene, phase);
    const target = (range.min + range.max) / 2;
    const expectedFamiliar = (ordered.length + 1) * familiarShare;
    // Keep every prefix within one song of the actual selected ratio. This
    // leaves room for musical transitions without exhausting either pool early.
    const balanced = remaining.filter((track) => !mixed || Math.abs(
      familiarCount + Number(track.liked === true) - expectedFamiliar,
    ) < 1 - 1e-9);
    const spaced = balanced.filter((track) => {
      if (!mixed || !previous || (track.liked === true) !== (previous.liked === true)) return true;
      const share = track.liked === true ? familiarShare : 1 - familiarShare;
      const maxRun = Math.max(2, Math.ceil(1 / (1 - share) - 1e-9));
      return runLength < maxRun;
    });
    // Prefix balance has priority if a run limit and available songs conflict.
    const candidates = spaced.length > 0 ? spaced : balanced.length > 0 ? balanced : remaining;
    const ranked = candidates.map((track) => {
      let score = 0;
      const reasons: string[] = [];
      if (hasEnergy(track)) {
        score -= Math.abs(track.energy - target) * 24;
        reasons.push("按已有能量信息匹配节目当前段落");
        if (previous && hasEnergy(previous)) {
          const change = Math.abs(track.energy - previous.energy);
          score -= change * 36;
          if (change <= 0.2) reasons.push("与上一首的能量变化较小");
        }
      }
      if (previous) {
        const sharedMood = overlap(previous.mood, track.mood);
        const sharedStyle = overlap(previous.styleTags ?? [], track.styleTags ?? []);
        score += sharedMood * 24 + sharedStyle * 18;
        if (sharedMood > 0) reasons.push("与上一首有共同情绪标签");
        if (sharedStyle > 0) reasons.push("与上一首有共同风格标签");
        const artist = normalize(track.artist);
        if (artist && artist === normalize(previous.artist)) score -= 26;
        else if (artist && ordered.slice(-3).some((item) => normalize(item.artist) === artist)) score -= 8;
      }
      if (mixed) {
        score -= Math.abs(familiarCount + Number(track.liked === true) - expectedFamiliar) * 6;
      }
      return { track, score, reasons };
    });
    // Stable ties preserve the selected order, but rank is never an energy proxy.
    ranked.sort((left, right) => right.score - left.score);
    const chosen = ranked[0]!;
    const familiar = chosen.track.liked === true;
    if (mixed) chosen.reasons.push("按入选歌单的实际比例分散熟悉与探索歌曲");
    if (chosen.reasons.length === 0) chosen.reasons.push("音乐属性不足，保留稳定次序并尽量错开相邻艺人");
    // Preserve the program-intent annotation used by replacement eligibility.
    // This describes our arrangement, not a measured property of the song.
    const phaseLabel = { opening: "开场", building: "展开", peak: "中段", cooldown: "回落", closing: "收尾" }[phase];
    chosen.reasons.push(mode === "genre"
      ? `按所选风格的${phaseLabel}段落编排`
      : `按${getSceneConfig(scene).label}氛围的${phaseLabel}段落编排`);
    ordered.push({
      ...chosen.track,
      arrangementTargetEnergy: target,
      reasons: [...chosen.track.reasons, ...chosen.reasons],
    });
    remaining.splice(remaining.indexOf(chosen.track), 1);
    familiarCount += Number(familiar);
    runLength = previous && (previous.liked === true) === familiar ? runLength + 1 : 1;
    elapsed += chosen.track.durationSeconds;
  }
  return ordered;
}

function hasEnergy(track: ProgramRundownItem): boolean {
  return track.energyMeasured === true && Number.isFinite(track.energy) && track.energy >= 0 && track.energy <= 1;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function overlap(left: readonly string[], right: readonly string[]): number {
  const a = new Set(left.map(normalize).filter(Boolean));
  const b = new Set(right.map(normalize).filter(Boolean));
  if (a.size === 0 || b.size === 0) return 0;
  return [...a].filter((tag) => b.has(tag)).length / new Set([...a, ...b]).size;
}
