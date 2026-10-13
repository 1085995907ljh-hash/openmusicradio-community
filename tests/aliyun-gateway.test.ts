import assert from "node:assert/strict";
import test from "node:test";
import { handleEvent } from "../aliyun/fc-gateway/src/index.js";

const previous = {
  apiKey: process.env.DASHSCOPE_API_KEY,
  authSecret: process.env.AUTH_SECRET,
  inviteCodes: process.env.INVITE_CODES,
  baseUrl: process.env.DASHSCOPE_BASE_URL,
  redisUrl: process.env.UPSTASH_REDIS_REST_URL,
  redisToken: process.env.UPSTASH_REDIS_REST_TOKEN,
};

function configure() {
  process.env.DASHSCOPE_API_KEY = "bailian-test-key";
  process.env.AUTH_SECRET = "a-secret-long-enough-for-tests";
  process.env.INVITE_CODES = "OMR-TEST01";
  process.env.DASHSCOPE_BASE_URL = "https://bailian.test/v1";
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.test";
  process.env.UPSTASH_REDIS_REST_TOKEN = "test-redis-token";
}

test.after(() => {
  for (const [key, value] of Object.entries({ UPSTASH_REDIS_REST_URL: previous.redisUrl, UPSTASH_REDIS_REST_TOKEN: previous.redisToken, DASHSCOPE_API_KEY: previous.apiKey, AUTH_SECRET: previous.authSecret, INVITE_CODES: previous.inviteCodes, DASHSCOPE_BASE_URL: previous.baseUrl })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("Alibaba gateway issues a signed device token and forwards LLM requests to Bailian", async () => {
  configure();
  const claim = await handleEvent({
    httpMethod: "POST",
    path: "/auth/invite/claim",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ inviteCode: "OMR-TEST01", displayName: "测试用户", deviceName: "Test Mac", claimId: "a".repeat(64) }),
  }, async (_input, init) => Response.json({ result: JSON.parse(String(init?.body))[5] }));
  assert.equal(claim.statusCode, 200);
  const claimBody = JSON.parse(claim.body) as { token: string; user: { id: string } };
  assert.match(claimBody.token, /^omr_v1\./);
  assert.ok(claimBody.user.id);

  let forwardedUrl = "";
  let forwardedAuthorization = "";
  const response = await handleEvent({
    httpMethod: "POST",
    path: "/v1/chat/completions",
    headers: { authorization: `Bearer ${claimBody.token}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-flash", messages: [] }),
  }, async (input, init) => {
    forwardedUrl = String(input);
    forwardedAuthorization = new Headers(init?.headers).get("authorization") ?? "";
    return Response.json({ choices: [{ message: { content: "ok" } }] });
  });
  assert.equal(response.statusCode, 200);
  assert.equal(forwardedUrl, "https://bailian.test/v1/chat/completions");
  assert.equal(forwardedAuthorization, "Bearer bailian-test-key");
});

test("Alibaba gateway has no application-owned daily quota and rejects invalid tokens", async () => {
  configure();
  const response = await handleEvent({ httpMethod: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(response.statusCode, 401);
  const health = await handleEvent({ httpMethod: "GET", path: "/health", headers: {} });
  assert.deepEqual(JSON.parse(health.body), { status: "ready" });
});
