# codex-relay 报 MISSING_CREDENTIAL /「API 密钥缺失」诊断（2026-11-13）

## 1. 现象

- profile `web` 的 provider `codex-relay`（baseURL `http://47.101.159.7:39187/v1`）在「设置 → 模型」显示密钥缺失，派发时失败。
- 用户变量里能看到 `CRS_OAI_KEY`（提问里写作 `CRS_OAI_KET`，实际注册名是 **CRS_OAI_KEY**，与配置指针一致）。
- 其余 provider（ais-2dsglm / kimi / opencode / claude-relay / tokeniss 等）都正常。

## 2. 结论（一句话）

密钥值确实存在于 Windows 用户环境变量，但 **DSH 不读注册表**：它只读「启动时冻结的环境快照」或 `~/.dsh/.credentials.yaml`。
当前 `dsh --profile web` 宿主进程（pid 45636，启动于 2026-11-13 12:00:29）继承的启动环境里没有 `CRS_OAI_KEY`，
凭据库里也没有该引用 —— 两条路都落空，pi-ai 适配器遂抛 MISSING_CREDENTIAL。

## 3. 证据链

### 3.1 配置指针

`C:\Users\wwm_1\.dsh\profiles\web\cordis.patch.yml`（约 248-252 行）：

```yaml
codex-relay:
  displayName: Codex Relay
  apiKeyEnv: CRS_OAI_KEY
  api: openai-responses
  baseURL: http://47.101.159.7:39187/v1
```

该指针自 2026-10-08 的备份起一直未变（`cordis.patch.yml.bak-before-standard-codex-20261008-183001` 起全部含 `apiKeyEnv: CRS_OAI_KEY`），不是今天才改坏的。

### 3.2 凭据解析顺序（源码事实）

- `@deepseek-ai/dsh-credentials-local` 头注释：`.credentials.yaml` > 继承的进程环境 > `<cwd>/.env` > `$DSH_HOME/.env`。
- `@deepseek-ai/dsh-launch-environment`：启动环境是**不可变快照**（层：process / project-env / user-env），launcher 在挂载任何插件前就固定；进程启动后再改 Windows 环境变量不会回流。
- `@deepseek-ai/dsh-llm-pi-ai`（lib/index.js:2921-2928）先 `credentials.resolve(ref)`，再 `launchEnvironmentOf(ctx).get(ref)`，都没有就抛：

```text
llm-pi-ai: no credential for provider route "<provider>"; its profile resolves CRS_OAI_KEY, which is not set
```

Web 端对应文案：`credentialMissing: "API 密钥缺失"`。

### 3.3 凭据库现状

`C:\Users\wwm_1\.dsh\.credentials.yaml` 的 `refs:` 只有 8 个引用：OPENCODE_API_KEY / AIS_2DSGLM_API_KEY / LLMKEY_KIMI / DEEPSEEK_API_KEY / CLAUDE_RELAY_TOKEN / TOKENISS_API_KEY / CLAUDETOKENISS25_API_KEY（`records:` 里另有 `client-connection/browser-session`、`llm-pi-ai/openai-codex` OAuth grant）。**没有 `CRS_OAI_KEY`** —— codex-relay 是唯一一条「密钥只靠环境变量、不进凭据库」的路由，所以也只有它挂。

### 3.4 宿主进程环境

在同会话 pwsh 里 dump 环境变量（子进程继承宿主，共 89 项）：`CRS_OAI_KEY` 不存在。与 `HKCU\Environment`（47 项）逐项比对：

- 缺失 14 项，**全部是密钥类**：`CRS_OAI_KEY`、`CODEX_THIRD_PARTY_API_KEY`、`DSHPACK_KEY_AIS/ANTHROPIC_RELAY/CODEX_RELAY/KIMI/OPENCODE`、`llmkey-ark/ds4/kimi/opgo`、`RELAY_API_KEY`、`TENCENT_DOCS_TOKEN`、`ais_dsglm_key_zzq`；
- 33 项非密钥变量全部在位（`DSHPACK_ROUTE_*`、`DSHPACK_BASE_*`、`HF_ENDPOINT` 等）。

即：宿主拿到的是「这批密钥变量被创建/重写之前」的那份环境。

### 3.5 注册表值本身有效

用 `CreateEnvironmentBlock(当前进程 token)` 现场重建一份**全新**用户环境块：84 项，`CRS_OAI_KEY` 存在（长度 67）。
说明变量名与取值都没写错，新进程能拿到；缺的只是「当前这个 DSH 进程是旧环境启动的」。

### 3.6 两个后备层都是空的

- `C:\Users\wwm_1\.dsh\.env`（user-env 层）：不存在
- `D:\src\dsh\.env`（project-env 层）：不存在

## 4. 修复路径（任选其一）

**A. 写进凭据库（推荐：不用重启、立即生效、优先级最高）**

设置 → 模型 → Codex Relay → 编辑 → 填 API Key → 保存。写入 `~/.dsh/.credentials.yaml` 的 `refs.CRS_OAI_KEY`；该文件由 dsh-credentials-local 的 watcher 热发布，不需要重启宿主。注意：文件里的值优先级高于环境变量，日后轮换密钥要改这里。

**B. 让宿主启动时就看见环境变量（保留「只放环境变量」的现有设计）**

必须从**新开**的终端启动：`dsh --profile web`。已开着的终端窗口不会自动获得新变量。此路径会重启宿主，按工作区约束需先停有活动会话的 web 进程，会打断正在跑的回合。

**C. 加 user-env 层（重启更稳，但仍需重启）**

把 `CRS_OAI_KEY=...` 写进 `C:\Users\wwm_1\.dsh\.env`（DSH 的 user-env 层，不进 Git）。代价是密钥同时存在注册表与该文件两处。

**不要**写进 `D:\src\dsh\.env`：那是 project-env 层，会随仓库分发，违反隐私纪律。

## 5. 验收

1. 设置 → 模型：Codex Relay 行的「API 密钥缺失」红点消失；
2. 新会话选择 `codex-relay / gpt-6.1-sol`（或派发一次该路由子代理）能正常出结果；
3. 日志不再出现 `MISSING_CREDENTIAL`。

## 6. 限制

- 本轮只做只读诊断：未写入凭据库、未重启宿主，因此**未做真实请求验证**；
- `http://47.101.159.7:39187/v1` 的连通性与中转额度本轮未验证；
- 宿主 12:00:29 的父进程（pid 38292）已退出，无法直接证明「启动它的终端早于这批密钥变量创建」，只能由 3.4/3.5 的比对反推。

## 7. 下一步唯一动作

由用户选 A 或 B：选 A 时由主控代为把注册表中的值写入 `refs.CRS_OAI_KEY`（不回显密钥），再按第 5 节验收。
