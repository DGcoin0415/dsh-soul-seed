// 接新模型前的体检：真发一句，看字到底回没回来。
// 目的不是测能力，是抓「接口通了、但正文被塞进思考里」这种闷声毛病。
//
// 用法：
//   node model-check.mjs --base https://xxx/v1 --key sk-xxx --model 模型名
//   node model-check.mjs --base ... --key ... --model ... --header "x-opencode-session:abc"

const args = {}
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i].replace(/^--/, '')
  args[k] = process.argv[i + 1]
}

const { base, key, model } = args
if (!base || !key || !model) {
  console.error('用法：node model-check.mjs --base <接口地址> --key <密钥> --model <模型名> [--header "名:值"]')
  process.exit(2)
}

const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }
if (args.header) {
  const [n, ...rest] = args.header.split(':')
  headers[n.trim()] = rest.join(':').trim()
}

const body = {
  model,
  messages: [{ role: 'user', content: '只回两个字：在的' }],
  max_tokens: 16,
  stream: false,
}

const t0 = Date.now()
let res
try {
  res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
} catch (e) {
  console.log(`✗ 连不上：${e.message}`)
  process.exit(1)
}

const ms = Date.now() - t0
const raw = await res.text()

if (!res.ok) {
  console.log(`✗ HTTP ${res.status}（${ms}ms）`)
  console.log('  ' + raw.slice(0, 300).replace(/\s+/g, ' '))
  process.exit(1)
}

let j
try {
  j = JSON.parse(raw)
} catch {
  console.log(`✗ 回来的不是 JSON：${raw.slice(0, 160)}`)
  process.exit(1)
}

const msg = j.choices?.[0]?.message ?? {}
const content = (msg.content ?? '').trim()
const reasoning = (msg.reasoning_content ?? msg.reasoning ?? '').trim()
const usage = j.usage ?? {}

const lines = [`用时 ${ms}ms`, `输入 ${usage.prompt_tokens ?? '?'} / 输出 ${usage.completion_tokens ?? '?'}`]

if (content) {
  console.log('✓ 正文正常')
  console.log('  ' + content.slice(0, 60).replace(/\s+/g, ' '))
  lines.forEach((l) => console.log('  ' + l))
  if (reasoning) console.log('  另带思考内容，正常')
  process.exit(0)
}

console.log('✗ 正文是空的')
if (reasoning) {
  console.log('  但思考字段里有字 —— 就是那个「字藏在思考里」的毛病，接进来会显示成没回话。')
  console.log('  片段：' + reasoning.slice(0, 80).replace(/\s+/g, ' '))
} else {
  console.log('  思考里也没字，八成是模型名不对或上游吞了。')
  console.log('  原文：' + raw.slice(0, 200).replace(/\s+/g, ' '))
}
lines.forEach((l) => console.log('  ' + l))
process.exit(1)
