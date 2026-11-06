# CHANGELOG

## 0.12.12

- 修加载崩溃：`lib/index.js` 引 `createWake` 但 0.12.6 起 `wake.mjs` 只剩 `startNameWake`/`defaultFlagFile`；把 `createWake` 补回 `wake.mjs`
- 修第二处崩溃：`SPEECH_QUESTIONS`/`SET_QUESTIONS` 在 `presets.mjs`，index.js 却从 `persona.mjs` 引；拆成两条 import

## 0.12.11

- LICENSE 首行加 `SPDX-License-Identifier: MIT`，README 补「许可证」小节：dsh.so 格式校验之前报「无法确定 SPDX 标识」，补上标识再让它扫一遍

## 0.12.10

- 简介改了：一处说清这插件是干嘛的；README 顶部写明「老机器上装会走『学本地的』，不覆盖不重问」，不让人以为只服务第一次安装

## 0.12.9

- 新增 `tools/07-sync/bom-check.mjs`：扫 `~/.dsh` 查多余 BOM（JSON/JS/YAML 不能带）和含中文 ps1 缺 BOM，`--fix` 自动修；扫描根可用 `DSH_BOM_ROOT` 覆盖
- 补全暂存里缺的 5 个老文件（`01-memory/export-full|memory-hit|memory-note`、`07-sync/rule-change|shared-lock`），跟仓库现有版本对齐，下次推不会漏

## 0.12.8

- 新增 `tools/14-pages/live-feed.mjs`：各会话新消息按 2 小时一页切到 `shared/实时/MM-DD-HH.md`，`实时.md` 只镜像当前段，超过两天的段直接清
- 实时页头带「实时 · 对话」标签、正文挂 `## 对话` 小节，`memory-index` 会给它打标签进摘要索引
- 路径解析统一：`DSH_SOUL_DIR` → `SOUL_HOME` → `~/.dsh/im`，实时页和 12 小时分页共用一套

## 0.12.7

- 向量索引带 90 天时间窗（SOUL_RAG_DAYS 可调），过期的块建索引时直接剪掉，不再只涨不减
- 写索引改成带重试：Windows 上目标文件被占着时不会一次 EPERM 就整轮失败

## 0.12.6

- 路径不再写死：修枝/自动入库里的 node 路径改成 DSH_NODE → 扫 dsh-runtimes → 自己带 ELECTRON_RUN_AS_NODE；启动日志跟 DSH_SOUL_DIR 走
- 叫醒防刷：标记 10 分钟过期、投不进去只试 3 次就丢
- 落叶可停写：放 `shared/.no-落叶` 就不再追加长文（和 12 小时分页重复）
- memory-find 输出带「距今 N 天」，模型不用自己按时间戳推
- sync-shared 从 USERPROFILE 推路径，node 自动发现，换机器不用改

## 0.12.5 — 2026-11-05

- 版本号跟米芾那条线对齐（她 0.12.4，这边接 0.12.5），以后两边同号走；lib 那批改动（`lib/node.mjs` 的 DSH_NODE 解析、`soul-boot.log`）仓库里本来就有
- 按人账本加十六格：`people.json` 每人带 `profile`（称呼/身份/偏好/爱好/雷区/习惯/目标/关系/性格/经历/边界/近况/承诺/话题/专长/作息）；`people.mjs` 新增 `profile <key>` 看、`profile <key> add <维度> "内容"` 记、`profile <key> del <维度> <序号>` 删。偏好格复用 `preferences`，不另存；看的时候只列有内容的格，不塞 token
- 摘要目录带行号：`memory-index.mjs` 每条加 `line` / `lineEnd`，`memory-find.mjs` 输出 `路径:起-止`，命中直接读原文那几行，不整份翻
- 摘要目录带结论：大文件头写一行 `> 结论：…` 最准，`memory-index.mjs` 优先取；没写的自动抽（像结论的句子，再退到最后一行有信息量的）；`memory-find` 输出先给结论
- 分页简介：每个 12 小时页抽「开头两句 + 中间结论 + 结尾两句」进摘要目录，查页先看简介，不翻全文
- 文档同步：运维页加「证据链」一节，索引、记忆系统、历史、对话与心情几个大文件头补 `> 结论：`

