// tests/anchor.test.mjs —— 结论锚：摘句 / 渲染 / 边界
import { harvest, render, buildAnchor, ANCHOR_MARK } from "../lib/anchor.mjs";

let bad = 0;
function ok(cond, msg) {
  console.log("  " + (cond ? "✓ " : "✗ ") + msg);
  if (!cond) bad++;
}

// 1) 能摘出结论句
const thoughts = [
  "先看看桌面上的东西。",
  "结论是这台机器的 node 在 dsh-runtimes 里，不能直接敲 node。",
  "也许我该再试试别的方法。",
  "所以要用全路径调 node.exe，已经确认过版本是 24。",
  "根因是路径写死了 C:\\Users\\Administrator。",
  "啊这个界面真好看。"
].join("\n");
const points = harvest(thoughts);
ok(points.length >= 2, "摘到至少 2 条结论（实际 " + points.length + " 条）");
ok(points.every((p) => p.length <= 220), "每条都不超过 220 字");
ok(points.some((p) => p.includes("全路径")), "含「用全路径」那条");
ok(!points.some((p) => p.includes("界面真好看")), "不摘要凑热闹的句子");

// 2) 最多 3 条
const many = Array.from({ length: 10 }, (_, i) => "所以第 " + (i + 1) + " 条结论已经成立了。").join("\n");
ok(harvest(many).length === 3, "最多只摘 3 条");

// 3) 超长句子整条丢，不截一半
const longLine = "结论是" + "很长".repeat(130) + "。";
ok(!harvest(longLine).some((p) => p.startsWith("结论是")), "超过 220 字的整条丢掉");

// 4) 空输入
ok(harvest("").length === 0, "空文本摘不到东西");
ok(harvest(null).length === 0, "null 不炸");
ok(render([]) === "", "空数组渲染成空串（调用方据此跳过注入）");

// 5) 渲染带标记
const text = buildAnchor(thoughts);
ok(text.includes(ANCHOR_MARK), "渲染带 [锚点] 标记");
ok(text.includes("别再重新推导"), "渲染带提醒语");
ok(text.split("\n").length >= 3, "渲染是多行");

// 6) 去重
const dup = "所以要用全路径。\n所以要用全路径。";
ok(harvest(dup).length === 1, "重复的句子只留一条");

// 7) 半截引文不要（2026-11-07 真实踩到的）
ok(harvest("所以「它也能帮你组织语言」那句……」").length === 0, "半截引文（省略号收尾）不要");
ok(harvest("所以「接进去」改变的不是能力，是距离。").length === 1, "引号配对的完整句要留");
ok(harvest("根因是括号没闭合（这明显不对").length === 0, "括号不配对不要");
ok(harvest("结论是要用全路径。").length === 1, "以句号收尾的完整结论要留");

process.exit(bad ? 1 : 0);
