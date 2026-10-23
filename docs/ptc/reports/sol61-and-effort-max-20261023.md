# 5.6→6.1 切换顺序统一 + ds4.1-flash 默认档位 max（2026-10-23）

- 根任务：`task-20261023T023539227240Z-128c1bad261b`（契约 `sol61-and-effort-max-20261023`，hash `992412167ae5dc86f86bc02846e19ccfa5f933bf15941090a019eab476e5c0b9`）
- 落点：`~/.dsh`（本机运行期）、`dsh-config-pack`（Git 通用包，v0.10.5）、共享盘 `C:\\syncJIANGUO\\Skill+Tool\\skillhub\\dsh-device`
- 取证命令：`dsh --profile web --dump-config`、`npm run verify`、`python -B scripts/test_ptc_route.py`

## 一、一句话结论

三件事必须分开落层，混在一起改必然"改了不生效"：

1. **切换顺序**（哪些 provider 先试）的权威源是**共享盘** `dsh-device\\route-config.json` → `setup.ps1` 复制进 `~/.dsh/plugins/provider-failover/route-config.json`，插件启动时**覆盖** profile 里的 `tiers`。本机运行期文件现在两档全是 `gpt-6.1-sol` / `deepseek-v4.1-flash+max`。
2. **6.1 的目录与回退档位**进 Git `dsh-config-pack`（v0.10.5）：`allowedModels` 的 `openai-codex` 项、`45-failover` tier1、`subagent-codex` 默认模型、README 表；本机 profile 另把 `openai-codex` 目录收紧成只列 `gpt-6.1-sol`（`codex-relay/gpt-5.6-sol` 仍保留为可选档，供旧会话恢复与 allowedModels 引用）。
3. **ds4.1-flash 之前根本没有推理档位**：`deepseek-v4.1-flash` 不在 pi-ai 已装目录里，模型条目省略 `reasoningEfforts` 时适配器把它当非推理模型（`reasoning=false`，选择器无档位、请求连 `reasoning_effort` 都不带）。本次在 `ais-2dsglm` 与 `opencodego` 两条路由上显式声明 `off/low/high/max`，再把 `agent-default-model.reasoningEffort` 设为 `max`，才算"统一改成 max"。

## 二、改动落点表

| 层 | 文件 | 改动 | 生效条件 | 跨设备 |
| --- | --- | --- | --- | --- |
| 运行期切换顺序 | `~/.dsh/plugins/provider-failover/route-config.json` | tier2 两条 ds4.1-flash 加 `reasoningEffort: max`；tier2 备用路由名 `opencode-go`→`opencodego`（本机 provider id） | 重启 DSH | 由共享盘答案 + `setup.ps1` 生成 |
| 共享盘答案 | `dsh-device\\route-config.json` | 同上（保留 `opencode-go` 作为跨设备规范名），另由新逻辑按设备改写 | 下次 `setup.ps1 -SharedRoot` | **是**（这是主通道） |
| 共享盘设备答案 | `dsh-device\\device.env` | `DSHPACK_ROUTE_OPENCODE=opencodego`、`DSHPACK_DEFAULT_PROVIDER=opencodego` | `setup.ps1` 导出用户环境变量 | 是（各设备各写自己的值） |
| 设备本地回退档位 | `~/.dsh/plugins/dsh-preset-failover-tiers/cordis.patch.yml` | tier1 两条 `gpt-5.6-sol`→`gpt-6.1-sol`；tier2 两条加 `reasoningEffort: max` | 重启 DSH | 否（设备本地副本，见限制） |
| 本机 profile | `~/.dsh/profiles/web/cordis.patch.yml` | `openai-codex` 目录 `gpt-6.1-sol`；`subagent-codex` `gpt-6.1-sol`；`ais-2dsglm`/`opencodego` 的 `deepseek-v4.1-flash` 声明 `reasoningEfforts`；`agent-default-model.reasoningEffort: max` | 重启 DSH + 新会话 | 否（profile 属设备） |
| Git 通用包 | `config/40-models.yml` | `ais-2dsglm` 的 v4.1-flash 声明 `reasoningEfforts`；`allowedModels` 的 `openai-codex/gpt-5.6-sol`→`gpt-6.1-sol` | `git pull` + `install.ps1` + 重启 | **是** |
| Git 通用包 | `config/45-failover.yml` | tier2 两条加 `reasoningEffort: max` | 同上 | 是 |
| Git 通用包 | `config/10-subagents.yml` | `subagent-codex` 钉 `model: gpt-6.1-sol`（此前未钉，落 CLI 默认） | 同上 | 是 |
| Git 通用包 | `scripts/setup.ps1` | 复制共享盘答案后，按本机 `DSHPACK_ROUTE_*` 重写档位路由名 | 下次 `setup.ps1` | **是**（修掉"源设备路由名被抄成空转条目"） |
| Git 通用包 | `README.md` | `openai-codex` 白名单行改 6.1；新增设备级 `agent-default-model.reasoningEffort` 说明 | — | 是 |
| PTC 运行期副本 | `ynm3000/skillhub/store/installed/ptc-multi-agent-control`（0.6.0） | `SKILL.md`/`USAGE.md`/bundle persona 的 `gpt-5.6-sol`→`gpt-6.1-sol`、`GPT-5.6 Sol`→`GPT-6.1 Sol`；`ptc_route.py` `CONTROLLER_MODEL` 同步；保留 changelog 历史不改 | 重启 DSH + 新会话 | 否（该目录 gitignore，见限制） |

