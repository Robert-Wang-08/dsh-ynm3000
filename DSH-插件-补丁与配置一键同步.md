# DSH 插件 / 补丁 / 配置 一键同步说明

适用：本机 DSH（DeepSeek Harness）Web profile 的插件、bundle 补丁与配置同步。
所有命令在 PowerShell 中执行；`<p>` 代表 profile 名（本文以 `web` 为例）。

---

## 0. 先分清四层（80% 的“改了不生效”都出在这里）

| 层级 | 位置 | 作用 | 覆盖关系 |
|---|---|---|---|
| 1. 内置 bundle | DSH 自带（`@deepseek-ai/dsh-base`、`dsh-web-app`） | 基础工具与服务 | 最先，被后面覆盖 |
| 2. Git 配置包 | `D:\src\dsh\dsh-config-pack`（`config/*.yml` + `cordis.patch.yml`） | 通用模型路由、ACP 子代理、MCP、开关 | 中间层 |
| 3. 目标 profile 补丁 | `%USERPROFILE%\.dsh\profiles\<p>\cordis.patch.yml` | 本机私有覆盖 | **最后一层，按行 id 覆盖，后写胜** |
| 4. agent preset | 各 bundle 内的 preset 行 | 决定**这个会话能看到哪些工具** | 受 1–3 影响 |

关键规则：profile 补丁里出现与配置包**同 id** 的行，会静默遮蔽配置包。`verify.mjs --profile` 会把这种情况报成错误。

---

## 1. 来源 → 落点 对照表

| 要同步的东西 | 唯一来源 | 落点 |
|---|---|---|
| 通用配置包 | `D:\src\dsh\dsh-config-pack`（Git tag） | profile 的 `node_modules` + bundle 登记 |
| ACP 抗性插件 | `D:\src\dsh\dsh-subagent-acp-resilient` | profile `dependencies` 的 `link:` |
| PTC 多代理资产 | SkillHub canonical：`D:\nutstore\Skill+Tool\skillhub\store\installed\ptc-multi-agent-control` | profile `node_modules\@local\dsh-ptc-multi-agent-mode` 的 **junction** |
| 本机路由策略 | `%USERPROFILE%\.dsh\plugins\provider-failover\route-config.json` | failover 插件读取 |
| 其它本地插件 | 各自仓库（`dsh-provider-failover`、`dsh-plugin-*` 等） | profile `dependencies` 的 `link:` |

**不要**手工改 `node_modules` 里的内容；它要么是 pnpm 生成的，要么是 junction。

---

## 2. 一键同步

### 2.1 装 / 升级通用配置包（推荐入口）

```powershell
pwsh -File D:\src\dsh\dsh-config-pack\scripts\install.ps1 `
  -ProfileName web `
  -Source 'github:Robert-Wang-08/dsh-config-pack#v0.8.1'
```

脚本会一次性代做：profile 不存在则从发行模板创建 → 写 pnpm 前置（`blockExoticSubdeps: false`、`nodeLinker: hoisted`、`allowBuilds`）→ **只调一次** `dsh plugin add` → 失败按 pnpm 错误码有界自愈重试（≤3 次）→ 校验 bundle 已登记并跑只读校验。

它只改 pnpm 配置，**不改写** `cordis.patch.yml`。
其它参数：`-FromDefaultProfile`（默认 `web`）、`-Uninstall`。

### 2.2 手工等价命令（需要精确控制时）

```powershell
# 安装；注意把本包放在参数最后
dsh plugin --profile web add @deepseek-ai/dsh-subagent-acp@0.2.0-rc.2 `
  '@deepseek-ai/dsh-subagent-claude-code@0.2.0-rc.2' `
  github:Robert-Wang-08/dsh-config-pack#v0.6.0

# 卸载
dsh plugin --profile web remove dsh-config-pack
```

git 宿主依赖有前置：profile 的 `pnpm-workspace.yaml` 必须先写 `blockExoticSubdeps: false` 与 `allowBuilds`，否则报 `ERR_PNPM_EXOTIC_SUBDEP` / `ERR_PNPM_IGNORED_BUILDS`。

### 2.3 同步本地插件链接（link: 依赖）

在 profile 的 `package.json` 中声明，然后重装一次：

```powershell
# 例：ACP 抗性插件与 PTC 资产
# "@local/dsh-subagent-acp-resilient": "link:D:/src/dsh/dsh-subagent-acp-resilient"
# "@local/dsh-ptc-multi-agent-mode":    "link:D:/nutstore/Skill+Tool/skillhub/store/installed/ptc-multi-agent-control/assets/dsh-bundle"
dsh plugin --profile web add @local/dsh-subagent-acp-resilient @local/dsh-ptc-multi-agent-mode
```

### 2.4 同步 SkillHub 资产（PTC bundle）

PTC 资产的**唯一正本**在坚果云 SkillHub store，IDE 侧是 junction：

```powershell
# 1) 确认 junction 指向正本（不是旧 D:\src\ynm3000\skillhub 的残留）
Get-Item "$env:USERPROFILE\.dsh\profiles\web\node_modules\@local\dsh-ptc-multi-agent-mode" |
  Format-List FullName,LinkType,Target

# 2) 正本改动后重新登记哈希
python D:\src\ynm3000\skillhub\skillhub.py --root "D:\nutstore\Skill+Tool\skillhub" show ptc-multi-agent-control
```

