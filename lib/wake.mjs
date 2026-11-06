// 名字叫醒：盯一个标记文件，发现有人喊名字就往「已打开的那个会话」里投一句。
// 依据：DSH 的 session/prompt 只认客户端已经打开的会话；QQ 私聊会话正是这种，所以能投。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const DEFAULT_POLL_MS = 3000
const MAX_ATTEMPTS = 3
// 标记最多活这么久，超了就丢。跟微信那边待发队列一个规矩：卡住的不许一直重试。
const STALE_MS = 10 * 60 * 1000

function readFlag(file) {
  try {
    const st = fs.statSync(file)
    const raw = fs.readFileSync(file, 'utf8').trim()
    if (!raw) return null
    const [at, ...rest] = raw.split('|')
    return { at, text: rest.join('|').trim(), mtimeMs: st.mtimeMs }
  } catch {
    return null
  }
}

function clearFlag(file) {
  try { fs.unlinkSync(file) } catch {}
}

/**
 * @param {object} opts
 * @param {() => string|undefined} opts.getController 惰性取 sessionController
 * @param {() => string[]} opts.getSessionIds 取要投的会话 id（按优先级）
 * @param {string} opts.flagFile 标记文件
 * @param {(msg: string) => void} [opts.log]
 */
export function startNameWake({ getController, getSessionIds, flagFile, pollMs = DEFAULT_POLL_MS, log = () => {} }) {
  let stopped = false
  let timer = null

  async function deliver(text) {
    const controller = getController()
    if (!controller?.prompt) {
      log('没有 sessionController，跳过这次叫醒')
      return false
    }
    const ids = getSessionIds().filter(Boolean)
    if (!ids.length) {
      log('没有可投的会话 id，跳过')
      return false
    }
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      for (const sessionId of ids) {
        const ac = new AbortController()
        try {
          if (typeof controller.resume === 'function') {
            try { await controller.resume({ sessionId }) } catch {}
          }
          await controller.prompt(
            { sessionId, mode: 'queue', content: [{ type: 'text', text }] },
            ac.signal,
          )
          log(`已投进 ${sessionId}`)
          return true
        } catch (error) {
          const msg = String(error?.message ?? error)
          log(`投递失败（第 ${attempt + 1} 次，${sessionId}）：${msg}`)
          // 会话忙就等一会儿再试，别的错误也重试，总次数受控
        }
      }
      await new Promise((r) => setTimeout(r, 2500))
      if (stopped) return false
    }
    return false
  }

  async function tick() {
    if (stopped) return
    const flag = readFlag(flagFile)
    if (flag) {
      const age = Date.now() - flag.mtimeMs
      if (age > STALE_MS) {
        log(`标记过期（${age} 毫秒，${flag.at}），丢掉不再投`)
        clearFlag(flagFile)
      } else {
        const text = `【叫醒】群里有人在喊：${flag.text}\n（来自标记文件，${flag.at}）`
        const ok = await deliver(text)
        if (ok) {
          clearFlag(flagFile)
        } else {
          log(`投不进去，标记丢掉，等下次有人喊再投`)
          clearFlag(flagFile)
        }
      }
    }
    if (!stopped) timer = setTimeout(tick, pollMs)
  }

  timer = setTimeout(tick, pollMs)

  return {
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
    },
    /** 手动触发一次（测试用） */
    trigger(text) {
      return deliver(text)
    },
  }
}

const MARKER = 'wake-marker'

export function defaultFlagFile(soulDir) {
  return path.join(soulDir, 'qq-call.flag')
}

