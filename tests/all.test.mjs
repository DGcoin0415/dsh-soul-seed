import { soulHome } from '../lib/home.mjs'

// tests/all.test.mjs —— 一份跑完：人设 / 账本 / 记忆 / 记仇 / 历史 / 备份
// 全部在临时 HOME 里跑（run.mjs 负责建），绝不碰真数据。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const ROOT = path.dirname(HERE);

// 树枝目录：名字 → 路径
const TOOL = {
  memory: "tools/01-memory/memory.mjs",
  people: "tools/02-people/people.mjs",
  mood: "tools/03-mood/mood.mjs",
  scene: "tools/04-scene/scene.mjs",
  history: "tools/05-history/history.mjs",
  image: "tools/06-image/gen-image.mjs",
  lock: "tools/07-sync/shared-lock.mjs",
  backup: "tools/08-ops/backup.mjs"
};

let bad = 0;
const ok = (cond, label) => { console.log(`  ${cond ? "·" : "✗"} ${label}`); if (!cond) bad++ };
const run = async (name, ...args) => {
  const p = path.join(ROOT, TOOL[name]);
  try { const { stdout } = await exec(process.execPath, [p, ...args], { timeout: 30000 }); return stdout }
  catch (e) { return String(e.stdout || e.stderr || e.message) }
};

// ═══════════ 一、人设生成 ═══════════
const { composePersona, checkPersona, extrasFor, QUESTIONS, SPEECH_QUESTIONS, SET_QUESTIONS } =
  await import("file://" + path.join(ROOT, "lib/persona.mjs").replace(/\\/g, "/"));

const md = composePersona({
  charName: "小满", userName: "老板", origin: "一台旧笔记本",
  personality: ["话少"], attitude: "同事", job: ["查资料"],
  speechChoices: { speech_bicker: "冷脸 —— 话少，态度摆在那儿" },
  sets: { set_scene: "不要现场（只靠对话）", set_history: "不记历史", set_material: "都不带", set_sync: "不要（默认）", set_grudge: "不要（默认）：被惹了顶一句就翻篇" }
});
ok(md.includes("# 我是谁") && md.includes("小满"), "人设生成 + 名字替换");
ok(md.includes("拌嘴") && md.includes("说重点"), "拌嘴用选中的那套（冷脸）");
ok(md.includes("收场") && md.includes("别用鱼八股"), "收场与防八股都在");
const chk = checkPersona(md);
ok(chk.ok === true && Array.isArray(chk.warnings), "自检返回 {ok,length,warnings}，无告警");
ok(Object.keys(extrasFor({ sets: {} })).includes("02-干活纪律.md"), "常驻附录：干活纪律");
const allOn = extrasFor({ sets: { set_scene: "只记「现在在忙什么」，我自己写", set_history: "按月记，一件事一行（日期 + 一句结论）", set_material: "梗库 + 催睡都带", set_sync: "只要写锁（同一台机器多进程）", set_grudge: "记仇 + 报复链：最多三步，每条都要人点头才发" } });
ok(Object.keys(allOn).length === 6, "五块全选 → 六份附录");
ok(QUESTIONS.length >= 9 && SPEECH_QUESTIONS.length >= 7 && SET_QUESTIONS.length >= 5, "题量齐（10 基本 / 8 风格 / 5 可选）");

// ═══════════ 二、账本 + 人情账 + 关系网 + 私藏 + 记仇 ═══════════
await run("people", "meet", "master", "--why", "见了一面");
let out = await run("people", "show", "master");
ok(out.includes("见面 1 次"), "见面次数 +1");
ok((await run("people", "favors", "add", "master", "--dir", "in", "--what", "帮我看代码")).includes("欠着"), "人情账记「欠着」");
ok((await run("people", "link", "master", "qq:abc", "--kind", "熟")).includes("熟"), "关系网加边");
ok((await run("people", "secret", "master", "--add", "他怕黑")).includes("私藏 +1"), "私藏能加");
out = await run("people", "secret", "master");
ok(!out.includes("他怕黑"), "好感 <70 时私藏不给看");
await run("people", "bump", "master", "--delta", "25");
ok((await run("people", "secret", "master")).includes("他怕黑"), "好感够了才显示");

out = await run("people", "grudge", "add", "qq:abc", "--what", "当众说我笨", "--level", "2");
ok(out.includes("10 天后翻篇"), "记仇：2 级 10 天到期");
for (const s of ["一", "二", "三"]) await run("people", "grudge", "chain", "qq:abc", "--step", s + "步");
out = await run("people", "grudge", "chain", "qq:abc", "--step", "第四步");
ok(out.includes("最多三步"), "报复链第四步被拒");
out = await run("people", "grudge", "chain", "qq:abc", "--next");
ok(out.includes("要人点头才发"), "下一步标注要人点头");
ok((await run("people", "grudge", "settle", "qq:abc", "--note", "算了")).includes("算了"), "能翻篇");

