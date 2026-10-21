/**
 * dsh-plugin-new-session — host 半（无 client 半、无外部依赖）。
 *
 * 目的：在**会话内**通过 `new_session` 工具创建**独立顶层会话**，等价于
 * Web GUI 的「新建会话」按钮，而不是 `subagent*` 那种挂在本会话下的子会话。
 *
 * 实现依据（DSH 0.2.0-rc.2 本体）：
 *   - GUI 的「新建会话」走 RPC
 *     `@deepseek-ai/dsh-api-session-controller#session/create`；
 *   - 该 RPC 的宿主实现就是服务 `sessionController`（TypertRemoteService，
 *     namespace `session`），其方法 `create` / `rename` / `prompt` 可直接调用；
 *   - `create()` 内部执行 `agents.ensureSession(id, cwd, ...)`，产出的 Session
 *     header 不带 `parentSession`、不带 `origin: 'subagent'`，因此是普通顶层会话，
 *     会出现在 GUI 侧边栏会话列表中。
 *
 * 为什么手写 ToolDefinition 而不 import `@deepseek-ai/dsh-tools`：本插件以
 * `link:` 方式登记，自身目录没有 node_modules，import 官方包会解析失败；
 * `ToolDefinition` 的形状已由 `defineTool` 的实现固定为
 * `{ name, description, parameters, output: { schema, render }, execute }`，
 * 这里按该形状直接构造，保持零依赖。
 *
 * 自写资产标记：origin: self / author: wang / created: 2026-10-20。
 */

import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { normalize } from 'node:path';

/** 插件名（cordis 插件标识，patch 层以包名登记）。 */
export const name = 'new-session';

/**
 * 只注入工具注册表与会话控制器。
 * cordis 语义：任一服务缺失时插件不激活，因此 headless 等无 Web 控制器的
 * profile 不会误加载本插件。
 */
export const inject = ['tools', 'sessionController'];

/** `new_session` 的模型可见参数（标准 JSON Schema）。 */
const PARAMETERS = {
	type: 'object',
	additionalProperties: false,
	properties: {
		title: {
			type: 'string',
			description: '新会话标题，便于在 GUI 侧边栏辨认。省略则不重命名。'
		},
		firstMessage: {
			type: 'string',
			description: '创建后立即作为用户消息发送给新会话的首条内容。省略则只建会话、不发送任何消息。'
		},
		cwd: {
			type: 'string',
			description: '新会话的工作目录（绝对路径）。省略则继承当前会话所在的工作区；当前会话没有工作区时才回退到它的 cwd。'
		},
		agentPreset: {
			type: 'string',
			description: '可选的 Agent 预设 id。省略则用部署默认预设。'
		}
	}
};

/** `new_session` 的规范输出。 */
const OUTPUT_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		sessionId: {
			type: 'string'
		},
		cwd: {
			type: 'string'
		},
		workspaceId: {
			type: 'string'
		},
		title: {
			type: 'string'
		},
		prompted: {
			type: 'boolean'
		},
		warnings: {
			type: 'array',
			items: { type: 'string' }
		}
	},
	required: ['sessionId', 'cwd', 'prompted', 'warnings']
};

/** 对外暴露参数与输出 schema，供本地校验脚本与后续复用。 */
export const parameters = PARAMETERS;
export const outputSchema = OUTPUT_SCHEMA;

const DESCRIPTION = [
	'Create a NEW INDEPENDENT top-level Session (the same thing the Web GUI "new session" button creates) and return its id.',
	'This is NOT a subagent: the new Session has no parent, inherits no context, and appears in the GUI session list on its own; it keeps running after this conversation ends.',
	'Use it when the user wants a separate conversation, a fresh context, or a parallel piece of work that should survive this session.',
	'Do not use it as a replacement for `subagent_*` when the user only needs a bounded side task whose result must come back here.',
	'By default the new Session joins the SAME WORKSPACE as this conversation, i.e. the same working-directory group in the GUI sidebar; pass `cwd` only to deliberately move it elsewhere.',
	'Optional `title` renames the new Session; optional `firstMessage` sends the first user message to it immediately; optional `cwd` overrides the workspace; optional `agentPreset` selects an Agent preset.'
].join(' ');

