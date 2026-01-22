"use strict";

const { parseSse } = require("./sse");
const { normalizeString } = require("../infra/util");
const { normalizeUsageInt, makeToolMetaGetter, assertSseResponse } = require("./provider-util");
const { extractErrorMessageFromJson } = require("./request-util");
const { buildMinimalRetryRequestDefaults, postAnthropicWithFallbacks } = require("./anthropic-request");
const { stripAnthropicToolBlocksFromMessages, stripAnthropicImageBlocksFromMessages } = require("../core/anthropic-blocks");
const { extractTextFromAnthropicJson, emitAnthropicJsonAsAugmentChunks } = require("./anthropic-json-util");
const {
  STOP_REASON_END_TURN,
  STOP_REASON_TOOL_USE_REQUESTED,
  mapAnthropicStopReasonToAugment,
  rawResponseNode,
  toolUseStartNode,
  toolUseNode,
  thinkingNode,
  tokenUsageNode,
  mainTextFinishedNode,
  makeBackChatChunk
} = require("../core/augment-protocol");

async function anthropicCompleteText({ baseUrl, apiKey, model, system, messages, timeoutMs, abortSignal, extraHeaders, requestDefaults }) {
  const minimalDefaults = buildMinimalRetryRequestDefaults(requestDefaults);
  const resp = await postAnthropicWithFallbacks({
    baseLabel: "Anthropic",
    timeoutMs,
    abortSignal,
    attempts: [
      { labelSuffix: "", request: { baseUrl, apiKey, model, system, messages, tools: [], extraHeaders, requestDefaults, stream: false }, retryHint: "retry with minimal requestDefaults" },
      { labelSuffix: ":minimal-defaults", request: { baseUrl, apiKey, model, system, messages, tools: [], extraHeaders, requestDefaults: minimalDefaults, stream: false } }
    ]
  });

  const json = await resp.json().catch(() => null);
  const out = extractTextFromAnthropicJson(json);
  if (out) return out;

  const types = Array.isArray(json?.content)
    ? json.content
        .map((b) => normalizeString(b?.type) || "unknown")
        .filter(Boolean)
        .slice(0, 10)
        .join(",")
    : "";
  throw new Error(`Anthropic 响应缺少可解析文本（content_types=${types || "n/a"}）`.trim());
}

async function* anthropicStreamTextDeltas({ baseUrl, apiKey, model, system, messages, timeoutMs, abortSignal, extraHeaders, requestDefaults }) {
  const minimalDefaults = buildMinimalRetryRequestDefaults(requestDefaults);
  const resp = await postAnthropicWithFallbacks({
    baseLabel: "Anthropic(stream)",
    timeoutMs,
    abortSignal,
    attempts: [
      { labelSuffix: "", request: { baseUrl, apiKey, model, system, messages, tools: [], extraHeaders, requestDefaults, stream: true }, retryHint: "retry with minimal requestDefaults" },
      { labelSuffix: ":minimal-defaults", request: { baseUrl, apiKey, model, system, messages, tools: [], extraHeaders, requestDefaults: minimalDefaults, stream: true } }
    ]
  });

  const contentType = normalizeString(resp?.headers?.get?.("content-type")).toLowerCase();
  if (contentType.includes("json")) {
    const json = await resp.json().catch(() => null);
    const text = extractTextFromAnthropicJson(json);
    if (text) {
      yield text;
      return;
    }
    throw new Error(`Anthropic(stream) JSON 响应缺少可解析文本（content-type=${contentType || "unknown"}）`.trim());
  }

  await assertSseResponse(resp, { label: "Anthropic(stream)", expectedHint: "请确认 baseUrl 指向 Anthropic /messages SSE" });
  let dataEvents = 0;
  let parsedChunks = 0;
  let emitted = 0;
  for await (const ev of parseSse(resp)) {
    const data = normalizeString(ev?.data);
    if (!data) continue;
    dataEvents += 1;
    let json;
    try { json = JSON.parse(data); } catch { continue; }
    parsedChunks += 1;
    if (json && typeof json === "object" && (json.type === "error" || json.error)) {
      const msg = normalizeString(extractErrorMessageFromJson(json)) || "upstream error";
      throw new Error(`Anthropic(stream) upstream error: ${msg}`.trim());
    }
    if (json?.type === "message_stop") break;
    if (json?.type === "content_block_delta" && json.delta && json.delta.type === "text_delta" && typeof json.delta.text === "string") {
      const t = json.delta.text;
      if (t) { emitted += 1; yield t; }
    }
  }
  if (emitted === 0) throw new Error(`Anthropic(stream) 未解析到任何 SSE delta（data_events=${dataEvents}, parsed_chunks=${parsedChunks}）；请检查 baseUrl 是否为 Anthropic SSE`.trim());
}

