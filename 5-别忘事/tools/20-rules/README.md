# rules.mjs · 规则 / 功能 / 插件开关

根页（`SHARED-STATE.md`）里有两块标记：

- `<!-- RULES:BEGIN -->` … `<!-- RULES:END -->` —— 九类规矩，一类一句主句 + 若干条细则（细则缩进跟在主句后面）
- `<!-- PLUGINS:BEGIN -->` … `<!-- PLUGINS:END -->` —— 推荐插件

两块都**不要手改**，由本脚本按 `shared/规则开关.json` 重新生成。

## 用法

```bash
node rules.mjs list                    # 看三组开关 + 根页现在注入了什么
node rules.mjs show                    # 打印注入根页的那两段
node rules.mjs set 省钱=off 语音=on     # 按名字改，一次可多个，三组一起查
node rules.mjs all  [rules|features|plugins]
node rules.mjs none [rules|features|plugins]
```

## 三组开关

| 组 | 内容 |
| --- | --- |
| `rules` | 九类规矩：省钱 / 省时间 / 别弄坏 / 别泄露 / 别忘事 / 能收到 / 会说话 / 会干活 / 会出活 |
| `features` | 八项功能：生图 / 语音 / 消息渠道 / 文档 / 图片编辑 / OCR / 渔世界 / 表情包（只在开关表里，不注入根页） |
| `plugins` | 八个推荐插件，跟着根页 PLUGINS 块走 |

## 摆放

放到工作区根目录（和 `SHARED-STATE.md` 同级），开关文件在 `shared/规则开关.json`。
脚本按自身位置推导工作区根，不写死路径。

## 约定

- 新会话第一次起来先问「要全套还是挑几类」，没选过默认全套
- `list` 只读，不改任何文件
- 改完立刻生效，不用重启
