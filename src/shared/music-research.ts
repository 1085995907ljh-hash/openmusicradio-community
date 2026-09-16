export interface MusicResearchTrack {
  title: string;
  artist: string;
  album?: string;
  exploration?: boolean;
}

export interface ResearchedMusicFact {
  id: string;
  value: string;
  sourceUrl: string;
  subject?: "song" | "album" | "artist";
  sourceTitle?: string;
  evidenceQuote?: string;
}

export interface MusicResearchAttempt {
  query: string;
  status: "completed" | "failed";
  sourceUrls: string[];
}

export interface MusicResearchReceipt {
  trackKey: string;
  status: "researched" | "no_results" | "failed";
  completedAt: string;
  attempts: MusicResearchAttempt[];
  facts: ResearchedMusicFact[];
  steps?: Array<{ action: "search" | "read"; target: string; status: "completed" | "failed"; detail?: string }>;
  completionReason?: string;
  failureCode?: "search_unavailable" | "source_unavailable" | "model_unavailable" | "invalid_action" | "invalid_evidence";
}

export interface MusicResearchReport {
  tracks: MusicResearchReceipt[];
}

const RESEARCH_FAILURE_MESSAGES: Record<NonNullable<MusicResearchReceipt["failureCode"]>, string> = {
  search_unavailable: "搜索服务暂时不可用",
  source_unavailable: "资料原文暂时无法读取",
  model_unavailable: "调研模型请求失败或超时",
  invalid_action: "调研模型未完成有效的搜索和阅读",
  invalid_evidence: "候选资料未通过原文核验",
};

/** Only controlled diagnostics may reach the UI, never upstream bodies or model output. */
export class MusicResearchIncompleteError extends Error {
  constructor(message: string) { super(message); this.name = "MusicResearchIncompleteError"; }
}

export function musicResearchTrackKey(track: MusicResearchTrack): string {
  return JSON.stringify([track.title.trim(), track.artist.trim(), track.album?.trim() ?? ""]);
}

export function musicResearchFactText(fact: ResearchedMusicFact): string {
  const subject = fact.subject ? { song: "歌曲", album: "专辑", artist: "歌手" }[fact.subject] : undefined;
  return [subject ? `事实主体：${subject}。` : "", fact.value, fact.evidenceQuote ? `原文证据：${fact.evidenceQuote}` : ""].filter(Boolean).join("\n");
}

/** A fact list alone cannot prove that every selected song was researched. */
export function requireCompletedMusicResearch(value: unknown, tracks: readonly MusicResearchTrack[]): MusicResearchReport {
  if (!value || typeof value !== "object" || !("tracks" in value) || !Array.isArray(value.tracks)) {
    throw new MusicResearchIncompleteError("联网调研没有返回逐曲记录，口播尚未开始生成。");
  }
  const report = value as MusicResearchReport;
  if (report.tracks.length !== tracks.length) throw new MusicResearchIncompleteError("部分歌曲尚未完成联网调研，口播尚未开始生成。");
  for (const [index, track] of tracks.entries()) {
    const receipt = report.tracks[index];
    if (!receipt || receipt.trackKey !== musicResearchTrackKey(track)
      || !["researched", "no_results"].includes(receipt.status)
      || !Number.isFinite(Date.parse(receipt.completedAt))
      || !Array.isArray(receipt.attempts) || receipt.attempts.length === 0
      || receipt.attempts.some((attempt) => !attempt || attempt.status !== "completed" || typeof attempt.query !== "string" || !attempt.query.trim()
        || !Array.isArray(attempt.sourceUrls) || attempt.sourceUrls.some((url) => typeof url !== "string" || !url.startsWith("https://")))
      || !Array.isArray(receipt.facts)
      || (receipt.status === "researched") !== (receipt.facts.length > 0)
      || receipt.facts.some((fact) => !fact || typeof fact.id !== "string" || !/^web:[A-Za-z0-9_-]+$/.test(fact.id)
        || typeof fact.value !== "string" || fact.value.trim().length < 12
        || typeof fact.sourceUrl !== "string" || !receipt.attempts.some((attempt) => attempt.sourceUrls.includes(fact.sourceUrl)))) {
      const title = track.title.replace(/[\r\n]/g, " ").slice(0, 80);
      const reason = receipt?.failureCode && Object.hasOwn(RESEARCH_FAILURE_MESSAGES, receipt.failureCode)
        ? RESEARCH_FAILURE_MESSAGES[receipt.failureCode] : "调研记录不完整或未通过核验";
      throw new MusicResearchIncompleteError(`第 ${index + 1} 首《${title}》联网调研未完成：${reason}。口播尚未开始生成。`);
    }
  }
  return report;
}
