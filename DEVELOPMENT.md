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

复制配置文件后，需要在 `.env.local` 的 `ONE_RADIO_CLOUD_BASE_URL` 中填写项目方提供的托管服务地址。浏览器打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)。

## 验证邀请

1. 填写自己的名字。
2. 输入项目方提供的邀请码。
3. 点击“验证邀请码”。
4. 验证成功后，点击“下一步，音乐授权”。

## 连接音乐平台

1. 完成邀请验证后，进入“音乐授权”。
2. 选择 QQ 音乐或网易云音乐。
3. 等待页面生成登录二维码。
4. 打开手机上的对应音乐 App 扫描二维码。
5. 在手机上确认登录，网页显示“已连接”后即可进入节目设置。

扫码登录使用的是运行者自己的音乐账号。程序不会收集账号密码，音乐平台授权只保存在当前 Mac。需要切换账号时，可以在本机设置中退出当前授权后重新扫码。

## 检查

```sh
npm run check
```

## 更新

以后更新社区版时运行 `npm run update`。它会先确认本地代码没有未提交修改，再停止旧服务、快进到远端最新版本、安装锁定依赖并重新启动。

从不包含更新命令的旧版本升级时，依次执行 `git pull --ff-only`、`npm ci` 和 `npm run restart`。重新克隆到另一个目录不能替代重启，因为旧目录里的服务可能仍在占用本机端口。

社区仓库不包含 OpenMusicRadio 的托管代理、邀请码数据库、生产凭据和内部开发资料。
