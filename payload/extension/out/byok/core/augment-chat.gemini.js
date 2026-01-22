"use strict";

const { normalizeString } = require("../infra/util");
const { debug } = require("../infra/log");
const shared = require("./augment-chat.shared");
const { TOOL_RESULT_MISSING_MESSAGE } = require("./tool-pairing");
const { getChatHistoryAndRequestNodesForAPI } = require("./augment-history-summary");
const {
  REQUEST_NODE_TOOL_RESULT,
  RESPONSE_NODE_TOOL_USE,
  RESPONSE_NODE_TOOL_USE_START
} = require("./augment-protocol");

function buildGeminiUserParts(message, nodes) {
  return buildGeminiPartsFromSegments(shared.buildUserSegmentsFromRequest(message, nodes));
}

function buildGeminiPartsFromSegments(segments) {
  const parts = [];
  for (const s of shared.asArray(segments)) {
    if (!s || typeof s !== "object") continue;
    if (s.kind === "text") {
      const t = String(s.text || "");
      if (t.trim()) parts.push({ text: t });
    } else if (s.kind === "image") {
      const data = String(s.data || "").trim();
      if (!data) continue;
      const mimeType = normalizeString(s.media_type) || "image/png";
      parts.push({ inlineData: { mimeType, data } });
    }
  }
  return parts;
}

function tryParseJsonObject(text) {
  const raw = normalizeString(text);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
  } catch {}
  return null;
}

function buildMissingToolResultResponse({ toolUseId, toolName }) {
  return {
    error: "tool_result_missing",
    tool_use_id: String(toolUseId || ""),
    tool_name: String(toolName || ""),
    message: TOOL_RESULT_MISSING_MESSAGE
  };
}

function buildGeminiToolResultsParts(nodes, { toolNameByUseId, pendingById }) {
  const parts = [];
  let convertedOrphans = 0;
  let injectedMissing = 0;

  for (const node of shared.asArray(nodes)) {
    const r = shared.asRecord(node);
    if (shared.normalizeNodeType(r) !== REQUEST_NODE_TOOL_RESULT) continue;
    const tr = shared.asRecord(shared.pick(r, ["tool_result_node", "toolResultNode"]));
    const toolUseId = normalizeString(shared.pick(tr, ["tool_use_id", "toolUseId"]));
    if (!toolUseId) continue;

    const toolName = normalizeString(toolNameByUseId.get(toolUseId));
    const text = shared.summarizeToolResultText(shared.pick(tr, ["content"]), shared.pick(tr, ["content_nodes", "contentNodes"]));
    const isError = Boolean(shared.pick(tr, ["is_error", "isError"]));
    if (!toolName) {
      const header = `[orphan_tool_result tool_use_id=${toolUseId}]`;
      const body = text ? `${header}\n${text}` : header;
      parts.push({ text: body });
      convertedOrphans += 1;
      continue;
    }

    const parsed = tryParseJsonObject(text);
    const response = parsed ? { ...parsed } : { content: text };
    if (!("tool_use_id" in response)) response.tool_use_id = toolUseId;
    if (!("tool_name" in response)) response.tool_name = toolName;
    if (isError) response.error = true;
    parts.push({ functionResponse: { name: toolName, response } });
    if (pendingById && pendingById.has(toolUseId)) pendingById.delete(toolUseId);
  }

  if (pendingById && pendingById.size) {
    for (const [toolUseId, meta] of pendingById.entries()) {
      const toolName = normalizeString(meta?.toolName) || normalizeString(toolNameByUseId.get(toolUseId));
      if (!toolName) continue;
      parts.push({ functionResponse: { name: toolName, response: buildMissingToolResultResponse({ toolUseId, toolName }) } });
      injectedMissing += 1;
      pendingById.delete(toolUseId);
    }
  }

  return { parts, report: { injected_missing_tool_results: injectedMissing, converted_orphan_tool_results: convertedOrphans } };
}

