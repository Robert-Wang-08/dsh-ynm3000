---
origin: self
owner: wang
author: wang
created: 2026-10-20
updated: 2026-10-20
version: 0.1.0
asset-type: prompt
source: dsh-ynm3000
skillhub-source: not-managed
---

# 另一设备核对 DSH 同步偏差

Git 同步本目录两份文件后，将下面的 prompt 交给另一台设备的 Codex 执行。它会核对该设备的实际安装，输出差异；不会自动安装、升级或覆盖配置。

配套文件：`new-device-packed-observed-20261020.json`。这是一台新设备完成安装后的**观察基线**，不是源设备的完整期望清单，也不是新的发布源。

## 可直接执行的 prompt

请核对本设备与另一台新设备的 DSH 安装、插件和配置是否存在偏差，重点查明 Recent Sessions 为什么没有随本轮同步安装。

本任务是只读审计。先完成检查和报告，不修改插件、profile、配置包、环境变量、共享盘或 SkillHub registry，不重启/停止现有服务，不发起模型付费调用，不执行 git commit/push。允许在本机非 Git、非同步目录保存脱敏检查报告和临时文件。发现偏差先解释证据和修复方案，不把两台设备强制改成相同状态。

### 1. 读取规则并确定事实来源

1. 读取本地仓库 `AGENTS.md`、`DSH-插件-补丁与配置一键同步.md`，以及本机可找到的 `dsh-preset-pack` 指导 skill。需要路由审计时再读取对应 skill。若文档冲突，遵循用户指令及适用的仓库规则，记录冲突，不套用旧路径或旧 tag。
2. 读取与本 prompt 同目录的 `new-device-packed-observed-20261020.json`。保留其中的观察时间、安装入口和证据边界；不要把 `knownMissing` 解释成禁止安装列表。
3. Git `Robert-Wang-08/dsh-config-pack` 的 tag 仍是通用配置唯一发布源。本 prompt 和观察基线不替代 `pack.manifest.yaml` 的发布组件锁。
4. 先检查本地已有 Git 同步状态和子模块状态，不自动 pull、checkout、reset 或更新子模块。工作区脏改动必须保留。若未拿到配套文件，报告缺失，不自行重建成“相同”结果。

### 2. 定位本设备实际使用的安装

- 确认 DSH CLI 的实际路径和版本，以及实际 `DSH_HOME`。不要从工作目录推断。
- 核对现有运行进程、命令行与 profile 目录。基线的 profile 是 `packed`；本设备若日常使用 `web` 或其他 profile，明确标记对应关系，分别审计日常 profile 与存在的 `packed`，不要为了比较而创建新 profile。
- 只读定位本机 DSH 总仓库与共享盘答案目录，不硬编码盘符、用户名或源设备绝对路径。确认 PTC 链接实际落点及其权威来源，区分失效链接、旧副本和当前正本；不执行全局 skills 同步。
- 不读取 `.credentials.yaml`、CLI 登录文件、会话历史或附件。环境变量只检查指定凭据引用名是否存在，禁止读取、显示、导出密钥值。不要整批导出环境变量。

### 3. 导出实际完整插件清单

对每个需要比较的 profile：

1. 运行 `dsh plugin --profile <p> list`，并只读检查 profile 的 `package.json`、锁文件和实际 `node_modules`。
2. 以直接依赖为基础，同时检查 bundles 中存在而直接依赖没有声明的项目，以及配置实际消费但未能解析的项目。区分直接依赖、传递依赖、普通运行依赖、profile bundle、宿主补丁工具，不把它们混算。
3. 逐项记录：实际包名、版本、来源类型（npm/Git tag/link）、可移植来源位置、实际解析包名、bundle 声明、bundle 是否登记、实际顺序、入口文件存在性。
4. 对 `link:` 记录解析后的真实目标及是否失效；Git 组件记录 HEAD、仓库根和 dirty 状态。同在总仓库内的源码只能记录“总仓库 commit + 相对路径”，不能把总仓库 SHA 当作独立组件仓库 SHA 比较。
5. 按包名比较基线的 `sampledArtifacts`：对实际文件计算 SHA256。缺失文件明确报缺失；相同版本但 commit/文件不同也要报。哈希采样只覆盖列出的文件，不声称已检查全部包内容或全部传递依赖。
6. 别名需同时保留原登记名与实际包名，例如 `dsh-archived-sessions` / `@jiangdaoli/dsh-archived-sessions`、`dsh-plugin-sidebar-visibility` / `@local/dsh-plugin-sidebar-visibility`。先检查是不是同一个包，避免把别名误算成漏装或重复。
7. 普通依赖没有 `dsh.bundle` 不等于漏激活；基线中的官方 ACP 和 ACP 抗性插件就是普通依赖。

### 4. 专门核对 Recent Sessions 及已知版本差异

