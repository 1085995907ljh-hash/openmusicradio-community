# 本地运行

OpenMusicRadio 社区版面向 macOS 13 及以上系统。

## 环境

- Node.js 20.19 及以上版本，或 22.12 及以上版本
- npm
- uv
- Swift 6.1 及以上版本，仅用于编译桌面主持人

## 启动

```sh
git clone https://github.com/1085995907ljh-hash/openmusicradio-community.git
cd openmusicradio-community
npm ci
cp .env.example .env.local
npm run dev
```

浏览器打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)。首次使用时，在设置页填写自己的兼容服务配置。密钥保存在当前 Mac 的钥匙串中，不会写入仓库或浏览器存储。

## 检查

```sh
npm run check
```

社区仓库不包含 OpenMusicRadio 的托管代理、邀请码数据库、生产凭据和内部开发资料。
