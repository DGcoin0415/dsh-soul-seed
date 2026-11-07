// tests/hop.test.mjs —— 顺藤的种子词抽取
import { pickSeedTerms } from "../lib/hop.mjs";

let bad = 0;
function ok(cond, msg) {
  console.log("  " + (cond ? "✓ " : "✗ ") + msg);
  if (!cond) bad++;
}

const seeds = pickSeedTerms(
  ["QQ NT（Electron）主动关掉了无障碍树，用 UI Automation 也读不到文本节点。", "代替截图 + 看图"],
  ["qq", "无障碍"]
);
ok(seeds.length > 0, "能抽出种子词（" + seeds.length + " 个）");
ok(seeds.length <= 4, "最多 4 个");
ok(!seeds.includes("qq"), "查询里已有的词不重复抽");
ok(!seeds.some((s) => /^[a-z]+$/.test(s) && ["files", "program", "exe"].includes(s)), "路径碎词不进种子");

const withIdent = pickSeedTerms(["这次改用 memory-find.mjs 和 turnlog 串起来"], []);
ok(withIdent.some((s) => /memory|turnlog|find/.test(s)), "英文标识符会被抽出来");

ok(pickSeedTerms([], []).length === 0, "空输入不炸");
ok(pickSeedTerms(["的", "了", "是"], []).length === 0, "全是虚词时抽不到");

process.exit(bad ? 1 : 0);
