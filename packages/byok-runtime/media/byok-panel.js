(() => {
  const vscode = acquireVsCodeApi();
  const state = { config: null, secretStatus: null, llmEndpoints: [], modelsCacheByProviderId: {} };
  const pending = new Map();

  const el = (id) => document.getElementById(id);
  const normalizeString = (v) => (typeof v === "string" ? v.trim() : "");

  const toast = (text) => {
    const node = el("toast-notification");
    if (!node) return;
    node.textContent = String(text || "");
    node.classList.add("is-visible");
    setTimeout(() => node.classList.remove("is-visible"), 1400);
  };

  const setBadge = (node, { text, level }) => {
    if (!node) return;
    node.textContent = text;
    node.classList.remove("status-badge--success", "status-badge--warning", "status-badge--error");
    if (level === "success") node.classList.add("status-badge--success");
    if (level === "warning") node.classList.add("status-badge--warning");
    if (level === "error") node.classList.add("status-badge--error");
  };

  const rpc = (method, params) => {
    const requestId = String(Date.now()) + ":" + Math.random().toString(16).slice(2);
    vscode.postMessage({ type: "byok-rpc", requestId, method, params: params || null });
    const timeoutMs = method === "listModels" ? 20000 : method === "testProxy" ? 12000 : 10000;
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      setTimeout(() => {
        if (!pending.has(requestId)) return;
        pending.delete(requestId);
        reject(new Error("请求超时"));
      }, timeoutMs);
    });
  };

  const joinBaseUrl = (baseUrl, endpoint) => {
    const b = normalizeString(baseUrl);
    const e = normalizeString(endpoint).replace(/^\/+/, "");
    if (!b || !e) return "";
    const base = b.endsWith("/") ? b : b + "/";
    return base + e;
  };

  const readFormToConfig = () => {
    const cfg = JSON.parse(
      JSON.stringify(
        state.config || { version: 2, enabled: false, proxy: { baseUrl: "" }, providers: [], routing: { activeProviderId: "", rules: {} } }
      )
    );
    cfg.version = 2;
    cfg.enabled = Boolean(el("check-plugin-enabled")?.checked);
    cfg.proxy = cfg.proxy || { baseUrl: "" };
    cfg.proxy.baseUrl = normalizeString(el("input-augment-base-url")?.value);
    cfg.routing = cfg.routing || { activeProviderId: "", rules: {} };
    cfg.routing.activeProviderId = normalizeString(el("select-active-provider")?.value);
    return cfg;
  };

  const collectSecretsForSave = () => {
    const proxyToken = normalizeString(el("input-augment-token")?.value);
    const clearProxyToken = el("input-augment-token")?.dataset?.clear === "1";
    const providerSecretsById = {};
    document.querySelectorAll("input[data-secret-provider-id]").forEach((n) => {
      const pid = n?.dataset?.secretProviderId || "";
      const v = normalizeString(n?.value);
      if (pid && v) providerSecretsById[pid] = { apiKey: v };
    });
    return { proxyToken: proxyToken || undefined, clearProxyToken, providerSecretsById };
  };

  const renderEffectiveUrl = () => {
    const baseUrl = normalizeString(el("input-augment-base-url")?.value);
    const out = el("text-effective-url");
    if (!out) return;
    const a = joinBaseUrl(baseUrl, "get-models");
    const b = joinBaseUrl(baseUrl, "chat-stream");
    out.textContent = [a ? "get-models: " + a : "", b ? "chat-stream: " + b : ""].filter(Boolean).join("\n");
  };

  const renderProviderCards = () => {
    const wrap = el("container-providers-list");
    if (!wrap) return;
    wrap.innerHTML = "";
    const providers = Array.isArray(state.config?.providers) ? state.config.providers : [];
    if (providers.length === 0) {
      const div = document.createElement("div");
      div.className = "text-muted";
      div.style.textAlign = "center";
      div.style.padding = "20px";
      div.textContent = "暂无 Provider，请点击右上角新增。";
      wrap.appendChild(div);
      return;
    }

    for (const p of providers) {
      const pid = String(p.id || "");
      const kind = String(p.type || "");
      const isCli = kind === "gemini_cli";
      const sec = (state.secretStatus?.providers && state.secretStatus.providers[pid]) || {};

      const card = document.createElement("div");
      card.className = "provider-card";
      card.dataset.providerId = pid;

      const header = document.createElement("div");
      header.className = "provider-card__header";

      const left = document.createElement("div");
      left.className = "flex-row";
      const chevron = document.createElement("span");
      chevron.className = "icon-chevron";
      chevron.textContent = "▶";
      const title = document.createElement("span");
      const strong = document.createElement("strong");
      strong.textContent = pid;
      const meta = document.createElement("span");
      meta.className = "text-muted text-xs";
      meta.textContent = `(${kind})`;
      title.appendChild(strong);
      title.appendChild(document.createTextNode(" "));
      title.appendChild(meta);
      left.appendChild(chevron);
      left.appendChild(title);

      const right = document.createElement("div");
      right.className = "flex-row";
      const badge = document.createElement("span");
      badge.className = "status-badge text-xs";
      const apiKeyStatus = String(sec.apiKey || "missing");
      if (apiKeyStatus === "env") {
        badge.textContent = "API Key: ENV";
        badge.classList.add("status-badge--success");
      } else if (apiKeyStatus === "set") {
        badge.textContent = "API Key: 已设置";
        badge.classList.add("status-badge--success");
      } else {
        badge.textContent = "API Key: 未设置";
        badge.classList.add("status-badge--warning");
      }

      const btnRemove = document.createElement("button");
      btnRemove.type = "button";
      btnRemove.className = "btn btn--danger btn--small";
      btnRemove.textContent = "删除";
      btnRemove.addEventListener("click", (e) => {
        e.stopPropagation();
        state.config.providers = providers.filter((x) => String(x.id || "") !== pid);
        render();
      });

      right.appendChild(badge);
      right.appendChild(btnRemove);

      header.appendChild(left);
      header.appendChild(right);
      header.addEventListener("click", () => card.classList.toggle("is-expanded"));

      const contentWrapper = document.createElement("div");
      contentWrapper.className = "provider-card__content-wrapper";
      const body = document.createElement("div");
      body.className = "provider-card__body";
      const inner = document.createElement("div");
      inner.className = "provider-card__inner";

      const grid = document.createElement("div");
      grid.className = "form-grid";

      const g1 = document.createElement("div");
      g1.className = "form-group";
      g1.innerHTML = "<label class='form-label'>Base URL (API 前缀，需包含版本段；尾随 / 可省略)</label>";
      const inputBase = document.createElement("input");
      inputBase.type = "url";
      inputBase.value = normalizeString(p.baseUrl);
      inputBase.placeholder =
        kind === "anthropic_native"
          ? "例如: https://api.anthropic.com/v1"
          : isCli
            ? "例如: https://generativelanguage.googleapis.com/v1（用于 models list，可留空）"
            : kind === "openai_native"
              ? "例如: https://api.openai.com/codex/v1"
              : "例如: https://api.openai.com/v1";
      inputBase.addEventListener("input", () => {
        p.baseUrl = normalizeString(inputBase.value);
      });
      g1.appendChild(inputBase);

      const gCmd = document.createElement("div");
      gCmd.className = "form-group";
      gCmd.innerHTML = "<label class='form-label'>Command (gemini_cli)</label>";
      const inputCmd = document.createElement("input");
      inputCmd.type = "text";
      inputCmd.value = normalizeString(p.command);
      inputCmd.placeholder = "例如: gemini";
      inputCmd.addEventListener("input", () => {
        p.command = normalizeString(inputCmd.value);
      });
      gCmd.appendChild(inputCmd);

      const gArgs = document.createElement("div");
      gArgs.className = "form-group form-grid--full";
      gArgs.innerHTML = "<label class='form-label'>Args（每行一个，支持 {{model}}/{{prompt}}）</label>";
      const inputArgs = document.createElement("textarea");
      inputArgs.rows = 3;
      inputArgs.value = Array.isArray(p.args) ? p.args.map((x) => normalizeString(x)).filter(Boolean).join("\n") : "";
      inputArgs.placeholder = "--model\n{{model}}\n--prompt\n{{prompt}}";
      inputArgs.addEventListener("input", () => {
        const args = inputArgs.value
          .split("\n")
          .map((x) => normalizeString(x))
          .filter(Boolean);
        p.args = args.length ? args : undefined;
      });
      gArgs.appendChild(inputArgs);

      const g2 = document.createElement("div");
      g2.className = "form-group";
      g2.innerHTML = "<label class='form-label'>默认模型 (Default Model)</label>";
      const modelRow = document.createElement("div");
      modelRow.className = "flex-row";
      const selectModel = document.createElement("select");
      selectModel.style.flex = "1 1 auto";
      selectModel.appendChild(new Option("（请选择模型）", ""));
      const cachedModels = Array.isArray(state.modelsCacheByProviderId?.[pid]?.models) ? state.modelsCacheByProviderId[pid].models.map((x) => normalizeString(x)).filter(Boolean) : [];
      for (const m of cachedModels) selectModel.appendChild(new Option(m, m));
      const currentModel = normalizeString(p.defaultModel);
      const inputModel = document.createElement("input");
      inputModel.type = "text";
      inputModel.value = currentModel;
      inputModel.placeholder = isCli ? "例如: gemini-1.5-pro" : "例如: gpt-4o-mini";
      inputModel.addEventListener("input", () => {
        const v = normalizeString(inputModel.value);
        p.defaultModel = v || undefined;
        if (selectModel.value !== v) selectModel.value = v;
      });
      if (currentModel && !cachedModels.includes(currentModel)) selectModel.appendChild(new Option(currentModel, currentModel));
      selectModel.value = currentModel;
      selectModel.addEventListener("change", () => {
        const v = normalizeString(selectModel.value);
        p.defaultModel = v || undefined;
        inputModel.value = v;
      });
      const btnRefreshModels = document.createElement("button");
      btnRefreshModels.type = "button";
      btnRefreshModels.className = "btn btn--small";
      btnRefreshModels.textContent = "刷新";
      const textModelsStatus = document.createElement("div");
      textModelsStatus.className = "text-muted text-xs";
      textModelsStatus.textContent = cachedModels.length ? `models: 缓存 ${cachedModels.length}` : "models: 未缓存（可点击刷新拉取）";
      modelRow.appendChild(selectModel);
      modelRow.appendChild(btnRefreshModels);
      g2.appendChild(modelRow);
      g2.appendChild(textModelsStatus);
      g2.appendChild(inputModel);
      const textModelHint = document.createElement("div");
      textModelHint.className = "text-muted text-xs";
      textModelHint.textContent = "提示：chat/chat-stream 由主面板 Model Picker 专属控制；其它 endpoint 未指定 model 时才会用 defaultModel 兜底。";
      g2.appendChild(textModelHint);

      const g3 = document.createElement("div");
      g3.className = "form-group form-grid--full";
      g3.innerHTML = "<label class='form-label'>API Key（支持 ${env:VAR}）</label>";
      const row = document.createElement("div");
      row.className = "flex-row";
      const inputKey = document.createElement("input");
      inputKey.type = "password";
      inputKey.placeholder = "输入以更新（不会回显旧值）";
      inputKey.dataset.secretProviderId = pid;
      row.appendChild(inputKey);
      g3.appendChild(row);

      btnRefreshModels.addEventListener("click", async () => {
        try {
          textModelsStatus.textContent = "models: 加载中...";
          const baseUrl = normalizeString(inputBase.value) || undefined;
          const apiKey = normalizeString(inputKey.value) || undefined;
          const r = await rpc("listModels", { providerId: pid, providerType: kind, baseUrl, apiKey });
          const models = Array.isArray(r?.models) ? r.models.map((x) => normalizeString(x)).filter(Boolean) : [];
          const current = normalizeString(p.defaultModel);
          state.modelsCacheByProviderId[pid] = { updatedAtMs: Date.now(), models };
          selectModel.innerHTML = "";
          selectModel.appendChild(new Option("（请选择模型）", ""));
          if (current && !models.includes(current)) selectModel.appendChild(new Option(current + "（当前/不在列表）", current));
          for (const m of models) selectModel.appendChild(new Option(m, m));
          if (current) selectModel.value = current;
          inputModel.value = current;
          textModelsStatus.textContent = `models: ${models.length}`;
          if (!models.length) toast("models 为空：请检查 baseUrl / apiKey / provider 兼容性");
        } catch (e) {
          textModelsStatus.textContent = "models: 加载失败";
          toast(e.message || e);
        }
      });

      grid.appendChild(g1);
      if (isCli) {
        grid.appendChild(gCmd);
        grid.appendChild(gArgs);
      }
      grid.appendChild(g2);
      grid.appendChild(g3);

      inner.appendChild(grid);
      body.appendChild(inner);
      contentWrapper.appendChild(body);

      card.appendChild(header);
      card.appendChild(contentWrapper);
      wrap.appendChild(card);
    }
  };

  const renderRouting = () => {
    const selectActive = el("select-active-provider");
    const tbody = el("tbody-routing");
    if (!selectActive || !tbody || !state.config) return;

    const providers = Array.isArray(state.config?.providers) ? state.config.providers : [];
    const providerIds = providers.map((p) => normalizeString(p.id)).filter(Boolean);
    state.config.routing = state.config.routing && typeof state.config.routing === "object" ? state.config.routing : { activeProviderId: "", rules: {} };
    state.config.routing.rules = state.config.routing.rules && typeof state.config.routing.rules === "object" ? state.config.routing.rules : {};
    const rules = state.config.routing.rules;

    const isChatEndpoint = (ep) => ep === "chat" || ep === "chat-stream";
    const parseByokModelId = (model) => {
      const raw = normalizeString(model);
      if (!raw.startsWith("byok:")) return null;
      const rest = raw.slice("byok:".length);
      const idx = rest.indexOf(":");
      if (idx <= 0 || idx >= rest.length - 1) return null;
      const providerId = rest.slice(0, idx);
      const modelId = rest.slice(idx + 1);
      if (!providerId || !modelId) return null;
      return { providerId, modelId };
    };

    const readRule = (ep) => {
      const r = rules[ep] && typeof rules[ep] === "object" ? rules[ep] : {};
      if (isChatEndpoint(ep)) {
        return r && r.enabled === false ? { enabled: false } : {};
      }
      const out = { ...r };
      const parsed = parseByokModelId(out.model);
      if (parsed) {
        out.providerId = normalizeString(out.providerId) || parsed.providerId;
        out.model = parsed.modelId;
      }
      return out;
    };

    const writeRule = (ep, next) => {
      const out = {};
      if (next && next.enabled === false) out.enabled = false;
      const providerId = normalizeString(next && next.providerId);
      const model = normalizeString(next && next.model);
      if (!isChatEndpoint(ep)) {
        if (providerId) out.providerId = providerId;
        if (model) out.model = model;
      }
      if (Object.keys(out).length) rules[ep] = out;
      else delete rules[ep];
    };

    selectActive.innerHTML = "";
    selectActive.appendChild(new Option("（自动：第一个 Provider）", ""));
    for (const id of providerIds) selectActive.appendChild(new Option(id, id));
    selectActive.value = normalizeString(state.config.routing.activeProviderId);
    selectActive.onchange = () => {
      state.config.routing.activeProviderId = normalizeString(selectActive.value);
      renderRouting();
    };

    tbody.innerHTML = "";
    const endpoints = Array.isArray(state.llmEndpoints) ? state.llmEndpoints.map((x) => normalizeString(x)).filter(Boolean) : [];
    if (!endpoints.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 4;
      td.className = "text-muted";
      td.textContent = "LLM 端点列表未加载（请先完成 payload 构建或检查 config/byok-routing/llm-endpoints.json 是否已打包）。";
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    if (!providerIds.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 4;
      td.className = "text-muted";
      td.textContent = "请先新增 Provider（否则无法设置路由）。";
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    for (const ep of endpoints) {
      const r = rules[ep] && typeof rules[ep] === "object" ? rules[ep] : null;
      if (!r) continue;
      if (isChatEndpoint(ep)) {
        if (r.enabled === false) rules[ep] = { enabled: false };
        else delete rules[ep];
        continue;
      }
      const parsed = parseByokModelId(r.model);
      const providerId = normalizeString(r.providerId) || (parsed ? parsed.providerId : "");
      const model = parsed ? parsed.modelId : normalizeString(r.model);
      const next = {};
      if (r.enabled === false) next.enabled = false;
      if (providerId) next.providerId = providerId;
      if (model) next.model = model;
      if (Object.keys(next).length) rules[ep] = next;
      else delete rules[ep];
    }

    for (const ep of endpoints) {
      const isChat = isChatEndpoint(ep);
      let rule = readRule(ep);
      const tr = document.createElement("tr");

      const tdEp = document.createElement("td");
      const epText = document.createElement("span");
      epText.className = "text-mono";
      epText.textContent = ep;
      tdEp.appendChild(epText);

      const tdMode = document.createElement("td");
      const modeWrap = document.createElement("div");
      modeWrap.className = "flex-row";

      const chkEnabled = document.createElement("input");
      chkEnabled.type = "checkbox";
      chkEnabled.title = "取消勾选将彻底禁用该 endpoint（fail-fast，不回落到上游）";
      chkEnabled.checked = rule.enabled !== false;

      const modeBadge = document.createElement("span");
      modeBadge.className = "status-badge text-xs";
      const updateMode = () => {
        const enabled = rule.enabled !== false;
        if (!enabled) return setBadge(modeBadge, { text: "禁用", level: "error" });
        if (isChat) return setBadge(modeBadge, { text: "Model Picker", level: "success" });
        const vp = normalizeString(rule.providerId);
        const vm = normalizeString(rule.model);
        const text = vp && vm ? "覆盖 P+M" : vp ? "覆盖 P" : vm ? "覆盖 M" : "默认";
        setBadge(modeBadge, { text, level: vp || vm ? "success" : "warning" });
      };
      updateMode();
      modeWrap.appendChild(chkEnabled);
      modeWrap.appendChild(modeBadge);
      tdMode.appendChild(modeWrap);

      const tdProvider = document.createElement("td");
      const selProvider = document.createElement("select");
      if (isChat) {
        selProvider.appendChild(new Option("（Model Picker 专属）", ""));
        selProvider.disabled = true;
      } else {
        selProvider.appendChild(new Option("（默认：activeProviderId）", ""));
        for (const id of providerIds) selProvider.appendChild(new Option(id, id));
        const currentProviderId = normalizeString(rule.providerId);
        if (currentProviderId && !providerIds.includes(currentProviderId)) selProvider.appendChild(new Option(`${currentProviderId}（未知）`, currentProviderId));
        selProvider.value = currentProviderId;
      }
      tdProvider.appendChild(selProvider);

      const tdModel = document.createElement("td");
      const modelRow = document.createElement("div");
      modelRow.className = "flex-row";
      const selModel = document.createElement("select");
      selModel.style.flex = "1 1 auto";
      const updateModelOptions = () => {
        const providerId = normalizeString(selProvider.value) || normalizeString(selectActive.value) || providerIds[0];
        const cached = Array.isArray(state.modelsCacheByProviderId?.[providerId]?.models)
          ? state.modelsCacheByProviderId[providerId].models.map((x) => normalizeString(x)).filter(Boolean)
          : [];
        selModel.innerHTML = "";
        if (isChat) {
          selModel.appendChild(new Option("（Model Picker 专属）", ""));
          selModel.disabled = true;
          return;
        }
        const current = normalizeString(rule.model);
        selModel.disabled = rule.enabled === false;
        selModel.appendChild(new Option("（默认：provider.defaultModel）", ""));
        if (current && !cached.includes(current)) selModel.appendChild(new Option(current + "（当前/不在缓存）", current));
        for (const m of cached) selModel.appendChild(new Option(m, m));
        selModel.value = current;
      };
      updateModelOptions();
      const btnRefreshModels = document.createElement("button");
      btnRefreshModels.type = "button";
      btnRefreshModels.className = "btn btn--small";
      btnRefreshModels.textContent = "刷新";
      btnRefreshModels.title = "拉取该 Provider 的 models 并写入缓存";
      btnRefreshModels.addEventListener("click", async () => {
        const providerId = normalizeString(selProvider.value) || normalizeString(selectActive.value) || providerIds[0];
        const provider = providers.find((x) => normalizeString(x.id) === providerId) || null;
        try {
          btnRefreshModels.disabled = true;
          const r = await rpc("listModels", { providerId, providerType: normalizeString(provider?.type) || undefined, baseUrl: normalizeString(provider?.baseUrl) || undefined });
          const models = Array.isArray(r?.models) ? r.models.map((x) => normalizeString(x)).filter(Boolean) : [];
          state.modelsCacheByProviderId[providerId] = { updatedAtMs: Date.now(), models };
          updateModelOptions();
          if (!models.length) toast("models 为空：请检查 baseUrl / apiKey / provider 兼容性");
        } catch (e) {
          toast(e.message || e);
        } finally {
          btnRefreshModels.disabled = false;
        }
      });
      btnRefreshModels.disabled = isChat || rule.enabled === false;

      modelRow.appendChild(selModel);
      modelRow.appendChild(btnRefreshModels);
      tdModel.appendChild(modelRow);

      chkEnabled.addEventListener("change", () => {
        rule = { ...rule };
        if (chkEnabled.checked) delete rule.enabled;
        else rule.enabled = false;
        writeRule(ep, rule);
        renderRouting();
      });

      selProvider.addEventListener("change", () => {
        const v = normalizeString(selProvider.value);
        rule = { ...rule };
        if (v) rule.providerId = v;
        else delete rule.providerId;
        writeRule(ep, rule);
        updateModelOptions();
        updateMode();
      });

      selModel.addEventListener("change", () => {
        const v = normalizeString(selModel.value);
        rule = { ...rule };
        if (v) rule.model = v;
        else delete rule.model;
        if (v && !normalizeString(rule.providerId)) {
          const implied = normalizeString(selectActive.value) || providerIds[0];
          if (implied) {
            rule.providerId = implied;
            selProvider.value = implied;
          }
        }
        writeRule(ep, rule);
        updateMode();
      });

      tr.appendChild(tdEp);
      tr.appendChild(tdMode);
      tr.appendChild(tdProvider);
      tr.appendChild(tdModel);
      tbody.appendChild(tr);
    }
  };

  const render = () => {
    if (!state.config) return;
    el("check-plugin-enabled").checked = Boolean(state.config.enabled);
    el("input-augment-base-url").value = normalizeString(state.config.proxy && state.config.proxy.baseUrl);
    renderEffectiveUrl();
    renderProviderCards();
    renderRouting();

    const tokenStatus = String(state.secretStatus?.proxy?.token || "missing");
    if (tokenStatus === "env") setBadge(el("badge-token-status"), { text: "ENV", level: "success" });
    else if (tokenStatus === "set") setBadge(el("badge-token-status"), { text: "已设置", level: "success" });
    else setBadge(el("badge-token-status"), { text: "未设置", level: "warning" });

    const baseUrl = normalizeString(el("input-augment-base-url")?.value);
    if (!/^https?:\/\//i.test(baseUrl)) setBadge(el("badge-proxy-config"), { text: "Base URL 无效", level: "error" });
    else setBadge(el("badge-proxy-config"), { text: "已配置", level: "success" });

    const enabled = Boolean(state.config.enabled);
    setBadge(el("badge-adapter-status"), { text: enabled ? "BYOK: ON" : "BYOK: OFF", level: enabled ? "success" : "warning" });
    const hasGetModels = Array.isArray(state.llmEndpoints) && state.llmEndpoints.includes("get-models");
    setBadge(el("badge-chat-status"), { text: enabled && hasGetModels ? "Model Picker: BYOK" : "Model Picker: 原生", level: enabled && hasGetModels ? "success" : "warning" });
  };

  const load = async () => {
    const r = await rpc("load", null);
    state.config = r.config;
    state.secretStatus = r.secretStatus;
    state.modelsCacheByProviderId = r.modelsCache && typeof r.modelsCache === "object" ? r.modelsCache : {};
    try {
      const e = await rpc("getLlmEndpoints", null);
      state.llmEndpoints = Array.isArray(e?.endpoints) ? e.endpoints.map((x) => normalizeString(x)).filter(Boolean) : [];
    } catch (e) {
      state.llmEndpoints = [];
      toast(e.message || e);
    }
    render();
  };

  window.addEventListener("message", (ev) => {
    const msg = ev.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.type !== "byok-rpc-response") return;
    const p = pending.get(msg.requestId);
    if (!p) return;
    pending.delete(msg.requestId);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error || "未知错误"));
  });

  el("btn-reload").addEventListener("click", () => load().catch((e) => toast(e.message || e)));

  el("btn-save-all").addEventListener("click", async () => {
    try {
      const config = readFormToConfig();
      const secrets = collectSecretsForSave();
      await rpc("save", { config, ...secrets });
      el("input-augment-token").value = "";
      el("input-augment-token").dataset.clear = "0";
      document.querySelectorAll("input[data-secret-provider-id]").forEach((n) => (n.value = ""));
      await load();
      toast("配置已保存");
    } catch (e) {
      toast(e.message || e);
    }
  });

  el("input-augment-base-url").addEventListener("input", () => renderEffectiveUrl());

  el("btn-clear-augment-token").addEventListener("click", () => {
    el("input-augment-token").value = "";
    el("input-augment-token").dataset.clear = "1";
    toast("Token 将在保存后清除");
  });

  el("btn-test-proxy").addEventListener("click", async () => {
    try {
      setBadge(el("badge-proxy-test"), { text: "测试中...", level: "warning" });
      const r = await rpc("testProxy", null);
      setBadge(el("badge-proxy-test"), { text: r.ok ? "OK " + r.status : "FAIL " + r.status, level: r.ok ? "success" : "error" });
    } catch (e) {
      setBadge(el("badge-proxy-test"), { text: "FAIL", level: "error" });
      toast(e.message || e);
    }
  });

  el("btn-show-add-provider").addEventListener("click", () => el("region-add-provider").classList.remove("hidden"));
  el("btn-cancel-add-provider").addEventListener("click", () => el("region-add-provider").classList.add("hidden"));

  el("btn-confirm-add-provider").addEventListener("click", () => {
    const id = normalizeString(el("input-new-provider-id")?.value);
    const kind = normalizeString(el("select-new-provider-kind")?.value);
    if (!id) return toast("Provider ID 不能为空");
    const providers = Array.isArray(state.config?.providers) ? state.config.providers : [];
    if (providers.some((p) => String(p.id || "") === id)) return toast("Provider ID 已存在");
    const type = kind === "anthropic" ? "anthropic_native" : kind === "codex" ? "openai_native" : kind === "geminiCli" ? "gemini_cli" : "openai_compatible";
    providers.push(type === "gemini_cli" ? { id, type, baseUrl: "", defaultModel: "", command: "gemini", args: ["--model", "{{model}}", "--prompt", "{{prompt}}"] } : { id, type, baseUrl: "", defaultModel: "" });
    state.config.providers = providers;
    el("input-new-provider-id").value = "";
    el("region-add-provider").classList.add("hidden");
    render();
  });

  load().catch((e) => toast(e.message || e));
})();
