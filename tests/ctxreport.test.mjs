// tests/ctxreport.test.mjs —— 上下文账的估算与汇总
import { analyze, render, estTokens } from "../lib/ctxreport.mjs";

let bad = 0;
function ok(cond, msg) {
  console.log("  " + (cond ? "✓ " : "✗ ") + msg);
  if (!cond) bad++;
}

// 造两轮：第一轮 3 步、第二次带一次压缩标记
const records = [
  { type: "turn/start", time: 1 },
  { type: "step/start" },
  { type: "assistant/message", data: { usage: { inputTokens: 1000, cacheReadTokens: 800, outputTokens: 100 }, message: { content: [{ type: "text", text: "第一轮" }] } } },
  { type: "turn/end" },
  { type: "turn/start", time: 2 },
  { type: "step/start" },
  { type: "assistant/message", data: { usage: { inputTokens: 3000, outputTokens: 200 }, message: { content: [{ type: "text", text: "[compacted-summary] 早前内容被压成摘要了" }] } } },
  { type: "turn/end" }
];

const r = analyze(records, { personaChars: 2000, memoryChars: 100, peopleChars: 50 });
ok(r.turns === 2, "数出 2 轮（" + r.turns + "）");
ok(r.turnsMeasured === 2, "两轮都有 usage");
ok(r.inputAvg === 2000, "平均输入 2000（实际 " + r.inputAvg + "）");
ok(r.inputMax === 3000, "最大输入 3000（实际 " + r.inputMax + "）");
ok(r.compactions === 1, "认出 1 次压缩（实际 " + r.compactions + "）");
ok(r.output === 300, "输出合计 300（实际 " + r.output + "）");
ok(r.external.persona > 0, "人格规模算了（" + r.external.persona + " tok）");

const text = render(r);
ok(text.includes("[上下文账]"), "渲染有标题");
ok(text.includes("平均"), "渲染有平均值");
ok(text.includes("估算"), "渲染写明是估算，不冒充实测");

ok(estTokens("中文四个字") > 0, "估算函数能算中文");
ok(estTokens("") === 0, "空串算 0");
ok(estTokens(null) === 0, "null 不炸");

process.exit(bad ? 1 : 0);