- 查找 **`@yfwu2020/dsh-recent-sessions`**：在本设备是否安装、装在哪个 profile、具体版本、来源 spec、锁文件解析结果、bundle 登记及入口文件。
- 新设备观察基线没有这个包；查询时 npm 公开最新版本是 `0.2.3`，这不证明源设备安装的也是 `0.2.3`。本次以本设备实际安装证据为准，禁止自动采用 latest。
- 查它是否被总仓库、config-pack tag 的依赖/组件锁/安装脚本实际覆盖。若它仅在源设备 profile 中手工登记，则明确解释“为何克隆总仓库和装 config-pack 不会把它带过去”。
- 区分三方：本设备日常实际安装、新设备观察基线、config-pack 发布锁。不得把任意两者混成同一个期望清单。
- 已知需重点复核：新设备 Provider Badge 是 `0.2.1 / cccdbed21c6212701739cef21c207a8cb3646448`，发布锁是 `v0.1.0 / 84873291a3c8bdb085aee9bef4efe3b7d5b167e0`；Failover 均标 `3.4.0`，但新设备是 `40a99181c8f65e8603d49cc3fe7eca847143faf4`，发布锁是 `d0c6c2d6c1b0af78a0fbb60e89d86c4571b41f0e`。
- 基线的 config-pack 安装源是 `#v0.7.0`，tag 解引用提交为 `df2b9b69d337c90d2ab31291f4cee23d98ad707b`；源码子模块检出与已安装 tag 可能不同，必须分开报告。
- 总仓库后续仅添加本审计文档导致 HEAD 改变，不自动等同于插件代码变化；进一步检查对应源码相对路径的树或文件差异。

### 5. 核对配置，保护设备差异

- 检查 config-pack tag/解析提交、PTC bundle 版本和补丁指纹、bundle 顺序，以及 profile 层是否遮蔽配置包 owns id。
- 检查本机路由层是否存在、schema/route/model/档位/开关是否合理，是否与本设备共享盘答案对应。个人答案和路由只在本机审计，不复制到 Git。
- 检查默认 provider/model、所选 preset、ACP/MCP 开关的用户级设置与当前进程生效证据；持久化配置与运行态无法交叉核实时，写“运行态未验证”。
- 密钥指针只显示变量名及存在性。基线 JSON 特意不携带任何设备个人答案、凭据变量状态或配置原文；需要跨设备比较的个人偏好仍以共享盘个人答案及用户说明为依据，资料不足就列“待核对”，不能猜相同。
- 盘符、家目录、绝对链接路径、CLI 登录态和凭据状态允许因设备不同，归为“设备差异”；默认模型、路由等语义不同需单列解释，不能全归为路径差异。
- 不把 profile 的整个 package.json/pnpm-lock 哈希差异直接当成功能偏差；路径和安装方式本身会改变这些文件。不同构建工具版本、行尾、source map 或绝对路径造成的产物差异，需要进一步归因，不直接声称源码不同或功能等价。

### 6. 执行适用的只读校验

先确认脚本和参数存在，使用本机真实路径与 profile：

```powershell
node <pack>/scripts/verify-components.mjs --offline
node <pack>/scripts/verify.mjs --profile <p>
dsh --profile <p> --dump-config > <本机私有临时目录>/composed.yml
node <pack>/scripts/verify.mjs --composed <本机私有临时目录>/composed.yml
```

- 如需验证发布 tag 未漂移，可运行 `verify-components.mjs` 的联网模式，记录联网状态；联网失败不能改称通过。
- 记录每条命令退出码及错误摘要，检查 stderr 是否有 `did not activate` / `patch: entry ... not found`。不要回显完整配置 dump，其中可能含本机私密内容。
- `verify-components` 检查发布声明及 tag，不直接证明 profile 的 link 组件与锁一致；`0 dangling` 也不证明插件齐全、真实调用可用或 UI 已渲染。
- 本轮不启动新服务、不重启现有服务、不创建模型会话。运行/UI/真实调用没有直接证据时，明确列为未验证。

### 7. 交付报告与修复计划

将本机原始清单、必要证据及报告保存到本机非同步目录，例如 `$env:USERPROFILE/.dsh/device/inventory/`。最终回复给出本机绝对路径。不要把完整 profile、设备路径、个人答案或原始日志写进此 Git 仓库。

报告至少包含：

1. 本设备与基线各自的来源、profile、DSH/config-pack 版本和采集时间。
2. 对照表：`逻辑组件 | 基线实际版本/来源/commit | 本设备实际版本/来源/commit | bundle/文件证据 | 结论`。
3. 将结果分为：一致、缺失/多装、版本或代码偏差、登记/顺序/入口异常、允许的设备差异、证据不足。
4. Recent Sessions 的精确安装版本、spec、所属 profile，以及应补入哪一份发布/同步清单才能避免再次漏装。若本设备也没有或来源不明，直说，不能拿 npm latest 充当源设备版本。
5. 逐项区分“偏离另一设备观察基线”与“偏离 config-pack 发布锁”；观察基线已有的偏差不得被自动纠正成新的统一标准。
6. 每条只读校验的结果，以及运行态/UI/新会话调用的验证边界。
7. 给出最小修复命令、备份/回滚方式及需要用户决定的统一基线。插件增删只能用 `dsh plugin`，不得手改 profile package.json；配置包放最后。仅提出方案，不执行安装/改配置/发布。

最终结论只能是“在已核对范围内一致”“存在偏差”或“证据不足”，并说明未核对范围。不得仅凭 tag 相同、版本号相同、Git 同步完成或 `0 dangling` 宣布完全一致。
