/**
 * Configuration-integrity tests.
 *
 * These pin the two facts the provider's whole timeout contract rests on:
 *
 * 1. the framework does NOT validate unknown config keys — schemastery passes
 *    them straight through, so a misspelled bound is silently inert;
 * 2. therefore every bound the provider reads must be declared, and a key that
 *    looks like a bound but is not declared must be reported loudly.
 *
 * The default ladder is also pinned here, so the documented tiers (process start
 * 30s, session setup 60s, idle warning 3min, normal soft/hard 10/20min, complex
 * soft/hard 20/45min) cannot drift away from the code.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Config, DECLARED_CONFIG_KEYS, apply } from '../lib/index.js';

/** A `ctx` that records what the plugin logs and registers. */
function makeCtx() {
  const warnings = [];
  const registered = [];
  return {
    warnings,
    registered,
    ctx: {
      logger: { warn: (...args) => warnings.push(args.map(String).join(' ')) },
      subagents: { registerProvider: (provider) => registered.push(provider) },
      subprocess: { spawn: () => ({}) }
    }
  };
}

test('the schema declares every key the provider reads and nothing else', () => {
  /* Schemastery drops keys whose declared type has no default and no supplied value. */
  const OPTIONAL_KEYS = ['cwd', 'recoveryRecordDir'];
  const parsed = Config({ command: 'cursor-agent' });
  for (const key of Object.keys(parsed)) {
    assert.ok(
      DECLARED_CONFIG_KEYS.includes(key),
      `schema key "${key}" is missing from DECLARED_CONFIG_KEYS, so it would be falsely reported as inert`
    );
  }
  for (const key of DECLARED_CONFIG_KEYS) {
    assert.ok(
      Object.hasOwn(parsed, key) || OPTIONAL_KEYS.includes(key),
      `DECLARED_CONFIG_KEYS names "${key}" but the schema does not produce it`
    );
  }
  assert.deepEqual(
    DECLARED_CONFIG_KEYS.filter((key) => !Object.hasOwn(parsed, key)).sort(),
    [...OPTIONAL_KEYS].sort(),
    'the set of omitted-by-default keys must stay exactly the documented optional ones'
  );
});

test('the documented default ladder is what the provider actually uses', () => {
  const parsed = Config({ command: 'cursor-agent' });
  assert.equal(parsed.processStartTimeoutMs, 30_000, 'process start tier');
  assert.equal(parsed.startupTimeoutMs, 60_000, 'ACP session establishment tier');
  assert.equal(parsed.idleWarnMs, 180_000, 'idle warning tier');
  assert.equal(parsed.idleTimeoutMs, 600_000, 'idle kill tier');
  assert.equal(parsed.softTimeoutMs, 600_000, 'normal soft tier (10 min)');
  assert.equal(parsed.absoluteTimeoutMs, 1_200_000, 'normal hard tier (20 min)');
  assert.equal(parsed.complexSoftTimeoutMs, 1_200_000, 'complex soft tier (20 min)');
  assert.equal(parsed.complexHardTimeoutMs, 2_700_000, 'complex hard tier (45 min)');
  assert.equal(parsed.exitSettleMs, 3_000, 'exit-without-response settle window');
  assert.equal(parsed.disposalTimeoutMs, 30_000, 'disposal ceiling');
  assert.equal(parsed.guardWorkspaceReuse, true, 'workspace reuse guard is on by default');
});

test('an undeclared key shaped like a protection bound is reported as inert', () => {
  const { ctx, warnings, registered } = makeCtx();
  /* schemastery forwards this key untouched; only the provider can notice. */
  apply(ctx, Config({ command: 'cursor-agent', startupTimeout: 60_000 }));
  assert.equal(registered.length, 1);
  assert.ok(
    warnings.some((line) => /INERT/.test(line) && /startupTimeout/.test(line)),
    `an inert protection key must be reported loudly, got: ${JSON.stringify(warnings)}`
  );
});

test('a fully declared config produces no inert-key warning', () => {
  const { ctx, warnings } = makeCtx();
  apply(ctx, Config({
    command: 'cursor-agent',
    providerName: 'cursor',
    args: ['acp'],
    permission: 'allow',
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
    workspaceScanLimit: 20_000,
    guardWorkspaceReuse: true
  }));
  assert.deepEqual(warnings, []);
});

test('incoherent tier combinations are rejected at load', () => {
  const cases = [
    [{ processStartTimeoutMs: 90_000, startupTimeoutMs: 60_000 }, /processStartTimeoutMs must not exceed startupTimeoutMs/],
    [{ softTimeoutMs: 1_500_000, absoluteTimeoutMs: 1_200_000 }, /softTimeoutMs must not exceed absoluteTimeoutMs/],
    [{ absoluteTimeoutMs: 3_000_000, complexHardTimeoutMs: 2_700_000 }, /absoluteTimeoutMs must not exceed complexHardTimeoutMs/],
    [{ complexSoftTimeoutMs: 3_000_000, complexHardTimeoutMs: 2_700_000, absoluteTimeoutMs: 1_200_000, softTimeoutMs: 600_000 }, /complexSoftTimeoutMs must not exceed complexHardTimeoutMs/],
    [{ disposeGraceMs: 0 }, /disposeGraceMs must be a positive finite number/],
    [{ exitSettleMs: -1 }, /exitSettleMs must be a positive finite number/]
  ];
  for (const [overrides, pattern] of cases) {
    const { ctx, registered } = makeCtx();
    assert.throws(() => apply(ctx, Config({ command: 'cursor-agent', ...overrides })), pattern);
    assert.equal(registered.length, 0, 'a rejected config must not register a provider');
  }
});

test('a stale idleWarnMs is clamped instead of breaking an older deployment', () => {
  /*
   * An older bundle config pairs `idleTimeoutMs: 120000` with no `idleWarnMs`,
   * so the default advisory tier (180s) would land AFTER the escalation. That
   * must not remove the provider row: the warning is advisory, so it is clamped
   * and reported. Deployment order therefore does not matter.
   */
  const { ctx, warnings, registered } = makeCtx();
  apply(ctx, Config({
    command: 'cmd',
    providerName: 'cursor-grok',
    startupTimeoutMs: 45_000,
    idleTimeoutMs: 120_000,
    absoluteTimeoutMs: 1_800_000,
    activityExtensionMs: 60_000,
    recoverySettleMs: 5_000
  }));
  assert.equal(registered.length, 1, 'a stale-but-usable config must still register');
  assert.ok(
    warnings.some((line) => /idleWarnMs \(180000ms\) exceeds idleTimeoutMs \(120000ms\); clamping/.test(line)),
    `the clamp must be reported, got: ${JSON.stringify(warnings)}`
  );
});

test('a registered provider advertises no parent-enforced start capability', () => {
  const { ctx, registered } = makeCtx();
  apply(ctx, Config({ command: 'cursor-agent', providerName: 'cursor' }));
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, 'cursor');
  assert.deepEqual(registered[0].capabilities, {
    agentOptions: false,
    outputSchema: false,
    depthLimit: false,
    toolFilter: false,
    persona: false
  });
  assert.equal(registered[0].inheritsParentContext, false);
  /* Continuable children are the in-process providers' feature; ACP is one-shot. */
  assert.equal(registered[0].prepareContinuable, undefined);
});
