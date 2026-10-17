/**
 * Behavioral resilience tests for the ACP subagent provider.
 *
 * Each test reproduces one real failure mode of driving `cursor-agent acp` (or
 * any ACP child) from a long-lived DSH session, and asserts on the provider's
 * observable contract rather than on its source text:
 *
 * 1. normal completion
 * 2. files modified, final response arrives late
 * 3. child exits without ever answering `session/prompt`
 * 4. partial completion, then the child goes silent (soft timeout)
 * 5. teardown cannot prove the managed range empty (bounded, not a hang)
 * 6. a silent-but-progressing child is never failed by a deadline
 * 7. the advisory idle warning fires without failing the run
 * 8. cancellation still settles as `aborted`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  apply,
  clearWorkspaceGuards,
  startAcpRun,
  workspaceGuardState
} from '../lib/index.js';
import { FAST_TIERS, createFakeChild, destroyFakeChildren, makeRequest, touchFile } from './helpers/fake-acp.mjs';

const TMP_ROOT = fileURLToPath(new URL('./.tmp/', import.meta.url));
mkdirSync(TMP_ROOT, { recursive: true });
let counter = 0;

/** One isolated workspace + recovery-record directory pair. */
function makeWorkspace() {
  counter += 1;
  const cwd = mkdtempSync(join(TMP_ROOT, `ws-${counter}-`));
  const recoveryRecordDir = join(cwd, '.recovery-records');
  return { cwd, recoveryRecordDir };
}

/** Build a provider the way the loader does, so `apply` validation runs too. */
function makeProvider(cwd, fake, overrides = {}) {
  const warnings = [];
  const errors = [];
  const registered = [];
  const ctx = {
    logger: { warn: (...args) => warnings.push(args.map(String).join(' ')) },
    subagents: { registerProvider: (provider) => registered.push(provider) },
    subprocess: { spawn: () => fake.child }
  };
  apply(ctx, {
    providerName: 'cursor',
    command: 'cursor-agent',
    args: ['acp'],
    cwd,
    permission: 'allow',
    env: {},
    guardWorkspaceReuse: true,
    recoveryRecordDir: join(cwd, '.recovery-records'),
    ...FAST_TIERS,
    ...overrides
  });
  assert.equal(registered.length, 1, 'apply must register exactly one provider');
  return { provider: registered[0], warnings, errors, ctx };
}

/** Await a settled result plus its disposal, mirroring what the tool layer does. */
async function settle(run) {
  const result = await run.result;
  let disposalError;
  try {
    await run.dispose();
  } catch (error) {
    disposalError = error;
  }
  return { result, disposalError };
}

const workspaces = [];
function workspace() {
  const made = makeWorkspace();
  workspaces.push(made.cwd);
  return made;
}

test.after(() => {
  destroyFakeChildren();
  for (const cwd of workspaces) {
    try {
      rmSync(cwd, { recursive: true, force: true, maxRetries: 3 });
    } catch {}
  }
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* Windows keeps a directory busy while a stream or the shell's redirect is open; the OS reclaims it. */
  }
});

test('1. normal completion settles as completed with the streamed output', async () => {
  clearWorkspaceGuards();
  const { cwd } = workspace();
  const fake = createFakeChild({
    onPrompt: ({ result, notifyText }) => {
      notifyText('finished the work');
      setTimeout(() => result({ stopReason: 'end_turn' }), 10);
    }
  });
  const { provider } = makeProvider(cwd, fake);
  const { result, disposalError } = await settle(await provider.start(makeRequest(cwd)));
  assert.equal(disposalError, undefined, 'dispose must not fail for a cooperative child');
  assert.equal(result.stopReason, 'completed');
  assert.equal(result.diagnostic, undefined);
  assert.equal(result.output.map((block) => block.text).join(''), 'finished the work');
});

test('2. files modified and the final response arrives late still completes', async () => {
  clearWorkspaceGuards();
  const { cwd } = workspace();
  const fake = createFakeChild({
    onPrompt: ({ result, notifyText, exit }) => {
      touchFile(cwd, 'src/app.js', 'edited');
      setTimeout(() => exit({ exitCode: 0, signal: null }), 40);
      /* After the exit, but inside the 150ms exit-settle window. */
      setTimeout(() => {
        notifyText('done after the process closed');
        result({ stopReason: 'end_turn' });
      }, 110);
    }
  });
  const { provider } = makeProvider(cwd, fake);
  const { result } = await settle(await provider.start(makeRequest(cwd)));
  assert.equal(result.stopReason, 'completed', 'a late-but-present response must not be recorded as an exit failure');
  assert.match(result.output.map((block) => block.text).join(''), /done after the process closed/);
});

