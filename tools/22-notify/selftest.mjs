/**
 * 自检（不进 profile，不参与运行时）
 * 用法：node selftest.mjs [--send]
 *   --send 会真的发一条测试消息到 master 微信私聊
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createNotify } from './lib/core.mjs'
import { loadConfig, paths } from './lib/config.mjs'
import { pollYuyu } from './lib/sources.mjs'
import { wechatProbe } from './lib/wechat.mjs'
import { buildDailyNews } from './lib/news.mjs'
import { backlogSection, collectBacklog, renderBacklog } from './lib/backlog.mjs'
import { checkPlugins, renderHealthLine, entryOf } from './lib/health.mjs'
import { collectStale, renderStale } from './lib/stale.mjs'

const send = process.argv.includes('--send')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-notify-'))
const log = []
let failed = 0

function ok(name, cond, extra = '') {
  if (!cond) failed += 1
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' · ' + extra : ''}`)
}

// 0) 模块能加载
const mod = await import('./index.js')
ok('index.js 导出 apply/name', mod.name === 'dsh-notify' && typeof mod.apply === 'function')

// 1) 配置默认值
const cfg = loadConfig(tmp)
ok('默认每 10 分钟', cfg.intervalMin === 10, `intervalMin=${cfg.intervalMin}`)
ok('默认开关是开的', cfg.enabled === true)

// 2) 会话优先投递 + 去重
const delivered = []
const fakeAgents = {
  get: (id) => (id === 'sess-abc' ? { id, followup: (m) => delivered.push(m) } : null),
  list: () => [{ id: 'sess-abc', followup: (m) => delivered.push(m) }],
}
const n1 = createNotify({ workspace: tmp, agents: fakeAgents, logger: (l) => log.push(l) })
const r1 = await n1.push({ source: 'job', text: '后台任务跑完了：3 个文件已生成', sessionId: 'sess-abc' })
ok('投回发起会话', r1.ok && r1.channel.includes('sess-abc'), JSON.stringify(r1))
ok('会话收到消息', delivered.length === 1 && delivered[0].content[0].text.includes('3 个文件'))
const r2 = await n1.push({ source: 'job', text: '后台任务跑完了：3 个文件已生成', sessionId: 'sess-abc' })
ok('同内容不重复推', r2.ok === false && r2.reason === '重复', JSON.stringify(r2))

// 3) 投不进进 pending，不崩；下一轮重试成功后清空
fs.writeFileSync(
  path.join(tmp, '.notify-config.json'),
  JSON.stringify({ sources: { yuyu: false, inbox: true, news: false } }),
  'utf8',
)
fs.writeFileSync(path.join(tmp, '.yuyu-notify.json'), JSON.stringify({ enabled: true }), 'utf8')
const n2 = createNotify({ workspace: tmp })
const r3 = await n2.push({ source: 'tool', text: '会话不在的情况', sessionId: 'sess-gone' })
ok('会话不在时不算成功', r3.ok === false, JSON.stringify(r3))
const st1 = n2.readState()
ok('失败进 pending', st1.pending.length === 1, `pending=${st1.pending.length}`)
const fakeAgents2 = { get: () => ({ id: 'sess-gone', followup: () => {} }), list: () => [] }
n2.setAgents(fakeAgents2)
const pushed = await n2.tick()
const st2 = n2.readState()
ok('下一轮重试成功并清空 pending', st2.pending.length === 0 && st2.stats.pushed >= 1, JSON.stringify(st2.stats))

// 4) 开关能关
fs.writeFileSync(path.join(tmp, '.notify-config.json'), JSON.stringify({ enabled: false }), 'utf8')
const n3 = createNotify({ workspace: tmp })
const r4 = await n3.push({ source: 'tool', text: '关掉之后不该推' })
ok('开关关掉就不推', r4.ok === false && r4.reason.includes('关'), JSON.stringify(r4))

// 5) 老开关 .yuyu-notify.json 也能关
fs.writeFileSync(path.join(tmp, '.notify-config.json'), JSON.stringify({ enabled: true }), 'utf8')
fs.writeFileSync(path.join(tmp, '.yuyu-notify.json'), JSON.stringify({ enabled: false }), 'utf8')
ok('老开关同样生效', loadConfig(tmp).enabled === false)

// 6) 鱼世界通知能拉（真网络）
let yuyuOk = false
let yuyuCount = 0
try {
  const res = await pollYuyu({ cursor: '', envFiles: paths(tmp).yuyuEnvFiles })
  yuyuOk = Boolean(res.cursor)
  yuyuCount = res.items.length
} catch (e) {
  console.log('  鱼世界拉取失败：' + (e?.message || e))
}
ok('鱼世界 /v1/notify 能拉且带游标', yuyuOk, `items=${yuyuCount}`)

// 7) 微信通道自检（不打印凭据）
const probe = wechatProbe()
ok('微信通道凭据就位', probe.ok, probe.ok ? `account=${probe.account}` : probe.reason)

// 7.5) 今日新闻能组出来（链接不进正文，另存一份）
const tmpNews = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-notify-newsbuild-'))
process.env.DSH_NOTIFY_HOME = tmpNews
let news = null
try {
  news = await buildDailyNews({ day: '01-01', maxGeneral: 5, maxAi: 5 })
} catch (e) {
  console.log('  新闻组稿失败：' + (e?.message || e))
}
ok('今日新闻拉到内容', Boolean(news?.ok), news ? `要闻 ${news.general} 条 / AI ${news.ai} 条 / ${news.text.length} 字` : '')
ok('新闻正文不带链接', Boolean(news?.text) && !/https?:\/\//.test(news.text))
ok(
  '新闻链接另存 state/last-news.json',
  fs.existsSync(path.join(tmpNews, 'state', 'last-news.json')) || !news?.links?.length,
)
ok('新闻有 AI 那一节', Boolean(news?.text && news.text.includes('AI · DeepSeek · DSH')))

// 8) 新闻定时逻辑：到点推一次、当天不再推
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-notify-news-'))
fs.writeFileSync(
  path.join(tmp2, '.notify-config.json'),
  JSON.stringify({ sources: { yuyu: false, inbox: false, news: true }, newsAt: '00:00' }),
  'utf8',
)
const newsDelivered = []
const n4 = createNotify({
  workspace: tmp2,
  agents: { get: (id) => ({ id, followup: (m) => newsDelivered.push(m) }), list: () => [] },
})
n4.noteSession('sess-news', 'news')
const cfg4 = loadConfig(tmp2)
const st4 = n4.readState()
const r5 = await n4.maybePushNews(cfg4, st4)
ok('到点会推今日新闻', Boolean(r5), String(r5))
ok('新闻投回原会话', newsDelivered.length === 1 && newsDelivered[0].content[0].text.includes('今日新闻'))
ok('推完记下当天', n4.readState().lastNewsDay === new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10))
const r6 = await n4.maybePushNews(cfg4, n4.readState())
ok('当天不重复推', r6 === '' && newsDelivered.length === 1, String(r6))

// ---------------------------------------------------- 10. 早报附录①：今天接着干的
const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-notify-backlog-'))
fs.mkdirSync(path.join(tmp3, 'shared'), { recursive: true })
fs.writeFileSync(
  path.join(tmp3, 'shared', '任务.md'),
  [
    '# 任务',
    '| 日期 | 谁 | 任务 | 状态 | 到期/约定 | 备注 |',
    '| --- | --- | --- | --- | --- | --- |',
    '| 2026-11-26 | 面板 | 网页版 city3d 跟 MC 对齐（地形/路网/树/楼高） | 进行中 | 无 | 还差窗和招牌 |',
    '| 2026-11-26 | 面板 | 城市按真实比例扩容 | 待办 | 无 | 等平价时段 |',
    '| 2026-11-25 | 米萨 | 已经做完的活 | 完成 | 无 | 别列出来 |',
    '- [鱼世界] 去北坡菜园续租 82 号｜谁：微信｜状态：待办',
  ].join('\n'),
  'utf8',
)
fs.writeFileSync(
  path.join(tmp3, 'shared', '接续.md'),
  ['# 接续', '', '## 没完的', '', '- [11-27 11:23] 米萨：雨衣还没买到，等会儿出门买一把', '', '## 刚完成', ''].join('\n'),
  'utf8',
)
const bl = collectBacklog({ workspace: tmp3, max: 5 })
ok('抽到没完的活', bl.items.length >= 3, `${bl.items.length} 条`)
ok(
  '完成的不列',
  !bl.items.some((x) => x.summary.includes('已经做完的活')),
)
ok(
  '任务.md 和接续.md 都算上',
  bl.items.some((x) => x.tag.startsWith('任务')) && bl.items.some((x) => x.tag.startsWith('接续')),
)
const empty = renderBacklog({ items: [] })
ok('啥都没有就写「今天没有挂着的活」', empty.includes('今天没有挂着的活'), empty.trim())
// 预算：整段不超过原文 1/3
const longNews = 'x'.repeat(300)
const sec3 = backlogSection({ workspace: tmp3, max: 5, budget: Math.floor(longNews.length / 3) })
ok('附录受预算约束（≤ 原文 1/3）', sec3.length <= 100 + 120, `${sec3.length} 字 / 预算 ${Math.floor(longNews.length / 3)}`)

// ---------------------------------------- 10b. 早报附录②：插件体检（真目录真 import）
const health = await checkPlugins()
ok('插件目录扫到了', health.total >= 1, `${health.total} 个`)
ok('每个插件都有入口文件', health.broken.length === 0, health.broken.map((b) => `${b.name}（${b.error}）`).join('；') || '都活')
const healthFake = { total: 3, alive: ['a', 'b'], broken: [{ name: 'c', error: 'SyntaxError：坏在 1 行' }], warnings: [], profiles: [] }
ok('挂了的会点名+一句话原因', renderHealthLine(healthFake).includes('c（SyntaxError'))
ok('全活就一行', /插件 \d+ 个都在/.test(renderHealthLine(health)))
// 假挂件：index.js 语法坏 → 必须报红；lib/index.js 的包 → 不许误报
const tmpP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-notify-plugins-'))
fs.mkdirSync(path.join(tmpP, 'dsh-good'))
fs.writeFileSync(path.join(tmpP, 'dsh-good', 'index.js'), 'export const name = "good"\n', 'utf8')
fs.mkdirSync(path.join(tmpP, 'dsh-bad'))
fs.writeFileSync(path.join(tmpP, 'dsh-bad', 'index.js'), 'export const name = = "bad"\n', 'utf8')
fs.mkdirSync(path.join(tmpP, 'dsh-libmain', 'lib'), { recursive: true })
fs.writeFileSync(path.join(tmpP, 'dsh-libmain', 'package.json'), JSON.stringify({ name: 'dsh-libmain', main: 'lib/index.js' }), 'utf8')
fs.writeFileSync(path.join(tmpP, 'dsh-libmain', 'lib', 'index.js'), 'export const name = "libmain"\n', 'utf8')
const h2 = await checkPlugins({ pluginsDir: tmpP, profilesDir: path.join(tmpP, 'none') })
ok('坏的报红、好的活着', h2.broken.length === 1 && h2.broken[0].name === 'dsh-bad', JSON.stringify(h2.broken.map((b) => b.name)))
ok('main 指 lib/index.js 的包不算挂', h2.alive.includes('dsh-libmain'), h2.alive.join(','))
ok('entryOf 认得 lib/index.js', /lib[\\/]index\.js$/.test(entryOf(path.join(tmpP, 'dsh-libmain'))))

// ------------------------------------- 10c. 挂账检查：工单/任务挂 24 小时没动
const tmp4 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-notify-stale-'))
fs.mkdirSync(path.join(tmp4, 'shared', '历史'), { recursive: true })
const oldDay = new Date(Date.now() + 8 * 3600e3 - 3 * 24 * 3600e3).toISOString().slice(0, 10)
const midDay = new Date(Date.now() + 8 * 3600e3 - 2 * 24 * 3600e3).toISOString().slice(0, 10)
const todayDay = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
fs.writeFileSync(
  path.join(tmp4, 'shared', '工单.md'),
  [
    '# 工单',
    '| 日期 | 房间 | 客户 | 问题 | 状态 |',
    '| --- | --- | --- | --- | --- |',
    `| ${oldDay} 09:05 | 1801 | 张三 | U 盘制作 | 待处理 |`,
    `| ${oldDay} 10:00 | 1802 | 李四 | 已搞定的 | 已处理 |`,
    `| ${todayDay} 11:00 | 1803 | 王五 | 今天刚开的 | 待处理 |`,
  ].join('\n'),
  'utf8',
)
fs.writeFileSync(
  path.join(tmp4, 'shared', '任务.md'),
  [
    '| 日期 | 谁 | 任务 | 状态 | 到期/约定 | 备注 |',
    '| --- | --- | --- | --- | --- | --- |',
    `| ${midDay} | 面板 | 挂住没动的活 | 进行中 | 无 | 历史里没人提 |`,
    `| ${midDay} | 面板 | 有人提过的活 | 待办 | 无 | 刚聊过 |`,
    `| ${midDay} | 面板 | 长期常态的活 | 进行中 | 长期 | 不算挂住 |`,
  ].join('\n'),
  'utf8',
)
fs.writeFileSync(path.join(tmp4, 'shared', '接续.md'), '- [11-27] 米萨：有人提过的活 还在弄呢\n', 'utf8')
const st = collectStale({ workspace: tmp4, hours: 24, max: 5 })
ok('工单：只报「待处理」且超过 24 小时的', st.orders.length === 1 && st.orders[0].room === '1801', JSON.stringify(st.orders.map((o) => o.room)))
ok('任务：报挂住的', st.tasks.some((t) => t.summary.includes('挂住没动的活')), st.tasks.map((t) => t.summary).join('｜'))
ok('最近提过的不报', !st.tasks.some((t) => t.summary.includes('有人提过的活')))
ok('到期写「长期」的不报', !st.tasks.some((t) => t.summary.includes('长期常态的活')))
const stText = renderStale(st, '2026-11-27')
ok('推送文案带单数和条数', stText.includes('工单还挂着 1 单') && stText.includes('1801'), stText.split('\n')[2])

// ------------------------- 10d. 接进真推送：早报附录 / 挂账每天一次 / 开关能关
const tmp5 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-notify-digest-'))
fs.cpSync(path.join(tmp3, 'shared'), path.join(tmp5, 'shared'), { recursive: true })
fs.cpSync(path.join(tmp4, 'shared'), path.join(tmp5, 'shared'), { recursive: true })
fs.writeFileSync(
  path.join(tmp5, '.notify-config.json'),
  JSON.stringify({ sources: { yuyu: false, inbox: false, news: true }, newsAt: '00:00', staleAt: '00:00' }),
  'utf8',
)
const got = []
const n5 = createNotify({
  workspace: tmp5,
  agents: { get: (id) => ({ id, followup: (m) => got.push(m.content[0].text) }), list: () => [] },
})
n5.noteSession('sess-digest', 'digest')
const cfg5 = loadConfig(tmp5)
ok('四个新开关默认都开', cfg5.digestBacklog && cfg5.digestHealth && cfg5.staleCheck && cfg5.staleAt === '00:00', JSON.stringify({ a: cfg5.digestBacklog, b: cfg5.digestHealth, c: cfg5.staleCheck }))
const body = await n5.appendDigest('【今日新闻】' + '内容'.repeat(300), cfg5)
ok('早报末尾接上了「今天接着干的」', body.includes('今天接着干的'), body.split('\n').filter((l) => l.startsWith('•')).length + ' 条')
ok('早报末尾接上了插件体检那行', /插件 \d+ 个都在|插件挂了/.test(body))
ok('附录不超过原文 1/3', body.length - ('【今日新闻】' + '内容'.repeat(300)).length <= Math.floor(1806 / 3) + 80, `${body.length} 字`)

const rStale = await n5.maybePushStale(cfg5, n5.readState())
ok('到点会推挂账提醒', Boolean(rStale), String(rStale))
ok('挂账提醒投回会话', got.some((t) => t.includes('挂着的活')), got.at(-1)?.split('\n')[0])
const rStale2 = await n5.maybePushStale(cfg5, n5.readState())
ok('同一天只推一次', rStale2 === '', `第二次=${rStale2 || '(没推)'}`)
ok('记下当天', n5.readState().lastStaleDay === new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10))

// 关掉：三个开关都关 → 不追加、不推
const tmp6 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-notify-off-'))
fs.cpSync(path.join(tmp5, 'shared'), path.join(tmp6, 'shared'), { recursive: true })
fs.writeFileSync(
  path.join(tmp6, '.notify-config.json'),
  JSON.stringify({ digestBacklog: false, digestHealth: false, staleCheck: false, staleAt: '00:00' }),
  'utf8',
)
const n6 = createNotify({ workspace: tmp6 })
const offCfg = loadConfig(tmp6)
const offBody = await n6.appendDigest('【今日新闻】正文', offCfg)
ok('digestBacklog/digestHealth 关掉就不追加', offBody === '【今日新闻】正文', offBody)
ok('staleCheck 关掉就不查', (await n6.maybePushStale(offCfg, n6.readState(), { force: true })) === '')
try {
  fs.rmSync(tmpP, { recursive: true, force: true })
} catch {}

// 11) 真的发一条
if (send) {
  const real = createNotify({ workspace: paths().workspace })
  const text = '【测试】dsh-notify 主动推送通道实测：这条是插件装好前的自检消息，收到就说明发信链路通了。'
  const r = await real.push({ source: 'selftest', text })
  ok('真发一条到微信私聊', r.ok, JSON.stringify(r))
}

console.log(failed ? `\n有 ${failed} 项没过` : '\n全部通过')
console.log('临时工作区：' + tmp)
process.exit(failed ? 1 : 0)
