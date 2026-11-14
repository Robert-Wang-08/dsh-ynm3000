/**
 * Focus Hub ← DSH 会话 只读增量适配器（v4 JSONL / Zstandard 多帧容器）。
 *
 * 契约：.ptc/contracts/20261020-real-dsh-source.json
 * - 纯只读：不写、不截断、不修复、不迁移任何会话文件；不碰 DSH 安装/配置/凭据。
 * - 只输出人类可见正文：user/message（source.kind==="user"）与 assistant/message，
 *   且 surfaceOp==='append'（append-origin 才是 transcript；replace 副本与 compaction
 *   是模型上下文，会隐藏用户见过的历史，不得冒充聊天记录）。内容只取 type:"text"。
 * - 工作区匹配：header.cwd 的 canonical 绝对路径精确相等（win32 大小写不敏感）；
 *   项目目录名是有损编码，只作候选，不作权威。
 * - 游标绑定 taskId + workspace + sessionId；contentDigest 覆盖「从文件第一行到
 *   游标推进点」的全部有效行，历史替换/截短会显式报 history-changed/shortened。
 * - 分页按「消息条数」推进：limit 截断时游标只推进到最后一条“已返回”消息，
 *   未返回的块/消息下次继续，不丢不重。每次扫描全量重解码校验（本切片不缓存）。
 * - 不依赖 @deepseek-ai 包；只用 node:zlib / node:fs / node:crypto / node:path。
 */
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const FORMAT_VERSION = 4;
export const DEFAULTS = {
  limit: 50,
  maxCompressedBytes: 64 * 1024 * 1024,
  maxFrameDecodedBytes: 128 * 1024 * 1024,
  maxTotalDecodedBytes: 256 * 1024 * 1024,
};

export class SourceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) { throw new SourceError(code, message); }

/* ---- 工作区目录编码：与 dsh-session-persistence-jsonl 的 projectKey 一致 ---- */
export function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) fail('bad-workspace', 'cannot encode an empty project path');
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
      separatorRun = false;
    }
  }
  return '--' + ((readable.replace(/^-+/, '') || 'root').slice(0, 251)) + '--';
}

export function canonicalWorkspace(dir) {
  if (typeof dir !== 'string' || dir.trim() === '') fail('bad-workspace', 'workspace 必须是非空路径');
  return path.resolve(dir);
}