/** @returns whether `value` is a plain object. */
function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Trim a string argument, returning undefined for absent/blank values. */
function trimmed(value) {
	if (typeof value !== 'string') return undefined;
	const text = value.trim();
	return text.length === 0 ? undefined : text;
}

/** Convert any thrown value into one readable line without leaking internals. */
function messageOf(error) {
	if (error instanceof Error) return error.message;
	if (isRecord(error) && typeof error.message === 'string') return error.message;
	return String(error);
}

/**
 * Whether a prompt failure is the expected "no model resolved yet" deployment
 * state rather than a defect. Only this class may degrade to a warning; every
 * other failure is reported to the caller.
 * @param error - value thrown by `sessionController.prompt`.
 * @returns true when the Host answered `session/model-unavailable`.
 */
function isModelUnavailable(error) {
	const code = isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
	if (code === 'session/model-unavailable') return true;
	const message = messageOf(error);
	return message.includes('session/model-unavailable') || message.includes('Select an available model');
}

/**
 * Canonicalize one path for comparison. Workspace paths are `fs.realpath`
 * results while a Session header may keep the spelling it was launched with, so
 * both sides are resolved when possible and compared case-insensitively on
 * Windows.
 * @param value - absolute path spelling.
 * @returns comparison key.
 */
function canonicalPath(value) {
	try {
		return normalize(realpathSync.native(value)).toLowerCase();
	} catch {
		return normalize(value).toLowerCase();
	}
}

/**
 * Resolve the Workspace this conversation belongs to.
 *
 * A Doubles as membership proof: `Workspace.sessionIds` is header-validated by
 * the registry itself, so seeing the current Session id there is authoritative.
 * When it is absent (e.g. the Session was never attached) fall back to matching
 * the Workspace directory against the Session cwd.
 * @param ctx - registrant context; `workspaceRegistry` is optional by deployment.
 * @param exec - current tool execution, carrying the owning Agent.
 * @param explicitCwd - caller-supplied directory that overrides the workspace.
 * @returns the owning Workspace, or undefined when this conversation has none.
 */
function resolveWorkspace(ctx, exec, explicitCwd) {
	const registry = ctx.get?.('workspaceRegistry');
	if (registry === undefined) return undefined;
	let workspaces;
	try {
		workspaces = registry.list();
	} catch {
		return undefined;
	}
	if (!Array.isArray(workspaces) || workspaces.length === 0) return undefined;

	// 显式 cwd：只有它正好是某个工作区的目录时才归入该工作区，否则按调用方要求
	// 落到目录本身（不强行把会话塞进不相关的工作区）。
	if (explicitCwd !== undefined) {
		const key = canonicalPath(explicitCwd);
		return workspaces.find((workspace) => canonicalPath(workspace.path) === key);
	}

	const sessionId = exec.agent?.session?.header?.id;
	if (sessionId !== undefined) {
		const owner = workspaces.find((workspace) => Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId));
		if (owner !== undefined) return owner;
	}

	const sessionCwd = exec.agent?.session?.header?.cwd;
	if (sessionCwd === undefined) return undefined;
	const key = canonicalPath(sessionCwd);
	return workspaces.find((workspace) => canonicalPath(workspace.path) === key);
}

/**
 * Register the `new_session` tool on `ctx.tools`.
 * @param ctx - registrant context carrying the tool registry and the Session controller.
 */
