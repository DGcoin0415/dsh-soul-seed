#!/usr/bin/env node
// persona.mjs —— 人设生成 CLI（给「鱼自己问、自己写」用，不需要人填表单）
//
// 用法：
//   node tools/00-setup/persona.mjs --questions        打印十个问题（JSON，给 agent 照着问）
//   node tools/00-setup/persona.mjs --rules            打印默认铁律（部署时给人看，允许删改）
//   node tools/00-setup/persona.mjs --answers a.json   用答案生成人设，写到 ~/.bili-ai/persona-draft.json
//   node tools/00-setup/persona.mjs --apply            把草稿写进 ~/.bili-ai/persona.md（旧文件备份）
//   node tools/00-setup/persona.mjs --show             看当前草稿 / 已写入的人设
//
// 答案 JSON 长这样：
//   { "charName":"米芾", "userName":"master", "origin":"…", "look":"…",
//     "personality":"…", "attitude":"…", "speech":"…", "job":"…", "extra":"…",
//     "rules":["…", "…"] }
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { QUESTIONS, SPEECH_QUESTIONS, SET_QUESTIONS, RULES_QUESTION, DEFAULT_RULES, composePersona, checkPersona, extrasFor } from "../../lib/persona.mjs";
import { composeSpeech } from "../../lib/presets.mjs";

const DATA = path.join(os.homedir(), ".bili-ai");
const DRAFT = path.join(DATA, "persona-draft.json");
const TARGET = path.join(DATA, "persona.md");

const argv = process.argv.slice(2);
const has = (n) => argv.includes("--" + n);
const arg = (n) => { const i = argv.indexOf("--" + n); return i > -1 ? argv[i + 1] : null };

const readJson = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, "utf8")) } catch { return d } };

if (has("questions")) {
  console.log(JSON.stringify({ questions: QUESTIONS, rulesQuestion: RULES_QUESTION, rules: DEFAULT_RULES }, null, 2));
  process.exit(0);
}

if (has("sets")) {
  console.log(JSON.stringify({ questions: SET_QUESTIONS }, null, 2))
  process.exit(0)
}

if (has("speech")) {
  console.log(JSON.stringify({ questions: SPEECH_QUESTIONS, manual: composeSpeech({}) }, null, 2));
  process.exit(0);
}

if (has("rules")) {
  console.log("下面这些「绝不做什么」，可以直接用，也可以删改（每行一条）：\n");
  DEFAULT_RULES.forEach((r, i) => console.log(`  ${i + 1}. ${r}`));
  process.exit(0);
}

if (has("answers")) {
  const file = arg("answers");
  const answers = readJson(file);
  if (!answers) { console.error("读不到答案文件：" + file); process.exit(2) }
  if (!String(answers.charName || "").trim()) { console.error("缺 charName（我是谁）"); process.exit(2) }
  const markdown = composePersona(answers);
  const check = checkPersona(markdown);
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(DRAFT, JSON.stringify({ answers, markdown, check, at: new Date().toISOString() }, null, 2), "utf8");
  console.log(markdown);
  console.log("\n—— 自检：" + check.length + " 字，" + (check.warnings.length ? check.warnings.length + " 条提醒" : "没问题"));
  for (const w of check.warnings) console.log("   ⚠️ " + w);
  // 附录（现场 / 历史 / 说话素材）
  const extras = extrasFor(answers)
  const DIR = path.join(DATA, "persona-附录")
  if (Object.keys(extras).length) {
    fs.mkdirSync(DIR, { recursive: true })
    for (const [name, body] of Object.entries(extras)) {
      fs.writeFileSync(path.join(DIR, name), body, "utf8")
    }
    console.log("\n附录已写出：" + Object.keys(extras).join("、") + "（在 " + DIR + "）")
  }
  console.log("\n确认没问题就跑：node tools/00-setup/persona.mjs --apply");
  process.exit(check.warnings.length ? 1 : 0);
}

if (has("apply")) {
  const draft = readJson(DRAFT);
  if (!draft?.markdown) { console.error("还没有草稿：先跑 --answers"); process.exit(2) }
  let backup = null;
  if (fs.existsSync(TARGET)) {
    backup = TARGET + ".bak-" + Date.now();
    fs.copyFileSync(TARGET, backup);
  }
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(TARGET, draft.markdown, "utf8");
  console.log("已写入 " + TARGET + (backup ? "（旧文件备份：" + path.basename(backup) + "）" : ""));
  process.exit(0);
}

if (has("show")) {
  const draft = readJson(DRAFT);
  const cur = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, "utf8") : "";
  if (draft?.markdown) { console.log("== 草稿（未写入）==\n" + draft.markdown) }
  if (cur) { console.log("== 已写入的 persona.md（" + cur.length + " 字）==\n" + cur) }
  if (!draft && !cur) console.log("还没有人设：先跑 --questions 问，再 --answers 生成");
  process.exit(0);
}

console.log(`用法：
  node tools/00-setup/persona.mjs --questions        十个问题（给鱼照着问）
  node tools/00-setup/persona.mjs --rules            默认铁律\n  node tools/00-setup/persona.mjs --speech           说话风格题 + 默认台词手册\n  node tools/00-setup/persona.mjs --sets             现场/历史/素材 三块可选套
  node tools/00-setup/persona.mjs --answers a.json   生成人设草稿
  node tools/00-setup/persona.mjs --apply            写进 ~/.bili-ai/persona.md
  node tools/00-setup/persona.mjs --show             看草稿 / 已写入的那份`);