function samePath(a, b) {
  const x = path.resolve(a), y = path.resolve(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function zstdAvailable() { return typeof zlib.zstdDecompressSync === "function"; }

/* ---- 单帧/多帧解码 ---- */

/* P0 preview: stream-decompress only until the first header line.
   Avoids both the original 1 MiB input cap and decoding a >128 MiB first frame. */
export function firstFrameHeader(buf) {
  if (!zstdAvailable()) fail("zstd-unsupported", "当前 Node 缺少 zlib.zstdDecompressSync");
  return new Promise((resolve, reject) => {
    const stream = zlib.createZstdDecompress();
    let text = '';
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      try { stream.destroy(); } catch { /* already closed */ }
      if (err) {
        try { fail('zstd-decode', '首帧解码失败：' + err.message); } catch (e) { reject(e); }
      } else {
        resolve(text);
      }
    };
    stream.on('data', (chunk) => {
      text += chunk.toString('utf8');
      if (text.includes('\n')) finish();
      else if (text.length > (1 << 20)) finish(new Error('header exceeds 1 MiB without newline'));
    });
    stream.on('error', (e) => finish(e));
    stream.on('end', () => finish());
    stream.end(buf);
  });
}

function parseHeaderLine(text, sessionId) {
  const first = text.split('\n').find((l) => l.trim() !== '');
  if (!first) fail('empty-log', '会话没有任何行');
  let header;
  try { header = JSON.parse(first); } catch { fail("invalid-json", "首行不是 JSON"); }
  if (header.type !== 'session') fail('bad-header', '首行不是 session 头');
  if (header.version !== FORMAT_VERSION) fail('unsupported-version', '只支持 v4，实际 v' + header.version);
  if (header.id !== sessionId) fail('identity-mismatch', 'header.id 与目录名不一致');
  if (typeof header.cwd !== 'string' || header.cwd === '') fail('no-cwd', 'header 缺 cwd');
  return header;
}

function isHumanMessageEvent(ev) {
  if (ev.surfaceOp !== 'append') return false;
  if (ev.type === 'user/message') {
    const d = ev.data || {};
    return !!(d.source && d.source.kind === "user" && Array.isArray(d.content));
  }
  if (ev.type === 'assistant/message') {
    const d = ev.data || {};
    return !!(d.message && Array.isArray(d.message.content));
  }
  return false;
}

function textBlocksOf(ev) {
  const d = ev.data || {};
  const content = ev.type === 'user/message' ? d.content : d.message.content;
  const messageId = (ev.type === 'user/message' ? d.id : d.message.id) || 'seq-' + ev.seq;
  const out = [];
  content.forEach((block, blockIndex) => {
    if (block && block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      out.push({ blockIndex, text: block.text, messageId });
    }
  });
  return out;
}

/* ---- 发现：只进 workspace 对应的项目目录，不跟 symlink ---- */

async function discoverSessionDirs(sessionsRoot, workspaceCanonical) {
  let rootStat;
  try { rootStat = await fsp.stat(sessionsRoot); }
  catch { fail('root-missing', '会话根目录不可访问：' + sessionsRoot); }
  if (!rootStat.isDirectory()) fail('root-invalid', '会话根不是目录：' + sessionsRoot);
  const key = projectKey(workspaceCanonical);
  const lowerKey = key.toLowerCase();
  const rootEntries = await fsp.readdir(sessionsRoot, { withFileTypes: true });
  const projectDirs = [];
  for (const ent of rootEntries) {
    if (!ent.isDirectory()) continue;
    if (ent.name === key || (process.platform === 'win32' && ent.name.toLowerCase() === lowerKey)) projectDirs.push(ent.name);
  }
  const sessions = [];
  for (const pdir of projectDirs) {
    const ppath = path.join(sessionsRoot, pdir);
    let ents;
    try { ents = await fsp.readdir(ppath, { withFileTypes: true }); }
    catch { fail("root-invalid", "项目目录不可读：" + ppath); }
    for (const ent of ents) {
      if (!ent.isDirectory()) continue;
      const spath = path.join(ppath, ent.name);
      let st;
      try { st = await fsp.lstat(spath); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      sessions.push({ sessionId: ent.name, dir: spath });
    }
  }
  sessions.sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1));
  return sessions;
}

/* 只挑唯一的 v4 generation；其它版本/双编码并存 → 明确 unsupported，不静默跳过 */
async function pickGenerationFile(sessionDir) {
  const ents = await fsp.readdir(sessionDir);
  const v4 = [];
  let sawOther = false;
  for (const name of ents) {
    const ver = name.match(/^session\.v(\d+)\.jsonl(\.zstd)?$/);
    if (ver) {
      if (Number(ver[1]) === FORMAT_VERSION) v4.push({ name, zstd: !!ver[2] });
      else sawOther = true;
      continue;
    }
    if (/^session\.jsonl(\.zstd)?$/.test(name)) sawOther = true;
  }
  if (v4.length === 0) fail('unsupported-version', sawOther ? '只发现非 v4 的会话文件（不自动迁移）' : '目录里没有 v4 会话文件');
  if (v4.length > 1) fail('encoding-mismatch', '同一 v4 存在多个 generation/编码：' + v4.map((g) => g.name).join(','));
  return v4[0];
}

/* ---- 单会话扫描（全量重解码；digest 覆盖文件首行到推进点） ---- */

