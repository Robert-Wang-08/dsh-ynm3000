# Kimi K3 独立复核：codegraph MCP 与 SkillHub 链接修复

- task_id: task-20261105T043846164037Z-fa0c17312386
- subtask_id: subtask-20261105T043847471213Z-ad641332720e
- contract_hash: bf8bd24f94b4133939e91cb2a10d2520b64d169fe9c92eed2b7eba72e0cf92f2
- 派发：主控 ais-2dsglm/deepseek-flash -> 子代理 kimi-coding/k3-256k（executor=subagent）
- 路由器判定：R1（cross_directory + 失败代价高）与 R2 变体均为 controller-codex 档；本次为**只读复核**且用户显式点名 Kimi K3，按「人工指定 provider/model 覆盖默认首选」执行并登记为 decision。
- 复核者独立性：子代理只读，未写账本，只返回 receipt。

## 结论

P0 = 0，P1 = 0，P2 = 1，P3 = 2。8 条主张全部独立验证为真（其中 C8 的"111 次"计数本身无独立数据源，仅内容零漂移可证）。

| 主张 | 判定 |
| --- | --- |
| C1 mcp-codegraph 唯一注册、无 disabled、args=['--mcp'] | 真 |
| C2 codegraph-mcp 默认 LSP，需 --mcp | 真 |
| C3 codex config.toml 可解析且值正确 | 真 |
| C4 三 root 各 37 个 junction，Target 全落 store\installed | 真 |
| C5 -ConfigPack 定位顺序与显式权威性 | 真（4/4） |
| C6 _ask_confirm 无 TTY 不阻塞 | 真（附 P2 回归） |
| C7 两文件语法无误 | 真 |
| C8 registry 零漂移 | 真（次数不可核） |

## 缺陷

1. **P2** skillhub.py L1259-1262：`echo y | skillhub.py promote X` 旧用法失效（非 TTY 一律判 N）。有 `--force`/`--yes` 绕行，需在变更说明中显式通告。
2. **P3** dsh-backup.ps1 L73-79：若 `link:` 依赖值写成相对路径，解析基准是进程 cwd 而非 profile 目录。本机 12 条 link 全为绝对路径，属潜在跨机隐患。
3. **P3** skillhub.py L1263：TTY 下 `input()` 遇 EOF 抛 EOFError 未捕获；旧代码同病，非本次回归。

## 主控补充发现（复核者未报）

4. **P3** dsh-backup-restore/SKILL.md 仍写"并在目标 profile 安装 dsh-config-pack"，与新回退链语义不符，属文档残留。

## 未验证项

- codegraph MCP 的运行态（需重启 DSH 后新会话才能观察）。
- `promote` 无 TTY 分支的 live 测试（会写 registry，未执行）。