function buildGeminiAssistantParts(text, outNodes, { toolNameByUseId, pendingById }) {
  const parts = [];
  const t = normalizeString(text);
  if (t) parts.push({ text: t });

  const nodes = shared.asArray(outNodes);
  const toolUse = [];
  const toolUseStart = [];
  for (const n of nodes) {
    const r = shared.asRecord(n);
    const nt = shared.normalizeNodeType(r);
    if (nt === RESPONSE_NODE_TOOL_USE) toolUse.push(r);
    else if (nt === RESPONSE_NODE_TOOL_USE_START) toolUseStart.push(r);
  }

  const chosen = toolUse.length ? toolUse : toolUseStart;
  const seen = new Set();
  for (const n of chosen) {
    const tu = shared.asRecord(shared.pick(n, ["tool_use", "toolUse"]));
    const toolUseId = normalizeString(shared.pick(tu, ["tool_use_id", "toolUseId"]));
    const toolName = normalizeString(shared.pick(tu, ["tool_name", "toolName"]));
    if (!toolUseId || !toolName || seen.has(toolUseId)) continue;
    seen.add(toolUseId);
    const inputJson = normalizeString(shared.pick(tu, ["input_json", "inputJson"])) || "{}";
    const args = shared.parseJsonObjectOrEmpty(inputJson);
    toolNameByUseId.set(toolUseId, toolName);
    if (pendingById) pendingById.set(toolUseId, { toolUseId, toolName, inputJson });
    parts.push({ functionCall: { name: toolName, args } });
  }

  return parts;
}

function buildGeminiContents(req) {
  const systemInstruction = shared.buildSystemPrompt(req);
  const contents = [];

  const { processedHistory, processedRequestNodes } = getChatHistoryAndRequestNodesForAPI(req);
  const history = shared.asArray(processedHistory);

  const toolNameByUseId = new Map();
  let repairedInjected = 0;
  let repairedOrphans = 0;

  for (let i = 0; i < history.length; i++) {
    const h = history[i];
    const reqNodesAll = shared.collectExchangeRequestNodes(h);
    const userParts = buildGeminiUserParts(h.request_message, reqNodesAll);
    if (userParts.length) contents.push({ role: "user", parts: userParts });

    const outNodes = shared.collectExchangeOutputNodes(h);
    const assistantText = normalizeString(h.response_text) ? h.response_text : shared.extractAssistantTextFromOutputNodes(outNodes);
    const pendingById = new Map();
    const assistantParts = buildGeminiAssistantParts(assistantText, outNodes, { toolNameByUseId, pendingById });
    if (assistantParts.length) contents.push({ role: "model", parts: assistantParts });

    const next = i + 1 < history.length ? history[i + 1] : null;
    if (next) {
      const { parts, report } = buildGeminiToolResultsParts(shared.collectExchangeRequestNodes(next), { toolNameByUseId, pendingById });
      repairedInjected += Number(report?.injected_missing_tool_results) || 0;
      repairedOrphans += Number(report?.converted_orphan_tool_results) || 0;
      if (parts.length) contents.push({ role: "user", parts });
    }
  }

  const pendingById = new Map();
  if (history.length) {
    const last = history[history.length - 1];
    const outNodes = shared.collectExchangeOutputNodes(last);
    // 只用来收集 pendingById：当前 request 的 tool_result 可能对应最后一条 assistant 的 tool_use
    buildGeminiAssistantParts("", outNodes, { toolNameByUseId, pendingById });
  }

  const currentNodesAll = shared.asArray(processedRequestNodes);
  const { parts: toolResultParts, report } = buildGeminiToolResultsParts(currentNodesAll, { toolNameByUseId, pendingById });
  repairedInjected += Number(report?.injected_missing_tool_results) || 0;
  repairedOrphans += Number(report?.converted_orphan_tool_results) || 0;
  if (toolResultParts.length) contents.push({ role: "user", parts: toolResultParts });

  const currentUserParts = buildGeminiPartsFromSegments(shared.buildUserSegmentsWithExtraText(req, currentNodesAll));
  if (currentUserParts.length) contents.push({ role: "user", parts: currentUserParts });

  if (repairedInjected || repairedOrphans) {
    debug(`gemini tool pairing repaired: injected_missing=${repairedInjected} converted_orphan=${repairedOrphans}`);
  }

  return { systemInstruction: normalizeString(systemInstruction) ? systemInstruction.trim() : "", contents };
}

module.exports = { buildGeminiContents };
