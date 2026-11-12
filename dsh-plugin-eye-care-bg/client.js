/**
 * dsh-plugin-eye-care-bg — 客户端半（client.js）
 *
 * 把 DSH Web 面板的页面底色改成护眼底色（默认 #C7EDCC，豆沙绿）。
 *
 * 交付形状是硬契约：dsh 把每个插件的 client.js 当 classic script 拼进单个
 * /plugins 响应执行 —— 本文件必须保持 CJS + window.__ModuleLoader__.load 包装，
 * 不得出现模块级 import/export；require 白名单只有 react（本文件不用）。
 *
 * 只改视觉：覆盖主题的设计令牌 --dsw-alias-bg-base（body 上定义的基础底色），
 * 并把 html/body 自身底色一并设上，避免页面外缘露白。不读写会话、不发请求。
 * 想换色：改下面的 BG 常量后重启 dsh（只改这里，不动主题包）。
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-eye-care-bg",
	factory: function (require) {
		var module = { exports: {} };
		var exports = module.exports;

		var name = "eye-care-bg";
		var inject = [];
		var BG = "#C7EDCC";

		var CSS = [
			":root,body{--dsw-alias-bg-base:" + BG + " !important;}",
			"html,body{background-color:" + BG + " !important;}"
		].join("\n");

		function apply(ctx) {
			ctx.effect(function () {
				var style = document.createElement("style");
				style.setAttribute("data-plugin", "dsh-plugin-eye-care-bg");
				style.textContent = CSS;
				document.head.append(style);
				return function () { style.remove(); };
			}, "dsh-plugin-eye-care-bg: eye-care background");
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