## 三、为什么 ds4.1-flash 之前没有档位（源码证据）

- `@earendil-works/pi-ai` `dist/index.js`：模型条目**声明了 `reasoningEfforts`** 时直接构造 `{reasoning:true, thinkingLevelMap:map}`，**不需要**目录里有同名条目；只有 `reasoningEfforts === undefined` 才去继承同 id 的已装目录条目，接不上就是 `reasoning:false`。
- 请求路径：`resolveReasoningLevel(model, options.reasoningEffort ?? profile.reasoning)`；链路不支持的层级**抛 `UNSUPPORTED_REASONING_EFFORT`**，不会静默降级。UI/目录侧展示的是 `describableReasoningLevel(...)` → `reasoning.defaultEffort`。
- 已装目录 `dist/providers/data/opencode-go.json` 里只有 `deepseek-v4-flash`（`thinkingLevelMap {minimal:null, low:"low", medium:null, high:"high", max:"max"}`、`compat.thinkingFormat:"deepseek"`）；**没有任何目录条目含 `deepseek-v4.1-flash`**。
- 协议侧：`compat.detectCompat` 只在 provider 名为 `deepseek` 或 baseUrl 含 `deepseek.com` 时才用 deepseek 风格的 `thinking` 参数，否则走 OpenAI 风格 `reasoning_effort`。本机两条路由（`http://47.101.159.7:29988/v1`、`https://opencode.ai/zen/go/v1`）都属后者，所以声明 `max` 会以 `reasoning_effort: "max"` 发出。
- 结论：本次声明的档位词汇刻意与 `deepseek-v4-flash` 对齐（只 `low/high/max` 有线上取值，`off: null` 表示"关"；`minimal/medium/xhigh` 保持未声明＝不支持）。**没有**使用 provider 级 `reasoning: max`，因为那会让同 provider 下无推理能力的 `glm-5.3-flash` 在选择器里也出现档位并在请求时抛错。

## 四、跨设备怎么同步（对应"如何通过跨设备共享盘同步更新"）

盘符映射：本机共享盘 = `C:\\syncJIANGUO\\Skill+Tool\\skillhub\\dsh-device\\`（另一设备同名目录）。

1. **切换顺序 / 档位**（配置类，设备相关）→ 共享盘 `dsh-device\\route-config.json` 是唯一答案文件。对方设备执行
   ```powershell
   pwsh dsh-config-pack\\scripts\\setup.ps1 -SharedRoot <共享盘根> -UpdateRoutes
   ```
   脚本会把答案复制到 `~/.dsh/plugins/provider-failover/route-config.json`，并用本机 `device.env` 的 `DSHPACK_ROUTE_*` 重写档位路由名；插件在 DSH **启动时**读取并覆盖 profile 的 `tiers`。**必须重启 DSH**才生效，会话内不会热加载。
2. **代码 / 通用配置**（层二）→ Git：`git pull` `dsh-config-pack`（跟 tag，当前 v0.10.5）→ `pwsh scripts/install.ps1 -ProfileName web` → 重启 DSH + 新开会话。以 `link:` 登记的插件只需 pull + 重启。
3. **设备绝对量**（路径、key 指针名、路由名偏好）→ 只进 `device.env`，不进 Git。
4. **已修掉的坑**：共享盘 `route-config.json` 里写的是**源设备**的路由名，旧 `setup.ps1` 逐字照抄，本机 provider 叫 `opencodego` 而答案是 `opencode-go` → tier2 第二条必然 `NO_ADAPTER` 空转。现在复制后会按 `DSHPACK_ROUTE_OPENCODE` 改写（单函数桩测已验）。仍需人工确认的一点：`device.env` 里 `DSHPACK_ROUTE_OPENCODE` 必须与该机真实 provider id 一致（本机已改 `opencodego`）。
5. **PTC 技能本体不在这条链上**：参见第七节。

