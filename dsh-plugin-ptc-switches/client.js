/**
 * dsh-plugin-ptc-switches — 客户端半（client.js）
 *
 * 在会话头部 `conversation.session.header.utilities` 席位（铃铛旁）注册
 * 「PTC 开关」按钮；点击展开弹层，以 checkbox 列出 route-config.json
 * subagentRouting.switches 的全部人工开关（如 gpt-official / opus-review），
 * 勾选即 POST /ptc-switches/set 写回本机路由层；失败时回滚勾选并显示错误。
 * 弹层底部另有一段**纯文本**「其他可选子代理」清单（host 半 value.others）：
 * 只列出、无 checkbox、不参与写回，用于把未登记开关的子代理也一并交代清楚。
 *
 * 数据全部为宿主自报（/ptc-switches 端点由本插件 host 半注册）；本文件不发
 * 任何其他请求、不读会话内容、不持凭据。
 *
 * 交付形状是硬契约：dsh 把每个插件的 client.js 当 classic script 拼进单个
 * /plugins 响应执行 —— 本文件必须保持 CJS + window.__ModuleLoader__.load
 * 包装，不得出现模块级 import/export；require 白名单只有 react（先例：
 * dsh-plugin-provider-badge / dsh-plugin-subagent-monitor / dsh-notify-bell）。
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-ptc-switches",
	factory: function (require) {
		var module = { exports: {} };
		var exports = module.exports;

		var react = require("react");
		var h = react.createElement;
		var useEffect = react.useEffect;
		var useState = react.useState;

		//#region 样式（shell 设计变量优先，缺失时回落常量）
		var STYLE_CSS = [
			".ptcsw-button{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border:1px solid var(--dsw-alias-border-primary,#d0d7de);border-radius:6px;background:transparent;color:var(--dsw-alias-text-secondary,#57606a);font-size:12px;line-height:20px;cursor:pointer}",
			".ptcsw-button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(208,215,222,.32))}",
			".ptcsw-button[data-off=true]{color:var(--dsw-alias-state-warning-primary,#9a6700);border-color:var(--dsw-alias-state-warning-primary,#9a6700)}",
			".ptcsw-backdrop{position:fixed;inset:0;z-index:1000}",
			".ptcsw-popover{position:fixed;z-index:1001;min-width:280px;max-width:360px;max-height:70vh;overflow:auto;padding:8px;border:1px solid var(--dsw-alias-border-primary,#d0d7de);border-radius:8px;background:var(--dsw-alias-bg-primary,#fff);box-shadow:0 8px 24px rgba(0,0,0,.18);font-size:12px;color:var(--dsw-alias-text-primary,#1f2328)}",
			".ptcsw-title{margin:2px 6px 6px;font-weight:600}",
			".ptcsw-row{display:flex;align-items:flex-start;gap:8px;padding:6px;border-radius:6px;cursor:pointer}",
			".ptcsw-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(208,215,222,.32))}",
			".ptcsw-row-readonly{cursor:default;opacity:.75}",
			".ptcsw-row-readonly:hover{background:transparent}",
			".ptcsw-fixed{margin-left:6px;padding:0 5px;border:1px solid var(--dsw-alias-border-primary,#d0d7de);border-radius:4px;font-size:10px;color:var(--dsw-alias-text-tertiary,#8c959f)}",
			".ptcsw-row[data-pending=true]{opacity:.6;pointer-events:none}",
			".ptcsw-row input{margin:2px 0 0;accent-color:var(--dsw-alias-brand-primary,#2f6feb)}",
			".ptcsw-key{font-weight:600}",
			".ptcsw-label{color:var(--dsw-alias-text-secondary,#57606a)}",
			".ptcsw-meta{color:var(--dsw-alias-text-tertiary,#8c959f);font-size:11px}",
			".ptcsw-error{margin:6px 6px 2px;color:var(--dsw-alias-state-error-primary,#cf222e)}",
			".ptcsw-others{margin:8px 6px 2px;padding-top:6px;border-top:1px solid var(--dsw-alias-border-primary,#d0d7de)}",
			".ptcsw-others-title{margin-bottom:4px;color:var(--dsw-alias-text-tertiary,#8c959f);font-size:11px}",
			".ptcsw-other-row{padding:1px 0;color:var(--dsw-alias-text-secondary,#57606a);font-size:11px;line-height:16px}",
			".ptcsw-director{margin:8px 6px 2px;padding-top:6px;border-top:1px solid var(--dsw-alias-border-primary,#d0d7de)}",
			".ptcsw-director-title{margin-bottom:4px;font-weight:600}",
			".ptcsw-director-row{padding:6px 0;border-bottom:1px solid var(--dsw-alias-border-muted,#eaeef2)}",
			".ptcsw-director-head{display:flex;align-items:flex-start;gap:7px}",
			".ptcsw-director-head input{margin:2px 0 0;accent-color:var(--dsw-alias-brand-primary,#2f6feb)}",
			".ptcsw-director-fields{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:5px 0 0 22px;color:var(--dsw-alias-text-tertiary,#8c959f);font-size:10px}",
			".ptcsw-tier{display:inline-flex;align-items:center;gap:3px;white-space:nowrap}",
			".ptcsw-priority{width:52px;height:22px;padding:0 4px;border:1px solid var(--dsw-alias-border-primary,#d0d7de);border-radius:4px;background:var(--dsw-alias-bg-primary,#fff);color:inherit;font-size:11px}",
			".ptcsw-position{height:22px;padding:0 4px;border:1px solid var(--dsw-alias-border-primary,#d0d7de);border-radius:4px;background:var(--dsw-alias-bg-primary,#fff);color:inherit;font-size:11px}",
			".ptcsw-foot{margin:6px 6px 2px;color:var(--dsw-alias-text-tertiary,#8c959f);font-size:11px}"
		].join("\n");
		//#endregion

		//#region Web → backend HTTP API（host 半注册于同一 web server）
		function swGet() {
			return fetch("/ptc-switches").then(function (res) { return res.json(); });
		}
		function swSet(key, enabled) {
			return fetch("/ptc-switches/set", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ key: key, enabled: enabled })
			}).then(function (res) { return res.json(); });
		}
		function directorSet(role, patch, expectedRevision) {
			return fetch("/ptc-switches/director-set", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(Object.assign({ roleId: role.roleId, expectedRevision: expectedRevision }, patch))
			}).then(function (res) { return res.json(); });
		}
		//#endregion

		/**
		 * 「PTC 开关」按钮 + 勾选弹层。
		 * 状态机：switches=null 表示未加载/加载失败；逐行 pending 期间禁用该行；
		 * 任何 ok:false 或网络错误都回滚到服务端返回的最新快照（或重拉）。
		 */
		function PtcSwitchesButton() {
			var openState = useState(false);
			var open = openState[0];
			var setOpen = openState[1];
			var switchesState = useState(null);
			var switches = switchesState[0];
			var setSwitches = switchesState[1];
			var errorState = useState(null);
			var error = errorState[0];
			var setError = errorState[1];
			var pendingState = useState(null);
			var pending = pendingState[0];
			var setPending = pendingState[1];
			var othersState = useState([]);
			var others = othersState[0];
			var setOthers = othersState[1];
			var directorState = useState({ available: false, roles: [], stalePolicies: [], invalidPolicies: [] });
			var director = directorState[0];
			var setDirector = directorState[1];
			var revisionState = useState(0);
			var routeRevision = revisionState[0];
			var setRouteRevision = revisionState[1];
			var posState = useState({ top: 0, right: 0 });
			var pos = posState[0];
			var setPos = posState[1];
			var buttonRef = react.useRef(null);

			var anyOff = Array.isArray(switches) && switches.some(function (sw) { return !sw.enabled; });

			/**
			 * 兼容 host 半新旧两版响应：新版 value.agents（含 switchable 与 catalog
			 * 只读项）；旧版 value.switches（全部可勾选）。旧版条目补 switchable:true。
			 * host 半仅在 DSH 重启时重载，client bundle 可能较新，必须容忍旧形状，
			 * 否则会把"版本错位"误显示为"未定义 switches"。
			 */
			function normalizeAgents(value) {
				if (!value) return [];
				if (Array.isArray(value.agents)) return value.agents;
				if (Array.isArray(value.switches)) {
					return value.switches.map(function (sw) {
						return Object.assign({ switchable: true }, sw);
					});
				}
				return [];
			}

			/**
			 * 只读清单：host 半 value.others（{key,label}）。旧版 host 不返回该字段，
			 * 此时返回空数组、整段不渲染 —— 版本错位不得显示为错误。
			 */
			function normalizeOthers(value) {
				if (!value || !Array.isArray(value.others)) return [];
				return value.others.filter(function (item) {
					return item && typeof item.key === "string";
				});
			}

			function normalizeDirector(value) {
				if (!value || !value.director || !Array.isArray(value.director.roles)) {
					return { available: false, roles: [], stalePolicies: [], invalidPolicies: [] };
				}
				return value.director;
			}

			function applySnapshot(value) {
				setSwitches(normalizeAgents(value));
				setOthers(normalizeOthers(value));
				setDirector(normalizeDirector(value));
				setRouteRevision(value && Number.isSafeInteger(value.routeRevision) ? value.routeRevision : 0);
			}

			function refresh() {
				return swGet().then(function (body) {
					if (body && body.ok) {
						applySnapshot(body.value);
						setError(null);
					} else {
						setError((body && body.error && body.error.message) || "加载失败");
					}
				}).catch(function (err) {
					setError(String(err && err.message || err));
				});
			}

			useEffect(function () {
				if (!open) return;
				refresh();
			}, [open]);

			function onToggle(sw) {
				if (pending || !sw.switchable) return;
				var next = !sw.enabled;
				setPending(sw.key);
				setError(null);
				// 乐观更新；失败时以服务端快照/重拉为准回滚。
				setSwitches(function (prev) {
					return prev && prev.map(function (item) {
						return item.key === sw.key ? Object.assign({}, item, { enabled: next }) : item;
					});
				});
				swSet(sw.key, next).then(function (body) {
					if (body && body.ok) {
						applySnapshot(body.value);
					} else {
						setError((body && body.error && body.error.message) || "写入失败");
						refresh();
					}
				}).catch(function (err) {
					setError(String(err && err.message || err));
					refresh();
				}).finally(function () {
					setPending(null);
				});
			}

			function onDirectorUpdate(role, patch) {
				if (pending) return;
				setPending("director:" + role.roleId);
				setError(null);
				setDirector(function (prev) {
					return Object.assign({}, prev, {
						roles: (prev.roles || []).map(function (item) {
							return item.roleId === role.roleId ? Object.assign({}, item, patch) : item;
						})
					});
				});
				directorSet(role, patch, routeRevision).then(function (body) {
					if (body && body.ok) applySnapshot(body.value);
					else {
						setError((body && body.error && body.error.message) || "Director 策略写入失败");
						refresh();
					}
				}).catch(function (err) {
					setError(String(err && err.message || err));
					refresh();
				}).finally(function () {
					setPending(null);
				});
			}

			function onButtonClick() {
				if (!open && buttonRef.current) {
					var rect = buttonRef.current.getBoundingClientRect();
					setPos({ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) });
				}
				setOpen(!open);
			}

			var rows = null;
			if (Array.isArray(switches) && switches.length > 0) {
				rows = switches.map(function (sw) {
					var interactive = sw.switchable === true;
					return h("label", {
						key: sw.key,
						className: interactive ? "ptcsw-row" : "ptcsw-row ptcsw-row-readonly",
						"data-pending": pending === sw.key ? "true" : "false",
						title: interactive ? "" : "固定参与路由，不可勾选（如需开关请先人工在 switches 登记）"
					},
						h("input", {
							type: "checkbox",
							checked: sw.enabled,
							disabled: !interactive,
							onChange: interactive ? function () { onToggle(sw); } : undefined
						}),
						h("span", null,
							h("div", null,
								h("span", { className: "ptcsw-key" }, sw.key),
								sw.label ? h("span", { className: "ptcsw-label" }, " — " + sw.label) : null,
								interactive ? null : h("span", { className: "ptcsw-fixed" }, "固定")
							),
							h("div", { className: "ptcsw-meta" },
								(sw.executors || []).concat(sw.routes || []).join(", "))
						)
					);
				});
			} else if (Array.isArray(switches)) {
				rows = h("div", { className: "ptcsw-foot" }, "route-config.json 未定义 subagentRouting.switches");
			} else {
				rows = h("div", { className: "ptcsw-foot" }, error ? "加载失败，点击重试" : "加载中…");
			}

			/**
			 * 只读文本区：未登记开关的其他可选子代理。刻意不渲染 input —— 这些条目
			 * 没有开关口径（routes/executors 过滤），勾选会造成"看起来能关、其实不生效"。
			 */
			var otherRows = others.length > 0 ? h("div", { className: "ptcsw-others" },
				h("div", { className: "ptcsw-others-title" }, "其他可选子代理（仅列出，不可勾选）"),
				others.map(function (item) {
					return h("div", { key: item.key, className: "ptcsw-other-row" },
						h("span", { className: "ptcsw-key" }, item.key),
						item.label ? h("span", { className: "ptcsw-label" }, " — " + item.label) : null
					);
				})
			) : null;

			var directorBlock = null;
			if (director && director.available && Array.isArray(director.roles)) {
				var tierLabels = { design: "设计", execute: "执行/验证", continuous: "连续修改", docs: "文档" };
				directorBlock = h("div", { className: "ptcsw-director" },
					h("div", { className: "ptcsw-director-title" }, "Director 角色（PTC 参与）"),
					director.roles.length === 0 ? h("div", { className: "ptcsw-foot" }, "尚未定义角色") : director.roles.map(function (role) {
						var rolePending = pending === "director:" + role.roleId;
						var routeText = [role.provider, role.model, role.reasoningEffort].filter(Boolean).join(" / ");
						return h("div", { key: role.roleId, className: "ptcsw-director-row", "data-pending": rolePending ? "true" : "false" },
							h("label", { className: "ptcsw-director-head" },
								h("input", { type: "checkbox", checked: role.enabled === true, disabled: !!pending, onChange: function () { onDirectorUpdate(role, { enabled: !role.enabled }); } }),
								h("span", null,
									h("div", null, h("span", { className: "ptcsw-key" }, role.displayName || role.roleId), h("span", { className: "ptcsw-label" }, " — " + role.roleId)),
									routeText ? h("div", { className: "ptcsw-meta" }, routeText) : null
								)
							),
							h("div", { className: "ptcsw-director-fields" },
								Object.keys(tierLabels).map(function (tier) {
									var checked = (role.tiers || []).indexOf(tier) >= 0;
									return h("label", { key: tier, className: "ptcsw-tier" },
										h("input", {
											type: "checkbox",
											checked: checked,
											disabled: !!pending,
											onChange: function () {
												var next = checked ? (role.tiers || []).filter(function (x) { return x !== tier; }) : (role.tiers || []).concat([tier]);
												onDirectorUpdate(role, { tiers: next });
											}
										}),
										tierLabels[tier]
									);
								}),
								h("label", { className: "ptcsw-tier" }, "位置", h("select", {
									className: "ptcsw-position", value: role.position || "fallback", disabled: !!pending,
									onChange: function (event) { onDirectorUpdate(role, { position: event.target.value }); }
								},
									h("option", { value: "preferred" }, "首选"),
									h("option", { value: "fallback" }, "后备")
								)),
								h("label", { className: "ptcsw-tier" }, "优先级", h("input", {
									type: "number", min: 0, max: 1000, step: 10, className: "ptcsw-priority", value: role.priority,
									disabled: !!pending,
									onChange: function (event) {
										var value = Number(event.target.value);
										if (Number.isSafeInteger(value) && value >= 0 && value <= 1000) onDirectorUpdate(role, { priority: value });
									}
								}))
							)
						);
					}),
					(director.stalePolicies || []).length > 0 ? h("div", { className: "ptcsw-error" }, "已失效角色策略: " + director.stalePolicies.join(", ")) : null,
					(director.invalidPolicies || []).length > 0 ? h("div", { className: "ptcsw-error" }, "非法角色策略（已禁用）: " + director.invalidPolicies.join(", ")) : null
				);
			}

			return h(react.Fragment, null,
				h("button", {
					ref: buttonRef,
					type: "button",
					className: "ptcsw-button",
					"data-off": anyOff ? "true" : "false",
					title: anyOff ? "PTC 子代理开关（有已关闭项）" : "PTC 子代理开关",
					onClick: onButtonClick
				}, anyOff ? "PTC⚠" : "PTC"),
				open ? h("div", {
					className: "ptcsw-backdrop",
					onClick: function () { setOpen(false); }
				}) : null,
				open ? h("div", {
					className: "ptcsw-popover",
					style: { top: pos.top + "px", right: pos.right + "px" },
					onClick: function (e) { e.stopPropagation(); }
				},
					h("div", { className: "ptcsw-title" }, "PTC 子代理路由"),
					rows,
					directorBlock,
					otherRows,
					error ? h("div", { className: "ptcsw-error" }, error) : null,
					h("div", { className: "ptcsw-foot" }, "变更即时写回本机 PTC 路由层，新派发立即生效")
				) : null
			);
		}

		//#region 插件入口
		var inject = ["slots"];

		function apply(ctx) {
			ctx.effect(function () {
				var style = document.createElement("style");
				style.setAttribute("data-plugin", "dsh-plugin-ptc-switches");
				style.textContent = STYLE_CSS;
				document.head.append(style);
				return function () { style.remove(); };
			}, "dsh-plugin-ptc-switches: styles");

			ctx.effect(function () {
				return ctx.slots.inject("conversation.session.header.utilities", function () {
					var dispose = ctx.slots.register({
						name: "conversation.session.header.utilities",
						id: "ptc-switches-toggle",
						order: 91,
						inject: function () { return {}; }
					}, PtcSwitchesButton);
					return function () { dispose(); };
				});
			}, "dsh-plugin-ptc-switches: entry");
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
