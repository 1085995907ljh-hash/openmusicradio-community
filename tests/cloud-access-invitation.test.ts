import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CloudAccessStore } from "../src/server/cloud-access.js";

test("fresh and legacy-placeholder installs use the managed gateway while custom endpoints are preserved", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "omr-gateway-default-"));
  const previous = process.env.ONE_RADIO_CLOUD_BASE_URL;
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.ONE_RADIO_CLOUD_BASE_URL;
    else process.env.ONE_RADIO_CLOUD_BASE_URL = previous;
  });
  const store = new CloudAccessStore(join(dir, "access.json"));
  for (const value of [undefined, "", "https://<your-function-endpoint>"]) {
    if (value === undefined) delete process.env.ONE_RADIO_CLOUD_BASE_URL;
    else process.env.ONE_RADIO_CLOUD_BASE_URL = value;
    assert.equal(await store.baseUrl(), "https://openmusicradio-gateway.vercel.app");
  }
  process.env.ONE_RADIO_CLOUD_BASE_URL = "https://custom.example/";
  assert.equal(await store.baseUrl(), "https://custom.example");
  process.env.ONE_RADIO_CLOUD_BASE_URL = "not-a-url";
  assert.equal(await store.baseUrl(), "");
});

test("installation receipt persists across retries and concurrent client instances", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "omr-invite-"));
  const previous = process.env.ONE_RADIO_CLOUD_BASE_URL;
  process.env.ONE_RADIO_CLOUD_BASE_URL = "https://gateway.test";
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.ONE_RADIO_CLOUD_BASE_URL;
    else process.env.ONE_RADIO_CLOUD_BASE_URL = previous;
  });
  const receipts: string[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    receipts.push(JSON.parse(String(init?.body)).claimId);
    return Response.json({ error: { message: "邀请码已被其他设备使用，请申请新的邀请码。" } }, { status: 409 });
  };
  const attempt = (file: string, code = "OMR-TEST01") => assert.rejects(new CloudAccessStore(join(dir, file), "unused-test-keychain", fetchImpl).claim(code, "Tester"), /其他设备/);
  await Promise.all(Array.from({ length: 12 }, () => attempt("first.json")));
  assert.equal(new Set(receipts).size, 1);
  assert.match(receipts[0], /^[a-f0-9]{64}$/);
  await attempt("first.json");
  assert.equal(receipts.at(-1), receipts[0]);
  await attempt("second.json");
  assert.notEqual(receipts.at(-1), receipts[0]);
  await attempt("first.json", "OMR-TEST02");
  assert.notEqual(receipts.at(-1), receipts[0]);
  assert.equal((await stat(join(dir, "first.json.activation-secret"))).mode & 0o777, 0o600);
});
