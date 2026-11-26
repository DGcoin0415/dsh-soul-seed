#!/usr/bin/env node
import { soulHome } from '../../lib/home.mjs'
// backup.mjs —— 一键把这些东西打包（不给平台添麻烦：Windows 用 Compress-Archive，其它用 tar）
//
//   node tools/08-ops/backup.mjs                打包到 ~/Downloads (或 ~)
//   node tools/08-ops/backup.mjs --out D:\bak   指定目录
//   node tools/08-ops/backup.mjs --list         看现有备份
//
// 打进去的：mood / people / memory / history / scene / persona.md + 附录 / 运行状态
// 不打的：任何 key、cookie、凭据
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const DIR = soulHome();
const argv = process.argv.slice(2);
const opt = (n, d = null) => { const i = argv.indexOf("--" + n); return i > -1 ? argv[i + 1] : d };
const outDir = opt("out", "") || (fs.existsSync(path.join(os.homedir(), "Downloads")) ? path.join(os.homedir(), "Downloads") : os.homedir());
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const zipPath = path.join(outDir, `soul-backup-${stamp}.zip`);

const INCLUDED = [
  "mood.json", "people.json", "memory.json", "persona.md", "运行状态.txt",
  "persona-附录", "history", "scene"
];

if (argv.includes("--list")) {
  const list = fs.readdirSync(outDir).filter((f) => f.startsWith("soul-backup-") && f.endsWith(".zip"));
  if (!list.length) console.log("还没有备份");
  for (const f of list) {
    const p = path.join(outDir, f);
    console.log(`  ${f}  ${(fs.statSync(p).size / 1024).toFixed(0)} KB  ${fs.statSync(p).mtime.toLocaleString("sv-SE")}`);
  }
  process.exit(0);
}

// 先把要打的收进临时目录（避免把 key 之类带进去）
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "soul-backup-"));
let n = 0;
for (const rel of INCLUDED) {
  const src = path.join(DIR, rel);
  if (!fs.existsSync(src)) continue;
  const dst = path.join(stage, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (fs.statSync(src).isDirectory()) {
    fs.cpSync(src, dst, { recursive: true });
  } else {
    fs.copyFileSync(src, dst);
  }
  n++;
}
if (!n) { console.error("没有可备份的数据（~/.dsh/soul-seed 还是空的）"); process.exit(1) }

fs.mkdirSync(outDir, { recursive: true });
if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

try {
  if (process.platform === "win32") {
    execFileSync("powershell.exe", [
      "-NoProfile", "-Command",
      `Compress-Archive -Path '${stage}\\*' -DestinationPath '${zipPath}' -CompressionLevel Optimal`
    ], { stdio: "ignore" });
  } else {
    execFileSync("tar", ["-czf", zipPath.replace(/\.zip$/, ".tar.gz"), "-C", stage, "."], { stdio: "ignore" });
  }
  const final = fs.existsSync(zipPath) ? zipPath : zipPath.replace(/\.zip$/, ".tar.gz");
  console.log(`备份完成：${final}  ${(fs.statSync(final).size / 1024).toFixed(0)} KB  （${n} 项）`);
} catch (e) {
  console.error("打包失败：" + e.message);
  console.log("退路：把整个 " + stage + " 目录手动拷走，里面有 " + n + " 项");
  process.exit(1);
} finally {
  // 只清临时目录里的散文件，zip 已落到 outDir
  try { fs.rmSync(stage, { recursive: true, force: true }) } catch {}
}