async function scanSession(session, workspaceCanonical, prev, options, warnings) {
  const gen = await pickGenerationFile(session.dir);
  const file = path.join(session.dir, gen.name);
  const buf = await fsp.readFile(file);
  if (gen.zstd && buf.length > options.maxCompressedBytes) fail("too-large", "压缩文件超过上限：" + file);
  const headerText = gen.zstd ? await firstFrameHeader(buf) : buf.toString("utf8");
  const header = parseHeaderLine(headerText, session.sessionId);
  if (!samePath(header.cwd, workspaceCanonical)) fail('workspace-mismatch', 'header.cwd 与请求工作区不一致：' + header.cwd);
  const inherited = Number(header.inheritedEventCount || 0) || 0;
  const messages = [];
  let procSeq = -1;
  let eventCount = 0;
  let digest = createHash("sha256");
  let boundaryVerified = !prev || prev.lastSeq < 0; // lastSeq<0：上次只扫到 header，无事件可比对
  let boundaryDigestHex = null; // 最后一次“已返回消息”所在行的摘要快照（覆盖文件首行到该行）
  let stop = false;
  let lastReturnedSeq = -1;
  let lastReturnedBlock = -1;
  const prevSeq = prev ? prev.lastSeq : -1;
  const prevBlock = prev ? prev.lastBlockIndex : -1;

  let headerSeen = false;
  function handleLine(line) {
    if (line.trim() === '') return false;
    if (!headerSeen) {
      let h;
      try { h = JSON.parse(line); } catch { fail('invalid-json', '首行不是 JSON'); }
      if (h.type !== 'session') fail('bad-header', '首行不是 session 头');
      digest.update(line);
      digest.update('\n');
      headerSeen = true;
      return false;
    }
    let ev;
    try { ev = JSON.parse(line); }
    catch { fail('invalid-json', session.sessionId + ' 中有一行不是 JSON'); }
    if (!Number.isInteger(ev.seq) || typeof ev.type !== 'string') {
      fail('bad-event', '事件缺少整数 seq 或 type（seq=' + ev.seq + '）');
    }
    if (ev.seq !== procSeq + 1) fail("seq-gap", "seq 不连续：期望 " + (procSeq + 1) + " 实际 " + ev.seq);
    digest.update(line); // 只把完整解析的行计入摘要；torn 半行不计
    digest.update('\n');
    procSeq = ev.seq;
    eventCount += 1;
    if (!boundaryVerified && procSeq === prevSeq) {
      const snapshot = digest.copy().digest('hex'); // copy 校验，不终结累计哈希
      if (snapshot !== prev.contentDigest) fail('history-changed', '游标之前的历史内容发生了变化（替换/重写）');
      boundaryVerified = true;
    }
    if (ev.seq < inherited) return false;
    if (!isHumanMessageEvent(ev)) return false;
    for (const b of textBlocksOf(ev)) {
      if (ev.seq < prevSeq) continue;
      if (ev.seq === prevSeq && (prevBlock === -1 || b.blockIndex <= prevBlock)) continue; // -1=该事件已完整消费
      if (messages.length >= options.limit) { stop = true; break; }
      messages.push({
        id: session.sessionId + ':' + b.messageId + ':' + ev.seq + ':' + b.blockIndex,
        role: ev.type === 'user/message' ? 'user' : 'assistant',
        text: b.text,
        source: {
          sessionId: session.sessionId, messageId: b.messageId, seq: ev.seq,
          blockIndex: b.blockIndex, role: ev.type === "user/message" ? "user" : "assistant",
          time: ev.time || null, workspace: workspaceCanonical, formatVersion: FORMAT_VERSION,
        },
      });
      lastReturnedSeq = ev.seq;
      lastReturnedBlock = b.blockIndex;
      boundaryDigestHex = digest.copy().digest('hex');
    }
    return false;
  }

  if (gen.zstd) {
    let offset = 0;
    let totalDecoded = 0;
    while (offset < buf.length) {
      let r;
      try {
        r = zlib.zstdDecompressSync(buf.subarray(offset), { info: true, maxOutputLength: options.maxFrameDecodedBytes });
      } catch (e) {
        if (offset > 0) { warnings.push(session.sessionId + ': 末帧不完整，按完整前缀读取（未修改源文件）'); break; }
        fail('zstd-decode', '首帧解码失败：' + e.message);
      }
      const written = r.engine && r.engine.bytesWritten;
      if (!written) {
        if (offset > 0) { warnings.push(session.sessionId + ': 末帧不完整，按完整前缀读取（未修改源文件）'); break; }
        fail('zstd-stall', '首帧解码无进展');
      }
      offset += written;
      totalDecoded += r.buffer.length;
      if (totalDecoded > options.maxTotalDecodedBytes) fail('too-large', '解码总量超上限');
      const frameText = r.buffer.toString('utf8');
      const tailFrame = offset >= buf.length; // 已消费到最后一个压缩字节
      try {
        for (const line of frameText.split('\n')) {
          handleLine(line);
          if (stop) break;
        }
      } catch (e) {
        if (e instanceof SourceError && e.code === 'invalid-json' && tailFrame && !frameText.endsWith('\n')) {
          warnings.push(session.sessionId + ': 末帧不完整，按完整前缀读取（未修改源文件）');
          break;
        }
        throw e;
      }
      if (tailFrame && !frameText.endsWith('\n')) {
        // 截断帧可能解码「成功」但输出为空/半行：只要末帧明文不以换行收束即按 torn tail 告警
        warnings.push(session.sessionId + ': 末帧不完整，按完整前缀读取（未修改源文件）');
      }
      if (stop) break;
    }
  } else {
    for (const line of buf.toString('utf8').split('\n')) {
      handleLine(line);
      if (stop) break;
    }
  }
  if (!boundaryVerified) fail('history-shortened', '日志在游标之前被截短：期望 seq ' + prevSeq);
  const cursor = stop
    ? { lastSeq: lastReturnedSeq, lastBlockIndex: lastReturnedBlock, eventCount, contentDigest: boundaryDigestHex }
    : { lastSeq: procSeq, lastBlockIndex: -1, eventCount, contentDigest: digest.copy().digest('hex') };
  return { header, file, bytes: buf.length, messages, limitReached: stop, cursor };
}

