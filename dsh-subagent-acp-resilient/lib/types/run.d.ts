/**
 * Fresh-process ACP subagent client. Drives one child session and owns
 * cancellation, bounded quiescent disposal, and post-timeout recovery evidence.
 *
 * @module @local/dsh-subagent-acp-resilient/run
 */
import { type ContentBlock as AcpContentBlock, type StopReason } from '@agentclientprotocol/sdk';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { SubagentRun, SubagentStartRequest, SubagentStopReason } from '@deepseek-ai/dsh-subagent';
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess';
/** Fixed response to child permission requests: reject by default, or select the first allow option. */
export type PermissionPolicy = 'allow' | 'reject';
/** Which bound ended a run. Reported verbatim in the model-visible diagnostic. */
export type AcpTimeoutKind =
    | 'process-start'
    | 'startup'
    | 'soft'
    | 'complex-soft'
    | 'idle'
    | 'absolute'
    | 'complex-hard';
/** What the bounded teardown ladder managed to prove about the managed range. */
export interface QuiescenceProof {
    /** True only when the whole managed range was proven empty within the ladder's bounds. */
    quiesced: boolean;
    /** Failures observed while tearing down; the first is surfaced to the host sink. */
    failures: unknown[];
    /** How long the ladder waited, in ms. */
    waitedMs: number;
}
/** The provider-level disposal outcome: the proof plus what the spawned command itself did. */
export interface DisposalOutcome extends QuiescenceProof {
    /** True when the spawned command itself reported an exit, even if descendants linger. */
    childProvenStopped: boolean;
}
/**
 * One workspace-guard entry: what the provider knows about the last ACP writer in
 * a cwd. `unproven-stopped` is the only state that refuses a new writer.
 */
export interface WorkspaceGuardEntry {
    cwd: string;
    runId: string;
    providerName: string;
    state: 'stopped' | 'stopped-with-survivors' | 'unproven-stopped';
    at: number;
    rangeQuiesced: boolean;
    childProvenStopped: boolean;
    recovery?: Record<string, unknown>;
    changedFiles?: string[];
}
/** Resolved spawn spec for an ACP child process (no defaults — see Config). */
export interface AcpRunSpec {
    /** Provider name, used in diagnostics and guard records. */
    providerName: string;
    /** The executable to spawn (the child ACP agent). */
    command: string;
    /** Arguments passed to {@link command}. */
    args: string[];
    /**
     * Absolute working directory for the child process AND its ACP session
     * `cwd`. The provider resolves it before this spec exists: config override,
     * else the delegating parent session's workspace.
     */
    cwd: string;
    /** How to auto-answer the child's permission prompts. */
    permission: PermissionPolicy;
    /** Extra environment variables to ADD for the child, on top of the scrubbed parent env. */
    env: Record<string, string>;
    /** Tier 1 of disposal: EOF grace. */
    disposeEofGraceMs: number;
    /** Tier 2 of disposal: escalation grace. */
    disposeGraceMs: number;
    /** Tier 3 of disposal: final bounded wait before the range counts as unproven. */
    disposeFinalGraceMs: number;
    /** Ceiling on the whole disposal ladder. */
    disposalTimeoutMs: number;
    /** First-inbound-traffic tier. */
    processStartTimeoutMs: number;
    /** ACP session-establishment tier. */
    startupTimeoutMs: number;
    /** Advisory no-progress tier. */
    idleWarnMs: number;
    /** No-progress escalation tier. */
    idleTimeoutMs: number;
    /** Normal soft deadline. */
    softTimeoutMs: number;
    /** Normal hard ceiling. */
    absoluteTimeoutMs: number;
    /** Complex soft deadline, after one evidence-based escalation. */
    complexSoftTimeoutMs: number;
    /** Complex hard ceiling. */
    complexHardTimeoutMs: number;
    /** Watchdog quantum and the recency window that counts as proven progress. */
    activityExtensionMs: number;
    /** Minimum spacing between bounded workspace probes. */
    activityProbeMs: number;
    /** Grace after observed exit while the prompt is still pending. */
    exitSettleMs: number;
    /** Settle window after a timeout before the workspace snapshot. */
    recoverySettleMs: number;
    /** Maximum files inspected by the bounded workspace snapshot. */
    workspaceScanLimit: number;
    /** Where content-free recovery records are written. */
    recoveryRecordDir: string;
    /** Whether an unproven stop refuses a later writer in the same cwd. */
    guardWorkspaceReuse: boolean;
    /**
     * Spawn function from the subprocess seam (`ctx.subprocess.spawn`), so the
     * child rides the shared scrub, managed-range teardown, and service-owned
     * lifetime instead of a package-local child_process path.
     */
    spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle;
    /** Advisory channel: idle warnings and unproven-but-stopped teardown notes. */
    onWarn?: (message: string) => void;
    /**
     * Host sink for startup, published-run, or teardown failures. Model-visible
     * text uses fixed safe facts, while this callback retains the original Error
     * when one exists. A throw from the sink itself is contained.
     */
    onError?: (error: Error, stopReason: SubagentStopReason) => void;
}
/** EOF grace for child flush and nested-process teardown; wider than the signal grace below. */
export declare const DEFAULT_DISPOSE_EOF_GRACE_MS = 6000;
/** Default grace between terminate and the final bounded wait. */
export declare const DEFAULT_DISPOSE_GRACE_MS = 3000;
/** Default final bounded wait after termination. */
export declare const DEFAULT_DISPOSE_FINAL_GRACE_MS = 10000;
/** Default ceiling on the whole disposal ladder. */
export declare const DEFAULT_DISPOSAL_TIMEOUT_MS = 30000;
/** Default first-inbound-traffic tier. */
export declare const DEFAULT_PROCESS_START_TIMEOUT_MS = 30000;
/** Default ACP session-establishment tier. */
export declare const DEFAULT_STARTUP_TIMEOUT_MS = 60000;
/** Default advisory no-progress tier. */
export declare const DEFAULT_IDLE_WARN_MS = 180000;
/** Default no-progress escalation tier. */
export declare const DEFAULT_IDLE_TIMEOUT_MS = 600000;
/** Default normal soft deadline. */
export declare const DEFAULT_SOFT_TIMEOUT_MS = 600000;
/** Default normal hard ceiling. */
export declare const DEFAULT_ABSOLUTE_TIMEOUT_MS = 1200000;
/** Default complex soft deadline. */
export declare const DEFAULT_COMPLEX_SOFT_TIMEOUT_MS = 1200000;
/** Default complex hard ceiling. */
export declare const DEFAULT_COMPLEX_HARD_TIMEOUT_MS = 2700000;
/** Default watchdog quantum / progress-recency window. */
export declare const DEFAULT_ACTIVITY_EXTENSION_MS = 15000;
/** Default minimum spacing between workspace probes. */
export declare const DEFAULT_ACTIVITY_PROBE_MS = 30000;
/** Default grace after an observed exit with the prompt still pending. */
export declare const DEFAULT_EXIT_SETTLE_MS = 3000;
/** Default settle window after a timeout before snapshotting the workspace. */
export declare const DEFAULT_RECOVERY_SETTLE_MS = 5000;
/** Default bounded workspace-scan file limit. */
export declare const DEFAULT_WORKSPACE_SCAN_LIMIT = 20000;
/**
 * Bounded teardown ladder for an out-of-process agent, over the seam's public
 * verbs: stdin EOF (the child's window to flush persistence and reap its own
 * descendants), then the `terminate()` escalation, then a final bounded wait.
 *
 * It ALWAYS returns — never later than `eofGraceMs + finalGraceMs` — and reports
 * whether the managed range was actually proven empty, instead of waiting
 * unbounded for a proof that may never come.
 *
 * @param child - the spawned ACP child's handle.
 * @param eofGraceMs - tier-1 window after stdin EOF.
 * @param finalGraceMs - tier-3 bounded wait after termination.
 * @returns the proof it obtained, plus any failures, plus how long it waited.
 */
