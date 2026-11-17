"""Human-readable deterministic reports; no LLM calls or approval actions.

Both the scheduled health report and the human-attention notices are rendered as
Markdown. The delivery transport converts Markdown into a Feishu rich-text post
(`tag: md`), so headings, bullet lists and blank lines reach the reader as real
formatting instead of one dense wall of text.
"""
from common import safe_text

LABEL={"reachable":"接口可达","online_degraded":"在线但降级","unknown":"状态未知","working":"执行中","idle":"空闲未结束","person":"待人工","ended":"已结束"}
# The authoritative end outcome, not a natural-language guess from the worker report.
OUTCOME={"completed":"已完成","merged":"已完成","stopped":"已停止","dropped":"已结束未完成","closed":"已结束未完成"}
EFFORT_INTRO="运行时长为建单到结束（含等待人工输入）；输入轮次为去重后的触发输入，交手为派给 worker 的次数。"
EFFORT_TOKEN_INTRO="token 为工单 worker 会话全时用量，不含主控/子代理/外部 ACP；无 usage 记未知，不填 0。"
# One-line pointer back to the full report, so a focused attention notice is not a dead end.
# The attention snapshot is the same full snapshot as the health report, kept under the attention title.
REPORT_HINT="完整待人工事项报告：本机快照 `%USERPROFILE%\\.dsh\\state\\superagent-health\\latest-attention.md`；飞书全量报告见每 4 小时整点（09/13/17）与 21:05 的「健康报告」（同内容）。"
# What an operator does about a failed collection: the code alone does not say whether the host or the plugin is at fault.
ERROR_HINT={"http_404":"该实例没有挂载 orchestrator 路由（插件未加载或正在重载），可用 /orchestrator/api/state 手工复核",
            "auth_401":"接口要求鉴权或令牌无效","auth_403":"接口拒绝该身份",
            "transport_or_schema":"连接失败或响应不是预期 JSON","response_budget":"响应超过读取上限"}
# Source health codes, translated so an incident line names the failure instead of a bare identifier.
HEALTH_CODE={"pollFailures":"轮询连续失败","setupPending":"等待部署检查","sourceOff":"按配置关闭",
             "feishuCliUnset":"飞书 bot CLI 未配置","feishuBotMissing":"等待飞书 bot"}
# A focused incident message must not become a second full report: it only names the failure or the recovery.
INCIDENT_BOUNDARY="本消息只报异常/恢复，不重复会话、工单与任务投入；完整报告见 09/13/17 整点及 21:05 的「健康报告」。"
INCIDENT_HINT="本机完整快照 `%USERPROFILE%\\.dsh\\state\\superagent-health\\latest.md`。"

def model_line(event):
    response=event.get("lastResponse")
    if response:
        return "最近响应模型 " + str(response.get("provider") or "未知") + "/" + str(response["model"]) + "（" + response["at"] + "；" + response["source"] + "）"
    return "实际响应模型：未知"

def _label(value):
    return str(value or "未知")

def _ticket_line(ticket):
    return "**" + ticket["id"][:8] + "** " + safe_text(ticket.get("title"),80) + " · " + LABEL.get(ticket.get("stage"),_label(ticket.get("stage")))