/* ---- 主入口 ---- */
export async function scanWorkspace(input) {
  if (!input || typeof input !== 'object') fail('bad-input', '需要 options 对象');
  const options = { ...DEFAULTS, limit: Number.isInteger(input.limit) && input.limit > 0 ? input.limit : DEFAULTS.limit };
  const workspaceCanonical = canonicalWorkspace(input.workspace);
  if (typeof input.taskId !== 'string' || input.taskId === '') fail('bad-input', 'taskId 必须是非空字符串');
  if (typeof input.sessionsRoot !== 'string' || input.sessionsRoot === '') fail('bad-input', 'sessionsRoot 必须是非空路径');
  let cursor = input.cursor || null;
  if (cursor) {
    if (cursor.version !== 1) fail('cursor-mismatch', '不认识的 cursor 版本');
    if (cursor.taskId !== input.taskId) fail('cursor-mismatch', 'cursor.taskId 与请求不一致');
    if (!samePath(cursor.workspace, workspaceCanonical)) fail("cursor-mismatch", "cursor.workspace 与请求不一致");
  }
  const warnings = [];
  const errors = [];
  const messages = [];
  const sessionsScanned = [];
  const proposedSessions = {};
  const discovered = await discoverSessionDirs(input.sessionsRoot, workspaceCanonical);
  let hasMore = false;
  for (const s of discovered) {
    if (messages.length >= options.limit) { hasMore = true; break; }
    const prev = cursor && cursor.sessions ? cursor.sessions[s.sessionId] || null : null;
    try {
      const sessionOptions = { ...options, limit: Math.max(1, options.limit - messages.length) }; // 全局 limit 按剩余预算分配
      const r = await scanSession(s, workspaceCanonical, prev, sessionOptions, warnings);
      if (r.limitReached) hasMore = true;
      messages.push(...r.messages);
      proposedSessions[s.sessionId] = r.cursor;
      sessionsScanned.push({ sessionId: s.sessionId, delegated: (r.header.delegationDepth || 0) > 0, file: r.file, bytes: r.bytes, newMessages: r.messages.length, limitReached: r.limitReached });
      if (r.limitReached) break;
    } catch (e) {
      if (e instanceof SourceError) {
        errors.push({ sessionId: s.sessionId, code: e.code, message: e.message });
        if (prev) proposedSessions[s.sessionId] = prev;
      } else {
        throw e;
      }
    }
  }
  return {
    ok: true,
    partial: errors.length > 0,
    workspace: workspaceCanonical,
    taskId: input.taskId,
    sessionsScanned,
    messages,
    hasMore,
    proposedCursor: { version: 1, taskId: input.taskId, workspace: workspaceCanonical, sessions: proposedSessions },
    warnings,
    errors,
  };
}

/* ---- CLI（只读；cursor 文件只读入，不写回） ---- */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sessions-root') args.sessionsRoot = argv[++i];
    else if (a === '--workspace') args.workspace = argv[++i];
    else if (a === '--task-id') args.taskId = argv[++i];
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--cursor-file') args.cursorFile = argv[++i];
    else fail('bad-args', '未知参数：' + a);
  }
  return args;
}

export async function runCli(argv) {
  const args = parseArgs(argv);
  let cursor = null;
  if (args.cursorFile) cursor = JSON.parse(await fsp.readFile(args.cursorFile, 'utf8'));
  return scanWorkspace({
    sessionsRoot: args.sessionsRoot,
    workspace: args.workspace,
    taskId: args.taskId,
    limit: args.limit,
    cursor,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runCli(process.argv.slice(2));
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (e) {
    process.stderr.write('[dsh-source] ' + (e.code || 'error') + ': ' + e.message + '\n');
    process.exit(1);
  }
}
