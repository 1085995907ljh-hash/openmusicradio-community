import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("host-script recovery retries automatically without a manual retry button", () => {
  const source = readFileSync(new URL("../src/web/App.tsx", import.meta.url), "utf8");

  assert.match(source, /setTimeout\(\(\) => void regenerateHostScripts\(\), retryDelayMs\)/);
  assert.match(source, /正在自动重试口播/);
  assert.doesNotMatch(source, />重试口播</);
  assert.doesNotMatch(source, />取消重试</);
  assert.doesNotMatch(source, /onRetryHostScripts/);
});
