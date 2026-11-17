/**
 * dsh-plugin-session-id — 客户端半冒烟（node test/smoke-client.mjs）。
 *
 * 用 vm 沙箱 + 假 react + 假剪贴板真渲染组件，覆盖：
 *   1. 未挂会话 ID 时不渲染任何东西；
 *   2. 执行器会话（worker-<ticketId>）弹出完整 ID + 工单 ID，可分别复制；
 *   3. 普通会话只给会话 ID，不显示工单行；
 *   4. Clipboard API 不可用时退回 textarea + execCommand；
 *   5. 弹层定位（下方 / 上方 / 视口夹取）与 `worker-` 解析是纯函数；
 *   6. apply 只在 conversation.session.header.actions 席位登记，且 inject 仅含 slots。
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

//#region 假宿主（window / document / navigator）
function makeHost() {
	const copied = [];
	const appended = [];
	const removed = [];
	const execCommand = { value: true, calls: 0 };
	const doc = {
		addEventListener() {},
		removeEventListener() {},
		execCommand() {
			execCommand.calls += 1;
			return execCommand.value;
		},
		head: { append() {} },
		body: {
			appendChild(node) { appended.push(node); },
			removeChild(node) { removed.push(node); }
		},
		createElement(tag) {
			return {
				tagName: String(tag).toUpperCase(),
				attributes: {},
				style: {},
				value: '',
				setAttribute(name, value) { this.attributes[name] = value; },
				select() { this.selected = true; },
				remove() {}
			};
		}
	};
	const nav = {
		clipboard: {
			writeText(value) {
				copied.push(value);
				return Promise.resolve();
			}
		}
	};
	return { doc, nav, copied, appended, removed, execCommand };
}
//#endregion

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 装配一次沙箱，返回 { Component, module, host }。 */
function loadClient() {
	resetHooks();
	const host = makeHost();
	let captured = null;
	const sandbox = {
		window: {
			innerWidth: 1440,
			innerHeight: 900,
			addEventListener() {},
			removeEventListener() {},
			__ModuleLoader__: { load: (definition) => { captured = definition; } }
		},
		document: host.doc,
		navigator: host.nav,
		console,
		setTimeout,
		clearTimeout,
		JSON,
		Math,
		Object,
		Array,
		String,
		Promise
	};
	vm.createContext(sandbox);
	vm.runInContext(source, sandbox, { filename: 'client.js' });
	assert.ok(captured, 'client.js 必须调用 window.__ModuleLoader__.load 注册自己');
	assert.equal(captured.id, 'dsh-plugin-session-id');

	const registry = [];
	const module = captured.factory((name) => {
		assert.equal(name, 'react', `require 白名单只允许 react，收到 ${name}`);
		return react;
	});
	assert.equal(typeof module.apply, 'function');
	// vm 沙箱的 Array 属于另一个 realm，不能 deepEqual 比较；按内容断言。
	assert.equal(module.inject.length, 1);
	assert.equal(module.inject[0], 'slots');
	module.apply({
		effect(fn) { fn(); return () => {}; },
		slots: {
			inject(seat, factory) { return factory(); },
			register(spec, component) { registry.push({ spec, component }); return () => {}; }
		}
	});
	assert.equal(registry.length, 1, 'apply 必须且只能登记一个席位组件');
	assert.equal(registry[0].spec.name, 'conversation.session.header.actions');
	assert.equal(registry[0].spec.id, 'session-id');
	assert.equal(registry[0].spec.order, 15);
	return { Component: registry[0].component, module, host };
}

