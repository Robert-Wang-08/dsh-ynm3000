/**
 * Resilient out-of-process ACP subagent backend.
 *
 * Same seams and same observable contract as `@deepseek-ai/dsh-subagent-acp`,
 * plus a graded, evidence-driven timeout ladder and a bounded teardown, so a
 * child that hangs, dies silently, or outlives its own process can never stall
 * the delegating session. Each child has its own process, session, model, and
 * tools, so it shares no Cordis context and advertises no parent-enforced start
 * capabilities; the ONE thing it reads off `request.parent` is the session's
 * workspace cwd (see {@link resolveCwd}). This plugin uses named exports only; a
 * default would hide its loader metadata.
 * @module @local/dsh-subagent-acp-resilient
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type PermissionPolicy, type WorkspaceGuardEntry } from './run.ts';
/** The cordis plugin name the implementation exports. */
export declare const name = 'subagent-acp';
/** Services this plugin requires before `apply` runs. */
export declare const inject: string[];
/**
 * Every config key this provider actually reads. The loader's schema does NOT
 * reject unknown keys — schemastery forwards them — so a misspelled bound would
 * be silently inert. {@link apply} warns about protection-shaped keys that are
 * not in this list.
 */
export declare const DECLARED_CONFIG_KEYS: readonly string[];
/** Config: how to spawn, drive, and bound one child ACP agent process. */
export interface Config {
    /** Provider name on `ctx.subagents` (default `acp`). */
    providerName: string;
    /** The executable to spawn for each run (the child ACP agent). */
    command: string;
    /** Arguments passed to {@link command}. */
    args: string[];
    /**
     * Working directory override for the child process and its ACP session.
     * Must be non-empty; a relative path resolves against the harness launch
     * directory at load, and the result must be an existing directory. When
     * omitted, each child inherits its delegating parent session's cwd — and
     * starting one from a parent session that has no cwd fails.
     */
    cwd?: string;
    /**
     * How to auto-answer the child's `session/request_permission` prompts:
     * `reject` (default — decline every prompt) or `allow` (approve via the first
     * `allow_once` or `allow_always` option). No prompt is surfaced to a human.
     */
    permission: PermissionPolicy;
    /**
     * Extra environment variables for the child process. Forwarded on top of a
     * credential-scrubbed copy of the parent env, so an explicit key here reaches
     * the child while ambient secrets do not leak implicitly.
     */
    env: Record<string, string>;
    /** Tier 1: window for the child to flush and reap its own descendants after stdin EOF (default 6s). */
    disposeEofGraceMs: number;
    /** Tier 2: escalation grace passed to the subprocess seam on `terminate()` (default 3s). */
    disposeGraceMs: number;
    /** Tier 3: final bounded wait after termination before declaring the managed range unproven (default 10s). */
    disposeFinalGraceMs: number;
    /**
     * Ceiling on the whole teardown ladder. Disposal always returns within
     * `disposeEofGraceMs + disposeGraceMs + disposeFinalGraceMs + disposalTimeoutMs`;
     * it never waits unbounded for a range that cannot be proven empty (default 30s).
     */
    disposalTimeoutMs: number;
    /**
     * Tier: the spawned command must produce its FIRST byte of inbound traffic
     * within this window. This catches a launcher/shim that starts but never
     * reaches the agent, and it is disarmed by the first inbound ACP frame
     * (default 30s).
     */
    processStartTimeoutMs: number;
    /** Tier: ACP session establishment — `initialize` through the `session/new` response (default 60s). */
    startupTimeoutMs: number;
    /**
     * Tier: advisory. After this long without proven progress the provider logs a
     * warning and records it on the run; the run is NOT failed (default 3min).
     * Since it can never fail a run, a value above `idleTimeoutMs` is CLAMPED to
     * it with a warning rather than rejected, so an older config keeps loading.
     */
    idleWarnMs: number;
    /** Tier: no proven progress for this long escalates the deadline (default 10min). */
    idleTimeoutMs: number;
    /** Tier: normal-ladder soft deadline. Fires only when progress is NOT proven recent (default 10min). */
    softTimeoutMs: number;
    /** Tier: normal-ladder hard ceiling (default 20min). */
    absoluteTimeoutMs: number;
    /** Tier: complex-ladder soft deadline, used after one evidence-based escalation (default 20min). */
    complexSoftTimeoutMs: number;
    /** Tier: complex-ladder hard ceiling (default 45min). */
    complexHardTimeoutMs: number;
    /** Watchdog recheck quantum, and the recency window that counts as "proven progress" (default 15s). */
    activityExtensionMs: number;
    /** Minimum spacing between bounded workspace probes — the second, independent progress witness (default 30s). */
    activityProbeMs: number;
    /**
     * Grace after observing the child exit while `session/prompt` is still
     * pending, so an in-flight final response can still be read (default 3s).
     */
    exitSettleMs: number;
    /** Settle window after a timeout before the workspace snapshot is taken (default 5s). */
    recoverySettleMs: number;
    /** Maximum files inspected by the bounded workspace snapshot (default 20000). */
    workspaceScanLimit: number;
    /**
     * Where content-free recovery records are written as JSON. Defaults to
     * `$DSH_HOME/acp-recovery` so a post-mortem survives the session.
     */
    recoveryRecordDir?: string;
    /**
     * When true (default), a workspace whose previous ACP child was never proven
     * stopped is refused as the cwd of a new writing run, so two agents cannot
     * mutate the same tree at once.
     */
    guardWorkspaceReuse: boolean;
}
export declare const Config: z<Config>;
/**
 * Register the provider and validate the ladder's internal coherence. Rejects
 * incoherent combinations that would change when a run is declared dead (e.g. a
 * soft deadline above its hard ceiling) at load rather than at the first
 * timeout, clamps the advisory `idleWarnMs` instead of rejecting it, and warns
 * about config keys the provider never reads.
 */
export declare function apply(ctx: Context, config: Config): void;
/** Start a run. Exported for tests and for embedding the provider outside the loader. */
export { startAcpRun, disposeAcpChild } from './run.ts';
/** The bounded teardown ladder's typed outcomes. */
export type { AcpRunSpec, AcpTimeoutKind, DisposalOutcome, QuiescenceProof } from './run.ts';
/** Current workspace-guard registry, for diagnostics. */
export declare function workspaceGuardState(): WorkspaceGuardEntry[];
/** Why `cwd` is currently refused as a new writer's workspace, if it is. */
export declare function blockedWorkspace(cwd: string): WorkspaceGuardEntry | undefined;
/** Drop every guard. Exported so an operator or a test can clear stale state. */
export declare function clearWorkspaceGuards(): void;
