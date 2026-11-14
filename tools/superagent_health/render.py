"""Human-readable deterministic report; no LLM calls or approval actions."""
from common import safe_text

LABEL={"reachable":"接口可达","online_degraded":"在线但降级","unknown":"状态未知","working":"执行中","idle":"空闲未结束","person":"待人工","ended":"已结束"}
# What an operator does about a failed collection: the code alone does not say whether the host or the plugin is at fault.
ERROR_HINT={"http_404":"该实例没有挂载 orchestrator 路由（插件未加载或正在重载），可用 /orchestrator/api/state 手工复核",
            "auth_401":"接口要求鉴权或令牌无效","auth_403":"接口拒绝该身份",
            "transport_or_schema":"连接失败或响应不是预期 JSON","response_budget":"响应超过读取上限"}

def model_line(event):
    response=event.get("lastResponse")
    if response:
        return "最近响应模型 " + str(response.get("provider") or "未知") + "/" + str(response["model"]) + "（" + response["at"] + "；" + response["source"] + "）"
    return "实际响应模型：未知"

def render(snapshot,kind="健康报告"):
    lines=["Superagent · " + kind, "统计截至 " + snapshot["windowEnd"] + "；状态采集于 " + snapshot["collectedAt"]]
    for item in snapshot["instances"]:
        lines += ["", "【"+item["id"]+"】"+LABEL.get(item["health"],item["health"])]
        if item.get("collectionError"):
            lines.append("采集异常："+item["collectionError"]+"（"+ERROR_HINT.get(item["collectionError"],"未分类")+"），工单与人工待办数量未知。")
            continue
        lines += ["今日完成工单："+str(item["todayCompleted"])+"；未完成："+str(item["openTickets"])+"；工单待人工："+str(len(item["humanItems"])),
                  "今日有执行事件的关联会话："+str(item["activeManagedSessionsObserved"])+"（缺证据 "+str(item["missingSessionEvidence"])+"；仅主控/工单worker，子代理未证实完整覆盖）"]
        if item["errorComponents"]:
            lines.append("异常组件："+", ".join(item["errorComponents"]))
        if item.get("paused"):
            lines.append("调度已暂停。")
        if item["quality"] != "observed_nonatomic":
            lines.append("数据不完整："+", ".join(item["paginationErrors"]))
        for session in item["sessions"]:
            ev=session["events"]
            if session["role"] != "master" and not ev.get("activeToday"):
                continue
            lines.append("会话 "+session["id"][:14]+" / "+session["role"]+"："+model_line(ev))
            if ev.get("inFlight"):
                lines.append("存在未匹配的持久步骤；不能据此确认仍在运行。")
        shown=[t for t in item["tickets"] if not t.get("ended")]+[t for t in item["tickets"] if t.get("ended")]
        for ticket in shown[:20]:
            recap=ticket["recap"]
            lines.append("工单 "+ticket["id"][:8]+"："+safe_text(ticket["title"],80)+" / "+LABEL.get(ticket["stage"],ticket["stage"]))
            lines.append("一句话："+recap["text"])
            if recap.get("at"):
                lines.append("摘要截至 "+recap["at"]+"；来源 "+recap["source"]+"（worker报告，未独立验收"+("；早于最新工单更新" if recap.get("mayBeStale") else "")+"）")
        if len(shown)>20:
            lines.append("另有 "+str(len(shown)-20)+" 项，本地完整快照可查。")
        for issue in item["humanItems"]:
            lines.append("需要管理人："+issue["question"]+"；原因 "+str(issue["reason"])+"；事项 "+issue["issueId"]+"；期限未设置。请回原工单处理，通知不等于授权。")
    lines += ["", "今日用量："]
    for item in snapshot["dashboard"]:
        lines.append("dashboard："+item["quality"]+" / "+str(item.get("error") or "仅状态已读")+"。未取得可核验完整金额，不填零；worker目录覆盖待修复。")
    lines.append("关联会话事件usage仅用于观测，可有缓存字段包含关系差异/子代理遗漏；不冒充全局账单。")
    lines.append("本机采集只能说明接口可达，不保证调度循环及整机离线告警。")
    return chr(10).join(lines)

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
