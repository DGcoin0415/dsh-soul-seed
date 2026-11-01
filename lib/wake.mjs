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

  function mark(note) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(markerPath, JSON.stringify({ at: new Date().toISOString(), note }, null, 2), 'utf8');
    } catch {}
  }

  function buildText({ personaExists, name }) {
    const who = name ? '「' + name + '」' : '';
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

  async function wakeOnce({ personaExists = false, name = '', sessionId = null } = {}) {
    const id = sessionId || (sessionIdPrefix + '-first');
    if (!controller?.prompt) {
      log('没有 sessionController，跳过醒来（只写标记，下次再试）');
      return { ok: false, error: 'NO_SESSION_CONTROLLER' };
    }
    try {
      if (controller.create) {
        try { await controller.create({ sessionId: id, cwd }) }
        catch { /* 会话已存在就用现有的 */ }
      }
      const text = buildText({ personaExists, name });
      await controller.prompt({
        sessionId: id,
        mode: 'queue',
        content: [{ type: 'text', text }]
      });
      mark('woke');
      log('醒来了，已在会话 ' + id + ' 里说了一句');
      return { ok: true, sessionId: id };
    } catch (e) {
      const msg = String(e?.message ?? e);
      log('醒来失败：' + msg + '（不阻塞，下次面板打开再试）');
      return { ok: false, error: msg };
    }
  }

  return { wakeOnce, already, mark, markerPath };
}
