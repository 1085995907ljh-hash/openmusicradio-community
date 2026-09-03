import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const lockPath = process.env.ONE_RADIO_DEV_LOCK_PATH?.trim()
  || join(homedir(), "Library", "Application Support", "OneRadio", "dev.lock");
const stopOnly = process.argv.includes("--stop-only");

function lockOwnerPid() {
  if (!existsSync(lockPath)) return null;
  const raw = readFileSync(lockPath, "utf8").trim();
  try {
    const value = JSON.parse(raw);
    const pid = typeof value === "number" ? value : Number(value?.pid);
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  } catch {
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  }
}

function processCommand(pid) {
  try {
    return execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    const state = execFileSync("/bin/ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" }).trim();
    return Boolean(state) && !state.startsWith("Z");
  } catch {
    return false;
  }
}

async function stopCurrentService() {
  const pid = lockOwnerPid();
  if (!pid || !isRunning(pid)) {
    if (existsSync(lockPath)) unlinkSync(lockPath);
    return;
  }
  const command = processCommand(pid);
  if (!/(?:^|\s)\S*node(?:\s|$).*scripts\/dev\.mjs(?:\s|$)/.test(command)) {
    throw new Error(`拒绝停止无法确认身份的进程 ${pid}。请手动关闭旧终端后重试。`);
  }
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 8_000;
  while (isRunning(pid) && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  if (isRunning(pid)) throw new Error(`旧服务进程 ${pid} 未能正常退出，请关闭旧终端后重试。`);
  if (existsSync(lockPath)) unlinkSync(lockPath);
}

await stopCurrentService();
if (stopOnly) {
  console.log("旧 One Radio 服务已停止。");
} else {
  console.log("正在启动当前版本，请保持此终端窗口打开。");
  const child = spawn("npm", ["run", "dev"], { cwd: resolve(process.cwd()), env: process.env, stdio: "inherit" });
  child.once("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}
