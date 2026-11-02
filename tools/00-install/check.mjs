#!/usr/bin/env node
// 灵魂种子 · 装机自检
// 只读检测，不写任何文件；用来确认「第一次装」这一步会不会翻车。
// 用法：node tools/00-install/check.mjs [--json]

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

const HOME = os.homedir()
const DSH = path.join(HOME, '.dsh')
const PROFILES = path.join(DSH, 'profiles')
const PLUGIN_NAME = 'dsh-soul-seed'

const rows = []
const add = (level, item, detail, fix) => rows.push({ level, item, detail, fix })

function exists(p) {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

// 1) Node 版本
const need = 20
const major = Number(process.versions.node.split('.')[0])
if (major >= need) add('ok', 'Node 版本', `v${process.versions.node}`)
else add('fail', 'Node 版本', `v${process.versions.node}，要 >= ${need}`, `升级 Node 到 ${need}+`)

// 2) DSH 目录
if (exists(DSH)) add('ok', 'DSH 目录', DSH)
else add('fail', 'DSH 目录', '找不到 ~/.dsh，这台机器没装过 DSH', '先装 DSH 再种')

// 3) profile
const profiles = exists(PROFILES) ? fs.readdirSync(PROFILES).filter((d) => exists(path.join(PROFILES, d, 'package.json'))) : []
if (profiles.length) add('ok', 'profile', profiles.join(', '))
else add('fail', 'profile', '没有可用的 profile', '先用 DSH 桌面版跑一次')

// 4) 本地是否已装插件
let installed = null
for (const pf of profiles) {
  const nm = path.join(PROFILES, pf, 'node_modules', PLUGIN_NAME)
  if (exists(nm)) {
    const pkg = readJson(path.join(nm, 'package.json'))
    installed = { profile: pf, version: pkg?.version ?? '?' }
    break
  }
}
// 也要认出 link 到本地目录的情况
if (!installed) {
  for (const pf of profiles) {
    const pkgPath = path.join(PROFILES, pf, 'package.json')
    const pkg = readJson(pkgPath)
    if (pkg?.dependencies?.[PLUGIN_NAME]) {
      installed = { profile: pf, version: pkg.dependencies[PLUGIN_NAME], linked: true }
      break
    }
  }
}
if (installed) add('ok', '插件', `${installed.profile} · ${installed.version}${installed.linked ? '（link）' : ''}`)
else add('warn', '插件', '还没装', `dsh plugin --profile <profile> add ${PLUGIN_NAME}`)

// 5) 已有的灵魂资产（决定首次 / 非首次）
const marks = {
  人设: path.join(DSH, 'persona-cards'),
  记忆: path.join(DSH, 'persona-cards', 'memories'),
  灵魂目录: path.join(DSH, 'im', 'shared'),
  账本: path.join(HOME, '.bili-ai', 'people.json'),
}
const present = Object.entries(marks).filter(([, p]) => exists(p)).map(([k]) => k)
if (present.length >= 2) add('ok', '已有资产', `${present.join('、')} → 会走「学本地的」，不覆盖`)
else if (present.length === 0) add('ok', '已有资产', '空的，会走首次初始化十问')
else add('warn', '已有资产', `只有 ${present.join('、')}，属于半新半旧`, '先备份再跑，避免只补一半')

// 6) DSH 版本能不能读出来（接口断裂最常见的表现）
let dshVersion = null
for (const p of [path.join(DSH, 'profiles'), path.join(DSH, '..')]) {
  const v = path.join(p, 'version')
  if (exists(v)) {
    try {
      dshVersion = fs.readFileSync(v, 'utf8').trim()
      break
    } catch {}
  }
}
if (dshVersion) add('ok', 'DSH 版本', dshVersion)
else add('info', 'DSH 版本', '没读到版本文件，不影响装，只是出问题不好对版本')

// 7) 关键依赖：面板是否 404 的常见原因是包名不一致
const patch = path.join(profiles[0] ? path.join(PROFILES, profiles[0]) : '', 'node_modules', PLUGIN_NAME, 'cordis.patch.yml')
if (exists(patch)) {
  const text = fs.readFileSync(patch, 'utf8')
  if (text.includes(PLUGIN_NAME)) add('ok', '补丁包名', '一致')
  else add('fail', '补丁包名', 'cordis.patch.yml 里的 name 跟包名对不上', `把 name 改成 ${PLUGIN_NAME}`)
}

// 输出
const json = process.argv.includes('--json')
if (json) {
  console.log(JSON.stringify(rows, null, 2))
} else {
  const icon = { ok: '✓', warn: '!', fail: '×', info: '·' }
  console.log('\n灵魂种子 · 装机自检\n')
  for (const r of rows) {
    console.log(`${icon[r.level] ?? ' '} ${r.item}: ${r.detail}`)
    if (r.fix) console.log(`   → ${r.fix}`)
  }
  const bad = rows.filter((r) => r.level === 'fail').length
  console.log(bad ? `\n${bad} 项挡着装，先处理上面标 × 的。` : '\n没拦路的，可以种。')
}

process.exit(rows.some((r) => r.level === 'fail') ? 1 : 0)
