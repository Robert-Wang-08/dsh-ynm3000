---
origin: self
owner: wang
author: wang
created: 2026-10-20
updated: 2026-10-21
version: 0.2.2
asset-type: prompt
source: dsh-ynm3000
skillhub-source: not-managed
---

# 引导 prompt：新设备下载 DSH 仓库群并一键恢复配置

> 用法：在新设备的 AI 代理（任意有 shell 权限的 CLI 代理）里整段粘贴下面的 prompt。
> 它覆盖：装依赖 → 装 DSH → 克隆本总仓库（仓库群）→ 从共享盘一键恢复 → 验收。
> 没有共享盘的设备不用本 prompt，改让 AI 读 `dsh-config-pack/docs/AI-DEVICE-SETUP.md`。

## 可直接执行的 prompt

# 任务：新设备从零安装 DSH 并跨设备还原配置（前导同步）

你在一台新的 Windows 设备上工作。这台设备**还没有安装 DSH**。你的职责：装好依赖与 DSH，
把插件/配置源码同步下来，然后从共享盘答案完成一键还原，最后按清单验收。
逐步执行，每步先检查是否已完成（幂等），完成一项报告一项再进行下一项。

## 背景（渠道纪律，必须遵守）

- 通用配置唯一发布源：Git `Robert-Wang-08/dsh-config-pack`（tag 发布，当前 v0.10.4）。
- 设备个人答案的**参考位置**在云盘（如坚果云）的 `dsh-device\device.env`（只有变量名/路由名，**没有密钥值**）。
  若你自己另有个人数据同步盘，请按同样的命名放置：`dsh-device\device.env`，可选同目录
  `device-answers.json` / `route-config.json`——`setup.ps1` 按此约定读取，不硬编码盘符。
- 密钥只进用户环境变量；**绝不**把密钥写进 device.env、route-config.json、任何文件或 Git。
- `.credentials.yaml` 不跨设备，不从共享盘找它；密钥在 setup 交互时输入。
- 全程不要 `git push`，不要手改 profile 的 `package.json`，插件增删只用 `dsh plugin` 命令。

## 路径约定（隐私：先替换再执行）

下文出现的 `D:\src\dsh`（仓库根）与 `D:\nutstore\Skill+Tool\skillhub`（云盘根）只是**源设备的安装实例（示例）**，不是规定位置，也不要原样照抄进本机或报告。执行前先确定本机实际路径并全程替换：

- `<仓库根>` = 第 4 步 clone 本总仓库的目标目录（安装实例：`D:\src\dsh`）；
- `<云盘根>` = 第 3 步定位到的云盘同步根（安装实例：`D:\nutstore\Skill+Tool\skillhub`）。

## 步骤

1. **前置检查**（缺什么装什么）：
   - `git --version`；`pwsh --version`（需 PowerShell 7，缺则 `winget install Microsoft.PowerShell`）；
   - `node --version`（建议 nvm-windows + v24.18.0，与源设备一致）；
   - `pnpm --version`（缺则 `npm i -g pnpm`）。
2. **安装 DSH（钉版本）**：`npm install -g @deepseek-ai/dsh@0.2.0-rc.2`，然后 `dsh --version` 确认。
   （npm latest 已更高，但本流程只在 0.2.0-rc.2 上验证过，不要擅自换版本。）
3. **定位云盘**：找到云盘（如坚果云）同步根下含 `dsh-device\device.env` 的目录，记为 `<云盘根>`
   （源设备安装实例：`D:\nutstore\Skill+Tool\skillhub`，本机盘符可能不同）。
   若云盘未登录或该目录不存在，**停下来问用户**，不要猜路径。
4. **克隆总仓库**（仓库群入口，含全部插件子仓库与本引导文件），目标目录记为 `<仓库根>`：
   ```powershell
   git clone --recurse-submodules https://github.com/Robert-Wang-08/dsh-ynm3000.git <仓库根>
   git -C <仓库根> submodule status   # dsh-config-pack 应在 v0.10.4 对应提交或更新
   ```
   （源设备安装实例：`<仓库根>` = `D:\src\dsh`。）
   注意：不要去找源设备 `D:\src\ynm3000` 下的旧路径——那里的残留与本安装无关，插件的权威副本在本总仓库里。