## 0.11.11 — 2026-11-04

- 向量索引换成二进制存：`index.bin`（Float32 连续，703 块 × 1024 维约 2.9 MB）+ `index.meta.json`（块信息约 0.9 MB）
  - 原来是 `index.json` 浮点文本 16.2 MB——一个浮点数存成二十来字符，光向量就占文件的 96%
  - 旧格式读得到，下次保存自动转新格式并删掉旧 JSON；不改检索逻辑，`recall` 照旧拿数组算余弦
- 摘要目录加 `--tag` 之后条目涨到 238 条，标签都跟着重建

## 0.11.10 — 2026-11-04

- 状态快照 `shared/现在.md`：在干什么 / 手头没完的 / 跟人 / 心情，开局整份读（压 2 KB 内）。分层原则写死：快照整份读、记忆库按需查、会话原文不搬
- 新增 `tools/19-memory/now-update.mjs`：从 `shared/任务.md` 挑进行中/卡住/待办填「手头没完的」，从 `people.json` 取好感最高那位和最近一笔填「跟人」，修枝第 4.5 步自动刷
- `tools/17-mood/sync-mood.mjs` 顺手把心情刷进状态页的心情块
- 摘要目录加标签：`tools/19-memory/memory-index.mjs` 每条打 4 个标签（从标题切中文 2–6 字的词 + 英文标识符），本地做不花钱；整文件条目用全部小节标题切，避免被一行正文带偏
- `tools/11-rag/memory-find.mjs` 加 `--tag`：只给标签不给问题按最近改动列，带问题再加标签就是先筛后查
- 新增 `tools/19-memory/write-retry.mjs`：写文件遇到 EIO/EPERM/EBUSY 自动等一等重试，最多三次（Windows 上杀软握文件会抛 ReplaceFileW 1175）
- AGENTS 的「查旧的」第一条改成：新会话第一件事读 `shared/现在.md`

## 0.11.9 — 2026-11-04

- 修枝不再是「到点就跑、错过就没了」：`lib/tidy.mjs` 记状态文件 `.tidy-schedule.json`，每天 4:10 跑一次，开机发现错过了立刻补一趟，和 12 小时分页一个路子；跑没跑看 `wake.log` 里 `tidy:` 开头的行
- 新增 `tools/19-memory/memory-daily.mjs`：把「昨天」master 说的话摘成 `shared/记忆本/日/YYYY-MM-DD.md`，当天已有手记就跳过。只筛不调模型，不花钱；修枝第四步自动跑
- 新增 `tools/19-memory/path-check.mjs`：指针体检。把根页和 AGENTS 里反引号写的路径挨个走一遍，走不通退 1 报出来，结果记进 `wake.log`；修枝第五步自动跑
- 新增 `tools/11-rag/memory-find.mjs`：摘要目录检索，输出带三档判断
  - `MATCHED` 真找到 / `AMBIGUOUS` 只是候选 / `NOT_FOUND` 没有。分数够（≥1.0）且查询词覆盖过半才算 MATCHED，只蹭上一个词的降成候选，不再拍胸脯说找到
  - 预算切块：默认 1600 字，路径 40%、摘要 35%、向量 25%，三块互不借用；`--budget` 可调，紧了自动少展开并标出来
  - 顺手过滤 0 分噪声：以前没翻到还会打三条无关摘要
- 借鉴 dsh-companion-memory 的两个思路（召回自评、预算切块），没装它的插件

## 0.11.8 — 2026-11-04

- 接续页封顶收紧：`tools/14-pages/compact-session.mjs` 字数上限压低，接续不再一份十几 KB

