/**
 * dsh-plugin-ptc-switches — node 半（宿主侧）。
 *
 * 官方 Cordis 插件形态（同 dsh-notify-bell 先例）：导出 name / inject / apply，
 * 经 ctx.inject(['webServer', 'settings'], ...) 在 DSH Web server 上注册 /ptc-switches
 * 前缀端点，供浏览器读写 PTC 子代理开关和 Director 角色参与策略。
 *
 * API：
 *   GET  /ptc-switches          → agents / others / director / routeRevision
 *   POST /ptc-switches/set      → body { key, enabled } → 原子写回 + 备份
 *   POST /ptc-switches/director-set
 *                                → body { roleId, enabled?, tiers?, position?, priority?, expectedRevision? }
 *                                  → 串行读改写 + revision 检查 + 备份
 *
 * 开关事实源：route-config.json 的 subagentRouting.switches（本机人工确认状态，
 * 不入库、不同步）。路径解析：PTC_ROUTE_CONFIG 环境变量 >
 * $DSH_HOME/plugins/provider-failover/route-config.json > ~/.dsh/ 同名路径。
 *
 * 本插件无持久运行时状态：每次请求重新读文件，因此 ptc_switch.py 或其他工具的
 * 外部修改在下次 GET 即反映；写文件采用临时文件 + rename 原子替换，写前留
 * .bak-before-switch-<utc> 备份。不持凭据、不介入模型请求。
 */
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import pkg from './package.json' with { type: 'json' };

export const name = 'ptc-switches';

/** 插件版本（来自 package.json），随 API 返回，便于前端/调试确认运行中的版本。 */
export const PLUGIN_VERSION = pkg.version;

/** 本插件只依赖 webServer 服务（见 apply 内 ctx.inject）。 */
export const inject = [];

/** 解析 route-config.json 路径：显式环境变量 > DSH_HOME > 默认 ~/.dsh。 */
export function resolveConfigPath(env = process.env, home = homedir()) {
	if (typeof env?.PTC_ROUTE_CONFIG === 'string' && env.PTC_ROUTE_CONFIG.length > 0) {
		return env.PTC_ROUTE_CONFIG;
	}
	const base = typeof env?.DSH_HOME === 'string' && env.DSH_HOME.length > 0
		? env.DSH_HOME
		: join(home, '.dsh');
	return join(base, 'plugins', 'provider-failover', 'route-config.json');
}

/** 读取配置；文件缺失返回 null（调用方决定 404 还是空表），非法 JSON 抛错。 */
export function loadConfig(configPath) {
	let text;
	try {
		text = readFileSync(configPath, 'utf8');
	} catch (error) {
		if (error?.code === 'ENOENT') return null;
		throw error;
	}
	const data = JSON.parse(text);
	if (data === null || typeof data !== 'object' || Array.isArray(data)) {
		throw new Error('route-config.json 必须是 JSON object');
	}
	return data;
}

/** 提取 subagentRouting.switches（只认 object 形态；缺失视为无开关）。 */
export function getSwitches(data) {
	const subagent = data?.subagentRouting;
	if (subagent === null || typeof subagent !== 'object' || Array.isArray(subagent)) return {};
	const switches = subagent.switches;
	if (switches === null || typeof switches !== 'object' || Array.isArray(switches)) return {};
	const out = {};
	for (const [key, value] of Object.entries(switches)) {
		if (value !== null && typeof value === 'object' && !Array.isArray(value)) out[key] = value;
	}
	return out;
}

/** 提取 subagentRouting.catalog（只读展示清单；缺失视为空）。 */
export function getCatalog(data) {
	const subagent = data?.subagentRouting;
	if (subagent === null || typeof subagent !== 'object' || Array.isArray(subagent)) return [];
	const catalog = subagent.catalog;
	if (!Array.isArray(catalog)) return [];
	return catalog.filter((e) => e !== null && typeof e === 'object' && !Array.isArray(e) && typeof e.key === 'string');
}

