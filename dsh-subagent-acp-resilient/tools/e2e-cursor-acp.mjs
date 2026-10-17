/**
 * Live end-to-end verification of the resilient ACP provider against a REAL
 * agent (default: `cursor-agent acp`), through the provider's real code path.
 *
 * It proves, with the production tier numbers:
 *   - the process starts and the ACP session handshakes under the ladder;
 *   - a prompt that MODIFIES FILES settles as `completed` and returns the answer;
 *   - `dispose()` always returns within its ceiling;
 *   - the workspace guard and the recovery record reflect what really happened.
 *
 * Fidelity note: this adapter wraps `node:child_process`, so the Windows Job
 * object managed-range semantics of `dsh-subprocess-local` are approximated by
 * exit observation plus `kill()`. The provider logic under test — tiers,
 * activity probing, exit detection, bounded disposal, guards, records — is the
 * real implementation, not a stub.
 *
 * Usage:
 *   node tools/e2e-cursor-acp.mjs [--command-line "cursor-agent --model auto acp"]
 *                                 [--prompt "..."] [--budget-ms 300000]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { apply, clearWorkspaceGuards, workspaceGuardState } from '../lib/index.js';

const { values } = parseArgs({
  options: {
    'command-line': { type: 'string', default: process.platform === 'win32' ? 'cursor-agent --model auto acp' : 'exec cursor-agent --model auto acp' },
    shell: { type: 'string', default: process.platform === 'win32' ? 'cmd' : 'sh' },
    'shell-arg': { type: 'string', default: process.platform === 'win32' ? '/c' : '-c' },
    prompt: { type: 'string', default: 'Create a file named e2e-proof.txt in the current directory containing exactly the text ACP_ROUND_TRIP_OK (one line, no trailing blank line). Then reply with the single word done.' },
    'budget-ms': { type: 'string', default: '420000' },
    'record-dir': { type: 'string' },
    'scan-limit': { type: 'string', default: '20000' }
  }
});

/* The production ladder, exactly as the PTC bundle configures it. */
const PRODUCTION_TIERS = {
  processStartTimeoutMs: 30_000,
  startupTimeoutMs: 60_000,
  idleWarnMs: 180_000,
  idleTimeoutMs: 600_000,
  softTimeoutMs: 600_000,
  absoluteTimeoutMs: 1_200_000,
  complexSoftTimeoutMs: 1_200_000,
  complexHardTimeoutMs: 2_700_000,
  activityExtensionMs: 15_000,
  activityProbeMs: 30_000,
  exitSettleMs: 3_000,
  recoverySettleMs: 5_000,
  disposeEofGraceMs: 6_000,
  disposeGraceMs: 3_000,
  disposeFinalGraceMs: 10_000,
  disposalTimeoutMs: 30_000,
  workspaceScanLimit: Number(values['scan-limit'])
};

const budgetMs = Number(values['budget-ms']);
const root = resolve(process.env.TEMP ?? '/tmp', `acp-e2e-${Date.now()}`);
mkdirSync(root, { recursive: true });
const cwd = mkdtempSync(join(root, 'ws-'));
const recoveryRecordDir = values['record-dir'] ?? join(root, 'acp-recovery');
mkdirSync(recoveryRecordDir, { recursive: true });

const timeline = [];
const stamp = (label) => timeline.push({ at: Date.now(), label });

/** Adapt one real `child_process` child to the `SubprocessHandle` surface. */
function adapt(child) {
  let settled = false;
  let outcome;
  const done = new Promise((resolveDone, rejectDone) => {
    child.on('error', (error) => {
      settled = true;
      rejectDone(error);
    });
    child.on('exit', (code, signal) => {
      settled = true;
      outcome = { exitCode: code, signal };
      resolveDone(outcome);
    });
  });
  done.catch(() => {});
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    done,
    terminate() {
      stamp('dispose:terminate');
      child.kill();
    },
    waitForExit(signal) {
      return new Promise((resolveWait, rejectWait) => {
        if (settled) return resolveWait(true);
        let aborted = false;
        const onAbort = () => {
          aborted = true;
          resolveWait(false);
        };
        if (signal !== undefined) {
          if (signal.aborted) return resolveWait(false);
          signal.addEventListener('abort', onAbort, { once: true });
        }
        done.then(() => {
          if (signal !== undefined) signal.removeEventListener('abort', onAbort);
          resolveWait(aborted ? false : true);
        }, (error) => {
          if (signal !== undefined) signal.removeEventListener('abort', onAbort);
          rejectWait(error);
        });
      });
    }
  };
}

