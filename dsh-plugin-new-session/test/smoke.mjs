/**
 * dsh-plugin-new-session 冒烟测试（不启动 DSH、不写 ~/.dsh）。
 *
 * 覆盖：工具定义形状、cwd 继承、工作区归属、正常创建、
 * rename/prompt 降级为警告、create 失败抛出可读错误。
 *
 * 运行：node test/smoke.mjs
 */
import assert from 'node:assert/strict';
import { apply, inject, name } from '../index.js';

/** Capture the single tool the plugin registers. */
function loadWith(controller, registry) {
	let registered;
	const ctx = {
		tools: { register(definition) { registered = definition; return () => {}; } },
		sessionController: controller,
		...(registry === undefined
			? {}
			: { get: (service) => (service === 'workspaceRegistry' ? registry : undefined) })
	};
	apply(ctx);
	assert.ok(registered, 'plugin must register exactly one tool');
	return registered;
}

/** Build an exec context mimicking the agent loop. */
function execWithCwd(cwd, signal = new AbortController().signal) {
	return {
		callId: 'call-1',
		rootCallId: 'call-1',
		name: 'new_session',
		arguments: {},
		signal,
		...(cwd === undefined ? {} : { agent: { session: { header: { cwd } } } })
	};
}

let passed = 0;
/** Run one named assertion group. */
async function check(label, body) {
	await body();
	passed += 1;
	console.log(`ok ${passed} - ${label}`);
}

// --- 0. 插件导出形状 -------------------------------------------------------
assert.equal(name, 'new-session');
assert.deepEqual(inject, ['tools', 'sessionController']);
console.log('ok 0 - exports name/inject');

// --- 1. 工具定义形状 -------------------------------------------------------
const base = loadWith({
	async create() { return { sessionId: 'session-abc' }; },
	async rename() { return { title: 't', seq: 1 }; },
	async prompt() { return { accepted: true }; }
});
assert.equal(base.name, 'new_session');
assert.equal(base.parameters.type, 'object');
assert.equal(base.parameters.additionalProperties, false);
assert.deepEqual(Object.keys(base.parameters.properties).sort(), ['agentPreset', 'cwd', 'firstMessage', 'title']);
assert.equal(typeof base.execute, 'function');
assert.equal(typeof base.output.render, 'function');
assert.equal(base.output.schema.type, 'object');
assert.ok(base.description.includes('NOT a subagent'));
await check('tool definition shape', async () => {});

// --- 2. 默认路径：只建会话，继承当前 cwd -----------------------------------
await check('creates session and inherits current cwd', async () => {
	let seen;
	const tool = loadWith({
		async create(request) { seen = request; return { sessionId: 'session-1' }; },
		async rename() { throw new Error('must not be called'); },
		async prompt() { throw new Error('must not be called'); }
	});
	const value = await tool.execute({}, execWithCwd('D:\\work\\demo'));
	assert.deepEqual(seen, { cwd: 'D:\\work\\demo' });
	assert.deepEqual(value, { sessionId: 'session-1', cwd: 'D:\\work\\demo', prompted: false, warnings: [] });
	assert.equal(tool.output.render({}, value)[0].type, 'text');
	assert.ok(tool.output.render({}, value)[0].text.includes('session-1'));
});

// --- 3. 显式 cwd 覆盖当前 cwd，且不传 cwd 时不带该字段 ----------------------
await check('explicit cwd wins and blank cwd is dropped', async () => {
	const requests = [];
	const tool = loadWith({
		async create(request) { requests.push(request); return { sessionId: 'session-2' }; },
		async prompt() { return { accepted: true }; }
	});
	await tool.execute({ cwd: ' D:\\other ' }, execWithCwd('D:\\work\\demo'));
	await tool.execute({ cwd: '   ' }, execWithCwd(undefined));
	assert.deepEqual(requests, [{ cwd: 'D:\\other' }, {}]);
});