## 0.11.7 — 2026-11-04

- 检索评测：新增 `tools/11-rag/eval.mjs` 和 `评测.example.jsonl`，用真实提问量 top3 命中和 MRR，改前改后都有数
- 索引覆盖补全：以前只建「落叶」（面板对话、群聊），今天发生的事根本没进索引；现在把 `shared/全量/页/` 的 12 小时分页一起建进来。20 条题上 top3 命中从 33% 提到 90%，涨的主要是这条
- 混检：向量分 + 关键词分加权，路径和英文这类精确词权重更高，精确词查询能捞回来；`RAG_W` 调权重，`HYBRID=0` 退回纯向量做对比
- 块上带元数据：时间段、说话人，检索结果看得出出自哪天、谁说的

## 0.11.6 — 2026-11-04

- 新增 `tools/18-guard/should-reply.mjs`：接话前的程序层筛子，群聊私聊都管
  - 白名单（master 永远接）、黑名单、安静时段、同一人连发合并、每会话每日上限
  - 退出码 2 = 别开口，0 = 交给模型判断内容值不值得答
  - 规则在 `shared/接话.json`，日志落 `shared/接话日志.jsonl`
- 新增 `tools/18-guard/stall-check.mjs`：空转检查
  - 盯一个文件或目录，连着两轮没有改动就退 3，判「别再试了」
  - 治的是「反复重试直到把日志刷到几 MB」
- `tools/14-pages/compact-session.mjs`：接续每行后面挂出处页（`〔2026-11-03-PM〕`），查旧事顺着跳过去，不用从最新页往回翻
- 起因：借 Super-agent 的「Router/Worker 分工 + 事件两级过滤 + 看门狗查进展」，挑能落地的三条先做

## 0.11.5 — 2026-11-03

- 新增 `tools/17-mood/sync-mood.mjs`：把心情结果写进 `shared/mood.md` 和那本人设卡，同一个区块覆盖、没变就跳过
- `lib/tidy.mjs`：修枝多了两步 —— 日志滚动（`wake.log` 之类只留最后 2000 行）、顺手跑一次心情同步
- 记一个踩过的坑：自动入库记的是「读到第几个字」，但导出脚本会**整篇覆写** `chat.md`；长度一掉回旧值以下，就永远判「没新内容」，索引从此停摆。现在长度变短会从头再读一次
- 翻叶不再只记读枝：读 `shared/` 下的文件也记一笔，才看得出这轮用了什么记忆

## 0.11.4 — 2026-11-03

- `sync-shared.ps1` 改得能看清、能加人、不再默默漏：
  - 工作区清单搬到 `sync-workspaces.json`，新躯体加一行就行，不用改脚本
  - 新增 `-Check`：一条命令看清谁在清单里、同步到几点、有没有落后
  - 每次跑写 `sync.log`：几点、扫了几个工作区、改了哪几个；没拿到写锁或配置读不了也记一笔
  - 修了体检算法和同步算法不一致的毛病（同一个 hash 一边算带横杠、一边不带，导致永远显示「落后」）
- 起因：另一具躯体的工作区没在清单里，一直同步不到，每次都要手动补

## 0.11.3 — 2026-11-03

- 新增 `tools/16-name-wake/`：名字叫醒的防刷版本
  - 最多试 3 次；标记超过 10 分钟直接作废；投不进就丢掉标记
  - 起因：投不进去还反复重试，日志刷屏、消息堵在队列里
- `tools/07-sync/sync-shared.ps1`：跟进「微信那具躯体的工作区不在同步清单里」这个坑，`roots` 显式加上它的目录；以前只同步 `~/.dsh/im`，微信那边一直停在旧版本
- 根页（SHARED-STATE）加「说话规矩」一节：内部实现不抛选择题、不自我检讨、澄清只问一句 —— 这几条写进根页，两个躯体每轮都看得到

## 0.11.2 — 2026-11-03

