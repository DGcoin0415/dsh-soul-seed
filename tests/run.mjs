// tests/run.mjs —— 跑全部测试：node tests/run.mjs（或 npm test）
// 每个测试都在临时 HOME 里跑，绝不碰真数据。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const ROOT = path.dirname(HERE);
const NODE = process.execPath;

const files = fs.readdirSync(HERE).filter((f) => f.endsWith(".test.mjs")).sort();
let pass = 0, fail = 0;

for (const file of files) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "seed-test-"));
  try {
    const { stdout, stderr } = await exec(NODE, [path.join(HERE, file)], {
      env: { ...process.env, USERPROFILE: tmp, HOME: tmp },
      timeout: 60000
    });
    const lines = (stdout || "").split("\n").filter((l) => l.startsWith("  "));
    const bad = lines.filter((l) => l.includes("✗"));
    if (bad.length) throw new Error(bad.join("；") || stderr);
    console.log(`✓ ${file}`);
    for (const l of lines) console.log(l);
    pass++;
  } catch (e) {
    console.log(`✗ ${file}`);
    console.log("  " + String(e.message || e).split("\n").slice(0, 6).join("\n  "));
    fail++;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`\n${pass} 通过 · ${fail} 失败 · 共 ${files.length} 个测试文件`);
process.exit(fail ? 1 : 0);