// --- 4. 正常路径：标题 + 首条消息 ------------------------------------------
await check('applies title and sends first message', async () => {
	const calls = [];
	const tool = loadWith({
		async create(request) { calls.push(['create', request]); return { sessionId: 'session-3' }; },
		async rename(request) { calls.push(['rename', request]); return { title: request.title, seq: 7 }; },
		async prompt(request, signal) { calls.push(['prompt', request, signal]); return { accepted: true }; }
	});
	const exec = execWithCwd('D:\\src\\dsh');
	const value = await tool.execute(
		{ title: ' 插件清单核对 ', firstMessage: ' 查一下插件 ', agentPreset: 'web-default' },
		exec
	);
	assert.equal(value.sessionId, 'session-3');
	assert.equal(value.title, '插件清单核对');
	assert.equal(value.prompted, true);
	assert.deepEqual(value.warnings, []);
	assert.deepEqual(calls[0], ['create', { cwd: 'D:\\src\\dsh', agentPreset: 'web-default' }]);
	assert.deepEqual(calls[1], ['rename', { sessionId: 'session-3', title: '插件清单核对' }]);
	assert.equal(calls[2][1].sessionId, 'session-3');
	assert.equal(calls[2][1].mode, 'queue');
	assert.deepEqual(calls[2][1].content, [{ type: 'text', text: '查一下插件' }]);
	assert.match(calls[2][1].requestId, /^new-session-[0-9a-f-]{36}$/);
	// Host 的 prompt(request, signal) 要求必需的 AbortSignal；漏传会以
	// "Cannot read properties of undefined (reading 'throwIfAborted')" 失败。
	assert.ok(calls[2][2] instanceof AbortSignal, 'prompt must receive an AbortSignal');
	assert.equal(calls[2][2], exec.signal, 'prompt must receive the tool call signal');
});

// --- 5. 降级路径：rename / prompt 失败只记警告 ------------------------------
await check('degrades rename and prompt failures to warnings', async () => {
	const tool = loadWith({
		async create() { return { sessionId: 'session-4' }; },
		async rename() { throw new Error('renaming is unavailable: no session-title service'); },
		async prompt() { throw new Error('session/model-unavailable: Select an available model'); }
	});
	const value = await tool.execute({ title: 'x', firstMessage: 'y' }, execWithCwd('D:\\src\\dsh'));
	assert.equal(value.sessionId, 'session-4');
	assert.equal(value.title, undefined);
	assert.equal(value.prompted, false);
	assert.equal(value.warnings.length, 2);
	assert.ok(value.warnings[0].includes('标题设置失败'));
	assert.ok(value.warnings[1].includes('首条消息发送失败'));
	assert.ok(tool.output.render({}, value)[0].text.includes('警告'));
});

// --- 5b. prompt 的非预期失败必须抛出，不得降级 ------------------------------
await check('prompt failure other than model-unavailable is rethrown', async () => {
	const tool = loadWith({
		async create() { return { sessionId: 'session-4b' }; },
		async prompt() { throw new Error("Cannot read properties of undefined (reading 'throwIfAborted')"); }
	});
	await assert.rejects(
		() => tool.execute({ firstMessage: 'y' }, execWithCwd('D:\\src\\dsh')),
		(error) => /会话已创建（session-4b）/.test(error.message) && /throwIfAborted/.test(error.message)
	);
});

// 只带 code 的 RemoteError 形状仍应识别为 model-unavailable 并降级。
await check('prompt failure with only a model-unavailable code degrades', async () => {
	const tool = loadWith({
		async create() { return { sessionId: 'session-4c' }; },
		async prompt() { throw { code: 'session/model-unavailable', message: 'no model' }; }
	});
	const value = await tool.execute({ firstMessage: 'y' }, execWithCwd('D:\\src\\dsh'));
	assert.equal(value.prompted, false);
	assert.equal(value.warnings.length, 1);
});

// --- 6. create 失败必须抛出可读错误 ----------------------------------------
await check('create failure throws a readable error', async () => {
	const tool = loadWith({
		async create() { throw new Error('gateway/bad-request: session.create accepts workspaceId or cwd, not both'); }
	});
	await assert.rejects(
		() => tool.execute({}, execWithCwd('D:\\src\\dsh')),
		/new_session: 创建会话失败：gateway\/bad-request/
	);
});

// --- 7. 非对象参数不崩 -----------------------------------------------------
await check('tolerates non-object args', async () => {
	const tool = loadWith({ async create() { return { sessionId: 'session-5' }; } });
	const value = await tool.execute(null, execWithCwd('D:\\src\\dsh'));
	assert.equal(value.sessionId, 'session-5');
});

// --- 8. 工作区归属：默认继承当前会话所在工作区 -----------------------------

/** Build an exec context whose Session belongs to `sessionId`. */
function execWithSession({ cwd, sessionId }) {
	return {
		callId: 'call-1',
		rootCallId: 'call-1',
		name: 'new_session',
		arguments: {},
		signal: new AbortController().signal,
		agent: { session: { header: { ...(cwd === undefined ? {} : { cwd }), ...(sessionId === undefined ? {} : { id: sessionId }) } } }
	};
}

