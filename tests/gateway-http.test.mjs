import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import gateway from "../aliyun/fc-gateway/api/gateway.js";
import { createHmac } from "node:crypto";

test("Vercel rewrites preserve gateway health and protected routes", async () => {
  const health = await gateway.fetch(new Request("https://gateway.test/api/gateway?route=health"));
  assert.equal(health.status, 200);
  const denied = await gateway.fetch(new Request("https://gateway.test/api/gateway?route=v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  }));
  assert.equal(denied.status, 401);
  const direct = await gateway.fetch(new Request("https://gateway.test/health"));
  assert.equal(direct.status, 200);
});

test("gateway HTTP entry supports health, invitation, session and rejects unauthorized model calls", async () => {
  const names = ["PORT", "DASHSCOPE_API_KEY", "AUTH_SECRET", "INVITE_CODES", "UPSTASH_REDIS_REST_URL"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    PORT: "0",
    DASHSCOPE_API_KEY: "test-key",
    AUTH_SECRET: "test-secret-for-http-gateway-validation",
    INVITE_CODES: "OMR-HTTPTEST",
  });
  let server;
  delete process.env.UPSTASH_REDIS_REST_URL;
  try {
    ({ default: server } = await import("../aliyun/fc-gateway/server.js"));
    if (!server.listening) await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ready" });
    const unauthorized = await fetch(`${base}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    assert.equal(unauthorized.status, 401);
    const claim = await fetch(`${base}/auth/invite/claim`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ inviteCode: "OMR-HTTPTEST", displayName: "Test", deviceName: "Test Mac", claimId: "a".repeat(64) }),
    });
    assert.equal(claim.status, 503);
    assert.equal((await claim.json()).error.type, "invitation_storage_unavailable");
    // Previously issued device tokens continue working even if redemption storage is down.
    const payload = Buffer.from(JSON.stringify({ v: 1, userId: "legacy-user", deviceId: "legacy-device", issuedAt: Date.now() })).toString("base64url");
    const token = `omr_v1.${payload}.${createHmac("sha256", process.env.AUTH_SECRET).update(payload).digest("base64url")}`;
    const session = await fetch(`${base}/auth/session`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(session.status, 200);
    assert.equal((await session.json()).user.id, "legacy-user");
  } finally {
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