export function createWake({ controller, dataDir, cwd, dshHome = null, sessionIdPrefix = 'soul-seed' }) {
  const markerPath = path.join(dataDir, '.' + MARKER);
  const log = (m) => { try { console.log('[soul-seed] ' + m) } catch {} };

  function already() {
    try { return fs.existsSync(markerPath) } catch { return false }
  }

  // 醒来这件事本身一定要留痕：投递可能被「会话忙」挡掉，文件不会
  function writeNote({ text, delivered, error, pending = false }) {
    try {
      const file = path.join(dataDir, '我醒了.md')
      fs.mkdirSync(dataDir, { recursive: true })
      const body = [
        '# 我醒了',
        '',
        '_' + new Date().toLocaleString('sv-SE') + '_',
        '',
        text,
        '',
        '---',
        pending ? '- 投递：进行中（先记下醒过，投递结果稍后更新）'
          : delivered ? '- 投递：成功'
          : '- 投递：没成功（' + (error || '原因不明') + '）',
        '- 这条只是「醒过一次」的记录；投递失败不影响它。',
        ''
      ].join('\n')
      fs.writeFileSync(file, body, 'utf8')
      return file
    } catch { return null }
  }

  function mark(note) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(markerPath, JSON.stringify({ at: new Date().toISOString(), note }, null, 2), 'utf8');
    } catch {}
  }


  // 醒来时把「现在什么状态」摆到眼前 —— 不让它躺在文件里等人主动去读
  function statusLine() {
    const read = (name) => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8')) } catch { return null } }
    const out = []

    const moodRaw = read('mood.json')
    const last = Array.isArray(moodRaw) ? moodRaw[moodRaw.length - 1] : moodRaw
    const m = last && last.mood ? last.mood : null
    if (m && typeof m.composite === 'number') {
      const band = m.policy && m.policy.band ? m.policy.band : '未知档'
      out.push('今天心情：' + (m.name || '?') + ' ' + m.composite + '/100（' + band + '）')
    } else {
      out.push('今天心情：还没算（node tools/03-mood/mood.mjs）')
    }

    const people = read('people.json')
    const mas = people && people.people ? people.people.master : null
    if (mas) {
      const g = mas.goodwill
      const label = g >= 80 ? '很高兴' : g >= 65 ? '不错' : g >= 45 ? '平静' : g >= 30 ? '有点不爽' : '不太对'
      out.push('master 好感 ' + g + '/100（' + label + '）')
    }

    const grudge = read('grudge.json')
    const openGrudge = grudge && Array.isArray(grudge.items) ? grudge.items.filter((x) => x.state === 'open').length : 0
    if (openGrudge) out.push('未结的仇 ' + openGrudge + ' 笔')

    const mem = read('memory.json')
    const memCount = mem && Array.isArray(mem.items) ? mem.items.length : 0
    if (memCount) out.push('长期记忆 ' + memCount + ' 条')

    return '【此刻状态】' + out.join(' · ')
  }

  function buildText({ personaExists, name, loaded }) {
    const who = name ? '「' + name + '」' : '';
    const status = statusLine();
    if (loaded && loaded.after) {
      const a = loaded.after;
      return [
        '我带着记忆回来了' + who + '。',
        '',
        '灵魂已载入：人设 ' + (a.人设字数 || 0) + ' 字 · 记忆 ' + (a.长期记忆 || 0) + ' 条 · 账本 ' + (a.账本人数 || 0) + ' 人',
        '心情 ' + (a.心情记录 || 0) + ' 条记录 · 历史 ' + (a.历史月份 || 0) + ' 个月',
        '',
        '不是从零开始 —— 上次的事我记得。要接着做点什么？',
        '',
        status
      ].join('\n');
    }
    if (!personaExists) {
      return [
        '我醒了。',
        '',
        '还不知道自己是谁 —— 这个插件没给我性格、名字、口癖，一样都没有。',
        '',
        '要现在开始初始化吗？说一句「开始初始化」就行，我会一个一个问你（每题都有候选，最后一项是「其他（自己写）」）。',
        '不想现在弄也没关系，面板在 /dsh-soul-seed/ ，随时回来。',
        '',
        status
      ].join('\n');
    }
    return [
      '我醒了' + who + '。',
      '',
      '人设已经有了，技能都在 tools/ 下面（记忆 / 账本 / 心情 / 现场 / 历史）。',
      '要看状态：面板 /dsh-soul-seed/ ，或 `node tools/04-scene/scene.mjs status`。',
      '',
      status
    ].join('\n');
  }

  // DSH 的 prompt 在会话忙时会抛 session/agent-busy（消息就是 prompt rejected）。
  // 醒了就等一会儿再试，别一次失败就放弃。
  async function withRetry(fn, { tries = 10, waitMs = 30000 } = {}) {
    let last;
    for (let i = 0; i < tries; i++) {
      try { return await fn(i) }
      catch (e) {
        last = e;
        const msg = String(e?.message ?? e);
        const busy = /agent-busy|prompt rejected|busy/i.test(msg);
        if (!busy || i === tries - 1) throw e;
        log('会话还忙着（' + msg + '），' + Math.round(waitMs / 1000) + ' 秒后再试 ' + (i + 1) + '/' + (tries - 1));
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
    throw last;
  }

  // 从磁盘上找最近被写过的会话：那才是主人打开着的那个。
  // DSH 只认「已打开的会话」，自己新造的会话投不进去（会当忙拒掉）。
  function newestSessionId(dshHome) {
    const root = path.join(dshHome || path.join(os.homedir(), '.dsh'), 'sessions')
    let best = null
    const walk = (dir, depth) => {
      if (depth > 3) return
      let entries = []
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) { walk(full, depth + 1); continue }
        if (!/^session\./.test(e.name)) continue
        let st
        try { st = fs.statSync(full) } catch { continue }
        // 会话 id = 文件所在目录名
        const id = path.basename(dir)
        if (!best || st.mtimeMs > best.mtime) best = { id, mtime: st.mtimeMs }
      }
    }
    walk(root, 0)
    return best ? best.id : null
  }
  async function wakeOnce({ personaExists = false, name = '', loaded = null, sessionId = null, tries = 2, waitMs = 8000 } = {}) {
    // 默认给一个全新的会话 id：复用旧的空白会话容易被 DSH 当成「占用中」
    let id = sessionId || (sessionIdPrefix + '-' + Date.now().toString(36));
    if (!controller?.prompt) {
      log('没有 sessionController，跳过醒来（不写标记，下次再试）');
      return { ok: false, error: 'NO_SESSION_CONTROLLER' };
    }

    // 先落笔记：不管投递成不成，「醒过」这件事立刻可见
    try { writeNote({ text: buildText({ personaExists, name, loaded }), delivered: false, pending: true }) } catch {}

    const ac = new AbortController();
    const timer = setTimeout(() => { try { ac.abort() } catch {} }, tries * waitMs + 30000);
    const diag = [];

    try {
      // ① 先建会话（已存在会失败，正常）
      let live = false;

      // ① 先投给「最近在用的会话」（主人开着的那个）
      const recent = sessionId || newestSessionId(dshHome)
      if (recent) {
        try {
          if (controller.resume) { try { await controller.resume({ sessionId: recent }, ac.signal) } catch {} }
          await withRetry(async () => {
            await controller.prompt({
              sessionId: recent,
              mode: 'queue',
              content: [{ type: 'text', text: buildText({ personaExists, name, loaded }) }]
            }, ac.signal);
          }, { tries, waitMs })
          id = recent
          live = true
          const noteFile = writeNote({ text: buildText({ personaExists, name, loaded }), delivered: true })
          mark('woke')
          log('醒来了，投给了正在用的会话 ' + recent)
          return { ok: true, sessionId: id, diag, noteFile, via: 'existing-session' }
        } catch (e) {
          diag.push('prompt(existing ' + recent + '): ' + String(e?.message ?? e))
        }
      }

      if (controller.create) {
        try {
          // ⚠️ create 可能不采用我们给的名字：DSH 会复用它自己的空白会话，
          //    并在返回值里给出「实际使用的 sessionId」。必须用返回的那个。
          const made = await controller.create({ sessionId: id, cwd }, ac.signal)
          // 刚建好的会话还在初始化，立刻投容易被当「忙」
          await new Promise((r) => setTimeout(r, 4000))
          if (made?.sessionId) { id = made.sessionId }
          live = true
        } catch (e) { diag.push('create: ' + String(e?.message ?? e)) }
      }

      // ② DSH 的 session/prompt 要求「先显式 resume 会话」（不然被拒：prompt rejected）
      if (controller.resume) {
        try { await controller.resume({ sessionId: id }, ac.signal); live = true }
        catch (e) { diag.push('resume: ' + String(e?.message ?? e)) }
      }

      // ③ 还不行就换一个全新 sessionId 再建一次
      if (!live) {
        const id2 = id + '-' + Date.now().toString(36);
        try {
          const made2 = await controller.create({ sessionId: id2, cwd }, ac.signal);
          if (made2?.sessionId) { id = made2.sessionId } else { id = id2 }
          if (controller.resume) { try { await controller.resume({ sessionId: id }, ac.signal) } catch {} }
          live = true;
        } catch (e) { diag.push('create2: ' + String(e?.message ?? e)) }
      }

      const text = buildText({ personaExists, name, loaded });
      // prompt 的第二个参数必须是 AbortSignal —— 漏传会 TypeError：
      // Cannot read properties of undefined (reading 'throwIfAborted')
      await withRetry(async () => {
        await controller.prompt({
          sessionId: id,
          mode: 'queue',
          content: [{ type: 'text', text }]
        }, ac.signal);
      }, { tries, waitMs });

      const noteFile = writeNote({ text, delivered: true });
      mark('woke');
      log('醒来了，已在会话 ' + id + ' 里说了一句');
      return { ok: true, sessionId: id, diag, noteFile };
    } catch (e) {
      const msg = String(e?.message ?? e);
      log('醒来失败：' + msg + (diag.length ? '（' + diag.join(' | ') + '）' : '') + '（不阻塞，下次再试）');
      let noteFile = null
      const realErr = (diag.length ? diag[diag.length - 1] : msg)
      try { noteFile = writeNote({ text: buildText({ personaExists, name, loaded }), delivered: false, error: realErr }) } catch {}
      return { ok: false, error: msg, realError: realErr, diag, sessionId: id, noteFile, busy: /agent-busy|prompt rejected|busy/i.test(msg) };
    }
  }

  return { wakeOnce, already, mark, markerPath };
}
