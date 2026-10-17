/**
 * dsh-plugin-ptc-switches — host 半冒烟测试（node test/smoke.mjs）。
 *
 * 覆盖：路径解析、读取/视图、只读纯文本清单（others，含内置回落）、
 * setSwitch 原子写回与备份、未知 key 拒绝、HTTP 处理器 GET/set 全流程
 * （mock webServer + mock req/res）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { DEFAULT_OTHERS, apply, agentsView, directorRolesView, getDirectorPolicies, getOthers, getSwitches, loadConfig, othersView, resolveConfigPath, routeRevision, setDirectorPolicy, setSwitch, switchView } from '../index.js';

const tmp = mkdtempSync(join(tmpdir(), 'ptc-switches-'));
const configPath = join(tmp, 'plugins', 'provider-failover', 'route-config.json');
mkdirSync(dirname(configPath), { recursive: true });

const seed = {
	schemaVersion: 1,
	subagentRouting: {
		revision: 3,
		directorRoles: {
			'code-reviewer': { enabled: true, tiers: ['execute'], priority: 40 }
		},
		switches: {
			'gpt-official': { enabled: true, label: 'GPT 官网', routes: ['openai-codex'], executors: ['subagent_codex'] },
			'opus-review': { enabled: true, label: 'Opus 复核', routes: ['design-opus55'], executors: ['subagent_claude_opus55_plan'] }
		},
		catalog: [
			{ key: 'codex-astra', label: 'Astra 设计', executors: ['subagent_codex_astra'], switchable: false },
			{ key: 'kimi-docs', label: 'Kimi 文档', executors: ['subagent_kimi_docs'], switchable: false },
			{ key: 'gpt-official', label: '不应重复展示', executors: ['subagent_codex'], switchable: false }
		],
		others: ['subagent_fork', { key: 'subagent_kimi', label: 'Kimi（ACP）' }],
		design: { fuzzy: 'astra->gpt->ds' }
	}
};
writeFileSync(configPath, JSON.stringify(seed, null, 2) + '\n');

const settings = {
	describe() {
		return [{
			ns: 'subagent-director',
			revision: 7,
			value: {
				roles: {
					'code-reviewer': {
						displayName: 'Code Reviewer',
						description: 'Review defects and regressions',
						provider: 'codex-relay',
						model: 'gpt-5.6-sol',
						reasoningEffort: 'high'
					},
					'docs-writer': { displayName: 'Docs Writer', description: 'Write docs' }
				}
			}
		}];
	}
};

// 1. 路径解析
assert.equal(resolveConfigPath({ PTC_ROUTE_CONFIG: '/x/rc.json' }), '/x/rc.json');
assert.equal(resolveConfigPath({ DSH_HOME: '/x/dsh' }), join('/x/dsh', 'plugins', 'provider-failover', 'route-config.json'));

// 2. 读取 + 视图：switches 在前可勾选，catalog 只读在后，与 switches 同 key 的不重复
const data = loadConfig(configPath);
const view = switchView(getSwitches(data));
assert.deepEqual(view.map((s) => s.key), ['gpt-official', 'opus-review']);
assert.ok(view.every((s) => s.enabled === true));
const agents = agentsView(data);
assert.deepEqual(agents.map((a) => a.key), ['gpt-official', 'opus-review', 'codex-astra', 'kimi-docs']);
assert.deepEqual(agents.map((a) => a.switchable), [true, true, false, false]);
assert.ok(agents.filter((a) => !a.switchable).every((a) => a.enabled === true));

// 2b. 纯文本清单：配置 others 优先（字符串与 { key, label } 两形态都接受），
//     且恒不带 switchable/enabled —— 面板据此不渲染 checkbox。
const others = othersView(data);
assert.deepEqual(others.map((o) => o.key), ['subagent_fork', 'subagent_kimi']);
assert.equal(others[0].label, '');
assert.equal(others[1].label, 'Kimi（ACP）');
assert.ok(others.every((o) => o.switchable === undefined && o.enabled === undefined));
assert.equal(getOthers(data).length, 2);

// 2d. Director 角色由 settings 提供，PTC 文件只保存 enabled/tiers/priority。
const director = directorRolesView(data, settings);
assert.equal(director.available, true);
assert.equal(director.revision, 7);
assert.deepEqual(director.roles.map((r) => r.roleId), ['code-reviewer', 'docs-writer']);
assert.equal(director.roles[0].enabled, true);
assert.deepEqual(director.roles[0].tiers, ['execute']);
assert.equal(director.roles[0].provider, 'codex-relay');
assert.equal(director.roles[1].enabled, false);
assert.equal(routeRevision(data), 3);
assert.deepEqual(getDirectorPolicies(data)['code-reviewer'], { enabled: true, tiers: ['execute'], priority: 40 });
const invalidDirector = directorRolesView({ subagentRouting: { directorRoles: {
	'code-reviewer': { enabled: true, tiers: ['execute', 'other'], priority: 40 }
} } }, settings);
assert.equal(invalidDirector.roles[0].enabled, false);
assert.deepEqual(invalidDirector.invalidPolicies, ['code-reviewer']);

// 2c. 未配置 others 时回落到内置清单（新装机器也能列全）
const fallbackPath = join(tmp, 'fallback', 'plugins', 'provider-failover', 'route-config.json');
mkdirSync(dirname(fallbackPath), { recursive: true });
writeFileSync(fallbackPath, JSON.stringify({ subagentRouting: { switches: {} } }, null, 2) + '\n');
assert.deepEqual(othersView(loadConfig(fallbackPath)), DEFAULT_OTHERS);
assert.ok(DEFAULT_OTHERS.length > 0 && DEFAULT_OTHERS.every((o) => typeof o.key === 'string'));

const corruptPath = join(tmp, 'corrupt', 'plugins', 'provider-failover', 'route-config.json');
mkdirSync(dirname(corruptPath), { recursive: true });
writeFileSync(corruptPath, JSON.stringify({ subagentRouting: { revision: 0, switches: {}, directorRoles: [] } }, null, 2) + '\n');
assert.throws(
	() => setDirectorPolicy(corruptPath, 'code-reviewer', { enabled: true }, 0, settings),
	/directorRoles 必须是 JSON object/
);
assert.ok(Array.isArray(loadConfig(corruptPath).subagentRouting.directorRoles));

// 3. setSwitch：关闭 opus-review → 备份产生、其他字段保留、原子生效
const { backup } = setSwitch(configPath, 'opus-review', false);
assert.ok(existsSync(backup));
const after = loadConfig(configPath);
assert.equal(after.subagentRouting.switches['opus-review'].enabled, false);
assert.equal(after.subagentRouting.switches['gpt-official'].enabled, true);
assert.equal(after.subagentRouting.design.fuzzy, 'astra->gpt->ds');
assert.equal(routeRevision(after), 4);

// 3b. Director 策略只更新 PTC 参与字段并递增 revision。
const directorWrite = setDirectorPolicy(configPath, 'docs-writer', { enabled: true, tiers: ['docs'], priority: 60, position: 'preferred' }, 4, settings);
assert.ok(existsSync(directorWrite.backup));
const afterDirector = loadConfig(configPath);
assert.equal(routeRevision(afterDirector), 5);
assert.deepEqual(afterDirector.subagentRouting.directorRoles['docs-writer'], { enabled: true, tiers: ['docs'], priority: 60, position: 'preferred' });
assert.equal(JSON.stringify(afterDirector).includes('Write docs'), false, 'route-config 不得复制 Director description');
assert.throws(() => setDirectorPolicy(configPath, 'docs-writer', { enabled: false }, 4, settings), /已更新/);
assert.throws(() => setDirectorPolicy(configPath, 'missing-role', { enabled: true }, 5, settings), /未知 Director 角色/);

// 4. 未知 key 拒绝且不改动文件
assert.throws(() => setSwitch(configPath, 'bogus', true), /未知开关/);
assert.equal(loadConfig(configPath).subagentRouting.switches['gpt-official'].enabled, true);

// 5. HTTP 处理器全流程（mock webServer）
let handler = null;
const fakeCtx = {
	inject(services, fn) {
		assert.deepEqual(services, ['webServer', 'settings']);
		fn({ settings, webServer: { register(spec) { assert.equal(spec.kind, 'prefix'); assert.equal(spec.path, '/ptc-switches'); handler = spec.handler; } } });
	},
	logger: { info() {} }
};
apply(fakeCtx, {}, { configPath });
assert.ok(handler, 'handler registered');

function mockReq(method, url, body) {
	const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
	req.method = method;
	req.url = url;
	return req;
}
function mockRes() {
	return {
		status: null,
		body: null,
		writeHead(status) { this.status = status; },
		end(text) { this.body = text ? JSON.parse(text) : null; }
	};
}

const resGet = mockRes();
await handler(mockReq('GET', '/ptc-switches'), resGet);
assert.equal(resGet.status, 200);
assert.equal(resGet.body.ok, true);
assert.equal(resGet.body.value.agents.find((s) => s.key === 'opus-review').enabled, false);
assert.equal(resGet.body.value.agents.find((s) => s.key === 'codex-astra').switchable, false);
assert.deepEqual(resGet.body.value.others.map((o) => o.key), ['subagent_fork', 'subagent_kimi']);
assert.equal(resGet.body.value.others[0].switchable, undefined);
assert.equal(resGet.body.value.director.available, true);
assert.equal(resGet.body.value.director.roles.length, 2);
assert.equal(resGet.body.value.routeRevision, 5);

const resSet = mockRes();
await handler(mockReq('POST', '/ptc-switches/set', { key: 'gpt-official', enabled: false }), resSet);
assert.equal(resSet.status, 200);
assert.equal(resSet.body.ok, true);
assert.equal(resSet.body.value.agents.find((s) => s.key === 'gpt-official').enabled, false);
assert.ok(Array.isArray(resSet.body.value.others));
assert.equal(resSet.body.value.routeRevision, 6);

const resDirector = mockRes();
await handler(mockReq('POST', '/ptc-switches/director-set', {
	roleId: 'code-reviewer',
	enabled: false,
	tiers: ['design', 'execute'],
	priority: 20,
	position: 'preferred',
	expectedRevision: 6
}), resDirector);
assert.equal(resDirector.status, 200);
assert.equal(resDirector.body.ok, true);
assert.equal(resDirector.body.value.routeRevision, 7);
const reviewerView = resDirector.body.value.director.roles.find((r) => r.roleId === 'code-reviewer');
assert.equal(reviewerView.enabled, false);
assert.deepEqual(reviewerView.tiers, ['design', 'execute']);
assert.equal(reviewerView.priority, 20);
assert.equal(reviewerView.position, 'preferred');

const resConflict = mockRes();
await handler(mockReq('POST', '/ptc-switches/director-set', {
	roleId: 'code-reviewer', enabled: true, expectedRevision: 6
}), resConflict);
assert.equal(resConflict.status, 409);
assert.equal(resConflict.body.error.code, 'revision-conflict');

const resInvalidDirector = mockRes();
await handler(mockReq('POST', '/ptc-switches/director-set', {
	roleId: 'code-reviewer', enabled: 'false', expectedRevision: 7
}), resInvalidDirector);
assert.equal(resInvalidDirector.status, 400);
assert.equal(resInvalidDirector.body.error.code, 'bad-request');
assert.equal(routeRevision(loadConfig(configPath)), 7);

const resBad = mockRes();
await handler(mockReq('POST', '/ptc-switches/set', { key: 'bogus', enabled: true }), resBad);
assert.equal(resBad.status, 500);
assert.equal(resBad.body.ok, false);

const res404 = mockRes();
await handler(mockReq('GET', '/ptc-switches/nope'), res404);
assert.equal(res404.status, 404);

// 6. 备份文件存在且内容可解析
const backups = readdirSync(dirname(configPath)).filter((f) => f.includes('.bak-before-switch-'));
assert.ok(backups.length >= 2, `expected >=2 backups, got ${backups.length}`);
JSON.parse(readFileSync(join(dirname(configPath), backups[0]), 'utf8'));

console.log('smoke ok: resolve/load/view/set/http/backup all pass');
