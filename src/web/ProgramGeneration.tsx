import { useId, type CSSProperties } from "react";
import { Check, X } from "lucide-react";
import "./program-generation.css";

const stages = ["读取听歌偏好", "寻找合适的歌曲", "编排音乐与节奏", "撰写歌单推荐语"];
const descriptions = [
  "从你熟悉的旋律出发，寻找这次节目的方向。",
  "让喜欢的音乐与新的发现，在这里相遇。",
  "安排歌曲的起伏，也为主持人的声音留出空间。",
  "歌曲已经选好，正在整理推荐语，完成后一起呈现。",
];

export default function ProgramGeneration({ complete, completedSteps, mode = "generating", onCancel, cancelling = false }: { complete: boolean; completedSteps: number; mode?: "generating" | "preparing"; onCancel?: () => void; cancelling?: boolean }) {
  const preparing = mode === "preparing";
  const stepLabels = preparing ? ["核对最终节目单", "准备主持内容", "合成语音并准备播放队列", "校验首曲并开始播放"] : stages;
  const stepDescriptions = preparing ? ["核对你确认的歌曲与顺序，为开播做好准备。", "让主持人的话语，和这份歌单自然相遇。", "正在合成主持语音，安排音乐与口播的播放顺序。", "检查第一首歌，就绪后自动开始播放。"] : descriptions;
  const id = useId().replace(/:/g, "");
  const count = complete ? 4 : Math.max(0, Math.min(4, Math.floor(completedSteps)));
  const percent = count * 25;
  const active = Math.min(count, 3);
  return <section className="generation-room" data-mode={mode} data-complete={complete} aria-labelledby="generation-title">
    <div className="generation-heading"><span className="generation-eyebrow">OPEN MUSIC RADIO · {preparing ? "GETTING READY TO PLAY" : "CURATING YOUR SESSION"}</span><h2 id="generation-title">{preparing ? "正在完成开播准备" : "你的下一段音乐，正在成形。"}</h2><p>{preparing ? "节目内容和播放队列就绪后，会自动开始播放。" : "一点熟悉，一点新发现。为你编排一档私人节目。"}</p></div>
    <div className="generation-art" aria-hidden="true">
      <div className="generation-halo" />
      <svg className="generation-sculpture" viewBox="0 0 800 360" preserveAspectRatio="none" fill="none">
        <defs>
          <linearGradient id={`${id}-thread`} x1="120" y1="80" x2="670" y2="280" gradientUnits="userSpaceOnUse"><stop stopColor="#4b6a81" /><stop offset=".32" stopColor="#92e4e6" /><stop offset=".65" stopColor="#c5b7ed" /><stop offset="1" stopColor="#54647d" /></linearGradient>
          <linearGradient id={`${id}-shine`}><stop stopColor="#8ce2e8" stopOpacity="0" /><stop offset=".5" stopColor="#e4faff" /><stop offset="1" stopColor="#c4b8f0" stopOpacity="0" /></linearGradient>
        </defs>
        <g className="generation-threads">
          {Array.from({ length: 32 }, (_, index) => {
            const t = index / 31;
            const y = 90 + t * 180;
            const edgeY = 180 + (t - .5) * 36;
            const d = `M -40 ${edgeY} C 20 ${edgeY}, -20 ${245 - t * 30}, 100 ${y} C 220 ${-65 + t * 390}, 290 ${360 - t * 350}, 400 ${180 + Math.sin(t * Math.PI * 2) * 46} S 585 ${-60 + t * 410}, 700 ${270 - t * 180} S 800 ${edgeY}, 840 ${edgeY}`;
            return <path key={index} className="generation-thread" d={d} stroke={`url(#${id}-thread)`} strokeWidth={index % 5 === 0 ? 1.2 : .65} vectorEffect="non-scaling-stroke" style={{ "--thread-delay": `${index * -.13}s`, opacity: .3 + Math.sin(t * Math.PI) * .5 } as CSSProperties} />;
          })}
        </g>
        <path className="generation-trace generation-trace-glow" d="M -40 180 C 20 180 -40 330 100 180 C 240 30 280 330 400 180 S 570 30 700 180 S 800 180 840 180" stroke={`url(#${id}-shine)`} strokeWidth="6" vectorEffect="non-scaling-stroke" pathLength="100" />
        <path className="generation-trace" d="M -40 180 C 20 180 -40 330 100 180 C 240 30 280 330 400 180 S 570 30 700 180 S 800 180 840 180" stroke={`url(#${id}-shine)`} strokeWidth="3" vectorEffect="non-scaling-stroke" pathLength="100" />
      </svg>
      <div className="generation-note-sprites">
        <img src="/media/music-notes/eighth-note.png" className="generation-note-sprite" alt="" style={{ left: "25.625%", top: "27.22%", "--note-delay": "0s" } as CSSProperties} />
        <img src="/media/music-notes/beamed-notes.png" className="generation-note-sprite" alt="" style={{ left: "73.5%", top: "68.61%", "--note-delay": "-1.4s" } as CSSProperties} />
        <img src="/media/music-notes/quarter-note.png" className="generation-note-sprite" alt="" style={{ left: "79.75%", top: "29.72%", "--note-delay": "-2.8s" } as CSSProperties} />
        <img src="/media/music-notes/eighth-note.png" className="generation-note-sprite" alt="" style={{ left: "41.875%", top: "77.78%", "--note-delay": "-3.6s" } as CSSProperties} />
      </div>
      <span className="generation-art-caption">A SESSION, JUST FOR YOU</span>
    </div>
    <div className="generation-status" role="status" aria-live="polite" aria-atomic="true"><span className="generation-status-dot" /><strong>{cancelling ? "正在取消生成" : complete ? (preparing ? "开播准备已就绪" : "节目计划已就绪") : count === 4 ? (preparing ? "正在开始播放" : "正在整理最终结果") : `${preparing ? "正在" : ""}${stepLabels[active]}`}</strong><span className="generation-percent">{percent}<small>%</small></span></div>
    <p className="generation-description">{complete ? (preparing ? "准备完成，即将开始你的私人电台。" : "接下来，确认歌单，开始你的私人电台。") : stepDescriptions[active]}</p>
    <div className="generation-progress" role="progressbar" aria-label={preparing ? "开播准备进度" : "节目计划生成进度"} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={`${percent}%，已完成 ${count} 个阶段，共 4 个阶段`}>
      <ol>{stepLabels.map((stage, index) => <li key={stage} className={index < count ? "done" : index === count ? "active" : "pending"}><span className="generation-step-track" /><span className="generation-step-label"><span>{index < count ? <Check size={12} /> : `0${index + 1}`}</span>{stage}</span></li>)}</ol>
    </div>
    <p className="generation-footnote">按已完成阶段计算 · {count} / 4</p>
    {onCancel && !complete && <button className="generation-cancel" type="button" onClick={onCancel} disabled={cancelling}><X size={14} />{cancelling ? "正在取消…" : preparing ? "取消生成，返回歌单" : "取消生成，返回设置"}</button>}
  </section>;
}
