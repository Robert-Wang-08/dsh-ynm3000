/**
 * Fake ACP child used by the resilience tests.
 *
 * It is a real in-memory ACP agent over the same NDJSON framing the provider
 * uses, plus a controllable `SubprocessHandle` surface, so every scenario
 * (normal completion, late response, silent exit, stuck teardown, slow but
 * progressing work) is reproduced without spawning a real `cursor-agent`.
 */
import { PassThrough } from 'node:stream';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

/** Write `content` to `name` inside `dir`, creating subdirectories as needed. */
export function touchFile(dir, name, content = 'x') {
  const path = join(dir, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
  return path;
}

/** Every fake child built in this process, so a test run can close its streams. */
const createdChildren = [];

/** Destroy every fake child's streams so the test process can exit. */
export function destroyFakeChildren() {
  for (const entry of createdChildren.splice(0)) {
    for (const stream of [entry.toParent, entry.fromParent, entry.stderr]) {
      try {
        stream.destroy();
      } catch {}
    }
  }
}

/**
 * Build one fake ACP child.
 *
 * @param options.onPrompt - called with `{ result, notify, notifyText, exit, state, request }`
 *   when `session/prompt` arrives; it owns when (and whether) the prompt is answered.
 * @param options.onInitialize - called before the `initialize` response.
 * @param options.silent - never answer any ACP message (a started-but-mute child).
 * @param options.stallSessionNew - answer `initialize` but never `session/new`.
 * @param options.waitForExit - replaces the managed-range wait. The default
 *   resolves `true` once the child exits, and `false` when the passed signal
 *   aborts first — the seam contract.
 * @param options.ignoreStdinEnd - never exit when stdin closes (the hostile case).
 * @param options.autoExitOnTerminate - resolve `done` when `terminate()` is called.
 * @param options.endStdoutOnExit - close stdout when the child exits.
 */
export function createFakeChild(options = {}) {
  /** Child -> provider (stdout). */
  const toParent = new PassThrough();
  /** Provider -> child (stdin). */
  const fromParent = new PassThrough();
  /** Provider -> child (stderr): the provider requests `inherit`, which it never reads. */
  const stderr = new PassThrough();

  const state = { exited: false, terminated: false, cancelled: false, prompts: 0, updates: 0 };
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  done.catch(() => {});

  const send = (message) => {
    toParent.write(`${JSON.stringify(message)}\n`);
  };
  const respond = (id, result) => send({ jsonrpc: '2.0', id, result });
  const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
  const notifyText = (text) => {
    state.updates += 1;
    notify('session/update', {
      sessionId: 'fake-session',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
    });
  };
  /**
   * The spawned command exits. By default the stdout pipe stays readable, so
   * bytes already in flight still reach the provider — which is exactly the
   * "files modified, final response arrives late" race. `endStdoutOnExit` models
   * the harsher case where the pipe closes with the process.
   */
  const exit = (outcome = { exitCode: 0, signal: null }) => {
    if (state.exited) return;
    state.exited = true;
    resolveDone(outcome);
    if (options.endStdoutOnExit === true) toParent.end();
  };

  const child = {
    stdin: fromParent,
    stdout: toParent,
    stderr,
    control: undefined,
    collected: {},
    done,
    terminate() {
      state.terminated = true;
      if (options.autoExitOnTerminate === true) exit({ exitCode: null, signal: 'SIGTERM' });
      options.onTerminate?.(state, { exit });
    },
    waitForExit(signal) {
      if (typeof options.waitForExit === 'function') return options.waitForExit(signal, { state, child, done, exit });
      return new Promise((resolve, reject) => {
        if (state.exited) return resolve(true);
        let aborted = false;
        const onAbort = () => {
          aborted = true;
          resolve(false);
        };
        if (signal !== undefined) {
          if (signal.aborted) return resolve(false);
          signal.addEventListener('abort', onAbort, { once: true });
        }
        done.then(() => {
          if (signal !== undefined) signal.removeEventListener('abort', onAbort);
          resolve(aborted ? false : true);
        }, (error) => {
          if (signal !== undefined) signal.removeEventListener('abort', onAbort);
          reject(error);
        });
      });
    }
  };

  let buffer = '';
  const handle = (message) => {
    /* `silent` reproduces a child that started but never speaks ACP at all. */
    if (options.silent === true) return;
    if (message.method === 'initialize') {
      options.onInitialize?.(state);
      respond(message.id, { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} });
      return;
    }
    if (message.method === 'session/new') {
      /* `stallSessionNew` reproduces a child that handshakes but never creates a session. */
      if (options.stallSessionNew === true) return;
      respond(message.id, { sessionId: 'fake-session' });
      return;
    }
    if (message.method === 'session/prompt') {
      state.prompts += 1;
      options.onPrompt?.({
        message,
        result: (value) => respond(message.id, value),
        notify,
        notifyText,
        exit,
        state,
        child
      });
      return;
    }
    if (message.method === 'session/cancel') {
      state.cancelled = true;
      options.onCancel?.(state);
    }
  };
  fromParent.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length === 0) continue;
      try {
        handle(JSON.parse(line));
      } catch {}
    }
  });

  /*
   * A cooperative ACP child exits once its stdin closes — that is what the
   * provider's EOF grace relies on. `ignoreStdinEnd` models the hostile case
   * where it does not, which is the hang this provider must bound.
   */
  const onStdinClosed = () => {
    if (options.ignoreStdinEnd === true || state.exited) return;
    setTimeout(() => exit({ exitCode: 0, signal: null }), options.stdinEndExitDelayMs ?? 5);
  };
  fromParent.on('end', onStdinClosed);
  fromParent.on('finish', onStdinClosed);
  fromParent.on('close', onStdinClosed);

  createdChildren.push({ child, toParent, fromParent, stderr });
  return { child, state, exit, notify, notifyText, rejectDone };
}

/** A minimal `ResolvedSubagentStartRequest` for `startAcpRun`. */
export function makeRequest(cwd, { prompt = 'do the thing', signal } = {}) {
  return {
    label: 'resilience-test',
    prompt: [{ type: 'text', text: prompt }],
    parent: { session: { header: { cwd } } },
    signal: signal ?? new AbortController().signal
  };
}

/** Fast tier settings: the whole ladder runs in well under a second. */
export const FAST_TIERS = Object.freeze({
  disposeEofGraceMs: 60,
  disposeGraceMs: 20,
  disposeFinalGraceMs: 80,
  disposalTimeoutMs: 400,
  processStartTimeoutMs: 200,
  startupTimeoutMs: 400,
  idleWarnMs: 120,
  idleTimeoutMs: 4000,
  softTimeoutMs: 400,
  absoluteTimeoutMs: 1200,
  complexSoftTimeoutMs: 900,
  complexHardTimeoutMs: 2200,
  activityExtensionMs: 20,
  activityProbeMs: 20,
  exitSettleMs: 150,
  recoverySettleMs: 10,
  workspaceScanLimit: 2000
});

/** A complete `AcpRunSpec` over one fake child, with every bound overridable. */
export function makeSpec(cwd, fake, overrides = {}) {
  const warnings = [];
  const errors = [];
  return {
    warnings,
    errors,
    spec: {
      providerName: 'cursor',
      command: 'cursor-agent',
      args: ['acp'],
      cwd,
      permission: 'allow',
      env: {},
      ...FAST_TIERS,
      spawn: () => fake.child,
      onWarn: (message) => warnings.push(message),
      onError: (error) => errors.push(error),
      ...overrides
    }
  };
}
