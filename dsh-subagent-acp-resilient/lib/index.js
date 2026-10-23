import { accessSync, constants, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { PROTOCOL_VERSION, client, methods, ndJsonStream } from "@agentclientprotocol/sdk";
import { brandString } from "@deepseek-ai/dsh-brand";
import { AssistantOutputFold, settleRunResult, subprocessRunHandle } from "@deepseek-ai/dsh-subagent";
//#region lib/types/run.js
/**
 * Fresh-process ACP subagent client. Drives one child session and owns
 * cancellation, tiered deadline enforcement, activity-based progress
 * detection, bounded teardown, and post-timeout artifact preservation.
 *
 * @module @deepseek-ai/dsh-subagent-acp/run
 */
/** EOF grace for child flush and nested-process teardown; wider than the signal grace below. */
const DEFAULT_DISPOSE_EOF_GRACE_MS = 6e3;
/** Default POSIX grace between SIGTERM and SIGKILL on dispose (the `disposeGraceMs` config). */
const DEFAULT_DISPOSE_GRACE_MS = 3e3;
/**
 * Bounded second-tier window after `terminate()` for the managed range to prove
 * itself empty. Upstream waited here without any bound, which is the hang this
 * provider exists to remove: a surviving descendant keeps the range observable
 * and non-empty, so an unbounded wait never settles.
 */
const DEFAULT_DISPOSE_FINAL_GRACE_MS = 10e3;
/** Whole-disposal ceiling: no teardown path may exceed this, whatever the seam does. */
const DEFAULT_DISPOSAL_TIMEOUT_MS = 30e3;
/** Spawn -> first inbound ACP traffic (the child executable actually started and speaks ACP). */
const DEFAULT_PROCESS_START_TIMEOUT_MS = 30e3;
/** Spawn -> `initialize` + `session/new` complete (ACP session establishment). */
const DEFAULT_STARTUP_TIMEOUT_MS = 60e3;
/** Quiet-period warning threshold: report, never fail. */
const DEFAULT_IDLE_WARN_MS = 180e3;
/** Probe-verified no-progress deadline (idle kill). */
const DEFAULT_IDLE_TIMEOUT_MS = 600e3;
/** Normal task soft deadline: stop cooperatively once a probe proves no progress. */
const DEFAULT_SOFT_TIMEOUT_MS = 600e3;
/** Normal task hard ceiling: unconditional stop. */
const DEFAULT_ABSOLUTE_TIMEOUT_MS = 1200e3;
/** Complex task soft deadline, reached only by evidence-backed escalation or explicit config. */
const DEFAULT_COMPLEX_SOFT_TIMEOUT_MS = 1200e3;
/** Complex task hard ceiling. */
const DEFAULT_COMPLEX_HARD_TIMEOUT_MS = 2700e3;
/** Watchdog recheck quantum; also the maximum lateness of any tier decision. */
const DEFAULT_ACTIVITY_EXTENSION_MS = 15e3;
/**
 * Minimum interval between bounded workspace scans used as progress evidence.
 * Deliberately coarser than the recheck quantum: the scan is the only
 * non-ACP-bound cost this provider adds, so it is rate-limited independently.
 */
const DEFAULT_ACTIVITY_PROBE_MS = 30e3;
/** Grace after child exit for a final `session/prompt` response still in flight. */
const DEFAULT_EXIT_SETTLE_MS = 3e3;
/** Settle window after cancellation before workspace inspection. */
const DEFAULT_RECOVERY_SETTLE_MS = 5e3;
/** Maximum files inspected by one bounded workspace snapshot. */
const DEFAULT_WORKSPACE_SCAN_LIMIT = 2e4;
const ACP_TOOL_KINDS = new Set([
	"read",
	"edit",
	"delete",
	"move",
	"search",
	"execute",
	"think",
	"fetch",
	"switch_mode",
	"other"
]);
/** Every config key this provider actually reads; anything else is inert (see `reportInertConfigKeys`). */
const DECLARED_CONFIG_KEYS = Object.freeze([
	"providerName",
	"command",
	"args",
	"cwd",
	"permission",
	"env",
	"disposeEofGraceMs",
	"disposeGraceMs",
	"disposeFinalGraceMs",
	"disposalTimeoutMs",
	"processStartTimeoutMs",
	"startupTimeoutMs",
	"idleWarnMs",
	"idleTimeoutMs",
	"softTimeoutMs",
	"absoluteTimeoutMs",
	"complexSoftTimeoutMs",
	"complexHardTimeoutMs",
	"activityExtensionMs",
	"activityProbeMs",
	"exitSettleMs",
	"recoverySettleMs",
	"workspaceScanLimit",
	"recoveryRecordDir",
	"guardWorkspaceReuse"
]);
/** An unknown key shaped like a protection bound is a silent no-op; it must be reported. */
const PROTECTION_KEY_PATTERN = /(timeout|idle|dispose|grace|activity|recovery|settle|scan|guard)/i;
/** Upper bound on cause text carried into the diagnostic; the service layer truncates again at 4096 bytes. */
const MAX_CAUSE_DETAIL_CHARS = 2000;
/**
 * Render the upstream failure detail retained on the Error cause chain.
 * The caller needs actionable reasons (HTTP status, quota, auth, limit); the
 * service layer applies its own 4096-byte cap on the final diagnostic.
 * @param cause - original failure, possibly an AggregateError or carrying a cause chain.
 * @returns de-duplicated single-line detail, or undefined when nothing is available.
 */
function causeDetail(cause) {
	if (cause === void 0 || cause === null) return void 0;
	const parts = [];
	const visit = (value, depth) => {
		if (value === void 0 || value === null || depth > 3) return;
		if (value instanceof AggregateError && Array.isArray(value.errors)) {
			for (const inner of value.errors) visit(inner, depth + 1);
			return;
		}
		const text = value instanceof Error ? value.message : String(value);
		const trimmed = typeof text === "string" ? text.trim() : "";
		if (trimmed.length > 0) parts.push(trimmed.split(/ +/).join(" "));
		if (value instanceof Error && value.cause !== void 0) visit(value.cause, depth + 1);
	};
	visit(cause, 0);
	if (parts.length === 0) return void 0;
	const joined = [...new Set(parts)].join(" | ");
	return joined.length > MAX_CAUSE_DETAIL_CHARS ? joined.slice(0, MAX_CAUSE_DETAIL_CHARS) + "..." : joined;
}
/** Attach the upstream detail to the fixed facts so every diagnostics path can render it. */
function withCauseDetail(facts, cause) {
	const detail = causeDetail(cause);
	return detail === void 0 ? facts : {
		...facts,
		detail
	};
}
/** Fixed safe failure text derived only from provider-owned structured facts. */
function failureDiagnostic(facts) {
	const fields = [
		"provider: ACP",
		`stage: ${facts.stage}`,
		`category: ${facts.category}`
	];
	if (facts.stopReason !== void 0) fields.push(`stop reason: ${facts.stopReason}`);
	if (facts.outcome?.exitCode !== null && facts.outcome?.exitCode !== void 0) fields.push(`exit code: ${facts.outcome.exitCode}`);
	/* v8 ignore next -- Windows does not report POSIX child signals in SubprocessOutcome. */
	if (facts.outcome?.signal !== null && facts.outcome?.signal !== void 0) fields.push(`signal: ${facts.outcome.signal}`);
	if (facts.timeoutKind !== void 0) fields.push(`timeout: ${facts.timeoutKind}`);
	if (facts.ladder !== void 0) fields.push(`ladder: ${facts.ladder}`);
	if (facts.elapsedMs !== void 0) fields.push(`elapsed ms: ${facts.elapsedMs}`);
	if (facts.idleMs !== void 0) fields.push(`idle ms: ${facts.idleMs}`);
	if (facts.lastActivity !== void 0) fields.push(`last activity: ${facts.lastActivity}`);
	if (facts.idleWarnings !== void 0) fields.push(`idle warnings: ${facts.idleWarnings}`);
	if (facts.exitSettleMs !== void 0) fields.push(`exit settle ms: ${facts.exitSettleMs}`);
	if (facts.recovery !== void 0) fields.push(`recovery: ${facts.recovery}`);
	if (facts.changedFiles !== void 0) fields.push(`changed files: ${facts.changedFiles}`);
	if (facts.changedTestFiles !== void 0) fields.push(`changed test files: ${facts.changedTestFiles}`);
	if (facts.processState !== void 0) fields.push(`process: ${facts.processState}`);
	if (facts.rangeQuiesced !== void 0) fields.push(`range quiesced: ${facts.rangeQuiesced}`);
	if (facts.tests !== void 0) fields.push(`tests: ${facts.tests}`);
	const headline = `Subagent failure (${fields.join("; ")})`;
	return facts.detail === void 0 ? headline : headline + "\ncause: " + facts.detail;
}
/** Fixed permission fact; ACP tool titles and option text never enter it. */
function permissionDiagnostic(permission) {
	return `ACP unattended decision (policy: ${permission.policy}; request: ${permission.request}; decision: ${permission.decision})`;
}
/** Put the operation failure first, followed by the latest permission decision. */
function diagnosticText(facts, permission, cause) {
	const failure = failureDiagnostic(withCauseDetail(facts, cause));
	return permission === void 0 ? failure : failure + "\n" + permissionDiagnostic(permission);
}
var AcpRunFailure = class extends Error {
	constructor(facts, cause) {
		const merged = withCauseDetail(facts, cause);
		super(`subagent-acp: ${failureDiagnostic(merged)}`, { cause });
		this.name = "AcpRunFailure";
	}
};
/**
 * Hide a pre-spawn workspace/configuration failure behind fixed safe facts.
 * @param cause - original Host failure retained on the Error cause chain.
 * @returns an Error whose message contains only the fixed ACP failure line.
 */
function acpConfigurationFailure(cause) {
	return new AcpRunFailure({
		stage: "initialize",
		category: "configuration"
	}, cause);
}
/** Keep only the closed ACP tool-kind vocabulary; future values use a fixed fallback. */
function permissionRequestKind(kind) {
	const candidate = kind ?? "unknown";
	return ACP_TOOL_KINDS.has(candidate) ? candidate : "unknown";
}
/** Promise-based sleep used by the bounded settle windows. */
function delay(ms) {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
/** Bounded byte-level workspace fingerprint: relative path -> `size:mtimeMs`. */
function workspaceSnapshot(root, limit) {
	const files = new Map();
	const stack = [root];
	while (stack.length && files.size < limit) {
		const dir = stack.pop();
		let entries;
		try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
		for (const entry of entries) {
			if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".ptc") continue;
			const path = join(dir, entry.name);
			if (entry.isDirectory()) stack.push(path);
			else if (entry.isFile()) {
				try { const s = statSync(path); files.set(relative(root, path), `${s.size}:${s.mtimeMs}`); } catch {}
			}
			if (files.size >= limit) break;
		}
	}
	return files;
}
/** Paths added, modified, or removed between two snapshots, sorted and de-duplicated. */
function changedWorkspaceFiles(before, after) {
	const changed = [];
	for (const [path, signature] of after) if (before.get(path) !== signature) changed.push(path);
	for (const path of before.keys()) if (!after.has(path)) changed.push(path);
	return [...new Set(changed)].sort();
}
/** Count changed paths that look like test material, so the parent knows what to re-verify. */
function changedTestFiles(paths) {
	let count = 0;
	for (const path of paths) if (/(^|[\\/])(tests?|__tests__|spec|specs)([\\/]|$)|\.(test|spec)\.[^\\/]+$/i.test(path)) count += 1;
	return count;
}
/** Bounded, content-free recovery record so a timed-out run stays resumable and auditable. */
function writeRecoveryRecord(dir, record) {
	if (dir === void 0) return;
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${record.runId}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");
	} catch {}
}
//#endregion
//#region lib/types/workspace-guard.js
/**
 * Per-workspace reuse guard. Requirement: never start another write-capable
 * child in a directory until the previous child is PROVEN stopped. A run whose
 * managed range could not be shown empty leaves its cwd guarded; a later run in
 * that cwd is refused with a precise diagnostic instead of silently interleaving
 * two writers.
 * @module @deepseek-ai/dsh-subagent-acp/workspace-guard
 */
