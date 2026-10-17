/**
 * dsh-plugin-ptc-switches — 客户端半冒烟（node test/smoke-client.mjs）。
 *
 * 用 vm 沙箱 + 假 react + 假 fetch 真渲染组件，断言「其他可选子代理」是
 * **纯文本**：出现 others 文本、不产生任何 checkbox；并覆盖旧版 host
 * （只有 value.switches、没有 others）的降级路径不得抛错。
 *
 * 退出码 0 / 1（assert 失败即抛）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'client.js'), 'utf8');

//#region 假 react（含最小 hooks 运行时）
let hookIndex = 0;
let hookStates = [];
let hookDeps = [];
let pendingEffects = [];
let dirty = false;

/** 每个组件实例一套全新 hook 存储：否则用例之间会串状态。 */
function resetHooks() {
	hookIndex = 0;
	hookStates = [];
	hookDeps = [];
	pendingEffects = [];
	dirty = false;
}

function useState(initial) {
	const i = hookIndex++;
	if (!(i in hookStates)) hookStates[i] = typeof initial === 'function' ? initial() : initial;
	const set = (next) => {
		hookStates[i] = typeof next === 'function' ? next(hookStates[i]) : next;
		dirty = true;
	};
	return [hookStates[i], set];
}
function useEffect(fn, deps) {
	const i = hookIndex++;
	const previous = hookDeps[i];
	const changed = previous === undefined || deps === undefined
		|| deps.length !== previous.length
		|| deps.some((value, index) => !Object.is(value, previous[index]));
	if (changed) {
		hookDeps[i] = deps;
		pendingEffects.push(fn);
	}
}
function useRef(initial) {
	const i = hookIndex++;
	if (!(i in hookStates)) hookStates[i] = { current: initial };
	return hookStates[i];
}
const react = {
	createElement(type, props, ...children) {
		const merged = Object.assign({}, props);
		if (children.length > 0) merged.children = children.length === 1 ? children[0] : children;
		return { type, props: merged };
	},
	Fragment: 'Fragment',
	useState,
	useEffect,
	useRef
};
//#endregion

