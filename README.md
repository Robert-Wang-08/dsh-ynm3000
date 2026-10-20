# dsh-ynm3000

DSH 插件与配置的总仓库。各插件仍是独立仓库，这里只用 submodule 记下路径、远程地址和当前提交。

克隆：

```powershell
git clone --recurse-submodules https://github.com/Robert-Wang-08/dsh-ynm3000.git D:\src\dsh
# ↑ D:\src\dsh 只是源设备的安装实例（示例路径），按本机实际选择，后续命令同步替换。
```

已关联：

- `dsh-archived-sessions`
- `dsh-config-pack`
- `dsh-permission-compat`
- `dsh-plugin-provider-badge`
- `dsh-plugin-sidebar-visibility`
- `dsh-provider-failover`

下面三份还没有独立远程仓库，源码直接放在本仓库里：

- `dsh-plugin-ptc-switches`
- `dsh-plugin-subagent-monitor`
- `dsh-subagent-acp-resilient`

根目录的 `dsh-menu.ps1` 是本机运维入口。公开发布的一键安装仍走 `dsh-config-pack` 的 GitHub tag，不从本仓库安装。

## 新设备安装

在 `dsh-config-pack` 里一条命令。有共享盘就读已经填好的答案；没有就用包内模板，或把说明交给 AI。然后装包、写路由、设置用户环境变量。密钥不进答案文件。

**让 AI 自动配置（推荐入口）**：把 [`docs/bootstrap/PROMPT-新设备装机-引导.md`](docs/bootstrap/PROMPT-新设备装机-引导.md) 整段交给新设备的 AI 代理执行——它覆盖装依赖、装 DSH（钉 `0.2.0-rc.2`）、克隆本仓库群、从共享盘一键还原、验收与报告。三方插件（recent-sessions / dshmarket / director / palette）默认安装，prompt 里有 `-SkipOptional` 跳过开关。

没有共享盘、交给 AI 时，让 AI 读 `dsh-config-pack/docs/AI-DEVICE-SETUP.md`。生成的文件放到 `%USERPROFILE%\.dsh\device\`，再重新运行下面的命令。

共享盘答案的**参考位置**是 SkillHub 下的 `dsh-device`（`device.env` 和 `route-config.json`），不提交到 Git。若你用自己的个人数据同步盘，请按此命名放置（`dsh-device\device.env`，可选 `device-answers.json` / `route-config.json`），`setup.ps1` 按该约定读取。日常 profile 是 `web`。`web-restore` 只在本机做验证，不作为提交内容。

![新设备安装](attachments/readme_setup-flow_v1.svg)

英文图：[setup-flow_v1_en.svg](attachments/setup-flow_v1_en.svg)

```powershell
pwsh -File dsh-config-pack\scripts\setup.ps1 -Source 'github:Robert-Wang-08/dsh-config-pack#v0.9.0'
```

```mermaid
flowchart TD
  A["运行 setup.ps1"] --> B{"有共享盘?"}
  B -->|有| C["读取 device.env"]
  B -->|没有| D["模板，或让 AI 读 AI-DEVICE-SETUP.md"]
  C --> E["install.ps1 装 Git 包"]
  D --> E
  E --> F["写入 route-config.json"]
  F --> G["设置用户环境变量"]
  G --> H["重启 DSH 并新开会话"]
```
