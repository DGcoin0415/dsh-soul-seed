# dsh-misa-soul · 人工灵魂

把一份**纯文本的分层记忆目录**挂进 DeepSeek Harness 的每个会话：根页每轮注入系统提示，枝上的细节用一个工具按需读，定了什么事往当月历史追加一条；另附一份按人的好感 / 心情账本，带半衰期衰减和记仇门槛。

不绑定任何渠道、不联网、不写数据库——就是文件。

## 它做什么

1. **根页注入**：每轮把 `<记忆目录>/SHARED-STATE.md` 塞进系统提示（默认最多 6000 字，超出截断并提示全文位置）。
2. **按需读枝**：`soul` 工具 `action=read` 读 `shared/` 下的任意文本文件（带路径越界校验）。
3. **落果**：`action=note` 往 `shared/历史/YYYY-MM.md` 追加「时间 + 一句结论」。
4. **按人账本**：`person-get` / `person-bump` / `person-mood` 读写 `shared/people/people.json`。
5. **情绪衰减**：`action=decay` 把每个人的心情分按半衰期往 50 回落——负面 3 小时、正面 8 小时；低于门槛（默认 30）且是故意的，就标成记仇。

## 目录约定

```
<记忆目录>/                 # 默认 ~/.dsh/im，可用环境变量 DSH_SOUL_DIR 改
├─ SHARED-STATE.md          # 根：身份、铁律、索引（每轮注入）
└─ shared/
   ├─ 索引.md               # 「要查什么，翻哪份」
   ├─ 规矩/ 说话/ 资料/ 历史/ people/
   └─ …
```

没放 `SHARED-STATE.md` 就不注入任何东西，装上也安静。

## 工具

| action | 作用 | 主要参数 |
| --- | --- | --- |
| `where` | 看记忆目录和根页大小 | — |
| `tree` | 列出整棵树和每份大小 | — |
| `read` | 读某个枝 | `file`（`shared/` 下相对路径） |
| `note` | 往当月历史追加结论 | `text` |
| `person-get` | 查某人账本 | `key` |
| `person-bump` | 加减好感 | `key`、`delta`、`name` |
| `person-mood` | 设心情分 | `key`、`score`、`label`、`intent` |
| `decay` | 全体心情衰减一遍 | — |

`key` 用「渠道:账号」，例如 `qq:1042442284`。

## 安装

```bash
# 本机开发
ln -s /path/to/dsh-misa-soul ~/.dsh/plugins/dsh-misa-soul
# 然后在 profile 的 package.json 里加 link 依赖，并把它加进 dsh.profile.bundles，重启 DSH
```

## 为什么是文件而不是数据库

- 人能直接读、直接改、直接备份；出问题用记事本就能修。
- 两份躯体（不同机器 / 不同渠道）可以各自持有一份，靠同步脚本或聊天互抄，不存在迁移问题。
- 想删掉某个记忆，就是删文件，没有隐藏状态。

## 边界

- 不抓渠道消息（那是 dsh-im 之类渠道插件的事）。
- 不做语义检索，没有向量库；靠索引文件的人为分层来控制读取量。
- 心情分是角色内部刻度，不是对真实关系的度量。

## License

MIT