def span(seconds):
    """Short duration for a report line; hours omit a zero minute part."""
    seconds=int(seconds or 0)
    if seconds>=3600:
        return str(seconds//3600)+"h"+str(seconds%3600//60)+"m"
    if seconds>=60:
        return str(seconds//60)+"m"
    return str(seconds)+"s"

def compact(value):
    value=int(value or 0)
    if value>=1000000:
        return str(round(value/1000000,1))+"M"
    if value>=1000:
        return str(round(value/1000,1))+"k"
    return str(value)

def tokens_text(tokens):
    """Input/output are the stable fields; cache is shown only when the source reported it."""
    if not isinstance(tokens, dict):
        return "token 未知"
    parts=["入 "+compact(tokens.get("input")), "出 "+compact(tokens.get("output"))]
    if tokens.get("cacheRead"):
        parts.append("缓存读 "+compact(tokens.get("cacheRead")))
    if tokens.get("cacheWrite"):
        parts.append("缓存写 "+compact(tokens.get("cacheWrite")))
    return "token "+" / ".join(parts)

def deployment_tag(deployment):
    """'branch@revision' for the report header; None when the guard did not run at all."""
    if not isinstance(deployment, dict):
        return None
    if deployment.get("quality") != "observed":
        return "运行代码未知"
    return "运行代码 " + str(deployment.get("branch") or "?") + "@" + str(deployment.get("revision") or "?")

def deployment_warning(deployment):
    """The running checkout is not the main tip. None when it is, or when git could not tell."""
    if not isinstance(deployment, dict) or deployment.get("quality") != "observed" or deployment.get("current") is True:
        return None
    branch=str(deployment.get("branch") or "?")
    revision=str(deployment.get("revision") or "?")
    main=str(deployment.get("mainRevision") or "?")
    main_branch=str(deployment.get("mainBranch") or "main")
    behind=int(deployment.get("behind") or 0)
    ahead=int(deployment.get("ahead") or 0)
    dirty=[str(path) for path in (deployment.get("dirty") or [])]
    off_main=branch != main_branch or behind > 0 or ahead > 0 or revision != main
    details=[]
    if branch != main_branch:
        details.append("处于 detached HEAD" if branch == "HEAD" else "在分支 " + branch + " 上")
    if behind:
        details.append("落后 main " + str(behind) + " 个提交")
    if ahead:
        details.append("领先 main " + str(ahead) + " 个提交")
    if dirty:
        names=[path.rsplit("/", 1)[-1] for path in dirty[:3]]
        details.append(str(len(dirty)) + " 个健康工具文件未提交（" + "、".join(names) + "）")
    if not details:
        details.append("与 main 不一致")
    if off_main:
        return ("**部署警告**：运行代码 " + branch + "@" + revision + " 不是 main 顶端 " + main
                + "（" + "、".join(details) + "）；合并到 main 的修复不会生效。在该仓库执行 "
                "`git fetch origin` 后 `git merge --ff-only origin/main`，下一轮采集即生效。")
    return ("**部署警告**：运行代码 " + branch + "@" + revision + " 有未提交改动：" + "、".join(details)
            + "；定时任务执行的不是 main 上已提交的版本，请提交或还原这些文件。")

def render(snapshot,kind="健康报告"):
    tag=deployment_tag(snapshot.get("deployment"))
    header=("统计截至 " + snapshot["windowEnd"] + "；状态采集于 " + snapshot["collectedAt"]
            + ("；" + tag if tag else ""))
    lines=["# Superagent · " + kind, "", header]
    warning=deployment_warning(snapshot.get("deployment"))
    if warning:
        lines += ["", warning]
    for item in snapshot["instances"]:
        lines += ["", "## 【"+item["id"]+"】"+LABEL.get(item["health"],_label(item["health"]))]
        if item.get("collectionError"):
            lines += ["", "- 采集异常："+item["collectionError"]+"（"+ERROR_HINT.get(item["collectionError"],"未分类")+"），工单与人工待办数量未知。"]
            continue
        lines += ["", "- 今日完成工单："+str(item["todayCompleted"]),
                  "- 未完成："+str(item["openTickets"]),
                  "- 工单待人工："+str(len(item["humanItems"])),
                  "- 今日有执行事件的关联会话："+str(item["activeManagedSessionsObserved"])+"（缺证据 "+str(item["missingSessionEvidence"])+"；仅主控/工单worker，子代理未证实完整覆盖）"]
        if item["errorComponents"]:
            lines += ["", "**异常组件**：" + "、".join(item["errorComponents"])]
        if item.get("paused"):
            lines += ["", "**调度已暂停。**"]
        if item["quality"] != "observed_nonatomic":
            lines += ["", "**数据不完整**：" + "、".join(item["paginationErrors"])]
        sessions=[s for s in item["sessions"] if s["role"]=="master" or s["events"].get("activeToday")]
        if sessions:
            lines += ["", "**会话**"]
            for session in sessions:
                ev=session["events"]
                lines.append("- `"+session["id"][:14]+"` / "+session["role"]+"："+model_line(ev))
                if ev.get("inFlight"):
                    lines.append("  - 存在未匹配的持久步骤；不能据此确认仍在运行。")
        shown=[t for t in item["tickets"] if not t.get("ended")]+[t for t in item["tickets"] if t.get("ended")]
        if shown:
            lines += ["", "**工单**"]
            for ticket in shown[:20]:
                recap=ticket["recap"]
                lines.append("- "+_ticket_line(ticket))
                lines.append("  - 一句话："+recap["text"])
                if recap.get("at"):
                    lines.append("  - 摘要截至 "+recap["at"]+"；来源 "+recap["source"]+"（worker报告，未独立验收"+("；早于最新工单更新" if recap.get("mayBeStale") else "")+"）")
            if len(shown)>20:
                lines.append("- 另有 "+str(len(shown)-20)+" 项，本地完整快照可查。")
        effort=item.get("taskEffort") or []
        missing=int(item.get("taskEffortMissing") or 0)
        if effort:
            lines += ["", "**任务投入（本窗口结束，按运行时长排序）**", EFFORT_INTRO, EFFORT_TOKEN_INTRO]
            for index,task in enumerate(effort,1):
                line=("- "+str(index)+". **"+str(task.get("ticketId") or "")[:8]+"** "+safe_text(task.get("title"),60)+" · "
                      +OUTCOME.get(task.get("outcome"),"已结束")+" · 输入 "+str(task.get("inputRounds"))+" 轮 / 交手 "
                      +str(task.get("handoffRounds"))+" 次 · 运行 "+span(task.get("elapsedSeconds"))+" · "+tokens_text(task.get("tokens")))
                if task.get("tokenQuality")=="partial":
                    line+="（部分响应无usage）"
                lines.append(line)
            total=item.get("taskTokenTotal")
            if isinstance(total, dict):
                lines.append("- 本窗口结束任务合计 "+tokens_text(total)+"（"+str(item.get("taskTokenTasks") or 0)+" 项有 usage"
                             +("，"+str(item["taskTokenMissing"])+" 项未知" if item.get("taskTokenMissing") else "")+"）")
            extra=int(item.get("taskEffortTotal") or len(effort))-len(effort)
            if extra>0:
                lines.append("- 另有 "+str(extra)+" 项已结束任务未列出（只列运行时长前 "+str(len(effort))+" 项）。")
            if missing:
                lines.append("- 另有 "+str(missing)+" 项已结束任务缺少可核验投入数据（详情读取失败或字段缺失），未计入排序。")
        elif missing:
            lines += ["", "**任务投入**：本窗口有 "+str(missing)+" 项结束任务，但缺少可核验详情，未给出统计。"]
        if item["humanItems"]:
            lines += ["", "**需要管理人**"]
            for issue in item["humanItems"]:
                lines.append("- **"+str(issue.get("ticketId") or "")[:8]+"** "+safe_text(issue.get("question")))
                lines.append("  - 原因："+str(issue.get("reason"))+"；事项："+str(issue.get("issueId"))+"；期限未设置。请回原工单处理，通知不等于授权。")
    lines += ["", "## 今日用量"]
    for item in snapshot["dashboard"]:
        lines.append("- dashboard："+item["quality"]+" / "+str(item.get("error") or "仅状态已读")+"。未取得可核验完整金额，不填零；worker目录覆盖待修复。")
    lines += ["- 关联会话事件usage仅用于观测，可有缓存字段包含关系差异/子代理遗漏；不冒充全局账单。",
              "- 本机采集只能说明接口可达，不保证调度循环及整机离线告警。"]
    return chr(10).join(lines)

def render_attention(snapshot,kind,issue):
    """One human decision, as a short scannable list instead of the whole report."""
    instance=next((i for i in snapshot["instances"] if i.get("id")==issue.get("instanceId")),None)
    ticket=None
    if instance is not None:
        ticket=next((t for t in instance.get("tickets",[]) if t.get("id")==issue.get("ticketId")),None)
    lines=["# Superagent · " + kind, "", "统计截至 " + snapshot["windowEnd"]]
    if instance is not None:
        lines += ["", "## 【"+instance["id"]+"】"+LABEL.get(instance.get("health"),_label(instance.get("health")))]
    lines += ["", "**需要你决定**", ""]
    ticket_id=str(issue.get("ticketId") or (ticket or {}).get("id") or "")
    if ticket is not None:
        lines.append("- 工单："+_ticket_line(ticket))
    elif ticket_id:
        lines.append("- 工单："+"**"+ticket_id[:8]+"**")
    lines.append("- 问题："+safe_text(issue.get("question"),400))
    lines.append("- 原因："+str(issue.get("reason") or "未标注"))
    lines.append("- 事项："+str(issue.get("id") or issue.get("issueId") or ""))
    lines.append("- 期限："+str(issue.get("deadline") or "未设置"))
    lines += ["", "请回原工单处理；通知不等于授权。", "", REPORT_HINT]
    if instance is not None:
        others=[i for i in instance.get("humanItems",[]) if i.get("issueId")!=issue.get("id")]
        if others:
            lines += ["", "**其他待人工（"+str(len(others))+"）**"]
            for other in others:
                lines.append("- **"+str(other.get("ticketId") or "")[:8]+"** "+safe_text(other.get("question"),80))
        if instance.get("health") in ("unknown",):
            lines += ["", "**注意**：本次状态采集异常，工单与人工待办数量可能不完整。"]
    return chr(10).join(lines)

def render_health_notice(snapshot,kind,health):
    """One incident or recovery, without the full session, ticket and effort inventory.

    `health` carries the incident instance and, for a recovery, the abnormal condition that
    preceded it (components, collection error and alert time). The full report stays the job of
    the scheduled slots; an alert must stay scannable when it arrives right next to one.
    """
    instance_id=(health or {}).get("instanceId")
    items=[i for i in snapshot["instances"] if i.get("id")==instance_id] or snapshot["instances"]
    lines=["# Superagent · " + kind, "", "状态采集于 "+snapshot["collectedAt"]]
    warning=deployment_warning(snapshot.get("deployment"))
    if warning:
        lines += ["", warning]
    for item in items:
        lines += ["", "## 【"+item["id"]+"】"+LABEL.get(item.get("health"),_label(item.get("health")))]
        if kind=="异常健康报告":
            lines += ["", "**异常说明**"]
            if item.get("collectionError"):
                code=str(item["collectionError"])
                lines.append("- 采集失败："+code+"（"+ERROR_HINT.get(code,"未分类")+"）；工单与人工待办数量未知。")
            for name in item.get("errorComponents") or []:
                entry=(item.get("components") or {}).get(name) or {}
                code=entry.get("code")
                line="- "+name+"："+HEALTH_CODE.get(code,str(code) if code else "状态 error")
                if entry.get("at"):
                    line+="（自 "+str(entry["at"])+" 起）"
                lines.append(line)
                if entry.get("detail"):
                    lines.append("  - 最近错误："+safe_text(entry["detail"],160))
            if not item.get("collectionError") and not item.get("errorComponents"):
                lines.append("- 本次采集没有可复述的异常组件；请查看本地完整快照。")
        else:
            lines += ["", "**恢复时点**："+snapshot["collectedAt"]]
            causes=[]
            components=(health or {}).get("previousComponents") or []
            if components:
                causes.append("组件 "+"、".join(components)+" 已恢复 ready")
            if (health or {}).get("previousCollectionError"):
                causes.append("采集失败 "+str(health["previousCollectionError"])+" 已恢复")
            if (health or {}).get("alertedAt"):
                causes.append("异常自 "+str(health["alertedAt"])+" 起")
            if (health or {}).get("successSamples") is not None:
                causes.append("连续 "+str(health["successSamples"])+" 次采集成功")
            lines += ["", "**原因说明**："+("；".join(causes) if causes else "采集恢复正常")+"。"]
    lines += ["", "**边界**："+INCIDENT_BOUNDARY, "", INCIDENT_HINT]
    return chr(10).join(lines)

def report_text(snapshot,kind="健康报告",issue=None,health=None):
    """Pick the focused notice renderer for human-attention and incident messages."""
    if health is not None and kind in ("异常健康报告","恢复报告"):
        return render_health_notice(snapshot,kind,health)
    if isinstance(issue,dict) and kind.startswith("待人工"):
        return render_attention(snapshot,kind,issue)
    return render(snapshot,kind)

def chunks(text,limit=3500):
    parts=[]
    current=""
    for line in text.splitlines():
        while len(line)>limit:
            if current:
                parts.append(current)
                current=""
            parts.append(line[:limit])
            line=line[limit:]
        if len(current)+len(line)+1>limit:
            parts.append(current)
            current=""
        current+=(chr(10) if current else "")+line
    if current:
        parts.append(current)
    return parts
