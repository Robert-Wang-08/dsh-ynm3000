/**
 * dsh-plugin-session-id — 客户端半（client.js）
 *
 * 在会话头部 `conversation.session.header.actions` 席位（标题旁）注册一个
 * 「会话 ID」按钮：点开即见当前 Session ID（可选中），并一键复制；当会话是
 * SuperAgent 执行器会话（ID 形如 `worker-<ticketId>`）时，同时显示该工单 ID
 * 并提供单独复制。
 *
 * sessionId 由宿主的会话标准 props 随席位作用域投递（`props.sessionId`），
 * 不需要额外 RPC、不读会话内容、不持凭据、不写 settings。
 *
 * 交付形状是硬契约：dsh 把每个插件的 client.js 当 classic script 拼进单个
 * /plugins 响应执行 —— 本文件必须保持 CJS + window.__ModuleLoader__.load
 * 包装，不得出现模块级 import/export；require 白名单只有 react（先例：
 * dsh-plugin-ptc-switches / dsh-plugin-subagent-monitor / dsh-plugin-eye-care-bg）。
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-session-id",
	factory: function (require) {
		var module = { exports: {} };
		var exports = module.exports;

		var react = require("react");
		var h = react.createElement;
		var useEffect = react.useEffect;
		var useState = react.useState;
		var useRef = react.useRef;

		//#region 常量与样式
		var WORKER_PREFIX = "worker-";
		var PANEL_WIDTH = 360;
		var PANEL_HEIGHT = 208;
		var MARGIN = 8;

		// shell 设计令牌优先，缺失时回落常量；深色主题由令牌自动跟随。
		var STYLE_CSS = [
			".dshsid-trigger{border:1px solid transparent;border-radius:6px;background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:12px;line-height:18px;padding:3px 6px;min-height:24px;display:inline-flex;align-items:center;gap:4px;letter-spacing:0}",
			".dshsid-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(208,215,222,.32))}",
			".dshsid-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2f6feb);outline-offset:1px}",
			".dshsid-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover,rgba(208,215,222,.32))}",
			".dshsid-panel{position:fixed;z-index:1200;box-sizing:border-box;width:min(" + PANEL_WIDTH + "px,calc(100vw - 16px));padding:10px 12px;border:1px solid var(--dsw-alias-border-primary,#d0d7de);border-radius:8px;background:var(--dsw-alias-bg-primary,#fff);box-shadow:0 8px 24px rgba(0,0,0,.18);font-size:12px;line-height:18px;color:var(--dsw-alias-text-primary,#1f2328);letter-spacing:0;text-align:left}",
			".dshsid-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;font-weight:600}",
			".dshsid-close{border:none;background:transparent;color:var(--dsw-alias-text-tertiary,#8c959f);cursor:pointer;font:inherit;font-size:14px;line-height:18px;padding:0 2px;border-radius:4px}",
			".dshsid-close:hover{color:var(--dsw-alias-text-primary,#1f2328);background:var(--dsw-alias-interactive-bg-hover,rgba(208,215,222,.32))}",
			".dshsid-code{display:block;box-sizing:border-box;margin:0 0 8px;padding:6px 8px;border:1px solid var(--dsw-alias-border-muted,#eaeef2);border-radius:6px;background:var(--dsw-alias-markdown-inline-code,#f6f8fa);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:17px;word-break:break-all;user-select:text}",
			".dshsid-actions{display:flex;align-items:center;flex-wrap:wrap;gap:6px}",
			".dshsid-btn{border:1px solid var(--dsw-alias-border-primary,#d0d7de);border-radius:6px;background:var(--dsw-alias-bg-primary,#fff);color:inherit;cursor:pointer;font:inherit;font-size:12px;line-height:20px;padding:2px 8px}",
			".dshsid-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(208,215,222,.32))}",
			".dshsid-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2f6feb);outline-offset:1px}",
			".dshsid-ticket{margin-top:8px;color:var(--dsw-alias-text-secondary,#57606a)}",
			".dshsid-ticket .dshsid-code{display:inline;margin:0;padding:1px 5px;font-size:11px}",
			".dshsid-status{margin-top:6px;color:var(--dsw-alias-state-success-primary,#1a7f37)}",
			".dshsid-status[data-failed=true]{color:var(--dsw-alias-state-error-primary,#cf222e)}",
			".dshsid-hint{margin-top:8px;padding-top:6px;border-top:1px solid var(--dsw-alias-border-muted,#eaeef2);color:var(--dsw-alias-text-tertiary,#8c959f);font-size:11px;line-height:16px}"
		].join("\n");
		//#endregion

		//#region 纯函数
		/** 只接受字符串，其余一律当作空值，避免把 undefined 渲染进面板。 */
		function textOf(value) {
			return typeof value === "string" ? value : "";
		}

		/**
		 * 执行器会话 ID 形如 `worker-<ticketId>`（见 dsh-superagent
		 * `workerSessionId`），返回工单 ID；其他会话返回空串。
		 */
		function ticketOf(sessionId) {
			var id = textOf(sessionId);
			if (id.indexOf(WORKER_PREFIX) !== 0) return "";
			var ticketId = id.slice(WORKER_PREFIX.length);
			return ticketId.length > 0 ? ticketId : "";
		}

		/**
		 * 把 popover 放进视口：优先按钮下方，下方放不下且上方放得下时翻到上方，
		 * 两边都放不下时夹到视口内。rect 只需 left/top/bottom，viewport 只需
		 * width/height；缺失值按 0 处理（打开首帧尚未测量时的安全默认）。
		 */
		function placePopover(rect, viewport) {
			var anchor = rect !== null && typeof rect === "object" ? rect : {};
			var box = viewport !== null && typeof viewport === "object" ? viewport : {};
			var left = typeof anchor.left === "number" ? anchor.left : 0;
			var top = typeof anchor.top === "number" ? anchor.top : 0;
			var bottom = typeof anchor.bottom === "number" ? anchor.bottom : top;
			var width = typeof box.width === "number" ? box.width : 0;
			var height = typeof box.height === "number" ? box.height : 0;

			var x = width > 0
				? Math.max(MARGIN, Math.min(left, width - PANEL_WIDTH - MARGIN))
				: left;

			var below = bottom + 6;
			var above = top - 6 - PANEL_HEIGHT;
			var y;
			if (height > 0 && below + PANEL_HEIGHT <= height - MARGIN) y = below;
			else if (height > 0 && above >= MARGIN) y = above;
			else if (height > 0) y = Math.max(MARGIN, height - PANEL_HEIGHT - MARGIN);
			else y = below;

			return { left: Math.round(x), top: Math.round(y) };
		}

		/**
		 * 剪贴板写入：优先异步 Clipboard API（127.0.0.1 / localhost 属于安全上下文）；
		 * 不可用或被拒绝时退回隐藏 textarea + execCommand('copy')，覆盖普通 http 访问。
		 * 返回 Promise<boolean>。
		 */
		function copyText(value) {
			var clipboard = typeof navigator !== "undefined" && navigator !== null ? navigator.clipboard : undefined;
			if (clipboard !== undefined && clipboard !== null && typeof clipboard.writeText === "function") {
				try {
					return clipboard.writeText(value).then(
						function () { return true; },
						function () { return copyTextFallback(value); }
					);
				} catch (_) { /* 同步异常也走回退 */ }
			}
			return Promise.resolve(copyTextFallback(value));
		}

		function copyTextFallback(value) {
			try {
				if (typeof document === "undefined" || document === null || !document.body) return false;
				if (typeof document.createElement !== "function") return false;
				var area = document.createElement("textarea");
				area.value = value;
				area.setAttribute("readonly", "");
				area.style.position = "fixed";
				area.style.top = "0";
				area.style.opacity = "0";
				document.body.appendChild(area);
				try {
					if (typeof area.select === "function") area.select();
					return typeof document.execCommand === "function" && document.execCommand("copy") === true;
				} finally {
					// 无论复制成败都清掉临时节点，避免异常路径把它留在 DOM 里。
					try { document.body.removeChild(area); } catch (_) { /* 已被移除 */ }
				}
			} catch (_) {
				return false;
			}
		}
		//#endregion

		//#region 组件
		function SessionIdButton(props) {
			var sessionId = props !== null && typeof props === "object" ? textOf(props.sessionId) : "";
			var ticketId = ticketOf(sessionId);

			var openState = useState(false);
			var open = openState[0];
			var setOpen = openState[1];
			var positionState = useState(null);
			var position = positionState[0];
			var setPosition = positionState[1];
			var statusState = useState("");
			var status = statusState[0];
			var setStatus = statusState[1];
			var rootRef = useRef(null);
			var triggerRef = useRef(null);

			// 打开时按触发按钮的实时位置定位；窗口尺寸变化时重算。
			useEffect(function () {
				if (!open) return undefined;
				if (typeof window === "undefined" || window === null) return undefined;
				var place = function () {
					var trigger = triggerRef.current;
					if (trigger === null || trigger === undefined || typeof trigger.getBoundingClientRect !== "function") return;
					setPosition(placePopover(
						trigger.getBoundingClientRect(),
						{ width: window.innerWidth, height: window.innerHeight }
					));
				};
				place();
				window.addEventListener("resize", place);
				return function () { window.removeEventListener("resize", place); };
			}, [open]);

			// 点空白处 / Esc 关闭，避免弹层挂在页面上挡住会话操作。
			useEffect(function () {
				if (!open) return undefined;
				if (typeof document === "undefined" || document === null) return undefined;
				var onPointerDown = function (event) {
					var root = rootRef.current;
					if (root !== null && root !== undefined && typeof root.contains === "function"
						&& event !== null && typeof event === "object"
						&& root.contains(event.target)) return;
					setOpen(false);
				};
				var onKeyDown = function (event) {
					if (event !== null && typeof event === "object" && event.key === "Escape") setOpen(false);
				};
				document.addEventListener("mousedown", onPointerDown);
				document.addEventListener("keydown", onKeyDown);
				return function () {
					document.removeEventListener("mousedown", onPointerDown);
					document.removeEventListener("keydown", onKeyDown);
				};
			}, [open]);

			// 复制反馈 1.8s 后自动复位。
			useEffect(function () {
				if (status === "") return undefined;
				var timer = setTimeout(function () { setStatus(""); }, 1800);
				return function () { clearTimeout(timer); };
			}, [status]);

			if (sessionId.length === 0) return null;

			var copy = function (value) {
				copyText(value).then(function (ok) {
					setStatus(ok ? "已复制" : "复制失败，请手动选择文本");
				});
			};

			return h("span", { "data-session-id-root": true, ref: rootRef, style: { display: "inline-flex", alignItems: "center", position: "relative", letterSpacing: "0" } },
				h("button", {
					ref: triggerRef,
					type: "button",
					className: "dshsid-trigger",
					"data-session-id-trigger": true,
					"aria-haspopup": "dialog",
					"aria-expanded": open ? "true" : "false",
					"aria-controls": "dsh-sid-panel",
					title: "查看 / 复制当前会话 ID\n" + sessionId,
					onClick: function () {
						setStatus("");
						setOpen(!open);
					}
				}, "会话 ID"),
				open ? h("div", {
					id: "dsh-sid-panel",
					className: "dshsid-panel",
					"data-session-id-panel": true,
					role: "dialog",
					"aria-label": "会话 ID",
					style: position === null
						? { left: "0px", top: "0px", visibility: "hidden" }
						: { left: position.left + "px", top: position.top + "px" }
				},
					h("div", { className: "dshsid-head" },
						h("span", null, "当前会话 ID"),
						h("button", {
							type: "button",
							className: "dshsid-close",
							"aria-label": "关闭",
							onClick: function () { setOpen(false); }
						}, "\u00d7")),
					h("code", { className: "dshsid-code", "data-session-id-value": true, tabIndex: 0 }, sessionId),
					h("div", { className: "dshsid-actions" },
						h("button", {
							type: "button",
							className: "dshsid-btn",
							"data-session-id-copy": true,
							onClick: function () { copy(sessionId); }
						}, "复制会话 ID"),
						ticketId.length > 0 ? h("button", {
							type: "button",
							className: "dshsid-btn",
							"data-session-id-copy-ticket": true,
							onClick: function () { copy(ticketId); }
						}, "复制工单 ID") : null),
					ticketId.length > 0 ? h("div", { className: "dshsid-ticket", "data-session-id-ticket": true },
						"SuperAgent 工单 ",
						h("code", { className: "dshsid-code" }, ticketId)) : null,
					status.length > 0 ? h("div", {
						className: "dshsid-status",
						role: "status",
						"aria-live": "polite",
						"data-failed": status.indexOf("复制失败") === 0 ? "true" : "false"
					}, status) : null,
					h("div", { className: "dshsid-hint" },
						"在 SuperAgent 面板或对话里用这个 ID 定位同一会话。"))
				: null
			);
		}
		//#endregion

		//#region 插件入口
		var inject = ["slots"];

		function apply(ctx) {
			ctx.effect(function () {
				var style = document.createElement("style");
				style.setAttribute("data-plugin", "dsh-plugin-session-id");
				style.textContent = STYLE_CSS;
				document.head.append(style);
				return function () { style.remove(); };
			}, "dsh-plugin-session-id: styles");

			ctx.effect(function () {
				return ctx.slots.inject("conversation.session.header.actions", function () {
					var dispose = ctx.slots.register({
						name: "conversation.session.header.actions",
						id: "session-id",
						order: 15,
						inject: function () { return {}; }
					}, SessionIdButton);
					return function () { dispose(); };
				});
			}, "dsh-plugin-session-id: entry");
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.__test = { textOf: textOf, ticketOf: ticketOf, placePopover: placePopover, copyText: copyText };
		return module.exports;
	}
});