/** 渲染 → 跑 effect → 等微任务 → 反复直到稳定，返回最终元素树。 */
async function renderStable(Component, props) {
	let tree = null;
	for (let round = 0; round < 12; round += 1) {
		hookIndex = 0;
		pendingEffects = [];
		dirty = false;
		tree = Component(props);
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

function find(node, predicate) {
	let hit = null;
	walk(node, (el) => { if (hit === null && predicate(el)) hit = el; });
	return hit;
}

function all(node, predicate) {
	const hits = [];
	walk(node, (el) => { if (predicate(el)) hits.push(el); });
	return hits;
}

function textOf(node) {
	const parts = [];
	walk(node, (el) => {
		if (typeof el === 'string') parts.push(el);
		else if (el && el.props && typeof el.props.children === 'string') parts.push(el.props.children);
	});
	return parts.join(' ');
}

//#region 纯函数
{
	const { module } = loadClient();
	const t = module.__test;
	assert.equal(t.ticketOf('worker-61d11e10af1367676088076ee48f4680'), '61d11e10af1367676088076ee48f4680');
	assert.equal(t.ticketOf('worker-'), '', 'worker- 后没有工单 ID 时不得给出空工单');
	assert.equal(t.ticketOf('session-abc'), '', '非执行器会话没有工单 ID');
	assert.equal(t.ticketOf(undefined), '');

	const below = t.placePopover({ left: 100, top: 40, bottom: 64 }, { width: 1440, height: 900 });
	assert.equal(below.left, 100);
	assert.equal(below.top, 70);
	const clamped = t.placePopover({ left: 1400, top: 40, bottom: 64 }, { width: 1440, height: 900 });
	assert.equal(clamped.left, 1440 - 360 - 8, '靠右时弹层必须夹回视口');
	const above = t.placePopover({ left: 100, top: 500, bottom: 900 }, { width: 1440, height: 900 });
	assert.equal(above.top, 500 - 6 - 208, '下方放不下时翻到上方');
	const tiny = t.placePopover({ left: 0, top: 10, bottom: 890 }, { width: 320, height: 300 });
	assert.equal(tiny.left, 8);
	assert.equal(tiny.top, Math.max(8, 300 - 208 - 8));
}
//#endregion

//#region 用例 1：没有 sessionId → 不渲染
{
	const { Component } = loadClient();
	assert.equal(Component({}), null, '没有 sessionId 时必须不渲染，避免出现空按钮');
	assert.equal(Component({ sessionId: '' }), null);
	assert.equal(Component({ sessionId: 42 }), null);
}
//#endregion

//#region 用例 2：执行器会话 → 完整 ID + 工单 ID + 两个复制按钮
{
	const { Component, host } = loadClient();
	const SESSION = 'worker-61d11e10af1367676088076ee48f4680';
	const TICKET = '61d11e10af1367676088076ee48f4680';
	let tree = await renderStable(Component, { sessionId: SESSION });

	const trigger = find(tree, (el) => el && el.props && el.props['data-session-id-trigger'] === true);
	assert.ok(trigger, '必须渲染「会话 ID」触发按钮');
	assert.equal(trigger.props.type, 'button');
	assert.equal(trigger.props['aria-expanded'], 'false');
	assert.ok(trigger.props.title.includes(SESSION), '按钮 tooltip 必须带完整 ID');
	assert.equal(find(tree, (el) => el && el.props && el.props['data-session-id-panel']), null, '未点击时不得渲染弹层');

	trigger.props.onClick();
	tree = await renderStable(Component, { sessionId: SESSION });

	const panel = find(tree, (el) => el && el.props && el.props['data-session-id-panel'] === true);
	assert.ok(panel, '点击后必须渲染弹层');
	const value = find(panel, (el) => el && el.props && el.props['data-session-id-value'] === true);
	assert.equal(textOf(value), SESSION, '弹层必须显示完整会话 ID');
	assert.ok(textOf(panel).includes(TICKET), '执行器会话必须显示 SuperAgent 工单 ID');
	assert.equal(textOf(find(tree, (el) => el && el.props && el.props['data-session-id-trigger'])).trim(), '会话 ID');

	const copyId = find(panel, (el) => el && el.props && el.props['data-session-id-copy'] === true);
	const copyTicket = find(panel, (el) => el && el.props && el.props['data-session-id-copy-ticket'] === true);
	assert.ok(copyId, '必须有复制会话 ID 按钮');
	assert.ok(copyTicket, '执行器会话必须有复制工单 ID 按钮');

	copyId.props.onClick();
	tree = await renderStable(Component, { sessionId: SESSION });
	assert.deepEqual(host.copied, [SESSION], '复制会话 ID 必须写入完整 ID');
	assert.ok(textOf(tree).includes('已复制'), '复制成功后必须给出可见反馈');

	copyTicket.props.onClick();
	tree = await renderStable(Component, { sessionId: SESSION });
	assert.deepEqual(host.copied, [SESSION, TICKET], '复制工单 ID 必须只写工单 ID');
}
//#endregion

//#region 用例 3：普通会话 → 没有工单行，只有复制会话 ID
{
	const { Component } = loadClient();
	let tree = await renderStable(Component, { sessionId: '8f3a2b1c-0d4e-4f5a-9b6c-7d8e9f0a1b2c' });
	find(tree, (el) => el && el.props && el.props['data-session-id-trigger'] === true).props.onClick();
	tree = await renderStable(Component, { sessionId: '8f3a2b1c-0d4e-4f5a-9b6c-7d8e9f0a1b2c' });
	const panel = find(tree, (el) => el && el.props && el.props['data-session-id-panel'] === true);
	assert.ok(panel);
	assert.equal(find(panel, (el) => el && el.props && el.props['data-session-id-ticket']), null, '普通会话不得出现工单行');
	assert.equal(find(panel, (el) => el && el.props && el.props['data-session-id-copy-ticket']), null);
	assert.ok(textOf(panel).includes('8f3a2b1c-0d4e-4f5a-9b6c-7d8e9f0a1b2c'));
}
//#endregion

//#region 用例 4：Clipboard API 不可用 → textarea + execCommand 回退
{
	const { Component, host } = loadClient();
	host.nav.clipboard = undefined;
	let tree = await renderStable(Component, { sessionId: 'plain-session' });
	find(tree, (el) => el && el.props && el.props['data-session-id-trigger'] === true).props.onClick();
	tree = await renderStable(Component, { sessionId: 'plain-session' });
	find(tree, (el) => el && el.props && el.props['data-session-id-copy'] === true).props.onClick();
	tree = await renderStable(Component, { sessionId: 'plain-session' });

	assert.equal(host.execCommand.calls, 1, 'Clipboard API 缺失时必须走 execCommand 回退');
	assert.equal(host.appended.length, 1, '回退必须插入一个临时 textarea');
	assert.equal(host.appended[0].value, 'plain-session', 'textarea 必须带上待复制文本');
	assert.equal(host.appended[0].attributes.readonly, '', 'textarea 必须只读');
	assert.equal(host.removed.length, 1, '复制后必须移除临时 textarea');
	assert.ok(textOf(tree).includes('已复制'));
}
//#endregion

//#region 用例 5：回退失败 → 提示手动复制，不假装成功
{
	const { Component, host } = loadClient();
	host.nav.clipboard = undefined;
	host.execCommand.value = false;
	let tree = await renderStable(Component, { sessionId: 'plain-session' });
	find(tree, (el) => el && el.props && el.props['data-session-id-trigger'] === true).props.onClick();
	tree = await renderStable(Component, { sessionId: 'plain-session' });
	find(tree, (el) => el && el.props && el.props['data-session-id-copy'] === true).props.onClick();
	tree = await renderStable(Component, { sessionId: 'plain-session' });
	assert.ok(textOf(tree).includes('复制失败'), '复制失败必须如实提示');
	assert.equal(host.removed.length, 1, '失败路径也必须清理临时 textarea');
}
//#endregion

console.log('client smoke ok: 会话 ID 展示 / 工单 ID 解析 / 复制成功与失败回退 全部通过');
process.exit(0);
