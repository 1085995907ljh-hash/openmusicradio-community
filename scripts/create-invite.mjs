import { randomBytes } from "node:crypto";

if (process.argv[2] !== undefined) throw new Error("邀请码不接受额外参数。");

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const bytes = randomBytes(8);
const suffix = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
const code = `OMR-${suffix}`;
console.log(`邀请码：${code}`);
console.log("\n把下面的值追加到 Vercel 网关的 INVITE_CODES（逗号分隔，不覆盖已有值）：\n");
console.log(code);
console.log("\n需要已配置持久化核销存储；生成本身不会启用邀请码。旧函数计算部署对应 ONE_RADIO_INVITE_CODES。");
