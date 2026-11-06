// 补丁 2：orchestrator 会话的工具白名单按“工具实际存在”过滤。
//
// 症状：服务 err 日志报  tools.restrict() names unknown global tool "bash"
//       → orchestrator 会话 resume 失败 → orchestrator 服务起不来
//       → dsh-superagent-github / -feishu 两个 source 永远 pending（HTTP 404 Unknown operation）。
// 根因：master 绑定的 allow 列表写死了 "bash"，而 Windows 版 DSH 的全局工具是 "pwsh"（无 bash）。
// 修法：allow 列表按 agent.ctx.tools.get(name, scopeParentOf(agent)) 过滤，缺失的名字直接跳过。
export const id = "orchestrator-tools-existing-only";
export const target = "lib/index.js";
export const summary = "orchestrator 工具白名单跳过不存在的工具（修 unknown global tool bash）";

export const applied = (text) => text.includes("catch { return false; } }") && text.includes("scopeParentOf(agent))");

export function apply(text) {
  const re = /allow:\s*\[\s*"skill",\s*"bash",[\s\S]{0,200}?\]/;
  const m = re.exec(text);
  if (!m) throw new Error("orchestrator-tools: 没有匹配到 allow 列表，补丁可能需要更新");
  const repl =
    'allow: [ "skill", "bash", "read", "read_image", "job_output", "job_list", "job_kill" ]' +
    ".filter((n) => { try { return !!agent.ctx.tools.get(n, scopeParentOf(agent)); } catch { return false; } })";
  return text.slice(0, m.index) + repl + text.slice(m.index + m[0].length);
}
