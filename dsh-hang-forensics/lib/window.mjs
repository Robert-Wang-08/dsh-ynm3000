// window.mjs — 打印某个会话在指定时间窗内的事件摘要，用于复盘卡死前主线程在忙什么。
// 用法: node window.mjs <sessionId片段> <HH:mm:ss 起> <HH:mm:ss 止>
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { zstdDecompressSync } from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
function decodeAll(buf) {
  const offsets = [];
  let i = 0;
  while (i < buf.length) {
    const at = buf.indexOf(MAGIC, i);
    if (at < 0) break;
    offsets.push(at);
    i = at + 4;
  }
  let text = '';
  for (let k = 0; k < offsets.length; k += 1) {
    const start = offsets[k];
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    try {
      text += zstdDecompressSync(buf.subarray(start, end)).toString('utf8');
    } catch {}
  }
  return text;
}

const [needle, fromStr, toStr] = process.argv.slice(2);
const today = new Date();
const at = (hhmmss) => {
  const [h, m, s] = hhmmss.split(':').map(Number);
  const d = new Date(today);
  d.setHours(h, m, s, 0);
  return d.getTime();
};
const from = at(fromStr);
const to = toStr ? at(toStr) : Date.now();

const root = join(homedir(), '.dsh', 'sessions');
let target = null;
for (const ws of readdirSync(root)) {
  let st;
  try {
    st = statSync(join(root, ws));
  } catch {
    continue;
  }
  if (!st.isDirectory()) continue;
  for (const s of readdirSync(join(root, ws))) {
    if (!s.includes(needle)) continue;
    const f = join(root, ws, s, 'session.v4.jsonl.zstd');
    try {
      statSync(f);
      target = { ws, s, f };
    } catch {}
  }
}
if (!target) {
  console.error(`找不到包含 "${needle}" 的会话`);
  process.exit(1);
}
const events = [];
for (const line of decodeAll(readFileSync(target.f)).split('\n')) {
  if (!line.trim()) continue;
  try {
    events.push(JSON.parse(line));
  } catch {}
}
const t = (ms) => new Date(ms).toLocaleTimeString('sv-SE');
console.log(`会话 ${target.s.replace(/^session-/, '').slice(0, 8)} @ ${target.ws}`);
console.log(`窗口 ${t(from)} → ${t(to)}`);
const inWin = events.filter((e) => typeof e.time === 'number' && e.time >= from && e.time <= to);
console.log(`窗口内事件 ${inWin.length} 条\n`);

const tally = new Map();
for (const e of inWin) {
  let key = e.type;
  if (e.type === 'tool/call') key = `tool/call ${e.data?.call?.name ?? e.data?.name ?? '?'}`;
  tally.set(key, (tally.get(key) ?? 0) + 1);
}
console.log('--- 事件计数 ---');
for (const [k, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(4)}  ${k}`);

console.log('\n--- 逐条（tool/result 折叠）---');
for (const e of inWin) {
  if (e.type === 'tool/result') continue;
  const d = e.data ?? {};
  let extra = '';
  if (e.type === 'tool/call') extra = `${d.call?.name ?? '?'} ${JSON.stringify(d.call?.arguments ?? {}).slice(0, 120)}`;
  else if (e.type === 'turn/start' || e.type === 'turn/end') extra = JSON.stringify(d.turn) + (d.reason ? ` ${JSON.stringify(d.reason)}` : '');
  else if (e.type === 'step/start' || e.type === 'step/end') extra = `turn ${d.turn} step ${d.step}`;
  else if (e.type.startsWith('tool/ptc')) extra = JSON.stringify(d).slice(0, 110);
  console.log(`${t(e.time)}  ${e.type.padEnd(20)} ${extra}`);
}

// 打印最大事件间隔，定位"静默期"
let maxGap = 0;
let gapAt = '';
for (let i = 1; i < inWin.length; i += 1) {
  const gap = inWin[i].time - inWin[i - 1].time;
  if (gap > maxGap) {
    maxGap = gap;
    gapAt = `${t(inWin[i - 1].time)} ${inWin[i - 1].type} → ${t(inWin[i].time)} ${inWin[i].type}`;
  }
}
console.log(`\n最大静默 ${(maxGap / 1000).toFixed(1)}s：${gapAt}`);
