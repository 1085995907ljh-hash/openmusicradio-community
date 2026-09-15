import test from "node:test";
import assert from "node:assert/strict";

import { loadRadioHostReviewSkill, loadRadioHostSkill } from "../src/server/radio-host-skill.js";

test("radio host skill prioritizes artist background, style, and classic stories over routine credits", () => {
  const writer = loadRadioHostSkill();
  const reviewer = loadRadioHostReviewSkill();

  assert.match(writer, /音乐人背景/);
  assert.match(writer, /经典成就|经典歌曲/);
  assert.match(writer, /作词、作曲和制作名单不是默认介绍材料|作词、作曲、编曲和制作人名单不是默认口播内容/);
  assert.match(reviewer, /不把作词、作曲、制作名单当作默认信息/);
});

test("radio host skill separates factual checkpoints from whole-show editing and final locking", () => {
  const writer = loadRadioHostSkill();
  const reviewer = loadRadioHostReviewSkill();

  assert.match(writer, /规划阶段不写正文/);
  assert.match(writer, /每次只为一个|一次只写一条/);
  assert.match(writer, /撰稿阶段不改写前文/);
  assert.match(writer, /评论区、高赞评论/);
  assert.match(reviewer, /stage=fact_check/);
  assert.match(reviewer, /stage=show_edit/);
  assert.match(reviewer, /事实通过只表示内部检查点就绪/);
  assert.match(reviewer, /只有完成整档编辑及必要复核后才能锁稿展示/);
  assert.match(writer, /专辑.*年份.*各最多一次/s);
  assert.match(reviewer, /纯元数据补充最多两条/);
  assert.match(reviewer, /无效专辑占位值/);
  assert.match(reviewer, /文风不触发固定模板/);
  assert.match(reviewer, /身份正确且无虚构的短稿必须通过/);
  assert.match(writer, /有界重试/);
  assert.doesNotMatch(reviewer, /通过后直接展示并立即锁定/);
});
