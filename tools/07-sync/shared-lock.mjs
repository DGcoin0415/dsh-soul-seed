#!/usr/bin/env node
// shared-lock.mjs —— 共享目录的写锁（两台机器/两个进程同时改同一份文件时用）
//
//   node shared-lock.mjs acquire [--ttl 300] [--who me]
//   node shared-lock.mjs release
//   node shared-lock.mjs status
//
// 锁文件：~/.bili-ai/shared/.lock.json
// 过期：超过 ttl 秒视为陈旧锁，可被抢（防止崩了以后永远锁死）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = path.join(os.homedir(), ".bili-ai", "shared");
const FILE = path.join(DIR, ".lock.json");
const argv = process.argv.slice(2);
const cmd = argv[0] ?? "status";
const opt = (n, d = null) => { const i = argv.indexOf("--" + n); return i > -1 ? argv[i + 1] : d };
const ttl = Number(opt("ttl", 300)) * 1000;
const who = opt("who", os.hostname());
const now = Date.now();

fs.mkdirSync(DIR, { recursive: true });
const read = () => { try { return JSON.parse(fs.readFileSync(FILE, "utf8")) } catch { return null } };

if (cmd === "acquire") {
  const cur = read();
  if (cur && now - new Date(cur.at).getTime() < ttl && cur.who !== who) {
    console.error(`被占着：${cur.who}（${Math.round((ttl - (now - new Date(cur.at).getTime())) / 1000)} 秒后过期）`);
    process.exit(1);
  }
  const stale = cur && now - new Date(cur.at).getTime() >= ttl;
  fs.writeFileSync(FILE, JSON.stringify({ who, at: new Date().toISOString(), pid: process.pid }), "utf8");
  console.log((stale ? "抢到陈旧锁：" : "拿到锁：") + who);
} else if (cmd === "release") {
  const cur = read();
  if (!cur) { console.log("本来就没锁"); process.exit(0) }
  if (cur.who !== who) { console.error("不是你的锁：" + cur.who); process.exit(1) }
  fs.unlinkSync(FILE);
  console.log("放锁：" + who);
} else {
  const cur = read();
  if (!cur) { console.log("没锁"); process.exit(0) }
  const age = Math.round((now - new Date(cur.at).getTime()) / 1000);
  console.log(`锁着：${cur.who}，${age} 秒前（ttl ${ttl / 1000} 秒）`);
}
