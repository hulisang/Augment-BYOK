"use strict";

const { joinBaseUrl } = require("./http");
const { parseSse } = require("./sse");
const { normalizeString, requireString, normalizeRawToken, stripByokInternalKeys } = require("../infra/util");
const { debug } = require("../infra/log");
const { withJsonContentType } = require("./headers");
const { makeToolMetaGetter, assertSseResponse } = require("./provider-util");
const { fetchOkWithRetry, extractErrorMessageFromJson } = require("./request-util");
const { rawResponseNode, makeBackChatChunk } = require("../core/augment-protocol");
const { buildToolUseChunks, buildTokenUsageChunk, buildFinalChatChunk } = require("./chat-chunks-util");
const {
  sanitizeToolHint,
  normalizeFunctionCallArgsToJsonString,
  extractGeminiUsageTokens,
  extractGeminiStopReasonFromCandidate,
  emitGeminiChatJsonAsAugmentChunks
} = require("./gemini-json-util");

const GEMINI_FALLBACK_STATUSES = new Set([400, 422]);

function normalizeGeminiModel(model) {
  const m = requireString(model, "Gemini model");
  if (m.includes("/")) return m;
  return `models/${m}`;
}

function buildGeminiRequest({ baseUrl, apiKey, model, systemInstruction, contents, tools, extraHeaders, requestDefaults, stream }) {
  const b = requireString(baseUrl, "Gemini baseUrl");
  const key = normalizeRawToken(apiKey);
  const extra = extraHeaders && typeof extraHeaders === "object" ? extraHeaders : {};
  if (!key && Object.keys(extra).length === 0) throw new Error("Gemini apiKey 未配置（且 headers 为空）");

  const m = normalizeGeminiModel(model);
  const endpoint = stream ? `${m}:streamGenerateContent` : `${m}:generateContent`;
  const url0 = joinBaseUrl(b, b.includes("/v1beta") ? endpoint : `v1beta/${endpoint}`);
  if (!url0) throw new Error("Gemini URL 构造失败（请检查 baseUrl/model）");

  const u = new URL(url0);
  if (key) u.searchParams.set("key", key);
  if (stream) u.searchParams.set("alt", "sse");

  const rd = stripByokInternalKeys(requestDefaults);
  const body = { ...rd, contents: Array.isArray(contents) ? contents : [] };
  const sys = normalizeString(systemInstruction);
  if (sys && !body.systemInstruction) body.systemInstruction = { parts: [{ text: sys.trim() }] };
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    if (!body.toolConfig) body.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
  }

  const headers = withJsonContentType(extraHeaders);
  if (stream) headers.accept = "text/event-stream";
  return { url: u.toString(), headers, body };
}

function extractGeminiTextFromResponse(json) {
  const candidates = Array.isArray(json?.candidates) ? json.candidates : [];
  const parts = candidates[0]?.content?.parts;
  const list = Array.isArray(parts) ? parts : [];
  let out = "";
  for (const p of list) if (p && typeof p === "object" && typeof p.text === "string" && p.text) out += p.text;
  return out;
}

function stripGeminiInlineDataFromContents(contents, opts) {
  const placeholder =
    typeof opts?.placeholderText === "string" && opts.placeholderText.trim() ? opts.placeholderText.trim() : "[image omitted]";
  const input = Array.isArray(contents) ? contents : [];
  const out = [];
  let changed = false;

  for (const c of input) {
    if (!c || typeof c !== "object") {
      out.push(c);
      continue;
    }
    const parts = Array.isArray(c.parts) ? c.parts : [];
    if (!parts.length) {
      out.push(c);
      continue;
    }

    let localChanged = false;
    const rewritten = [];
    for (const p of parts) {
      if (!p || typeof p !== "object") continue;
      if (p.inlineData && typeof p.inlineData === "object") {
        rewritten.push({ text: placeholder });
        localChanged = true;
      } else rewritten.push(p);
    }
    if (localChanged) {
      out.push({ ...c, parts: rewritten });
      changed = true;
    } else out.push(c);
  }

  return { contents: changed ? out : input, changed };
}

