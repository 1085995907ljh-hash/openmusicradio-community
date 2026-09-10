import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("confirmation keeps host generation private and exposes explicit playlist editing controls", () => {
  const source = readFileSync(new URL("../src/web/App.tsx", import.meta.url), "utf8");

  assert.match(source, /口播将在确认后生成/);
  assert.match(source, /节目内容和播放队列就绪后，会自动开始播放/);
  assert.doesNotMatch(source, /regenerateHostScripts/);
  assert.doesNotMatch(source, /hostRetryRequired/);
  assert.doesNotMatch(source, /主持口播/);
  assert.doesNotMatch(source, />重试口播</);
  assert.doesNotMatch(source, />取消重试</);
  assert.doesNotMatch(source, /onRetryHostScripts/);
  assert.doesNotMatch(source, /onEditSettings/);
  assert.match(source, /批量调整/);
  assert.match(source, /调整顺序/);
  assert.match(source, /重新推荐/);
  assert.match(source, /替换所选/);
  assert.match(source, /is-replacing/);
  assert.match(source, /替换中/);
  assert.match(source, /顺序尚未保存，保存后才能启动节目/);
  assert.match(source, /__openMusicRadioVisualizerV2/);
  assert.match(source, /meyda-audio-graph-v2/);
  assert.match(source, /analyserError/);
  assert.doesNotMatch(source, /BatchAdjustmentKind/);
  assert.doesNotMatch(source, /toggleTrackLock/);
  assert.doesNotMatch(source, />英文歌曲</);
  assert.doesNotMatch(source, />指定风格</);
  assert.doesNotMatch(source, />指定歌手</);
  assert.match(source, /完成选歌并生成口播/);
  assert.match(source, /onUndo/);
  assert.doesNotMatch(source, /onRedo/);
  assert.doesNotMatch(source, />重做</);
});
