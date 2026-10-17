/**
 * dsh-plugin-subagent-monitor — node 半（宿主侧）。
 *
 * 纯载体占位：本插件的全部能力在浏览器端（client.js 经
 * conversation.session.header.actions 席位渲染面板），host 半只作为 roster
 * 行被扫描挂载，不注册服务、不碰 settings、不介入模型请求。
 */
export const name = 'subagent-monitor'

export function apply(ctx) {
  ctx.logger?.info?.('[dsh-plugin-subagent-monitor] host half mounted (client-driven)')
}
