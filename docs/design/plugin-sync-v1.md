# 双向插件清单同步方案 v1 定稿

目标：A→B、B→A 都按接收机目录解析 link 依赖，保留双方本地插件，禁止静默删除。

独立入口 scripts/plugin-sync.mjs export/plan/apply。导出 profile 的 dependencies 与 bundles，link 仅记录包名和工作区相对目录，不发送源机绝对路径。外部 link 需要接收机 packages 映射；同名有效本机落点优先复用并验证 package.json.name。非 link 的版本冲突阻断。无共同基线时采用保守合并：保留目标独有插件、不传播删除；bundle 顺序保留目标顺序并将新增项放到 dsh-config-pack 前。不声称自动解决三方删除或排序冲突。

plan 默认只读并列出新增项、缺目录、版本冲突。apply 显式 --host-stopped 才运行 dsh plugin add，不直接改 profile package.json。执行前备份目标 profile 关键文件，安装失败即停；依赖安装后核对实际包名、依赖、bundle 登记以及模块路径。不在沙箱内借调度器绕过授权。

测试：两个临时目录模拟 A/B 不同路径，A 导出→B 计划→B 导出→A 计划，确认保留本地路径、目标独有插件，缺路径/包名错误/版本冲突拒绝执行。活跃生产 profile 不做安装。

## GLM-5.3-Flash 挑战裁决

- M1 采纳：拒绝绝对/父目录逃逸，Windows 用 realpathSync.native 解析 Junction（回归曾捕获普通 realpath 没解析出的外指路径）。
- M2 采纳：显式单一路径，包名及 package.json/lib 指纹必须匹配；相同包名不代表相同源码。
- M3 采纳：共享顺序冲突阻断；新增项保持清单顺序，CLI 临时移除再恢复 config-pack 到末尾。其他补丁层不自动推断，需显式评审。
- M4 部分采纳：失败自动回滚配置文件；node_modules 非事务性，保持宿主停止并用 pnpm install 收敛。不得声称整个依赖树原子回滚。
- M5 保守实现：新增 registry 包只接受精确版本；既有 spec 不同阻断。声明 engines 的 link 包只支持 exact hostVersion，其余范围阻断，暂不实现通用 semver 裁决。
- M6 采纳且扩大一处实际修复：恢复脚本原来读取 profiles/<p>/package.json，实际快照位于 files/profile/package.json，导致旧体检跳过清单。修复路径并按接收机 profile 目录解析相对 link。

实现边界：无共同基线不传播删除；源码、配置、清单分开；不自动上传、拉 Git、安装活动 profile；不承诺网页功能已验收。验收 evidence：node scripts/test-plugin-sync.mjs（21 项），真实 web 导出及只读计划 exit 0。
