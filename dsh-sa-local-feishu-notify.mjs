/**
 * dsh-sa-local-feishu-notify.mjs — sa-local（fork）工单状态推送器。
 *
 * 轮询 ~/.dsh/state/sa-local/orchestrator.sqlite（只读），把三类信号推到飞书：
 *   ✅ 工单完成（ended.outcome === 'completed'）
 *   ❌ 工单结束但非完成（stopped / failed / 其它 outcome）
 *   ⚠️ 需要人处理（未结束且有 inputs 等待执行器）
 *
 * 首次启动只记基线不推送；游标写 <stateDir>/notify-cursor.json，避免重复。
 *
 * 用法：node dsh-sa-local-feishu-notify.mjs --chat oc_xxx [--lark-dir <dir>] [--once] [--dry-run]
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : fallback;
};
const flag = (name) => args.includes('--' + name);

const home = homedir();
const stateDir = arg('state-dir', join(home, '.dsh', 'state', 'sa-local'));
// 2026-11-06：superagent/sa-local 自己的通道改用 app3「superagent-飞书bot」，
// 不再往 HITL 的私聊（oc_3c60…）里灌，避免两条通道互相串消息。
// 可用 --chat / --lark-dir 覆盖。
const chat = arg('chat', 'oc_eae25b93a93612f82042deb68704e2af');
const larkDir = arg('lark-dir', join(home, '.lark-cli-hitl-aa67e4041a381c02'));
const cli = arg('cli', 'C:\\nvm4w\\nodejs\\node_modules\\@larksuite\\cli\\bin\\lark-cli.exe');
const intervalSec = Number(arg('interval', '5'));
const once = flag('once');
const dryRun = flag('dry-run');
const dbPath = join(stateDir, 'orchestrator.sqlite');
const cursorPath = join(stateDir, 'notify-cursor.json');

const log = (msg) => console.log(new Date().toISOString() + ' ' + msg);

function loadCursor() {
  try { return JSON.parse(readFileSync(cursorPath, 'utf8')); } catch { return null; }
}
function saveCursor(c) {
  const tmp = cursorPath + '.tmp';
  writeFileSync(tmp, JSON.stringify(c));
  renameSync(tmp, cursorPath);
}

function send(text) {
  return new Promise((resolve) => {
    if (dryRun) { log('DRY-RUN would send: ' + text.replace(/\n/g, ' / ')); return resolve(true); }
    const child = spawn(cli, ['im', '+messages-send', '--chat-id', chat, '--text', text, '--as', 'bot'], {
      env: { ...process.env, LARKSUITE_CLI_CONFIG_DIR: larkDir, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      let id = '';
      try { id = JSON.parse(out).data.message_id; } catch {}
      if (code === 0 && id) { log('sent ' + id); resolve(true); }
      else { log('send failed code=' + code + ' ' + (err || out).slice(0, 300)); resolve(false); }
    });
  });
}

function readTickets() {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare('SELECT value FROM ticket').all().map((r) => JSON.parse(r.value));
  } finally { db.close(); }
}

function describe(t) {
  const dir = t.execution?.directory ?? '';
  const secs = t.ended?.at && t.createdAt ? Math.round((Date.parse(t.ended.at) - Date.parse(t.createdAt)) / 1000) : undefined;
  return { dir, secs };
}

async function poll(cursor) {
  let tickets;
  try { tickets = readTickets(); } catch (e) { log('db read skipped: ' + e.message); return cursor; }
  const seenEnded = new Set(cursor.seenEnded);
  const seenInputs = cursor.seenInputs;
  let changed = false;
  for (const t of tickets) {
    const short = String(t.id).slice(0, 8);
    if (t.ended && !seenEnded.has(t.id)) {
      seenEnded.add(t.id); changed = true;
      const { dir, secs } = describe(t);
      const ok = t.ended.outcome === 'completed';
      const head = ok ? '✅ 工单完成' : '❌ 工单结束';
      const body = [head + '：' + (t.title ?? '(未命名)') + '  [' + short + ']',
        '结果：' + (t.ended.outcome ?? 'unknown') + (secs !== undefined ? '（' + secs + 's）' : ''),
        dir ? '目录：' + dir : ''].filter(Boolean).join('\n');
      await send(body);
    } else if (!t.ended) {
      const waiting = Array.isArray(t.inputs) ? t.inputs.length : 0;
      if (waiting > (seenInputs[t.id] ?? 0)) {
        seenInputs[t.id] = waiting; changed = true;
        await send('⚠️ 需要你处理：' + (t.title ?? '(未命名)') + '  [' + short + ']\n有 ' + waiting + ' 条消息等待执行器');
      }
    }
  }
  if (changed) {
    cursor.seenEnded = [...seenEnded];
    cursor.seenInputs = seenInputs;
    cursor.updatedAt = new Date().toISOString();
    if (!dryRun) saveCursor(cursor);
  }
  return cursor;
}

if (flag('test')) { const ok = await send('🔔 通知通道自检 · sa-local 工单状态推送（' + new Date().toISOString() + '）'); process.exit(ok ? 0 : 1); }

let cursor = loadCursor();
if (!cursor) {
  let tickets = [];
  try { tickets = readTickets(); } catch (e) { log('baseline postponed: ' + e.message); }
  const seenInputs = {};
  for (const t of tickets) seenInputs[t.id] = Array.isArray(t.inputs) ? t.inputs.length : 0;
  cursor = { seenEnded: tickets.filter((t) => t.ended).map((t) => t.id), seenInputs, updatedAt: new Date().toISOString() };
  if (tickets.length) { log('baseline: ' + cursor.seenEnded.length + ' ended ticket(s) recorded, no push'); if (!dryRun) saveCursor(cursor); }
}

if (once) { await poll(cursor); process.exit(0); }
log('watching ' + dbPath + ' -> ' + chat + ' every ' + intervalSec + 's' + (dryRun ? ' (dry-run)' : ''));
for (;;) {
  cursor = await poll(cursor);
  await new Promise((r) => setTimeout(r, intervalSec * 1000));
}