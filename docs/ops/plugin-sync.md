# 双向插件清单同步（v1）

A→B、B→A 使用相同入口，目标路径始终在接收机生成。源码仍通过 Git 传递；清单文件通过共享盘/拷贝交换。不会把整个源机 package.json 覆盖目标机。

## 导出（任意一台作为发送端）

在本机 dsh 仓库根运行：

~~~powershell
node ./scripts/plugin-sync.mjs export --profile "$env:USERPROFILE/.dsh/profiles/web" --workspace "$PWD" --out ./plugins-web.json
~~~

把 plugins-web.json 交给另一台设备。它只含包名、版本、bundle 顺序、源码指纹和工作区相对目录，不含发送机 link 绝对路径。隐式宿主 bundle 单独声明，不伪造 npm 依赖。不要把个人映射文件放进 Git。

## 接收端先看计划

先通过 Git 更新双方插件源码。在接收机自己的 dsh 仓库根运行：

~~~powershell
pwsh -NoProfile -File ./dsh-restore.ps1 -PluginManifest ./plugins-web.json
~~~

默认只输出 JSON 计划，errors 非空退出非零。导入方向反过来时命令不变。已有 link 优先使用接收机自己的有效路径；新插件按接收机 WorkspaceRoot 和清单相对目录定位。

工作区外插件用本机映射显式定位，例如保存到 ~/.dsh/device/plugin-map.json：

~~~json
{"packages":{"@local/example":"C:/Users/wang/src/ynm3000/example"}}
~~~

~~~powershell
pwsh -NoProfile -File ./dsh-restore.ps1 -PluginManifest ./plugins-web.json -RepoMap "$env:USERPROFILE/.dsh/device/plugin-map.json"
~~~

不是自动扫描磁盘挑第一个同名目录：只接受现有依赖声明的唯一路径、显式映射或工作区相对路径，校验 package.name 与整个包目录的内容指纹（排除 node_modules、.git、缓存等）。源码不同即阻断，先统一 Git 版本。数组映射不支持。

## 执行

先停目标 profile 宿主。第三方或实验插件按项目要求先对 plugtest 验证，再对 web 执行；测试 profile 必须已存在。本工具不替你创建测试 profile。

~~~powershell
pwsh -NoProfile -File ./dsh-restore.ps1 -PluginManifest ./plugins-web.json -Apply -HostStopped
~~~

HostStopped 是操作者已停机的明确声明，不是进程检测。变更前备份配置到 DSH_HOME/backups/pre-plugin-sync-*；调用 dsh plugin add/remove，不直接拼写 profile 依赖。已有 dsh-config-pack 时暂时移除它，按导出顺序登记新增项，最后恢复 config-pack。共享 bundle 顺序不一致时阻断，不猜排序意图。

安装后核验依赖、bundle 顺序、模块身份与实际 Junction 目标、精确 npm 版本；运行 dump-config。仍须重启宿主、刷新网页并验证具体 UI 功能，dump exit=0 不证明前端成功。

## 冲突与回滚

- 目标独有插件保留；没有共同基线不自动传播删除。
- 两端已有 npm spec 字符串不同即冲突；新增或补 bundle 登记的 npm 插件都必须精确版本，不自动选择 latest/范围；实装 engines 仍会复核，不兼容即回滚。
- 声明 engines.dsh 的本地包：当前自动兼容检查只接受与 map.hostVersion 完全相同的版本字符串；范围表达式阻断，需单独完成兼容评审。不会把不能证明兼容的包装进去。
- 单独依赖（不对应 bundle）的新增阻断，需明确依赖安装策略。
- 配置安装失败时自动还原六份关键文件（原先不存在的文件移除），退出非零。node_modules 无法靠恢复配置原子回滚，宿主保持停止，在目标 profile 目录运行 pnpm install 收敛依赖，再验收。备份目录保留。
- 不直接复用源设备 lockfile；由目标机插件 CLI 安装重算依赖。供应链限制/版本冷却由 CLI 执行，实装版本还会复核。

## 与快照恢复的关系

- Snapshot 模式恢复配置文件；PluginManifest 模式合并可移植插件清单，两者不能同次混用。
- 老快照仍有设备绝对路径，本次没有批量改写老快照。
- 本入口不会自动发送文件、自动拉 Git、自动启动宿主或绕过沙箱。
- 回归：node scripts/test-plugin-sync.mjs（A→B→A、来源冲突、路径逃逸、回滚等）。