5. **一键还原**（读共享盘答案 → 设 DSHPACK_* 用户环境变量 → 写路由 → 装包进 profile `packed`
   → 默认补装可选三方插件组）：
   ```powershell
   pwsh -File <仓库根>\dsh-config-pack\scripts\setup.ps1 `
        -SharedRoot <云盘根>
   ```
   - 不传 `-Source` 即自动取远端最新 tag（install.ps1 内置解析）；只有要钉死版本时才显式传
     `-Source 'github:Robert-Wang-08/dsh-config-pack#vX.Y.Z'`。
   - 可选三方插件组（`dsh-recent-sessions`、`dshmarket`、`dsh-plugin-subagent-director`、
     `dsh-palette`）**默认安装**；用户明确不要时加 `-SkipOptional` 整组跳过。
   - 提示 `DSHPACK_KEY_*` 时输入真实密钥（直接回车=跳过，之后可手动补用户环境变量）。
   - 若报 `ERR_PNPM_EXOTIC_SUBDEP` / `ERR_PNPM_IGNORED_BUILDS`：install.ps1 会自愈重试；
     仍失败时把完整报错给用户，不要手改配置硬闯。
   - **总仓库里的本地插件不随 `setup.ps1` 自动登记**（config-pack 只管它自己那套 bundle），
     需在还原之后逐个 `dsh plugin add`，源码直接来自本仓库、代码不复制：
     ```powershell
     dsh plugin --profile <profile> add <仓库根>\dsh-subagent-acp-resilient
     dsh plugin --profile <profile> add <仓库根>\dsh-plugin-ptc-switches
     dsh plugin --profile <profile> add <仓库根>\dsh-plugin-subagent-monitor
     dsh plugin --profile <profile> add <仓库根>\dsh-plugin-new-session
     ```
     逐个 add：参数顺序即 bundle 顺序，不要与 config-pack 混在同一次调用里。
     登记后 `git -C <仓库根> pull` 即更新这些插件，**不需要重新 add**。
     确认方法：`dsh plugin --profile <profile> list` 里能看到它们，且
     `dsh --profile <profile> --dump-config` 无 `patch: entry ... not found`。
6. **安装后偏差比较验收**（install.ps1 第 4.6 步已自动跑过一次；手动复核用同一条命令）：
   ```powershell
   node <仓库根>\dsh-config-pack\scripts\verify-install.mjs --profile packed
   # 可选：对拍另一台设备的观察基线（逐包版本 + 采样文件 SHA256）
   node <仓库根>\dsh-config-pack\scripts\verify-install.mjs --profile packed `
        --baseline <仓库根>\docs\verification\new-device-packed-observed-20261020.json
   ```
   预期：核心件全 ok、可选组默认已装、bundle 登记齐全、composed 0 dangling、
   无 `did not activate` / `patch entry not found`。
   判读：missing(核心件) 必须处理；optional missing 若因 -SkipOptional 属预期；
   shadowing / 设备字面量 / 偏好差异属已知设备差异，不算失败。
   **若 `dsh plugin` 报 `ERR_PNPM_UNEXPECTED_STORE` 或 `ERR_PNPM_PREPARE_PACKAGE`**：
   这是 pnpm store 与本机 profile 的 `.modules.yaml` 记录不一致，按
   `docs/bootstrap/pnpm-store-与重链.md` 先统一 store 再重链该 profile，然后回到本步骤。
7. **生效**：关掉 DSH 重新打开（首次直接 `dsh web` 启动，默认 http://127.0.0.1:3080），
   **新开一个会话**（工具表在会话启动时冻结，旧会话看不到新工具），
   在新会话里实际派发一次子代理验证路由可用。
8. **报告**：列出实际使用的共享盘路径、profile 名、config-pack tag、可选组安装结果、
   验收三项输出摘要；如有跳过的密钥项，单独提醒用户补。

## 范围外（不要主动做）

- SkillHub skills 跨设备同步（junction/`sync publish`）不在本次范围，用户提出再说；
- 不装 dsh-backup-restore 的本机快照（那是源设备同机恢复用的，与跨设备无关）；
- 不改 DSH 本体、不动 `C:\Users\<用户>\.dsh` 里本任务未涉及的文件；
- 只读审计类任务（对照基线核对偏差）另有专门 prompt：
  `docs/verification/PROMPT-另一设备核对DSH同步偏差.md`。
