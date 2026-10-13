import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { handleEvent } from "../aliyun/fc-gateway/src/index.js";
import { CLAIM_SCRIPT } from "../aliyun/fc-gateway/src/invitation-store.js";

test("redemption survives retries and rejects a second installation", async (t) => {
  const env = { AUTH_SECRET: "test-invitation-secret", INVITE_CODES: "OMR-ONCE01", UPSTASH_REDIS_REST_URL: "https://redis.test", UPSTASH_REDIS_REST_TOKEN: "test-only" };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  // REST contract double; the real Redis Lua script also needs deployment verification.
  const records = new Map();
  const storage = async (url, init) => {
    assert.equal(url, "https://redis.test");
    const [command, script, keyCount, key, claimHash, token] = JSON.parse(init.body);
    assert.equal(command, "EVAL");
    assert.equal(script, CLAIM_SCRIPT);
    assert.equal(keyCount, "1");
    assert.ok(!key.includes("OMR-ONCE01"));
    const stored = records.get(key);
    if (stored) return Response.json({ result: stored.claimHash === claimHash ? stored.token : null });
    records.set(key, { claimHash, token });
    return Response.json({ result: token });
  };
  const claim = (id, fetchImpl = storage, extra = {}) => handleEvent({ httpMethod: "POST", path: "/auth/invite/claim", body: JSON.stringify({ inviteCode: "OMR-ONCE01", displayName: "First", deviceName: "Mac", claimId: id, ...extra }) }, fetchImpl);
  const ids = Array.from({ length: 50 }, () => randomBytes(32).toString("hex"));
  const results = await Promise.all(ids.map((id) => claim(id)));
  assert.equal(results.filter((r) => r.statusCode === 200).length, 1);
  assert.equal(results.filter((r) => r.statusCode === 409).length, 49);
  const winner = results.findIndex((r) => r.statusCode === 200);
  const retry = await claim(ids[winner], storage, { displayName: "Changed", deviceName: "Renamed" });
  assert.deepEqual(JSON.parse(retry.body), JSON.parse(results[winner].body));
  assert.equal(records.size, 1);

  records.clear();
  const lost = await claim(ids[0], async (...args) => { await storage(...args); throw new Error("Response lost"); });
  assert.equal(lost.statusCode, 503);
  const recovered = await claim(ids[0]);
  assert.equal(recovered.statusCode, 200);
  assert.equal(JSON.parse(recovered.body).token, [...records.values()][0].token);
  assert.equal((await claim(ids[1])).statusCode, 409);
  assert.equal((await claim(undefined)).statusCode, 400);
  assert.equal((await claim(ids[0], storage, { inviteCode: "OMR-INVALID" })).statusCode, 401);
  assert.equal((await claim(ids[0], async () => Response.json({ error: "failure" }))).statusCode, 503);
  delete process.env.UPSTASH_REDIS_REST_URL;
  assert.equal((await claim(ids[0])).statusCode, 503);
});
