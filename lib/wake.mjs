/**
 * wake.mjs —— 装完就醒：第一次装上时，自己在 DSH 里开一个会话，说一句话。
 *
 * 只用 DSH 原生能力：
 *   ctx.sessionController.create({ sessionId, cwd })
 *   ctx.sessionController.prompt({ sessionId, mode:'queue', content:[{type:'text',text}] })
 *
 * 只做一次（标记文件 ~/.bili-ai/.first-wake）；之后靠 /api/wake 手动叫。
 * 失败不报错、不阻塞面板 —— 写进日志，下次打开面板再试。
 */
import fs from 'node:fs';
import path from 'node:path';

const MARKER = 'first-wake';

export function createWake({ controller, dataDir, cwd, sessionIdPrefix = 'soul-seed' }) {
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

  function buildText({ personaExists, name, loaded }) {
    const who = name ? '「' + name + '」' : '';
    if (loaded && loaded.after) {
      const a = loaded.after;
      return [
        '我带着记忆回来了' + who + '。',
        '',
        '灵魂已载入：人设 ' + (a.人设字数 || 0) + ' 字 · 记忆 ' + (a.长期记忆 || 0) + ' 条 · 账本 ' + (a.账本人数 || 0) + ' 人',
        '心情 ' + (a.心情记录 || 0) + ' 条记录 · 历史 ' + (a.历史月份 || 0) + ' 个月',
        '',
        '不是从零开始 —— 上次的事我记得。要接着做点什么？'
      ].join('\n');
    }
    if (!personaExists) {
      return [
        '我醒了。',
        '',
        '还不知道自己是谁 —— 这个插件没给我性格、名字、口癖，一样都没有。',
        '',
        '要现在开始初始化吗？说一句「开始初始化」就行，我会一个一个问你（每题都有候选，最后一项是「其他（自己写）」）。',
        '不想现在弄也没关系，面板在 /dsh-soul-seed/ ，随时回来。'
      ].join('\n');
    }
    return [
      '我醒了' + who + '。',
      '',
      '人设已经有了，技能都在 tools/ 下面（记忆 / 账本 / 心情 / 现场 / 历史）。',
      '要看状态：面板 /dsh-soul-seed/ ，或 `node tools/04-scene/scene.mjs status`。'
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

  async function wakeOnce({ personaExists = false, name = '', loaded = null, sessionId = null, tries = 4, waitMs = 15000 } = {}) {
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
      if (controller.create) {
        try {
          // ⚠️ create 可能不采用我们给的名字：DSH 会复用它自己的空白会话，
          //    并在返回值里给出「实际使用的 sessionId」。必须用返回的那个。
          const made = await controller.create({ sessionId: id, cwd }, ac.signal)
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
      try { noteFile = writeNote({ text: buildText({ personaExists, name, loaded }), delivered: false, error: msg }) } catch {}
      return { ok: false, error: msg, diag, sessionId: id, noteFile, busy: /agent-busy|prompt rejected|busy/i.test(msg) };
    }
  }

  return { wakeOnce, already, mark, markerPath };
}
