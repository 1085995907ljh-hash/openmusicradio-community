import { createHash } from "node:crypto";

// No expiry: deleting a redemption record would make a consumed code usable again.
export const CLAIM_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if existing then
  local record = cjson.decode(existing)
  if record.claimHash == ARGV[1] then return record.token end
  return false
end
redis.call('SET', KEYS[1], cjson.encode({claimHash = ARGV[1], token = ARGV[2]}))
return ARGV[2]
`;

const hash = (value) => createHash("sha256").update(value).digest("hex");

export async function redeemInvitation(inviteCode, claimId, token, fetchImpl) {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim() || process.env.KV_REST_API_URL?.trim();
  const secret = process.env.UPSTASH_REDIS_REST_TOKEN?.trim() || process.env.KV_REST_API_TOKEN?.trim();
  if (!url || !secret || new URL(url).protocol !== "https:") throw new Error("Invitation storage unavailable");
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(["EVAL", CLAIM_SCRIPT, "1", `openmusicradio:invite:v1:${hash(inviteCode)}`, hash(claimId), token]),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error("Invitation storage unavailable");
  const payload = await response.json();
  if (payload.error || !(payload.result === null || typeof payload.result === "string")) throw new Error("Invalid invitation storage response");
  return payload.result;
}
