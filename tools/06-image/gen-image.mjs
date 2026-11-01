#!/usr/bin/env node
// gen-image.mjs —— 通用生图 / 改图脚本（米芾用的那套流水线）
//
// 支持：
//   智谱   glm-image（画质好，带水印） / cogview-4（便宜，约 7 分一张）
//   阿里   wanx2.1-t2i-plus（万相，便宜稳） / wan2.7-image（能改图、能换画风）
//
// 用法：
//   # 文生图（便宜的先试）
//   node gen-image.mjs --prompt "一只橘猫在键盘上睡着" --provider zhipu --model cogview-4 --size 1152x1536
//
//   # 文生图（万相）
//   node gen-image.mjs --prompt "..." --provider dashscope --model wanx2.1-t2i-plus --size 720*1280
//
//   # 参考图改图 / 换画风（只有 wan2.7-image 支持）
//   node gen-image.mjs --ref portrait.jpg --prompt "只把画风改成精细手绘插画，其它不变" \
//        --provider dashscope --model wan2.7-image --size 720*1280
//
// 参数：
//   --prompt  提示词（必填）
//   --provider zhipu | dashscope（默认 zhipu）
//   --model    模型名（默认：zhipu=cogview-4，dashscope=wanx2.1-t2i-plus）
//   --size     尺寸，注意两家写法不同：智谱用 1152x1536，万相用 720*1280
//   --ref      参考图路径（只对 wan2.7-image 有效；小图会先放大到 1024 宽）
//   --out      输出路径（默认 ./out-<时间戳>.<自动判断后缀>）
//   --no-watermark  万相去水印（默认就去）
//
// Key 从 ~/.bili-ai/image-keys.json 读：
//   { "zhipu": "...", "dashscope": "..." }
// 也可以临时用环境变量 ZHIPU_KEY / DS_KEY 覆盖。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const arg = (name, def = null) => {
  const i = argv.indexOf("--" + name);
  return i > -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};
const flag = (name) => argv.includes("--" + name);

const prompt = arg("prompt");
if (!prompt) { console.error("缺少 --prompt"); process.exit(2) }

const provider = arg("provider", "zhipu");
const model = arg("model", provider === "zhipu" ? "cogview-4" : "wanx2.1-t2i-plus");
const size = arg("size", provider === "zhipu" ? "1152x1536" : "720*1280");
const ref = arg("ref");
const out = arg("out", path.join(process.cwd(), "out-" + Date.now()));

const KEYFILE = path.join(os.homedir(), ".bili-ai", "image-keys.json");
let keys = {};
try { keys = JSON.parse(fs.readFileSync(KEYFILE, "utf8")) } catch {}
const key = provider === "zhipu" ? (process.env.ZHIPU_KEY || keys.zhipu) : (process.env.DS_KEY || keys.dashscope);
if (!key) { console.error(`没有 ${provider} 的 key：写进 ${KEYFILE} 或用环境变量`); process.exit(2) }

// 按文件头判断真实格式，别信扩展名（接口经常给 JPEG 却叫 .png）
function extOf(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return ".jpg";
  if (buf[0] === 0x89 && buf[1] === 0x50) return ".png";
  if (buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP") return ".webp";
  return ".bin";
}
const mimeOf = (p) => p.endsWith(".webp") ? "image/webp" : p.endsWith(".png") ? "image/png" : "image/jpeg";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 智谱 ────────────────────────────────────────────────
async function zhipu() {
  const r = await fetch("https://open.bigmodel.cn/api/paas/v4/images/generations", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + key },
    body: JSON.stringify({ model, prompt, size })
  });
  const j = await r.json();
  const url = j?.data?.[0]?.url;
  if (!url) throw new Error("智谱返回异常：" + JSON.stringify(j).slice(0, 300));
  return Buffer.from(await (await fetch(url)).arrayBuffer());
}

// ── 阿里 DashScope ───────────────────────────────────────
async function dashscope() {
  const auth = { authorization: "Bearer " + key };

  if (model === "wan2.7-image") {
    // 同步调用（这个模型不支持异步头）
    const content = [];
    if (ref) {
      const buf = fs.readFileSync(ref);
      content.push({ image: `data:${mimeOf(ref)};base64,${buf.toString("base64")}` });
    }
    content.push({ text: prompt });
    const r = await fetch("https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation", {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ model, input: { messages: [{ role: "user", content }] }, parameters: { size, n: 1, watermark: !flag("no-watermark") } })
    });
    const j = await r.json();
    const url = j?.output?.choices?.[0]?.message?.content?.find?.((c) => c.image)?.image;
    if (!url) throw new Error("wan2.7-image 返回异常：" + JSON.stringify(j).slice(0, 300));
    return Buffer.from(await (await fetch(url)).arrayBuffer());
  }

  // 文生图（异步 + 轮询）
  const r = await fetch("https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis", {
    method: "POST",
    headers: { "content-type": "application/json", "X-DashScope-Async": "enable", ...auth },
    body: JSON.stringify({ model, input: { prompt }, parameters: { size, n: 1 } })
  });
  const j = await r.json();
  const id = j?.output?.task_id;
  if (!id) throw new Error("建任务失败：" + JSON.stringify(j).slice(0, 300));
  for (let i = 0; i < 60; i++) {
    await sleep(3000);
    const q = await (await fetch("https://dashscope.aliyuncs.com/api/v1/tasks/" + id, { headers: auth })).json();
    const st = q?.output?.task_status;
    if (st === "SUCCEEDED") {
      const url = q?.output?.results?.[0]?.url;
      if (!url) throw new Error("成功但没给地址");
      return Buffer.from(await (await fetch(url)).arrayBuffer());
    }
    if (st === "FAILED") throw new Error("任务失败：" + JSON.stringify(q?.output).slice(0, 300));
  }
  throw new Error("轮询超时");
}

const buf = provider === "zhipu" ? await zhipu() : await dashscope();
const finalOut = out.includes(".") ? out : out + extOf(buf);
fs.writeFileSync(finalOut, buf);
console.log("✓ " + finalOut + "  (" + Math.round(buf.length / 1024) + " KB, " + provider + "/" + model + ")");