const workspaceGuards = new Map();
/** Record the live run for a cwd. */
function guardWorkspace(cwd, entry) {
	workspaceGuards.set(cwd, entry);
}
/** Drop the guard only when the recorded run is the one now proven stopped. */
function releaseWorkspace(cwd, runId) {
	const entry = workspaceGuards.get(cwd);
	if (entry !== void 0 && entry.runId === runId) workspaceGuards.delete(cwd);
}
/** The blocking guard entry for a cwd, if its previous run was not proven stopped. */
function blockedWorkspace(cwd) {
	const entry = workspaceGuards.get(cwd);
	return entry !== void 0 && entry.state === "unproven-stopped" ? entry : void 0;
}
/** Snapshot of every guard, for diagnostics and tests. */
function workspaceGuardState() {
	return [...workspaceGuards.entries()].map(([cwd, entry]) => ({ cwd, ...entry }));
}
/** Test/maintenance seam: forget every guard. */
function clearWorkspaceGuards() {
	workspaceGuards.clear();
}
//#endregion
//#region lib/types/run.js
/**
 * Bounded managed-range exit wait: observes the handle's range until it is empty
 * or `ms` elapses. `false` means the bound won, never a hang.
 */
async function rangeExitsWithin(child, ms) {
	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort();
	}, ms);
	try {
		return await child.waitForExit(controller.signal);
	} finally {
		clearTimeout(timer);
	}
}
/**
 * Cooperative teardown ladder for an out-of-process agent, over the seam's
 * public verbs. Every rung is bounded: stdin EOF, then `terminate()` under a
 * second bound. Non-quiescence is REPORTED (`quiesced: false`) instead of
 * awaited forever, which is what makes a settled run always returnable.
 * @param child - the spawned ACP child's handle.
 * @param eofGraceMs - tier-1 window after stdin EOF.
 * @param finalGraceMs - tier-2 window after `terminate()`.
 * @returns the quiescence proof, any observation failures, and the wait time.
 */
