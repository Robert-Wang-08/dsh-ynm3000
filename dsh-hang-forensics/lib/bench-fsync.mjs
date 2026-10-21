// bench-fsync.mjs — 量化"每次会话事件都 fsync"的实际代价（含安全软件的过滤驱动开销）。
// 复刻 dsh-session-persistence-jsonl 的 appendLines 模式：open(wx) → writeFile → sync → rename。
import { open, rename, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'D:\\src\\dsh\\.fsbench';
const rounds = Number(process.argv[3] ?? 200);
const payload = JSON.stringify({ type: 'tool/call', seq: 1, time: Date.now(), data: { pad: 'x'.repeat(300) } });

await mkdir(dir, { recursive: true });
const writeMs = [];
const fsyncMs = [];
const renameMs = [];
for (let i = 0; i < rounds; i += 1) {
  const tmp = join(dir, `.bench-${i}.tmp`);
  const bin = join(dir, `bench-${i}.bin`);
  let t = performance.now();
  const handle = await open(tmp, 'wx', 0o600);
  await handle.writeFile(payload);
  writeMs.push(performance.now() - t);
  t = performance.now();
  await handle.sync();
  fsyncMs.push(performance.now() - t);
  await handle.close();
  t = performance.now();
  await rename(tmp, bin);
  renameMs.push(performance.now() - t);
}
await rm(dir, { recursive: true, force: true });

const stat = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const p = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return {
    p50: +p(0.5).toFixed(1),
    p95: +p(0.95).toFixed(1),
    p99: +p(0.99).toFixed(1),
    max: +s[s.length - 1].toFixed(1),
    avg: +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1),
  };
};

console.log(`目录 ${dir}，样本 ${rounds} 次（单位 ms）`);
console.log('open+write :', JSON.stringify(stat(writeMs)));
console.log('fsync      :', JSON.stringify(stat(fsyncMs)));
console.log('rename     :', JSON.stringify(stat(renameMs)));
const total = fsyncMs.reduce((a, b) => a + b, 0);
console.log(`单次 fsync 平均 ${(total / rounds).toFixed(1)}ms；若每秒 20 次追加 → 每秒光 fsync 就 ${((total / rounds) * 20).toFixed(0)}ms`);
