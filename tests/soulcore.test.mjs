// tests/soulcore.test.mjs —— 记忆树核心 + 轨道（数据全在临时目录，不碰真数据）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "seed-soulcore-"));
// 0.15.1-test 起共享工作区默认会走本机 ~/.dsh/im（如果存在），
// 测试要隔离就把 DSH_SHARED_DIR 显式指到临时目录，只设 DSH_SOUL_DIR 不够。
process.env.DSH_SHARED_DIR = tmp;
process.env.DSH_SOUL_DIR = tmp;
delete process.env.SOUL_HOME;

const core = await import("../lib/soulcore.mjs");
const tracks = await import("../lib/tracks.mjs");

let bad = 0;
function ok(cond, msg) {
  console.log("  " + (cond ? "✓ " : "✗ ") + msg);
  if (!cond) bad++;
}

// 根页：没有就空串，有就注入并被截断
ok(core.renderRoot() === "", "根页不存在时返回空串");
fs.writeFileSync(path.join(tmp, "SHARED-STATE.md"), "# 根页\n\n- 一条铁律\n", "utf8");
const root = core.renderRoot();
ok(root.includes("一条铁律"), "根页能读出来");
ok(core.renderRoot(5).includes("已截断"), "根页超长会截断并留提示");
ok(core.readRoot().startsWith("# 根页"), "readRoot 原文完整");
ok(core.rootPagePath().startsWith(tmp), "根页路径落在临时数据目录（" + core.rootPagePath() + "）");

// 历史：第一条自动写标题
const first = core.appendHistory("第一条结论");
ok(fs.existsSync(first.file), "历史文件建出来了");
ok(fs.readFileSync(first.file, "utf8").includes("# 历史 ·"), "历史文件有月份标题");
core.appendHistory("第二条结论");
ok(fs.readFileSync(first.file, "utf8").includes("第二条结论"), "第二句追加进去了");
let threw = false;
try { core.appendHistory("   "); } catch { threw = true; }
ok(threw, "空结论会拒收");

// 枝：读写 + 防目录穿越
fs.mkdirSync(path.join(tmp, "shared", "规矩"), { recursive: true });
fs.writeFileSync(path.join(tmp, "shared", "规矩", "测试.md"), "出图先查家底，再挑模型。\n", "utf8");
ok(core.readBranch("规矩/测试.md").includes("出图先查家底"), "readBranch 能读 shared 下的枝");
ok(core.readBranch("shared/规矩/测试.md").includes("出图先查家底"), "带 shared/ 前缀也认");
threw = false;
try { core.readBranch("../SHARED-STATE.md"); } catch { threw = true; }
ok(threw, ".. 越界被挡住");

const tree = core.listTree();
ok(tree.some((x) => x.path === "shared/规矩/测试.md"), "listTree 列出枝");
ok(tree.some((x) => x.dir), "listTree 列出目录");

// 落叶检索：本地关键词，不联网
const hits = core.recallLocal("出图 家底");
ok(hits.length > 0 && hits[0].file.includes("测试.md"), "rag 本地检索命中目标文件");
ok(hits[0].text.includes("出图"), "命中片段带上下文");
ok(core.recallLocal("不存在的词").length === 0, "查不到就回空");

// 轨道：存 → 查 → 覆盖更新
const saved = tracks.saveTrack({ name: "出图", keywords: "生图,画图", steps: "查家底｜挑模型", fallback: "走云端" });
ok(saved.ok, "轨道能存");
const trackFile = path.join(tmp, "shared", "轨道.json");
ok(fs.existsSync(trackFile), "轨道文件落在临时目录（" + trackFile + "）");
const shown = tracks.showTrack("画图");
ok(shown && shown.name === "出图" && shown.steps.length === 2, "按关键词能查回轨道");
ok(tracks.renderTrack(shown).includes("跑不通：走云端"), "轨道渲染带退路");
tracks.saveTrack({ name: "出图", keywords: "生图", steps: "换一步", fallback: "" });
const updated = tracks.loadTracks().tracks[0];
ok(updated.steps[0] === "换一步", "同名轨道覆盖内容");
ok(updated.keywords.join() === "生图", "同名轨道覆盖关键词");
ok(tracks.showTrack("根本没有") === null, "没命中回 null");

fs.rmSync(tmp, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