async function disposeAcpChild(child, eofGraceMs, finalGraceMs = DEFAULT_DISPOSE_FINAL_GRACE_MS) {
	const failures = [];
	const startedAt = Date.now();
	child.stdin?.end();
	let quiesced = false;
	try {
		quiesced = await rangeExitsWithin(child, eofGraceMs);
	} catch (error) {
		failures.push(toError(error));
	}
	if (!quiesced) {
		try {
			child.terminate();
		} catch (error) {
			failures.push(toError(error));
		}
		try {
			quiesced = await rangeExitsWithin(child, finalGraceMs);
		} catch (error) {
			failures.push(toError(error));
		}
	}
	return {
		quiesced,
		failures,
		waitedMs: Date.now() - startedAt
	};
}
/**
 * Map an ACP {@link StopReason} to a harness {@link SubagentStopReason}.
 * @param reason - the terminal reason from the child's `session/prompt` response.
 * @returns the harness equivalent; `max_turn_requests` and any unknown future
 * variant map to `error`, so an unclean stop is never reported as `completed`.
 */
function acpStopReason(reason) {
	switch (reason) {
		case "end_turn": return "completed";
		case "max_tokens": return "max-tokens";
		case "refusal": return "refusal";
		case "cancelled": return "aborted";
		case "max_turn_requests": return "error";
		default: return "error";
	}
}
/**
 * Collect the text of an ACP content block (non-text blocks contribute nothing).
 * @param content - the content block off a streamed `agent_message_chunk`.
 * @returns the block's text, or `''` for a non-text block.
 */
function acpContentText(content) {
	return content.type === "text" ? content.text : "";
}
/**
 * Translate the harness prompt blocks into ACP prompt blocks (text only).
 * @param prompt - the harness prompt; non-text blocks are dropped.
 * @returns the ACP text blocks, in order.
 */
function toAcpPrompt(prompt) {
	const blocks = [];
	for (const block of prompt) if (block.type === "text") blocks.push({
		type: "text",
		text: block.text
	});
	return blocks;
}
/** Normalize an unknown thrown value to an Error (the catch binding is `unknown`). */
function toError(value) {
	/* v8 ignore next */
	return value instanceof Error ? value : new Error(String(value));
}
/** Report an original Host failure without letting the observation sink replace it. */
function reportFailure(spec, error) {
	try {
		spec.onError?.(toError(error), "error");
	} catch {}
}
/** Classify an unpublished failure from the active protocol operation and observed process facts. */
function startupFailure(error, stage, outcome) {
	return new AcpRunFailure(
		/* v8 ignore next -- Windows anonymous pipes cannot expose a live-child protocol close during startup. */
		outcome === void 0 ? {
			stage,
			category: "transport"
		} : {
			stage,
			category: "process-exit",
			outcome
		},
		error
	);
}
/**
 * Preserve a startup-tier deadline as a classified timeout. Without this the
 * generic `startupFailure` wrapper would relabel `process-start`/`startup`
 * timeouts as `transport`, hiding which bound actually fired.
 */
function startupTimeoutFailure(error, stage) {
	const facts = error.timeoutFacts ?? {};
	return new AcpRunFailure({
		stage: facts.kind === "process-start" ? "process" : stage,
		category: "timeout",
		timeoutKind: facts.kind,
		elapsedMs: facts.elapsedMs,
		idleMs: facts.idleMs,
		lastActivity: facts.lastActivity
	}, error);
}
/** Map one remote terminal reason to the optional safe failure line it needs. */
function terminalFailure(reason, permission) {
	switch (reason) {
		case "end_turn": return;
		case "max_turn_requests": return diagnosticText({
			stage: "prompt",
			category: "remote-limit",
			stopReason: "max_turn_requests"
		}, permission);
		case "max_tokens":
		case "refusal":
		case "cancelled": return permission === void 0 ? void 0 : permissionDiagnostic(permission);
		default: return diagnosticText({
			stage: "prompt",
			category: "unknown",
			stopReason: "unknown"
		}, permission);
	}
}
/**
 * Start and publish one ACP child after initialization and session creation.
 * Startup rejects with fixed safe facts after provider-owned cleanup. The
 * published run is bounded end to end: a tiered watchdog settles it by
 * evidence, an exit observer settles it when the child dies without answering,
 * and disposal can never outlive its own ceiling.
 * @param request - the start request; its signal is the cancellation channel.
 * @param spec - the resolved spawn spec plus every bound the provider enforces.
 * @returns the ready run handle for the child subprocess.
 */