## 五、验证证据

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 组合配置可解析 | `dsh --profile web --dump-config` | exit 0 |
| 默认行含档位 | 同上输出 `agent-default-model` | `provider: opencodego / model: deepseek-v4.1-flash / reasoningEffort: max` |
| 档位声明进组合结果 | 同上 grep `reasoningEfforts` | `ais-2dsglm` 与 `opencodego` 两处均为 `off:null, low, high, max` |
| 切换顺序 | 同上读 tier 表 | tier1 `codex-relay/gpt-6.1-sol` + `openai-codex/gpt-6.1-sol`；tier2 两条 `deepseek-v4.1-flash` + `reasoningEffort: max`；tier3 `kimi-coding/k3-256k` |
| 包内自检 | `npm run verify`（config-pack） | `verify-ptc-public-template: OK`、`verify-components: OK - 9 component(s)` |
| 包内测试 | `npm test` | 需先把 `C:\\Users\\wang\\anaconda3` 放进 PATH（本机 `python` 只有 Store 假入口）；放开后通过，见第七节注 |
| PTC 脚本单测 | `python -B scripts/test_ptc_route.py` / `test_ptc_task_control.py`（store 副本） | 42 例 OK / 12 例 OK |
| `setup.ps1` 路由改写 | 单函数桩测（不执行整脚本，避免改环境变量） | `changed: opencodego:opencode-go->opencodego`，tier2 `ais=ais-2dsglm/…/max`、`opencodego=opencodego/…/max` |

## 六、回滚

- 本机文件：同目录 `*.bak-before-sol61-20261023-1045`（profile、回退档位、运行期 route-config、store 副本 5 个文件、config-pack 4 个文件、共享盘 2 个文件）。
- Git：`git -C dsh-config-pack revert <v0.10.5 commit>` 或 `git checkout v0.10.4 -- . ` 后重装；跑 `pwsh scripts/release.ps1` 重新发版。
- 生效：任何回滚都要**重启 DSH**；`route-config.json` 的改动还要避免再次运行 `setup.ps1 -UpdateRoutes` 覆盖。

## 七、限制与后续

1. **上游是否接受 `max` 未实测**：ais 网关当前返回 `403 quota_exceeded`（`96133851/1...`，key 于 06:00 重置），三条变体（基线 / `reasoning_effort:max` / `thinking+reasoning_effort`）全部 403。因此"声明已就位、参数已发出"有源码依据，但"上游按 max 加思考预算"只有重启后新会话实测才算证据。
2. **UI 会覆盖默认档位行**：本机 11:08 切换模型时，Web 选择器保存（saveSelection）把 `agent-default-model` 重写成 `provider/model` 三行，`reasoningEffort` 被丢掉一次，已补回。规则：**换模型后若选择器没选 max，就要在 UI 里重选或补回该行**。
3. **PTC 运行期副本仍是 0.6.0**：本机 profile 用 `link:` 指向 `ynm3000/skillhub/store/installed/ptc-multi-agent-control`（`/skillhub/` 在 ynm3000 里被 gitignore，因此**不随 Git 跨设备**）。本项目本体已是 0.16.1（Git 包 `packages/dsh-ptc-multi-agent-mode`）。本次只做文本/脚本级同步让当前会话路由文案与 CLI 默认模型一致；**把 profile 的 link 指向项目本体（0.6.0→0.16.1 会改工具面：Opus 5.5 档等）需单独验收**，属下一步。
4. **`~/.dsh/plugins/dsh-preset-failover-tiers` 是设备本地副本**，Git 里没有对应源；它和 `config/45-failover.yml` 内容重复，跨设备一致性靠 `route-config.json`（优先级更高）。若要彻底去重，应把该目录改为 Git 包内组件。
5. **`npm test` 的环境前提**：`test-ptc-public-template.mjs` 用 `run('python', ...)` 直接起 python；本机 PATH 上只有 Store 假入口。另外把 anaconda 加进 PATH 后，测试自身跑出的 `__pycache__`（.pyc 内含 `C:\\Users\\wang\\AppData\\...`）会触发它自己的"无个人绝对路径"扫描。建议在该测试里给子进程加 `PYTHONDONTWRITEBYTECODE=1` 并忽略 `__pycache__` 目录（未改，留作后续）。
6. **更早一次未登记账本的运行**：`v0.10.3`/`v0.10.4` 由今天早些时候一次没有写 `.ptc/registry.jsonl` 的运行产出（`.gitignore` 里记了"release.ps1 的 `git add -A` 曾把 `.bak-before-sol61-*` 打进 v0.10.3"的教训）。本次发版前已确认备份副本被 `*.bak-*` 规则忽略。
