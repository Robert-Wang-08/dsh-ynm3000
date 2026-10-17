/**
 * Bounded live probe for an ACP child: does the command start, how fast does it
 * handshake, and does it answer a prompt?
 *
 * This is the diagnostic counterpart to the fake-child test suite: it uses the
 * SAME tier numbers the provider enforces, against a real agent binary, so an
 * operator can tell "the process never started" apart from "the session stalled"
 * apart from "the agent is just slow".
 *
 * Usage:
 *   node tools/probe-acp.mjs --command cursor-agent --args acp --cwd <dir>
 *   node tools/probe-acp.mjs --command opencode --args acp
 *   node tools/probe-acp.mjs --command cursor-agent --args acp --shell   (cmd.exe /c wrapper)
 */
import { spawn } from 'node:child_process';
import { PROTOCOL_VERSION, client, methods, ndJsonStream } from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';

const { values } = parseArgs({
  options: {
    command: { type: 'string' },
    args: { type: 'string', multiple: true },
    cwd: { type: 'string' },
    shell: { type: 'boolean', default: false },
    prompt: { type: 'string' },
    'process-start-timeout': { type: 'string', default: '30000' },
    'session-setup-timeout': { type: 'string', default: '60000' },
    'prompt-timeout': { type: 'string', default: '60000' }
  }
});
const command = values.command;
if (command === undefined) {
  console.error('probe-acp: --command is required');
  process.exit(2);
}
const args = values.args ?? [];
const cwd = resolve(values.cwd ?? process.cwd());
const processStartTimeoutMs = Number(values['process-start-timeout']);
const sessionSetupTimeoutMs = Number(values['session-setup-timeout']);
const promptTimeoutMs = Number(values['prompt-timeout']);

/** Wrap one phase in its own deadline so the probe always terminates. */
function withDeadline(label, ms, work) {
  const startedAt = Date.now();
  let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: exceeded ${ms}ms`)), ms);
  });
  return Promise.race([work(), expiry]).then(
    (value) => ({ ok: true, value, ms: Date.now() - startedAt }),
    (error) => ({ ok: false, error, ms: Date.now() - startedAt })
  ).finally(() => clearTimeout(timer));
}

const child = values.shell
  ? spawn('cmd.exe', ['/c', command, ...args], { cwd, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
  : spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });

let exited;
const exitPromise = new Promise((resolveExit) => {
  exited = resolveExit;
});
child.on('error', (error) => exited({ error: error.code ?? error.message }));
child.on('exit', (code, signal) => exited({ code, signal }));

const requestLog = [];
const notifications = [];
let lastActivityAt = Date.now();
let lastActivity = 'spawn';

const clientStartedAt = Date.now();
const agent = client({ name: 'dsh-acp-probe' })
  .onNotification(methods.client.session.update, ({ params }) => {
    lastActivityAt = Date.now();
    lastActivity = `session-update:${params.update.sessionUpdate}`;
    notifications.push(lastActivity);
    return Promise.resolve();
  })
  .onRequest(methods.client.session.requestPermission, () => {
    lastActivityAt = Date.now();
    lastActivity = 'permission-request';
    return Promise.resolve({ outcome: { outcome: 'cancelled' } });
  })
  .connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)))
  .agent;

const report = { command, args, cwd, shell: values.shell, phases: {} };

const started = await withDeadline('process-start', processStartTimeoutMs, async () => {
  const response = await agent.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {}
  });
  requestLog.push('initialize');
  lastActivityAt = Date.now();
  lastActivity = 'initialize-response';
  return response;
});
report.phases['process-start+initialize'] = started.ok
  ? { ok: true, ms: started.ms, protocolVersion: started.value?.protocolVersion, agentInfo: started.value?.agentInfo }
  : { ok: false, ms: started.ms, error: String(started.error?.message ?? started.error) };

if (started.ok) {
  const session = await withDeadline('session-setup', sessionSetupTimeoutMs, async () => {
    const response = await agent.request(methods.agent.session.new, { cwd, mcpServers: [] });
    requestLog.push('session/new');
    lastActivityAt = Date.now();
    lastActivity = 'session-created';
    return response;
  });
  report.phases['session-setup'] = session.ok
    ? { ok: true, ms: session.ms, sessionId: session.value?.sessionId }
    : { ok: false, ms: session.ms, error: String(session.error?.message ?? session.error) };

  if (session.ok) {
    const promptText = values.prompt ?? 'Reply with the single word: pong. Do not modify any files.';
    const prompt = await withDeadline('prompt', promptTimeoutMs, async () => {
      const response = await agent.request(methods.agent.session.prompt, {
        sessionId: session.value.sessionId,
        prompt: [{ type: 'text', text: promptText }]
      });
      requestLog.push('session/prompt');
      return response;
    });
    report.phases.prompt = prompt.ok
      ? { ok: true, ms: prompt.ms, stopReason: prompt.value?.stopReason }
      : { ok: false, ms: prompt.ms, error: String(prompt.error?.message ?? prompt.error) };
    /* Best-effort cooperative cancel so a stuck agent is not left running. */
    try {
      await agent.notify(methods.agent.session.cancel, { sessionId: session.value.sessionId });
    } catch {}
  }
}

report.totalMs = Date.now() - clientStartedAt;
report.lastActivity = lastActivity;
report.notifications = notifications.slice(0, 20);
report.requests = requestLog;

child.stdin.end();
const exit = await Promise.race([exitPromise, new Promise((r) => setTimeout(() => r({ timedOut: true }), 3000))]);
report.exit = exit;
console.log(JSON.stringify(report, null, 2));
process.exit(0);
