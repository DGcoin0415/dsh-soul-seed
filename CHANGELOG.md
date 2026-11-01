# CHANGELOG

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
