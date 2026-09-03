<p align="center">
  <img src="public/brand/openmusicradio-icon-note-headphones.png" width="88" alt="OpenMusicRadio 图标">
</p>

<h1 align="center">OpenMusicRadio</h1>

<p align="center">把自己的音乐账号变成一档有主持人的私人电台。</p>

![OpenMusicRadio 开屏](docs/screenshots/openmusicradio-landing.png)

## 为此刻选一档音乐

OpenMusicRadio 会根据你在 QQ 音乐或网易云音乐里的收藏和听歌习惯，生成一档属于你的音乐节目。

想听熟悉的歌，可以让节目多放一些自己喜欢过的作品。想换换口味，也可以选择多点探索，从符合当前氛围的歌单里找到还没听过的音乐。歌曲会按照整档节目的情绪和节奏重新编排，听起来更像一档完整的电台节目。

你可以按音乐氛围选歌，也可以直接指定喜欢的风格。放松、专注、运动、通勤和派对都有各自的编排方式。

## 六位主持人

节目提供六位拥有不同声音和表达方式的主持人。有人安静细腻，有人清爽直接，也有人更适合热闹、有活力的节目。

主持人会自然地介绍音乐人、歌曲风格、创作背景和经典作品背后的故事。熟悉的歌会简短带过，值得认识的新歌会多讲一点。开启桌面陪伴后，主持人还会以像素角色出现在桌面上，平时安静陪伴，口播时才开口说话。

![节目单与主持人](docs/screenshots/openmusicradio-program.png)

## 安装与启动

社区版目前通过源码运行，支持 macOS 13 及以上系统。开始前需要准备 Node.js、npm 和 uv。桌面像素主持人还需要 Swift 6.1 及以上版本。

打开终端，依次运行下面的命令。

```sh
git clone https://github.com/1085995907ljh-hash/openmusicradio-community.git
cd openmusicradio-community
npm ci
cp .env.example .env.local
npm run dev
```

启动完成后，在浏览器打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)。首次进入需要填写名字和项目方提供的邀请码。验证成功后，页面会出现“下一步，音乐授权”按钮。更完整的环境说明可以查看 [本地运行说明](DEVELOPMENT.md)。

### 让 AI 助手帮你安装

电脑里已经安装 Codex、Claude Code 等可以操作终端的 AI 编程助手时，可以直接把下面这段话发给它：

```text
请在我的 Mac 上安装并启动 OpenMusicRadio。项目地址是
https://github.com/1085995907ljh-hash/openmusicradio-community.git

请先检查 Git、Node.js、npm、uv 和 Swift 是否可用；缺少环境时说明原因并帮我完成安全安装。然后克隆项目，进入项目目录，执行 npm ci，把 .env.example 复制为 .env.local，再执行 npm run dev。请不要让我手动执行你能够代为完成的步骤，不要改动项目源码，也不要索取或展示任何密钥。最后确认本地服务已经正常启动，并告诉我浏览器访问地址；如果失败，请读取实际报错并继续排查。
```

这是首次安装提示词，不是更新命令。安装完成后，仍需在页面填写名字和项目方提供的邀请码，再扫码授权自己的 QQ 音乐或网易云音乐账号。

## 连接自己的音乐账号

邀请码验证完成后，点击“下一步，音乐授权”，再选择 QQ 音乐或网易云音乐。页面会显示登录二维码，请打开手机上的对应音乐 App 扫描，并在手机上确认登录。

这里登录的是使用者自己的音乐账号。OpenMusicRadio 会从这个账号读取收藏、最近播放、历史和歌单，用来生成个人音乐节目。程序不会要求用户输入音乐平台密码，账号授权保存在当前 Mac 上，也可以随时退出或更换账号。

## 开始一档节目

1. 用手机 App 扫码连接自己的 QQ 音乐或网易云音乐账号。
2. 选择节目时长、推荐方式、熟悉程度和主持人。
3. 查看生成的歌单与全部口播，按需要调整歌曲或顺序。
4. 确认后开始播放。

播放过程中可以暂停、切换下一首，也可以把喜欢的歌曲加入音乐平台的“我喜欢”。节目结束后，本次歌单可以保留在音乐账号中，也可以自动删除。

## 隐私

音乐账号授权、听歌画像和节目记录保存在用户自己的 Mac 上。用户无需填写大模型或语音服务密钥，邀请码验证后获得的设备凭证保存在 macOS 钥匙串中。

## 当前状态

OpenMusicRadio 目前是 macOS 测试版本，公开安装包尚未发布。

## 更新源码版本

已经安装过社区版时，在项目目录运行下面的命令。

```sh
npm run update
```

程序会停止旧服务、拉取最新代码、重新安装依赖并启动新版本。请保持终端窗口打开。

如果当前旧版本还没有 `npm run update`，只需执行一次下面三条命令。

```sh
git pull --ff-only
npm ci
npm run restart
```

社区仓库只包含客户端与本地运行所需代码，不包含托管服务、生产密钥和内部设计资料。

## License

[MIT](LICENSE)
