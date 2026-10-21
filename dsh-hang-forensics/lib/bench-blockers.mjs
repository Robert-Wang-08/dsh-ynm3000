// bench-blockers.mjs — 量化"能在主线程上堵多久"的候选操作。
// 1) 复刻 @local/dsh-subagent-acp-resilient 的同步 workspaceSnapshot 走树
// 2) 解码/解析最大的会话日志（投影重建的一次成本）
// 3) 解压 + 解析全部会话日志（任何"全量扫描会话"的插件都要付这个账）
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { zstdDecompressSync } from 'node:zlib';

const SKIP = new Set(['.git', 'node_modules', '.ptc']);
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

// —— 与插件里逐字一致的实现 ——
function workspaceSnapshot(root, limit) {
  const files = new Map();
  const stack = [root];
  while (stack.length && files.size < limit) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile()) {
        try {
          const s = statSync(path);
          files.set(path, `${s.size}:${s.mtimeMs}`);
        } catch {}
      }
      if (files.size >= limit) break;
    }
  }
  return files;
}

const benchWalk = (root, limit = 20000, rounds = 3) => {
  const times = [];
  let count = 0;
  for (let i = 0; i < rounds; i += 1) {
    const t0 = performance.now();
    const snap = workspaceSnapshot(root, limit);
    times.push(performance.now() - t0);
    count = snap.size;
  }
  times.sort((a, b) => a - b);
  return { root, files: count, capped: count >= limit, ms: times.map((t) => Math.round(t)) };
};

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

console.log('=== 1. 同步 workspaceSnapshot 走树（每次 subagent 运行前后各一次）===');
for (const root of ['D:\\src\\dsh', 'D:\\src\\ynm3000\\skillhub', 'C:\\Users\\wwm_1\\.dsh\\sessions']) {
  try {
    const r = benchWalk(root);
    console.log(
      `${r.root}\n  文件数 ${r.files}${r.capped ? '（已触顶 20000）' : ''}  耗时 ${r.ms.join(' / ')} ms（3 次）`,
    );
  } catch (e) {
    console.log(`${root} 失败: ${e.message}`);
  }
}

console.log('\n=== 2/3. 会话日志解码成本 ===');
const sessRoot = join(homedir(), '.dsh', 'sessions');
const files = [];
for (const ws of readdirSync(sessRoot)) {
  let st;
  try {
    st = statSync(join(sessRoot, ws));
  } catch {
    continue;
  }
  if (!st.isDirectory()) continue;
  for (const s of readdirSync(join(sessRoot, ws))) {
    const f = join(sessRoot, ws, s, 'session.v4.jsonl.zstd');
    try {
      files.push({ f, size: statSync(f).size });
    } catch {}
  }
}
files.sort((a, b) => b.size - a.size);
let totalBytes = 0;
let totalMs = 0;
for (const { f, size } of files) {
  const isBig = size >= files[0].size;
  const t0 = performance.now();
  const text = decodeAll(readFileSync(f));
  const ms = performance.now() - t0;
  totalBytes += size;
  totalMs += ms;
  if (isBig) console.log(`最大单会话 ${(size / 1048576).toFixed(2)}MB → 解压 ${(text.length / 1048576).toFixed(1)}MB，耗时 ${Math.round(ms)}ms`);
}
console.log(`全部 ${files.length} 个会话合计 ${(totalBytes / 1048576).toFixed(1)}MB，纯解压裸耗时 ${Math.round(totalMs)}ms（未含 JSON.parse 与投影）`);
