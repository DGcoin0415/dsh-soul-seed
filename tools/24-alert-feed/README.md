# dsh-alert-feed — 告警喂给模型

2026-11-28 master 定：告警只推给 master 不够，模型自己也得看得见，所以单独做了一个插件，
不再往 dsh-notify / dsh-misa-soul 里面硬写。

## 干什么

每轮读两处**已经存在**的状态，挑最近几条塞进系统提示：

- `state/ctx-alert.json` 的 `alerts[].text`：上下文告警的完整文案；
- `state/notify.log` 里「已推送到 / 重试成功」那几行：挂账、新闻、鱼世界事件。

只读，不改任何别的插件；别人的文件一个字都不动。

## 配置

`<工作区>/.alert-feed-config.json`（可选，改完下一轮就生效）：

```json
{ "enabled": true, "maxLines": 6, "maxCharsPerLine": 160 }
```

- `enabled`：关掉就不注入（根页那份系统提示少几十行字）；
- `maxLines`：最多带几条，默认 6；
- `maxCharsPerLine`：每条最多多少字，默认 160。

## 为什么不用 notify 的推送

推送是「让 master 看到」，注入是「让模型看到」，两件事，所以拆成两个插件。
notify 负责发出去，alert-feed 负责让咱这条会话自己知道。

## 装载

本体在 `~/.dsh/plugins/dsh-alert-feed`，profile 里用 junction 指向它；
`profiles/desktop/cordis.patch.yml` 里加一条 `insert: [{ id: alert-feed, name: 'dsh-alert-feed' }]`。