async function fetchGeminiWithFallbacks({
  baseUrl,
  apiKey,
  model,
  systemInstruction,
  contents,
  tools,
  extraHeaders,
  requestDefaults,
  stream,
  timeoutMs,
  abortSignal,
  label
} = {}) {
  const hasTools = Array.isArray(tools) && tools.length > 0;
  const noImages = stripGeminiInlineDataFromContents(contents);

  const attempts = [
    { labelSuffix: "", tools, requestDefaults, contents },
    { labelSuffix: ":no-defaults", tools, requestDefaults: {}, contents }
  ];
  if (noImages.changed) attempts.push({ labelSuffix: ":no-images", tools, requestDefaults: {}, contents: noImages.contents });
  if (hasTools) {
    attempts.push({ labelSuffix: ":no-tools", tools: [], requestDefaults: {}, contents });
    if (noImages.changed) attempts.push({ labelSuffix: ":no-tools-no-images", tools: [], requestDefaults: {}, contents: noImages.contents });
  }

  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    const { url, headers, body } = buildGeminiRequest({
      baseUrl,
      apiKey,
      model,
      systemInstruction,
      contents: a.contents ?? contents,
      tools: a.tools,
      extraHeaders,
      requestDefaults: a.requestDefaults,
      stream: Boolean(stream)
    });
    const lab = `${normalizeString(label) || "Gemini"}${a.labelSuffix || ""}`;

    try {
      return await fetchOkWithRetry(url, { method: "POST", headers, body: JSON.stringify(body) }, { timeoutMs, abortSignal, label: lab });
    } catch (err) {
      lastErr = err;
      const status = err && typeof err === "object" ? Number(err.status) : NaN;
      const canFallback = Number.isFinite(status) && GEMINI_FALLBACK_STATUSES.has(status);
      const hasNext = i + 1 < attempts.length;
      if (!canFallback || !hasNext) throw err;
      debug(`${lab} fallback: retry (status=${status})`);
    }
  }

  throw lastErr || new Error("Gemini request failed");
}

async function geminiCompleteText({ baseUrl, apiKey, model, systemInstruction, contents, timeoutMs, abortSignal, extraHeaders, requestDefaults }) {
  const resp = await fetchGeminiWithFallbacks({
    baseUrl,
    apiKey,
    model,
    systemInstruction,
    contents,
    tools: [],
    extraHeaders,
    requestDefaults,
    stream: false,
    timeoutMs,
    abortSignal,
    label: "Gemini"
  });
  const json = await resp.json().catch(() => null);
  const text = extractGeminiTextFromResponse(json);
  if (!text) throw new Error("Gemini 响应缺少 candidates[0].content.parts[].text");
  return text;
}

async function* geminiStreamTextDeltas({ baseUrl, apiKey, model, systemInstruction, contents, timeoutMs, abortSignal, extraHeaders, requestDefaults }) {
  const resp = await fetchGeminiWithFallbacks({
    baseUrl,
    apiKey,
    model,
    systemInstruction,
    contents,
    tools: [],
    extraHeaders,
    requestDefaults,
    stream: true,
    timeoutMs,
    abortSignal,
    label: "Gemini(stream)"
  });
  const contentType = normalizeString(resp?.headers?.get?.("content-type")).toLowerCase();
  if (contentType.includes("json")) {
    const json = await resp.json().catch(() => null);
    if (json && typeof json === "object" && (json.error || json.message)) {
      const msg = normalizeString(extractErrorMessageFromJson(json)) || "upstream error";
      throw new Error(`Gemini(stream) upstream error: ${msg}`.trim());
    }
    const text = extractGeminiTextFromResponse(json);
    if (text) {
      yield text;
      return;
    }
    throw new Error(`Gemini(stream) JSON 响应缺少 candidates[0].content.parts[].text（content-type=${contentType || "unknown"}）`.trim());
  }
  await assertSseResponse(resp, { label: "Gemini(stream)", expectedHint: "请确认 baseUrl 指向 Google Generative Language API" });

  let dataEvents = 0;
  let parsedChunks = 0;
  let emitted = 0;
  let fullText = "";

  for await (const ev of parseSse(resp)) {
    const data = normalizeString(ev?.data);
    if (!data) continue;
    dataEvents += 1;
    if (data === "[DONE]") break;
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    parsedChunks += 1;
    if (json && typeof json === "object" && json.error) {
      const msg = normalizeString(extractErrorMessageFromJson(json)) || "upstream error";
      throw new Error(`Gemini(stream) upstream error: ${msg}`.trim());
    }
    const chunk = extractGeminiTextFromResponse(json);
    if (!chunk) continue;

    let delta = chunk;
    if (chunk.startsWith(fullText)) {
      delta = chunk.slice(fullText.length);
      fullText = chunk;
    } else {
      fullText += chunk;
    }
    if (delta) {
      emitted += 1;
      yield delta;
    }
  }

  if (emitted === 0) throw new Error(`Gemini(stream) 未解析到任何 SSE delta（data_events=${dataEvents}, parsed_chunks=${parsedChunks}）；请检查 baseUrl 是否为 Gemini SSE`.trim());
}