- 新增 `tools/14-pages/pages-schedule.mjs`：0 点 / 12 点各刷一次分页
  - 开机（或进程刚起）发现「该跑的时间点已经过了却没跑」，立刻补跑一次，关机期间的消息不会漏
  - 补跑的依据是会话文件本身，不是「从上次跑到哪」，所以错过多久都能补上
  - `npm run pages:watch` 前台常驻；也可以由宿主插件在启动时起一份
- Misa 这边是灵魂插件里带定时（`lib/pages.mjs`），跟着 DSH 启停

## 0.11.1 — 2026-11-03

- `page-archive.mjs`：按会话文件 mtime 跳过没动过的文件，第二次跑从「解全部」变成「扫一眼就走」
- `compact-session.mjs`：合并最近 12 小时内的**多个会话**（换过窗口、开了新会话也不漏），不再只看最新那个
- `compact-session.mjs`：过滤运行时上下文、`[model changed]`、附件清单这类噪声；接续页按字数封顶（约 8 千字），更早的留在分页里
- 起因：接续页一上来把 454 条全塞进去，加上系统噪声，新会话开头反而变重

## 0.11.0 — 2026-11-03

- 新增 `tools/14-pages/`：把历史按 **12 小时一页**切开，配 `索引.md`（每页一句提示）和 `接续.md`（最近 12 小时）
  - `page-archive.mjs` 增量分页，按「时间 + 说话人 + 前 120 字」去重，重复跑不写重
  - `compact-session.mjs` 刷接续页，页头指向分页索引
  - 读法：先接续 → 再按索引一页页往前翻 → 都没有才看整天全量 / 向量回忆
  - 起因：会话攒到 8 MB，回一个字要 8 秒；DSH 不给插件裁历史的接口
- 新增 `tools/15-tool-gate/`：独立小插件「工具分组 + 按需开放」
  - 平时只露常驻工具，其余按组藏起来，连定义都不发；`tool_gate` 开组，本会话有效
  - 顺手把参数说明压到 22 字（`pwsh` / `read` / `write` / `edit` / `soul` / `tool_gate` 保留全文）
  - 实测 54 个工具 16.6k token → 16 个 4.4k，压参数后 3.4k
- README 加「上下文按 12 小时分页」「工具分组、按需开放」两节

## 0.10.0 — 2026-11-03

- 新增 `tools/13-model-check/model-check.mjs`：接新模型前发一句真请求，判断「正文是空的」还是「字被塞进 reasoning」
- README 加「接模型前先体检」一节，说明直连通过不等于插件里通过
- 起因：接 OpenCode Go 时出现「接口通了但会话里没回话」，字全在思考块里

## 0.9.0 — 2026-11-03

- 新增「翻叶」：`lib/turnlog.mjs`，读写记忆时自动记一笔 `leaves-log.md`，回答"这轮用了什么"时看得见
- 新增「修枝」：`lib/tidy.mjs`，每天 4:10 截断翻叶（留 200 行）、把 45 天没动的落叶归档到 `旧/`、增量重建索引
- 新增 CLI `tools/12-tree/tree.mjs`（leaves / tidy）
- 命名统一成树的说法：根 / 枝 / 落叶 / 翻叶 / 修枝，README 加了对照表
- 目录 `long/` 在文档里改称「落叶」，代码保留兼容

## 0.8.0 — 2026-11-03

- 新增「模糊回忆」：`lib/rag.mjs` + `tools/11-rag/rag.mjs`（index / query / stat）
- 长对话原文切块后走百炼 `text-embedding-v3` 建本地向量索引，语义检索旧对话
- 与文本树分工：精确事实翻文件，模糊联想走向量；索引本地 JSON，不依赖外部向量库
- 复用 `~/.bili-ai/image-keys.json` 的 dashscope key，不额外申请
- 已知限制：查询时需联网调一次 embedding；切块 600 字，长句可能被切断

