// cdp-profile.mjs — 通过 Node Inspector (CDP) 对卡住的 dsh web 进程取证。
//
// 关键点：V8 的 inspector agent 跑在独立线程上，即使主线程被同步忙等打死，
// 仍能响应 Profiler.start/stop 和 Runtime.evaluate（V8 用中断机制接管）。
// 因此 `dsh web` 若以 `--inspect=127.0.0.1:<port>` 启动，卡死后依然能抓到
// "究竟哪个函数在吃 CPU"。
//
// 用法: node cdp-profile.mjs --port 9229 --out <dir> [--seconds 5] [--heap]
// 产物: <dir>/inspector-targets.json, <dir>/cpu-profile.json,
//       <dir>/cpu-profile-top.txt, <dir>/inspector-probe.json
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return dflt;
};
const port = Number(arg('port', 9229));
const outDir = arg('out', process.cwd());
const seconds = Number(arg('seconds', 5));
const wantHeap = process.argv.includes('--heap');
mkdirSync(outDir, { recursive: true });

const log = (msg) => {
  console.log(`[cdp] ${msg}`);
};

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} 超时 ${ms}ms`)), ms)),
  ]);
}

const listUrl = `http://127.0.0.1:${port}/json/list`;
let targets;
try {
  targets = await (await fetch(listUrl)).json();
} catch (e) {
  console.error(`[cdp] 无法访问 ${listUrl}: ${e.message}`);
  console.error('[cdp] 说明该进程没有以 --inspect 启动；本次无法取 JS 侧证据（其余快照仍在）。');
  process.exit(3);
}
writeFileSync(join(outDir, 'inspector-targets.json'), JSON.stringify(targets, null, 1));
const main = targets.find((t) => t.type === 'node') ?? targets[0];
if (!main?.webSocketDebuggerUrl) {
  console.error('[cdp] /json/list 里没有可用的 node target');
  process.exit(4);
}
log(`连接 ${main.webSocketDebuggerUrl}`);

const ws = new WebSocket(main.webSocketDebuggerUrl);
await withTimeout(
  new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = (e) => rej(new Error(`WS 连接失败: ${e.message ?? 'unknown'}`));
  }),
  5000,
  'WS 连接',
);

let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  let msg;
  try {
    msg = JSON.parse(ev.data);
  } catch {
    return;
  }
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
};
const send = (method, params = {}, timeoutMs = 15000) => {
  const id = ++seq;
  return withTimeout(
    new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    }),
    timeoutMs,
    method,
  );
};

// 1) 探活：主线程是否还能跑 JS。这是"卡死"最硬的判据。
const probe = { evaluatedAt: new Date().toISOString() };
for (const [label, expression] of [
  ['ping', '1+1'],
  ['memory', 'JSON.stringify(process.memoryUsage())'],
  ['eventloop', 'JSON.stringify({uptime:process.uptime(),cpu:process.cpuUsage()})'],
]) {
  const t0 = Date.now();
  try {
    const r = await send('Runtime.evaluate', { expression, timeout: 2000 }, 4000);
    probe[label] = { ok: true, ms: Date.now() - t0, value: r?.result?.value ?? null };
  } catch (e) {
    probe[label] = { ok: false, ms: Date.now() - t0, error: e.message };
  }
}
writeFileSync(join(outDir, 'inspector-probe.json'), JSON.stringify(probe, null, 1));
log(`主线程探活: ${probe.ping?.ok ? `有响应(${probe.ping.ms}ms)` : `无响应(${probe.ping?.error ?? '-'})`}`);

// 2) CPU profile：即使主线程忙等，采样也能拿到热点函数。
try {
  await send('Profiler.enable', {}, 5000);
  await send('Profiler.setSamplingInterval', { interval: 1000 }, 5000);
  await send('Profiler.start', {}, 5000);
  log(`采样 ${seconds}s ...`);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const { profile } = await send('Profiler.stop', {}, 120000);
  writeFileSync(join(outDir, 'cpu-profile.json'), JSON.stringify(profile));

  const byNode = new Map();
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  for (let i = 0; i < profile.samples.length; i += 1) {
    const id = profile.samples[i];
    const dt = profile.timeDeltas[i] ?? 0;
    byNode.set(id, (byNode.get(id) ?? 0) + dt);
  }
  const rows = [...byNode.entries()]
    .map(([id, us]) => {
      const cf = nodes.get(id)?.callFrame ?? {};
      const url = (cf.url ?? '').replace(/^file:\/\/\/?/, '');
      return {
        selfMs: us / 1000,
        fn: cf.functionName || '(anonymous)',
        where: `${url}:${(cf.lineNumber ?? 0) + 1}`,
      };
    })
    .sort((a, b) => b.selfMs - a.selfMs);
  const total = rows.reduce((s, r) => s + r.selfMs, 0);
  const lines = [
    `采样窗口 ${seconds}s，总样本时长 ${(total / 1000).toFixed(2)}s（自耗时 Top 30）`,
    '',
    ...rows
      .slice(0, 30)
      .map((r, i) => `${String(i + 1).padStart(2)}. ${r.selfMs.toFixed(0).padStart(6)}ms  ${(r.selfMs / 10 / total * 100 || 0).toFixed(1).padStart(5)}%  ${r.fn}  @ ${r.where}`),
  ];
  writeFileSync(join(outDir, 'cpu-profile-top.txt'), lines.join('\n'));
  log('CPU 热点:');
  console.log(lines.slice(2, 14).join('\n'));
} catch (e) {
  writeFileSync(join(outDir, 'cpu-profile-error.txt'), String(e?.stack ?? e));
  log(`CPU profile 失败: ${e.message}`);
}

// 3) 可选堆快照（很大，几十 MB 起）
if (wantHeap) {
  try {
    log('抓取堆快照 ...');
    const chunks = [];
    const onChunk = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === 'HeapProfiler.addHeapSnapshotChunk') chunks.push(msg.params.chunk);
    };
    ws.addEventListener('message', onChunk);
    await send('HeapProfiler.enable');
    await send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }, 300000);
    ws.removeEventListener('message', onChunk);
    const file = join(outDir, 'heap.heapsnapshot');
    writeFileSync(file, chunks.join(''));
    log(`堆快照: ${file}`);
  } catch (e) {
    log(`堆快照失败: ${e.message}`);
  }
}

ws.close();
log(`完成，产物在 ${outDir}`);
