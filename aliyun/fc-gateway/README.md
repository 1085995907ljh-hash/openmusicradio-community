# Alibaba Function Compute gateway

Vercel migration configuration is also available in this directory. See
[`docs/VERCEL-GATEWAY.md`](../../docs/VERCEL-GATEWAY.md) for deployment variables,
validation, and rollback. This Mac now uses the Vercel gateway. The old Alibaba
FC function is disabled; Bailian and Qwen TTS remain in use.

This function replaces the retired Cloudflare Worker. It keeps the client
contract used by OpenMusicRadio, but forwards both LLM and Qwen TTS requests
to Alibaba Bailian. The Bailian API key never enters the desktop application.

## Deploy

Install Serverless Devs and log in with an Alibaba Cloud account that can
create Function Compute functions. From this directory, set the following
environment variables and run `npm run deploy:aliyun-gateway` from the project
root:

```sh
export ALIYUN_REGION=cn-hangzhou
export ALIYUN_FC_SERVICE=openmusicradio
export ALIYUN_FC_FUNCTION=ai-gateway
export DASHSCOPE_API_KEY='你的百炼 API Key'
export ONE_RADIO_AUTH_SECRET='至少 32 位随机字符串'
export ONE_RADIO_INVITE_CODES='OMR-XXXXXXXX,OMR-YYYYYYYY'
export UPSTASH_REDIS_REST_URL='https://YOUR-DATABASE.upstash.io'
export UPSTASH_REDIS_REST_TOKEN='server-side Redis REST token'
# Optional: use a currently enabled Bailian model in the desktop .env.local.
# ONE_RADIO_MANAGED_LLM_MODEL=deepseek-v4.1-flash
npm run deploy:aliyun-gateway
```

The deployment output contains an HTTPS HTTP-trigger endpoint. Put that URL in
the desktop `.env.local` as `ONE_RADIO_CLOUD_BASE_URL`. The desktop client will
still ask for an invitation code once and store only a signed device token in
the macOS Keychain.

Invitation redemption now requires persistent Redis storage. Each code can
activate one installation. An atomic Redis Lua script stores the original
credential and a hashed installation receipt; retries by that installation
return the same credential. Other installations receive HTTP 409. Storage
failures return HTTP 503 without issuing an untracked credential. Do not set
an expiry, enable eviction, or delete redemption records. See
[`docs/INVITATION-REDEMPTION.md`](../../docs/INVITATION-REDEMPTION.md) before rollout.

`ONE_RADIO_PROXY_TOKEN` is optional and is intended for administrative health
checks. `DASHSCOPE_WORKSPACE_ID` and `DASHSCOPE_TTS_BASE_URL` are optional; set
them when using a Bailian workspace or a regional TTS endpoint. The gateway has
no application-owned daily request quota. Bailian and Function Compute account
limits, billing, and upstream throttling still apply.