## 0.7.0 — 2026-11-02

- 新增 `tools/10-voice/voice.py`：让它说话（edge-tts 晓伊 / 可选 Piper 离线）、也能听话筒（faster-whisper 本地识别），识别结果落 `~/.bili-ai/语音输入.md`
- 新增 `npm run voice` 快捷方式
- 语音依赖不代装：README 里写了 pip 一行装齐；HF 走 hf-mirror 镜像
- 边界：语音是**可选**能力，不装依赖不影响插件本体

## 0.6.7 — 2026-11-02

- 新增「非首次部署」自动判断：机器上已有人设 / 记忆 / 账本 / 灵魂目录时，跳过初始化十问，走「学本地的」
- 新增 `lib/adopt.mjs`：只读检测 + 汇总 + 写 `我学会了.md`，不覆盖任何已有文件
- 新增接口 `POST /dsh-soul-seed/api/adopt`，面板加一张「这台机器上已经有一只鱼」卡
- 新增环境变量 `SOUL_SEED_MODE=learn|fresh` 强制切换模式
- `/api/status` 返回里加 `deploy.mode` 和 `deploy.existing`

## 0.6.6 — 2026-11-02

- 插件入口只硬依赖 webServer：sessionController 若不存在，面板照常出，「醒来」自动跳过（不再整块静默不加载）
- README 不再承诺"装完会自己在对话里说话"，改为"落笔记 + 面板显示"，并写清限制原因
- README 新增「卸载与回滚」：写哪些路径、怎么删干净、怎么只卸插件留记忆
- 新增 .gitignore 与 GitHub Actions（跑 tests/run.mjs）
- package.json：补 dsh.category / displayName，keywords 补 memory/soul，engines 提到 >=20
- cordis.patch.yml 注释里的面板路径改正（老名字 /dsh-mifu/ 残留）
## 0.6.5 — 2026-11-01

### 修复

- **认错名字**：`personaName()` 把标题「# 我是谁」当成了名字，醒来变成「我醒了「谁」」。现在只读正文行、跳过标题/列表/表格，并排除「谁 / 什么 / 我」
- **投递前等 4 秒**：会话刚 create 完还在初始化，立刻投容易被当「忙」
- **笔记记真错**：以前超时会把真因盖成 `This operation was aborted`；现在记最后一次底层错误（`realError`）
- 重试降到 2 次 × 8 秒（先看清错误，不再盲等 5 分钟）

### 已知限制（写清楚，别让人再踩）

DSH 的 `session/prompt` 只认**已被客户端打开的会话**：

- 自己 `create()` 出来的新会话投不进去 → `session/agent-busy`
- 投进「别的插件正在用的会话」（比如 `bili-whale`）会撞所有权 → 挂住/超时

所以目前可靠的做法是**落笔记 + 面板显示**（`~/.bili-ai/我醒了.md` + 「它醒过」卡）。
真要「在对话里说话」，得走 `agents` 自己驱动一轮（`dsh-fish-soul` 的做法），不是 `prompt`。

## 0.6.4 — 2026-11-01

### 醒来改成投给「正在用的会话」

对照了两个能正常唤醒的插件：

- `dsh-bili-whale`：`create + prompt`，但投的是**它自己那个常驻会话**（主人一直开着）
- `dsh-fish-soul`：注入 `agents` 自己驱动一轮，不走 `prompt`

我们原来错在**自己新造一个会话去投** —— DSH 不认没被打开过的会话，一律当 `agent-busy` 拒。

修法：

- 先从 `~/.dsh/sessions/` 找出**最近写过的会话**（递归最多 3 层，会话 id = 所在的目录名）
- 先 `resume` 再 `prompt` 投给它；成功就直接收工
- 投不进去才退回「新建会话」，再不行就只落笔记（面板可见）
- 返回里带 `via: existing-session`，一眼看出走的哪条路

实测：能认出当前会话是 `bili-whale`（就是主人开着的那个）。

