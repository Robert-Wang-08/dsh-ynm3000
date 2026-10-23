# pnpm store 与 profile 重链（运维手册）

> 适用：`dsh plugin add/remove` 装不上、卸不掉、或换机/换盘后插件体系异常。
> 与具体设备绑定的 store 绝对路径**不写在本文件**，写在 `~/.dsh/device/device.env`。

## 1. 一句话原理

`dsh plugin` 底层调用 pnpm。pnpm 把**本次安装所用的 store** 记录在
`<profile>/node_modules/.modules.yaml` 的 `storeDir` 字段。之后每一次 pnpm 操作都会先把
**当前配置的 store** 与这个记录比对：

| 情况 | 结果 |
| --- | --- |
| 一致 | 正常 |
| 不一致 | `ERR_PNPM_UNEXPECTED_STORE`，命令直接失败 |
| store 不可写/无法 prepare | `ERR_PNPM_PREPARE_PACKAGE`（常见于 git 宿主依赖） |

所以「store 统一」= **全局配置** 与 **每个 profile 的 `.modules.yaml`** 指向同一路径。
两者缺一都不算统一。

## 2. 诊断（30 秒）

```powershell
pnpm config get store-dir
Get-ChildItem "$env:USERPROFILE\.dsh\profiles" -Directory | ForEach-Object {
  $y = Join-Path $_.FullName "node_modules\.modules.yaml"
  if (Test-Path $y) { $_.Name + " -> " + ((Select-String -Path $y -Pattern storeDir | Select-Object -First 1).Line.Trim()) }
}
```

输出里出现两个不同路径，就是本手册要处理的问题。

## 3. 统一到哪个 store

**选已经在用、且能完成 git 包 prepare 的那个**，而不是「默认位置」。判定顺序：

1. 先看哪个 store 能成功跑完一次 `dsh plugin add`（唯一硬判据）；
2. 再看它是否独占磁盘大头（迁移成本）；
3. 两者冲突时，以 1 为准——**能用的 store 优先**。

改全局配置：

```powershell
pnpm config set store-dir <可用 store 路径> --location=global
pnpm config get store-dir      # 回读确认，不得为 undefined
```

## 4. 重链一个 profile（改配置之后必做）

> ⚠️ **目标 profile 不能正在运行**。Windows 会锁住 `node_modules` 里的原生模块，重装必失败。
> 本机 `dsh --profile web` 是常驻服务，重链 `web` 必须先退出 DSH。

```powershell
$profile = "$env:USERPROFILE\.dsh\profiles\<profile>"

# 1) 旁路旧目录（保留回滚）
Rename-Item (Join-Path $profile "node_modules") "node_modules.oldstore"

# 2) 用统一后的 store 重装
Push-Location $profile
$env:CI = 'true'            # 非交互环境必须，否则 pnpm 会等确认
pnpm install
Write-Output ("installExit=" + $LASTEXITCODE)
Pop-Location

# 3) 确认记录已切换
Select-String -Path (Join-Path $profile "node_modules\.modules.yaml") -Pattern storeDir

# 4) 验收（这一步通过才算完成）
dsh plugin --profile <profile> list
```

验收判据：`list` 退出码 0、包数与重链前一致、`storeDir` 与 `pnpm config get store-dir` 相同。

### 回滚

```powershell
# 重装失败时：把半成品挪开，恢复原目录
Rename-Item (Join-Path $profile "node_modules") "node_modules.failed-<时间戳>"
Rename-Item (Join-Path $profile "node_modules.oldstore") "node_modules"
```

## 5. 两个真实失败模式（2026-10-23 本机实测）

### 5.1 `ERR_PNPM_UNEXPECTED_STORE`

报错原文含 `pnpm now wants to use the store at "<路径A>" to link dependencies`，
而 `.modules.yaml` 记录的是 `<路径B>`。原因通常是：曾经为了绕开 ACL/沙箱问题临时改过
`$env:pnpm_config_store_dir` 装过一次，之后又改回默认配置。
**只改全局配置不会自愈**，必须按 §4 重链。

### 5.2 `ERR_PNPM_PREPARE_PACKAGE`

```
[ERR_PNPM_PREPARE_PACKAGE] Failed to prepare git-hosted package fetched from
  "https://codeload.github.com/<owner>/<repo>/tar.gz/<sha>": <pkg> pnpm-install: Exit status 1
```

含义：pnpm 把 git 依赖解到 `<store>/tmp/<临目录>` 后再跑它自己的 `prepare`，该步骤失败。
**同一个依赖在 store A 成功、在 store B 失败**时，问题在 store B 的可写性/ACL，不在包本身。
本例中默认 store 的 `tmp` 无法执行 prepare，换 store 后立刻成功。

## 6. 设备本地需要记什么

写进 `~/.dsh/device/device.env`（跟随共享盘同步，不进 Git）：

```ini
# pnpm store：profile 的 node_modules 必须与之保持一致
DSHPACK_PNPM_STORE=<本机统一后的 store 绝对路径>
```

这不是密钥，只是设备路径；换设备时按 §3 重新判定，不要照抄。

## 7. 顺带结论（与 store 无关但常被误判为 store 问题）

- 单次 `dsh plugin add/remove` 的 4~5 分钟主要耗在**镜像对跨平台二进制的 403 重试**
  （`claude-agent-sdk-{darwin,linux,win32}-*`、`@openai/codex`、`libreoffice-kit-*`），
  不是 store 慢。确认这些平台包用不到时，用 `install.ps1 -NoRetry` 或
  `npm_config_fetch_retries=0` 可省掉重试等待。
- 打开 `fetch-retries=0` 后仍可能出现一次 `Will retry in 1 minute. 1 retries left` 日志，
  那是 pnpm 自身对**可选依赖**的行为，不影响最终退出码。
