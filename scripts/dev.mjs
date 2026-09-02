import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { openSync, closeSync, unlinkSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

const lockPath = join(homedir(), "Library", "Application Support", "OneRadio", "dev.lock");
mkdirSync(join(homedir(), "Library", "Application Support", "OneRadio"), { recursive: true, mode: 0o700 });
let lockFd;
for (let attempt = 0; attempt < 2; attempt += 1) {
  try {
    lockFd = openSync(lockPath, "wx", 0o600);
    writeFileSync(lockFd, String(process.pid), "utf8");
    break;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const ownerPid = Number(readFileSync(lockPath, "utf8").trim());
    try {
      if (Number.isInteger(ownerPid) && ownerPid > 1) process.kill(ownerPid, 0);
      console.log("One Radio 开发服务已经在运行，继续使用 http://127.0.0.1:5173/。");
      process.exit(0);
    } catch {
      unlinkSync(lockPath);
    }
  }
}
if (lockFd === undefined) throw new Error("无法取得 One Radio 开发服务锁。");

const runtimeEnv = Object.fromEntries([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "TZ",
  "XDG_CACHE_HOME",
  "SSL_CERT_FILE",
].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
// GUI-launched processes may expose only the system PATH while uv is installed
// in the user's local bin. Keep this approved runtime PATH intentionally small.
runtimeEnv.PATH = [join(homedir(), ".local", "bin"), "/opt/homebrew/bin", runtimeEnv.PATH]
  .filter(Boolean)
  .join(":");
const localControlToken = process.env.LOCAL_CONTROL_TOKEN ?? randomBytes(32).toString("hex");
const qqSidecarToken = randomBytes(32).toString("base64url");
const neteaseBaseUrl = process.env.NETEASE_API_BASE_URL ?? "http://127.0.0.1:4320";
const neteaseCookieStorePath = process.env.NETEASE_COOKIE_STORE_PATH ?? join(homedir(), "Library", "Application Support", "OneRadio", "netease-cookie");
const qqBaseUrl = process.env.QQMUSIC_API_BASE_URL ?? "http://127.0.0.1:4321";
const qqCredentialPath = process.env.QQMUSIC_CREDENTIAL_PATH ?? join(homedir(), "Library", "Application Support", "OneRadio", "qqmusic-credential.json");
const qqAllowedOrigins = process.env.QQMUSIC_ALLOWED_ORIGINS ?? "http://127.0.0.1:5173,http://localhost:5173";
const neteaseEnv = {
  ...runtimeEnv,
  NETEASE_API_BASE_URL: neteaseBaseUrl,
  NETEASE_COOKIE_STORE_PATH: neteaseCookieStorePath,
};
const qqEnv = {
  ...runtimeEnv,
  QQMUSIC_API_BASE_URL: qqBaseUrl,
  QQMUSIC_CREDENTIAL_PATH: qqCredentialPath,
  QQMUSIC_SIDECAR_TOKEN: qqSidecarToken,
  QQMUSIC_ALLOWED_ORIGINS: qqAllowedOrigins,
  QQMUSIC_LOG_LEVEL: "WARNING",
};
const serverEnv = {
  ...process.env,
  LOCAL_CONTROL_TOKEN: localControlToken,
  NETEASE_API_BASE_URL: neteaseBaseUrl,
  NETEASE_COOKIE_STORE_PATH: neteaseCookieStorePath,
  QQMUSIC_API_BASE_URL: qqBaseUrl,
  QQMUSIC_SIDECAR_TOKEN: qqSidecarToken,
  ONE_RADIO_PET_PREFERENCES_SUITE: "dev.openmusicradio.desktop-pet",
  ONE_RADIO_PET_BINARY: join(process.cwd(), "native", "OneRadioPet", ".build", "release", "OneRadioPet"),
  ONE_RADIO_PET_ASSETS: join(process.cwd(), "public", "hosts"),
};
const webEnv = {
  ...process.env,
  LOCAL_CONTROL_TOKEN: localControlToken,
};

const children = new Set();
let stopping = false;

const startChild = (script, env) => {
  const launch = () => {
    if (stopping) return;
    const child = spawn("npm", ["run", script], { stdio: "inherit", env });
    children.add(child);
    child.once("exit", () => {
      children.delete(child);
      if (!stopping) setTimeout(launch, 1_000);
    });
  };
  launch();
};

startChild("dev:netease", neteaseEnv);
startChild("dev:qqmusic", qqEnv);

const stop = () => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  try { if (lockFd !== undefined) closeSync(lockFd); } catch {}
  try { unlinkSync(lockPath); } catch {}
  setTimeout(() => process.exit(0), 2_000).unref();
};

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const shutdown = new Promise((resolve) => {
  process.once("SIGINT", resolve);
  process.once("SIGTERM", resolve);
});

const waitForNetease = async () => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${neteaseEnv.NETEASE_API_BASE_URL}/login/status`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // The companion may need a few seconds to register its anonymous session.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};

const waitForQqMusic = async () => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${qqEnv.QQMUSIC_API_BASE_URL}/health`, {
        headers: { "x-one-radio-qq-token": qqSidecarToken },
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // The Python SDK sidecar may need a few seconds to start.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};

await waitForNetease();
await waitForQqMusic();
const petBuild = spawnSync("swift", ["build", "-c", "release", "--package-path", "native/OneRadioPet"], {
  cwd: process.cwd(),
  env: runtimeEnv,
  stdio: "inherit",
});
if (petBuild.status !== 0) console.warn("One Radio 桌面陪伴构建失败，网页电台仍会继续启动。");
startChild("dev:server", serverEnv);
startChild("dev:web", webEnv);

await shutdown;