async function startAcpRun(request, spec) {
	if (request.signal.aborted) throw new Error("subagent request was aborted before the ACP child started");
	const id = brandString(randomUUID());
	const runStartedAt = Date.now();
	const initialWorkspace = workspaceSnapshot(spec.cwd, spec.workspaceScanLimit);
	let lastActivity = { at: runStartedAt, kind: "spawn" };
	let baseline = initialWorkspace;
	let lastProbeAt = 0;
	let idleWarnings = 0;
	let idleWarnedAt;
	const touchedPaths = new Set();
	const markActivity = (kind) => {
		lastActivity = { at: Date.now(), kind };
	};
	/**
	 * Dynamic activity evidence, throttled to one bounded scan per
	 * `activityProbeMs`. ACP events alone are not proof of progress and silence
	 * alone is not proof of failure: the workspace fingerprint is the second,
	 * independent witness. The baseline is refreshed on every probe, so
	 * "progress" always means RECENT change, never a change since spawn.
	 */
	const probeWorkspace = async () => {
		const now = Date.now();
		if (now - lastProbeAt < spec.activityProbeMs) return { changed: false, changedFiles: 0, skipped: true };
		lastProbeAt = now;
		const after = workspaceSnapshot(spec.cwd, spec.workspaceScanLimit);
		const changed = changedWorkspaceFiles(baseline, after);
		baseline = after;
		for (const path of changed) touchedPaths.add(path);
		if (changed.length > 0) markActivity(`workspace-change:${changed.length}`);
		return { changed: changed.length > 0, changedFiles: changed.length, skipped: false };
	};
	let child;
	try {
		child = spec.spawn({
			argv: [spec.command, ...spec.args],
			cwd: spec.cwd,
			stdio: {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "inherit"
			},
			graceMs: spec.disposeGraceMs,
			env: spec.env
		});
	} catch (error) {
		reportFailure(spec, error);
		throw new AcpRunFailure({
			stage: "process",
			category: "process-start"
		}, error);
	}
	/* v8 ignore start -- 'pipe' dispositions expose both streams by the seam contract; defensive. */
	if (child.stdin === void 0 || child.stdout === void 0) throw new Error("subagent-acp: subprocess implementation dropped a piped protocol stream");
	/* v8 ignore stop */
	let processOutcome;
	let processFailure;
	let exitAt;
	const processDone = child.done.then((outcome) => {
		processOutcome = outcome;
		exitAt = Date.now();
		return outcome;
	}, (error) => {
		processFailure = toError(error);
		exitAt = Date.now();
		throw processFailure;
	});
	const processRejected = processDone.then(
		/* v8 ignore next -- the success arm's never-settling executor is intentionally empty. */
		() => new Promise(() => {}),
		(err) => Promise.reject(toError(err))
	);
	processRejected.catch(() => {});
	const observeProcessOutcome = async (signal) => {
		if (processOutcome !== void 0) return processOutcome;
		const timeout = AbortSignal.timeout(Math.ceil(spec.disposeGraceMs));
		const bound = signal === void 0 ? timeout : AbortSignal.any([signal, timeout]);
		const aborted = Promise.withResolvers();
		/* v8 ignore next -- Windows cannot expose the live-child protocol close needed to await this abort. */
		const onObservationAbort = () => {
			aborted.resolve(void 0);
		};
		bound.addEventListener("abort", onObservationAbort, { once: true });
		/* v8 ignore next -- closes the event-loop race between listener registration and the preceding derived-signal check. */
		if (bound.aborted) onObservationAbort();
		try {
			return await Promise.race([processDone, aborted.promise]);
		} catch {
			return processOutcome;
		} finally {
			bound.removeEventListener("abort", onObservationAbort);
		}
	};
	let processDisposal;
	const disposeProcess = () => processDisposal ??= (async () => {
		const ladder = disposeAcpChild(child, spec.disposeEofGraceMs, spec.disposeFinalGraceMs);
		const ceiling = delay(spec.disposalTimeoutMs).then(() => ({
			quiesced: false,
			failures: [new Error(`subagent-acp: disposal exceeded ${spec.disposalTimeoutMs}ms; managed range not proven empty`)],
			waitedMs: spec.disposalTimeoutMs,
			ceilingExceeded: true
		}));
		const result = await Promise.race([ladder, ceiling]);
		/*
		 * Two different facts, deliberately not conflated:
		 * - childProvenStopped: the spawned command reported an exit, so the CHILD
		 *   is stopped and a new writer is allowed (`stopped-with-survivors`).
		 * - quiesced: the whole managed range is empty, the stronger fact.
		 * Only a child that never reported an exit is `unproven-stopped`, which is
		 * the one state that blocks a new writer in this cwd.
		 */
		const childProvenStopped = processOutcome !== void 0;
		guardWorkspace(spec.cwd, {
			runId: id,
			providerName: spec.providerName,
			state: result.quiesced ? "stopped" : childProvenStopped ? "stopped-with-survivors" : "unproven-stopped",
			at: Date.now(),
			rangeQuiesced: result.quiesced,
			childProvenStopped,
			recovery: spec.lastRecovery,
			changedFiles: spec.lastChangedFiles
		});
		if (result.quiesced) releaseWorkspace(spec.cwd, id);
		/* A late proof must still release the guard: the ceiling can win the race while the ladder finishes afterwards. */
		if (!result.quiesced) ladder.then((late) => {
			if (late.quiesced) releaseWorkspace(spec.cwd, id);
		}).catch(() => {});
		return { ...result, childProvenStopped };
	})();
	const fold = new AssistantOutputFold();
	const flags = { cancelled: false, timedOut: false };
	let latestPermission;
	/**
	 * The process-start tier bounds "spawn -> the child proves it speaks ACP", so
	 * it must be disarmed by the FIRST inbound message rather than by a fixed
	 * clock: a child that handshakes and then stalls belongs to the session-setup
	 * tier, and reporting it as a process-start timeout would name the wrong bound.
	 */
	let firstTrafficAt;
	let signalFirstTraffic;
	const firstTraffic = new Promise((resolveFirstTraffic) => {
		signalFirstTraffic = resolveFirstTraffic;
	});
	const noteFirstTraffic = () => {
		if (firstTrafficAt !== void 0) return;
		firstTrafficAt = Date.now();
		signalFirstTraffic();
	};
	const agent = client({ name: "deepseek-harness-subagent-acp" }).onNotification(methods.client.session.update, ({ params }) => {
		noteFirstTraffic();
		const update = params.update;
		markActivity(`session-update:${update.sessionUpdate}`);
		if (update.sessionUpdate === "agent_message_chunk") fold.pushText(acpContentText(update.content));
		return Promise.resolve();
	}).onRequest(methods.client.session.requestPermission, ({ params }) => {
		noteFirstTraffic();
		markActivity("permission-request");
		if (spec.permission === "allow") {
			const allow = params.options.find((o) => o.kind === "allow_once" || o.kind === "allow_always");
			if (allow !== void 0) {
				latestPermission = {
					policy: "allow",
					request: permissionRequestKind(params.toolCall.kind),
					decision: "allowed"
				};
				return Promise.resolve({ outcome: {
					outcome: "selected",
					optionId: allow.optionId
				} });
			}
		}
		latestPermission = {
			policy: spec.permission,
			request: permissionRequestKind(params.toolCall.kind),
			decision: "denied"
		};
		return Promise.resolve({ outcome: { outcome: "cancelled" } });
	}).connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))).agent;
	let sessionId;
	let startupStage = "initialize";
	let signalCancelSettled;
	const cancelSettled = new Promise((resolveCancelSettled) => {
		signalCancelSettled = resolveCancelSettled;
	});
	/** Genuine parent cancellation: settles the result as `aborted`, exactly as the seam expects. */
	const requestCancel = () => {
		if (flags.cancelled) return;
		flags.cancelled = true;
		signalCancelSettled();
		sendRemoteCancel();
	};
	/**
	 * Provider-owned stop. Deliberately does NOT set `flags.cancelled`: the seam's
	 * `settleRunResult` discards the diagnostic on the cancelled path, and the
	 * whole point of a timeout result is to carry the preserved-work facts back.
	 */
	const requestRemoteCancel = () => {
		flags.timedOut = true;
		sendRemoteCancel();
	};
	const sendRemoteCancel = () => {
		/* v8 ignore next */
		if (sessionId === void 0) return;
		try {
			agent.notify(methods.agent.session.cancel, { sessionId }).catch(() => {});
		} catch {}
	};
	const onAbort = () => {
		requestCancel();
	};
	request.signal.addEventListener("abort", onAbort, { once: true });
	const collectOutput = () => fold.collect() ?? [];
	/** Bounded settle window, then a full workspace diff: never rolled back, never claimed as complete. */
	const buildRecovery = async (timeoutFacts) => {
		requestRemoteCancel();
		await delay(spec.recoverySettleMs);
		const changed = changedWorkspaceFiles(initialWorkspace, workspaceSnapshot(spec.cwd, spec.workspaceScanLimit));
		spec.lastChangedFiles = changed.length;
		const processState = processOutcome !== void 0 ? `exited(${processOutcome.exitCode ?? processOutcome.signal ?? "unknown"})` : processFailure !== void 0 ? "exit-failed" : "running";
		const recovery = {
			...timeoutFacts,
			recovery: changed.length > 0 ? "changes-preserved-unverified" : "no-changes-detected",
			changedFiles: changed.length,
			changedTestFiles: changedTestFiles(changed),
			changedPaths: changed.slice(0, 50),
			processState,
			idleWarnings,
			tests: "not-verified"
		};
		spec.lastRecovery = recovery.recovery;
		writeRecoveryRecord(spec.recoveryRecordDir, {
			runId: id,
			providerName: spec.providerName,
			command: spec.command,
			args: spec.args,
			cwd: spec.cwd,
			startedAt: runStartedAt,
			settledAt: Date.now(),
			timeoutKind: timeoutFacts.timeoutKind,
			ladder: timeoutFacts.ladder,
			elapsedMs: timeoutFacts.elapsedMs,
			idleMs: timeoutFacts.idleMs,
			lastActivity: timeoutFacts.lastActivity,
			recovery: recovery.recovery,
			changedFiles: recovery.changedFiles,
			changedTestFiles: recovery.changedTestFiles,
			changedPaths: recovery.changedPaths,
			processState,
			tests: "not-verified",
			resumeHint: "Inspect the changed paths and re-run the task's tests before resuming or accepting this work."
		});
		return recovery;
	};
	try {
		let processStartTimerHandle;
		const processStartTimer = new Promise((_, reject) => {
			processStartTimerHandle = setTimeout(() => {
				reject(timeoutError("process-start", {
					elapsedMs: Date.now() - runStartedAt,
					idleMs: Date.now() - lastActivity.at,
					lastActivity: lastActivity.kind
				}));
			}, spec.processStartTimeoutMs);
		});
		firstTraffic.then(() => clearTimeout(processStartTimerHandle));
		const startupTimer = new Promise((_, reject) => setTimeout(() => {
			reject(timeoutError("startup", {
				elapsedMs: Date.now() - runStartedAt,
				idleMs: Date.now() - lastActivity.at,
				lastActivity: lastActivity.kind
			}));
		}, spec.startupTimeoutMs));
		await Promise.race([
			(async () => {
				await agent.request(methods.agent.initialize, {
					protocolVersion: PROTOCOL_VERSION,
					clientCapabilities: {}
				});
				noteFirstTraffic();
				markActivity("initialize-response");
				startupStage = "new-session";
				const session = await agent.request(methods.agent.session.new, {
					cwd: spec.cwd,
					mcpServers: []
				});
				const returnedSessionId = Reflect.get(session, "sessionId");
				if (typeof returnedSessionId !== "string") throw new AcpRunFailure({
					stage: "new-session",
					category: "protocol"
				}, /* @__PURE__ */ new Error("ACP child published without a session id"));
				sessionId = returnedSessionId;
				markActivity("session-created");
				/* v8 ignore next -- cancelSettled wins the startup race before this post-response guard can settle it. */
				if (flags.cancelled) throw new Error("subagent cancelled before the ACP session started");
			})(),
			processStartTimer,
			startupTimer,
			processRejected,
			cancelSettled.then(() => {
				throw new Error("subagent cancelled before the ACP session started");
			})
		]);
	} catch (error) {
		request.signal.removeEventListener("abort", onAbort);
		const cancelledBeforeCleanup = flags.cancelled;
		const isTimeout = error?.name === "AcpTimeoutError";
		if (isTimeout) flags.timedOut = true;
		const observedOutcome = !cancelledBeforeCleanup && !(error instanceof AcpRunFailure) ? await observeProcessOutcome() : void 0;
		const startup = cancelledBeforeCleanup ? { kind: "cancelled" } : {
			kind: "failed",
			failure: error instanceof AcpRunFailure ? error : error?.name === "AcpTimeoutError" ? startupTimeoutFailure(error, startupStage) : startupFailure(error, startupStage, observedOutcome)
		};
		if (startup.kind === "cancelled") {} else reportFailure(spec, error instanceof AcpRunFailure ? error.cause : processFailure ?? error);
		try {
			await disposeProcess();
		} catch (cleanupError) {
			reportFailure(spec, cleanupError);
			const cleanupFailure = new AcpRunFailure({
				stage: "teardown",
				category: processOutcome === void 0 ? "unknown" : "process-exit",
				...processOutcome === void 0 ? {} : { outcome: processOutcome }
			}, cleanupError);
			if (startup.kind === "cancelled") throw new AggregateError([cleanupFailure], cleanupFailure.message);
			throw new AggregateError([startup.failure, cleanupFailure], `${startup.failure.message}; ${cleanupFailure.message}`);
		}
		if (startup.kind === "cancelled") throw new Error("subagent request was aborted before the ACP child started");
		throw startup.failure;
	}
	/* v8 ignore next */
	if (sessionId === void 0) throw new Error("unreachable: ACP startup fulfilled without a session id");
	const remoteSessionId = sessionId;
	let diagnostic;
	let ladder = {
		name: "normal",
		softMs: spec.softTimeoutMs,
		hardMs: spec.absoluteTimeoutMs,
		idleMs: spec.idleTimeoutMs
	};
	let escalated = false;
	let watchdogSettled = false;
	let watchdogTimer;
	let signalWatchdogVerdict;
	const watchdogVerdict = new Promise((resolveVerdict) => {
		signalWatchdogVerdict = resolveVerdict;
	});
	const stopWatchdog = () => {
		if (watchdogSettled) return;
		watchdogSettled = true;
		if (watchdogTimer !== void 0) clearTimeout(watchdogTimer);
	};
	const settleWatchdog = (verdict) => {
		if (watchdogSettled) return;
		watchdogSettled = true;
		if (watchdogTimer !== void 0) clearTimeout(watchdogTimer);
		signalWatchdogVerdict(verdict);
	};
	const scheduleWatchdog = () => {
		if (watchdogSettled) return;
		const remainingSoft = Math.max(10, ladder.softMs - (Date.now() - runStartedAt));
		watchdogTimer = setTimeout(() => {
			watchdogStep().catch(() => {});
		}, Math.max(10, Math.min(spec.activityExtensionMs, remainingSoft)));
	};
	/**
	 * One watchdog step. Deadlines are consulted in strict order — hard ceiling,
	 * then probe-verified idle, then the progress-verified soft deadline, then
	 * the advisory idle warning — and no deadline fires on ACP silence alone.
	 * A run that is demonstrably still making progress is never failed by a
	 * deadline: it escalates once from the normal to the complex ladder and then
	 * remains governed by that ladder's hard ceiling.
	 */
	const watchdogStep = async () => {
		if (watchdogSettled) return;
		/* The periodic probe is what keeps `lastActivity` an honest progress signal. */
		await probeWorkspace();
		if (watchdogSettled) return;
		const now = Date.now();
		const elapsed = now - runStartedAt;
		const idleFor = now - lastActivity.at;
		if (elapsed >= ladder.hardMs) return settleWatchdog({
			kind: "hard",
			ladder: ladder.name,
			elapsedMs: elapsed,
			idleMs: idleFor,
			lastActivity: lastActivity.kind
		});
		if (idleFor >= ladder.idleMs) return settleWatchdog({
			kind: "idle",
			ladder: ladder.name,
			elapsedMs: elapsed,
			idleMs: idleFor,
			lastActivity: lastActivity.kind
		});
		if (elapsed >= ladder.softMs) {
			const progressing = idleFor <= spec.activityExtensionMs;
			if (!progressing) return settleWatchdog({
				kind: "soft",
				ladder: ladder.name,
				elapsedMs: elapsed,
				idleMs: idleFor,
				lastActivity: lastActivity.kind
			});
			if (!escalated && ladder.name === "normal") {
				escalated = true;
				ladder = {
					name: "complex",
					softMs: Math.max(spec.complexSoftTimeoutMs, elapsed),
					hardMs: Math.max(spec.complexHardTimeoutMs, elapsed),
					idleMs: Math.max(spec.idleTimeoutMs, spec.complexSoftTimeoutMs)
				};
				spec.onWarn?.(`subagent-acp "${spec.providerName}": soft deadline reached with proven progress; escalating to the complex ladder (soft ${ladder.softMs}ms, hard ${ladder.hardMs}ms)`);
			}
			return scheduleWatchdog();
		}
		if (idleWarnedAt === void 0 && idleFor >= spec.idleWarnMs) {
			idleWarnedAt = now;
			idleWarnings += 1;
			spec.onWarn?.(`subagent-acp "${spec.providerName}": child quiet for ${idleFor}ms (last activity: ${lastActivity.kind}); continuing because silence alone is not failure`);
		}
		scheduleWatchdog();
	};
	/* The child's exit is evidence, not progress: it is observed separately and never refreshes the idle clock. */
	let exitInfo;
	const exitObserved = new Promise((resolveExit) => {
		processDone.then(() => {
			exitInfo = { outcome: processOutcome };
			resolveExit();
		}, (error) => {
			exitInfo = { error: toError(error) };
			resolveExit();
		});
	});
	/**
	 * "Modified files, then the final response is late." The child's exit is held
	 * open for `exitSettleMs` so a response already in flight still wins; only
	 * after that window is a missing terminal response a failure.
	 */
	const exitWithoutResponse = exitObserved.then(async () => {
		await delay(spec.exitSettleMs);
		return exitInfo;
	});
	return subprocessRunHandle({
		id,
		result: settleRunResult({
			attempt: async () => {
				try {
					markActivity("prompt-start");
					const promptRequest = agent.request(methods.agent.session.prompt, {
						sessionId: remoteSessionId,
						prompt: toAcpPrompt(request.prompt)
					});
					promptRequest.catch(() => {});
					scheduleWatchdog();
					const outcome = await Promise.race([
						promptRequest.then((result) => ({ kind: "prompt", result })),
						watchdogVerdict.then((verdict) => ({ kind: "verdict", verdict })),
						exitWithoutResponse.then((info) => ({ kind: "exit", info })),
						cancelSettled.then(() => {
							throw new Error("subagent cancelled while the ACP prompt was running");
						})
					]);
					stopWatchdog();
					if (outcome.kind === "verdict") {
						const facts = {
							stage: "prompt",
							category: "timeout",
							timeoutKind: outcome.verdict.kind,
							ladder: outcome.verdict.ladder,
							elapsedMs: outcome.verdict.elapsedMs,
							idleMs: outcome.verdict.idleMs,
							lastActivity: outcome.verdict.lastActivity
						};
						const recovery = await buildRecovery(facts);
						diagnostic = diagnosticText({
							stage: "prompt",
							category: "timeout",
							timeoutKind: recovery.timeoutKind,
							ladder: recovery.ladder,
							elapsedMs: recovery.elapsedMs,
							idleMs: recovery.idleMs,
							lastActivity: recovery.lastActivity,
							idleWarnings: recovery.idleWarnings,
							recovery: recovery.recovery,
							changedFiles: recovery.changedFiles,
							changedTestFiles: recovery.changedTestFiles,
							processState: recovery.processState,
							tests: recovery.tests
						}, latestPermission);
						const error = new Error(`ACP ${recovery.timeoutKind} timeout`);
						error.name = "AcpTimeoutError";
						error.timeoutFacts = recovery;
						throw error;
					}
					if (outcome.kind === "exit") {
						const info = outcome.info;
						const facts = {
							stage: "prompt",
							category: info?.error !== void 0 ? "process-exit" : "process-exit",
							...info?.outcome === void 0 ? {} : { outcome: info.outcome }
						};
						const recovery = await buildRecovery({
							...facts,
							timeoutKind: "exit-without-response",
							exitSettleMs: spec.exitSettleMs,
							elapsedMs: Date.now() - runStartedAt,
							idleMs: Date.now() - lastActivity.at,
							lastActivity: lastActivity.kind
						});
						diagnostic = diagnosticText({
							stage: "prompt",
							category: "process-exit",
							...info?.outcome === void 0 ? {} : { outcome: info.outcome },
							timeoutKind: recovery.timeoutKind,
							exitSettleMs: spec.exitSettleMs,
							elapsedMs: recovery.elapsedMs,
							idleMs: recovery.idleMs,
							lastActivity: recovery.lastActivity,
							recovery: recovery.recovery,
							changedFiles: recovery.changedFiles,
							changedTestFiles: recovery.changedTestFiles,
							processState: recovery.processState,
							tests: recovery.tests
						}, latestPermission);
						throw info?.error ?? new Error(`ACP child exited without a final session/prompt response (${spec.exitSettleMs}ms settle window elapsed)`);
					}
					markActivity("prompt-terminal");
					const stopReason = acpStopReason(outcome.result.stopReason);
					diagnostic = terminalFailure(outcome.result.stopReason, latestPermission);
					return {
						output: collectOutput(),
						...diagnostic === void 0 ? {} : { diagnostic },
						stopReason
					};
				} catch (error) {
					stopWatchdog();
					if (!flags.cancelled && diagnostic === void 0) {
						const outcome = await observeProcessOutcome(request.signal);
						diagnostic = diagnosticText(outcome === void 0 ? {
							stage: "prompt",
							category: "transport"
						} : {
							stage: "process",
							category: "process-exit",
							outcome
						}, latestPermission, error);
					}
					throw processFailure ?? error;
				}
			},
			collectOutput,
			collectDiagnostic: () => diagnostic,
			cancelled: () => flags.cancelled,
			onError: spec.onError,
			signal: request.signal,
			onAbort
		}),
		signal: request.signal,
		onAbort,
		requestCancel,
		teardown: async () => {
			const result = await disposeProcess();
			if (result.failures.length > 0) reportFailure(spec, result.failures[0]);
			if (result.quiesced) return;
			/*
			 * A child that reported an exit IS stopped; only its descendants may
			 * linger. Failing here would replace an already-settled result (often a
			 * completed one) with a teardown error, which is exactly the "work is
			 * done but the caller never gets it" defect. Record the weaker fact and
			 * let the result stand.
			 */
			if (result.childProvenStopped) {
				spec.onWarn?.(`subagent-acp "${spec.providerName}": child exited but its managed range is not proven empty after ${result.waitedMs}ms; "${spec.cwd}" is recorded as stopped-with-survivors`);
				return;
			}
			spec.onWarn?.(`subagent-acp "${spec.providerName}": managed range not proven empty after ${result.waitedMs}ms and the child never reported an exit; cwd "${spec.cwd}" stays guarded against a new writer until it is`);
			throw new AcpRunFailure({
				stage: "teardown",
				category: processOutcome === void 0 ? "unknown" : "process-exit",
				...processOutcome === void 0 ? {} : { outcome: processOutcome },
				rangeQuiesced: false,
				recovery: "managed-range-not-empty"
			}, result.failures[0]);
		}
	});
}
//#endregion
//#region lib/types/index.js
/**
 * Out-of-process ACP subagent backend. Each child has its own process, session, model, and
 * tools, so it shares no Cordis context and advertises no parent-enforced start capabilities;
 * the ONE thing it reads off `request.parent` is the session's workspace cwd (see
 * {@link resolveCwd}). This plugin uses named exports only; a default would hide its
 * loader metadata (see `docs/postmortem/0001-acp-default-export-drops-inject.md`).
 * @module @deepseek-ai/dsh-subagent-acp-resilient
 */