**双 store 陷阱**：机器上同时存在 `D:\src\ynm3000\skillhub`（旧）与 `D:\nutstore\Skill+Tool\skillhub`（正本）。registry 里的 `source.path` 可能仍指向旧路径，属陈旧元数据，不要据此判断正本位置。

### 2.5 生成公开伴随包（面向外部用户）

```powershell
node D:\src\dsh\dsh-config-pack\scripts\generate-ptc-companion.mjs --interactive --out <本地目录>
node D:\src\dsh\dsh-config-pack\scripts\generate-ptc-companion.mjs --answers <answers.json> --out <本地目录> --dry-run
node D:\src\dsh\dsh-config-pack\scripts\generate-ptc-companion.mjs --answers <answers.json> --out <本地目录>
```

### 2.6 发布（维护者）

```powershell
pwsh -File D:\src\dsh\dsh-config-pack\scripts\release.ps1 -Note "<本次变更说明>"
```

CHANGELOG 由该脚本维护；不要手工在顶部插条目。

---

## 3. 每次同步后的校验（必做）

```powershell
cd D:\src\dsh\dsh-config-pack
node scripts/verify.mjs                      # 包自检：id 独占、!!js 合法、provider 唯一
node scripts/verify.mjs --profile web        # 额外检查 profile 是否遮蔽本包 id
dsh --profile web --dump-config > composed.yml
node scripts/verify.mjs --composed composed.yml   # 组合结果：工具行、provider 悬空
```

`--dump-config` 的两个局限：

1. 它回显的是**未求值**的补丁源，不能证明 `!!js` 表达式在运行时取到了什么值；
2. 长表达式会被截断。

所以“配置里写了”不等于“运行时可执行”。要判定可用性，必须在**新会话**里实调一次。

---

## 4. 生效条件（不满足就白改）

| 改动 | 是否需要重启 DSH | 是否需要新建顶层会话 |
|---|---|---|
| `cordis.patch.yml` 补丁行 | 需要（`patchReload: live` 只覆盖部分场景） | 工具表变化时**需要** |
| 环境变量开关（`DSHPACK_*`、`PTC_*`） | **需要**（env 不进入已运行进程） | 需要 |
| 模型白名单 / provider 目录 | 需要 | **需要** |
| skill 文件（`SKILL.md`） | 不需要 | 重新加载 skill 即可 |

**工具表与模型白名单在会话启动时冻结**：新增工具（如 `subagent_codex_astra`、`subagent_claude_opus5_plan`）或把新模型加入白名单后，必须重启 DSH 并**新建顶层会话**；在旧会话里会报 `child LLM route "..." is not allowed for this Session`。

---

## 5. 常见失败与处置

| 现象 | 原因 | 处置 |
|---|---|---|
| `ERR_PNPM_EXOTIC_SUBDEP` | pnpm 未允许 git 宿主依赖 | 先写 `blockExoticSubdeps: false`，再 `dsh plugin add` |
| `ERR_PNPM_IGNORED_BUILDS` | 构建脚本未被允许 | 在 `allowBuilds` 中登记后重试 |
| “装上了但整包不生效” | 首次 add 失败后重试，DSH 不再为新依赖登记 bundle | 用 `install.ps1`（保证一次成功），或 remove 后重装 |
| 配置包某行没生效 | profile 补丁同 id 遮蔽 | `verify.mjs --profile web` 定位后删除该行 |
| 工具不存在 / 模型被拒 | 旧会话冻结 | 重启 DSH + 新建顶层会话 |
| junction 指向旧 store | SkillHub 双 store 遗留 | 重建 junction 到 `D:\nutstore\...\store\installed\...` |
| `--dump-config` 看起来对但运行不对 | 看到的是未求值源 | 新会话实调验证 |

---

## 6. 回滚

```powershell
# 1) 备份（本地状态，切勿提交）
Copy-Item "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml" "$env:TEMP\cordis.patch.yml.bak"
Copy-Item "$env:USERPROFILE\.dsh\profiles\web\package.json"     "$env:TEMP\package.json.bak"

# 2) 卸载并回到指定 tag
dsh plugin --profile web remove dsh-config-pack
dsh plugin --profile web add github:Robert-Wang-08/dsh-config-pack#<上一个 tag>

# 3) 校验
node D:\src\dsh\dsh-config-pack\scripts\verify.mjs --profile web
```

---

## 7. 一键清单（复制粘贴）

```powershell
$pack = 'D:\src\dsh\dsh-config-pack'
$ver  = 'v0.8.1'

# 1. 升级配置包
pwsh -File "$pack\scripts\install.ps1" -ProfileName web -Source "github:Robert-Wang-08/dsh-config-pack#$ver"

# 2. 校验（三层）
Set-Location $pack
node scripts/verify.mjs
node scripts/verify.mjs --profile web
dsh --profile web --dump-config > "$env:TEMP\composed.yml"
node scripts/verify.mjs --composed "$env:TEMP\composed.yml"

# 3. 重启 DSH，然后新建顶层会话
# 4. 在新会话里实调一次你刚改的那条路由，确认可用
```

---

## 8. 禁止事项

- 不把 profile 本地状态（`%USERPROFILE%\.dsh\profiles\<p>\*`）提交到任何仓库；
- 不提交 `.ptc/`（工作区本地运行态）；
- 不手工编辑 `node_modules` 内容；
- 不用 `git add .`，只暂存已复核的显式路径；
- 不在旧会话里验证新增工具或新白名单模型；
- 不把“配置里写了”当作“可以执行”。