test('3. a child that exits without answering session/prompt settles instead of hanging', async () => {
  clearWorkspaceGuards();
  const { cwd, recoveryRecordDir } = workspace();
  const fake = createFakeChild({
    onPrompt: ({ notifyText, exit }) => {
      notifyText('wrote the files, about to die');
      touchFile(cwd, 'src/generated.js', 'content');
      setTimeout(() => exit({ exitCode: 0, signal: null }), 30);
    }
  });
  const { provider } = makeProvider(cwd, fake, { recoveryRecordDir });
  const startedAt = Date.now();
  const run = await provider.start(makeRequest(cwd));
  const { result } = await settle(run);
  const elapsed = Date.now() - startedAt;

  assert.equal(result.stopReason, 'error', 'a missing terminal response is never reported as completed');
  assert.ok(elapsed < FAST_TIERS.absoluteTimeoutMs, `must settle after the exit-settle window, not the absolute ceiling (took ${elapsed}ms)`);
  assert.ok(elapsed >= FAST_TIERS.exitSettleMs, 'must give the in-flight response the full settle window');
  const diagnostic = result.diagnostic ?? '';
  assert.match(diagnostic, /category: process-exit/);
  assert.match(diagnostic, /exit settle ms: 150/);
  assert.match(diagnostic, /exit code: 0/);
  assert.match(diagnostic, /recovery: changes-preserved-unverified/);
  assert.match(diagnostic, /changed files: 1/);
  assert.match(diagnostic, /tests: not-verified/);
  assert.match(result.output.map((block) => block.text).join(''), /wrote the files/, 'partial output survives the missing response');

  const records = readdirSync(recoveryRecordDir).filter((name) => name.endsWith('.json'));
  assert.equal(records.length, 1, 'a recoverable task-state record must be written');
  const record = JSON.parse(readFileSync(join(recoveryRecordDir, records[0]), 'utf8'));
  assert.equal(record.timeoutKind, 'exit-without-response');
  assert.equal(record.recovery, 'changes-preserved-unverified');
  assert.equal(record.changedFiles, 1);
  assert.equal(record.tests, 'not-verified');
  assert.equal(record.processState, 'exited(0)');
});

test('4. partial completion then silence soft-times-out with the preserved-work facts', async () => {
  clearWorkspaceGuards();
  const { cwd, recoveryRecordDir } = workspace();
  const fake = createFakeChild({
    onPrompt: ({ notifyText }) => {
      notifyText('starting');
      touchFile(cwd, 'src/partial.js', 'half');
      /* Never answers: the child is alive, silent, and not touching anything. */
    }
  });
  const { provider } = makeProvider(cwd, fake, { recoveryRecordDir });
  const startedAt = Date.now();
  const { result } = await settle(await provider.start(makeRequest(cwd)));
  const elapsed = Date.now() - startedAt;

  assert.equal(result.stopReason, 'error');
  assert.ok(elapsed >= FAST_TIERS.softTimeoutMs, `soft timeout fired too early (${elapsed}ms)`);
  assert.ok(elapsed < FAST_TIERS.absoluteTimeoutMs, `soft timeout must precede the hard ceiling (${elapsed}ms)`);
  const diagnostic = result.diagnostic ?? '';
  assert.match(diagnostic, /timeout: soft/, 'the diagnostic must survive the timeout path');
  assert.match(diagnostic, /ladder: normal/);
  assert.match(diagnostic, /recovery: changes-preserved-unverified/);
  assert.match(diagnostic, /changed files: 1/);
  assert.match(diagnostic, /changed test files: 0/);
  assert.match(diagnostic, /process: running/);
  assert.match(diagnostic, /tests: not-verified/);
  assert.match(result.output.map((block) => block.text).join(''), /starting/, 'partial output survives a timeout');

  const records = readdirSync(recoveryRecordDir).filter((name) => name.endsWith('.json'));
  assert.equal(records.length, 1);
  const record = JSON.parse(readFileSync(join(recoveryRecordDir, records[0]), 'utf8'));
  assert.equal(record.timeoutKind, 'soft');
  assert.equal(record.changedPaths.some((path) => path.replaceAll('\\', '/') === 'src/partial.js'), true);
  assert.equal(record.processState, 'running');
});

