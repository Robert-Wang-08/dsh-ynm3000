// session-tails.mjs — 解出 DSH 会话日志（多帧 zstd），报告"最近仍在活动"的会话及其尾巴。
// 用途：卡死现场快速判断"当时哪个会话、哪个回合在飞、最后一步做了什么"。
// 只读，不写任何会话文件。
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function decodeFrames(buf) {
  const offsets = [];
  let i = 0;
  while (i < buf.length) {
    const at = buf.indexOf(MAGIC, i);
    if (at < 0) break;
    offsets.push(at);
    i = at + 4;
  }
  if (offsets.length === 0) return buf.toString('utf8');
  const parts = [];
  for (let k = 0; k < offsets.length; k += 1) {
    const start = offsets[k];
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    try {
      parts.push(zstdDecompressSync(buf.subarray(start, end)).toString('utf8'));
    } catch {
      /* 不是帧边界，跳过 */
    }
  }
  return parts.join('');
}

function readEvents(file) {
  const text = decodeFrames(readFileSync(file));
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* 末行可能半条 */
    }
  }
  return events;
}

const minutes = Number(process.argv[2] ?? 20);
const tailN = Number(process.argv[3] ?? 8);
const since = Date.now() - minutes * 60 * 1000;
const root = join(homedir(), '.dsh', 'sessions');
const fmt = (t) => (typeof t === 'number' ? new Date(t).toLocaleString('sv-SE') : '-');

const active = [];
for (const ws of readdirSync(root)) {
  let wsStat;
  try {
    wsStat = statSync(join(root, ws));
  } catch {
    continue;
  }
  if (!wsStat.isDirectory()) continue;
  let sessions;
  try {
    sessions = readdirSync(join(root, ws));
  } catch {
    continue;
  }
  for (const sess of sessions) {
    const file = join(root, ws, sess, 'session.v4.jsonl.zstd');
    try {
      const st = statSync(file);
      if (st.mtimeMs >= since) active.push({ ws, sess, file, mtimeMs: st.mtimeMs });
    } catch {
      /* 无日志 */
    }
  }
}

active.sort((a, b) => b.mtimeMs - a.mtimeMs);
console.log(`# 最近 ${minutes} 分钟内有写入的会话：${active.length} 个`);
console.log(`# 生成时间 ${fmt(Date.now())}`);
console.log('');

const brief = (e) => {
  const d = e.data ?? {};
  switch (e.type) {
    case 'turn/start':
      return `turn ${d.turn} START`;
    case 'turn/end':
      return `turn ${d.turn} END ${JSON.stringify(d.reason)}`;
    case 'step/start':
      return `step ${d.step} start`;
    case 'step/end':
      return `step ${d.step} end`;
    case 'tool/call':
      return `CALL ${d.call?.name ?? d.name ?? '?'} ${JSON.stringify(d.call?.arguments ?? {}).slice(0, 140)}`;
    case 'tool/result':
      return 'RESULT (已返回)';
    case 'user/message':
      return 'USER 消息';
    case 'assistant/message':
      return 'ASSISTANT 消息';
    case 'assistant/attempt':
      return `attempt ${JSON.stringify((d.stream ?? []).map((s) => s.chunk?.type).filter((x) => x && x !== 'text-delta'))}`;
    default:
      return JSON.stringify(d).slice(0, 140);
  }
};

for (const a of active) {
  let events;
  try {
    events = readEvents(a.file);
  } catch (e) {
    console.log(`[${a.ws}] ${a.sess}  读取失败: ${e.message}\n`);
    continue;
  }
  const timed = events.filter((e) => typeof e.time === 'number');
  const starts = events.filter((e) => e.type === 'turn/start').length;
  const ends = events.filter((e) => e.type === 'turn/end').length;
  const last = timed[timed.length - 1];
  console.log(`[${a.ws}] ${a.sess.replace(/^session-/, '').slice(0, 8)}  ev=${events.length} turns=${starts}${starts > ends ? `  ⚠ 有 ${starts - ends} 个回合未闭合` : ''}`);
  console.log(`   最后写入 ${fmt(a.mtimeMs)}   最后事件 ${fmt(last?.time)} ${last?.type ?? ''}`);
  for (const e of timed.slice(-tailN)) {
    console.log(`   ${fmt(e.time)}  ${e.type.padEnd(18)} ${brief(e)}`);
  }
  console.log('');
}
