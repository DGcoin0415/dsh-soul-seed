# dsh-ctx-alert

真实上下文占用告警。解决一件事：以前「上下文快满了」是模型按根页规矩自己喊的，喊的数跟界面右下角对不上（界面 35%、模型说 74%）。这里统一用**真实 token 占用**，再数压缩轮次，按轮次 + 绝对线只提醒一次。

## 它怎么算

取值优先级（前面拿得到就不往后走）：

1. `tokenMeter.contextPressure(session)` → `projectedTokens` / `pressureTokens` + `contextWindow`（跟界面同一套）
2. `sessionProjections.snapshot(session, ['contextPressure'])` → 同上
3. 本轮 `assistant/message` 事件自带的 `usage.totalTokens`（最省，每轮都有）
4. `session.snapshotEvents()` 里最后一条 `assistant/message` 的 `usage.totalTokens`
5. 会话文件 `~/.dsh/sessions/<slug>/<会话id>/session.v4.jsonl.zstd`（同 `context-check.mjs`：解 zstd 帧，取最后一条 usage，除窗口；带 20 秒缓存）

窗口：先看 `contextPressure.contextWindow`，再看会话里 `request/context` 的 `contextWindow`，最后才用配置的 `windowTokens`（默认 1048576）。

## 轮次和阈值

规则按 `bench/ctx-rounds/report.md` 的历史数据定（master 2026-11-27 改）：

- 占用一次回落 ≥ `dropPoints`（默认 15 点）→ 记「压缩 +1」，`round +1`，峰值重置为当前值；
- **绝对线**（不看轮次）：占用 ≥ `absolutePct`（默认 72）就告警 —— 补「压缩失败、轮次不涨、直接撞死」那个洞（70% 以上压缩 0% 成功，12 条撞墙会话死在第 0 轮）；
- **最后一轮**（`round >= maxRounds`，默认 `maxRounds=1`，即压过一次后）：≥ `lastRoundPct`（60）告警，提醒换新会话、只记东西不接新活；
- **倒数第二轮**（`round == maxRounds-1`，默认第 0 轮）：≥ `penultRoundPct`（70）告警，提醒别再扛重活；
- 同一轮同一阈值只提醒一次（状态文件里记 `round:threshold`），绝对线自己一个键 `abs:72`。

> 为什么 `maxRounds=1`：每轮都是从 ~21% 爬到 ~69.7% 再压下来，不存在「压到第 N 轮才危险」；而 80% 的撞墙会话一次都没压成功，轮次永远是 0。设 3 或 4 在这批数据上基本不触发。

## 提醒去哪

复用已装的 `dsh-notify`：动态 import 它的 `lib/core.mjs`，`push({source:'ctx-alert', text, sessionId})`，带 sessionId 就 `followup` 回**发起会话**（在哪问的在哪回）。notify 没装时退回收件箱 `<工作区>/.notify-outbox/`，下一轮轮询捡走。

## 配置

`<工作区>/.ctx-alert-config.json`（默认工作区 `~/.dsh/im`）。改完不用重启，插件每 5 秒重读一次。

```json
{
  "enabled": true,
  "maxRounds": 1,
  "windowTokens": 1048576,
  "dropPoints": 15,
  "lastRoundPct": 60,
  "penultRoundPct": 70,
  "absolutePct": 72,
  "checkEveryMin": 1,
  "activeHours": 2,
  "writeHistory": true,
  "writeHandoff": true,
  "keepSamples": 30,
  "keepSessions": 40
}
```

`absolutePct: 0` 关掉绝对线。`maxRounds` 改大就退回多轮语义（例如 3 → 第 2 轮 70% / 第 3 轮 60%）。
`writeHandoff: false` 关掉「到 70% 自动写交接」。

## 到 70% 自动写交接（`writeHandoff`，默认开，2026-11-27 master 定）

占用**第一次**到「倒数第二轮」那条线（现用参数就是第 0 轮 70%）时，除了推送，顺手在 `shared/交接.md` 的「刚完成」段补一行：

```
- [14:51] 上下文 70%，本会话先写交接（插件自动） · 会话 session-xxxx
```

- 只插这一行，**不整篇重写**：读全文 → 插一行 → 原子写回（tmp + rename）；别的段一个字不动；
- **不调模型、不花钱**，全在插件里算；
- 幂等：同一会话已经在「刚完成」里写过就跳过（写两遍也只留一条）；状态文件里另外记一份 `sessions.<id>.handoffs["0:70"]`；
- 没有「刚完成」段就在文末补一个；`shared/交接.md` 不在就建一个最小的；
- 只在这一档写：绝对线（72%）和最后一轮（60%）不写，别的轮次也不写；
- 写盘失败只记日志，**不影响告警推送**。


## 阈值怎么定的（回放数据）

`node bench/ctx-rounds/sim-alert.mjs` 拿 108 条历史曲线回放，判定直接 import 本插件的 `rounds.mjs`：

| penult | absolute | 15 条撞墙会话 | 93 条没撞墙的误报 |
| --- | --- | --- | --- |
| 68 | 72 | 15 / 15 | 12（12.9%） |
| 69 | 72 | 15 / 15 | 12（12.9%） |
| **70（现用）** | **72** | **15 / 15** | **9（9.7%）** |
| 71 | 72 | 15 / 15 | 7（7.5%） |

68 和 70 之间是断崖：每轮峰值中位正好 69.7%，阈值压在它下面就命中一批「压得下去、最后正常收尾」的会话。70 放掉的那几条，涨过 72% 时绝对线照样报，所以覆盖率不掉——「留余量」和「控误报」不用二选一。全表见 `bench/ctx-rounds/threshold-tradeoff.md`。

## 落账

- 状态：`<工作区>/state/ctx-alert.json`（每个会话的 round / peak / 占用曲线 / 已提醒的档位 / 写过的交接 / 告警明细）
- 日志：`<工作区>/state/ctx-alert.log`
- 历史：`<工作区>/shared/历史/<当月>.md` 每次告警追加一条（只追加，标了是绝对线 / 最后一轮 / 倒数第二轮；顺手写过交接的会注明）
- 交接：`<工作区>/shared/交接.md` 的「刚完成」段（只在 70% 那一档补一行）

## 触发时机

- 每轮：`ctx.on('session/event')` 里 `assistant/message` 之后算一次；
- 每分钟：兜底扫状态里最近 `activeHours` 小时内动过的会话（走 tokenMeter / 会话文件），空闲会话也能覆盖；
- 开机：加载 10 秒后把状态里记过的会话补量一遍。
- **首次见到某个会话**：按会话文件里的整条占用曲线重放一遍，把「已经压缩过几轮」补准（不补的话，装插件之前压缩过的会话会从第 0 轮数起，永远等不到提醒）。

## 装法

本体 `~/.dsh/plugins/dsh-ctx-alert`，复制进 `profiles/<profile>/node_modules/dsh-ctx-alert`，profile 的 `cordis.patch.yml` 加：

```yaml
- insert:
    - id: ctx-alert
      name: 'dsh-ctx-alert'
```

**要重启 DSH 才生效**（插件不是同一个会话能热加载的）。

## 自测

```
node selftest.mjs
```

68 项：真实占用读取（当前会话 + 最近会话）、轮次/阈值/绝对线/去重、一条模拟占用曲线（70% 轮次线 → 72% 绝对线 → 61% 换会话，只提醒 3 次）、按会话文件补量轮次（合成 zstd 会话文件，补到第 2 轮并命中绝对线）、状态/历史是否真落盘、插件本体能否 `apply`（假 ctx + 真会话）。
