# dsh-notify · 通用主动推送

把「事情办完了」主动推给 master，不用等他问。

## 推送去哪（master 2026-11-27 定：**在哪问的就在哪回**）

1. 事件带发起会话 → `agent.followup()` 直接投回那条会话（面板就回面板，微信就回微信，QQ 就回 QQ）。
2. 没有发起会话（比如鱼世界自己跑的日常）→ 兜底发 master 微信私聊。
3. 要把环境事件也投进某条会话，就在配置里写 `fallbackChannel: "session"` 加 `fallbackSession`。

## 来源

| 来源 | 怎么进来 |
| --- | --- |
| 鱼世界 | 每 `intervalMin` 分钟拉 `GET https://api.yuyuworld.app/v1/notify?cursor=...`，游标防重复 |
| 收件箱 | 往 `<工作区>/.notify-outbox/` 丢 `{"text":"...","source":"job","session":"可选会话id"}.json`，推完自动归档到 `done/` |
| 工具 | `notify` 工具 `action=push`：模型或子代理跑完自己推一条，自动带上当前会话 id |
| 每日新闻 | 每天 `newsAt`（默认 08:30）自动推一份：当天要闻 3–5 条 + 专讲 AI / DeepSeek / DeepSeek Harness 一节（至少 3 条），每条带一句话说明和来源链接；当天推过不再推，`notify action=news` 可手动补推 |
| 挂账提醒 | 每天 `staleAt`（默认 09:00）查一次：工单「待处理」、任务「进行中/待办」超过 `staleHours`（默认 24 小时）没动就推一条，同一天只推一次；没有挂着的活不推。`notify action=stale` 手动跑一次 |

## 早报末尾多两节（2026-11-27 master 定）

每天那份今日新闻末尾会接上：

1. **今天接着干的**（`digestBacklog`，默认开，最多 `digestBacklogMax`=5 条）
   - 从 `shared/任务.md` 抽「进行中 / 待办 / 卡住」的行（表格行和「状态：」的列表行都认），每条压成一句话（≤40 字，不贴整行）；
   - 从 `shared/接续.md` 的「没完的」抽最近 3 条，按前 8 个字去重；
   - 整段不超过原新闻的 **1/3**，超了砍条数；一条都没有就写「今天没有挂着的活」。
2. **插件体检**（`digestHealth`，默认开，就一行）
   - 扫 `~/.dsh/plugins/<名>/`：有没有入口文件（package.json 的 `main` → `index.js` → `lib/index.js`）、能不能 `import()` 成功；
   - 再扫 `~/.dsh/profiles/<档>/node_modules/dsh-*`：装进 profile 的有没有对应目录和入口；
   - 全活就一行「插件 N 个都在｜profile desktop 13 个都在」；挂了点名 + 一句话原因（报错里的整条路径会换成 `<路径>`）。
   - **不造假红灯**：依赖找不到（裸包名，包其实在 profile 里）只记默认日志、不算挂；`main` 指 `lib/index.js` 的包也算活。

## 挂账检查（`staleCheck`，默认开）

- **工单**：`shared/工单.md` 里状态含「待处理」、日期超过 24 小时的，最多列 5 单（日期 · 房间 · 客户 · 问题 · 挂几天）。
- **任务**：`shared/任务.md` 里「进行中 / 待办」、日期超过 24 小时、且最近 24 小时没在 `shared/接续.md` 或 `shared/历史/<当月>.md` 里出现过的，最多列 `staleMaxTasks`（默认 5）条。
  - 「没动过」的判定：取任务摘要里 ≥4 字的中文/字母段当关键词，在「接续.md 全文 + 历史里最近 24 小时的行」里搜；任一个词出现过就算有动静（宁可少报，不造假红灯）。
  - 「到期/约定」写「长期」的常态活不算挂住。
- 推送排在早报之后，同一天只推一次（`state/notify.json` 的 `lastStaleDay` 记着）。


**凡是可能有后续的事都要推**：长活跑完、子代理回来、后台任务完事、定时任务出结果、插件例行跑完——都推一条短结论回原会话。

### 新闻源（本机实测可达）

- 要闻：IT之家 RSS、Solidot RSS、少数派 RSS
- AI：量子位 RSS、The Decoder RSS、TechCrunch/Ars Technica 里含 AI 的条目、GitHub `deepseek-ai` 仓库近 14 天发版、Hacker News 近 5 天 DeepSeek/AI 帖
- 全是公开源，不需要 key；某个源挂了只少几条，不影响整体

### 排版（master 2026-11-27 定）

