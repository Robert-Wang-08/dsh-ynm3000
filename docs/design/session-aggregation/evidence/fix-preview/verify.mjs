// P0 fix preview verification. Reads only; does not touch Focus Hub data.
import { firstFrameHeader, scanWorkspace } from './dsh-source.fixed.mjs';
import { readdir, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const sessionsRoot = path.join(os.homedir(), '.dsh', 'sessions');
const large = [];
for (const project of await readdir(sessionsRoot, { withFileTypes: true })) {
  if (!project.isDirectory()) continue;
  const pdir = path.join(sessionsRoot, project.name);
  for (const session of await readdir(pdir, { withFileTypes: true })) {
    if (!session.isDirectory()) continue;
    const file = path.join(pdir, session.name, 'session.v4.jsonl.zstd');
    try {
      const st = await stat(file);
      if (st.size >= 1048576) large.push({ file, size: st.size, session: session.name });
    } catch { /* no v4 file */ }
  }
}

const decode = [];
for (const item of large) {
  const t0 = Date.now();
  try {
    const buf = await readFile(item.file);
    const text = await firstFrameHeader(buf);
    decode.push({ session: item.session, size: item.size, ms: Date.now() - t0, ok: true, textLen: text.length, head: text.slice(0, 40) });
  } catch (err) {
    decode.push({ session: item.session, size: item.size, ms: Date.now() - t0, ok: false, error: String(err && err.message || err) });
  }
}

const workspaces = [
  'D:\\src\\ncbs',
  'D:\\src\\dsh',
  'D:\\src\\ynm3000',
  'D:\\nutstore\\1.logseq',
  'D:\\src\\ynm3000\\skillhub',
];
const scans = [];
for (const workspace of workspaces) {
  const t0 = Date.now();
  try {
    const r = await scanWorkspace({ sessionsRoot, workspace, taskId: '__ingest__', limit: 20 });
    scans.push({ workspace, ms: Date.now() - t0, messages: r.messages.length, sessionsScanned: r.sessionsScanned.length, partial: !!r.partial, errors: r.errors || [] });
  } catch (err) {
    scans.push({ workspace, ms: Date.now() - t0, error: String(err && err.message || err) });
  }
}

console.log(JSON.stringify({
  largeFiles: large.length,
  decodeOk: decode.filter((x) => x.ok).length,
  decodeFail: decode.filter((x) => !x.ok).length,
  decodeMsTotal: decode.reduce((s, x) => s + x.ms, 0),
  decodeFailures: decode.filter((x) => !x.ok).slice(0, 5),
  scans,
}, null, 2));
