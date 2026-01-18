(function () {
  "use strict";

  const ns = (window.__byokCfgPanel = window.__byokCfgPanel || {});
  const { normalizeStr, uniq, escapeHtml, optionHtml, computeProviderIndexById } = ns;

  const ENDPOINT_GROUPS_V1 = [
    {
      id: "llm_data_plane",
      label: "LLM 数据面（13）",
      endpoints: [
        "/get-models",
        "/chat",
        "/completion",
        "/chat-input-completion",
        "/edit",
        "/next_edit_loc",
        "/chat-stream",
        "/prompt-enhancer",
        "/instruction-stream",
        "/smart-paste-stream",
        "/next-edit-stream",
        "/generate-commit-message-stream",
        "/generate-conversation-title"
      ]
    },
    {
      id: "remote_agents",
      label: "Remote Agents（15）",
      endpoints: [
        "/remote-agents/create",
        "/remote-agents/update",
        "/remote-agents/delete",
        "/remote-agents/list",
        "/remote-agents/list-stream",
        "/remote-agents/chat",
        "/remote-agents/get-chat-history",
        "/remote-agents/agent-history-stream",
        "/remote-agents/logs",
        "/remote-agents/interrupt",
        "/remote-agents/pause",
        "/remote-agents/resume",
        "/remote-agents/resume-hint",
        "/remote-agents/generate-summary",
        "/remote-agents/add-ssh-key"
      ]
    },
    {
      id: "agents_tools",
      label: "Agents / Tools（6）",
      endpoints: [
        "/agents/check-tool-safety",
        "/agents/revoke-tool-access",
        "/agents/list-remote-tools",
        "/agents/run-remote-tool",
        "/agents/edit-file",
        "/agents/codebase-retrieval"
      ]
    },
    {
      id: "blobs_context_sync",
      label: "文件/Blob/上下文同步（7）",
      endpoints: [
        "/batch-upload",
        "/checkpoint-blobs",
        "/find-missing",
        "/save-chat",
        "/context-canvas/list",
        "/get-implicit-external-sources",
        "/search-external-sources"
      ]
    },
    {
      id: "github",
      label: "GitHub 集成（4）",
      endpoints: [
        "/github/is-user-configured",
        "/github/list-repos",
        "/github/list-branches",
        "/github/get-repo"
      ]
    },
    {
      id: "auth_subscription_secrets",
      label: "账号/订阅/权限/Secrets（7）",
      endpoints: [
        "/token",
        "/get-credit-info",
        "/subscription-banner",
        "/settings/get-tenant-tool-permissions",
        "/user-secrets/list",
        "/user-secrets/upsert",
        "/user-secrets/delete"
      ]
    },
    {
      id: "feedback_telemetry_debug",
      label: "反馈/遥测/调试（17）",
      endpoints: [
        "/chat-feedback",
        "/completion-feedback",
        "/next-edit-feedback",
        "/client-metrics",
        "/client-completion-timelines",
        "/record-session-events",
        "/record-user-events",
        "/record-preference-sample",
        "/record-request-events",
        "/report-error",
        "/report-feature-vector",
        "/resolve-completions",
        "/resolve-chat-input-completion",
        "/resolve-edit",
        "/resolve-instruction",
        "/resolve-next-edit",
        "/resolve-smart-paste"
      ]
    },
    {
      id: "notifications",
      label: "通知（2）",
      endpoints: [
        "/notifications/read",
        "/notifications/mark-as-read"
      ]
    }
  ];

  const ENDPOINT_MEANINGS_V1 = {
    "/get-models": "拉取可用模型/feature flags（并可注入 BYOK models registry）",
    "/chat": "非流式 chat（或某些场景的 chat 请求）",
    "/completion": "编辑器 inline completion（短文本）",
    "/chat-input-completion": "Chat 输入框智能补全",
    "/edit": "代码编辑/改写（输出文本或结构化编辑结果）",
    "/next_edit_loc": "Next Edit 定位（候选位置 JSON）",
    "/chat-stream": "核心聊天流（Augment NDJSON）",
    "/prompt-enhancer": "提示词增强（stream）",
    "/instruction-stream": "指令生成/改写（stream）",
    "/smart-paste-stream": "Smart Paste（stream）",
    "/next-edit-stream": "Next Edit 建议（stream）",
    "/generate-commit-message-stream": "Commit message（stream）",
    "/generate-conversation-title": "会话标题（stream）",

    "/remote-agents/create": "创建远程 agent",
    "/remote-agents/update": "更新配置",
    "/remote-agents/delete": "删除",
    "/remote-agents/list": "列表（一次性）",
    "/remote-agents/list-stream": "列表（流式更新）",
    "/remote-agents/chat": "与远程 agent 对话/下达任务",
    "/remote-agents/get-chat-history": "拉取对话历史（一次性）",
    "/remote-agents/agent-history-stream": "对话/事件历史流",
    "/remote-agents/logs": "日志",
    "/remote-agents/interrupt": "中断执行",
    "/remote-agents/pause": "暂停",
    "/remote-agents/resume": "恢复",
    "/remote-agents/resume-hint": "恢复提示/状态同步",
    "/remote-agents/generate-summary": "生成摘要",
    "/remote-agents/add-ssh-key": "写入 SSH key",

    "/agents/check-tool-safety": "工具安全性检查/准入",
    "/agents/revoke-tool-access": "撤销工具权限",
    "/agents/list-remote-tools": "列出可用远程工具",
    "/agents/run-remote-tool": "执行远程工具",
    "/agents/edit-file": "通过 agent 执行文件编辑",
    "/agents/codebase-retrieval": "代码库检索",

    "/batch-upload": "批量上传 blobs（文件内容/上下文）",
    "/checkpoint-blobs": "checkpoint 相关 blobs 操作",
    "/find-missing": "查找缺失 blob",
    "/save-chat": "保存会话/记录（服务端持久化）",
    "/context-canvas/list": "Context Canvas 列表",
    "/get-implicit-external-sources": "隐式外部来源",
    "/search-external-sources": "外部来源搜索",

    "/github/is-user-configured": "是否已配置 GitHub",
    "/github/list-repos": "仓库列表",
    "/github/list-branches": "分支列表",
    "/github/get-repo": "获取指定 repo 信息/元数据",

    "/token": "token 获取/刷新（鉴权相关）",
    "/get-credit-info": "额度/credits 信息",
    "/subscription-banner": "订阅提示 banner",
    "/settings/get-tenant-tool-permissions": "tenant 级工具权限配置",
    "/user-secrets/list": "列出用户 secrets",
    "/user-secrets/upsert": "写入/更新 secrets",
    "/user-secrets/delete": "删除 secrets",

    "/chat-feedback": "聊天反馈",
    "/completion-feedback": "补全反馈",
    "/next-edit-feedback": "Next Edit 反馈",
    "/client-metrics": "客户端指标",
    "/client-completion-timelines": "completion timeline（行为序列）",
    "/record-session-events": "会话事件",
    "/record-user-events": "用户事件",
    "/record-preference-sample": "偏好样本（用于训练/评估）",
    "/record-request-events": "请求事件记录",
    "/report-error": "错误上报",
    "/report-feature-vector": "特征向量上报",
    "/resolve-completions": "resolve*（日志/归因类）",
    "/resolve-chat-input-completion": "resolve*（日志/归因类）",
    "/resolve-edit": "resolve*（日志/归因类）",
    "/resolve-instruction": "resolve*（日志/归因类）",
    "/resolve-next-edit": "resolve*（日志/归因类）",
    "/resolve-smart-paste": "resolve*（日志/归因类）",

    "/notifications/read": "拉取通知",
    "/notifications/mark-as-read": "标记已读"
  };

  ns.summarizeSummaryBox = function summarizeSummaryBox(summary) {
    const s = summary && typeof summary === "object" ? summary : {};
    const off = s.official && typeof s.official === "object" ? s.official : {};
    const providers = Array.isArray(s.providers) ? s.providers : [];

    const lines = [];
    lines.push(`<div class="title">Runtime</div>`);
    lines.push(`<div class="small">runtimeEnabled: <span class="mono">${escapeHtml(String(Boolean(s.runtimeEnabled)))}</span></div>`);
    if (s.storageKey) lines.push(`<div class="small">storageKey: <span class="mono">${escapeHtml(String(s.storageKey))}</span></div>`);

    lines.push(`<div style="height:10px"></div>`);
    lines.push(`<div class="title">Official</div>`);
    lines.push(`<div class="small">completionUrl: <span class="mono">${escapeHtml(off.completionUrl || "")}</span></div>`);
    lines.push(`<div class="small">apiToken: ${off.apiTokenSet ? `<span class="badge">set</span>` : `<span class="badge">empty</span>`}</div>`);

    lines.push(`<div style="height:10px"></div>`);
    lines.push(`<div class="title">Providers</div>`);
    if (!providers.length) lines.push(`<div class="small">(none)</div>`);
    for (const p of providers) {
      lines.push(`<div class="card" style="padding:8px;margin-top:8px;">`);
      lines.push(`<div class="small"><span class="mono">${escapeHtml(p.id)}</span> <span class="badge">${escapeHtml(p.type || "")}</span></div>`);
      if (p.baseUrl) lines.push(`<div class="small">baseUrl: <span class="mono">${escapeHtml(p.baseUrl)}</span></div>`);
      if (p.defaultModel) lines.push(`<div class="small">defaultModel: <span class="mono">${escapeHtml(p.defaultModel)}</span></div>`);
      lines.push(`<div class="small">auth: ${p.authSet ? `<span class="badge">set</span>` : `<span class="badge">empty</span>`}</div>`);
      lines.push(`<div class="small">apiKey: ${p.apiKeySet ? `<span class="badge">set</span>` : `<span class="badge">empty</span>`}</div>`);
      lines.push(`<div class="small">headers: <span class="mono">${escapeHtml(String(p.headersCount || 0))}</span></div>`);
      lines.push(`<div class="small">models: <span class="mono">${escapeHtml(String(p.modelsCount || 0))}</span></div>`);
      lines.push(`</div>`);
    }

    return lines.join("");
  };

  ns.renderApp = function renderApp({ cfg, summary, status, modal, dirty, sideCollapsed, endpointSearch, selfTest }) {
    const c = cfg && typeof cfg === "object" ? cfg : {};
    const s = summary && typeof summary === "object" ? summary : {};
    const off = c.official && typeof c.official === "object" ? c.official : {};
    const routing = c.routing && typeof c.routing === "object" ? c.routing : {};
    const endpointSearchText = normalizeStr(endpointSearch);

    const providers = Array.isArray(c.providers) ? c.providers : [];
    const providerIds = providers.map((p) => normalizeStr(p?.id)).filter(Boolean);

    const rulesObj = routing.rules && typeof routing.rules === "object" ? routing.rules : {};
    const ruleEndpoints = Object.keys(rulesObj).sort();
    const knownEndpoints = uniq(ENDPOINT_GROUPS_V1.flatMap((g) => (Array.isArray(g?.endpoints) ? g.endpoints : [])));
    const knownEndpointSet = new Set(knownEndpoints);
    const unknownRuleEndpoints = uniq(ruleEndpoints.filter((ep) => ep && !knownEndpointSet.has(ep)));

    const isDirty = dirty === true;
    const isSideCollapsed = sideCollapsed === true;
    const runtimeEnabled = s.runtimeEnabled === true;

    const st = selfTest && typeof selfTest === "object" ? selfTest : {};
    const stRunning = st.running === true;
    const stLogs = Array.isArray(st.logs) ? st.logs : [];
    const stReport = st.report && typeof st.report === "object" ? st.report : null;

    const summarizeSelfTestReport = () => {
      if (!stReport) return "";
      const ps = Array.isArray(stReport.providers) ? stReport.providers : [];
      const total = ps.length;
      const failed = ps.filter((p) => p && p.ok === false).length;
      const globals = stReport.global && typeof stReport.global === "object" ? stReport.global : {};
      const gTests = Array.isArray(globals.tests) ? globals.tests : [];
      const gFailed = gTests.filter((x) => x && x.ok === false).length;
      const toolExec = globals.toolExec && typeof globals.toolExec === "object" ? globals.toolExec : null;
      const toolExecBadge =
        toolExec && toolExec.ok === true ? `<span class="badge">ok</span>` : toolExec && toolExec.ok === false ? `<span class="badge">failed</span>` : "";
      const failedTools = toolExec && Array.isArray(toolExec.failedTools) ? toolExec.failedTools : [];
      const failedToolsText = failedTools.length ? `${failedTools.join(",")}${toolExec && toolExec.failedToolsTruncated ? ",…" : ""}` : "";
      const badge = stReport.ok === true ? `<span class="badge">ok</span>` : `<span class="badge">failed</span>`;
      return (
        `<div class="small">result: ${badge} providers_failed=${failed}/${total} global_failed=${gFailed}/${gTests.length}</div>` +
        (toolExec
          ? `<div class="small">toolsExec: ${toolExecBadge} ${escapeHtml(String(toolExec.detail || ""))}</div>`
          : "") +
        (failedToolsText ? `<div class="small mono">failed_tools: ${escapeHtml(failedToolsText)}</div>` : "")
      );
    };

    const selfTestHtml = `
      <div class="card">
        <div class="title">Self Test</div>
        <div class="row" style="justify-content:space-between;align-items:center;">
          <div class="row">
            <button class="btn primary" data-action="runSelfTest" ${stRunning ? "disabled" : ""}>Run</button>
            <button class="btn" data-action="cancelSelfTest" ${stRunning ? "" : "disabled"}>Cancel</button>
            <button class="btn" data-action="clearSelfTest" ${stRunning ? "disabled" : ""}>Clear</button>
          </div>
          ${stRunning ? `<span class="badge">running</span>` : stReport ? (stReport.ok === true ? `<span class="badge">ok</span>` : `<span class="badge">failed</span>`) : ""}
        </div>
        <div class="hint">覆盖：models / 非流式 / 流式 / chat-stream / 真实工具集(schema+tool_use 往返) / 真实工具执行(toolsModel.callTool 全覆盖) / 多模态 / 上下文压缩(historySummary) / 缓存命中。</div>
        ${summarizeSelfTestReport()}
        <textarea class="mono" id="selfTestLog" readonly style="min-height:160px;">${escapeHtml(stLogs.join("\n"))}</textarea>
      </div>
    `;

    const toolbar = [
      `<button class="btn primary" data-action="save">Save</button>`,
      `<button class="btn" data-action="reset">Reset</button>`,
      `<button class="btn" data-action="reload">Reload</button>`,
      runtimeEnabled
        ? `<button class="btn danger" data-action="toggleRuntime">Rollback (Disable Runtime)</button>`
        : `<button class="btn" data-action="toggleRuntime">Enable Runtime</button>`,
      `<button class="btn" data-action="toggleSide">${isSideCollapsed ? "Show Summary" : "Hide Summary"}</button>`,
      isDirty ? `<span class="badge" id="dirtyBadge">pending</span>` : `<span class="badge" id="dirtyBadge">saved</span>`
    ].join("");

    const saveHint = `
      <div class="hint">
        提示：面板里的修改只会暂存在 UI 中，点击 <span class="mono">Save</span> 才会写入 extension <span class="mono">globalState</span>。
        <span class="mono">Reload</span> 会丢弃未保存修改并重新加载最后一次保存的配置；<span class="mono">Reset</span> 会直接写入默认配置。
      </div>
    `;

    const general = `
      <div class="card">
        <div class="title">General</div>
        <div class="hint">
          常用：设置默认 BYOK provider（用于未显式指定 provider 的 byok 路由，以及 <span class="mono">/get-models</span> 注入的默认模型偏好）。总开关请用顶部按钮。
        </div>
        <div class="grid">
          <div>routing.default_provider_id</div>
          <div>
            <select id="defaultProviderId">
              ${optionHtml({ value: "", label: "(auto)", selected: !routing.defaultProviderId })}
              ${providerIds.map((id) => optionHtml({ value: id, label: id, selected: routing.defaultProviderId === id })).join("")}
            </select>
            <div class="small">留空：自动选择（通常为 providers[0]）。</div>
          </div>
        </div>
      </div>
    `;

    const official = `
      <div class="card">
        <div class="title">Official</div>
        <div class="hint">
          用于 non-LLM 端点 official 路由 + /get-models 合并。
          若你已通过 Augment 登录（OAuth），通常可以留空 <span class="mono">api_token</span>（走登录态）；
          若填入 <span class="mono">api_token</span>（API Token 模式），<span class="mono">completion_url</span> 需要是 tenant URL（形如 <span class="mono">https://&lt;tenant&gt;.augmentcode.com/</span>），否则 Preferences → Secrets Manager 可能报 <span class="mono">Not Found</span>。
        </div>
        <div class="grid">
          <div>completion_url</div>
          <div><input type="text" id="officialCompletionUrl" value="${escapeHtml(off.completionUrl ?? "")}" placeholder="https://&lt;tenant&gt;.augmentcode.com/" /></div>
          <div>api_token</div>
          <div class="row">
            <input type="password" id="officialApiToken" value="" placeholder="${off.apiToken ? "(set)" : "(empty)"}" />
            <button class="btn" data-action="clearOfficialToken">Clear</button>
          </div>
        </div>
        <div class="small">说明：token 输入框留空=保持不变；Clear=清空。</div>
      </div>
    `;

    const providersHtml = `
      <div class="card">
        <div class="title">Providers</div>
        <div class="hint">OpenAI Chat Completions / OpenAI Responses（Codex）/ Anthropic / Google Gemini（AI Studio）。models 用于下拉选择与 /get-models 注入。</div>
        <div class="row" style="margin-bottom:8px;justify-content:space-between;">
          <button class="btn" data-action="addProvider">Add Provider</button>
          <div class="small">Tips: Fetch Models 会把结果写入 UI（pending save）。</div>
        </div>
        <div style="overflow:auto;">
          <table>
            <thead>
              <tr>
                <th style="min-width:120px;">id</th>
                <th style="min-width:140px;">type</th>
                <th style="min-width:260px;">base_url</th>
                <th style="min-width:220px;">api_key</th>
                <th style="min-width:180px;">models</th>
                <th style="min-width:220px;">default_model</th>
                <th style="min-width:170px;">advanced</th>
                <th style="min-width:90px;"></th>
              </tr>
            </thead>
            <tbody>
              ${providers
                .map((p, idx) => {
                  const pid = normalizeStr(p?.id);
                  const type = normalizeStr(p?.type);
                  const baseUrl = normalizeStr(p?.baseUrl);
                  const apiKeySet = Boolean(normalizeStr(p?.apiKey));
                  const dm = normalizeStr(p?.defaultModel);
                  const rawModels = Array.isArray(p?.models) ? p.models : [];
                  const models = uniq(rawModels.filter((m) => normalizeStr(m)));
                  const modelOptions = uniq(models.concat(dm ? [dm] : []));

                  return `
                    <tr>
                      <td><input type="text" data-p-idx="${idx}" data-p-key="id" value="${escapeHtml(pid)}" placeholder="openai" /></td>
                      <td>
                        <select data-p-idx="${idx}" data-p-key="type">
                          ${optionHtml({ value: "openai_compatible", label: "openai_compatible", selected: type === "openai_compatible" })}
                          ${optionHtml({ value: "openai_responses", label: "openai_responses", selected: type === "openai_responses" })}
                          ${optionHtml({ value: "anthropic", label: "anthropic", selected: type === "anthropic" })}
                          ${optionHtml({ value: "gemini_ai_studio", label: "gemini_ai_studio", selected: type === "gemini_ai_studio" })}
                        </select>
                      </td>
                      <td><input type="text" data-p-idx="${idx}" data-p-key="baseUrl" value="${escapeHtml(baseUrl)}" placeholder="https://api.openai.com/v1" /></td>
                      <td>
                        <div class="row">
                          <input type="password" data-p-idx="${idx}" data-p-key="apiKeyInput" value="" placeholder="${apiKeySet ? "(set)" : "(empty)"}" />
                          <button class="btn" data-action="clearProviderKey" data-idx="${idx}">Clear</button>
                        </div>
                      </td>
                      <td>
                        <div class="row">
                          <span class="badge">${escapeHtml(String(models.length))}</span>
                          <button class="btn" data-action="fetchProviderModels" data-idx="${idx}">Fetch</button>
                          <button class="btn" data-action="editProviderModels" data-idx="${idx}">Edit</button>
                        </div>
                      </td>
                      <td>
                        <select data-p-idx="${idx}" data-p-key="defaultModel">
                          ${optionHtml({ value: "", label: "(auto)", selected: !dm })}
                          ${modelOptions.map((m) => optionHtml({ value: m, label: m, selected: dm === m })).join("")}
                        </select>
                      </td>
                      <td>
                        <div class="row">
                          <button class="btn" data-action="editProviderHeaders" data-idx="${idx}">Headers</button>
                          <button class="btn" data-action="editProviderRequestDefaults" data-idx="${idx}">Defaults</button>
                        </div>
                      </td>
                      <td><button class="btn danger" data-action="removeProvider" data-idx="${idx}">Remove</button></td>
                    </tr>
                  `;
                })
                .join("") || `<tr><td colspan="8" class="small">(no providers)</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    `;

    const historySummary = c.historySummary && typeof c.historySummary === "object" ? c.historySummary : {};
    const hsEnabled = historySummary.enabled === true;
    const hsProviderId = normalizeStr(historySummary.providerId);
    const hsModel = normalizeStr(historySummary.model);
    const hsByokModel = hsProviderId && hsModel ? `byok:${hsProviderId}:${hsModel}` : "";
    const hsModelGroups = providers
      .map((p) => {
        const pid = normalizeStr(p?.id);
        const dm = normalizeStr(p?.defaultModel);
        const rawModels = Array.isArray(p?.models) ? p.models : [];
        const models = uniq(rawModels.map((m) => normalizeStr(m)).filter(Boolean).concat(dm ? [dm] : [])).sort((a, b) => a.localeCompare(b));
        return { pid, models };
      })
      .filter((g) => g && g.pid && Array.isArray(g.models) && g.models.length)
      .sort((a, b) => a.pid.localeCompare(b.pid));
    const historySummaryHtml = `
      <div class="card">
        <div class="title">History Summary（上下文压缩）</div>
        <div class="hint">
          启用后会在后台自动做“滚动摘要”，用于避免上下文溢出；面板/聊天 UI 仍显示完整历史（压缩仅用于发给上游模型）。
          高级参数使用默认值（当前面板未提供高级字段编辑）。
        </div>
        <div class="grid">
          <div>historySummary.enabled</div>
          <div class="row">
            <input type="checkbox" id="historySummaryEnabled" ${hsEnabled ? "checked" : ""} />
            <span class="small">启用</span>
          </div>
          <div>historySummary.model</div>
          <div>
            <select id="historySummaryByokModel">
              ${optionHtml({ value: "", label: "(follow current request)", selected: !hsByokModel })}
              ${hsModelGroups
                .map((g) => {
                  const options = g.models
                    .map((m) => {
                      const v = `byok:${g.pid}:${m}`;
                      return optionHtml({ value: v, label: m, selected: v === hsByokModel });
                    })
                    .join("");
                  return `<optgroup label="${escapeHtml(g.pid)}">${options}</optgroup>`;
                })
                .join("")}
            </select>
            <div class="small">留空则跟随当前对话模型；选择项来自 providers[].models。</div>
          </div>
          <div>cache</div>
          <div class="row">
            <button class="btn" data-action="clearHistorySummaryCache">Clear Summary Cache</button>
            <span class="small">仅清理后台摘要复用缓存，不影响 UI 历史显示。</span>
          </div>
        </div>
      </div>
    `;

    const providerMap = computeProviderIndexById(c);
    const llmGroup = ENDPOINT_GROUPS_V1.find((g) => g && g.id === "llm_data_plane");
    const byokSupportedSet = new Set(Array.isArray(llmGroup?.endpoints) ? llmGroup.endpoints : []);

    const endpointGroups = ENDPOINT_GROUPS_V1.concat(
      unknownRuleEndpoints.length
        ? [{ id: "other_from_config", label: "其他（来自配置）", endpoints: unknownRuleEndpoints }]
        : []
    );

    const defaultMode = "official";
    const defaultModeLabel = "default (official)";

    const endpointGroupsHtml = endpointGroups
      .map((g) => {
        const endpoints = Array.isArray(g?.endpoints) ? g.endpoints : [];
        const overrideCount = endpoints.filter((ep) => {
          const r = rulesObj[ep] && typeof rulesObj[ep] === "object" ? rulesObj[ep] : null;
          const m = normalizeStr(r?.mode);
          return m === "official" || m === "byok" || m === "disabled";
        }).length;

        const openAttr = endpointSearchText ? " open" : overrideCount ? " open" : "";

        const rows = endpoints
          .map((ep) => {
            const r = rulesObj[ep] && typeof rulesObj[ep] === "object" ? rulesObj[ep] : {};
            const mode = normalizeStr(r.mode);
            const modeIsByok = mode === "byok";
            const providerId = normalizeStr(r.providerId);
            const model = normalizeStr(r.model);
            const models = providerId && providerMap[providerId] && Array.isArray(providerMap[providerId].models) ? providerMap[providerId].models : [];

            const providerDisabled = !modeIsByok;
            const modelDisabled = providerDisabled || !providerId;
            const modelOptions = uniq(models.concat(model ? [model] : []));

            const desc = typeof ENDPOINT_MEANINGS_V1[ep] === "string" ? ENDPOINT_MEANINGS_V1[ep] : "";
            const byokDisabled = !byokSupportedSet.has(ep) && mode !== "byok" && g.id !== "other_from_config";

            return `
              <div class="endpoint-grid endpoint-row" data-endpoint-row="${escapeHtml(ep)}" data-endpoint-desc="${escapeHtml(desc)}">
                <div class="endpoint-meta">
                  <div class="mono">${escapeHtml(ep)}</div>
                  ${desc ? `<div class="small endpoint-desc">${escapeHtml(desc)}</div>` : ``}
                </div>
                <div>
                  <select data-rule-ep="${escapeHtml(ep)}" data-rule-key="mode">
                    ${optionHtml({ value: "", label: defaultModeLabel, selected: !mode })}
                    ${optionHtml({ value: "official", label: "official", selected: mode === "official" })}
                    ${optionHtml({ value: "byok", label: byokSupportedSet.has(ep) ? "byok" : "byok (LLM only)", selected: mode === "byok", disabled: byokDisabled })}
                    ${optionHtml({ value: "disabled", label: "disabled (no-op)", selected: mode === "disabled" })}
                  </select>
                </div>
                <div>
                  <select data-rule-ep="${escapeHtml(ep)}" data-rule-key="providerId" ${providerDisabled ? `disabled title="Only used when mode=byok"` : ""}>
                    ${optionHtml({ value: "", label: "(auto / from model picker)", selected: !providerId })}
                    ${providerIds.map((id) => optionHtml({ value: id, label: id, selected: providerId === id })).join("")}
                  </select>
                </div>
                <div>
                  <select data-rule-ep="${escapeHtml(ep)}" data-rule-key="model" ${modelDisabled ? `disabled title="Pick provider first (mode=byok)"` : ""}>
                    ${optionHtml({ value: "", label: "(auto / from model picker)", selected: !model })}
                    ${modelOptions.map((m) => optionHtml({ value: m, label: m, selected: model === m })).join("")}
                  </select>
                </div>
              </div>
            `;
          })
          .join("");

        return `
	          <details class="endpoint-group" data-endpoint-group="${escapeHtml(g.id)}"${openAttr}>
	            <summary class="endpoint-group-summary">
	              <span>${escapeHtml(g.label)}</span>
	              <span class="row" style="gap:6px;">
	                <span class="badge">${escapeHtml(String(overrideCount))} overridden</span>
	                <span class="badge" data-endpoint-group-count-badge>${escapeHtml(String(endpoints.length))} total</span>
	              </span>
	            </summary>
	            <div class="endpoint-group-body">
	              <div class="endpoint-grid endpoint-grid-header small">
	                <div>endpoint</div>
                <div>mode</div>
                <div>provider</div>
                <div>model</div>
              </div>
              ${rows || `<div class="small">(empty)</div>`}
            </div>
          </details>
        `;
      })
      .join("");

    const endpointRules = `
      <div class="card">
        <div class="title">Endpoint Rules</div>
	        <div class="hint">
	          这里统一管理 endpoint 的 <span class="mono">Routing</span> + <span class="mono">Disable</span>。
	          <span class="mono">disabled</span> 表示本地 no-op（不发网络请求），用于屏蔽遥测/排查调用链。
	          当前清单包含 <span class="mono">${escapeHtml(String(knownEndpoints.length))}</span> 个已知 endpoint；只有当 Augment 实际调用到该 endpoint 时规则才会生效。
	          未显式设置则默认 <span class="mono">official</span>。
	          <br/>
	          说明：当前仅 <span class="mono">LLM 数据面（13）</span> 支持 <span class="mono">byok</span>；其它端点默认只能 <span class="mono">official/disabled</span>。
	        </div>
        <div class="row" style="margin-bottom:8px;gap:8px;align-items:center;flex-wrap:wrap;">
          <input type="text" id="endpointSearch" value="${escapeHtml(endpointSearchText)}" placeholder="搜索 endpoint 或含义（支持子串过滤，例如 /record-、GitHub、token）" />
          <span class="small" id="endpointFilterCount"></span>
        </div>
        ${endpointGroupsHtml || `<div class="small">(no endpoints)</div>`}
      </div>
    `;

    const m = modal && typeof modal === "object" ? modal : null;
    const mKind = normalizeStr(m?.kind);
    const mIdx = Number(m?.idx);
    const mProvider = Number.isFinite(mIdx) && mIdx >= 0 && mIdx < providers.length ? providers[mIdx] : null;
    const modalHtml =
      !mKind
        ? ""
        : mKind === "confirmReset"
          ? `
              <div class="modal-backdrop">
                <div class="modal card">
                  <div class="title">Reset to defaults?</div>
                  <div class="hint">这会覆盖存储在 extension globalState 里的 BYOK 配置（token/key 也会被清空）。</div>
                  <div class="row" style="margin-top:10px;justify-content:flex-end;">
                    <button class="btn" data-action="modalCancel">Cancel</button>
                    <button class="btn danger" data-action="confirmReset">Reset</button>
                  </div>
                </div>
              </div>
            `
          : !mProvider
            ? ""
            : (() => {
            const title =
              mKind === "models" ? `Edit models (Provider #${mIdx + 1})` : mKind === "headers" ? `Edit headers (Provider #${mIdx + 1})` : `Edit request_defaults (Provider #${mIdx + 1})`;
            const text =
              mKind === "models"
                ? (Array.isArray(mProvider.models) ? mProvider.models : []).join("\n")
                : JSON.stringify(mKind === "headers" ? (mProvider.headers ?? {}) : (mProvider.requestDefaults ?? {}), null, 2);
            const hint =
              mKind === "models" ? "每行一个 model id（用于下拉选择与 /get-models 注入）。" : "请输入 JSON 对象（会在 Save 时持久化）。";

            return `
              <div class="modal-backdrop">
                <div class="modal card">
                  <div class="title">${escapeHtml(title)}</div>
                  <div class="hint">${escapeHtml(hint)}</div>
                  <textarea class="mono" id="modalText" style="min-height:240px;">${escapeHtml(text)}</textarea>
                  <div class="row" style="margin-top:10px;justify-content:flex-end;">
                    <button class="btn" data-action="modalCancel">Cancel</button>
                    <button class="btn primary" data-action="modalApply">Apply</button>
                  </div>
                </div>
              </div>
            `;
          })();

    return `
      <div class="wrap${isSideCollapsed ? " side-collapsed" : ""}">
        <div class="main">
          <div class="toolbar">${toolbar}</div>
          <div class="status" id="status">${escapeHtml(status || "Ready.")}</div>
          ${saveHint}
          ${general}
          ${official}
          ${providersHtml}
          ${historySummaryHtml}
          ${endpointRules}
          ${selfTestHtml}
        </div>
        <div class="side" id="side">${ns.summarizeSummaryBox(summary)}</div>
      </div>
      ${modalHtml}
    `;
  };
})();