async function* geminiChatStreamChunks({ baseUrl, apiKey, model, systemInstruction, contents, tools, timeoutMs, abortSignal, extraHeaders, requestDefaults, toolMetaByName, supportToolUseStart }) {
  const getToolMeta = makeToolMetaGetter(toolMetaByName);

  const resp = await fetchGeminiWithFallbacks({
    baseUrl,
    apiKey,
    model,
    systemInstruction,
    contents,
    tools,
    extraHeaders,
    requestDefaults,
    stream: true,
    timeoutMs,
    abortSignal,
    label: "Gemini(chat-stream)"
  });
  const contentType = normalizeString(resp?.headers?.get?.("content-type")).toLowerCase();
  if (contentType.includes("json")) {
    const json = await resp.json().catch(() => null);
    yield* emitGeminiChatJsonAsAugmentChunks(json, { toolMetaByName, supportToolUseStart });
    return;
  }
  await assertSseResponse(resp, { label: "Gemini(chat-stream)", expectedHint: "请确认 baseUrl 指向 Gemini /streamGenerateContent SSE" });

  let nodeId = 0;
  let fullText = "";
  let stopReason = null;
  let stopReasonSeen = false;
  let sawToolUse = false;
  let usagePromptTokens = null;
  let usageCompletionTokens = null;
  let usageCacheReadInputTokens = null;
  let dataEvents = 0;
  let parsedChunks = 0;
  let emittedChunks = 0;
  let toolSeq = 0;

  for await (const ev of parseSse(resp)) {
    const data = normalizeString(ev?.data);
    if (!data) continue;
    dataEvents += 1;
    if (data === "[DONE]") break;
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    parsedChunks += 1;

    if (json && typeof json === "object" && (json.error || json.message)) {
      const msg = normalizeString(extractErrorMessageFromJson(json)) || "upstream error";
      throw new Error(`Gemini(chat-stream) upstream error: ${msg}`.trim());
    }

    const candidates = Array.isArray(json?.candidates) ? json.candidates : [];
    const c0 = candidates[0] && typeof candidates[0] === "object" ? candidates[0] : null;
    const usage = extractGeminiUsageTokens(json);
    if (usage.usagePromptTokens != null) usagePromptTokens = usage.usagePromptTokens;
    if (usage.usageCompletionTokens != null) usageCompletionTokens = usage.usageCompletionTokens;
    if (usage.usageCacheReadInputTokens != null) usageCacheReadInputTokens = usage.usageCacheReadInputTokens;

    const stop = extractGeminiStopReasonFromCandidate(c0);
    if (stop.stopReasonSeen) {
      stopReasonSeen = true;
      stopReason = stop.stopReason;
    }

    const parts = Array.isArray(c0?.content?.parts) ? c0.content.parts : [];
    let chunkText = "";
    for (const p of parts) {
      if (!p || typeof p !== "object") continue;
      if (typeof p.text === "string" && p.text) {
        chunkText += p.text;
        continue;
      }
      const fc = p.functionCall && typeof p.functionCall === "object" ? p.functionCall : null;
      if (fc) {
        const toolName = normalizeString(fc.name);
        if (!toolName) continue;
        toolSeq += 1;
        const toolUseId = `tool-${sanitizeToolHint(toolName)}-${toolSeq}`;
        const inputJson = normalizeFunctionCallArgsToJsonString(fc.args ?? fc.arguments);
        const meta = getToolMeta(toolName);
        const built = buildToolUseChunks({ nodeId, toolUseId, toolName, inputJson, meta, supportToolUseStart });
        nodeId = built.nodeId;
        emittedChunks += built.chunks.length;
        for (const c of built.chunks) yield c;
        if (built.chunks.length) sawToolUse = true;
      }
    }

    if (chunkText) {
      let delta = chunkText;
      if (chunkText.startsWith(fullText)) {
        delta = chunkText.slice(fullText.length);
        fullText = chunkText;
      } else {
        fullText += chunkText;
      }
      if (delta) {
        nodeId += 1;
        emittedChunks += 1;
        yield makeBackChatChunk({ text: delta, nodes: [rawResponseNode({ id: nodeId, content: delta })] });
      }
    }
  }

  const hasUsage = usagePromptTokens != null || usageCompletionTokens != null || usageCacheReadInputTokens != null;
  if (emittedChunks === 0 && !hasUsage && !sawToolUse) {
    throw new Error(`Gemini(chat-stream) 未解析到任何上游 SSE 内容（data_events=${dataEvents}, parsed_chunks=${parsedChunks}）；请检查 baseUrl 是否为 Gemini SSE`.trim());
  }

  const usageBuilt = buildTokenUsageChunk({
    nodeId,
    inputTokens: usagePromptTokens,
    outputTokens: usageCompletionTokens,
    cacheReadInputTokens: usageCacheReadInputTokens
  });
  nodeId = usageBuilt.nodeId;
  if (usageBuilt.chunk) yield usageBuilt.chunk;

  const final = buildFinalChatChunk({ nodeId, fullText, stopReasonSeen, stopReason, sawToolUse });
  yield final.chunk;
}

module.exports = { geminiCompleteText, geminiStreamTextDeltas, geminiChatStreamChunks };
