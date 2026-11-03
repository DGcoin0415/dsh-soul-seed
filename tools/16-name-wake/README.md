# 16-name-wake：名字叫醒

有人在群里喊名字时，往「已经打开的那个会话」里投一句。DSH 的 `session/prompt` 只认客户端打开的会话，所以能投的就是这些。

```js
import { startNameWake, defaultFlagFile } from './tools/16-name-wake/name-wake.mjs'

const wake = startNameWake({
  getController: () => ctx.get('sessionController'),
  getSessionIds: () => [...],            // 按优先级，第一个投得进就用它
  flagFile: defaultFlagFile(soulDir),    // 标记文件路径
  log: (m) => console.log(m),
})
```

标记文件格式：`时间戳|要说的话`，一行。

## 卡住不许一直重试（0.11.3 加）

以前投不进去会不停重试，日志刷屏、消息堵在队列里。现在三条规矩：

- **最多试 3 次**：三次都投不进就放弃，不留尾巴。
- **标记最多活 10 分钟**：过了就当过期，直接删，不再投。
- **投不进就丢标记**：失败也删，等下次有人喊再投，不攒着反复拉起。

跟微信那边的待发队列一个原则：卡住的消息不许一直重试，宁可丢，不许堵。