export function apply(ctx) {
	ctx.tools.register({
		name: 'new_session',
		description: DESCRIPTION,
		parameters: PARAMETERS,
		output: {
			schema: OUTPUT_SCHEMA,
			render: (_args, value) => {
				const titlePart = value.title === undefined ? '' : `（${value.title}）`;
				const dirPart = `，工作目录 ${value.cwd === '' ? '（部署默认目录）' : value.cwd}`;
				const workspacePart = value.workspaceId === undefined ? '' : `，工作区 ${value.workspaceId}`;
				const messagePart = value.prompted ? '，首条消息已发送。' : '，尚未发送任何消息。';
				const warningPart = value.warnings.length === 0 ? '' : `\n警告：${value.warnings.join('；')}`;
				return [{
					type: 'text',
					text: `已创建独立会话 ${value.sessionId}${titlePart}${dirPart}${workspacePart}${messagePart}${warningPart}`
				}];
			}
		},
		async execute(args, exec) {
			const requested = isRecord(args) ? args : {};
			const warnings = [];

			// 归属：默认继承当前会话的工作区（GUI 侧边栏的同一目录分组）。
			// create 的 workspaceId 与 cwd 互斥：给出 workspaceId 时控制器会把新
			// 会话 attach 到该工作区，并把工作区目录当作 cwd。
			const sessionCwd = exec.agent?.session?.header?.cwd;
			const explicitCwd = trimmed(requested.cwd);
			const agentPreset = trimmed(requested.agentPreset);
			const workspace = resolveWorkspace(ctx, exec, explicitCwd);
			const cwd = workspace?.path ?? explicitCwd ?? sessionCwd;

			const request = {
				...(workspace === undefined
					? (cwd === undefined ? {} : { cwd })
					: { workspaceId: workspace.id }),
				...(agentPreset === undefined ? {} : { agentPreset })
			};

			let created;
			try {
				created = await ctx.sessionController.create(request);
			} catch (error) {
				throw new Error(`new_session: 创建会话失败：${messageOf(error)}`);
			}
			const sessionId = created.sessionId;

			// 标题是可选的增强项：控制器未挂载 session-title 服务时这里会失败，
			// 但会话本身已经创建成功，因此只降级为警告。
			let title;
			const requestedTitle = trimmed(requested.title);
			if (requestedTitle !== undefined) {
				try {
					const renamed = await ctx.sessionController.rename({ sessionId, title: requestedTitle });
					title = renamed.title;
				} catch (error) {
					warnings.push(`标题设置失败（会话已创建）：${messageOf(error)}`);
				}
			}

			// 首条消息失败分两类处理：
			//   - `session/model-unavailable` 是**预期内**的部署状态（新会话还没解析出
			//     可用模型），降级为警告，会话保留，用户可在 GUI 里选模型后继续；
			//   - 其它任何错误（参数漏传、宿主契约变化、权限等）一律抛出，绝不伪装成
			//     "会话建好了"。曾经因为一律降级，prompt 漏传 AbortSignal 的 bug 被
			//     掩盖成 warning，排查代价很高。
			// 注意：`prompt(request, signal)` 的 AbortSignal 是**必需参数**；漏传会在
			// Host 内部以 `Cannot read properties of undefined (reading 'throwIfAborted')`
			// 失败。这里转发本次工具调用的 signal。
			let prompted = false;
			const firstMessage = trimmed(requested.firstMessage);
			if (firstMessage !== undefined) {
				try {
					await ctx.sessionController.prompt({
						requestId: `new-session-${randomUUID()}`,
						sessionId,
						mode: 'queue',
						content: [{ type: 'text', text: firstMessage }]
					}, exec.signal);
					prompted = true;
				} catch (error) {
					if (isModelUnavailable(error)) {
						warnings.push(`首条消息发送失败（会话已创建）：${messageOf(error)}`);
					} else {
						throw new Error(`new_session: 会话已创建（${sessionId}），但首条消息发送失败：${messageOf(error)}`);
					}
				}
			}

			return {
				sessionId,
				cwd: cwd ?? '',
				...(workspace === undefined ? {} : { workspaceId: workspace.id }),
				...(title === undefined ? {} : { title }),
				prompted,
				warnings
			};
		},
		presentCall: (args) => ({
			card: 'generic',
			title: isRecord(args) && typeof args.title === 'string' ? `新建会话：${args.title}` : '新建独立会话',
			kind: 'other',
			rawInput: args
		})
	});
}