/**
 * 内置「其他可选子代理」回落清单：当前 profile 里已注册、但既未登记
 * switches 也不在 catalog 的子代理工具。仅在 route-config.json 未提供
 * subagentRouting.others 时使用，保证面板不依赖人工同步也能列全。
 * 这些子代理由各自插件/配置注册，本清单**只影响面板文本**，不参与路由。
 */
export const DEFAULT_OTHERS = [
	{ key: 'subagent_fork', label: '继承本会话上下文（fork）' },
	{ key: 'subagent_claude_code', label: 'Claude Code' },
	{ key: 'subagent_opencode', label: 'opencode（ACP）' },
	{ key: 'subagent_kimi', label: 'Kimi（ACP）' }
];

export const DIRECTOR_SETTINGS_NS = 'subagent-director';
export const DIRECTOR_TIERS = ['design', 'execute', 'continuous', 'docs'];

/** PTC 对 Director 角色的参与策略；不复制角色自身 provider/model/persona。 */
export function getDirectorPolicies(data) {
	const subagent = data?.subagentRouting;
	if (subagent === null || typeof subagent !== 'object' || Array.isArray(subagent)) return {};
	const policies = subagent.directorRoles;
	if (policies === null || typeof policies !== 'object' || Array.isArray(policies)) return {};
	return Object.fromEntries(Object.entries(policies).filter(([, value]) => value !== null && typeof value === 'object' && !Array.isArray(value)));
}

