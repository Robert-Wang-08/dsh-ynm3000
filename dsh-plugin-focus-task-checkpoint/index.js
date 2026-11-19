import { spawn } from 'node:child_process';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const pluginDir = dirname(fileURLToPath(import.meta.url));
const statePath = join(process.env.FOCUS_HUB_STATE_DIR || join(os.homedir(), '.focus-hub'), 'dsh-hook-state.json');
const baseUrl = process.env.FOCUS_HUB_BASE_URL || 'http://127.0.0.1:8770';

/**
 * 提交脚本（skills/focus-task/scripts/submit.mjs）的查找顺序。
 *
 * 插件本体在 dsh 仓库（`dsh-plugin-focus-task-checkpoint`），skill 本体在 SkillHub
 * store（`store/installed/focus-task`），二者不再相邻。默认按 DSH 用户级 skill 根
 * `~/.dsh/skills/focus-task/scripts/submit.mjs`（`skillhub deploy focus-task --to dsh`
 * 的落点）解析；插件配置 `submitScript` 与 `FOCUS_HUB_SUBMIT_SCRIPT` 可覆盖。
 * 最后的 `../scripts/submit.mjs` 只用于旧版「插件放在 skill 目录 dsh/ 下」的布局。
 */
export function submitScriptCandidates({ config = {}, env = process.env, home = os.homedir(), pluginRoot = pluginDir } = {}) {
  const candidates = [];
  if (typeof config?.submitScript === 'string' && config.submitScript.trim()) {
    candidates.push(resolve(config.submitScript.trim()));
  }
  if (typeof env.FOCUS_HUB_SUBMIT_SCRIPT === 'string' && env.FOCUS_HUB_SUBMIT_SCRIPT.trim()) {
    candidates.push(resolve(env.FOCUS_HUB_SUBMIT_SCRIPT.trim()));
  }
  candidates.push(join(home, '.dsh', 'skills', 'focus-task', 'scripts', 'submit.mjs'));
  candidates.push(resolve(pluginRoot, '..', 'scripts', 'submit.mjs'));
  return [...new Set(candidates)];
}

/** 返回第一个存在的提交脚本路径；都不存在时返回 null。 */
export async function resolveSubmitScript(options = {}) {
  for (const candidate of submitScriptCandidates(options)) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function fingerprint(todos) {
  return JSON.stringify(todos.map((item) => ({
    content: typeof item?.content === 'string' ? item.content : '',
    status: typeof item?.status === 'string' ? item.status : '',
  })));
}

function isSubagent(session) {
  const header = session?.header || {};
  return header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0;
}

async function readProjectId(cwd) {
  if (!cwd) return '';
  try {
    const binding = JSON.parse(await readFile(join(cwd, '.focus-hub.json'), 'utf8'));
    return typeof binding?.projectId === 'string' ? binding.projectId.trim() : '';
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return '';
  }
}

async function loadState() {
  try {
    const parsed = JSON.parse(await readFile(statePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { sessions: {} };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { sessions: {} };
  }
}

async function saveState(state) {
  await mkdir(dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(state), 'utf8');
  await rename(temporary, statePath);
}

function oneLine(text, recent) {
  const clause = String(text || '').trim().split(/[。！？；;\n]/)[0].split(/[、，,]/)[0].trim().replace(/已完成/g, '声称完成').slice(0, 28);
  const prior = (recent || []).find((item) => String(item).replace(/。$/, '') === clause);
  if (prior) return prior.endsWith('。') ? prior : `${prior}。`;
  return `${clause || '提交检查点'}。`;
}

function checkpointFor(sessionId, revision, turn, todos, recentTitles) {
  const doneItems = todos.filter((item) => item?.status === 'completed' && item.content).map((item) => ({
    text: item.content,
    status: 'claimed',
    evidenceType: 'agent-text',
    evidence: `dsh:todo/write turn ${turn}`,
  }));
  const pendingCandidates = todos.filter((item) => item?.content && item.status !== 'completed').map((item) => item.content);
  const primary = doneItems[0]?.text || pendingCandidates[0] || '';
  return {
    sessionId,
    revision,
    title: oneLine(primary, recentTitles),
    doneItems,
    pendingCandidates,
    decisions: ['DSH 钩子在 turn/end 提交清单差异，标为声称待验证'],
    topics: ['focus-task'],
    openQuestions: [],
    artifacts: [],
  };
}

function runSubmit(script, checkpointPath, cwd, projectId, sessionId, revision) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [
      script,
      '--checkpoint', checkpointPath,
      '--cwd', cwd,
      '--project-id', projectId,
      '--session-id', sessionId,
      '--revision', String(revision),
      '--base-url', baseUrl,
      '--model', 'dsh-hook',
    ], { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolvePromise({ ok: false, error: String(error.message || error) }));
    child.on('close', (code) => resolvePromise({ ok: code === 0, code, stdout, stderr }));
  });
}

