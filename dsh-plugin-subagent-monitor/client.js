/**
 * dsh-plugin-subagent-monitor — 客户端半（client.js）
 *
 * 在会话头部的 `conversation.session.header.actions` 席位（list、session
 * 作用域）注册一个小按钮，显示 `子代理 N`；点击展开一个 fixed 弹层，列出本
 * 会话可见的子代理与后台任务，并可逐行展开实时输出尾部。
 *
 * 数据来源（全部为官方公开面，只读借用）：
 * - 行集合：父会话 delegation（来自本会话 transcript 的 `tool/call` /
 *   `tool/result` 配对，以及 `tool/ptc-dispatch` 记录——PTC 主控把子代理
 *   调用放在 run_code 程序里执行时只留后者）∪ 本会话 `subagentCatalog` 子会话（来自
 *   `useSessions().projectionsBySession`）∪ 本会话 `ctx.jobs` 中
 *   `kind === 'subagent'` 的任务。
 * - 父会话 transcript：直接借用 `ctx.sessions.binding(sessionId)?.eventSource`
 *   （header 当前会话已由 shell retain；本插件只借用、不改变生命周期，也不
 *   注册 Conversation Node/View）。
 * - 子会话输出：`ctx.sessions.subagentAddress(childId)` →
 *   `ctx.sessions.retain(target, { source: "controllerOperation" })`，await
 *   ready 后订阅 `binding.eventSource`；仅在展开时 retain，收起/卸载时
 *   release()，成对释放。
 * - job 输出：`ctx.jobs.observe(sessionId, jobId)`，读取
 *   `jobs.observed[jobId].text` 尾部；收起时 stop()。
 *
 * 关键口径（见 .ptc/specs/subagent-monitor.spec.md）：
 * - 直接以 parent 的 SessionBinding.eventSource 读取工具名/描述/结果；不使用
 *   `ctx.uiConversation.events/views`。
 * - background job → child 为一对一置信关联：label 相等 + 时间窗内取时间差最小
 *   的唯一候选；多个同等候选时标记 ambiguous，不猜。
 * - 子代理类型短名**优先取实际路由**：派发参数里的显式 provider/model（等价于
 *   工具实例的 agentOptions）> 子会话持久化的 modelSelection 投影
 *   （`projectionsBySession[childId]`，仅本连接已加载投影基线的会话有值；宿主
 *   `byId[*].projectionValues` 与它同源，故不设回退）；两者都识别
 *   不出时才回落到工具名派生的驱动名（typeOfTool）。工具名派生的驱动名
 *   （spawn / fork / Codex…）保留在徽标 tooltip 里，不丢驱动差异。
 * - keepalive 的“静默”是 UI 侧推断（基于最近活动时间），明确标注
 *   `（UI 推断，非 ACP 真实心跳）`，不得据此改判失败。
 *
 * 交付形状是硬契约：dsh 把每个插件的 client.js 当 classic script 拼进单个
 * /plugins 响应执行 —— 本文件必须保持 CJS + window.__ModuleLoader__.load
 * 包装，不得出现模块级 import/export；require 白名单只有 react（先例：
 * D:\src\dsh\dsh-plugin-provider-badge\client.js）。
 *
 * 本插件不写文件、不写 settings、不持凭据、不发变更类请求、不修改宿主包。
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-subagent-monitor",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const react = require("react");
    const h = react.createElement;
    const useSyncExternalStore = react.useSyncExternalStore;
    const useMemo = react.useMemo;
    const useEffect = react.useEffect;
    const useState = react.useState;

    /* ── 常量 ──────────────────────────────────────────────────────── */

    /**
     * 12 槽调色板（未知类型走哈希取槽）。刻意只留 2 个蓝段，避免相近色难分辨。
     */
    const PALETTE = [
      "hsl(0, 62%, 46%)",
      "hsl(28, 85%, 46%)",
      "hsl(52, 90%, 38%)",
      "hsl(95, 55%, 34%)",
      "hsl(140, 55%, 36%)",
      "hsl(168, 65%, 32%)",
      "hsl(195, 75%, 38%)",
      "hsl(218, 70%, 46%)",
      "hsl(248, 55%, 48%)",
      "hsl(278, 55%, 44%)",
      "hsl(308, 60%, 42%)",
      "hsl(338, 70%, 42%)",
    ];

    /**
     * 精确工具名 → 类型短名（用户选定口径）。未入表的名字走启发式。
     */
    const TOOL_LABELS = {
      subagent_kimi_docs: "Kimi",
      subagent_cursor_grok: "Cursor",
      subagent_opencode_dsv41: "DS4.1",
      subagent_opencode: "OpenCode",
      subagent_codex_relay: "Codex-Relay",
      subagent_codex: "Codex",
      subagent_claude_code: "ClaudeCode",
      subagent_claude_opus5_plan: "Opus5",
      subagent_claude_opus48_plan: "Opus48",
      subagent_fork: "fork",
      subagent: "spawn",
    };

    /**
     * 固定类型色表（按类型短名）。未入表的短名走 PALETTE 哈希取槽。
     * 注：Cursor 与 Codex-Relay 共用同一蓝，是有意为之（两者同属 relay 家族）。
     */
    const TYPE_COLORS = {
      Kimi: "#A7E0A9",
      Cursor: "#2F6FEB",
      "Codex-Relay": "#2F6FEB",
      Codex: "#2E9E5B",
      OpenCode: "#7CB342",
      "DS4.1": "#8ECDF7",
      Opus5: "#E0501E",
      Opus48: "#C2410C",
      fork: "#8B5CF6",
      spawn: "#8ECDF7",
    };

    /** 启发式关键字（大小写不敏感 contains），顺序即优先级。 */
    const HEURISTIC_KEYS = [
      ["kimi", "Kimi"],
      ["cursor", "Cursor"],
      ["dsv41", "DS4.1"],
      ["deepseek", "DS4.1"],
      ["opencode", "OpenCode"],
      ["codex", "Codex"],
      ["claude", "Claude"],
      ["grok", "Grok"],
    ];

    /** background job → child 关联的时间容忍窗（毫秒）。 */
    const DEFAULT_TOLERANCE_MS = 30000;
    /** 子会话静默超过该阈值时，UI 给出“已静默”提示（不据此改判失败）。 */
    const SILENT_THRESHOLD_MS = 120000;
    /** 展开输出区的裁剪上限。 */
    const MAX_TAIL_LINES = 200;
    const MAX_TAIL_BYTES = 65536;

    /** 空事件窗口哨兵（无 binding 时 useSyncExternalStore 的稳定返回值）。 */
    const EMPTY_WINDOW = Object.freeze({
      entries: Object.freeze([]),
      hasMore: false,
      revision: 0,
      change: Object.freeze({ kind: "replace", entries: Object.freeze([]) }),
    });
    /** 空 jobs 快照哨兵。 */
    const EMPTY_JOBS = Object.freeze({ rows: Object.freeze({}), observed: Object.freeze({}) });

    const UNAVAILABLE = Object.freeze({});
    const NOOP_SUBSCRIBE = () => () => {};

    /* ── 纯函数：哈希与颜色 ────────────────────────────────────────── */

    /** FNV-1a 32 位稳定哈希。 */
    function hash32(raw) {
      const s = String(raw);
      let x = 2166136261;
      for (let i = 0; i < s.length; i++) {
        x ^= s.charCodeAt(i);
        x = Math.imul(x, 16777619);
      }
      return x >>> 0;
    }

    /** 类型短名 → 底色：固定表优先，否则按哈希取调色板槽。 */
    function colorForLabel(label) {
      const key = typeof label === "string" ? label : "";
      if (Object.prototype.hasOwnProperty.call(TYPE_COLORS, key)) return TYPE_COLORS[key];
      return PALETTE[hash32(key) % PALETTE.length];
    }

    /* ── 纯函数：工具名 → 类型短名（spec §2） ───────────────────────── */

    /**
     * 工具名 → { label, color }（**驱动名**口径）。顺序：精确表 → 启发式
     * contains → 去前缀截断 → `?`。自「路由优先」口径起，该结果只在行无法
     * 识别实际路由时充当徽标标签，否则仅作为 tooltip 里的驱动提示。
     * @param name - 工具名（`tool/call.name`）。
     * @returns { label, color }。
     */
    function typeOfTool(name) {
      const raw = typeof name === "string" ? name : "";
      if (Object.prototype.hasOwnProperty.call(TOOL_LABELS, raw)) {
        const label = TOOL_LABELS[raw];
        return { label, color: colorForLabel(label) };
      }
      const lower = raw.toLowerCase();
      for (const pair of HEURISTIC_KEYS) {
        if (lower.indexOf(pair[0]) >= 0) return { label: pair[1], color: colorForLabel(pair[1]) };
      }
      let rest = raw.replace(/^subagent_/, "").replace(/^subagent/, "").slice(0, 10);
      if (rest.length === 0) rest = "?";
      return { label: rest, color: colorForLabel(rest) };
    }

    /**
     * 从持久化 modelSelection 投影（或一次派发的显式路由对象）推断可识别
     * 短名。自「路由优先」口径起该结果**优先于**工具名派生的驱动名；工具名
     * 只在它无法识别时兜底。
     */
    function typeOfSelection(selection) {
      if (selection === null || typeof selection !== "object") return null;
      const selected = selection.lastUsed !== null && typeof selection.lastUsed === "object"
        ? selection.lastUsed
        : (selection.current !== null && typeof selection.current === "object" ? selection.current : selection);
      const provider = typeof selected.provider === "string" ? selected.provider.toLowerCase() : "";
      const model = typeof selected.model === "string" ? selected.model.toLowerCase() : "";
      const joined = provider + " " + model;
      let label = null;
      if (/opus[-_. ]?4[._-]?8|opus48/.test(joined)) label = "Opus48";
      else if (/opus[-_. ]?5|opus5/.test(joined)) label = "Opus5";
      else if (joined.indexOf("deepseek-v4.1") >= 0 || joined.indexOf("dsv41") >= 0) label = "DS4.1";
      else if (joined.indexOf("kimi") >= 0) label = "Kimi";
      else if (provider.indexOf("cursor") >= 0 || model.indexOf("grok") >= 0) label = "Cursor";
      else if (provider.indexOf("codex-relay") >= 0) label = "Codex-Relay";
      else if (provider.indexOf("openai-codex") >= 0 || provider === "codex") label = "Codex";
      else if (provider.indexOf("anthropic") >= 0 || model.indexOf("claude") >= 0) label = "Claude";
      else if (provider.indexOf("opencode") >= 0) label = "OpenCode";
      else if (provider.indexOf("fork") >= 0) label = "fork";
      else if (provider.indexOf("spawn") >= 0) label = "spawn";
      return label === null ? null : { label, color: colorForLabel(label) };
    }

    /**
     * 派发参数 → 显式路由。只在调用方确实传了 `provider` / `model` /
     * `reasoning_effort`（`modelSelectionSettings` 打开时才可能出现）时返回对象，
     * 该字段与工具实例上的 `agentOptions` 同义，是最强的一次性路由证据。
     * @param args - `tool/call` 的 arguments 解析结果。
     * @returns `{ provider, model, reasoningEffort }` 或 null。
     */
    function routeOfDispatchArgs(args) {
      if (args === null || typeof args !== "object") return null;
      const provider = typeof args.provider === "string" && args.provider.length > 0 ? args.provider : null;
      const model = typeof args.model === "string" && args.model.length > 0 ? args.model : null;
      const reasoningEffort = typeof args.reasoning_effort === "string" && args.reasoning_effort.length > 0
        ? args.reasoning_effort : null;
      if (provider === null && model === null && reasoningEffort === null) return null;
      return { provider, model, reasoningEffort };
    }

    /** 路由对象 → 可读的 `provider / model` 目标串（tooltip 用）。 */
    function routeTarget(route) {
      if (route === null || typeof route !== "object") return "";
      const parts = [];
      if (typeof route.provider === "string" && route.provider.length > 0) parts.push(route.provider);
      if (typeof route.model === "string" && route.model.length > 0) parts.push(route.model);
      return parts.join(" / ");
    }

    /** modelSelection 投影里当前生效的那一层（与 typeOfSelection 同口径）。 */
    function selectedRouteOf(selection) {
      if (selection === null || typeof selection !== "object") return null;
      const selected = selection.lastUsed !== null && typeof selection.lastUsed === "object"
        ? selection.lastUsed
        : (selection.current !== null && typeof selection.current === "object" ? selection.current : selection);
      return selected !== null && typeof selected === "object" ? selected : null;
    }

    /**
     * 行 → 实际路由派生的类型。优先级：派发参数显式路由（`row.route`，来自
     * `tool/call` 的 arguments）> 子会话持久化的 `row.modelSelection` 投影。
     * 两者都识别不出时返回 null，由 `rowType` 回落到工具名。
     * @returns `{ label, color, source, route }` 或 null。
     */
    function typeOfRoute(row) {
      if (row === null || typeof row !== "object") return null;
      const explicit = routeOfDispatchArgs(row.route);
      if (explicit !== null) {
        const typed = typeOfSelection(explicit);
        if (typed !== null) return { label: typed.label, color: typed.color, source: "dispatch", route: explicit };
      }
      const typedSelection = typeOfSelection(row.modelSelection);
      if (typedSelection !== null) {
        const selected = selectedRouteOf(row.modelSelection);
        return {
          label: typedSelection.label,
          color: typedSelection.color,
          source: "selection",
          route: {
            provider: selected !== null && typeof selected.provider === "string" ? selected.provider : null,
            model: selected !== null && typeof selected.model === "string" ? selected.model : null,
            reasoningEffort: null,
          },
        };
      }
      return null;
    }

    /* ── 纯函数：结果解析（spec §3） ───────────────────────────────── */

    /** 安全 JSON.parse：失败返回 null。 */
    function parseJson(text) {
      if (typeof text !== "string" || text.length === 0) return null;
      try {
        return JSON.parse(text);
      } catch (_) {
        return null;
      }
    }

    /**
     * 括号配平：从首个 `{` / `[` 起，尊重字符串与转义，截取一段平衡 JSON 候选。
     * 找不到平衡段时返回 null。
     */
    function extractBalanced(text) {
      if (typeof text !== "string") return null;
      let start = -1;
      for (let i = 0; i < text.length; i++) {
        if (text[i] === "{" || text[i] === "[") { start = i; break; }
      }
      if (start < 0) return null;
      const open = text[start];
      const close = open === "{" ? "}" : "]";
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
          if (escaped) { escaped = false; continue; }
          if (ch === "\\") { escaped = true; continue; }
          if (ch === "\"") { inString = false; continue; }
          continue;
        }
        if (ch === "\"") { inString = true; continue; }
        if (ch === "{" || ch === "[") depth++;
        else if (ch === "}" || ch === "]") {
          depth--;
          if (depth === 0) return text.slice(start, i + 1);
        }
      }
      return null;
    }

    /** 去 JSON 字符串转义（`\"` `\\` `\n` `\t` `\r` `\/`）。 */
    function decodeJsonEscapes(text) {
      if (typeof text !== "string") return "";
      let out = "";
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === "\\" && i + 1 < text.length) {
          const nx = text[i + 1];
          if (nx === "\"") { out += "\""; i++; continue; }
          if (nx === "\\") { out += "\\"; i++; continue; }
          if (nx === "n") { out += "\n"; i++; continue; }
          if (nx === "t") { out += "\t"; i++; continue; }
          if (nx === "r") { out += "\r"; i++; continue; }
          if (nx === "/") { out += "/"; i++; continue; }
          out += nx; i++; continue;
        }
        out += ch;
      }
      return out;
    }

    /**
     * 处理“JSON 被再包一层引号”的结果文本：整体是 JSON 字符串字面量时直接
     * JSON.parse；否则含 `\"` 时解一层转义。都不适用返回 null。
     */
    function tryUnescapeString(text) {
      const t = typeof text === "string" ? text.trim() : "";
      if (t.length === 0) return null;
      if (t[0] === "\"") {
        const value = parseJson(t);
        return typeof value === "string" ? value : null;
      }
      if (t.indexOf("\\\"") >= 0) return decodeJsonEscapes(t);
      return null;
    }

    /**
     * 递归搜索已解析的 JSON 节点，识别派发结果形状。
     * @param node - 任意 JSON 值。
     * @param depth - 递归深度护栏。
     */
    function searchNode(node, depth) {
      if (depth > 6 || node === null || node === undefined) return null;
      if (Array.isArray(node)) {
        for (const item of node) {
          const found = searchNode(item, depth + 1);
          if (found !== null) return found;
        }
        return null;
      }
      if (typeof node !== "object") return null;
      if (node.kind === "background" && typeof node.jobId === "string") return { kind: "background", jobId: node.jobId };
      if (node.kind === "continuable" && typeof node.subagentId === "string") return { kind: "continuable", subagentId: node.subagentId };
      if (node.kind === "foreground" && typeof node.runId === "string") return { kind: "foreground", runId: node.runId };
      for (const key of Object.keys(node)) {
        const found = searchNode(node[key], depth + 1);
        if (found !== null) return found;
      }
      return null;
    }

    /**
     * 结果文本 → 派发描述（spec §3）。覆盖：纯 JSON、带前缀 JSON、JSON 数组、
     * 嵌套对象、被再包一层的转义 JSON、以及 dsh-tool-subagent 的持久化
     * renderer 文本。全部失败返回 null（前台 one-shot 事后无 runId → null）。
     * @param text - `tool/result` 的文本内容。
     * @returns { kind, jobId? subagentId? runId? } | null。
     */
    function parseDispatch(text) {
      if (typeof text !== "string") return null;
      const raw = text.trim();
      if (raw.length === 0) return null;

      const candidates = [raw];
      const balanced = extractBalanced(raw);
      if (balanced !== null && balanced !== raw) candidates.push(balanced);
      for (const cand of candidates) {
        const found = searchNode(parseJson(cand), 0);
        if (found !== null) return found;
      }

      const unescaped = tryUnescapeString(raw);
      if (unescaped !== null) {
        const found = searchNode(parseJson(unescaped), 0);
        if (found !== null) return found;
        const inner = extractBalanced(unescaped);
        if (inner !== null) {
          const nested = searchNode(parseJson(inner), 0);
          if (nested !== null) return nested;
        }
      }

      const background = raw.match(/started\s+background\s+subagent\s+job\s+([A-Za-z0-9_.:\-]+)/);
      if (background !== null) return { kind: "background", jobId: background[1] };
      const continuable = raw.match(/started\s+subagent\s+([A-Za-z0-9_.:\-]+)/);
      if (continuable !== null) return { kind: "continuable", subagentId: continuable[1] };
      return null;
    }

    /* ── 纯函数：时间与状态（spec §4） ─────────────────────────────── */

    /** 毫秒 → 紧凑中文时长（秒 / 分钟 / 小时，最多两级）。 */
    function formatAge(ms) {
      const value = typeof ms === "number" && isFinite(ms) ? Math.max(0, ms) : 0;
      const seconds = Math.round(value / 1000);
      if (seconds < 60) return seconds + " 秒";
      const minutes = Math.round(seconds / 60);
      if (minutes < 60) return minutes + " 分钟";
      const hours = Math.floor(minutes / 60);
      const rem = minutes % 60;
      return rem > 0 ? hours + " 小时 " + rem + " 分钟" : hours + " 小时";
    }

    /** `turn/end.reason.kind` → 中文标签。 */
    function turnEndLabel(kind) {
      switch (kind) {
        case "completed": return "本轮完成";
        case "aborted": return "本轮已中止";
        case "interrupted": return "本轮已中断";
        case "error": return "本轮失败";
        case "blocked": return "本轮被阻塞";
        case "max-tokens": return "达到输出上限";
        case "forked": return "分叉边界";
        default: return "本轮结束";
      }
    }

    /** `turn/end.reason.kind` → 终态 { text, tone }。 */
    function turnEndStatus(kind) {
      if (kind === "completed") return { text: "已完成", tone: "done" };
      if (kind === "aborted" || kind === "interrupted") return { text: "已停止", tone: "warn" };
      if (kind === "error" || kind === "blocked" || kind === "max-tokens") return { text: "已失败", tone: "error" };
      if (typeof kind === "string" && kind.length > 0) return { text: "已结束", tone: "muted" };
      return null;
    }

    /** 行状态（spec §4 优先级：job.status > 子会话 running/turn-end > delegation）。 */
    function statusOf(row) {
      if (row === null || typeof row !== "object") return { text: "未知", tone: "muted" };
      if (row.archived === true) {
        const archivedStatus = typeof row.archivedStatus === "string" ? row.archivedStatus : "";
        return { text: "历史 · " + archivedStatus, tone: "muted" };
      }
      if (row.job !== null && typeof row.job === "object") {
        switch (row.job.status) {
          case "running": return { text: "运行中", tone: "run" };
          case "stopping": return { text: "停止中", tone: "warn" };
          case "completed": return { text: "已完成", tone: "done" };
          case "killed": return { text: "已停止", tone: "warn" };
          case "failed": return { text: "已失败", tone: "error" };
          default: break;
        }
      }
      if (row.child !== null && typeof row.child === "object") {
        if (typeof row.turnEndKind === "string" && row.turnEndKind.length > 0 && row.child.running !== true) {
          const terminal = turnEndStatus(row.turnEndKind);
          if (terminal !== null) return terminal;
        }
        if (row.child.running === true) return { text: "运行中", tone: "run" };
        return { text: "已停止", tone: "muted" };
      }
      if (row.delegation !== undefined && row.delegation !== null) return { text: "已派发", tone: "muted" };
      return { text: "未关联", tone: "muted" };
    }

    /** 子会话行的“最近活动”时间：max(最新事件时间, timing.active.through, updatedAt)。 */
    function latestChildActivity(row, now) {
      let last = 0;
      if (row !== null && typeof row === "object") {
        if (typeof row.lastEventTime === "number") last = Math.max(last, row.lastEventTime);
        if (row.timing !== null && typeof row.timing === "object"
          && row.timing.active !== null && typeof row.timing.active === "object"
          && typeof row.timing.active.through === "number") {
          last = Math.max(last, row.timing.active.through);
        }
        if (row.child !== null && typeof row.child === "object" && typeof row.child.updatedAt === "number") {
          last = Math.max(last, row.child.updatedAt);
        }
      }
      if (last === 0) last = typeof now === "number" ? now : Date.now();
      return last;
    }

    /**
     * keepalive 文案（spec §4）。job 行优先 status/observed/progress；子会话行
     * 用最近活动 + timing；静默超阈值时明确标注“UI 推断，非 ACP 真实心跳”。
     */
    function keepaliveOf(row, now) {
      const nowMs = typeof now === "number" ? now : Date.now();
      if (row === null || typeof row !== "object") return "";
      if (row.archived === true) return "历史记录（父会话窗口已裁剪）";

      if (row.job !== null && typeof row.job === "object") {
        const job = row.job;
        const observed = row.observed !== null && typeof row.observed === "object" ? row.observed : null;
        if (job.status === "running" || job.status === "stopping") {
          if (observed !== null && observed.streaming === true) {
            return "活跃 · 已运行 " + formatAge(nowMs - job.startedAt);
          }
          if (typeof job.progress === "string" && job.progress.length > 0) return job.progress;
          return "已运行 " + formatAge(nowMs - job.startedAt);
        }
        if (typeof job.detail === "string" && job.detail.length > 0) return job.detail;
        const end = typeof job.finishedAt === "number" ? job.finishedAt : nowMs;
        return "历时 " + formatAge(end - job.startedAt);
      }

      if (row.child !== null && typeof row.child === "object") {
        const child = row.child;
        const timing = row.timing !== null && typeof row.timing === "object" ? row.timing : null;
        const last = latestChildActivity(row, nowMs);
        if (child.running === true) {
          const silent = nowMs - last;
          if (silent > SILENT_THRESHOLD_MS) {
            return "运行中 · 已静默 " + formatAge(silent) + "（UI 推断，非 ACP 真实心跳）";
          }
          if (timing !== null && timing.active !== null && typeof timing.active === "object"
            && typeof timing.active.since === "number") {
            return "本轮已运行 " + formatAge(nowMs - timing.active.since);
          }
          return "活跃 " + formatAge(silent) + "前";
        }
        if (timing !== null && typeof timing.settledMs === "number" && timing.settledMs > 0) {
          return "已结算 " + formatAge(timing.settledMs);
        }
        return "最近活动 " + formatAge(nowMs - last) + "前";
      }

      if (row.delegation !== undefined && row.delegation !== null) return "已派发";
      return "";
    }

    /** 行是否处于活动态（触发器计数、排序提示用）。 */
    function isActiveRow(row) {
      if (row === null || typeof row !== "object") return false;
      if (row.archived === true) return false;
      if (row.job !== null && typeof row.job === "object") {
        return row.job.status === "running" || row.job.status === "stopping";
      }
      if (row.child !== null && typeof row.child === "object") return row.child.running === true;
      return false;
    }

    /** 模式短名（spec §4 渲染口径）。 */
    function modeLabel(mode) {
      switch (mode) {
        case "background": return "后台";
        case "continuable": return "续接";
        case "foreground": return "前台";
        default: return "未知";
      }
    }

    /* ── 纯函数：token 与行视觉标记 ─────────────────────────────────── */

    /**
     * 数字 → 紧凑 token 文案。<1000 整数；<1e6 一位小数 k（1000→"1k"）；
     * 否则一位小数 M。仅格式化已测得的投影值。
     */
    function formatTokens(n) {
      const value = typeof n === "number" && isFinite(n) ? Math.max(0, n) : 0;
      if (value < 1000) return String(Math.round(value));
      if (value < 1e6) {
        const k = Math.round((value / 1000) * 10) / 10;
        return (k % 1 === 0 ? String(Math.round(k)) : k.toFixed(1)) + "k";
      }
      const m = Math.round((value / 1e6) * 10) / 10;
      return (m % 1 === 0 ? String(Math.round(m)) : m.toFixed(1)) + "M";
    }

    /**
     * 子会话投影 values → 真实 token 对象；三者皆缺返回 null。
     * 兼容 `tokenUsage.totals` 与 `tokenUsage.val.totals`（及 contextPressure 同形）。
     */
    function tokensOfProjection(values) {
      if (values === null || typeof values !== "object") return null;

      let totals = null;
      const tokenUsage = values.tokenUsage;
      if (tokenUsage !== null && typeof tokenUsage === "object") {
        if (tokenUsage.totals !== null && typeof tokenUsage.totals === "object") totals = tokenUsage.totals;
        else if (tokenUsage.val !== null && typeof tokenUsage.val === "object"
          && tokenUsage.val.totals !== null && typeof tokenUsage.val.totals === "object") {
          totals = tokenUsage.val.totals;
        }
      }

      let pressure = null;
      const contextPressure = values.contextPressure;
      if (contextPressure !== null && typeof contextPressure === "object") {
        if (typeof contextPressure.surfaceTokens === "number" || typeof contextPressure.contextWindow === "number") {
          pressure = contextPressure;
        } else if (contextPressure.val !== null && typeof contextPressure.val === "object") {
          pressure = contextPressure.val;
        }
      }

      const output = totals !== null && typeof totals.outputTokens === "number" && isFinite(totals.outputTokens)
        ? totals.outputTokens : null;
      let input = null;
      if (totals !== null) {
        const uncached = typeof totals.uncachedInputTokens === "number" && isFinite(totals.uncachedInputTokens)
          ? totals.uncachedInputTokens : null;
        const cacheRead = typeof totals.cacheReadTokens === "number" && isFinite(totals.cacheReadTokens)
          ? totals.cacheReadTokens : null;
        if (uncached !== null || cacheRead !== null) {
          input = (uncached !== null ? uncached : 0) + (cacheRead !== null ? cacheRead : 0);
        }
      }
      const context = pressure !== null && typeof pressure.surfaceTokens === "number" && isFinite(pressure.surfaceTokens)
        ? pressure.surfaceTokens : null;
      const contextWindow = pressure !== null && typeof pressure.contextWindow === "number" && isFinite(pressure.contextWindow)
        ? pressure.contextWindow : null;

      if (output === null && input === null && context === null) return null;
      return { output, input, context, contextWindow };
    }

    /** 行 → token 展示文案；无真实 tokens 对象或各项皆空 → ""。 */
    function tokensLabel(row) {
      if (row === null || typeof row !== "object") return "";
      const tokens = row.tokens;
      if (tokens === null || typeof tokens !== "object") return "";
      const parts = [];
      if (typeof tokens.output === "number" && isFinite(tokens.output)) {
        parts.push("生成 " + formatTokens(tokens.output));
      }
      if (typeof tokens.input === "number" && isFinite(tokens.input)) {
        parts.push("输入 " + formatTokens(tokens.input));
      }
      if (typeof tokens.context === "number" && isFinite(tokens.context)) {
        const windowPart = typeof tokens.contextWindow === "number" && isFinite(tokens.contextWindow)
          ? formatTokens(tokens.contextWindow) : "—";
        parts.push("上下文 " + formatTokens(tokens.context) + "/" + windowPart);
      }
      return parts.join(" · ");
    }

    function isOneShotRow(row) {
      return row !== null && typeof row === "object" && row.oneShot === true;
    }

    function rowFontSize(row) {
      return isOneShotRow(row) ? 11.5 : 12.5;
    }

    /** 行 → 模式 chip { text, tone }。 */
    function rowChip(row) {
      if (row === null || typeof row !== "object") return { text: "子代理", tone: "muted" };
      if (row.archived === true) return { text: "历史", tone: "muted" };
      if (row.oneShot === true) return { text: "一次性", tone: "once" };
      if (row.mode === "continuable") return { text: "可续接", tone: "reuse" };
      if (row.mode === "background") return { text: "后台", tone: "job" };
      return { text: "子代理", tone: "muted" };
    }

    /* ── 纯函数：本地持久化（spec §4） ─────────────────────────────── */

    const PERSIST_VERSION = 1;
    const PERSIST_KEY_PREFIX = "dsh-subagent-monitor:v1:";
    const PERSIST_MAX_ROWS = 80;
    const PERSIST_MAX_TEXT = 400;

    /** 每个 sessionId 最近一次写入的 rowsSignature，避免每帧重复写。 */
    const persistedSignatures = new Map();

    /** sessionId → 本地存储键（按会话隔离）。 */
    function persistKey(sessionId) {
      return PERSIST_KEY_PREFIX + String(sessionId);
    }

    /** 解析可用的 Web Storage；无 window / 访问被拒 / 形状不符时返回 null。 */
    function resolveStorage() {
      try {
        if (typeof globalThis === "undefined" || globalThis === null) return null;
        const ls = globalThis.localStorage;
        if (ls === null || ls === undefined) return null;
        if (typeof ls.getItem !== "function" || typeof ls.setItem !== "function") return null;
        return ls;
      } catch (_) {
        return null;
      }
    }

    /** 行内容 → 可持久化的短预览文本。仅本地只读记录，不推算任何 token。 */
    function snapshotPreviewText(row) {
      if (row === null || typeof row !== "object") return "";
      if (typeof row.preview === "string") return row.preview;
      const delegation = row.delegation !== null && typeof row.delegation === "object" ? row.delegation : null;
      if (delegation !== null && typeof delegation.resultText === "string") return delegation.resultText;
      return "";
    }

    /**
     * 行 → 可持久化快照。只保留渲染与状态所需的最小字段；`savedAt` 为写入时间。
     * 绝不写入或推算 token：tokens 只搬运行上已由子会话真实投影得到的对象。
     */
    function snapshotRow(row, now) {
      const src = row !== null && typeof row === "object" ? row : {};
      const savedAt = typeof now === "number" ? now : Date.now();
      const startedAt = typeof src.startedAt === "number" ? src.startedAt : savedAt;
      return {
        key: typeof src.key === "string" ? src.key : String(src.key),
        kind: typeof src.kind === "string" ? src.kind : "unknown",
        childId: typeof src.childId === "string" ? src.childId : undefined,
        jobId: typeof src.jobId === "string" ? src.jobId : undefined,
        runId: typeof src.runId === "string" ? src.runId : undefined,
        toolName: typeof src.toolName === "string" ? src.toolName : undefined,
        label: typeof src.label === "string" ? src.label : "",
        mode: typeof src.mode === "string" ? src.mode : "unknown",
        oneShot: src.oneShot === true,
        startedAt,
        savedAt,
        tokens: src.tokens !== null && typeof src.tokens === "object" ? src.tokens : null,
        modelSelection: src.modelSelection !== null && typeof src.modelSelection === "object" ? src.modelSelection : null,
        route: src.route !== null && typeof src.route === "object" ? {
          provider: typeof src.route.provider === "string" ? src.route.provider : null,
          model: typeof src.route.model === "string" ? src.route.model : null,
          reasoningEffort: typeof src.route.reasoningEffort === "string" ? src.route.reasoningEffort : null,
        } : null,
        statusText: statusOf(src).text,
        preview: preview(snapshotPreviewText(src), PERSIST_MAX_TEXT),
      };
    }

    /** 读取某会话的持久化快照数组；无 storage / 无键 / JSON 损坏 → []。 */
    function loadPersisted(storage, sessionId) {
      if (storage === null || storage === undefined || typeof storage.getItem !== "function") return [];
      let raw = null;
      try { raw = storage.getItem(persistKey(sessionId)); } catch (_) { return []; }
      if (typeof raw !== "string" || raw.length === 0) return [];
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch (_) { return []; }
      if (parsed === null || typeof parsed !== "object") return [];
      const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
      const out = [];
      for (const item of rows) {
        if (item !== null && typeof item === "object" && typeof item.key === "string") out.push(item);
      }
      return out;
    }

    /**
     * 写入某会话快照：按 startedAt 倒序、截断 PERSIST_MAX_ROWS 行后整体覆盖。
     * 任何失败返回 false，不抛。
     */
    function savePersisted(storage, sessionId, rows) {
      if (storage === null || storage === undefined || typeof storage.setItem !== "function") return false;
      const now = Date.now();
      const list = Array.isArray(rows) ? rows.slice() : [];
      list.sort((a, b) => {
        const sa = a !== null && typeof a === "object" && typeof a.startedAt === "number" ? a.startedAt : 0;
        const sb = b !== null && typeof b === "object" && typeof b.startedAt === "number" ? b.startedAt : 0;
        const ka = a !== null && typeof a === "object" ? a.key : "";
        const kb = b !== null && typeof b === "object" ? b.key : "";
        return (sb - sa) || String(ka).localeCompare(String(kb));
      });
      const trimmed = list.slice(0, PERSIST_MAX_ROWS).map((row) => snapshotRow(row, now));
      const payload = { version: PERSIST_VERSION, savedAt: now, rows: trimmed };
      try {
        storage.setItem(persistKey(sessionId), JSON.stringify(payload));
        return true;
      } catch (_) {
        return false;
      }
    }

    /**
     * 快照 → 历史行（archived:true）。运行时资源（child/timing/job/observed）
     * 一律为 null，confidence 固定为 "archived"，并携带历史态字段。
     */
    function restoreRow(snapshot) {
      const s = snapshot !== null && typeof snapshot === "object" ? snapshot : {};
      const startedAt = typeof s.startedAt === "number" ? s.startedAt : 0;
      return {
        key: typeof s.key === "string" ? s.key : "",
        kind: typeof s.kind === "string" ? s.kind : "delegation",
        sessionId: undefined,
        childId: typeof s.childId === "string" ? s.childId : undefined,
        jobId: typeof s.jobId === "string" ? s.jobId : undefined,
        runId: typeof s.runId === "string" ? s.runId : undefined,
        toolName: typeof s.toolName === "string" ? s.toolName : undefined,
        label: typeof s.label === "string" ? s.label : "",
        mode: typeof s.mode === "string" ? s.mode : "unknown",
        oneShot: s.oneShot === true,
        archived: true,
        tokens: s.tokens !== null && typeof s.tokens === "object" ? s.tokens : null,
        confidence: "archived",
        createdAt: startedAt,
        startedAt,
        child: null,
        timing: null,
        modelSelection: s.modelSelection !== null && typeof s.modelSelection === "object" ? s.modelSelection : null,
        route: s.route !== null && typeof s.route === "object" ? {
          provider: typeof s.route.provider === "string" ? s.route.provider : null,
          model: typeof s.route.model === "string" ? s.route.model : null,
          reasoningEffort: typeof s.route.reasoningEffort === "string" ? s.route.reasoningEffort : null,
        } : null,
        job: null,
        observed: null,
        lastEventTime: 0,
        archivedStatus: typeof s.statusText === "string" ? s.statusText : "",
        archivedPreview: typeof s.preview === "string" ? s.preview : "",
        archivedAt: typeof s.savedAt === "number" ? s.savedAt : 0,
      };
    }

    /**
     * 合并实时行与历史快照：按 key 去重（实时行优先），历史行补在其后，
     * 整体按 startedAt 倒序。
     */
    function mergePersisted(liveRows, storedRows) {
      const live = Array.isArray(liveRows)
        ? liveRows.filter((row) => row !== null && typeof row === "object" && typeof row.key === "string")
        : [];
      const liveKeys = new Set();
      for (const row of live) liveKeys.add(row.key);
      const restored = [];
      for (const snap of Array.isArray(storedRows) ? storedRows : []) {
        if (snap === null || typeof snap !== "object" || typeof snap.key !== "string") continue;
        if (liveKeys.has(snap.key)) continue;
        restored.push(restoreRow(snap));
      }
      const merged = live.concat(restored);
      merged.sort((a, b) => {
        const sa = typeof a.startedAt === "number" ? a.startedAt : 0;
        const sb = typeof b.startedAt === "number" ? b.startedAt : 0;
        return (sb - sa) || String(a.key).localeCompare(String(b.key));
      });
      return merged;
    }

    /**
     * 行集合的稳定签名：key + archived 标记 + statusOf(row).text +
     * tokensLabel(row) + 秒级 startedAt。用于跳过每帧的重复写入。
     */
    function rowsSignature(rows) {
      const parts = [];
      for (const row of Array.isArray(rows) ? rows : []) {
        if (row === null || typeof row !== "object") continue;
        const key = typeof row.key === "string" ? row.key : "";
        const archived = row.archived === true ? "1" : "0";
        const startedAt = typeof row.startedAt === "number" ? Math.floor(row.startedAt / 1000) : 0;
        parts.push(key + "|" + archived + "|" + statusOf(row).text + "|" + tokensLabel(row) + "|" + startedAt);
      }
      parts.sort();
      return parts.join("\n");
    }

    /* ── 纯函数：关联置信度（spec §4） ─────────────────────────────── */

    /**
     * background job → child 的一对一关联。候选：label 完全相等且
     * `child.createdAt >= job.startedAt - tolerance`。取时间差最小者；多个
     * 同等最小差 → ambiguous（不猜）。
     * @param job - JobView。
     * @param children - `{ id, label, createdAt }[]`。
     * @param tolerance - 容忍窗（毫秒）。
     * @returns { confidence: 'exact'|'ambiguous'|'none', childId?, candidates? }。
     */
    function associateBackground(job, children, tolerance) {
      const tol = typeof tolerance === "number" ? tolerance : DEFAULT_TOLERANCE_MS;
      const label = job !== null && typeof job === "object" && typeof job.label === "string" ? job.label : "";
      const startedAt = job !== null && typeof job === "object" && typeof job.startedAt === "number" ? job.startedAt : 0;
      if (label.length === 0) return { confidence: "none" };
      const candidates = [];
      for (const child of Array.isArray(children) ? children : []) {
        if (child === null || typeof child !== "object") continue;
        if (typeof child.label !== "string" || child.label !== label) continue;
        const createdAt = typeof child.createdAt === "number" ? child.createdAt : -Infinity;
        if (!(createdAt >= startedAt - tol)) continue;
        candidates.push({ childId: child.id, distance: Math.abs(createdAt - startedAt) });
      }
      if (candidates.length === 0) return { confidence: "none" };
      candidates.sort((a, b) => a.distance - b.distance || String(a.childId).localeCompare(String(b.childId)));
      if (candidates.length > 1 && candidates[1].distance === candidates[0].distance) {
        return { confidence: "ambiguous", candidates: candidates.map((c) => c.childId) };
      }
      return { confidence: "exact", childId: candidates[0].childId };
    }

    /**
     * 前台 one-shot 关联：仅在 label + 时间窗内**唯一**时给
     * `exact-by-unique-window`，否则不关联（进独立行）。
     */
    function associateForeground(delegation, children, tolerance) {
      const tol = typeof tolerance === "number" ? tolerance : DEFAULT_TOLERANCE_MS;
      const label = delegation !== null && typeof delegation === "object" && typeof delegation.label === "string"
        ? delegation.label : "";
      const at = delegation !== null && typeof delegation === "object" && typeof delegation.startedAt === "number"
        ? delegation.startedAt : 0;
      if (label.length === 0) return { confidence: "none" };
      const candidates = [];
      for (const child of Array.isArray(children) ? children : []) {
        if (child === null || typeof child !== "object") continue;
        if (typeof child.label !== "string" || child.label !== label) continue;
        const createdAt = typeof child.createdAt === "number" ? child.createdAt : 0;
        if (Math.abs(createdAt - at) <= tol) candidates.push(child.id);
      }
      if (candidates.length === 1) return { confidence: "exact-by-unique-window", childId: candidates[0] };
      if (candidates.length > 1) return { confidence: "ambiguous", candidates };
      return { confidence: "none" };
    }

    /* ── 纯函数：结果文本与输出折叠（spec §5） ─────────────────────── */

    /** 内容块/字符串 → 纯文本（只取 text 块）。 */
    function contentText(content) {
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      const parts = [];
      for (const block of content) {
        if (typeof block === "string") { parts.push(block); continue; }
        if (block !== null && typeof block === "object" && typeof block.text === "string") parts.push(block.text);
      }
      return parts.join("\n");
    }

    /** 单行预览：折叠空白并截断。 */
    function preview(text, limit) {
      const raw = typeof text === "string" ? text : "";
      const flat = raw.replace(/\s+/g, " ").trim();
      const max = typeof limit === "number" && limit > 0 ? limit : 120;
      return flat.length > max ? flat.slice(0, max) + "…" : flat;
    }

    /**
     * 从父会话 transcript 收集 subagent 相关派发：`tool/call`（name 以
     * subagent 开头）与配对的 `tool/result`。
     * @param entries - SessionEventLikeEntry[]。
     * @returns `{ callId, name, startedAt, route, resultText }[]`。
     */
    function collectDelegations(entries) {
      const pending = new Map();
      const out = [];
      for (const entry of Array.isArray(entries) ? entries : []) {
        const event = entry !== null && typeof entry === "object" ? entry.event : null;
        if (event === null || typeof event !== "object") continue;
        if (event.type === "tool/call") {
          const data = event.data !== null && typeof event.data === "object" ? event.data : {};
          const name = typeof data.name === "string" ? data.name : "";
          if (!name.startsWith("subagent")) continue;
          const args = parseJson(typeof data.arguments === "string" ? data.arguments : "");
          pending.set(data.callId, {
            callId: data.callId,
            name,
            label: args !== null && typeof args === "object" && typeof args.description === "string" ? args.description : "",
            runInBackground: args !== null && typeof args === "object" && args.run_in_background === true,
            route: routeOfDispatchArgs(args),
            startedAt: typeof event.time === "number" ? event.time : Date.now(),
          });
        } else if (event.type === "tool/result") {
          const data = event.data !== null && typeof event.data === "object" ? event.data : {};
          const message = data.message !== null && typeof data.message === "object" ? data.message : {};
          const call = pending.get(message.toolCallId);
          if (call === undefined) continue;
          out.push({
            callId: call.callId,
            name: call.name,
            label: call.label,
            runInBackground: call.runInBackground,
            route: call.route,
            startedAt: call.startedAt,
            resultText: contentText(message.content),
          });
          pending.delete(message.toolCallId);
        } else if (event.type === "tool/ptc-dispatch") {
          // PTC 分发：run_code 程序内的子代理调用不产生 tool/call，只留此记录；
          // 该记录自带 arguments 与 content，无需与 tool/result 配对。
          const data = event.data !== null && typeof event.data === "object" ? event.data : {};
          const name = typeof data.name === "string" ? data.name : "";
          if (!name.startsWith("subagent")) continue;
          const raw = data.arguments;
          const args = typeof raw === "string" ? parseJson(raw)
            : (raw !== null && typeof raw === "object" ? raw : null);
          out.push({
            callId: typeof data.subCallId === "string" && data.subCallId.length > 0
              ? data.subCallId
              : (typeof data.rootCallId === "string" ? data.rootCallId : null),
            name,
            label: args !== null && typeof args === "object" && typeof args.description === "string" ? args.description : "",
            runInBackground: args !== null && typeof args === "object" && args.run_in_background === true,
            route: routeOfDispatchArgs(args),
            startedAt: typeof event.time === "number" ? event.time : Date.now(),
            resultText: contentText(data.content),
          });
        }
      }
      return out;
    }

    /**
     * 事件窗口 → 输出行（子会话输出区）。处理 live-chunk（text/reasoning/
     * tool-call delta）、durable assistant/message settlement、tool/call、
     * tool/result、turn/end。事件形状异常时跳过该行，不抛错。
     */
    function foldEntries(entries) {
      const lines = [];
      let current = "";
      const flush = () => { if (current.length > 0) { lines.push(current); current = ""; } };
      for (const entry of Array.isArray(entries) ? entries : []) {
        const event = entry !== null && typeof entry === "object" ? entry.event : null;
        if (event === null || typeof event !== "object") continue;
        if (event.type === "assistant/live-chunk") {
          const data = event.data !== null && typeof event.data === "object" ? event.data : {};
          const chunk = data.chunk !== null && typeof data.chunk === "object" ? data.chunk : null;
          if (chunk === null) continue;
          if (chunk.type === "text-delta" && typeof chunk.text === "string") current += chunk.text;
          else if (chunk.type === "reasoning-delta" && typeof chunk.text === "string") { flush(); lines.push("· " + chunk.text); }
          else if (chunk.type === "tool-call-delta" && typeof chunk.name === "string" && chunk.name.length > 0) { flush(); lines.push("→ " + chunk.name); }
        } else if (event.type === "assistant/message") {
          flush();
          const data = event.data !== null && typeof event.data === "object" ? event.data : {};
          const message = data.message !== null && typeof data.message === "object" ? data.message : null;
          const text = contentText(message !== null ? message.content : null);
          if (text.length > 0) lines.push(text);
        } else if (event.type === "tool/call") {
          flush();
          const data = event.data !== null && typeof event.data === "object" ? event.data : {};
          const name = typeof data.name === "string" ? data.name : "tool";
          const args = typeof data.arguments === "string" ? data.arguments : "";
          lines.push("→ " + name + (args.length > 0 ? " " + preview(args, 120) : ""));
        } else if (event.type === "tool/result") {
          flush();
          const data = event.data !== null && typeof event.data === "object" ? event.data : {};
          const message = data.message !== null && typeof data.message === "object" ? data.message : null;
          const text = contentText(message !== null ? message.content : null);
          const isError = message !== null && message.isError === true;
          lines.push((isError ? "✗ " : "← ") + preview(text, 200));
        } else if (event.type === "turn/end") {
          flush();
          const data = event.data !== null && typeof event.data === "object" ? event.data : {};
          const reason = data.reason !== null && typeof data.reason === "object" ? data.reason : {};
          lines.push("— " + turnEndLabel(typeof reason.kind === "string" ? reason.kind : ""));
        }
      }
      flush();
      return lines;
    }

    /** 尾部裁剪：保留最近 maxLines 行 / maxBytes 字节（长度近似字节）。 */
    function trimTail(lines, maxLines, maxBytes) {
      const list = Array.isArray(lines) ? lines.slice() : [];
      const lineCap = typeof maxLines === "number" && maxLines > 0 ? maxLines : MAX_TAIL_LINES;
      const byteCap = typeof maxBytes === "number" && maxBytes > 0 ? maxBytes : MAX_TAIL_BYTES;
      let truncated = false;
      if (list.length > lineCap) {
        list.splice(0, list.length - lineCap);
        truncated = true;
      }
      let total = 0;
      for (let i = 0; i < list.length; i++) total += list[i].length + 1;
      while (list.length > 1 && total > byteCap) {
        total -= list[0].length + 1;
        list.shift();
        truncated = true;
      }
      return { lines: list, truncated };
    }

    /* ── 纯函数：行合并（spec §4 集合与关联） ──────────────────────── */

    /** 目录条目 → 子会话行。 */
    function makeChildRow(sessionId, entry, summary, timing, modelSelection, now) {
      const mode = entry.mode === "continuable" ? "continuable" : entry.mode === "one-shot" ? "foreground" : "unknown";
      const fallbackLabel = summary !== null && typeof summary === "object" && typeof summary.displayTitle === "string"
        ? summary.displayTitle : String(entry.id);
      const label = typeof entry.label === "string" && entry.label.length > 0 ? entry.label : fallbackLabel;
      const createdAt = typeof entry.createdAt === "number" ? entry.createdAt
        : (summary !== null && typeof summary === "object" && typeof summary.updatedAt === "number" ? summary.updatedAt : now);
      return {
        key: "child:" + entry.id,
        kind: "child",
        sessionId,
        childId: entry.id,
        jobId: undefined,
        runId: undefined,
        toolName: undefined,
        label,
        mode,
        oneShot: entry.mode !== "continuable",
        archived: false,
        tokens: null,
        confidence: undefined,
        createdAt,
        startedAt: createdAt,
        child: summary !== null && typeof summary === "object"
          ? summary
          : { id: entry.id, running: false, updatedAt: createdAt },
        timing: timing !== null && typeof timing === "object" ? timing : null,
        modelSelection: modelSelection !== null && typeof modelSelection === "object" ? modelSelection : null,
        route: null,
        job: null,
        observed: null,
        lastEventTime: 0,
        linkedJobId: undefined,
      };
    }

    /** JobView → job 行。 */
    function makeJobRow(sessionId, job, observed, now) {
      return {
        key: "job:" + job.id,
        kind: "job",
        sessionId,
        childId: undefined,
        jobId: job.id,
        runId: undefined,
        toolName: undefined,
        label: typeof job.label === "string" && job.label.length > 0 ? job.label : String(job.id),
        mode: "background",
        oneShot: false,
        archived: false,
        tokens: null,
        confidence: undefined,
        createdAt: typeof job.startedAt === "number" ? job.startedAt : now,
        startedAt: typeof job.startedAt === "number" ? job.startedAt : now,
        child: null,
        timing: null,
        modelSelection: null,
        route: null,
        job,
        observed: observed !== null && typeof observed === "object" ? observed : null,
        lastEventTime: 0,
        linkedChildId: undefined,
        backgroundDelegation: undefined,
        backgroundAssociation: undefined,
      };
    }

    /** delegation（无对应 child/job）→ 独立行。 */
    function makeDelegationRow(sessionId, delegation, dispatch, now) {
      return {
        key: "del:" + String(delegation.callId),
        kind: "delegation",
        sessionId,
        childId: dispatch.kind === "continuable" ? dispatch.subagentId : undefined,
        jobId: dispatch.kind === "background" ? dispatch.jobId : undefined,
        runId: dispatch.kind === "foreground" && typeof dispatch.runId === "string" ? dispatch.runId : undefined,
        toolName: delegation.name,
        label: dispatch.kind === "foreground" ? (typeof delegation.label === "string" && delegation.label.length > 0 ? delegation.label : String(dispatch.runId)) : String(delegation.callId),
        mode: dispatch.kind === "background" ? "background" : dispatch.kind === "continuable" ? "continuable" : "foreground",
        oneShot: dispatch.kind === "foreground",
        archived: false,
        tokens: null,
        confidence: "unmatched",
        createdAt: typeof delegation.startedAt === "number" ? delegation.startedAt : now,
        startedAt: typeof delegation.startedAt === "number" ? delegation.startedAt : now,
        child: null,
        timing: null,
        modelSelection: null,
        route: delegation.route !== undefined ? delegation.route : null,
        job: null,
        observed: null,
        lastEventTime: 0,
        delegation,
      };
    }

    /**
     * 合并三路来源为面板行集合（spec §4）：
     * - `children`：本会话 `subagentCatalog` 条目。
     * - `jobs`：本会话 `ctx.jobs` 中 kind === 'subagent' 的 JobView。
     * - `delegations`：父会话 transcript 拆出的派发（parseDispatch）。
     * 关联成功不重复计数；无法关联时保留独立行并标记未关联/ambiguous。
     * @param input - { sessionId, children, jobs, delegations, byId, observed, timingOf, modelSelectionOf, tokensOf, tolerance, now }。
     * @returns 行数组，按 startedAt 倒序。
     */
    function buildRows(input) {
      const src = input !== null && typeof input === "object" ? input : {};
      const sessionId = src.sessionId;
      const children = Array.isArray(src.children) ? src.children : [];
      const jobs = Array.isArray(src.jobs) ? src.jobs : [];
      const delegations = Array.isArray(src.delegations) ? src.delegations : [];
      const byId = src.byId !== null && typeof src.byId === "object" ? src.byId : {};
      const observed = src.observed !== null && typeof src.observed === "object" ? src.observed : {};
      const timingOf = typeof src.timingOf === "function" ? src.timingOf : () => null;
      const modelSelectionOf = typeof src.modelSelectionOf === "function" ? src.modelSelectionOf : () => null;
      const tokensOf = typeof src.tokensOf === "function" ? src.tokensOf : () => null;
      const tolerance = typeof src.tolerance === "number" ? src.tolerance : DEFAULT_TOLERANCE_MS;
      const now = typeof src.now === "number" ? src.now : Date.now();

      const childRows = new Map();
      for (const entry of children) {
        if (entry === null || typeof entry !== "object" || typeof entry.id !== "string") continue;
        const childRow = makeChildRow(sessionId, entry, byId[entry.id], timingOf(entry.id), modelSelectionOf(entry.id), now);
        childRow.tokens = tokensOf(entry.id);
        childRows.set(entry.id, childRow);
      }

      const jobRows = new Map();
      for (const job of jobs) {
        if (job === null || typeof job !== "object" || typeof job.id !== "string") continue;
        jobRows.set(job.id, makeJobRow(sessionId, job, observed[job.id], now));
      }

      const standalone = [];
      const continuableByChild = new Map();
      for (const delegation of delegations) {
        if (delegation === null || typeof delegation !== "object") continue;
        let dispatch = delegation.dispatch !== undefined ? delegation.dispatch : parseDispatch(delegation.resultText);
        // 前台 one-shot 的持久化 renderer 可能只留下 output；用工具参数的
        // run_in_background=false/缺省保留 label+时间窗关联机会。
        if (dispatch === null && delegation.runInBackground !== true) {
          dispatch = { kind: "foreground", runId: String(delegation.callId) };
        }
        if (dispatch === null) continue;
        if (dispatch.kind === "continuable") {
          continuableByChild.set(dispatch.subagentId, delegation);
        } else if (dispatch.kind === "background") {
          const jobRow = jobRows.get(dispatch.jobId);
          if (jobRow !== undefined) jobRow.backgroundDelegation = delegation;
          else standalone.push(makeDelegationRow(sessionId, delegation, dispatch, now));
        } else {
          standalone.push(makeDelegationRow(sessionId, delegation, dispatch, now));
        }
      }

      for (const [childId, delegation] of continuableByChild) {
        const childRow = childRows.get(childId);
        if (childRow === undefined) {
          standalone.push(makeDelegationRow(sessionId, delegation, { kind: "continuable", subagentId: childId }, now));
          continue;
        }
        childRow.delegation = delegation;
        childRow.toolName = delegation.name;
        if (delegation.route !== undefined) childRow.route = delegation.route;
        childRow.mode = "continuable";
        childRow.oneShot = false;
        childRow.confidence = "exact";
      }

      const availableForJob = [];
      for (const childRow of childRows.values()) {
        if (childRow.confidence !== "exact") availableForJob.push(childRow);
      }
      for (const jobRow of jobRows.values()) {
        // 每个 child 最多消费一次；后续 job 不得复用已绑定 child。
        const pool = availableForJob
          .filter((c) => c.linkedJobId === undefined)
          .map((c) => ({ id: c.childId, label: c.label, createdAt: c.createdAt }));
        const association = associateBackground(jobRow.job, pool, tolerance);
        jobRow.backgroundAssociation = association;
        if (association.confidence === "exact") {
          const childRow = childRows.get(association.childId);
          if (childRow !== undefined && childRow.linkedJobId === undefined) {
            childRow.linkedJobId = jobRow.jobId;
            jobRow.linkedChildId = childRow.childId;
            jobRow.childId = childRow.childId;
            jobRow.modelSelection = childRow.modelSelection;
            if (jobRow.route === null || jobRow.route === undefined) {
              jobRow.route = childRow.route !== undefined ? childRow.route : null;
            }
            jobRow.tokens = childRow.tokens;
            jobRow.key = "child:" + childRow.childId;
          }
        }
      }

      for (const delegationRow of standalone) {
        if (delegationRow.mode !== "foreground") continue;
        const pool = [];
        for (const childRow of childRows.values()) {
          if (childRow.linkedJobId === undefined && childRow.confidence !== "exact") {
            pool.push({ id: childRow.childId, label: childRow.label, createdAt: childRow.createdAt });
          }
        }
        const association = associateForeground({ label: delegationRow.label, startedAt: delegationRow.startedAt }, pool, tolerance);
        if (association.confidence === "exact-by-unique-window") {
          const childRow = childRows.get(association.childId);
          if (childRow !== undefined) {
            childRow.linkedJobId = delegationRow.key;
            delegationRow.linkedChildId = childRow.childId;
            delegationRow.childId = childRow.childId;
            delegationRow.key = "child:" + childRow.childId;
            delegationRow.child = childRow.child;
            delegationRow.timing = childRow.timing;
            delegationRow.modelSelection = childRow.modelSelection;
            if (delegationRow.route === null || delegationRow.route === undefined) {
              delegationRow.route = childRow.route !== undefined ? childRow.route : null;
            }
            delegationRow.tokens = childRow.tokens;
            delegationRow.confidence = "exact-by-unique-window";
          }
        } else if (association.confidence === "ambiguous") {
          delegationRow.confidence = "ambiguous";
        }
      }

      const rows = [];
      for (const jobRow of jobRows.values()) {
        if (jobRow.backgroundDelegation !== undefined) {
          jobRow.mode = "background";
          jobRow.toolName = jobRow.backgroundDelegation.name;
          if (jobRow.backgroundDelegation.route !== undefined) jobRow.route = jobRow.backgroundDelegation.route;
        }
        // confidence 表示 job→child 关联，不把精确的 tool→job 误当成 child 已关联。
        if (jobRow.linkedChildId !== undefined) jobRow.confidence = "exact";
        else if (jobRow.backgroundAssociation !== undefined && jobRow.backgroundAssociation.confidence === "ambiguous") {
          jobRow.confidence = "ambiguous";
        } else jobRow.confidence = "unmatched";
        if (jobRow.linkedChildId !== undefined) {
          const childRow = childRows.get(jobRow.linkedChildId);
          if (childRow !== undefined) {
            jobRow.child = childRow.child;
            jobRow.timing = childRow.timing;
            jobRow.lastEventTime = childRow.lastEventTime;
            jobRow.tokens = childRow.tokens;
          }
        }
        rows.push(jobRow);
      }
      for (const childRow of childRows.values()) {
        if (childRow.linkedJobId !== undefined) continue;
        if (childRow.confidence === undefined) childRow.confidence = "unmatched";
        rows.push(childRow);
      }
      for (const delegationRow of standalone) rows.push(delegationRow);

      rows.sort((a, b) => (b.startedAt - a.startedAt) || String(a.key).localeCompare(String(b.key)));
      return rows;
    }

    /* ── 纯函数：行类型与资源链接 ──────────────────────────────────── */

    /**
     * 行 → 类型徽标 `{ label, color, via, driver, route }`。
     * 优先级：**实际路由**（派发参数显式路由 → 子会话 modelSelection 投影）
     * > 工具名派生的驱动名 > 后台/子代理兜底。
     * `driver` 始终保留工具名派生结果（spawn / fork / Codex…），使标签改为
     * 路由口径后仍不丢驱动差异。
     */
    function rowType(row) {
      const src = row !== null && typeof row === "object" ? row : null;
      const driver = src !== null && typeof src.toolName === "string" && src.toolName.length > 0
        ? typeOfTool(src.toolName).label
        : null;
      if (src !== null) {
        const routed = typeOfRoute(src);
        if (routed !== null) {
          return { label: routed.label, color: routed.color, via: "route", driver, route: routed.route };
        }
      }
      if (driver !== null) {
        return { label: driver, color: colorForLabel(driver), via: "tool", driver, route: null };
      }
      if (src !== null && src.kind === "job") {
        return { label: "后台", color: colorForLabel("后台"), via: "fallback", driver: null, route: null };
      }
      return { label: "子代理", color: colorForLabel("子代理"), via: "fallback", driver: null, route: null };
    }

    /** 徽标 tooltip：路由口径注明实际目标，并把驱动（工具名）差异附在后面。 */
    function badgeTitle(type) {
      if (type === null || typeof type !== "object") return "子代理类型：?";
      const label = typeof type.label === "string" && type.label.length > 0 ? type.label : "?";
      if (type.via !== "route") return "子代理类型（驱动）：" + label;
      const target = routeTarget(type.route);
      const driver = typeof type.driver === "string" && type.driver.length > 0 && type.driver !== label
        ? "· 驱动 " + type.driver
        : "";
      return "实际路由：" + label + (target.length > 0 ? "（" + target + "）" : "") + driver;
    }

    /** 行 → 资源链接 mode 参数（one-shot | continuable）。 */
    function resourceModeOf(row) {
      return row !== null && typeof row === "object" && row.mode === "continuable" ? "continuable" : "one-shot";
    }

    /**
     * 规范化的子会话 Sidebar 资源地址（与宿主 `subagentChatAddress` 同形）。
     * 仅用于展示/断言；导航改走 `uiWorkspace.openSession(address)`。
     */
    function resourceUrl(childId, parentSessionId, mode) {
      const child = encodeURIComponent(String(childId));
      const parent = encodeURIComponent(String(parentSessionId));
      const m = mode === "continuable" ? "continuable" : "one-shot";
      return "dsh-resource://subagentchat/session/" + child + "?parent=" + parent + "&mode=" + m;
    }

    /* ── 纯函数：弹层定位 ──────────────────────────────────────────── */

    /** fixed 弹层定位：优先按钮下方，不足翻上方，水平/垂直夹取在视口内。 */
    function panelPositionFor(anchor, viewport) {
      const margin = 8;
      const panelWidth = 480;
      const panelHeight = 380;
      const left = anchor !== null && typeof anchor === "object" && typeof anchor.left === "number" ? anchor.left : 0;
      const top = anchor !== null && typeof anchor === "object" && typeof anchor.top === "number" ? anchor.top : 0;
      const bottom = anchor !== null && typeof anchor === "object" && typeof anchor.bottom === "number" ? anchor.bottom : top;
      const width = viewport !== null && typeof viewport === "object" && typeof viewport.width === "number" ? viewport.width : 0;
      const height = viewport !== null && typeof viewport === "object" && typeof viewport.height === "number" ? viewport.height : 0;
      const below = bottom + 6;
      const above = top - 6 - panelHeight;
      let y;
      if (height > 0 && below + panelHeight <= height - margin) y = below;
      else if (height > 0 && above >= margin) y = above;
      else if (height > 0) y = Math.max(margin, height - panelHeight - margin);
      else y = below;
      const effectiveWidth = width > 0 ? Math.min(panelWidth, Math.max(0, width - margin * 2)) : panelWidth;
      const x = width > 0 ? Math.max(margin, Math.min(left, width - effectiveWidth - margin)) : left;
      return { left: x, top: y };
    }

    /* ── 服务解析与 inject face ────────────────────────────────────── */

    /** 从 ctx 取服务（get(name) 或属性），异常返回 undefined。 */
    function svc(ctx, name) {
      try {
        if (ctx === null || ctx === undefined) return undefined;
        if (typeof ctx.get === "function") return ctx.get(name);
        return ctx[name];
      } catch (_) {
        return undefined;
      }
    }

    /**
     * 稳定 observable 包装：每次 getSnapshot 重新解析底层 eventSource，无
     * binding 时返回空窗口。supply 的 subscribe/getSnapshot 身份稳定，可直接
     * 交给 useSyncExternalStore。
     */
    function windowSource(sessions, sessionId) {
      const read = () => {
        try {
          if (sessions === null || sessions === undefined || typeof sessions.binding !== "function") return null;
          const binding = sessions.binding(sessionId);
          if (binding === null || binding === undefined) return null;
          return binding.eventSource !== null && binding.eventSource !== undefined ? binding.eventSource : null;
        } catch (_) {
          return null;
        }
      };
      return {
        subscribe: (fn) => {
          const source = read();
          if (source !== null && typeof source.subscribe === "function") return source.subscribe(fn);
          return () => {};
        },
        getSnapshot: () => {
          const source = read();
          if (source === null || typeof source.getSnapshot !== "function") return EMPTY_WINDOW;
          try {
            return source.getSnapshot();
          } catch (_) {
            return EMPTY_WINDOW;
          }
        },
      };
    }

    /**
     * 构造 header action 的 inject face。sessionId 不由 inject 回调传入，而由
     * SessionStandardProps 提供；服务缺失时降级为 UNAVAILABLE。
     */
    function faceOf(ctx) {
      try {
        const sessions = svc(ctx, "sessions");
        if (sessions === null || sessions === undefined || typeof sessions.binding !== "function") return UNAVAILABLE;
        const jobs = svc(ctx, "jobs");
        const uiWorkspace = svc(ctx, "uiWorkspace");
        return {
          // header action 的 inject() 不接收 sessionId；当前会话 identity 来自标准 props。
          parentSourceFor: (sessionId) => windowSource(sessions, sessionId),
          jobsSource: jobs !== null && jobs !== undefined && jobs.state !== null && typeof jobs.state === "object"
            ? jobs.state : null,
          watchRows: (id) => {
            try { return jobs !== null && typeof jobs.watchRows === "function" ? jobs.watchRows(id) : () => {}; } catch (_) { return () => {}; }
          },
          observe: (id, jobId) => {
            try { return jobs !== null && typeof jobs.observe === "function" ? jobs.observe(id, jobId) : () => {}; } catch (_) { return () => {}; }
          },
          subagentAddress: (id) => {
            try { return typeof sessions.subagentAddress === "function" ? sessions.subagentAddress(id) : undefined; } catch (_) { return undefined; }
          },
          retain: (target) => {
            try { return sessions.retain(target, { source: "controllerOperation" }); } catch (_) { return null; }
          },
          refreshProjections: (id) => {
            try {
              const p = sessions.refreshProjections(id);
              if (p !== null && typeof p === "object" && typeof p.catch === "function") p.catch(() => {});
            } catch (_) { /* 投影刷新失败不打扰用户 */ }
          },
          openChild: uiWorkspace !== null && uiWorkspace !== undefined && typeof uiWorkspace.openSession === "function"
            ? (childId, parentId, mode) => {
              if (typeof childId !== "string" || childId.length === 0) return false;
              try {
                // 优先借用宿主登记的 direct-parent address；不可得时按契约安全构造。
                let address = null;
                if (typeof sessions.subagentAddress === "function") {
                  try { address = sessions.subagentAddress(childId); } catch (_) { address = null; }
                }
                const usable = address !== null && typeof address === "object"
                  && typeof address.childSessionId === "string" && address.childSessionId.length > 0;
                if (!usable) {
                  address = {
                    parentSessionId: parentId,
                    childSessionId: childId,
                    mode: mode === "continuable" ? "continuable" : mode === "one-shot" ? "one-shot" : "unknown",
                  };
                }
                uiWorkspace.openSession(address);
                return true;
              } catch (_) {
                return false;
              }
            }
            : undefined,
        };
      } catch (_) {
        return UNAVAILABLE;
      }
    }

    /* ── 组件 ──────────────────────────────────────────────────────── */

    const ROOT_STYLE = {
      display: "inline-flex",
      alignItems: "center",
      position: "relative",
      letterSpacing: "0",
    };

    const TRIGGER_STYLE = {
      border: "1px solid transparent",
      borderRadius: "6px",
      background: "transparent",
      color: "inherit",
      cursor: "pointer",
      font: "inherit",
      fontSize: "12px",
      lineHeight: "18px",
      padding: "3px 6px",
      minHeight: "24px",
      display: "inline-flex",
      alignItems: "center",
      gap: "4px",
    };

    const OPEN_CHILD_STYLE = {
      border: "1px solid rgba(255,255,255,0.2)",
      borderRadius: "4px",
      background: "transparent",
      color: "inherit",
      cursor: "pointer",
      font: "inherit",
      fontSize: "11px",
      lineHeight: "16px",
      padding: "2px 8px",
    };

    const PANEL_STYLE = {
      position: "fixed",
      zIndex: 1200,
      width: "calc(100vw - 16px)",
      maxWidth: "480px",
      maxHeight: "min(70vh, 380px)",
      overflowY: "auto",
      padding: "4px",
      borderRadius: "8px",
      background: "var(--dsw-specific-menu, #20242b)",
      color: "inherit",
      boxShadow: "0 8px 24px rgba(0, 0, 0, 0.35)",
      display: "flex",
      flexDirection: "column",
      gap: "1px",
      letterSpacing: "0",
      boxSizing: "border-box",
    };

    const ROW_STYLE = {
      display: "flex",
      alignItems: "center",
      gap: "6px",
      padding: "5px 7px",
      borderRadius: "6px",
      fontSize: "12px",
      lineHeight: "17px",
      cursor: "pointer",
      boxSizing: "border-box",
    };

    const BADGE_BASE_STYLE = {
      display: "inline-flex",
      alignItems: "center",
      gap: "4px",
      height: "18px",
      padding: "0 5px",
      border: "1px solid rgba(255,255,255,0.18)",
      borderRadius: "4px",
      background: "rgba(255,255,255,0.06)",
      color: "inherit",
      fontWeight: 650,
      fontSize: "11px",
      lineHeight: "18px",
      whiteSpace: "nowrap",
      flex: "none",
    };

    const TYPE_SWATCH_STYLE = {
      display: "inline-block",
      width: "8px",
      height: "8px",
      borderRadius: "2px",
      flex: "none",
    };

    const MONO_STYLE = {
      fontFamily: "var(--dsw-font-mono, monospace)",
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
      margin: "0 8px 8px",
      padding: "6px 8px",
      maxHeight: "240px",
      overflow: "auto",
      borderRadius: "6px",
      background: "rgba(0, 0, 0, 0.22)",
      fontSize: "11px",
      lineHeight: "16px",
    };

    const NOTICE_STYLE = {
      margin: "0 8px 6px",
      fontSize: "11px",
      lineHeight: "16px",
      opacity: 0.72,
    };

    const CHIP_STYLE = {
      flex: "none",
      padding: "0 5px",
      border: "1px solid rgba(255,255,255,0.18)",
      borderRadius: "4px",
      fontSize: "10px",
      lineHeight: "16px",
      opacity: 0.85,
      whiteSpace: "nowrap",
    };

    const TOKENS_STYLE = {
      flex: "none",
      fontSize: "10px",
      lineHeight: "16px",
      opacity: 0.7,
      whiteSpace: "nowrap",
      fontFamily: "var(--dsw-font-mono, monospace)",
    };

    const LEGEND_STYLE = {
      margin: "2px 8px 4px",
      fontSize: "10px",
      lineHeight: "15px",
      opacity: 0.6,
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis",
    };

    const EMPTY_TEXT = "本会话还没有子代理或后台任务";
    const NO_OUTPUT_TEXT = "暂无可用输出（子代理尚未产生文本）";

    /** 行输出面板：job 走 observed 文本；child/delegation 走子会话事件窗口。 */
    function OutputArea(props) {
      const row = props.row;
      const text = typeof props.text === "string" ? props.text : "";
      const notice = typeof props.notice === "string" ? props.notice : "";
      if (text.length === 0) {
        return h("div", { style: { ...NOTICE_STYLE, padding: "6px 8px" } }, notice.length > 0 ? notice : NO_OUTPUT_TEXT);
      }
      return h("div", { "data-subagent-monitor-output": row !== null ? row.key : undefined, style: MONO_STYLE },
        notice.length > 0 ? h("div", { style: { opacity: 0.72, marginBottom: "4px" } }, notice) : null,
        text);
    }

    function SubagentMonitor(props) {
      const face = props !== null && typeof props === "object" ? props : UNAVAILABLE;
      if (typeof face.sessionId !== "string" || face.sessionId.length === 0) return null;
      if (typeof face.useSessions !== "function") return null;
      const sessionId = face.sessionId;
      const listState = face.useSessions((state) => state);

      const jobsSource = face.jobsSource;
      const subscribeJobs = useMemo(
        () => (jobsSource !== null && jobsSource !== undefined ? (fn) => jobsSource.subscribe(fn) : NOOP_SUBSCRIBE),
        [jobsSource],
      );
      const getJobsSnapshot = useMemo(
        () => (jobsSource !== null && jobsSource !== undefined ? () => jobsSource.getSnapshot() : () => EMPTY_JOBS),
        [jobsSource],
      );
      const jobsSnapshot = useSyncExternalStore(subscribeJobs, getJobsSnapshot, () => EMPTY_JOBS);

      const parentSource = useMemo(
        () => (typeof face.parentSourceFor === "function" ? face.parentSourceFor(sessionId) : null),
        [face.parentSourceFor, sessionId],
      );
      const subscribeParent = useMemo(
        () => (parentSource !== null && parentSource !== undefined ? (fn) => parentSource.subscribe(fn) : NOOP_SUBSCRIBE),
        [parentSource],
      );
      const getParentSnapshot = useMemo(
        () => (parentSource !== null && parentSource !== undefined ? () => parentSource.getSnapshot() : () => EMPTY_WINDOW),
        [parentSource],
      );
      const parentWindow = useSyncExternalStore(subscribeParent, getParentSnapshot, () => EMPTY_WINDOW);

      const [open, setOpen] = useState(false);
      const [position, setPosition] = useState(null);
      const [expanded, setExpanded] = useState(null);
      const [childWindow, setChildWindow] = useState(null);
      const [now, setNow] = useState(Date.now());

      // 面板打开时每秒刷新耗时/静默文案；关闭即清理，不伪造 host 活动。
      useEffect(() => {
        if (!open) return undefined;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
      }, [open]);

      useEffect(() => {
        if (typeof face.watchRows === "function") return face.watchRows(sessionId);
        return undefined;
      }, [face.watchRows, sessionId]);

      useEffect(() => {
        if (typeof document === "undefined") return undefined;
        const closeOnOutside = (event) => {
          if (event !== null && typeof event === "object" && event.target !== null
            && typeof event.target.closest === "function"
            && event.target.closest("[data-subagent-monitor-root]") !== null) return;
          setOpen(false);
          setExpanded(null);
        };
        const onKey = (event) => {
          if (event !== null && typeof event === "object" && event.key === "Escape") {
            setOpen(false);
            setExpanded(null);
          }
        };
        document.addEventListener("mousedown", closeOnOutside);
        document.addEventListener("keydown", onKey);
        return () => {
          document.removeEventListener("mousedown", closeOnOutside);
          document.removeEventListener("keydown", onKey);
        };
      }, []);

      // 展开 job 行时观察其输出；收起时 stop()。
      useEffect(() => {
        if (expanded === null || expanded.indexOf("job:") !== 0) return undefined;
        if (typeof face.observe !== "function") return undefined;
        const jobId = expanded.slice(4);
        let stop = null;
        try { stop = face.observe(sessionId, jobId); } catch (_) { stop = null; }
        return () => { try { if (typeof stop === "function") stop(); } catch (_) { /* 释放失败忽略 */ } };
      }, [expanded, face.observe, sessionId]);

      // 展开子会话行时 retain 其 binding 并订阅 eventSource；收起/卸载时 release()。
      useEffect(() => {
        if (expanded === null) return undefined;
        const prefix = rowsChildPrefix(expanded);
        if (prefix === null) return undefined;
        const childId = expanded.slice(prefix.length);
        let reference = null;
        let unsubscribe = null;
        let cancelled = false;
        setChildWindow(null);
        try {
          const address = typeof face.subagentAddress === "function" ? face.subagentAddress(childId) : undefined;
          const target = address !== undefined && address !== null ? address : childId;
          reference = typeof face.retain === "function" ? face.retain(target) : null;
          const bind = (binding) => {
            const source = binding !== null && binding !== undefined && binding.eventSource !== null && binding.eventSource !== undefined
              ? binding.eventSource : null;
            if (source === null || typeof source.subscribe !== "function") return;
            const publish = () => {
              if (cancelled) return;
              try { setChildWindow(source.getSnapshot()); } catch (_) { setChildWindow(null); }
            };
            unsubscribe = source.subscribe(publish);
            publish();
          };
          if (reference !== null && reference !== undefined && reference.ready !== null
            && typeof reference.ready === "object" && typeof reference.ready.then === "function") {
            reference.ready.then((binding) => { if (!cancelled) bind(binding); }).catch(() => {});
          } else if (reference !== null && reference !== undefined) {
            bind(reference.binding);
          }
        } catch (_) { /* retain 失败 → 输出区显示不可用 */ }
        return () => {
          cancelled = true;
          try { if (typeof unsubscribe === "function") unsubscribe(); } catch (_) { /* 忽略 */ }
          try { if (reference !== null && reference !== undefined && typeof reference.release === "function") reference.release(); } catch (_) { /* 忽略 */ }
        };
      }, [expanded, face.subagentAddress, face.retain]);

      const projections = listState !== null && typeof listState === "object" && listState.projectionsBySession !== null
        && typeof listState.projectionsBySession === "object" ? listState.projectionsBySession : {};
      const byId = listState !== null && typeof listState === "object" && listState.byId !== null
        && typeof listState.byId === "object" ? listState.byId : {};
      const projection = projections[sessionId];
      const catalog = projection !== null && typeof projection === "object" && projection.values !== null
        && typeof projection.values === "object" && Array.isArray(projection.values.subagentCatalog)
        ? projection.values.subagentCatalog : [];
      const projectionValues = projection !== null && typeof projection === "object"
        && projection.values !== null && typeof projection.values === "object" ? projection.values : {};
      const allJobs = jobsSnapshot !== null && typeof jobsSnapshot === "object" && jobsSnapshot.rows !== null
        && typeof jobsSnapshot.rows === "object" ? jobsSnapshot.rows[sessionId] : undefined;
      const jobs = Array.isArray(allJobs) ? allJobs.filter((job) => job !== null && typeof job === "object" && job.kind === "subagent") : [];
      const observed = jobsSnapshot !== null && typeof jobsSnapshot === "object" && jobsSnapshot.observed !== null
        && typeof jobsSnapshot.observed === "object" ? jobsSnapshot.observed : {};
      const parentEntries = parentWindow !== null && typeof parentWindow === "object" && Array.isArray(parentWindow.entries)
        ? parentWindow.entries : [];
      const delegations = collectDelegations(parentEntries);

      const rows = buildRows({
        sessionId,
        children: catalog,
        jobs,
        delegations,
        byId,
        observed,
        timingOf: (childId) => {
          const sessionProjection = projections[childId];
          return sessionProjection !== null && typeof sessionProjection === "object" && sessionProjection.values !== null
            && typeof sessionProjection.values === "object" ? sessionProjection.values.subagentTiming : null;
        },
        modelSelectionOf: (childId) => {
          // 唯一来源是本连接已加载的逐会话投影（projectionsBySession[childId]）。
          // 不要回退 byId[childId].projectionValues：宿主两者取自同一个
          // projectionStores Map（dsh-api-session-controller/lib/client.js:2940/2965），
          // 该回退恒为死分支，只会制造"已覆盖"的错觉。
          const sessionProjection = projections[childId];
          return sessionProjection !== null && typeof sessionProjection === "object" && sessionProjection.values !== null
            && typeof sessionProjection.values === "object" ? sessionProjection.values.modelSelection : null;
        },
        tokensOf: (childId) => {
          const sessionProjection = projections[childId];
          return sessionProjection !== null && typeof sessionProjection === "object" && sessionProjection.values !== null
            && typeof sessionProjection.values === "object" ? tokensOfProjection(sessionProjection.values) : null;
        },
        now,
      });

      const storage = useMemo(resolveStorage, []);
      const [storedRows, setStoredRows] = useState([]);

      useEffect(() => {
        setStoredRows(loadPersisted(storage, sessionId));
      }, [storage, sessionId]);

      const merged = mergePersisted(rows, storedRows);
      const signature = rowsSignature(rows);

      useEffect(() => {
        if (storage === null || merged.length === 0) return undefined;
        if (persistedSignatures.get(sessionId) === signature) return undefined;
        persistedSignatures.set(sessionId, signature);
        savePersisted(storage, sessionId, rows);
        setStoredRows(loadPersisted(storage, sessionId));
        return undefined;
      }, [storage, sessionId, signature, merged.length]);

      if (merged.length === 0) return null;

      const activeCount = merged.filter(isActiveRow).length;
      const triggerText = "子代理 " + (activeCount > 0 && activeCount !== merged.length ? activeCount + "/" + merged.length : String(merged.length));

      const trigger = h("button", {
        type: "button",
        "data-subagent-monitor-trigger": true,
        title: "子代理 / 后台任务",
        "aria-haspopup": "dialog",
        "aria-expanded": open,
        style: TRIGGER_STYLE,
        onClick: (event) => {
          if (event !== null && typeof event === "object" && typeof event.stopPropagation === "function") event.stopPropagation();
          if (open) { setOpen(false); setExpanded(null); return; }
          let pos = { left: 0, top: 0 };
          try {
            const rect = event !== null && typeof event === "object" && event.currentTarget !== null
              && typeof event.currentTarget.getBoundingClientRect === "function"
              ? event.currentTarget.getBoundingClientRect() : null;
            const viewport = typeof window !== "undefined" && window !== null
              ? { width: window.innerWidth, height: window.innerHeight } : null;
            pos = panelPositionFor(rect, viewport);
          } catch (_) { /* 无 DOM 环境不做定位 */ }
          setPosition(pos);
          setOpen(true);
        },
      }, triggerText);

      const childrenEls = [trigger];

      if (open) {
        const rowEls = [];
        rowEls.push(h("div", {
          key: "__legend",
          "data-subagent-legend": true,
          style: LEGEND_STYLE,
        }, "可续接（可继续对话） · 一次性（专用工具，只读记录）"));
        if (merged.length === 0) {
          rowEls.push(h("div", { key: "__empty", style: { ...NOTICE_STYLE, padding: "8px" } }, EMPTY_TEXT));
        }
        for (const row of merged) {
          const type = rowType(row);
          const status = statusOf(row);
          const keepalive = keepaliveOf(row, now);
          const isExpanded = expanded === row.key;
          const oneShotNoChild = row.oneShot === true && !(typeof row.childId === "string" && row.childId.length > 0);
          const metaParts = [modeLabel(row.mode), status.text, keepalive];
          if (oneShotNoChild) metaParts.push("一次性 · 无独立子会话");
          const meta = metaParts.filter((s) => typeof s === "string" && s.length > 0).join(" · ");
          const chip = rowChip(row);
          const tokenText = tokensLabel(row);
          const borderLeft = (row.oneShot === true ? "3px dashed " : "3px solid ") + type.color;

          const head = h("div", {
            key: row.key,
            role: "button",
            tabIndex: 0,
            "data-subagent-monitor-row": row.key,
            "data-subagent-oneshot": row.oneShot === true ? "true" : "false",
            style: {
              ...ROW_STYLE,
              borderLeft,
              opacity: row.archived === true ? 0.72 : 1,
              background: isExpanded ? "rgba(255,255,255,0.10)" : "transparent",
            },
            onClick: () => setExpanded(isExpanded ? null : row.key),
            onKeyDown: (event) => {
              if (event !== null && typeof event === "object"
                && (event.key === "Enter" || event.key === " " || event.key === "Spacebar")) {
                if (typeof event.preventDefault === "function") event.preventDefault();
                setExpanded(isExpanded ? null : row.key);
              }
            },
          },
          h("span", {
            key: "badge",
            "data-subagent-type": type.label,
            "data-subagent-type-via": type.via,
            title: badgeTitle(type),
            style: BADGE_BASE_STYLE,
          },
          h("span", { key: "swatch", "aria-hidden": true, style: { ...TYPE_SWATCH_STYLE, background: type.color } }),
          h("span", { key: "name", "data-subagent-type-name": true }, type.label)),
          h("span", {
            key: "label",
            style: {
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: rowFontSize(row) + "px",
              fontStyle: row.oneShot === true ? "italic" : undefined,
              fontWeight: row.oneShot === true ? undefined : 600,
            },
          }, row.label),
          h("span", { key: "chip", "data-subagent-chip": chip.text, style: CHIP_STYLE }, chip.text),
          tokenText.length > 0
            ? h("span", { key: "tokens", "data-subagent-tokens": tokenText, style: TOKENS_STYLE }, tokenText)
            : null,
          h("span", { key: "meta", style: { flex: "0 1 45%", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: 0.75, fontSize: "11px" } }, meta),
          row.confidence === "ambiguous" || row.confidence === "unmatched"
            ? h("span", { key: "conf", style: { flex: "none", opacity: 0.6, fontSize: "10px" } }, "未关联")
            : null,
          );

          rowEls.push(head);

          if (isExpanded) {
            const childId = row.childId;
            const canLink = typeof childId === "string" && childId.length > 0;
            if (canLink && !oneShotNoChild && typeof face.openChild === "function") {
              rowEls.push(h("div", { key: row.key + ":link", style: { padding: "0 12px 6px" } },
                h("button", {
                  type: "button",
                  "data-subagent-open-child": childId,
                  style: OPEN_CHILD_STYLE,
                  onClick: (event) => {
                    if (event !== null && typeof event === "object" && typeof event.stopPropagation === "function") event.stopPropagation();
                    const navigated = face.openChild(childId, sessionId, resourceModeOf(row));
                    if (navigated === true) { setOpen(false); setExpanded(null); }
                  },
                }, "打开子会话")));
            }
            if (row.childId !== undefined) {
              // 已关联 subagent job 必须走 child transcript；其 job output ring 按宿主设计为空。
              const folded = trimTail(foldEntries(childWindow !== null && typeof childWindow === "object"
                && Array.isArray(childWindow.entries) ? childWindow.entries : []));
              const text = folded.lines.join("\n");
              const hasMore = childWindow !== null && typeof childWindow === "object" && childWindow.hasMore === true;
              const notice = folded.truncated || hasMore ? "更早输出未加载" : "";
              rowEls.push(h(OutputArea, { key: row.key + ":out", row, text, notice }));
            } else if (row.jobId !== undefined) {
              const jobObserved = observed[row.jobId];
              const text = jobObserved !== null && jobObserved !== undefined && typeof jobObserved.text === "string" ? jobObserved.text : "";
              const notice = jobObserved !== null && jobObserved !== undefined && jobObserved.gapBefore === true
                ? "更早输出已丢弃"
                : (text.length === 0 ? "此 subagent job 未写入 job 输出，且尚未关联子会话" : "");
              rowEls.push(h(OutputArea, { key: row.key + ":out", row, text, notice }));
            } else {
              rowEls.push(h(OutputArea, { key: row.key + ":out", row, text: "", notice: "" }));
            }
          }
        }

        const panelStyle = position !== null && typeof position === "object"
          ? { ...PANEL_STYLE, left: position.left, top: position.top } : PANEL_STYLE;
        childrenEls.push(h("div", {
          key: "__panel",
          "data-subagent-monitor-panel": true,
          role: "dialog",
          "aria-label": "子代理 / 后台任务",
          style: panelStyle,
        }, rowEls));
      }

      return h("span", { "data-subagent-monitor-root": true, style: ROOT_STYLE }, ...childrenEls);
    }

    /** 返回 `child:` 前缀长度（命中时），否则 null。 */
    function rowsChildPrefix(key) {
      return typeof key === "string" && key.indexOf("child:") === 0 ? 6 : null;
    }

    /* ── 注册 ──────────────────────────────────────────────────────── */

    /**
     * cordis 注入权限清单。`sessions` 内部访问 `remote.session`（binding/
     * retain 走 remote），`jobs` 同理，所以 `remote` / `remote.session` 必须
     * 声明，否则相关访问抛 "cannot get property remote.session without
     * inject"。`slots` 用于席位注册。会话标准 props（useSessions 等）由
     * ui-session 适配器随 session 作用域投递，无需额外注入。`uiWorkspace`
     * 用于“打开子会话”导航（`ctx.uiWorkspace.openSession(address)`），缺失时
     * 按钮不渲染、`face.openChild` 返回 false。
     */
    const inject = ["slots", "sessions", "jobs", "uiWorkspace", "remote", "remote.session"];

    function apply(ctx) {
      ctx.slots.inject("conversation.session.header.actions", () =>
        ctx.slots.register(
          {
            name: "conversation.session.header.actions",
            id: "subagent-monitor",
            order: 25,
            inject: () => faceOf(ctx),
          },
          SubagentMonitor,
        ),
        "subagent-monitor: session header subagent/job panel",
      );
    }

    /** probe 专用面：纯函数与 face 出厂的行为断言（不构成任何运行时承诺）。 */
    const __test = {
      hash32, PALETTE, TYPE_COLORS, TOOL_LABELS, HEURISTIC_KEYS,
      colorForLabel, typeOfTool, typeOfSelection,
      routeOfDispatchArgs, typeOfRoute, routeTarget, rowType, badgeTitle,
      parseJson, extractBalanced, decodeJsonEscapes, tryUnescapeString, searchNode, parseDispatch,
      formatAge, turnEndLabel, turnEndStatus, statusOf, latestChildActivity, keepaliveOf, isActiveRow, modeLabel,
      formatTokens, tokensOfProjection, tokensLabel, isOneShotRow, rowFontSize, rowChip,
      associateBackground, associateForeground,
      contentText, preview, collectDelegations, foldEntries, trimTail,
      makeChildRow, makeJobRow, makeDelegationRow, buildRows,
      persistKey, resolveStorage, snapshotRow, loadPersisted, savePersisted, restoreRow, mergePersisted, rowsSignature,
      PERSIST_VERSION, PERSIST_KEY_PREFIX, PERSIST_MAX_ROWS, PERSIST_MAX_TEXT,
      resourceModeOf, resourceUrl,
      panelPositionFor, svc, windowSource, faceOf, UNAVAILABLE,
      EMPTY_WINDOW, EMPTY_JOBS, NO_OUTPUT_TEXT, EMPTY_TEXT,
      DEFAULT_TOLERANCE_MS, SILENT_THRESHOLD_MS, MAX_TAIL_LINES, MAX_TAIL_BYTES,
    };

    exports.apply = apply;
    exports.inject = inject;
    exports.__test = __test;
    return module.exports;
  },
});
