/**
 * dsh-plugin-eye-care-bg — node 半。
 *
 * 只作为 bundle 载体存在：真正的效果在 client.js（浏览器侧注入一段护眼底色 CSS）。
 * 宿主侧不注册端点、不读文件、不持凭据，apply 为空实现。
 *
 * 修改底色：改 client.js 里的 BG 常量（或本文件导出的默认值只用于文档说明）。
 */
export const name = 'eye-care-bg';

export const BG_DEFAULT = '#C7EDCC';

/** 无宿主行为。保留空 apply 是为了满足 cordis 插件形态（name + apply）。 */
export function apply() {}
