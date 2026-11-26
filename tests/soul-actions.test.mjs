// tests/soul-actions.test.mjs —— 0.15.1-test 补的九个 action 各跑一次。
// 全在临时目录里跑：DSH_SHARED_DIR / DSH_SOUL_DIR / HOME 都指过去，绝不碰真数据。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const problems = []
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : detail ? ` — ${detail}` : ''}`)
  if (!ok) problems.push(name)
}

// 临时根目录：默认系统临时区；受限环境（只允许写工作区）用 SOUL_TEST_TMP 指过去。
const tmpRoot = process.env.SOUL_TEST_TMP || os.tmpdir()
fs.mkdirSync(tmpRoot, { recursive: true })
const tmp = fs.mkdtempSync(path.join(tmpRoot, 'soul-actions-'))
process.env.HOME = tmp
process.env.USERPROFILE = tmp
process.env.DSH_SHARED_DIR = path.join(tmp, 'im')
process.env.DSH_SOUL_DIR = path.join(tmp, 'soul-seed')
delete process.env.SOUL_HOME
delete process.env.ZHIPU_API_KEY
delete process.env.DASHSCOPE_API_KEY

const ws = process.env.DSH_SHARED_DIR
const soul = process.env.DSH_SOUL_DIR
fs.mkdirSync(path.join(ws, 'shared', 'people'), { recursive: true })
fs.mkdirSync(path.join(ws, 'shared', '历史'), { recursive: true })
fs.mkdirSync(path.join(ws, 'shared', '规矩'), { recursive: true })
fs.mkdirSync(soul, { recursive: true })

const rootText = '# 人工灵魂 · 测试根页\n\n- 这是一份测试用的根页。\n'
fs.writeFileSync(path.join(ws, 'SHARED-STATE.md'), rootText)
fs.writeFileSync(path.join(ws, 'shared', '规矩', '测试枝.md'), '# 测试枝\n\n这里写了一句能检索的话：半夜不睡。\n')

const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString()
const ledgerV1 = {
  version: 1,
  global: { affinity: 55, mood: '平静' },
  people: {
    'qq:1001': {
      name: '老大',
      affinity: 100,
      mood: '平静',
      firstSeen: hoursAgo(100),
      lastSeen: hoursAgo(2),
      encounters: 3,
      notes: [{ at: hoursAgo(2), kind: 'trait', summary: '嫌咱话多' }],
      moodScore: 80,
      moodAt: hoursAgo(1),
    },
    'qq:1002': {
      name: '小号',
      affinity: 40,
      mood: '烦',
      firstSeen: hoursAgo(50),
      lastSeen: hoursAgo(4),
      encounters: 1,
      notes: [],
      moodScore: 10,
      moodAt: hoursAgo(3),
    },
  },
  links: [],
  grudgeThreshold: 30,
}
const ledgerPath = path.join(ws, 'shared', 'people', 'people.json')
fs.writeFileSync(ledgerPath, JSON.stringify(ledgerV1, null, 2))

const tracksPath = path.join(ws, 'shared', '轨道.json')
fs.writeFileSync(
  tracksPath,
  JSON.stringify(
    {
      version: 1,
      tracks: [
        { name: '出图', keywords: ['生图'], steps: ['查家底', '出图'], fallback: '走云端', uses: 0, fails: 0, updated: '2026-11-26T00:00:00+08:00' },
      ],
    },
    null,
    2,
  ),
)

const { runSoulAction, ACTIONS } = await import('../lib/actions.mjs')
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))

// 1. where
const where = (await runSoulAction({ action: 'where' })).message
check('where 报记忆目录', where.includes(`记忆目录：${ws}`), where)
check(
  'where 报根页字节',
  /根页：\d+ 字节/.test(where) && Number(where.match(/根页：(\d+)/)[1]) === Buffer.byteLength(rootText),
  where,
)
check('where 报账本路径', where.includes(ledgerPath), where)

// 2. read（顺手记一条翻叶）
await runSoulAction({ action: 'read', file: '规矩/测试枝.md' })

// 3. person-get
const get1 = (await runSoulAction({ action: 'person-get', key: 'qq:1001' })).message
check(
  'person-get 读 v1 账本',
  get1.includes('老大（qq:1001）') &&
    get1.includes('好感 100') &&
    get1.includes('心情分 80') &&
    get1.includes('见面 3 次') &&
    get1.includes('最近一条：嫌咱话多'),
  get1,
)
const get2 = (await runSoulAction({ action: 'person-get', key: 'qq:1002' })).message
check('person-get 低于门槛给提示', get2.includes('⚠'), get2)
const get3 = (await runSoulAction({ action: 'person-get', key: 'qq:9999' })).message
check('person-get 没这个人', get3.includes('账本里还没有'), get3)

// 4. person-bump
const bump = (await runSoulAction({ action: 'person-bump', key: 'qq:1001', delta: -3 })).message
const afterBump = readJson(ledgerPath).people['qq:1001']
check('person-bump 返回新好感', bump.includes('好感 → 97'), bump)
check('person-bump 保留 v1 格式', afterBump.affinity === 97 && !('goodwill' in afterBump), JSON.stringify(afterBump))

// 5. person-mood
const mood = (await runSoulAction({ action: 'person-mood', key: 'qq:1001', score: 20, label: '烦', intent: '故意' })).message
const afterMood = readJson(ledgerPath).people['qq:1001']
check('person-mood 返回分数和标签', mood.includes('心情 → 20（烦）') && mood.includes('记着了'), mood)
check('person-mood 写回 v1 字段', afterMood.moodScore === 20 && afterMood.mood === '烦' && afterMood.intent === '故意', JSON.stringify(afterMood))

// 6. decay：qq:1002 的 10 分在 3 小时前，正好一个半衰期 → 30
const decay = (await runSoulAction({ action: 'decay' })).message
const afterDecay = readJson(ledgerPath)
check('decay 返回变动人数', decay.includes('变动 1 人'), decay)
check('decay 按半衰期回落到 30', afterDecay.people['qq:1002'].moodScore === 30, String(afterDecay.people['qq:1002'].moodScore))

// 7. leaves
const leaves = (await runSoulAction({ action: 'leaves' })).message
check('leaves 有读枝记录', leaves.includes('读枝') && leaves.includes('测试枝.md'), leaves)

// 8. tidy
const tidyMsg = (await runSoulAction({ action: 'tidy' })).message
check('tidy 返回三项数字', /修枝：截断 \d+ 行，归档 \d+ 份，索引新增 \d+ 块/.test(tidyMsg), tidyMsg)

// 9. track-list / track-bump
const list = (await runSoulAction({ action: 'track-list' })).message
check('track-list 列出轨道', list.includes('出图') && list.includes('用过 0 次'), list)
const bump1 = (await runSoulAction({ action: 'track-bump', query: '出图', ok: true })).message
check('track-bump 跑通', bump1.includes('跑通') && bump1.includes('用过 1 次'), bump1)
const bump2 = (await runSoulAction({ action: 'track-bump', query: '出图', ok: false })).message
check('track-bump 失败计数', bump2.includes('没跑通') && bump2.includes('用过 2 次') && bump2.includes('失败 1 次'), bump2)

// 10. v2 回落：清掉工作区账本，soul-seed 放 v2 账本
fs.rmSync(ledgerPath)
const soulLedger = {
  version: 2,
  people: {
    'qq:2001': {
      id: 'qq:2001',
      nickname: '二号',
      goodwill: 88,
      mood: 12,
      meets: 5,
      firstAt: hoursAgo(30),
      lastAt: hoursAgo(1),
      habits: [],
      events: [{ at: hoursAgo(3), kind: 'mood', delta: -20, why: '骂咱' }],
      favors: [],
      secrets: [],
    },
  },
  links: [],
}
fs.writeFileSync(path.join(soul, 'people.json'), JSON.stringify(soulLedger, null, 2))
const v2get = (await runSoulAction({ action: 'person-get', key: 'qq:2001' })).message
check(
  'person-get 回落读 v2 账本',
  v2get.includes('好感 88') && v2get.includes('心情分 12') && v2get.includes('见面 5 次') && v2get.includes('最近一条：骂咱'),
  v2get,
)
const v2bump = (await runSoulAction({ action: 'person-bump', key: 'qq:2001', delta: -8 })).message
const v2after = readJson(path.join(soul, 'people.json')).people['qq:2001']
check(
  'person-bump 写回 v2 格式',
  v2bump.includes('好感 → 80') && v2after.goodwill === 80 && typeof v2after.mood === 'number' && !('affinity' in v2after),
  JSON.stringify(v2after),
)
const v2decayFile = path.join(soul, 'people.json')
const v2beforeDecay = readJson(v2decayFile)
v2beforeDecay.people['qq:2001'].lastAt = hoursAgo(3) // person-bump 把 lastAt 刷成了现在，这里倒回 3 小时再衰减
fs.writeFileSync(v2decayFile, JSON.stringify(v2beforeDecay, null, 2))
const v2decay = (await runSoulAction({ action: 'decay' })).message
const v2decayAfter = readJson(v2decayFile).people['qq:2001']
check('decay 认 v2 的 mood 数字', v2decay.includes('变动 1 人') && v2decayAfter.mood === 31, `${v2decay} / ${v2decayAfter.mood}`)

// 11. 未知 action + 模块 import
const unknown = (await runSoulAction({ action: 'nope' })).message
check('未知 action 有回话', unknown.includes('未知 action'), unknown)
const mod = await import('../lib/index.js')
check('index.js import 通过', mod.default?.name === 'dsh-soul-seed' && typeof mod.default.apply === 'function')
check('ACTIONS 是 15 个', ACTIONS.length === 15, String(ACTIONS.length))

// 12. 共享工作区定位规则（local-env.mjs）
const { sharedBase } = await import('../lib/local-env.mjs')
const explicit = path.join(tmp, 'somewhere')
process.env.DSH_SHARED_DIR = explicit
check('DSH_SHARED_DIR 优先', sharedBase() === explicit, sharedBase())
delete process.env.DSH_SHARED_DIR
process.env.SOUL_HOME = path.join(tmp, 'soul-home')
check('SOUL_HOME 次之', sharedBase() === path.resolve(process.env.SOUL_HOME), sharedBase())
delete process.env.SOUL_HOME
fs.mkdirSync(path.join(tmp, '.dsh', 'im'), { recursive: true })
check('都没设时默认指 ~/.dsh/im', sharedBase() === path.join(tmp, '.dsh', 'im'), sharedBase())
fs.rmSync(path.join(tmp, '.dsh'), { recursive: true, force: true })
check('本机没有 ~/.dsh/im 才回落 soul-seed', sharedBase() === soul, sharedBase())

fs.rmSync(tmp, { recursive: true, force: true })
if (problems.length) {
  console.log(`  ✗ ${problems.length} 项没过：${problems.join('、')}`)
  process.exit(1)
}
console.log('  ✓ 九个 action 全过')
