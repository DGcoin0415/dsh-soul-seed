/**
 * soul.mjs —— 灵魂的打包与载入
 *
 *   灵魂 = 人设 + 附录(规矩/说话/现场) + 记忆 + 账本 + 心情 + 历史 + 现场
 *   躯体 = 一台装好 DSH 的机器（一个新的 ~/.bili-ai）
 *
 *   exportSoul()  → 打成一个 zip（绝不打包 key / cookie）
 *   importSoul()  → 解进这台躯体（先备份现有的）
 *   autoImport()  → 起躯体时如果发现 soul-pack.zip 就自动载入
 *
 * zip 用系统自带工具（Windows: Compress-Archive / 其它: tar），不引第三方依赖。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** 进灵魂包的东西（白名单，绝不加 key / cookie / 凭据） */
export const SOUL_ITEMS = [
  'persona.md',
  'persona-附录',
  'mood.json',
  'people.json',
  'memory.json',
  'grudge.json',
  'history',
  'scene',
  'config.json'
];

/** 明确不进包的（写出来是给人看的，也是自查） */
export const NEVER_PACK = ['credentials.json', 'image-keys.json', 'cookies', '.first-wake', 'soul-pack.zip'];

const log = (m) => { try { console.log('[soul] ' + m) } catch {} };

function zipDir(srcDir, zipPath) {
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  if (process.platform === 'win32') {
    execFileSync('powershell.exe', [
      '-NoProfile', '-Command',
      `Compress-Archive -Path '${srcDir}\\*' -DestinationPath '${zipPath}' -CompressionLevel Optimal`
    ], { stdio: 'ignore' });
  } else {
    execFileSync('tar', ['-czf', zipPath, '-C', srcDir, '.'], { stdio: 'ignore' });
  }
  return zipPath;
}

function unzipTo(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (process.platform === 'win32') {
    execFileSync('powershell.exe', [
      '-NoProfile', '-Command',
      `Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`
    ], { stdio: 'ignore' });
  } else {
    execFileSync('tar', ['-xzf', zipPath, '-C', destDir], { stdio: 'ignore' });
  }
}

/** 灵魂概况（导入导出前后都打一份，好对账） */
export function soulStats(dataDir) {
  const read = (f, d = null) => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8')) } catch { return d } };
  const text = (f) => { try { return fs.readFileSync(path.join(dataDir, f), 'utf8') } catch { return '' } };
  const dirCount = (d) => { try { return fs.readdirSync(path.join(dataDir, d)).length } catch { return 0 } };
  const p = text('persona.md');
  const people = read('people.json', { people: {} });
  const mem = read('memory.json', { items: [] });
  const mood = read('mood.json', []);
  const grudge = read('grudge.json', { items: [] });
  return {
    人设字数: p.trim().length,
    附录份数: dirCount('persona-附录'),
    账本人数: Object.keys(people.people || {}).length,
    长期记忆: (mem.items || []).length,
    心情记录: Array.isArray(mood) ? mood.length : 0,
    记仇未结: (grudge.items || []).filter((g) => g.state === 'open').length,
    历史月份: dirCount('history'),
    现场文件: dirCount('scene')
  };
}

/** 导出灵魂包 */
export function exportSoul({ dataDir, outDir, name = 'soul-pack' } = {}) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-export-'));
  let n = 0;
  for (const rel of SOUL_ITEMS) {
    const src = path.join(dataDir, rel);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(stage, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (fs.statSync(src).isDirectory()) fs.cpSync(src, dst, { recursive: true });
    else fs.copyFileSync(src, dst);
    n++;
  }
  if (!n) { try { fs.rmSync(stage, { recursive: true, force: true }) } catch {} ; return { ok: false, error: '空灵魂：~/.bili-ai 里没有可打包的东西' } }

  // 附一份人读的清单
  const stats = soulStats(dataDir);
  fs.writeFileSync(path.join(stage, 'SOUL-MANIFEST.md'),
    `# 灵魂包\n\n导出时间：${new Date().toLocaleString('sv-SE')}\n\n` +
    Object.entries(stats).map(([k, v]) => `- ${k}：${v}`).join('\n') +
    `\n\n> 不含任何 key / cookie / 凭据（见 NEVER_PACK）。\n`, 'utf8');

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const zipPath = path.join(outDir, `${name}-${stamp}.zip`);
  zipDir(stage, zipPath);
  try { fs.rmSync(stage, { recursive: true, force: true }) } catch {}
  log(`灵魂已打包：${zipPath}（${n} 项）`);
  return { ok: true, zipPath, items: n, stats };
}

/** 导入灵魂包（先备份现有灵魂） */
export function importSoul({ dataDir, zipPath, backupDir = null } = {}) {
  if (!fs.existsSync(zipPath)) return { ok: false, error: '找不到这个包：' + zipPath };
  const before = soulStats(dataDir);

  // 备份现有
  let backup = null;
  if (Object.values(before).some((v) => v > 0)) {
    backup = path.join(backupDir || path.join(dataDir, 'soul-backup'), 'before-' + Date.now() + '.zip');
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-backup-'));
    let any = 0;
    for (const rel of SOUL_ITEMS) {
      const src = path.join(dataDir, rel);
      if (!fs.existsSync(src)) continue;
      const dst = path.join(stage, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      if (fs.statSync(src).isDirectory()) fs.cpSync(src, dst, { recursive: true });
      else fs.copyFileSync(src, dst);
      any++;
    }
    if (any) zipDir(stage, backup);
    try { fs.rmSync(stage, { recursive: true, force: true }) } catch {}
  }

  // 解包（先到临时目录，避免半截覆盖）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-import-'));
  unzipTo(zipPath, tmp);
  const incoming = [];
  for (const rel of SOUL_ITEMS) {
    const src = path.join(tmp, rel);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(dataDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (fs.statSync(src).isDirectory()) fs.cpSync(src, dst, { recursive: true, overwrite: true });
    else fs.copyFileSync(src, dst);
    incoming.push(rel);
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}

  const after = soulStats(dataDir);
  log(`灵魂已载入：${incoming.length} 项` + (backup ? `（旧灵魂备份在 ${path.basename(backup)}）` : ''));
  return { ok: true, incoming, before, after, backup };
}

/** 起躯体时自动载入：发现 soul-pack*.zip 就导入，导完改名防重复 */
export function autoImport({ dataDir, markerDir = null } = {}) {
  const candidates = [];
  try {
    for (const f of fs.readdirSync(dataDir)) {
      if (/^soul-pack.*\.zip$/i.test(f)) candidates.push(path.join(dataDir, f));
    }
  } catch {}
  if (!candidates.length) return { ok: false, reason: 'NO_PACK' };
  const zip = candidates[0];
  const r = importSoul({ dataDir, zipPath: zip, backupDir: markerDir || undefined });
  if (r.ok) {
    try { fs.renameSync(zip, zip + '.imported-' + Date.now()) } catch {}
    try {
      fs.writeFileSync(path.join(dataDir, '.soul-loaded'),
        JSON.stringify({ at: new Date().toISOString(), zip: path.basename(zip), stats: r.after }, null, 2), 'utf8');
    } catch {}
  }
  return r;
}

/** 这次醒来是不是「带着记忆回来」的 */
export function wasLoaded(dataDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, '.soul-loaded'), 'utf8')) } catch { return null }
}
