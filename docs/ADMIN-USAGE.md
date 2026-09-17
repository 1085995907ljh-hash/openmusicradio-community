# 百炼网关与邀请码管理

这套工具只用于私有托管服务，不进入公开社区仓库。AI 网关部署在阿里云函数计算，模型和语音请求转发到百炼；百炼密钥只保存在函数计算环境变量中。

## 首次启用

1. 按 [`aliyun/fc-gateway/README.md`](../aliyun/fc-gateway/README.md) 创建函数计算服务和 HTTP 触发器。
2. 设置 `DASHSCOPE_API_KEY`、`ONE_RADIO_AUTH_SECRET` 和 `ONE_RADIO_INVITE_CODES`。
3. 把函数计算输出的 HTTPS 地址写入客户端 `ONE_RADIO_CLOUD_BASE_URL`。

网关只连接百炼的 OpenAI 兼容 LLM 接口和 Qwen TTS 接口。生产 Secret 为 `DASHSCOPE_API_KEY`、可选的 `DASHSCOPE_WORKSPACE_ID`、`ONE_RADIO_AUTH_SECRET` 和管理员使用的 `ONE_RADIO_PROXY_TOKEN`；客户端只保存邀请码换取的签名设备令牌，不保存模型密钥。

## 配置邀请码

```sh
npm run invite:create
```

把邀请码写入 `ONE_RADIO_INVITE_CODES`，多个值用逗号分隔。函数计算网关不维护 Cloudflare D1；需要撤销邀请码时，更新环境变量并重新部署函数。邀请码只用于换取签名设备令牌，客户端后续请求不携带百炼密钥。

## 用量说明

函数计算网关不再维护 Cloudflare D1 用量表，也不设置应用侧按日请求上限。实际用量和限流以百炼、函数计算控制台的账单与监控为准；`usage:report` 只适用于旧 Worker，不要用于新网关。

管理员令牌与 Worker 的 `PROXY_TOKEN` 对应，不要写入仓库、截图或聊天记录。普通用户的设备令牌无法访问管理报表。

## 统计口径

- LLM 非流式响应读取上游返回的 `usage`，兼容 Responses 和 Chat Completions 字段。
- 上游没有返回 usage 时会记为未取得，不估算 token。
- 流式响应保持透传，记为未取得 token。
- CosyVoice 按输入字符计费。一个汉字计两个字符，英文字母、标点和空格各计一个字符。
- 请求失败也会保存，方便区分真实消耗和接口故障。
