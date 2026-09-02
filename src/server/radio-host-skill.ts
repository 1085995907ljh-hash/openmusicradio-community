import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const MAX_SKILL_BYTES = 48_000;
const SKILL_DIRECTORIES = [
  resolve(process.cwd(), "skills/ai-radio-host"),
  resolve(dirname(fileURLToPath(import.meta.url)), "../../skills/ai-radio-host"),
];
const SKILL_ROOTS = [
  ...SKILL_DIRECTORIES.map((root) => resolve(root, "references")),
];

const FALLBACK_GENERATOR = [
  "你是中文音乐电台的主持人兼撰稿人。先考虑听众此刻需要知道什么，再写三个内容角度真正不同的候选。",
  "只使用 allowedFacts；探索歌曲介绍音乐人背景、作品故事和风格，熟悉歌曲只讲一个新信息，经典歌曲强调成就、影响或故事。资料不足就简洁报出艺人和歌名。",
  "作词、作曲、编曲和制作名单不是默认口播材料；只有它能解释合作关系、创作缘起、声音风格或经典地位时才提。",
  "避免百科、广告、播音腔、短视频钩子、空泛情绪和提示听众如何听音乐。",
  "返回 JSON：{\"candidates\":[{\"angle\":\"...\",\"text\":\"...\",\"factIds\":[],\"deliveryInstruction\":\"...\"}]}。",
].join("\n");

const FALLBACK_REVIEWER = [
  "你是独立节目监制，只审核候选，不能代写。",
  "开场和结尾只检查固定硬伤；中间口播作为一组整体审核语气、用词、信息密度、重复和衔接，不逐段打分。",
  "明显机器腔、重复句式、信息贫乏、把作词作曲名单当主体、没有歌手背景或经典故事时退回。",
  "返回 JSON：{\"approved\":true,\"selectedIndex\":0,\"issues\":[],\"rationale\":\"...\"}；不通过时 approved=false、selectedIndex=null，并给出可执行问题。最多两轮修改，最后一轮直接输出。",
].join("\n");

function loadContract(fileName: string, fallback: string, configuredPath?: string): string {
  for (const path of [configuredPath, ...SKILL_ROOTS.map((root) => resolve(root, fileName))]) {
    if (!path) continue;
    try {
      const text = readFileSync(path, "utf8").trim();
      if (text) return text.slice(0, MAX_SKILL_BYTES);
    } catch {
      // A missing local skill should degrade to the small built-in contract.
    }
  }
  return fallback;
}

function loadSkillBundle(contractFile: string, fallback: string, configuredPath?: string): string {
  if (configuredPath) return loadContract(contractFile, fallback, configuredPath);
  for (const root of SKILL_DIRECTORIES) {
    try {
      const parts = [
        readFileSync(resolve(root, "SKILL.md"), "utf8"),
        readFileSync(resolve(root, "references/research-contract.md"), "utf8"),
        readFileSync(resolve(root, "references/writing-method.md"), "utf8"),
        readFileSync(resolve(root, `references/${contractFile}`), "utf8"),
      ];
      return parts.join("\n\n").trim().slice(0, MAX_SKILL_BYTES);
    } catch {
      // Try the next project-relative Skill location.
    }
  }
  return fallback;
}

function loadReviewBundle(fallback: string, configuredPath?: string): string {
  if (configuredPath) return loadContract("reviewer-contract.md", fallback, configuredPath);
  for (const root of SKILL_DIRECTORIES) {
    try {
      return [
        readFileSync(resolve(root, "references/research-contract.md"), "utf8"),
        readFileSync(resolve(root, "references/writing-method.md"), "utf8"),
        readFileSync(resolve(root, "references/reviewer-contract.md"), "utf8"),
      ].join("\n\n").trim().slice(0, MAX_SKILL_BYTES);
    } catch {
      // Try the next project-relative Skill location.
    }
  }
  return fallback;
}

/** Loads the Yao-authored writer and independent-review contracts. */
export function loadRadioHostSkill(): string {
  return loadSkillBundle("generator-contract.md", FALLBACK_GENERATOR, process.env.AI_RADIO_HOST_SKILL_PATH?.trim());
}

export function loadRadioHostReviewSkill(): string {
  return loadReviewBundle(FALLBACK_REVIEWER, process.env.AI_RADIO_HOST_REVIEW_SKILL_PATH?.trim());
}
