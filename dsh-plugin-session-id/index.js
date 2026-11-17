/**
 * dsh-plugin-session-id — node 半（宿主侧）。
 *
 * 纯载体占位：全部能力在浏览器端（client.js 经
 * conversation.session.header.actions 席位渲染「会话 ID」按钮）。host 半只作为
 * roster 行被扫描挂载，不注册服务、不碰 settings、不读写会话、不介入模型请求。
 */
export const name = 'session-id'

export function apply(ctx) {
  ctx.logger?.info?.('[dsh-plugin-session-id] host half mounted (client-driven)')
}