//#region 假宿主（window / document / fetch）
const styleSheet = { setAttribute() {}, remove() {}, textContent: '' };
const document = {
	createElement: () => styleSheet,
	head: { append() {} }
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 装配一次沙箱，返回 { Component, setFetch }。 */
function loadClient() {
	resetHooks();
	let captured = null;
	// fetch 由每个用例注入：沙箱是独立 vm context，看不见宿主 globalThis。
	const fetchHolder = { impl: () => Promise.reject(new Error('fetch 未装配')) };
	const sandbox = {
		window: { __ModuleLoader__: { load: (definition) => { captured = definition; } } },
		document,
		console,
		setTimeout,
		JSON,
		Object,
		Array,
		String,
		Promise,
		fetch: (...args) => fetchHolder.impl(...args)
	};
	vm.createContext(sandbox);
	vm.runInContext(source, sandbox, { filename: 'client.js' });
	assert.ok(captured, 'client.js 必须调用 window.__ModuleLoader__.load 注册自己');
	assert.equal(captured.id, 'dsh-plugin-ptc-switches');

	const module = captured.factory((name) => {
		assert.equal(name, 'react', `require 白名单只允许 react，收到 ${name}`);
		return react;
	});
	assert.equal(typeof module.apply, 'function');

	// 捕获 apply 注册的组件
	let Component = null;
	module.apply({
		effect(fn) { fn(); return () => {}; },
		slots: {
			inject(seat, factory) { return factory(); },
			register(spec, component) { Component = component; return () => {}; }
		}
	});
	assert.ok(Component, 'apply 必须注册 header utilities 组件');

	return { Component, module, setFetch: (impl) => { fetchHolder.impl = impl; } };
}

/** 渲染 → 跑 effect → 等微任务 → 反复直到稳定，返回最终元素树。 */
async function renderStable(Component) {
	let tree = null;
	for (let round = 0; round < 12; round++) {
		hookIndex = 0;
		pendingEffects = [];
		dirty = false;
		tree = Component({});
		for (const effect of pendingEffects) effect();
		await tick();
		if (!dirty) return tree;
	}
	throw new Error('渲染未在 12 轮内稳定');
}

function walk(node, visit) {
	if (node === null || node === undefined || typeof node === 'boolean') return;
	if (Array.isArray(node)) { for (const child of node) walk(child, visit); return; }
	if (typeof node !== 'object') return;
	visit(node);
	if (node.props && node.props.children !== undefined) walk(node.props.children, visit);
}

function textOf(node) {
	const parts = [];
	walk(node, (el) => {
		if (typeof el === 'string') parts.push(el);
		else if (typeof el.props?.children === 'string') parts.push(el.props.children);
	});
	return parts.join(' ');
}

function find(node, predicate) {
	let hit = null;
	walk(node, (el) => { if (hit === null && predicate(el)) hit = el; });
	return hit;
}

function countInputs(node) {
	let count = 0;
	walk(node, (el) => { if (el.type === 'input') count += 1; });
	return count;
}

//#region 用例 1：新版 host（含 others）→ 纯文本列出，且不产生 checkbox
const host = loadClient();
const { Component } = host;
let response = {
	ok: true,
	value: {
		path: 'route-config.json',
		agents: [
			{ key: 'gpt-official', enabled: true, label: 'GPT 官网', routes: ['openai-codex'], executors: ['subagent_codex'], switchable: true },
			{ key: 'codex-astra', enabled: true, label: 'Astra 设计', routes: [], executors: ['subagent_codex_astra'], switchable: false }
		],
		others: [
			{ key: 'subagent_fork', label: '继承本会话上下文（fork）' },
			{ key: 'subagent_claude_code', label: 'Claude Code' },
			{ key: 'subagent_opencode', label: 'opencode（ACP）' },
			{ key: 'subagent_kimi', label: 'Kimi（ACP）' }
		],
		director: {
			available: true,
			roles: [{
				roleId: 'code-reviewer', displayName: 'Code Reviewer', provider: 'codex-relay', model: 'gpt-5.6-sol',
				reasoningEffort: 'high', enabled: true, tiers: ['execute'], priority: 40, position: 'fallback'
			}],
			stalePolicies: []
		},
		routeRevision: 3
	}
};
globalThis.fetch = undefined; // 沙箱只认注入的 fetch，这里避免误用宿主实现
host.setFetch(() => Promise.resolve({ json: () => Promise.resolve(response) }));

let tree = await renderStable(Component);

// 关闭态：不渲染弹层
assert.equal(find(tree, (el) => el.props?.className === 'ptcsw-popover'), null, '关闭时不得渲染弹层');

const button = find(tree, (el) => el.type === 'button');
assert.ok(button, '必须有触发按钮');
button.props.onClick();
tree = await renderStable(Component);

const popover = find(tree, (el) => el.props?.className === 'ptcsw-popover');
assert.ok(popover, '打开后必须渲染弹层');

const othersBlock = find(tree, (el) => el.props?.className === 'ptcsw-others');
assert.ok(othersBlock, '必须渲染「其他可选子代理」文本区块');

const othersText = textOf(othersBlock);
for (const key of ['subagent_fork', 'subagent_claude_code', 'subagent_opencode', 'subagent_kimi']) {
	assert.ok(othersText.includes(key), `others 文本必须列出 ${key}，实际: ${othersText}`);
}
assert.ok(othersText.includes('继承本会话上下文'), 'others 文本必须带上 label');
assert.ok(othersText.includes('其他可选子代理'), 'others 区块必须有标题');

// 硬契约：others 区块内不得出现任何 input（只列不勾）
assert.equal((() => {
	let count = 0;
	walk(othersBlock, (el) => { if (el.type === 'input') count += 1; });
	return count;
})(), 0, 'others 区块不得渲染 checkbox');

const directorBlock = find(tree, (el) => el.props?.className === 'ptcsw-director');
assert.ok(directorBlock, 'Director 已安装且有角色时必须渲染参与策略区');
const directorText = textOf(directorBlock);
assert.ok(directorText.includes('Code Reviewer'));
assert.ok(directorText.includes('codex-relay / gpt-5.6-sol / high'));
assert.ok(find(directorBlock, (el) => el.props?.className === 'ptcsw-priority'), '必须渲染优先级输入');
assert.ok(find(directorBlock, (el) => el.props?.className === 'ptcsw-position'), '必须渲染首选/后备位置选择器');

// 全弹层 input 数 = 2 个 agent + Director 的启用、4 个 tier、1 个优先级。
assert.equal(countInputs(popover), 8, 'Director 角色应增加启用、层级和优先级控件');
//#endregion

//#region 用例 2：旧版 host（只有 value.switches）→ 容忍降级，不渲染 others、不抛错
const legacy = loadClient();
legacy.setFetch(() => Promise.resolve({
	json: () => Promise.resolve({
		ok: true,
		value: { switches: [{ key: 'gpt-official', enabled: false, label: 'GPT 官网' }] }
	})
}));
let legacyTree = await renderStable(legacy.Component);
find(legacyTree, (el) => el.type === 'button').props.onClick();
legacyTree = await renderStable(legacy.Component);
assert.ok(find(legacyTree, (el) => el.props?.className === 'ptcsw-popover'), '旧版 host 也要能打开弹层');
assert.equal(find(legacyTree, (el) => el.props?.className === 'ptcsw-others'), null, '旧版 host 无 others 时整段不渲染');
//#endregion

//#region 用例 3：others 缺失但 agents 在（部分升级中间态）
const partial = loadClient();
partial.setFetch(() => Promise.resolve({
	json: () => Promise.resolve({
		ok: true,
		value: { agents: [{ key: 'gpt-official', enabled: true, label: '', switchable: true }] }
	})
}));
let partialTree = await renderStable(partial.Component);
find(partialTree, (el) => el.type === 'button').props.onClick();
partialTree = await renderStable(partial.Component);
assert.equal(find(partialTree, (el) => el.props?.className === 'ptcsw-others'), null, 'others 缺失时整段不渲染');
assert.equal(countInputs(partialTree), 1, 'agents 仍正常渲染');
//#endregion

console.log('client smoke ok: others 纯文本渲染 / 零 checkbox / 旧版 host 降级 全部通过');