/** Real spawn honouring the stdio dispositions the provider asks for. */
function spawnRealChild(spec) {
  const [file, ...args] = spec.argv;
  stamp('spawn');
  return spawn(file, args, {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio: [spec.stdio?.stdin ?? 'pipe', spec.stdio?.stdout ?? 'pipe', spec.stdio?.stderr ?? 'inherit'],
    windowsHide: true
  });
}

const warnings = [];
const errors = [];
const registered = [];
const ctx = {
  logger: { warn: (...args) => warnings.push(args.map(String).join(' ')) },
  subagents: { registerProvider: (provider) => registered.push(provider) },
  subprocess: {
    spawn: (spec) => adapt(spawnRealChild(spec))
  }
};

clearWorkspaceGuards();
apply(ctx, {
  providerName: 'cursor-grok',
  command: values.shell,
  args: [values['shell-arg'], values['command-line']],
  cwd,
  permission: 'allow',
  env: {},
  guardWorkspaceReuse: true,
  recoveryRecordDir,
  ...PRODUCTION_TIERS
});
if (registered.length !== 1) throw new Error('apply did not register a provider');

const controller = new AbortController();
const budgetTimer = setTimeout(() => {
  stamp('budget-expired');
  controller.abort();
}, budgetMs);

const startedAt = Date.now();
let run;
const report = { cwd, commandLine: values['command-line'], tiers: PRODUCTION_TIERS, recoveryRecordDir };
try {
  run = await registered[0].start({
    label: 'e2e-cursor',
    prompt: [{ type: 'text', text: values.prompt }],
    parent: { session: { header: { cwd } } },
    signal: controller.signal
  });
  stamp('started');
  report.startMs = Date.now() - startedAt;

  const result = await run.result;
  stamp('result');
  report.resultMs = Date.now() - startedAt;
  report.result = {
    stopReason: result.stopReason,
    output: typeof result.output === 'string' ? result.output.slice(0, 2000) : result.output,
    error: result.error === undefined ? undefined : String(result.error?.message ?? result.error)
  };

  try {
    await run.dispose();
    stamp('disposed');
    report.disposal = { ok: true, ms: Date.now() - startedAt };
  } catch (error) {
    stamp('dispose-failed');
    report.disposal = { ok: false, ms: Date.now() - startedAt, error: String(error?.message ?? error) };
  }
} catch (error) {
  stamp('start-failed');
  report.startError = String(error?.message ?? error);
} finally {
  clearTimeout(budgetTimer);
}

report.warnings = warnings;
report.errors = errors.map((entry) => String(entry?.message ?? entry));
report.guards = workspaceGuardState();

/* What actually landed on disk. */
try {
  report.files = readdirSync(cwd).map((name) => {
    const path = join(cwd, name);
    const info = statSync(path);
    return { name, size: info.size, content: info.size < 2048 ? readFileSync(path, 'utf8').slice(0, 200) : undefined };
  });
} catch (error) {
  report.filesError = String(error?.message ?? error);
}
try {
  report.recoveryRecords = readdirSync(recoveryRecordDir).map((name) => ({
    name,
    body: JSON.parse(readFileSync(join(recoveryRecordDir, name), 'utf8'))
  }));
} catch (error) {
  report.recoveryRecordsError = String(error?.message ?? error);
}

report.timeline = timeline.map((entry) => ({ ...entry, offsetMs: entry.at - startedAt }));
report.totalMs = Date.now() - startedAt;
console.log(JSON.stringify(report, null, 2));

/* Leave the scratch workspace behind only when it holds evidence worth keeping. */
if (process.env.ACP_E2E_KEEP === '1') console.log(`kept: ${root}`);
else rmSync(root, { recursive: true, force: true, maxRetries: 5 });
process.exit(0);
