(function () {
  "use strict";

  const ns = (window.__byokCfgPanel = window.__byokCfgPanel || {});
  const { normalizeStr, uniq, escapeHtml, optionHtml } = ns;

  /**
   * 渲染 History Summary 面板（从 config-panel.webview.render.js 拆分还原 + Advanced 字段对齐）。
   * 签名与 app.js 第 235 行保持一致：ns.renderHistorySummaryPanel({ cfg, providers })
   * @param {{ cfg: object, providers: Array }} options
   * @returns {string} HTML
   */
  ns.renderHistorySummaryPanel = function renderHistorySummaryPanel({ cfg, providers } = {}) {
    const c = cfg && typeof cfg === "object" ? cfg : {};
    const providersList = Array.isArray(providers) ? providers : [];

    const hs = c.historySummary && typeof c.historySummary === "object" ? c.historySummary : {};
    const hsEnabled = hs.enabled === true;
    const hsProviderId = normalizeStr(hs.providerId);
    const hsModel = normalizeStr(hs.model);
    const hsByokModel = hsProviderId && hsModel ? `byok:${hsProviderId}:${hsModel}` : "";

    /* ---------- Model 下拉 ---------- */
    const hsModelGroups = providersList
      .map((p) => {
        const pid = normalizeStr(p?.id);
        const dm = normalizeStr(p?.defaultModel);
        const rawModels = Array.isArray(p?.models) ? p.models : [];
        const models = uniq(rawModels.map((m) => normalizeStr(m)).filter(Boolean).concat(dm ? [dm] : [])).sort((a, b) => a.localeCompare(b));
        return { pid, models };
      })
      .filter((g) => g && g.pid && Array.isArray(g.models) && g.models.length)
      .sort((a, b) => a.pid.localeCompare(b.pid));

    /* ---------- Advanced 字段 ---------- */
    const triggerStrategy = normalizeStr(hs.triggerStrategy);
    const prompt = typeof hs.prompt === "string" ? hs.prompt : "";
    const rollingSummary = hs.rollingSummary === true;

    const intVal = (v) => (Number.isFinite(Number(v)) ? String(v) : "");
    const numVal = (v) => (Number.isFinite(Number(v)) ? String(v) : "");

    const contextWindowTokensOverrides =
      hs.contextWindowTokensOverrides && typeof hs.contextWindowTokensOverrides === "object" && !Array.isArray(hs.contextWindowTokensOverrides)
        ? JSON.stringify(hs.contextWindowTokensOverrides, null, 2)
        : "";

    /* ---------- HTML ---------- */
    return `
      <section class="settings-panel">
        <header class="settings-panel__header">
          <span>History Summary</span>
          ${hsEnabled ? `<span class="status-badge status-badge--success">enabled</span>` : `<span class="status-badge status-badge--warning">disabled</span>`}
        </header>
        <div class="settings-panel__body">
          <div class="form-grid">
            <div class="form-group">
              <label class="form-label">启用</label>
              <label class="checkbox-wrapper">
                <input type="checkbox" id="historySummaryEnabled" ${hsEnabled ? "checked" : ""} />
                <span>启用</span>
              </label>
              <div class="text-muted text-xs">启用后会在后台自动做"滚动摘要"，用于避免上下文溢出（仅影响发给上游模型的内容）。</div>
            </div>
            <div class="form-group">
              <label class="form-label">Model</label>
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
              <div class="text-muted text-xs">留空则跟随当前对话模型；候选项来自 providers[].models。</div>
            </div>
            <div class="form-group form-grid--full">
              <div class="flex-row flex-wrap">
                <button class="btn btn--small" data-action="clearHistorySummaryCache">清理摘要缓存</button>
                <span class="text-muted text-xs">仅清理后台摘要复用缓存，不影响 UI 历史显示。</span>
              </div>
            </div>
          </div>

          <details class="endpoint-group" style="margin-top:12px;">
            <summary class="endpoint-group-summary">
              <span>Advanced</span>
              <span class="badge">prompt</span>
            </summary>
            <div class="endpoint-group-body">
              <div class="text-muted text-xs">高级参数；留空=使用默认值。重度字段（summaryNodeRequestMessageTemplate / abridgedHistoryParams）建议在 JSON 导入/导出中维护。</div>
              <div style="height:10px;"></div>
              <div class="form-grid">
                <div class="form-group form-grid--full">
                  <label class="form-label">Prompt</label>
                  <textarea class="mono" rows="4" id="historySummaryPrompt" placeholder="(default)">${escapeHtml(prompt)}</textarea>
                  <div class="text-muted text-xs">摘要生成时发给 LLM 的 system prompt；留空=使用内置默认。</div>
                </div>
                <div class="form-group">
                  <label class="form-label">Rolling Summary</label>
                  <label class="checkbox-wrapper">
                    <input type="checkbox" id="historySummaryRollingSummary" ${rollingSummary ? "checked" : ""} />
                    <span>启用</span>
                  </label>
                  <div class="text-muted text-xs">滚动摘要：每次触发时在旧摘要基础上增量更新。</div>
                </div>
                <div class="form-group">
                  <label class="form-label">Trigger Strategy</label>
                  <select id="historySummaryTriggerStrategy">
                    ${optionHtml({ value: "", label: "(auto)", selected: !triggerStrategy || triggerStrategy === "auto" })}
                    ${optionHtml({ value: "ratio", label: "ratio", selected: triggerStrategy === "ratio" })}
                    ${optionHtml({ value: "chars", label: "chars", selected: triggerStrategy === "chars" })}
                  </select>
                  <div class="text-muted text-xs">auto=智能判断（推荐）；ratio=按上下文占比；chars=按字符数。</div>
                </div>
                <div class="form-group">
                  <label class="form-label">Trigger On Context Ratio</label>
                  <input type="number" id="historySummaryTriggerOnContextRatio" value="${numVal(hs.triggerOnContextRatio)}" placeholder="0.7" step="0.05" min="0.1" max="0.95" />
                  <div class="text-muted text-xs">上下文占比触发阈值（auto/ratio 生效；默认 0.7）。</div>
                </div>
                <div class="form-group">
                  <label class="form-label">Target Context Ratio</label>
                  <input type="number" id="historySummaryTargetContextRatio" value="${numVal(hs.targetContextRatio)}" placeholder="0.55" step="0.05" min="0.1" max="0.95" />
                  <div class="text-muted text-xs">压缩目标占比（默认 0.55）。</div>
                </div>
                <div class="form-group">
                  <label class="form-label">Trigger On History Size Chars</label>
                  <input type="number" id="historySummaryTriggerOnHistorySizeChars" value="${intVal(hs.triggerOnHistorySizeChars)}" placeholder="800000" min="1" />
                  <div class="text-muted text-xs">chars 基准阈值（chars 模式直接使用；auto/ratio 无法推断窗口时回退）。</div>
                </div>
                <div class="form-group">
                  <label class="form-label">History Tail Size Chars To Exclude</label>
                  <input type="number" id="historySummaryHistoryTailSizeCharsToExclude" value="${intVal(hs.historyTailSizeCharsToExclude)}" placeholder="250000" min="0" />
                  <div class="text-muted text-xs">尾部原文预算（进入 end_part_full）。</div>
                </div>
                <div class="form-group">
                  <label class="form-label">Min Tail Exchanges</label>
                  <input type="number" id="historySummaryMinTailExchanges" value="${intVal(hs.minTailExchanges)}" placeholder="2" min="1" />
                  <div class="text-muted text-xs">最少保留尾部轮次（防止 tool_result 孤儿）。</div>
                </div>
                <div class="form-group">
                  <label class="form-label">Max Tokens</label>
                  <input type="number" id="historySummaryMaxTokens" value="${intVal(hs.maxTokens)}" placeholder="1024" min="1" />
                  <div class="text-muted text-xs">摘要 LLM 输出 max_tokens。</div>
                </div>
                <div class="form-group">
                  <label class="form-label">Timeout Seconds</label>
                  <input type="number" id="historySummaryTimeoutSeconds" value="${intVal(hs.timeoutSeconds)}" placeholder="60" min="1" />
                  <div class="text-muted text-xs">摘要请求超时（秒）。</div>
                </div>
                <div class="form-group">
                  <label class="form-label">Max Summarization Input Chars</label>
                  <input type="number" id="historySummaryMaxSummarizationInputChars" value="${intVal(hs.maxSummarizationInputChars)}" placeholder="250000" min="0" />
                  <div class="text-muted text-xs">发给摘要 LLM 的最大输入字符数。</div>
                </div>
                <div class="form-group">
                  <label class="form-label">Cache TTL (ms)</label>
                  <input type="number" id="historySummaryCacheTtlMs" value="${intVal(hs.cacheTtlMs)}" placeholder="0" min="0" />
                  <div class="text-muted text-xs">摘要缓存有效期（毫秒；0=不限时）。</div>
                </div>
                <div class="form-group">
                  <label class="form-label">Context Window Tokens Default</label>
                  <input type="number" id="historySummaryContextWindowTokensDefault" value="${intVal(hs.contextWindowTokensDefault)}" placeholder="0" min="0" />
                  <div class="text-muted text-xs">模型上下文窗口默认值（0=使用内置表）。</div>
                </div>
                <div class="form-group form-grid--full">
                  <label class="form-label">Context Window Tokens Overrides (JSON)</label>
                  <textarea class="mono" rows="4" id="historySummaryContextWindowTokensOverrides" placeholder='{"model-name": 128000}'>${escapeHtml(contextWindowTokensOverrides)}</textarea>
                  <div class="text-muted text-xs">模型窗口覆盖（JSON 对象）；按最长子串、大小写不敏感匹配。</div>
                </div>
              </div>
            </div>
          </details>
        </div>
      </section>
    `;
  };
})();