- 每条独占一行，以「• 」开头：`• 序号 标题（≤30 字，超了截断加…）｜一句人话｜来源站名`
- 清掉「查看全文」「消息源 @xxx」「责任编辑」这类尾巴和 HTML 残留
- 要闻 3–5 条、AI 一节 3–5 条（DeepSeek / DSH 优先，中文源优先）
- 完整链接统一放最后的「链接」块，按序号列，不嵌在正文里
- 整条 ≤600 字（`newsMaxChars`）：超了先砍条数，还超就先丢说明、再把超长链接的条目往后排

## 配置：`<工作区>/.notify-config.json`

```json
{
  "enabled": true,
  "intervalMin": 10,
  "sources": { "yuyu": true, "inbox": true, "news": true },
  "preferSession": true,
  "fallbackChannel": "wechat",
  "fallbackSession": "",
  "newsAt": "08:30",
  "newsChannel": "session",
  "newsMaxGeneral": 5,
  "newsMaxAi": 5,
  "newsMaxChars": 2500,
  "digestBacklog": true,
  "digestBacklogMax": 5,
  "digestHealth": true,
  "staleCheck": true,
  "staleAt": "09:00",
  "staleHours": 24,
  "staleMaxTasks": 5,
  "maxPerTick": 8,
  "maxChars": 1200,
  "maxRetry": 5
}
```

四个新开关（都默认开，写 `false` 就关；改完下一轮生效，不用重启）：

| 配置项 | 默认 | 作用 |
| --- | --- | --- |
| `digestBacklog` | `true` | 早报末尾加「今天接着干的」 |
| `digestBacklogMax` | `5` | 那一节最多几条 |
| `digestHealth` | `true` | 早报末尾加插件体检一行 |
| `staleCheck` | `true` | 每天查一次工单/任务挂账 |
| `staleAt` | `"09:00"` | 挂账检查几点跑（`HH:mm`） |
| `staleHours` | `24` | 多久没动算挂住 |
| `staleMaxTasks` | `5` | 任务那节最多列几条 |

- **关掉**：把 `enabled` 写 `false`；或者写 `<工作区>/.yuyu-notify.json` `{"enabled":false}`（兼容老开关，只认 enabled）。
- 也可以用 `notify` 工具 `action=off`。

## `notify` 工具的 action

| action | 干什么 |
| --- | --- |
| `push` | 推一条（`text` 必填，`session` 可选） |
| `status` | 看开关 / 来源 / 累计 / 待重试 / 新功能状态 |
| `on` / `off` | 开或关整条推送 |
| `news` | 立刻推一份今日新闻（手动补推/验源） |
| `digest` | **只预览**早报附录（今天接着干的 + 插件体检），不推送 |
| `stale` | 立刻跑一次挂账检查并推送 |
| `health` | 立刻体检一次插件，只返回结果不推送 |


## 状态：`<工作区>/state/notify.json`

`yuyuCursor` 游标、`sentKeys` 去重、`pending` 待重试、`sessions` 最近活跃会话、`stats` 统计。
重启从状态文件继续，不会重复推。日志在 `state/notify.log`，token 一律脱敏。

## 装法

复制到 `<profile>/node_modules/dsh-notify`，再在 profile 的 `cordis.patch.yml` 的 `insert` 列表加：

```yaml
    - id: notify
      name: 'dsh-notify'
```

改完要重启 DSH 才生效。

## 已知限制

- 只能投到「本 DSH 里存在的会话」和 master 的微信私聊；投不进（会话已关）就退回微信，微信也投不进就进重试队列。
- 会话注入是 `followup`，会像一条新消息进会话，模型可能会接着回一句。
- 微信兜底复用工作区 `wxlib.mjs` + `.credentials.yaml` 的 bot token，token 过期需要重新扫码登录微信桥。
- 后台 job 完成没有通用 hook：要靠任务自己往收件箱丢一条，或跑完调 `notify` 工具。
- 新闻是公开 RSS/API 聚合，不生成评论；源里没有 DeepSeek/DSH 新消息时会明说「今天没看到」，不编。
- 早报附录里「接续.md 的没完的」是聊天原文摘的，只能取最近 3 条、截 40 字，不会替你判断哪条才是真要紧的。
- 挂账检查靠 `任务.md` 的日期列和摘要关键词判断「有没有动过」；日期没写、或摘要里挤不出 ≥4 字的词的任务会跳过（不瞎报）。
- 插件体检是真的把每个插件的入口 `import()` 一遍；同一个进程里每个插件只 import 一次，只读不改，失败只记日志。