test('5. a teardown that cannot prove quiescence is bounded, reported, and guards the workspace', async () => {
  clearWorkspaceGuards();
  const { cwd } = workspace();
  const fake = createFakeChild({
    onPrompt: ({ result }) => setTimeout(() => result({ stopReason: 'end_turn' }), 10),
    /* The seam's range never empties and the signal is ignored: the exact hang. */
    waitForExit: () => new Promise(() => {}),
    ignoreStdinEnd: true,
    autoExitOnTerminate: false
  });
  const { provider, warnings } = makeProvider(cwd, fake);
  const startedAt = Date.now();
  const run = await provider.start(makeRequest(cwd));
  const { result, disposalError } = await settle(run);
  const elapsed = Date.now() - startedAt;

  assert.equal(result.stopReason, 'completed', 'the result settles independently of teardown');
  assert.ok(disposalError !== undefined, 'an unproven teardown must be reported');
  assert.match(disposalError.message, /range quiesced: false/);
  assert.match(disposalError.message, /managed-range-not-empty/);
  assert.ok(elapsed < 2000, `disposal ceiling must bound the wait (took ${elapsed}ms)`);
  assert.ok(warnings.some((line) => /managed range not proven empty/.test(line)));

  const guards = workspaceGuardState().filter((entry) => entry.cwd === cwd);
  assert.equal(guards.length, 1);
  assert.equal(guards[0].state, 'unproven-stopped');
  assert.equal(guards[0].childProvenStopped, false);

  /* Requirement 6: no second writer in a directory whose child was not proven stopped. */
  const second = createFakeChild({ onPrompt: ({ result }) => result({ stopReason: 'end_turn' }) });
  const { provider: secondProvider } = makeProvider(cwd, second);
  await assert.rejects(
    async () => secondProvider.start(makeRequest(cwd)),
    (error) => {
      assert.match(error.message, /category: workspace-guard/);
      assert.match(error.message, /prior-run-not-proven-stopped/);
      return true;
    }
  );
  assert.equal(second.state.prompts, 0, 'the refused run must never reach the child');
  clearWorkspaceGuards();
});

test('11. a child that exited but left descendants keeps its result and does not block the workspace', async () => {
  clearWorkspaceGuards();
  const { cwd } = workspace();
  const fake = createFakeChild({
    onPrompt: ({ result }) => setTimeout(() => result({ stopReason: 'end_turn' }), 10),
    /* The managed range never proves itself empty, but the child itself does exit. */
    waitForExit: () => new Promise(() => {})
  });
  const { provider, warnings } = makeProvider(cwd, fake);
  const { result, disposalError } = await settle(await provider.start(makeRequest(cwd)));

  assert.equal(disposalError, undefined, 'a child that reported an exit is not a teardown failure');
  assert.equal(result.stopReason, 'completed', 'a lingering descendant must not downgrade a completed run');
  assert.ok(warnings.some((line) => /stopped-with-survivors/.test(line)));

  const guards = workspaceGuardState().filter((entry) => entry.cwd === cwd);
  assert.equal(guards.length, 1);
  assert.equal(guards[0].state, 'stopped-with-survivors');
  assert.equal(guards[0].childProvenStopped, true);
  assert.equal(guards[0].rangeQuiesced, false);

  /* The child is proven stopped, so the next writer is allowed through. */
  const second = createFakeChild({ onPrompt: ({ result }) => result({ stopReason: 'end_turn' }) });
  const { provider: secondProvider } = makeProvider(cwd, second);
  const secondRun = await secondProvider.start(makeRequest(cwd));
  await settle(secondRun);
  assert.equal(second.state.prompts, 1, 'the next run must reach the child');
  clearWorkspaceGuards();
});

test('6. a silent child is kept alive by proven workspace progress, then escalates', async () => {
  clearWorkspaceGuards();
  const { cwd } = workspace();
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
    touchFile(cwd, `out/step-${ticks}.txt`, String(ticks));
  }, 5);
  const fake = createFakeChild({
    onPrompt: ({ result, notifyText }) => {
      /* No ACP traffic at all between prompt and answer: only the files move. */
      setTimeout(() => {
        notifyText('progressed on filesystem evidence');
        result({ stopReason: 'end_turn' });
      }, 520);
    }
  });
  const { provider, warnings } = makeProvider(cwd, fake, {
    activityProbeMs: 15,
    activityExtensionMs: 60,
    softTimeoutMs: 250,
    absoluteTimeoutMs: 800,
    complexSoftTimeoutMs: 900,
    complexHardTimeoutMs: 2000
  });
  try {
    const startedAt = Date.now();
    const { result } = await settle(await provider.start(makeRequest(cwd)));
    const elapsed = Date.now() - startedAt;
    assert.equal(result.stopReason, 'completed', 'filesystem progress must keep the run alive past the normal soft deadline');
    assert.ok(elapsed > 250, `the run must outlive the normal soft deadline (took ${elapsed}ms)`);
    assert.ok(warnings.some((line) => /escalating to the complex ladder/.test(line)), 'escalation must be reported');
  } finally {
    clearInterval(timer);
  }
});