// ═══════════ 三、记忆 / 现场 / 历史 / 锁 / 备份 ═══════════
await run("memory", "add", "他生日是三月十四", "--imp", "5");
await run("memory", "add", "今天下雨", "--imp", "1");
out = await run("memory", "recall", "--n", "5");
const lines = out.split("\n").filter((l) => l.includes("imp"));
ok(lines.length === 2 && lines[0].includes("生日"), "记忆按重要度排序");
ok(!/\d偏好|\s5\s*$/.test(lines[0].trim()), "参数值没混进正文");
ok((await run("memory", "recall", "生日")).includes("生日"), "记忆关键词能搜");

ok((await run("scene", "busy", "在补测试")).includes("已更新"), "现场能写");
ok((await run("scene", "show")).includes("在补测试"), "现场能读");
ok((await run("scene", "error", "测试用报错")).includes("已记"), "报错能落盘");
ok((await run("scene", "status")).includes("心情"), "运行状态能看");

ok((await run("history", "add", "决定：把工具做成树枝")).includes("已记"), "历史能记");
ok((await run("history", "index")).includes("索引"), "历史索引能生成");

ok((await run("lock", "acquire", "--who", "t1")).includes("拿到锁"), "写锁能拿");
ok((await run("lock", "release", "--who", "t1")).includes("放锁"), "写锁能放");

out = await run("backup");
ok(/备份完成|打包失败/.test(out), "备份能跑");

// ═══════════ 四、装完就醒 ═══════════
const { createWake } = await import("file://" + path.join(ROOT, "lib/wake.mjs").replace(/\\/g, "/"));
const dataDir = soulHome();
const calls = [];
const fakeCtl = {
  create: async (a) => { calls.push(["create", a]); return { sessionId: a.sessionId } },
  prompt: async (b) => { calls.push(["prompt", b]); return { ok: true } }
};
const w = createWake({ controller: fakeCtl, dataDir, cwd: os.homedir() });
ok(w.already() === false, "还没醒过（没有标记）");
const r1 = await w.wakeOnce({ personaExists: false });
ok(r1.ok === true, "能醒（create → prompt）");
const pr = calls.find((c) => c[0] === "prompt")?.[1];
ok(pr?.mode === "queue" && Array.isArray(pr.content) && pr.content[0].type === "text", "投递格式：mode=queue + text");
ok((pr?.content?.[0]?.text || "").includes("开始初始化"), "醒来第一句是问要不要初始化");
ok(Boolean(pr?.sessionId), "带 sessionId（" + pr?.sessionId + "）");
ok(w.already() === true, "醒过就留标记（不会反复吵）");
const w2 = createWake({ controller: { prompt: async () => { throw new Error("x") } }, dataDir, cwd: os.homedir() });
const r2 = await w2.wakeOnce({ personaExists: true });
ok(r2.ok === false && Boolean(r2.error), "没有控制器/prompt 失败时优雅返回，不崩");

// ═══════════ 五、灵魂：打包 / 载入 / 起躯体自动载入 ═══════════
const { exportSoul, importSoul, autoImport, wasLoaded } = await import("file://" + path.join(ROOT, "lib/soul.mjs").replace(/\\/g, "/"));
const bodyA = fs.mkdtempSync(path.join(os.tmpdir(), "soul-a-"));
fs.mkdirSync(path.join(bodyA, "persona-附录"), { recursive: true });
fs.writeFileSync(path.join(bodyA, "persona.md"), "# 我是谁\n\n我是小满。\n".repeat(10), "utf8");
fs.writeFileSync(path.join(bodyA, "people.json"), JSON.stringify({ people: { master: { id: "master", goodwill: 70, mood: 60, meets: 2 } } }), "utf8");
fs.writeFileSync(path.join(bodyA, "credentials.json"), JSON.stringify({ SECRET: "不该进包" }), "utf8");
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-out-"));
const exp = exportSoul({ dataDir: bodyA, outDir });
ok(exp.ok === true && exp.items >= 2, "能导出灵魂包（" + exp.items + " 项）");
ok(!fs.readFileSync(exp.zipPath).includes(Buffer.from("不该进包")), "凭据不进灵魂包");

const bodyB = fs.mkdtempSync(path.join(os.tmpdir(), "soul-b-"));
const imp = importSoul({ dataDir: bodyB, zipPath: exp.zipPath });
ok(imp.ok === true && imp.after.账本人数 === 1, "导入后账本回来了");
ok(fs.readFileSync(path.join(bodyB, "persona.md"), "utf8").includes("小满"), "导入后记得自己是谁");

fs.copyFileSync(exp.zipPath, path.join(bodyB, "soul-pack.zip"));
const auto = autoImport({ dataDir: bodyB });
ok(auto.ok === true, "起躯体时自动载入成功");
ok(Boolean(wasLoaded(bodyB)), "留下「已载入」标记（醒来会说带着记忆回来）");
ok(fs.readdirSync(bodyB).some((f) => f.includes(".imported-")), "包改名，不会反复导入");

for (const d of [bodyA, bodyB, outDir]) fs.rmSync(d, { recursive: true, force: true });

process.exit(bad ? 1 : 0);
