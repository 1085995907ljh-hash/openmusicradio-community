# 邀请码单次核销

一个邀请码激活一个安装实例；同一安装重试返回原凭证。另一个安装兑换返回 409，存储不可用返回 503。已有设备凭证继续有效。

服务端配置持久化 Upstash Redis：`UPSTASH_REDIS_REST_URL` 和 `UPSTASH_REDIS_REST_TOKEN`，或 Vercel 集成提供的 `KV_REST_API_URL` 和 `KV_REST_API_TOKEN`。选择 Free 时关闭自动升级和 eviction，不为核销记录设置 TTL。密钥仅保存于服务端。

客户端保留权限为 0600 的 `.activation-secret`，用于网络失败后的幂等重试。它是安装凭据，不是硬件绑定；复制凭据可能转移授权。删除后需新邀请码。

升级时保留 AUTH_SECRET 并替换以前可重复使用的邀请码名单。移除邀请码不会撤销已签发令牌。数据库丢失时停用旧名单，不得以空账本重新开放旧邀请码。
