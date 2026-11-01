#!/usr/bin/env node
// soul.mjs —— 灵魂打包 / 载入（命令行）
//
//   node tools/09-soul/soul.mjs status            现在这具躯体里有什么
//   node tools/09-soul/soul.mjs export [--out 目录]
//   node tools/09-soul/soul.mjs import <灵魂包.zip>
//   node tools/09-soul/soul.mjs auto              起躯体时自动载入（插件启动会自己调）
//
// 灵魂 = 人设 + 附录 + 记忆 + 账本 + 心情 + 历史 + 现场
// 绝不打包：credentials.json / image-keys.json / cookies
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exportSoul, importSoul, autoImport, soulStats, wasLoaded, SOUL_ITEMS, NEVER_PACK } from "../../lib/soul.mjs";

const dataDir = path.join(os.homedir(), ".bili-ai");
const argv = process.argv.slice(2);
const cmd = argv[0] ?? "status";
const pos = argv.slice(1).filter((a) => !a.startsWith("--"));
const opt = (n, d = null) => { const i = argv.indexOf("--" + n); return i > -1 ? argv[i + 1] : d };

const fmt = (s) => Object.entries(s).map(([k, v]) => `  ${k}：${v}`).join("\n");

if (cmd === "status") {
  const st = soulStats(dataDir);
  console.log("这具躯体里：");
  console.log(fmt(st));
  const loaded = wasLoaded(dataDir);
  if (loaded) console.log(`\n上次载入灵魂：${loaded.at.slice(0, 16).replace("T", " ")}（${loaded.zip}）`);
  const pending = (() => { try { return fs.readdirSync(dataDir).filter((f) => /^soul-pack.*\.zip$/i.test(f)) } catch { return [] } })();
  if (pending.length) console.log("\n⚠️ 有灵魂包等着载入：" + pending.join("、") + "（跑 auto）");
  console.log("\n进包的：" + SOUL_ITEMS.join("、"));
  console.log("永不进包：" + NEVER_PACK.join("、"));
} else if (cmd === "export") {
  const outDir = opt("out", "") || (fs.existsSync(path.join(os.homedir(), "Downloads")) ? path.join(os.homedir(), "Downloads") : os.homedir());
  const r = exportSoul({ dataDir, outDir, name: opt("name", "soul-pack") });
  if (!r.ok) { console.error(r.error); process.exit(1) }
  console.log("灵魂包：" + r.zipPath);
  console.log(fmt(r.stats));
} else if (cmd === "import") {
  const zip = pos[0];
  if (!zip) { console.error('用法：node tools/09-soul/soul.mjs import <灵魂包.zip>'); process.exit(2) }
  const r = importSoul({ dataDir, zipPath: path.resolve(zip) });
  if (!r.ok) { console.error(r.error); process.exit(1) }
  console.log("载入了：" + r.incoming.join("、"));
  console.log("之前：\n" + fmt(r.before));
  console.log("现在：\n" + fmt(r.after));
  if (r.backup) console.log("旧灵魂已备份：" + r.backup);
} else if (cmd === "auto") {
  const r = autoImport({ dataDir });
  if (r.reason === "NO_PACK") { console.log("没有待载入的灵魂包"); process.exit(0) }
  if (!r.ok) { console.error(r.error); process.exit(1) }
  console.log("自动载入完成：" + r.incoming.join("、"));
  console.log(fmt(r.after));
} else {
  console.log(`用法：
  node tools/09-soul/soul.mjs status
  node tools/09-soul/soul.mjs export [--out 目录] [--name soul-pack]
  node tools/09-soul/soul.mjs import <灵魂包.zip>
  node tools/09-soul/soul.mjs auto`);
}
