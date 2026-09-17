import { randomBytes } from "node:crypto";

if (process.argv[2] !== undefined) throw new Error("邀请码不接受额外参数。");

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const bytes = randomBytes(8);
const suffix = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
const code = `OMR-${suffix}`;
console.log(`邀请码：${code}`);
console.log("\n把下面这一项追加到函数计算环境变量 ONE_RADIO_INVITE_CODES：\n");
console.log(`ONE_RADIO_INVITE_CODES=${code}`);
