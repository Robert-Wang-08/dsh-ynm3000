# dsh-plugin-ptc-switches

DSH Web 增强插件：在会话头部（铃铛旁）新增「PTC 开关」按钮，点击展开面板，
列出全部可选子代理：

- **可勾选项**（`subagentRouting.switches`）：人工开关，勾选/取消即时写回路由层。
  例如 `gpt-official`（GPT 官网）、`opus-review`（Opus 独立复核梯）。
- **Director 角色策略**：从 `dsh-plugin-subagent-director` settings 实时读取角色名、
  provider/model/reasoning effort，在同一面板配置角色是否参与 PTC、适用层级
  （设计/执行与验证/连续修改/文档）、首选或后备位置以及优先级。PTC 文件只保存
  `{ enabled, tiers, position, priority }`，不会复制 persona/provider/model/toolFilter。
- **只读项**（`subagentRouting.catalog`）：固定参与路由的子代理（Astra、Codex
  Relay、Cursor/Grok、DS×2、Kimi 文档），仅展示不可勾选；如需可开关化，先人工
  在 `switches` 里登记 key 与 routes/executors 过滤口径。
- **纯文本项**（`subagentRouting.others`）：其余可选子代理（`subagent_fork`、
  `subagent_claude_code`、`subagent_opencode`、`subagent_kimi`）以一段文字列出，
  **不渲染 checkbox**、不参与写回。这些条目没有开关过滤口径，给勾选框会造成
  「看起来能关、其实不生效」。该字段缺失时回落到插件内置的 `DEFAULT_OTHERS`
  清单，因此新装机器不配置也能列全。

勾选即时写回 `$DSH_HOME/plugins/provider-failover/route-config.json`（写前自动
`.bak-before-switch-<utc>` 或 `.bak-before-director-role-<utc>` 备份，临时文件 + rename
原子替换）；Director 策略写回使用 `subagentRouting.revision` 做乐观并发控制。
`ptc_route.py` 在每次路由判定时重新读取该文件，因此**新派发立即生效，无需重启**。
Host 级 `providerFailover` 不受本面板影响（它由 DSH 启动层读取，改动仍需重启）。

## 安装

```powershell
dsh plugin --profile web add <path-to-this-package>
# 重启 DSH 后生效（host 半需要注册 /ptc-switches 端点）
```

## API（host 半注册于 DSH Web server）

- `GET  /ptc-switches` → `{ ok, value: { path, agents, others, director, routeRevision }, version }`。`director.roles` 合并 Director 只读角色元数据与 PTC 参与策略。
- `POST /ptc-switches/set` body `{ key, enabled }` → 校验 key 已定义于 switches → 原子写回 → 返回最新快照。
- `POST /ptc-switches/director-set` body `{ roleId, enabled?, tiers?, position?, priority?, expectedRevision? }` → 校验角色存在和字段取值 → revision 冲突返回 409 → 原子写回 → 返回最新快照。

开关事实源路径解析：`PTC_ROUTE_CONFIG` 环境变量 > `$DSH_HOME` > `~/.dsh`。

## 与路由器/CLI 的关系

- 路由器：`ptc-multi-agent-control/scripts/ptc_route.py` 的 `apply_switches()`
  按开关过滤候选链；`apply_director_roles()` 把命中 tier 的角色表示为
  `executor=subagent_role + role=<id>`，`preferred` 位于原生候选前，`fallback`
  位于首个主控兜底前，同组按 priority 与 role id 稳定排序。主控席位
  （executor=none）永不被开关剔除；决策输出包含 `disabled_switches`、
  `director_roles`、`disabled_director_roles` 和 `route_config_revision`。
- CLI 等效：`ptc_switch.py --list` / `--set <key> on|off`（同一文件、同一备份约定）。

## 测试

```powershell
node test/smoke.mjs         # host 纯函数与 HTTP：switch/Director/revision/备份
node test/smoke-client.mjs  # 客户端 vm 真渲染：agents/Director/others/旧版降级
```

`test/smoke-client.mjs` 用 `vm` 沙箱 + 假 `react`（含最小 hooks 运行时）+ 注入式
假 `fetch`，覆盖：新版 host 渲染出 `ptcsw-others` 文本区块且**其内不含任何
`input`**、弹层 `input` 总数等于 agents 行数、旧版 host（仅 `value.switches`）
与中间态（无 `others`）都整段不渲染且不抛错。退出码 0 / 1。