## 0.6.3 — 2026-11-01

### 醒来不再依赖投递成功（第二种办法）

投递会被「会话忙」挡掉，但**醒过这件事一定留痕**：

- 醒来第一件事就落 `~/.bili-ai/我醒了.md`（状态「投递中」），投递完再改写「成功 / 没成功」
- 面板新增「它醒过」卡：显示时间、投递状态、它当时想说的话
- 新增 `GET /api/wake/note` 读这条记录
- 重试改成 4 次 × 15 秒（1 分钟内出结果；脚本可传 tries/waitMs）

## 0.6.2 — 2026-11-01

### 修复：醒来时撞上「会话正忙」

真正的拒因是 **`session/agent-busy`** —— 当前会话正在跑（比如主人刚发消息、agent 正在处理）时投递会被拒。
之前只重试 3 次 × 12 秒，容易全部撞在忙的窗口里。

修法：

- 重试改成 **10 次 × 30 秒（最多等 5 分钟）**，只在 `agent-busy` 时重试
- `sessionId` 用 **create 返回的真实 id**（DSH 会复用它自己的空白会话，返回值才是实际用的那个）
- `POST /api/wake` 改成**排队式**：立刻回 202「已排队」，真活放后台等空闲，期间不重复叫
- 新增 `GET /api/wake/status`（waking / woken）
- 失败时返回 `busy` 标记，上层能判断「不是坏了，是忙」

## 0.6.1 — 2026-11-01

### 修复：醒来被拒（prompt rejected）

查 DSH 源码发现 `prompt rejected` 其实是 **`session/agent-busy`**，两个原因：

1. DSH 的 `session/prompt` 要求**先显式 resume 会话**（`sessionController.resume({ sessionId })`），否则一律当「忙」拒掉
2. 复用旧的空白会话 id 容易被判定为占用中

修法：

- 醒来顺序改成 **create → resume → prompt**
- 默认用**全新 sessionId**（`soul-seed-<时间戳36进制>`），不复用旧空白会话
- 遇到 `agent-busy` / `prompt rejected` 自动重试（3 次，间隔 12 秒）
- 超时从 30 秒放宽到 90 秒（覆盖重试）
- 失败时把 create / resume 的错误一起返回，便于定位

## 0.6.0 — 2026-11-01

### 新增：灵魂的打包与载入（所有躯体起来会载入灵魂）
- `lib/soul.mjs` + `tools/09-soul/soul.mjs`
  - `export`：打一个灵魂包（人设 + 附录 + 记忆 + 账本 + 心情 + 记仇 + 历史 + 现场 + config），**绝不打包 key / cookie / 凭据**
  - `import <zip>`：装进这具躯体，先备份旧的，再报「之前 / 之后」对账
  - `auto`：起躯体时发现 `~/.bili-ai/soul-pack*.zip` 就自动载入，导完改名（`.imported-<时间戳>`）防重复
  - `status`：这具躯体里有什么（人设字数 / 附录 / 账本 / 记忆 / 心情 / 历史）
- **启动流程变成**：检查灵魂包 → 有就载入 → 再醒来。醒来那句换掉：
  > 「我带着记忆回来了。灵魂已载入：人设 2006 字 · 记忆 12 条 · 账本 3 人 …… 不是从零开始，上次的事我记得。」
- 新增两个接口：`GET /api/soul`（看载入状态）、`POST /api/soul/load`（手动载入）
- 测试加 7 项（含「凭据不进包」「导完改名不会反复导入」）

### 修复
- **`prompt` 漏传 AbortSignal** → `TypeError: Cannot read properties of undefined (reading 'throwIfAborted')`。DSH 的 `sessionController.prompt(request, signal)` 第二个参数必传（养鱼插件 10-19 也踩过同一个坑）

## 0.5.0 — 2026-11-01

