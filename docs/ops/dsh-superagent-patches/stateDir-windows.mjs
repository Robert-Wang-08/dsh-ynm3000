// 补丁 3：让 stateDir 接受 Windows 绝对路径。
//
// 症状：服务 err 日志报
//   dsh: warning: 2 entries did not activate
//   dsh-superagent (dsh-superagent): ValidationError: invalid config:
//     - $.stateDir expect string to match regexp /^\// (at stateDir)
//   dsh-superagent-github (dsh-superagent/github-watch): pending (waiting for service: orchestrator)
// → dsh-superagent 与它依赖的 orchestrator 都不激活，面板只有壳，任何 Ticket 都不会产生。
//
// 根因：src/deployment.ts 的 absolute() 把「绝对路径」写死成正则 /^\//（POSIX 视角），
//       于是 Windows 的 C:\Users\... 一律被判非法。这是原型只在 POSIX 上验证过的可移植性缺陷，
//       不是本机配置错误（stateDir 本身是必需项，无法省略）。
//
// 修法：把校验放宽成「/ 开头、\\ 开头、或盘符 + 分隔符开头」，其余语义不变。
//       只改校验器，不改 stateDir 的用途与必填性。
export const id = "stateDir-windows-absolute";
export const target = "lib/poll-*.js";
export const summary = "stateDir 接受 Windows 绝对路径（C:\\ / C:/），否则插件校验失败拒绝启动";

export const applied = (text) => text.includes("[A-Za-z]:[\\\\/]");

export function apply(text) {
  const from = ".pattern(/^\\//)";
  const to = ".pattern(/^([\\\\/]|[A-Za-z]:[\\\\/])/)";
  const hits = text.split(from).length - 1;
  if (hits !== 1) throw new Error("stateDir-windows: absolute() 校验器出现 " + hits + " 处，补丁可能需要更新");
  return text.replace(from, to);
}
