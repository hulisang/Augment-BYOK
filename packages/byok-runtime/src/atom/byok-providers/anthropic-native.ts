import { parseSse } from "../common/sse";
import { buildAbortSignal, joinBaseUrl, normalizeRawToken, safeFetch, normalizeString } from "../common/http";
import type { ByokStreamEvent } from "./stream-events";

export type AnthropicMessage = { role: "user" | "assistant"; content: any };
export type AnthropicTool = { name: string; description?: string; input_schema: any };
export type AnthropicToolUse = { id: string; name: string; input: any };
export type AnthropicCompleteWithToolsResult =
  | { kind: "final"; text: string }
  | { kind: "tool_calls"; toolUses: AnthropicToolUse[]; assistantText: string; contentBlocks: any[] };

export async function anthropicCountTokens({
  baseUrl,
  apiKey,
  model,
  system,
  messages,
  tools,
  timeoutMs,
  abortSignal,
  extraHeaders,
  extraBody
}: {
  baseUrl: string;
  apiKey: string;
  model: string;
  system?: string | any[];
  messages: any[];
  tools?: any[];
  timeoutMs: number;
  abortSignal?: AbortSignal;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, any>;
}): Promise<number> {
  const url = joinBaseUrl(baseUrl, "messages/count_tokens");
  if (!url) throw new Error("Anthropic baseUrl 无效");
  const key = normalizeRawToken(apiKey);
  if (!key) throw new Error("Anthropic apiKey 未配置");

  const body: any = { ...(extraBody && typeof extraBody === "object" ? extraBody : null), model, messages };
  if (system != null) body.system = system;
  if (Array.isArray(tools) && tools.length) body.tools = tools;

  const resp = await safeFetch(
    url,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(extraHeaders || {}),
        "x-api-key": key,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(body),
      signal: buildAbortSignal(timeoutMs, abortSignal)
    },
    "Anthropic"
  );

  const text = await resp.text().catch(() => "");
  if (!resp.ok) throw new Error(`Anthropic count_tokens 请求失败: ${resp.status} ${text.slice(0, 200)}`.trim());
  const json = text ? JSON.parse(text) : null;
  const tokens = Number(json?.input_tokens);
  if (!Number.isFinite(tokens)) throw new Error("Anthropic count_tokens 响应缺少 input_tokens");
  return tokens;
}

export async function anthropicComplete({
  baseUrl,
  apiKey,
  model,
  system,
  messages,
  temperature,
  maxTokens,
  topP,
  topK,
  stopSequences,
  thinking,
  extraHeaders,
  extraBody,
  timeoutMs,
  abortSignal
}: {
  baseUrl: string;
  apiKey: string;
  model: string;
  system?: string | any[];
  messages: AnthropicMessage[];
  temperature?: number;
  maxTokens: number;
  topP?: number;
  topK?: number;
  stopSequences?: string[];
  thinking?: any;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, any>;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const url = joinBaseUrl(baseUrl, "messages");
  if (!url) throw new Error("Anthropic baseUrl 无效");
  const key = normalizeRawToken(apiKey);
  if (!key) throw new Error("Anthropic apiKey 未配置");

  const body: any = { ...(extraBody && typeof extraBody === "object" ? extraBody : null), model, max_tokens: maxTokens, messages, stream: false };
  if (system != null) body.system = system;
  if (typeof temperature === "number") body.temperature = temperature;
  if (typeof topP === "number") body.top_p = topP;
  if (typeof topK === "number") body.top_k = topK;
  if (Array.isArray(stopSequences) && stopSequences.length) body.stop_sequences = stopSequences.filter((x) => typeof x === "string" && x.trim());
  if (thinking != null) body.thinking = thinking;

  const resp = await safeFetch(
    url,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(extraHeaders || {}),
        "x-api-key": key,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(body),
      signal: buildAbortSignal(timeoutMs, abortSignal)
    },
    "Anthropic"
  );

  const text = await resp.text().catch(() => "");
  if (!resp.ok) throw new Error(`Anthropic 请求失败: ${resp.status} ${text.slice(0, 200)}`.trim());
  const json = text ? JSON.parse(text) : null;
  const blocks = Array.isArray(json?.content) ? json.content : [];
  const out = blocks.map((b: any) => (b && b.type === "text" && typeof b.text === "string" ? b.text : "")).join("");
  if (!out) throw new Error("Anthropic 响应缺少 content[].text");
  return out;
}