/** Minimal WorkspaceRegistry stand-in. */
function registryWith(workspaces) {
	return { list: () => workspaces };
}

await check('joins the workspace whose sessionIds contain this session', async () => {
	const requests = [];
	const tool = loadWith(
		{ async create(request) { requests.push(request); return { sessionId: 'session-w1' }; } },
		registryWith([
			{ id: 'ws-other', path: 'D:\\src\\other', sessionIds: ['session-x'] },
			{ id: 'ws-dsh', path: 'D:\\src\\dsh', sessionIds: ['session-current'] }
		])
	);
	const value = await tool.execute({}, execWithSession({ cwd: 'D:\\src\\dsh', sessionId: 'session-current' }));
	assert.deepEqual(requests, [{ workspaceId: 'ws-dsh' }]);
	assert.equal(value.workspaceId, 'ws-dsh');
	assert.equal(value.cwd, 'D:\\src\\dsh');
	assert.ok(tool.output.render({}, value)[0].text.includes('ws-dsh'));
});

await check('falls back to matching the Session cwd against workspace paths', async () => {
	const requests = [];
	const tool = loadWith(
		{ async create(request) { requests.push(request); return { sessionId: 'session-w2' }; } },
		registryWith([{ id: 'ws-dsh', path: 'D:\\src\\dsh', sessionIds: [] }])
	);
	const value = await tool.execute({}, execWithSession({ cwd: 'd:/SRC/dsh/', sessionId: 'session-not-listed' }));
	assert.deepEqual(requests, [{ workspaceId: 'ws-dsh' }]);
	assert.equal(value.workspaceId, 'ws-dsh');
});

await check('explicit cwd inside a workspace joins that workspace', async () => {
	const requests = [];
	const tool = loadWith(
		{ async create(request) { requests.push(request); return { sessionId: 'session-w3' }; } },
		registryWith([{ id: 'ws-dsh', path: 'D:\\src\\dsh', sessionIds: ['session-current'] }])
	);
	const value = await tool.execute({ cwd: 'D:\\src\\dsh' }, execWithSession({ cwd: 'D:\\elsewhere', sessionId: 'session-current' }));
	assert.deepEqual(requests, [{ workspaceId: 'ws-dsh' }]);
	assert.equal(value.workspaceId, 'ws-dsh');
});

await check('explicit cwd outside every workspace keeps plain cwd', async () => {
	const requests = [];
	const tool = loadWith(
		{ async create(request) { requests.push(request); return { sessionId: 'session-w4' }; } },
		registryWith([{ id: 'ws-dsh', path: 'D:\\src\\dsh', sessionIds: ['session-current'] }])
	);
	const value = await tool.execute({ cwd: 'D:\\tmp\\scratch' }, execWithSession({ cwd: 'D:\\src\\dsh', sessionId: 'session-current' }));
	assert.deepEqual(requests, [{ cwd: 'D:\\tmp\\scratch' }]);
	assert.equal(value.workspaceId, undefined);
	assert.equal(value.cwd, 'D:\\tmp\\scratch');
});

await check('no workspaceRegistry keeps the previous cwd behaviour', async () => {
	const requests = [];
	const tool = loadWith({ async create(request) { requests.push(request); return { sessionId: 'session-w5' }; } });
	const value = await tool.execute({}, execWithSession({ cwd: 'D:\\src\\dsh', sessionId: 'session-current' }));
	assert.deepEqual(requests, [{ cwd: 'D:\\src\\dsh' }]);
	assert.equal(value.workspaceId, undefined);
});

await check('workspace membership never sends cwd at the same time', async () => {
	const requests = [];
	const tool = loadWith(
		{ async create(request) { requests.push(request); return { sessionId: 'session-w6' }; } },
		registryWith([{ id: 'ws-dsh', path: 'D:\\src\\dsh', sessionIds: ['session-current'] }])
	);
	await tool.execute({ agentPreset: 'web-default' }, execWithSession({ cwd: 'D:\\src\\dsh', sessionId: 'session-current' }));
	assert.deepEqual(requests, [{ workspaceId: 'ws-dsh', agentPreset: 'web-default' }]);
	assert.equal(Object.hasOwn(requests[0], 'cwd'), false);
});

console.log(`\nall ${passed + 1} checks passed`);