const name = "subagent-acp";
const inject = ["subagents", "subprocess"];
const Config = z.object({
	providerName: z.string().default("acp"),
	command: z.string().required(),
	args: z.array(z.string()).default([]),
	cwd: z.string(),
	permission: z.union(["allow", "reject"]).default("reject"),
	env: z.dict(z.string()).default({}),
	disposeEofGraceMs: z.number().default(DEFAULT_DISPOSE_EOF_GRACE_MS),
	disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
	disposeFinalGraceMs: z.number().default(DEFAULT_DISPOSE_FINAL_GRACE_MS),
	disposalTimeoutMs: z.number().default(DEFAULT_DISPOSAL_TIMEOUT_MS),
	processStartTimeoutMs: z.number().default(DEFAULT_PROCESS_START_TIMEOUT_MS),
	startupTimeoutMs: z.number().default(DEFAULT_STARTUP_TIMEOUT_MS),
	idleWarnMs: z.number().default(DEFAULT_IDLE_WARN_MS),
	idleTimeoutMs: z.number().default(DEFAULT_IDLE_TIMEOUT_MS),
	softTimeoutMs: z.number().default(DEFAULT_SOFT_TIMEOUT_MS),
	absoluteTimeoutMs: z.number().default(DEFAULT_ABSOLUTE_TIMEOUT_MS),
	complexSoftTimeoutMs: z.number().default(DEFAULT_COMPLEX_SOFT_TIMEOUT_MS),
	complexHardTimeoutMs: z.number().default(DEFAULT_COMPLEX_HARD_TIMEOUT_MS),
	activityExtensionMs: z.number().default(DEFAULT_ACTIVITY_EXTENSION_MS),
	activityProbeMs: z.number().default(DEFAULT_ACTIVITY_PROBE_MS),
	exitSettleMs: z.number().default(DEFAULT_EXIT_SETTLE_MS),
	recoverySettleMs: z.number().default(DEFAULT_RECOVERY_SETTLE_MS),
	workspaceScanLimit: z.number().default(DEFAULT_WORKSPACE_SCAN_LIMIT),
	recoveryRecordDir: z.string(),
	guardWorkspaceReuse: z.boolean().default(true)
});
/** A bound must fit every Node timer that observes or terminates the child. */
function assertPositiveFinite(field, value) {
	if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) throw new Error(`subagent-acp: ${field} must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
}
/** Report config keys this provider never reads, so a protection bound cannot be a silent no-op. */
function reportInertConfigKeys(ctx, config) {
	const declared = new Set(DECLARED_CONFIG_KEYS);
	const inert = Object.keys(config).filter((key) => !declared.has(key));
	if (inert.length === 0) return [];
	const risky = inert.filter((key) => PROTECTION_KEY_PATTERN.test(key));
	ctx.logger.warn(`subagent-acp: ignoring ${inert.length} config key(s) this provider does not read: ${inert.join(", ")}`);
	if (risky.length > 0) ctx.logger.warn(`subagent-acp: ${risky.join(", ")} look like timeout/recovery bounds but are INERT — the framework passes unknown keys through without validation, so these values have no effect. Supported keys: ${DECLARED_CONFIG_KEYS.join(", ")}`);
	return inert;
}
function timeoutError(kind, timing, recovery) {
	const error = new Error(`ACP ${kind} timeout`);
	error.name = "AcpTimeoutError";
	error.timeoutFacts = { kind, ...timing, ...recovery };
	return error;
}
/**
 * Whether `path` names an existing directory the harness can ENTER. The
 * search-permission probe matters: `statSync().isDirectory()` is true for a
 * mode-600 directory, but a subprocess cwd needs `X_OK` or spawn fails EACCES.
 */
function isDirectory(path) {
	try {
		if (!statSync(path).isDirectory()) return false;
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
/**
 * Assert `cwd` can actually host the child: absolute (it doubles as the ACP
 * session workspace, and a relative path would be re-anchored to the server
 * process's launch directory) and an existing directory (fail here, before the
 * process boundary, instead of as an ambiguous spawn ENOENT).
 */
function assertUsableCwd(label, cwd) {
	if (!isAbsolute(cwd)) throw new Error(`subagent-acp: ${label} must be an absolute path: ${cwd}`);
	if (!isDirectory(cwd)) throw new Error(`subagent-acp: ${label} is not an accessible directory: ${cwd}`);
	return cwd;
}
/**
 * Resolve the child's working directory: the deployment `cwd` override when
 * configured (already validated at load), else the parent session's workspace
 * cwd (validated here, its earliest resolvable point).
 */
function resolveCwd(configured, request) {
	if (configured !== void 0) return configured;
	const parentCwd = request.parent.session.header.cwd;
	if (parentCwd === void 0) throw new Error("subagent-acp: no working directory for the child — configure `cwd` or delegate from a parent session that has one");
	return assertUsableCwd("parent session cwd", parentCwd);
}
/**
 * The ACP provider. Advertises NO start-time capabilities: an out-of-process
 * child cannot honor `agentOptions`/`outputSchema`/`maxDepth`/`toolFilter`/
 * `persona` (the service rejects a request needing any before `start` runs).
 */
var AcpProvider = class {
	name;
	ctx;
	config;
	capabilities = {
		agentOptions: false,
		outputSchema: false,
		depthLimit: false,
		toolFilter: false,
		persona: false
	};
	inheritsParentContext = false;
	constructor(name, ctx, config) {
		this.name = name;
		this.ctx = ctx;
		this.config = config;
	}
	start(request) {
		if (request.signal.aborted) throw new Error("subagent request was aborted before the ACP child started");
		let cwd;
		try {
			cwd = resolveCwd(this.config.cwd, request);
		} catch (error) {
			const failure = acpConfigurationFailure(error);
			this.ctx.logger.warn(`subagent-acp "${this.name}": child start failed: %o`, error);
			throw failure;
		}
		if (this.config.guardWorkspaceReuse) {
			const blocked = blockedWorkspace(cwd);
			if (blocked !== void 0) {
				this.ctx.logger.warn(`subagent-acp "${this.name}": refusing to start in "${cwd}": run ${blocked.runId} was never proven stopped`);
				throw new AcpRunFailure({
					stage: "process",
					category: "workspace-guard",
					recovery: "prior-run-not-proven-stopped",
					changedFiles: blocked.changedFiles,
					processState: `unproven-stopped(${blocked.providerName})`
				});
			}
		}
		return startAcpRun(request, {
			providerName: this.name,
			command: this.config.command,
			args: this.config.args,
			cwd,
			permission: this.config.permission,
			env: this.config.env,
			disposeEofGraceMs: this.config.disposeEofGraceMs,
			disposeGraceMs: this.config.disposeGraceMs,
			disposeFinalGraceMs: this.config.disposeFinalGraceMs,
			disposalTimeoutMs: this.config.disposalTimeoutMs,
			processStartTimeoutMs: this.config.processStartTimeoutMs,
			startupTimeoutMs: this.config.startupTimeoutMs,
			idleWarnMs: this.config.idleWarnMs,
			idleTimeoutMs: this.config.idleTimeoutMs,
			softTimeoutMs: this.config.softTimeoutMs,
			absoluteTimeoutMs: this.config.absoluteTimeoutMs,
			complexSoftTimeoutMs: this.config.complexSoftTimeoutMs,
			complexHardTimeoutMs: this.config.complexHardTimeoutMs,
			activityExtensionMs: this.config.activityExtensionMs,
			activityProbeMs: this.config.activityProbeMs,
			exitSettleMs: this.config.exitSettleMs,
			recoverySettleMs: this.config.recoverySettleMs,
			workspaceScanLimit: this.config.workspaceScanLimit,
			recoveryRecordDir: this.config.recoveryRecordDir,
			spawn: (spec) => this.ctx.subprocess.spawn(spec),
			onWarn: (message) => {
				this.ctx.logger.warn(message);
			},
			onError: (error, stopReason) => {
				this.ctx.logger.warn(`subagent-acp "${this.name}": child run failed (${stopReason}): ${error.message}`);
			}
		});
	}
};
function apply(ctx, config) {
	const resolved = config;
	reportInertConfigKeys(ctx, resolved);
	for (const key of DECLARED_CONFIG_KEYS) {
		if (key === "cwd" || key === "recoveryRecordDir" || key === "guardWorkspaceReuse" || key === "providerName" || key === "command" || key === "args" || key === "permission" || key === "env") continue;
		assertPositiveFinite(key, resolved[key]);
	}
	if (resolved.processStartTimeoutMs > resolved.startupTimeoutMs) throw new Error("subagent-acp: processStartTimeoutMs must not exceed startupTimeoutMs (process start is the first phase of session establishment)");
	/*
	 * `idleWarnMs` is purely advisory — it never fails a run — so an incoherent
	 * value is clamped to the escalation tier rather than rejected. This keeps a
	 * deployment order-independent: an older config that still says
	 * `idleTimeoutMs: 120000` keeps loading (with a loud warning) instead of
	 * silently losing every provider row.
	 */
	if (resolved.idleWarnMs > resolved.idleTimeoutMs) {
		ctx.logger.warn(`subagent-acp: idleWarnMs (${resolved.idleWarnMs}ms) exceeds idleTimeoutMs (${resolved.idleTimeoutMs}ms); clamping the advisory warning to the escalation tier`);
		resolved.idleWarnMs = resolved.idleTimeoutMs;
	}
	if (resolved.softTimeoutMs > resolved.absoluteTimeoutMs) throw new Error("subagent-acp: softTimeoutMs must not exceed absoluteTimeoutMs");
	if (resolved.absoluteTimeoutMs > resolved.complexHardTimeoutMs) throw new Error("subagent-acp: absoluteTimeoutMs must not exceed complexHardTimeoutMs");
	if (resolved.complexSoftTimeoutMs > resolved.complexHardTimeoutMs) throw new Error("subagent-acp: complexSoftTimeoutMs must not exceed complexHardTimeoutMs");
	if (resolved.cwd === "") throw new Error("subagent-acp: config cwd must not be empty — omit the key to inherit the parent session cwd");
	const withRecovery = resolved.recoveryRecordDir === void 0 && typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME.length > 0 ? {
		...resolved,
		recoveryRecordDir: join(process.env.DSH_HOME, "acp-recovery")
	} : resolved;
	const validated = withRecovery.cwd === void 0 ? withRecovery : {
		...withRecovery,
		cwd: assertUsableCwd("config cwd", resolve(withRecovery.cwd))
	};
	ctx.subagents.registerProvider(new AcpProvider(validated.providerName, ctx, validated));
}
//#endregion
export { Config, DECLARED_CONFIG_KEYS, apply, blockedWorkspace, clearWorkspaceGuards, disposeAcpChild, inject, name, startAcpRun, workspaceGuardState };