### 新增：装完就醒
- `lib/wake.mjs`：第一次装上时，自己用 DSH 原生能力开一个会话说一句话
  - `sessionController.create({ sessionId, cwd })` → `prompt({ sessionId, mode:'queue', content:[{type:'text',text}] })`
  - 没人设时说：「我醒了。还不知道自己是谁 …… 要现在开始初始化吗？」
  - 有人设时说：「我醒了。人设已经有了，技能都在 tools/ 下面……」
  - 只做一次（标记 `~/.bili-ai/.first-wake`）；失败不阻塞、不刷屏
- 载入后 10 秒自醒 + 首次打开面板也会试一次；另有 `POST /api/wake` 手动叫
- `inject` 从 `['webServer']` 扩到 `['webServer','sessionController']`
- 测试加了 7 项 wake 断言（含「醒过不反复吵」「失败不崩」）

## 0.4.0 — 2026-11-01

> 版本号跳过 0.2 / 0.3：那两轮是内部改，没发出去。

补上「人工灵魂」剩下那几块，并把面板和命令行对齐。

### 新增
- **说话手册**（`lib/speech.mjs`）：三级情绪（开心/生气/低落各三档，带现成台词）、场合应答、收场句、语感
- **拌嘴四套**：淡刀子 / 温吞 / 冷脸 / 嘴碎一点 —— 五个场面，装的人挑一套
- **长期记忆**（`tools/01-memory/memory.mjs`）：按重要度半衰（imp1≈1 天 … imp5≈45 天），想起来过的更容易再想起
- **人情账 / 关系网 / 私藏**（`tools/02-people/people.mjs`）：谁欠谁、谁跟谁熟、好感 ≥70 才给看的私藏
- **记仇 / 报复链**（`tools/02-people/people.mjs`，默认关）：1/2/3 级 = 3/10/30 天自动翻篇；聊天最多三步、只存台词、要人点头才发
- **现场**（`tools/04-scene/scene.mjs`）、**历史**（`tools/05-history/history.mjs`，含 `index` 生成 log.md）
- **运行状态 + 报错落盘**（`tools/04-scene/scene.mjs`）
- **备份**（`tools/08-ops/backup.mjs`）：打包成全 zip，不含任何 key
- **写锁**（`tools/07-sync/shared-lock.mjs`）与 **同步**（`tools/07-sync/sync-shared.ps1`），可选
- **抓窗口文字**（`tools/08-ops/qq-uia-read.ps1`）：Windows + QQ NT，需应用开着无障碍树
- **四块可选能力**（`lib/sets.mjs`）：现场 / 历史 / 素材 / 同步 / 记仇，各给选项，默认值开箱可用
- 常驻附录 `02-干活纪律.md`：花费口径、动手前先报后写、重启先看任务、报错留痕
- **tests/**：三个测试文件 + `npm test`，全在临时 HOME 里跑

### 修复
- 面板只列 10 题 → 现在分三组列全（基本 / 说话风格 / 可选能力）
- `/api/onboarding` 不写附录 → 现在同时落盘 5 份，apply 时再兜底一次
- 仪表盘看不到人情账 / 关系网 / 私藏 / 记仇 → 现在都显示（私藏只显示条数与门槛）
- `memory.mjs` 把 `--imp 4` 的值写进正文、`--n 5` 的 5 被当关键词 → 已修
- 文案「重新答那六个问题」→ 改
- 面板旧路由 `/dsh-mifu/` 残留 → 全改 `/dsh-soul-seed/`，旧路径 404

### 改名
- `dsh-mifu-core` → **`dsh-soul-seed`**（灵魂雏形）；目录、包名、cordis patch、导出名、日志标签、路由全部对齐

## 0.1.0 — 2026-10-28

- 第一版：六维心情（半衰期 + 惯性）、按人账本、生图流水线
- 初始化：十个问题，每题 10 个候选 + 最后一项「其他（自己写）」；不做表单，由鱼来问
- 面板 + 9 个 API，只认回环