export declare function disposeAcpChild(
    child: SubprocessHandle,
    eofGraceMs: number,
    finalGraceMs?: number
): Promise<QuiescenceProof>;
/**
 * Map an ACP {@link StopReason} to a harness {@link SubagentStopReason}.
 * @param reason - the terminal reason from the child's `session/prompt` response.
 * @returns the harness equivalent; `max_turn_requests` and any unknown future
 * variant map to `error`, so an unclean stop is never reported as `completed`.
 */
export declare function acpStopReason(reason: StopReason): SubagentStopReason;
/**
 * Collect the text of an ACP content block (non-text blocks contribute nothing).
 * @param content - the content block off a streamed `agent_message_chunk`.
 * @returns the block's text, or `''` for a non-text block.
 */
export declare function acpContentText(content: AcpContentBlock): string;
/**
 * Translate the harness prompt blocks into ACP prompt blocks (text only).
 * @param prompt - the harness prompt; non-text blocks are dropped.
 * @returns the ACP text blocks, in order.
 */
export declare function toAcpPrompt(prompt: ContentBlock[]): AcpContentBlock[];
/**
 * Start and publish one ACP child after initialization and session creation.
 *
 * Settlement is guaranteed: the prompt is raced against the watchdog ladder
 * (hard → idle → soft, each gated on PROVEN progress), the observed exit of the
 * child, and the caller's cancellation — never against ACP silence alone. When a
 * bound wins, the diagnostic names the tier, the elapsed/idle time, the last
 * observed activity, the changed files, and the recovery state, and a timeout
 * never reports `completed`.
 *
 * @param request - the start request; its signal is the cancellation channel.
 * @param spec - the resolved spawn spec: command/args/cwd, env, permission
 * policy, the timeout ladder, the disposal graces, and the sinks.
 * @returns the ready run handle for the child subprocess.
 */
export declare function startAcpRun(request: SubagentStartRequest, spec: AcpRunSpec): Promise<SubagentRun>;
