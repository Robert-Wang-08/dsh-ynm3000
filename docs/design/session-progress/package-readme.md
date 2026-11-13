# Focus Hub v2 整合参考包

先双击 [integrated-prototype.html](<integrated-prototype.html>)，无需安装、联网或启动服务器。

以用户指定样例的蓝灰三栏和四视图为主架；顶部“L1聚合边 / 下钻P02看外部前提 / 共享工作引用”可演示任务关系随上下钻聚合与还原，跳转后可返回原焦点。

[示例数据](<integrated-demo-data.json>)保留4目标37唯一任务，新增的跨目标依赖和验收门明确为合成压力案例，不代表真实业务。可离线导入导出同结构JSON。界面内的看板是示例投影，不是实时DSH任务看板。

[整合说明](<V2-INTEGRATION.md>)包含具体规则与限制，[机器报告](<integrated-verification.json>)记录104项浏览器自检及URL新页面恢复通过。

## 重建及验证

需要本机已有Python、Node、PowerShell及Chrome/Edge，不安装第三方库：

```powershell
pwsh -NoProfile -File ./verify-integrated.ps1
# 浏览器不在默认路径时加 -Browser <Chrome或Edge的完整路径>
```

[原始样例](<reference-v2/task_focus_hub_v2.html>)及配套[原数据](<reference-v2/focus_hub_demo_data.json>)保持不变；[构建器](<build-integrated.py>)将样例、[增强逻辑](<v2-enhancements.js>)与[自检](<v2-selftest.js>)生成单文件整合稿。

仅设计参考，未安装M6、未部署插件、未连接真实日志、未推送Git。不要将样例状态当作真实完成证据，也不要让页面直接写入任务卡审批/验收态。