export async function anthropicCompleteWithTools({
  baseUrl,
  apiKey,
  model,
  system,
  messages,
  tools,
  temperature,
  maxTokens,
  topP,
  topK,
  stopSequences,
  thinking,
  extraHeaders,
  extraBody,
  timeoutMs,
  abortSignal
}: {
  baseUrl: string;
  apiKey: string;
  model: string;
  system?: string | any[];
  messages: any[];
  tools: AnthropicTool[];
  temperature?: number;
  maxTokens: number;
  topP?: number;
  topK?: number;
  stopSequences?: string[];
  thinking?: any;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, any>;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}): Promise<AnthropicCompleteWithToolsResult> {
  const url = joinBaseUrl(baseUrl, "messages");
  if (!url) throw new Error("Anthropic baseUrl 无效");
  const key = normalizeRawToken(apiKey);
  if (!key) throw new Error("Anthropic apiKey 未配置");

  const body: any = { ...(extraBody && typeof extraBody === "object" ? extraBody : null), model, max_tokens: maxTokens, messages, tools, stream: false };
  if (system != null) body.system = system;
  if (typeof temperature === "number") body.temperature = temperature;
  if (typeof topP === "number") body.top_p = topP;
  if (typeof topK === "number") body.top_k = topK;
  if (Array.isArray(stopSequences) && stopSequences.length) body.stop_sequences = stopSequences.filter((x) => typeof x === "string" && x.trim());
  if (thinking != null) body.thinking = thinking;

  const resp = await safeFetch(
    url,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(extraHeaders || {}),
        "x-api-key": key,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(body),
      signal: buildAbortSignal(timeoutMs, abortSignal)
    },
    "Anthropic"
  );

  const text = await resp.text().catch(() => "");
  if (!resp.ok) throw new Error(`Anthropic 请求失败: ${resp.status} ${text.slice(0, 200)}`.trim());
  const json = text ? JSON.parse(text) : null;
  const blocks = Array.isArray(json?.content) ? json.content : [];
  const assistantText = blocks.map((b: any) => (b && b.type === "text" && typeof b.text === "string" ? b.text : "")).join("");
  const toolUses = blocks
    .map((b: any) => (b && b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string" ? ({ id: b.id, name: b.name, input: b.input } as AnthropicToolUse) : null))
    .filter(Boolean) as AnthropicToolUse[];
  if (toolUses.length) return { kind: "tool_calls", toolUses, assistantText, contentBlocks: blocks };
  if (!assistantText) throw new Error("Anthropic 响应缺少 content[].text/tool_use");
  return { kind: "final", text: assistantText };
}

export async function* anthropicStreamEvents({
  baseUrl,
  apiKey,
  model,
  system,
  messages,
  tools,
  temperature,
  maxTokens,
  topP,
  topK,
  stopSequences,
  thinking,
  extraHeaders,
  extraBody,
  timeoutMs,
  abortSignal
}: {
  baseUrl: string;
  apiKey: string;
  model: string;
  system?: string | any[];
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  temperature?: number;
  maxTokens: number;
  topP?: number;
  topK?: number;
  stopSequences?: string[];
  thinking?: any;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, any>;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}): AsyncGenerator<ByokStreamEvent> {
  const url = joinBaseUrl(baseUrl, "messages");
  if (!url) throw new Error("Anthropic baseUrl 无效");
  const key = normalizeRawToken(apiKey);
  if (!key) throw new Error("Anthropic apiKey 未配置");

  const body: any = { ...(extraBody && typeof extraBody === "object" ? extraBody : null), model, max_tokens: maxTokens, messages, stream: true };
  if (system != null) body.system = system;
  if (Array.isArray(tools) && tools.length) body.tools = tools;
  if (typeof temperature === "number") body.temperature = temperature;
  if (typeof topP === "number") body.top_p = topP;
  if (typeof topK === "number") body.top_k = topK;
  if (Array.isArray(stopSequences) && stopSequences.length) body.stop_sequences = stopSequences.filter((x) => typeof x === "string" && x.trim());
  if (thinking != null) body.thinking = thinking;

  const resp = await safeFetch(
    url,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(extraHeaders || {}),
        "x-api-key": key,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(body),
      signal: buildAbortSignal(timeoutMs, abortSignal)
    },
    "Anthropic"
  );

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Anthropic stream 请求失败: ${resp.status} ${text.slice(0, 200)}`.trim());
  }

  let thinkingBuf = "";
  const toolUses: Array<{ toolUseId: string; toolName: string; inputJson: string }> = [];
  let toolUseId = "";
  let toolName = "";
  let toolInputBuf = "";
  for await (const ev of parseSse(resp)) {
    const data = ev.data;
    if (!data) continue;
    let json: any;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    if (json?.type === "content_block_delta" && json?.delta?.type === "thinking_delta" && typeof json?.delta?.thinking === "string") {
      thinkingBuf += json.delta.thinking;
    }
    if (json?.type === "content_block_start" && json?.content_block?.type === "tool_use") {
      toolUseId = normalizeString(json?.content_block?.id);
      toolName = normalizeString(json?.content_block?.name);
      const input = json?.content_block?.input;
      toolInputBuf = input && typeof input === "object" ? JSON.stringify(input) : "";
    }
    if (json?.type === "content_block_delta" && json?.delta?.type === "input_json_delta") {
      const part = json?.delta?.partial_json ?? json?.delta?.partialJson ?? json?.delta?.input_json ?? json?.delta?.inputJson;
      if (typeof part === "string") toolInputBuf += part;
    }
    if (json?.type === "content_block_stop" && toolName) {
      const now = Date.now();
      const id = toolUseId || `byok-tool-${now}-${toolUses.length}`;
      const inputJson = normalizeString(toolInputBuf) || "{}";
      try {
        JSON.parse(inputJson);
      } catch {
        throw new Error(`Tool(${toolName}) input_json 不是合法 JSON: ${inputJson.slice(0, 200)}`);
      }
      toolUses.push({ toolUseId: id, toolName, inputJson });
      toolUseId = "";
      toolName = "";
      toolInputBuf = "";
    }
    if (json?.type === "content_block_delta" && json?.delta?.type === "text_delta" && typeof json?.delta?.text === "string") yield { kind: "text", text: json.delta.text };
  }
  if (thinkingBuf.trim()) yield { kind: "thinking", summary: thinkingBuf };
  for (const tu of toolUses) yield { kind: "tool_use", toolUseId: tu.toolUseId, toolName: tu.toolName, inputJson: tu.inputJson };
}

export async function* anthropicStream(args: Parameters<typeof anthropicStreamEvents>[0]): AsyncGenerator<string> {
  for await (const ev of anthropicStreamEvents(args)) if (ev.kind === "text") yield ev.text;
}

export async function anthropicListModels({
  baseUrl,
  apiKey,
  timeoutMs,
  abortSignal
}: {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}): Promise<string[]> {
  const url = joinBaseUrl(baseUrl, "models");
  if (!url) throw new Error("Anthropic baseUrl 无效");
  const key = normalizeRawToken(apiKey);
  if (!key) throw new Error("Anthropic apiKey 未配置");

  const resp = await safeFetch(
    url,
    {
      method: "GET",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      signal: buildAbortSignal(timeoutMs, abortSignal)
    },
    "Anthropic"
  );

  const text = await resp.text().catch(() => "");
  if (!resp.ok) throw new Error(`Anthropic models 请求失败: ${resp.status} ${text.slice(0, 200)}`.trim());
  const json = text ? JSON.parse(text) : null;
  const data = Array.isArray(json?.data) ? json.data : null;
  if (!data) throw new Error("Anthropic models 响应缺少 data[]");
  const models = data.map((m: any) => (m && typeof m.id === "string" ? m.id : "")).filter(Boolean);
  models.sort();
  return models;
}