async function* anthropicChatStreamChunks({ baseUrl, apiKey, model, system, messages, tools, timeoutMs, abortSignal, extraHeaders, requestDefaults, toolMetaByName, supportToolUseStart }) {
  const minimalDefaults = buildMinimalRetryRequestDefaults(requestDefaults);
  const strippedMessages = stripAnthropicToolBlocksFromMessages(messages, { maxToolTextLen: 8000 });
  const strippedNoImageMessages = stripAnthropicImageBlocksFromMessages(strippedMessages);
  const resp = await postAnthropicWithFallbacks({
    baseLabel: "Anthropic(chat-stream)",
    timeoutMs,
    abortSignal,
    attempts: [
      {
        labelSuffix: "",
        request: { baseUrl, apiKey, model, system, messages, tools, extraHeaders, requestDefaults, stream: true, includeToolChoice: true },
        retryHint: "retry without tool_choice"
      },
      {
        labelSuffix: ":no-tool-choice",
        request: { baseUrl, apiKey, model, system, messages, tools, extraHeaders, requestDefaults, stream: true, includeToolChoice: false },
        retryHint: "retry without tools + strip tool blocks"
      },
      {
        labelSuffix: ":no-tools",
        request: { baseUrl, apiKey, model, system, messages: strippedNoImageMessages, tools: [], extraHeaders, requestDefaults: minimalDefaults, stream: true }
      }
    ]
  });

  const contentType = normalizeString(resp?.headers?.get?.("content-type")).toLowerCase();
  if (contentType.includes("json")) {
    const json = await resp.json().catch(() => null);
    yield* emitAnthropicJsonAsAugmentChunks(json, { toolMetaByName, supportToolUseStart });
    return;
  }

  await assertSseResponse(resp, { label: "Anthropic(chat-stream)", expectedHint: "请确认 baseUrl 指向 Anthropic /messages SSE" });

  const getToolMeta = makeToolMetaGetter(toolMetaByName);

  let nodeId = 0;
  let fullText = "";
  let stopReason = null;
  let stopReasonSeen = false;
  let sawToolUse = false;
  let usageInputTokens = null;
  let usageOutputTokens = null;
  let usageCacheReadInputTokens = null;
  let usageCacheCreationInputTokens = null;
  let currentBlockType = "";
  let toolUseId = "";
  let toolName = "";
  let toolInputJson = "";
  let thinkingBuf = "";
  let dataEvents = 0;
  let parsedChunks = 0;
  let emittedChunks = 0;

  for await (const ev of parseSse(resp)) {
    const data = normalizeString(ev?.data);
    if (!data) continue;
    dataEvents += 1;
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    parsedChunks += 1;
    const eventType = normalizeString(json?.type) || normalizeString(ev?.event);

    const usage = (json?.message && typeof json.message === "object" ? json.message.usage : null) || json?.usage;
    if (usage && typeof usage === "object") {
      const it = normalizeUsageInt(usage.input_tokens);
      const ot = normalizeUsageInt(usage.output_tokens);
      const cr = normalizeUsageInt(usage.cache_read_input_tokens);
      const cc = normalizeUsageInt(usage.cache_creation_input_tokens);
      if (it != null) usageInputTokens = it;
      if (ot != null) usageOutputTokens = ot;
      if (cr != null) usageCacheReadInputTokens = cr;
      if (cc != null) usageCacheCreationInputTokens = cc;
    }

    if (eventType === "content_block_start") {
      const block = json?.content_block && typeof json.content_block === "object" ? json.content_block : null;
      currentBlockType = normalizeString(block?.type);
      if (currentBlockType === "tool_use") {
        toolUseId = normalizeString(block?.id);
        toolName = normalizeString(block?.name);
        toolInputJson = "";
      } else if (currentBlockType === "thinking") {
        thinkingBuf = "";
      }
      continue;
    }

    if (eventType === "content_block_delta") {
      const delta = json?.delta && typeof json.delta === "object" ? json.delta : null;
      const dt = normalizeString(delta?.type);
      if (dt === "text_delta" && typeof delta?.text === "string" && delta.text) {
        const t = delta.text;
        fullText += t;
        nodeId += 1;
        emittedChunks += 1;
        yield makeBackChatChunk({ text: t, nodes: [rawResponseNode({ id: nodeId, content: t })] });
      } else if (dt === "input_json_delta" && typeof delta?.partial_json === "string" && delta.partial_json) {
        toolInputJson += delta.partial_json;
      } else if (dt === "thinking_delta" && typeof delta?.thinking === "string" && delta.thinking) {
        thinkingBuf += delta.thinking;
      }
      continue;
    }

    if (eventType === "content_block_stop") {
      if (currentBlockType === "thinking") {
        const summary = normalizeString(thinkingBuf);
        if (summary) {
          nodeId += 1;
          emittedChunks += 1;
          yield makeBackChatChunk({ text: "", nodes: [thinkingNode({ id: nodeId, summary })] });
        }
        thinkingBuf = "";
      }
      if (currentBlockType === "tool_use") {
        const name = normalizeString(toolName);
        let id = normalizeString(toolUseId);
        if (name) {
          if (!id) id = `tool-${nodeId + 1}`;
          const inputJson = normalizeString(toolInputJson) || "{}";
          const meta = getToolMeta(name);
          sawToolUse = true;
          if (supportToolUseStart === true) {
            nodeId += 1;
            emittedChunks += 1;
            yield makeBackChatChunk({ text: "", nodes: [toolUseStartNode({ id: nodeId, toolUseId: id, toolName: name, inputJson, mcpServerName: meta.mcpServerName, mcpToolName: meta.mcpToolName })] });
          }
          nodeId += 1;
          emittedChunks += 1;
          yield makeBackChatChunk({ text: "", nodes: [toolUseNode({ id: nodeId, toolUseId: id, toolName: name, inputJson, mcpServerName: meta.mcpServerName, mcpToolName: meta.mcpToolName })] });
        }
        toolUseId = "";
        toolName = "";
        toolInputJson = "";
      }
      currentBlockType = "";
      continue;
    }

    if (eventType === "message_delta") {
      const delta = json?.delta && typeof json.delta === "object" ? json.delta : null;
      const sr = normalizeString(delta?.stop_reason);
      if (sr) {
        stopReasonSeen = true;
        stopReason = mapAnthropicStopReasonToAugment(sr);
      }
      continue;
    }

    if (eventType === "message_stop") break;
    if (eventType === "error") {
      const msg = normalizeString(extractErrorMessageFromJson(json)) || "upstream error event";
      throw new Error(`Anthropic(chat-stream) upstream error event: ${msg}`.trim());
    }
  }

  if (currentBlockType === "thinking") {
    const summary = normalizeString(thinkingBuf);
    if (summary) {
      nodeId += 1;
      emittedChunks += 1;
      yield makeBackChatChunk({ text: "", nodes: [thinkingNode({ id: nodeId, summary })] });
    }
  }

  const hasUsage = usageInputTokens != null || usageOutputTokens != null || usageCacheReadInputTokens != null || usageCacheCreationInputTokens != null;
  if (emittedChunks === 0 && !hasUsage && !sawToolUse) {
    throw new Error(`Anthropic(chat-stream) 未解析到任何上游 SSE 内容（data_events=${dataEvents}, parsed_chunks=${parsedChunks}）；请检查 baseUrl 是否为 Anthropic /messages SSE`);
  }

  if (hasUsage) {
    nodeId += 1;
    yield makeBackChatChunk({ text: "", nodes: [tokenUsageNode({ id: nodeId, inputTokens: usageInputTokens, outputTokens: usageOutputTokens, cacheReadInputTokens: usageCacheReadInputTokens, cacheCreationInputTokens: usageCacheCreationInputTokens })] });
  }

  const finalNodes = [];
  if (fullText) {
    nodeId += 1;
    finalNodes.push(mainTextFinishedNode({ id: nodeId, content: fullText }));
  }

  const stop_reason = stopReasonSeen && stopReason != null ? stopReason : sawToolUse ? STOP_REASON_TOOL_USE_REQUESTED : STOP_REASON_END_TURN;
  yield makeBackChatChunk({ text: "", nodes: finalNodes, stop_reason });
}

module.exports = { anthropicCompleteText, anthropicStreamTextDeltas, anthropicChatStreamChunks };
