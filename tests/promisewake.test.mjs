// tests/promisewake.test.mjs —— 醒来要能看见没做完的约定
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openPromises } from "../lib/wake.mjs";

let bad = 0;
function ok(cond, msg) {
  console.log("  " + (cond ? "✓ " : "✗ ") + msg);
  if (!cond) bad++;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-"));
const write = (items) => fs.writeFileSync(path.join(dir, "memory.json"), JSON.stringify({ version: 1, items }), "utf8");

write([{ kind: "promise", text: "周五交表", at: "2026-11-09", status: "待办" }]);
const a = openPromises(dir);
ok(a.includes("周五交表"), "未完成的约定会出现");
ok(a.includes("2026-11-09"), "期限一起带上");
ok(a.includes("待办约定"), "有标题");

write([{ kind: "promise", text: "已经办完", status: "完成" }]);
ok(openPromises(dir) === "", "全完成时不吵人");

write([{ kind: "fact", text: "普通记忆不该出现在这里" }]);
ok(openPromises(dir) === "", "普通记忆不算约定");

fs.rmSync(dir, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
