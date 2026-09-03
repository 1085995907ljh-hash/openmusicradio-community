import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("restart stops only the dev supervisor named by the scoped lock", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "one-radio-restart-test-"));
  const fakeDev = join(directory, "scripts", "dev.mjs");
  const lockPath = join(directory, "dev.lock");
  mkdirSync(dirname(fakeDev), { recursive: true });
  writeFileSync(fakeDev, "setInterval(() => {}, 1000);\n");
  const child = spawn(process.execPath, [fakeDev], { stdio: "ignore" });
  context.after(() => {
    try { process.kill(child.pid!, "SIGKILL"); } catch {}
  });
  writeFileSync(lockPath, JSON.stringify({ pid: child.pid, projectRoot: directory }));
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));

  const stopped = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/restart.mjs", import.meta.url)), "--stop-only"], {
    env: { ...process.env, ONE_RADIO_DEV_LOCK_PATH: lockPath },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.stdout, /旧 One Radio 服务已停止/);
  const state = spawnSync("/bin/ps", ["-p", String(child.pid), "-o", "stat="], { encoding: "utf8" }).stdout.trim();
  assert.ok(!state || state.startsWith("Z"), `expected stopped process, got ${state}`);
});

test("update command is conservative and restart guidance replaces silent reuse", () => {
  const devSource = readFileSync(new URL("../scripts/dev.mjs", import.meta.url), "utf8");
  const updateSource = readFileSync(new URL("../scripts/update.mjs", import.meta.url), "utf8");
  assert.match(devSource, /npm run restart/);
  assert.match(updateSource, /--ff-only/);
  assert.match(updateSource, /npm", \["ci"\]/);
  assert.match(updateSource, /ONE_RADIO_UPDATE_NO_START/);
  assert.doesNotMatch(updateSource, /reset --hard|checkout --|clean -f/);
});
