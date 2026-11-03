# dsh-tool-gate（可选小插件）

工具分组 + 按需开放。平时模型只看得到常驻工具，其余按组藏起来，**连参数定义都不发**；用的时候调 `tool_gate` 开一组。

## 装

它是个独立插件，不在 soul-seed 本体里加载。把 `tools/15-tool-gate` 整个目录拷到 `~/.dsh/plugins/dsh-tool-gate`，然后在 profile 的 `package.json` 里链上并加进 bundles：

```json
{
  "dependencies": { "dsh-tool-gate": "link:C:/Users/<你>/.dsh/plugins/dsh-tool-gate" },
  "dsh": { "profile": { "bundles": ["...", "dsh-tool-gate"] } }
}
```

重启 DSH 后 `tool_gate` 就出现了。

## 配置

改 `~/.dsh/im/tool-groups.json`（`SOUL_HOME` 换过就改那边），改完不用重启（每次组装提示时现读）。

```json
{
  "keep": ["pwsh", "read", "write", "edit", "glob", "grep", "soul", "tool_gate"],
  "groups": {
    "生图": ["generate_image", "generate_images", "edit_image"],
    "语音": ["tts_speak", "tts_voices"]
  },
  "trim": {
    "paramDesc": 22,
    "toolDesc": 0,
    "fullDesc": ["pwsh", "read", "write", "edit", "soul", "tool_gate"]
  }
}
```

- `keep`：永远可见，不会被任何组藏起来。
- `groups`：组名 → 工具名。组没开就整组藏起来。
- 没写进任何组的工具保持原样，不动它。
- `trim.paramDesc`：每个参数说明截到多少字（0 = 不截）。`fullDesc` 里的工具保留全文说明，比如 `pwsh` 那些坑。
- `trim.toolDesc`：工具一句话描述的截断长度（0 = 不截）。

## 用法

- `tool_gate` 不带参数：看有哪些组、每组几个、开没开。
- `tool_gate({"action":"open","group":"生图"})`：开这一组，本会话一直有效。
- `tool_gate({"action":"close","group":"生图"})`：收回。

## 实现要点

- 藏：挂 `agent.ctx.on('system-prompt/assemble')`，把这一轮的 `assembly.tools` 和 `tool:<name>` 段过滤掉。
- 压：同一处顺手把参数说明按 `trim` 缩短，schema 结构不动，调用不受影响。
- 拦：`agent.ctx.get('tools').guard(...)`，藏着的工具被调用就提示先开组。
- 开：`tool_gate` 往会话的开启集合里加组名，下一轮组装时自然就放出来了。

实测：54 个工具 16.6k token → 16 个 4.4k token；参数说明压到 22 字后再降到 3.4k。开一组回涨到 22 个。

## 注意

- 开启状态只在内存里，重启会回到「只露常驻」。
- 组里别放 `pwsh` 这类干活必需的；藏了它，模型就没法跑命令给自己开组了。
