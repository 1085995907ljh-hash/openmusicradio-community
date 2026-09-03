import { execFileSync, spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(process.cwd());
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, stdio: "inherit", ...options });
const output = (command, args) => execFileSync(command, args, { cwd: root, encoding: "utf8" }).trim();

if (output("git", ["status", "--porcelain", "--untracked-files=no"])) {
  throw new Error("检测到尚未提交的代码修改。为避免覆盖文件，本次更新已停止。");
}
const upstream = output("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
run("git", ["fetch", "--prune"]);
try {
  run("git", ["merge-base", "--is-ancestor", "HEAD", upstream], { stdio: "ignore" });
} catch {
  throw new Error("本地分支与远端版本已经分叉，无法自动更新。请保留终端输出并联系项目维护者。");
}

run(process.execPath, ["scripts/restart.mjs", "--stop-only"]);
run("git", ["merge", "--ff-only", upstream]);
run("npm", ["ci"]);
if (process.env.ONE_RADIO_UPDATE_NO_START === "1") {
  console.log("更新完成。已按检查模式跳过启动。");
  process.exit(0);
}
console.log("更新完成，正在启动新版本。请保持此终端窗口打开。");
const child = spawn("npm", ["run", "dev"], { cwd: root, env: process.env, stdio: "inherit" });
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
