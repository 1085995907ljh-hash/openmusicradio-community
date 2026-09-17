# 主持人声音配置

六位主持人统一使用 `qwen-audio-3.0-tts-plus`。语速是模型的相对倍率，不是每秒字数；同一主持人的倍率、音调和演绎指令不随音乐氛围、口播位置或正文长度改变。语意中的自然起伏、停顿和重音由完整正文与固定指令共同表达。

| 主持人 | Plus 音色后缀 | 语速 | 固定表达基调 |
| --- | --- | --- | --- |
| 龙浩 | longhuifengyi | 0.98 | 温暖柔和、真诚亲近 |
| 龙小诚 | longchengyiwei | 1.00 | 沉稳清楚、笃定亲切 |
| 龙鑫 | longhexuanlan | 1.05 | 清爽阳光、轻微笑意 |
| 龙安宣 | longhongxiaoxiao | 1.03 | 爽朗自信、热忱有力 |
| 龙安雅 | longchenghongling | 1.00 | 知性从容、温和有兴味 |
| 龙安燃 | longfengxindie | 1.06 | 热情灵动、开心好奇 |

完整音色 ID 使用 `qwen-audio-3.0-tts-plus-` 前缀。来源为[官方音色列表](https://help.aliyun.com/zh/model-studio/qwen-audio-tts-voice-list)及真实合成验证；部分可用音色可能尚未出现在下载版列表中。

`src/shared/program-options.ts` 是音色、语速和固定提示词的唯一配置入口。`hostTtsInstruction` 保留完整短句，不接受大模型生成的变速、情绪切换或时长指令覆盖。Qwen 适配层仅发送一次提示词，不再重复拼接人设、正则提取关键词或截断半个词。音调倍率为 1，保留音色自身特征；音量沿用场景的混音配置。

`targetSeconds` 是编排估算，不用于控制 TTS 语速、添加静音或改变播放速度。短稿自然说完即止，长稿按同样的个人语速表达。

变更声音配置后，重新生成 `public/hosts/previews/` 的六个试听文件和 `public/hosts/cues/duration-reached/` 的六个提示音，并更新这两类 URL 的版本参数，以免浏览器复用旧音频。真实接口返回有效音频可验证音色兼容性；自然度和情感质量仍须通过试听判断，单元测试不能替代听感验收。