export function apply(ctx, config = {}) {
  const live = new Map();
  const chains = new Map();
  let disk = { sessions: {} };
  const ready = loadState().then((state) => { disk = state; }).catch((error) => {
    ctx.logger?.warn?.(`focus-task hook state unreadable: ${error.message || error}`);
  });

  let submitScript;
  let submitScriptResolved = false;
  const locateSubmitScript = async () => {
    if (submitScriptResolved) return submitScript;
    submitScriptResolved = true;
    submitScript = await resolveSubmitScript({ config });
    if (!submitScript) {
      ctx.logger?.warn?.(
        'focus-task hook: submit.mjs not found; deploy the skill (skillhub deploy focus-task --to dsh) '
        + 'or set FOCUS_HUB_SUBMIT_SCRIPT / the plugin config submitScript',
      );
    }
    return submitScript;
  };

  const enqueue = (session, row, turn, seq) => {
    const previous = chains.get(session.id) || Promise.resolve();
    const next = previous.then(async () => {
      await ready;
      const saved = disk.sessions[session.id] || { revision: 0, fingerprint: null, seq: 0 };
      if (Number.isFinite(seq) && seq <= saved.seq) return;
      if (row.fingerprint === saved.fingerprint) {
        row.dirty = false;
        return;
      }
      const cwd = session.header?.cwd;
      const projectId = await readProjectId(cwd);
      if (!projectId) {
        ctx.logger?.info?.(`focus-task hook skipped ${session.id}: no .focus-hub.json`);
        return;
      }
      const script = await locateSubmitScript();
      if (!script) {
        row.dirty = false;
        return;
      }
      const revision = Number(saved.revision || 0) + 1;
      const file = join(tmpdir(), `focus-task-${session.id}-rev${revision}.json`);
      const recentTitles = Array.isArray(disk.recentTitles) ? disk.recentTitles : [];
      const checkpoint = checkpointFor(session.id, revision, turn, row.todos, recentTitles);
      await writeFile(file, JSON.stringify(checkpoint), 'utf8');
      const result = await runSubmit(script, file, cwd, projectId, session.id, revision);
      ctx.logger?.info?.(`focus-task hook ${session.id} rev ${revision}: ${result.stdout || result.stderr || result.error || ''}`);
      if (!result.ok) return;
      disk.sessions[session.id] = { revision, fingerprint: row.fingerprint, seq: seq || saved.seq };
      disk.recentTitles = [checkpoint.title, ...recentTitles.filter((item) => item !== checkpoint.title)].slice(0, 8);
      row.dirty = false;
      row.submittedFingerprint = row.fingerprint;
      await saveState(disk);
    }).catch((error) => {
      ctx.logger?.warn?.(`focus-task hook failed: ${error.message || error}`);
    });
    chains.set(session.id, next);
  };

  ctx.on('session/event', (session, event) => {
    if (!session?.id || isSubagent(session)) return;
    if (event?.type === 'todo/write') {
      const todos = Array.isArray(event.data?.todos) ? event.data.todos : [];
      const mark = fingerprint(todos);
      const row = live.get(session.id) || { dirty: false, submittedFingerprint: null };
      row.todos = todos;
      row.fingerprint = mark;
      row.dirty = mark !== row.submittedFingerprint;
      live.set(session.id, row);
      return;
    }
    if (event?.type === 'turn/end') {
      const row = live.get(session.id);
      if (!row?.dirty || !row.todos?.length) return;
      enqueue(session, row, event.data?.turn ?? '', event.seq);
    }
  });
}