test('7. the idle warning fires without failing a slow run', async () => {
  clearWorkspaceGuards();
  const { cwd } = workspace();
  const fake = createFakeChild({
    onPrompt: ({ result, notifyText }) => {
      touchFile(cwd, 'once.txt', 'once');
      setTimeout(() => {
        notifyText('late but fine');
        result({ stopReason: 'end_turn' });
      }, 260);
    }
  });
  const { provider, warnings } = makeProvider(cwd, fake, {
    idleWarnMs: 100,
    softTimeoutMs: 900,
    absoluteTimeoutMs: 2000
  });
  const { result } = await settle(await provider.start(makeRequest(cwd)));
  assert.equal(result.stopReason, 'completed');
  assert.ok(warnings.some((line) => /child quiet for \d+ms/.test(line)), `idle warning missing from: ${JSON.stringify(warnings)}`);
  assert.ok(warnings.some((line) => /silence alone is not failure/.test(line)));
});

test('8. parent cancellation still settles as aborted', async () => {
  clearWorkspaceGuards();
  const { cwd } = workspace();
  const controller = new AbortController();
  const fake = createFakeChild({
    onPrompt: ({ notifyText }) => {
      notifyText('working');
      setTimeout(() => controller.abort('cancelled by test'), 30);
    }
  });
  const { provider } = makeProvider(cwd, fake);
  const { result, disposalError } = await settle(
    await provider.start(makeRequest(cwd, { signal: controller.signal }))
  );
  assert.equal(disposalError, undefined);
  assert.equal(result.stopReason, 'aborted');
  assert.equal(fake.state.cancelled, true, 'the child must receive session/cancel');
});

test('9. process start and session establishment time out as separate, classified tiers', async () => {
  clearWorkspaceGuards();
  const { cwd } = workspace();

  /* (a) The executable starts but never speaks ACP: the process-start tier decides. */
  const mute = createFakeChild({ silent: true });
  const { provider: muteProvider } = makeProvider(cwd, mute, {
    processStartTimeoutMs: 120,
    startupTimeoutMs: 400
  });
  const muteStartedAt = Date.now();
  await assert.rejects(
    () => muteProvider.start(makeRequest(cwd)),
    (error) => {
      assert.match(error.message, /category: timeout/, 'a startup deadline must not be relabelled transport');
      assert.match(error.message, /timeout: process-start/);
      assert.match(error.message, /last activity: spawn/);
      return true;
    }
  );
  const muteElapsed = Date.now() - muteStartedAt;
  assert.ok(muteElapsed >= 120 && muteElapsed < 400, `process-start tier must decide before session setup (took ${muteElapsed}ms)`);

  /* (b) Handshake completes, session/new never does: the session-setup tier decides. */
  const stalling = createFakeChild({ stallSessionNew: true });
  const { provider: stallingProvider } = makeProvider(cwd, stalling, {
    processStartTimeoutMs: 120,
    startupTimeoutMs: 320
  });
  const stallStartedAt = Date.now();
  await assert.rejects(
    () => stallingProvider.start(makeRequest(cwd)),
    (error) => {
      assert.match(error.message, /timeout: startup/);
      assert.match(error.message, /last activity: initialize-response/);
      return true;
    }
  );
  const stallElapsed = Date.now() - stallStartedAt;
  assert.ok(stallElapsed >= 320, `session-setup tier must not fire before its bound (took ${stallElapsed}ms)`);
});

test('10. a config cwd that does not exist is rejected at load, before any spawn', () => {
  clearWorkspaceGuards();
  assert.equal(typeof startAcpRun, 'function');
  const missing = join(TMP_ROOT, 'does-not-exist');
  const fake = createFakeChild({ onPrompt: ({ result }) => result({ stopReason: 'end_turn' }) });
  const ctx = {
    logger: { warn: () => {} },
    subagents: { registerProvider: () => {} },
    subprocess: { spawn: () => fake.child }
  };
  assert.throws(
    () => apply(ctx, { providerName: 'bad', command: 'cursor-agent', args: ['acp'], cwd: missing, ...FAST_TIERS }),
    /is not an accessible directory/
  );
  assert.equal(existsSync(missing), false);
  assert.equal(fake.state.prompts, 0);
});
