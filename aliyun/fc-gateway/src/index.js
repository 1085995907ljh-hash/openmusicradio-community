import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const LLM_ROUTES = new Map([
  ["POST /v1/chat/completions", "/chat/completions"],
  ["POST /v1/responses", "/responses"],
  ["GET /v1/models", "/models"],
]);
const QWEN_ROUTES = new Map([
  ["POST /qwen/api/v1/services/audio/tts/SpeechSynthesizer", "/services/audio/tts/SpeechSynthesizer"],
  ["POST /qwen/api/v1/services/aigc/multimodal-generation/generation", "/services/aigc/multimodal-generation/generation"],
]);

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
    body: JSON.stringify(payload),
  };
}

function errorResponse(statusCode, message, type = "proxy_error") {
  return jsonResponse(statusCode, { error: { message, type } });
}

function header(headers, name) {
  if (!headers || typeof headers !== "object") return "";
  const wanted = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === wanted);
  return typeof entry?.[1] === "string" ? entry[1] : "";
}

function bearerToken(headers) {
  const authorization = header(headers, "authorization");
  return authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function configured(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function constantTimeEqual(left, right) {
  if (!left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sign(payload, secret) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function inviteCodes() {
  return new Set((process.env.INVITE_CODES ?? "").split(/[\s,]+/).map((code) => code.trim().toUpperCase()).filter(Boolean));
}

function issueDeviceToken(displayName, deviceName) {
  const payload = base64url(JSON.stringify({
    v: 1,
    userId: randomUUID(),
    deviceId: randomUUID(),
    displayName,
    deviceName,
    issuedAt: Date.now(),
  }));
  return `omr_v1.${payload}.${sign(payload, process.env.AUTH_SECRET.trim())}`;
}

function verifyDeviceToken(token) {
  const secret = process.env.AUTH_SECRET?.trim();
  if (!secret || !token.startsWith("omr_v1.")) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || !constantTimeEqual(parts[2], sign(parts[1], secret))) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (payload.v !== 1 || typeof payload.userId !== "string" || typeof payload.deviceId !== "string") return null;
    if (!Number.isFinite(payload.issuedAt) || Date.now() - payload.issuedAt > 365 * 24 * 60 * 60 * 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

function authenticate(headers) {
  const token = bearerToken(headers);
  if (!token) return null;
  if (configured(process.env.PROXY_TOKEN) && constantTimeEqual(token, process.env.PROXY_TOKEN.trim())) {
    return { userId: "admin", deviceId: "admin", admin: true };
  }
  const payload = verifyDeviceToken(token);
  return payload ? { ...payload, admin: false } : null;
}

function decodeEventBody(event) {
  if (typeof event?.body !== "string") return Buffer.alloc(0);
  const body = event.isBase64Encoded ? Buffer.from(event.body, "base64") : Buffer.from(event.body);
  return body.length <= MAX_BODY_BYTES ? body : null;
}

function dashscopeTtsBaseUrl() {
  const configuredBase = process.env.DASHSCOPE_TTS_BASE_URL?.trim();
  if (configuredBase) return configuredBase.replace(/\/$/, "");
  const workspace = process.env.DASHSCOPE_WORKSPACE_ID?.trim();
  return workspace
    ? `https://${workspace}.cn-beijing.maas.aliyuncs.com/api/v1`
    : "https://dashscope.aliyuncs.com/api/v1";
}

function requestJson(body) {
  if (!body || body.length === 0) return {};
  try { return JSON.parse(body.toString("utf8")); } catch { return null; }
}

async function claimInvitation(event) {
  const body = requestJson(decodeEventBody(event));
  const inviteCode = typeof body?.inviteCode === "string" ? body.inviteCode.trim().toUpperCase() : "";
  const displayName = typeof body?.displayName === "string" ? body.displayName.trim() : "";
  const deviceName = typeof body?.deviceName === "string" ? body.deviceName.trim() : "";
  if (!/^[A-Z0-9-]{6,40}$/.test(inviteCode) || !displayName || displayName.length > 40 || !deviceName || deviceName.length > 80) {
    return errorResponse(400, "Invitation code, name, or device name is invalid", "invalid_request_error");
  }
  if (!inviteCodes().has(inviteCode)) return errorResponse(401, "Invitation code is invalid", "invitation_error");
  if (!configured(process.env.AUTH_SECRET)) return errorResponse(503, "Alibaba gateway authentication is not configured", "configuration_error");
  const token = issueDeviceToken(displayName, deviceName);
  const identity = verifyDeviceToken(token);
  return jsonResponse(200, {
    token,
    user: { id: identity.userId, displayName },
    device: { id: identity.deviceId, name: deviceName },
  });
}

async function forward(event, routeKey, upstreamPath, fetchImpl) {
  const body = routeKey.startsWith("POST ") ? decodeEventBody(event) : Buffer.alloc(0);
  if (body === null) return errorResponse(413, "Request body is too large", "invalid_request_error");
  if (routeKey.startsWith("POST ") && !header(event.headers, "content-type").toLowerCase().startsWith("application/json")) {
    return errorResponse(415, "Content-Type must be application/json", "invalid_request_error");
  }
  const isTts = upstreamPath.startsWith("/services/");
  const baseUrl = isTts ? dashscopeTtsBaseUrl() : (process.env.DASHSCOPE_BASE_URL?.trim() || "https://dashscope.aliyuncs.com/compatible-mode/v1");
  const apiKey = process.env.DASHSCOPE_API_KEY?.trim();
  if (!configured(apiKey) || !configured(process.env.AUTH_SECRET) || !baseUrl) return errorResponse(503, "Alibaba Bailian gateway is not configured", "configuration_error");
  const target = `${baseUrl.replace(/\/$/, "")}${upstreamPath}`;
  try {
    const response = await fetchImpl(target, {
      method: routeKey.startsWith("POST ") ? "POST" : "GET",
      headers: {
        accept: header(event.headers, "accept") || "application/json",
        authorization: `Bearer ${apiKey}`,
        ...(isTts && configured(process.env.DASHSCOPE_WORKSPACE_ID) ? { "X-DashScope-WorkSpace": process.env.DASHSCOPE_WORKSPACE_ID.trim() } : {}),
        ...(routeKey.startsWith("POST ") ? { "content-type": "application/json" } : {}),
      },
      ...(routeKey.startsWith("POST ") ? { body } : {}),
    });
    const responseBody = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") || "application/octet-stream";
    return {
      statusCode: response.status,
      headers: { "content-type": contentType, "cache-control": "no-store", "x-content-type-options": "nosniff" },
      body: contentType.toLowerCase().startsWith("audio/") ? responseBody.toString("base64") : responseBody.toString("utf8"),
      ...(contentType.toLowerCase().startsWith("audio/") ? { isBase64Encoded: true } : {}),
    };
  } catch {
    return errorResponse(502, "Bailian upstream request failed", "upstream_error");
  }
}

export async function handleEvent(event, fetchImpl = fetch) {
  if (typeof event === "string") {
    try { event = JSON.parse(event); } catch { return errorResponse(400, "Invalid HTTP event", "invalid_request_error"); }
  }
  const method = String(event?.httpMethod || event?.requestContext?.http?.method || "GET").toUpperCase();
  const rawPath = String(event?.path || event?.requestContext?.http?.path || "/");
  const pathname = new URL(rawPath, "https://fc.local").pathname;
  const headers = event?.headers ?? {};

  if (method === "GET" && pathname === "/health") {
    return jsonResponse(200, { status: configured(process.env.DASHSCOPE_API_KEY) && configured(process.env.AUTH_SECRET) ? "ready" : "unconfigured" });
  }
  if (method === "POST" && pathname === "/auth/invite/claim") return claimInvitation({ ...event, headers });
  if (method === "GET" && pathname === "/auth/session") {
    const identity = authenticate(headers);
    if (!identity) return errorResponse(401, "Device authorization is invalid", "authentication_error");
    return jsonResponse(200, { user: { id: identity.userId, displayName: identity.displayName || "管理员" }, device: { id: identity.deviceId } });
  }

  const routeKey = `${method} ${pathname}`;
  const upstreamPath = LLM_ROUTES.get(routeKey) || QWEN_ROUTES.get(routeKey);
  if (!upstreamPath) return errorResponse(404, "Route not found", "not_found");
  if (!authenticate(headers)) return errorResponse(401, "Invalid gateway token", "authentication_error");
  return forward({ ...event, headers }, routeKey, upstreamPath, fetchImpl);
}

// Serverless Devs' Node.js HTTP trigger accepts this object response shape.
export async function handler(event) {
  return handleEvent(event);
}