export function routeRevision(data) {
	const value = data?.subagentRouting?.revision;
	return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** 从 DSH settings 服务读取 Director 角色；角色内容仍由 Director 单独管理。 */
export function readDirectorNamespace(settings) {
	if (!settings || typeof settings.describe !== 'function') return null;
	const descriptors = settings.describe({ redactSecrets: true });
	if (!Array.isArray(descriptors)) return null;
	return descriptors.find((entry) => entry && entry.ns === DIRECTOR_SETTINGS_NS) ?? null;
}

export function directorRolesView(data, settings) {
	const descriptor = readDirectorNamespace(settings);
	const roles = descriptor?.value?.roles;
	const policies = getDirectorPolicies(data);
	if (roles === null || typeof roles !== 'object' || Array.isArray(roles)) {
		return { available: descriptor !== null, revision: descriptor?.revision ?? 0, roles: [], invalidPolicies: [], stalePolicies: Object.keys(policies).sort() };
	}
	const invalidPolicies = [];
	const view = Object.keys(roles).sort().map((roleId) => {
		const role = roles[roleId];
		const hasPolicy = Object.prototype.hasOwnProperty.call(policies, roleId);
		const policy = policies[roleId] ?? {};
		const tiersValid = Array.isArray(policy.tiers) && policy.tiers.every((tier) => DIRECTOR_TIERS.includes(tier));
		const priorityValid = policy.priority === undefined || (Number.isSafeInteger(policy.priority) && policy.priority >= 0 && policy.priority <= 1000);
		const positionValid = policy.position === undefined || ['preferred', 'fallback'].includes(policy.position);
		const policyValid = !hasPolicy || (typeof policy.enabled === 'boolean' && tiersValid && priorityValid && positionValid);
		if (!policyValid) invalidPolicies.push(roleId);
		const tiers = policyValid && Array.isArray(policy.tiers) ? policy.tiers : [];
		return {
			roleId,
			displayName: typeof role?.displayName === 'string' ? role.displayName : roleId,
			description: typeof role?.description === 'string' ? role.description : '',
			provider: typeof role?.provider === 'string' ? role.provider : '',
			model: typeof role?.model === 'string' ? role.model : '',
			reasoningEffort: typeof role?.reasoningEffort === 'string' ? role.reasoningEffort : '',
			enabled: policyValid && policy.enabled === true,
			tiers,
			priority: policyValid && Number.isSafeInteger(policy.priority) ? policy.priority : 100,
			position: policyValid && policy.position === 'preferred' ? 'preferred' : 'fallback'
		};
	});
	const known = new Set(Object.keys(roles));
	return {
		available: true,
		revision: descriptor?.revision ?? 0,
		roles: view,
		invalidPolicies,
		stalePolicies: Object.keys(policies).filter((id) => !known.has(id)).sort()
	};
}

/**
 * 提取 subagentRouting.others（可选的纯文本清单；缺失视为空数组）。
 * 元素允许两种形态：字符串（即 key）或 { key, label } 对象。
 */
export function getOthers(data) {
	const subagent = data?.subagentRouting;
	if (subagent === null || typeof subagent !== 'object' || Array.isArray(subagent)) return [];
	const others = subagent.others;
	if (!Array.isArray(others)) return [];
	return others.filter((e) => typeof e === 'string' || (e !== null && typeof e === 'object' && !Array.isArray(e) && typeof e.key === 'string'));
}

/**
 * 只读「其他可选子代理」视图：配置提供 others 时以其为准，否则用 DEFAULT_OTHERS。
 * 恒不带 switchable/enabled —— 面板只渲染文本，不接受勾选，也不写回配置。
 */
export function othersView(data) {
	const configured = getOthers(data);
	const source = configured.length > 0 ? configured : DEFAULT_OTHERS;
	return source.map((entry) => {
		const raw = typeof entry === 'string' ? { key: entry } : entry;
		return {
			key: raw.key,
			label: typeof raw.label === 'string' ? raw.label : ''
		};
	});
}

/** 面向前端的开关视图（key 排序，缺省 enabled=true 与路由器口径一致）。 */
export function switchView(switches) {
	return Object.keys(switches).sort().map((key) => {
		const sw = switches[key];
		return {
			key,
			enabled: sw.enabled !== false,
			label: typeof sw.label === 'string' ? sw.label : '',
			routes: Array.isArray(sw.routes) ? sw.routes.filter((r) => typeof r === 'string') : [],
			executors: Array.isArray(sw.executors) ? sw.executors.filter((e) => typeof e === 'string') : []
		};
	});
}

/**
 * 面板完整视图：可勾选项（switches，switchable=true）在前，
 * 只读项（catalog 中 switchable !== true 且未在 switches 定义的）在后，
 * 只读项恒 enabled=true（不受开关机制门控，仅供展示）。catalog 中
 * switchable === true 的条目视为"尚未登记 switches 的可开关项"，
 * 不重复展示（须先人工在 switches 里登记过滤口径才可勾选）。
 */
export function agentsView(data) {
	const switches = switchView(getSwitches(data));
	const switchKeys = new Set(switches.map((s) => s.key));
	const toggleable = switches.map((s) => ({ ...s, switchable: true }));
	const readonly = getCatalog(data)
		.filter((e) => e.switchable !== true && !switchKeys.has(e.key))
		.map((e) => ({
			key: e.key,
			enabled: true,
			label: typeof e.label === 'string' ? e.label : '',
			routes: Array.isArray(e.routes) ? e.routes.filter((r) => typeof r === 'string') : [],
			executors: Array.isArray(e.executors) ? e.executors.filter((x) => typeof x === 'string') : [],
			switchable: false
		}));
	return [...toggleable, ...readonly];
}

function utcStamp(date = new Date()) {
	// 保留毫秒：同秒内的连续开关操作不得互相覆盖备份。形如 20261015T065000123Z。
	return date.toISOString().replace(/[-:.]/g, '');
}

let configWriteLocked = false;

function badRequest(message) {
	const error = new Error(message);
	error.code = 'bad-request';
	return error;
}

function withConfigWriteLock(operation) {
	if (configWriteLocked) {
		const error = new Error('另一项 PTC 路由配置正在写入，请刷新后重试');
		error.code = 'config-busy';
		throw error;
	}
	configWriteLocked = true;
	try {
		return operation();
	} finally {
		configWriteLocked = false;
	}
}

function writeConfigAtomic(configPath, data, backupLabel = 'switch') {
	const backup = `${configPath}.bak-before-${backupLabel}-${utcStamp()}`;
	copyFileSync(configPath, backup);
	mkdirSync(dirname(configPath), { recursive: true });
	const tmp = `${configPath}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
	try {
		renameSync(tmp, configPath);
	} catch (error) {
		try {
			renameSync(tmp, configPath);
		} catch {
			throw error;
		}
	}
	return { backup };
}

/**
 * 原子更新单个开关的 enabled（保留其他所有字段）。
 * - 文件不存在 / 开关 key 未定义 → 抛错且不改动原文件（前端据此回滚）。
 * - 写前复制 .bak-before-switch-<utc毫秒> 备份；写入走同目录临时文件 + rename。
 * @returns {{ backup: string }}
 */
export function setSwitch(configPath, key, enabled) {
	return withConfigWriteLock(() => {
		const data = loadConfig(configPath);
		if (data === null) throw new Error(`route-config.json 不存在: ${configPath}`);
		if (data.subagentRouting === null || typeof data.subagentRouting !== 'object' || Array.isArray(data.subagentRouting)) {
			throw new Error('subagentRouting 必须是 JSON object');
		}
		const switches = getSwitches(data);
		if (!(key in switches)) {
			throw new Error(`未知开关 ${JSON.stringify(key)}；已定义: ${Object.keys(switches).sort().join(', ') || '(无)'}`);
		}
		data.subagentRouting.switches[key].enabled = enabled;
		data.subagentRouting.revision = routeRevision(data) + 1;
		return writeConfigAtomic(configPath, data, 'switch');
	});
}

/** 更新单个 Director 角色的 PTC 参与策略；角色本体仍由 Director settings 管理。 */
export function setDirectorPolicy(configPath, roleId, patch, expectedRevision, settings) {
	return withConfigWriteLock(() => {
		const data = loadConfig(configPath);
		if (data === null) throw new Error(`route-config.json 不存在: ${configPath}`);
		if (data.subagentRouting === null || typeof data.subagentRouting !== 'object' || Array.isArray(data.subagentRouting)) {
			throw new Error('subagentRouting 必须是 JSON object');
		}
		if (
			data.subagentRouting.directorRoles !== undefined
			&& (data.subagentRouting.directorRoles === null || typeof data.subagentRouting.directorRoles !== 'object' || Array.isArray(data.subagentRouting.directorRoles))
		) {
			throw new Error('subagentRouting.directorRoles 必须是 JSON object');
		}
		const currentRevision = routeRevision(data);
		if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
			const error = new Error(`路由配置已更新（期望 revision ${expectedRevision}，当前 ${currentRevision}），请刷新后重试`);
			error.code = 'revision-conflict';
			throw error;
		}
		const director = directorRolesView(data, settings);
		if (!director.roles.some((role) => role.roleId === roleId)) {
			throw badRequest(`未知 Director 角色 ${JSON.stringify(roleId)}；请先在 Subagent Director 中定义`);
		}
		if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') {
			throw badRequest('enabled 必须是 boolean');
		}
		const tiers = patch.tiers;
		if (tiers !== undefined && (!Array.isArray(tiers) || tiers.some((tier) => !DIRECTOR_TIERS.includes(tier)))) {
			throw badRequest(`tiers 只能包含: ${DIRECTOR_TIERS.join(', ')}`);
		}
		if (patch.priority !== undefined && (!Number.isSafeInteger(patch.priority) || patch.priority < 0 || patch.priority > 1000)) {
			throw badRequest('priority 必须是 0..1000 的整数（数值越小越优先）');
		}
		if (patch.position !== undefined && !['preferred', 'fallback'].includes(patch.position)) {
			throw badRequest('position 只能是 preferred 或 fallback');
		}
		data.subagentRouting.directorRoles ??= {};
		const existing = data.subagentRouting.directorRoles[roleId];
		const next = existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...existing } : {};
		if (patch.enabled !== undefined) next.enabled = patch.enabled;
		if (tiers !== undefined) next.tiers = [...new Set(tiers)];
		if (patch.priority !== undefined) next.priority = patch.priority;
		if (patch.position !== undefined) next.position = patch.position;
		data.subagentRouting.directorRoles[roleId] = next;
		data.subagentRouting.revision = currentRevision + 1;
		const { backup } = writeConfigAtomic(configPath, data, 'director-role');
		return { backup, data };
	});
}

export function apply(ctx, config = {}, options = {}) {
	const configPath = options.configPath ?? resolveConfigPath();

	ctx.inject(['webServer', 'settings'], (webCtx) => {
		const readBody = async (req) => {
			const chunks = [];
			for await (const chunk of req) chunks.push(chunk);
			return Buffer.concat(chunks).toString('utf8');
		};
		const json = (res, status, body) => {
			res.writeHead(status, { 'content-type': 'application/json' });
			res.end(JSON.stringify(body));
		};
		const buildValue = (data, extra = {}) => ({
			path: configPath,
			agents: agentsView(data),
			others: othersView(data),
			director: directorRolesView(data, webCtx.settings),
			routeRevision: routeRevision(data),
			...extra
		});
		webCtx.webServer.register({
			kind: 'prefix',
			path: '/ptc-switches',
			handler: async (req, res) => {
				const url = new URL(req.url ?? '/', 'http://ptc-switches');
				const endpoint = url.pathname.replace(/^\/ptc-switches\/?/, '') || 'get';
				try {
					if (endpoint === 'get') {
						if (req.method !== 'GET') return json(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'use GET' } });
						const data = loadConfig(configPath);
						if (data === null) {
							return json(res, 200, { ok: true, value: { path: configPath, agents: [], others: othersView(null), director: directorRolesView(null, webCtx.settings), routeRevision: 0, missing: true }, version: PLUGIN_VERSION });
						}
						return json(res, 200, { ok: true, value: buildValue(data), version: PLUGIN_VERSION });
					}
					if (endpoint === 'set') {
						if (req.method !== 'POST') return json(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'use POST' } });
						let args = {};
						try {
							args = JSON.parse(await readBody(req) || '{}');
						} catch {
							return json(res, 400, { ok: false, error: { code: 'bad-request', message: 'body must be JSON' } });
						}
						if (typeof args.key !== 'string' || typeof args.enabled !== 'boolean') {
							return json(res, 400, { ok: false, error: { code: 'bad-request', message: 'body must be { key: string, enabled: boolean }' } });
						}
						const { backup } = setSwitch(configPath, args.key, args.enabled);
						const data = loadConfig(configPath);
						return json(res, 200, {
							ok: true,
							value: buildValue(data, { backup }),
							version: PLUGIN_VERSION
						});
					}
					if (endpoint === 'director-set') {
						if (req.method !== 'POST') return json(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'use POST' } });
						let args = {};
						try {
							args = JSON.parse(await readBody(req) || '{}');
						} catch {
							return json(res, 400, { ok: false, error: { code: 'bad-request', message: 'body must be JSON' } });
						}
						if (typeof args.roleId !== 'string' || args.roleId.length === 0) {
							return json(res, 400, { ok: false, error: { code: 'bad-request', message: 'body must include roleId' } });
						}
						const { backup, data } = setDirectorPolicy(
							configPath,
							args.roleId,
							{ enabled: args.enabled, tiers: args.tiers, priority: args.priority, position: args.position },
							args.expectedRevision,
							webCtx.settings
						);
						return json(res, 200, { ok: true, value: buildValue(data, { backup }), version: PLUGIN_VERSION });
					}
					return json(res, 404, { ok: false, error: { code: 'not-found', message: `unknown endpoint ${endpoint}` } });
				} catch (error) {
					const code = error?.code;
					const status = code === 'bad-request' ? 400 : (code === 'revision-conflict' || code === 'config-busy' ? 409 : 500);
					return json(res, status, { ok: false, error: { code: code || 'write-failed', message: error instanceof Error ? error.message : String(error) } });
				}
			}
		});
	});

	ctx.logger?.info?.(`[dsh-plugin-ptc-switches] host half mounted, config: ${configPath}`);
}
