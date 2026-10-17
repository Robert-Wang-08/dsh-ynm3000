/**
 * One-off forensic scan: decompress DSH V4 session logs and report what the ACP
 * subagent path actually did (errors, timeouts, exits) in this machine's history.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const root = process.argv[2] ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions');
const PATTERNS = [
  'subagent-acp',
  'Subagent failure',
  'not found on PATH',
  'ENOENT',
  'EINVAL',
  'timed out',
  'TOOL_TIMEOUT',
  'workspace-guard',
  'managed-range',
  'dispose failed',
  'aborted before the ACP'
];

const hits = new Map();
let scanned = 0;
let bytes = 0;
let skipped = 0;

/** Collect every `session.v4.jsonl[.zstd]` under a workspace/session tree. */
function collect(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) collect(path, out);
    else if (entry.name.includes('session.v4.jsonl')) out.push(path);
  }
  return out;
}

for (const path of collect(root, [])) {
  const size = statSync(path).size;
  if (size > 12_000_000) {
    skipped += 1;
    continue;
  }
  let text;
  try {
    const raw = readFileSync(path);
    text = path.endsWith('.zstd') ? zstdDecompressSync(raw).toString('utf8') : raw.toString('utf8');
  } catch {
    skipped += 1;
    continue;
  }
  scanned += 1;
  bytes += size;
  for (const line of text.split('\n')) {
    for (const pattern of PATTERNS) {
      if (!line.includes(pattern)) continue;
      if (!hits.has(pattern)) hits.set(pattern, []);
      const list = hits.get(pattern);
      if (list.length < 6) list.push({ session: path.slice(root.length + 1), excerpt: line.slice(0, 420) });
    }
  }
}

console.log(JSON.stringify({ scanned, skipped, megabytes: Math.round(bytes / 1e6), hits: Object.fromEntries(hits) }, null, 2));
