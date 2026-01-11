import { parseSse } from "../common/sse";
import { buildAbortSignal, buildBearerAuthHeader, joinBaseUrl, safeFetch } from "../common/http";
import type { ByokStreamEvent } from "./stream-events";

export type OpenAiChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type OpenAiTool = { type: "function"; function: { name: string; description?: string; parameters: any } };
export type OpenAiToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type OpenAiChatCompleteWithToolsResult =
  | { kind: "final"; text: string }
  | { kind: "tool_calls"; toolCalls: OpenAiToolCall[]; assistantText: string };

function normalizeStop(v: unknown): string | string[] | undefined {
  if (typeof v === "string") return v.trim() ? v : undefined;
  if (!Array.isArray(v)) return undefined;
  const out = v.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean);
  return out.length ? out : undefined;
}

export async function openAiChatComplete({
  baseUrl,
  apiKey,
  model,
  messages,
  temperature,
  maxTokens,
  topP,
  presencePenalty,
  frequencyPenalty,
  stop,
  seed,
  extraHeaders,
  extraBody,
  timeoutMs,
  abortSignal
}: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: OpenAiChatMessage[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  stop?: string | string[];
  seed?: number;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, any>;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const url = joinBaseUrl(baseUrl, "chat/completions");
  if (!url) throw new Error("OpenAI baseUrl 无效");
  const auth = buildBearerAuthHeader(apiKey);
  if (!auth) throw new Error("OpenAI apiKey 未配置");

  const body: any = { ...(extraBody && typeof extraBody === "object" ? extraBody : null), model, messages, stream: false };
  if (typeof temperature === "number") body.temperature = temperature;
  if (typeof maxTokens === "number") body.max_tokens = maxTokens;
  if (typeof topP === "number") body.top_p = topP;
  if (typeof presencePenalty === "number") body.presence_penalty = presencePenalty;
  if (typeof frequencyPenalty === "number") body.frequency_penalty = frequencyPenalty;
  if (typeof seed === "number") body.seed = seed;
  const stopNorm = normalizeStop(stop);
  if (stopNorm) body.stop = stopNorm;

  const resp = await safeFetch(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...(extraHeaders || {}), authorization: auth },
      body: JSON.stringify(body),
      signal: buildAbortSignal(timeoutMs, abortSignal)
    },
    "OpenAI"
  );

  const text = await resp.text().catch(() => "");
  if (!resp.ok) throw new Error(`OpenAI 请求失败: ${resp.status} ${text.slice(0, 200)}`.trim());
  const json = text ? JSON.parse(text) : null;
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("OpenAI 响应缺少 choices[0].message.content");
  return content;
}

export async function openAiChatCompleteWithTools({
  baseUrl,
  apiKey,
  model,
  messages,
  tools,
  temperature,
  maxTokens,
  topP,
  presencePenalty,
  frequencyPenalty,
  stop,
  seed,
  extraHeaders,
  extraBody,
  timeoutMs,
  abortSignal
}: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: any[];
  tools: OpenAiTool[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  stop?: string | string[];
  seed?: number;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, any>;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}): Promise<OpenAiChatCompleteWithToolsResult> {
  const url = joinBaseUrl(baseUrl, "chat/completions");
  if (!url) throw new Error("OpenAI baseUrl 无效");
  const auth = buildBearerAuthHeader(apiKey);
  if (!auth) throw new Error("OpenAI apiKey 未配置");

  const body: any = { ...(extraBody && typeof extraBody === "object" ? extraBody : null), model, messages, tools, tool_choice: "auto", stream: false };
  if (typeof temperature === "number") body.temperature = temperature;
  if (typeof maxTokens === "number") body.max_tokens = maxTokens;
  if (typeof topP === "number") body.top_p = topP;
  if (typeof presencePenalty === "number") body.presence_penalty = presencePenalty;
  if (typeof frequencyPenalty === "number") body.frequency_penalty = frequencyPenalty;
  if (typeof seed === "number") body.seed = seed;
  const stopNorm = normalizeStop(stop);
  if (stopNorm) body.stop = stopNorm;

  const resp = await safeFetch(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...(extraHeaders || {}), authorization: auth },
      body: JSON.stringify(body),
      signal: buildAbortSignal(timeoutMs, abortSignal)
    },
    "OpenAI"
  );

  const text = await resp.text().catch(() => "");
  if (!resp.ok) throw new Error(`OpenAI 请求失败: ${resp.status} ${text.slice(0, 200)}`.trim());
  const json = text ? JSON.parse(text) : null;
  const msg = json?.choices?.[0]?.message;
  const toolCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls.filter((c: any) => c && typeof c.id === "string" && c.function && typeof c.function.name === "string") : [];
  if (toolCalls.length) return { kind: "tool_calls", toolCalls, assistantText: typeof msg?.content === "string" ? msg.content : "" };
  const content = msg?.content;
  if (typeof content !== "string") throw new Error("OpenAI 响应缺少 choices[0].message.content/tool_calls");
  return { kind: "final", text: content };
}

export async function* openAiChatStreamEvents({
  baseUrl,
  apiKey,
  model,
  messages,
  tools,
  temperature,
  maxTokens,
  topP,
  presencePenalty,
  frequencyPenalty,
  stop,
  seed,
  extraHeaders,
  extraBody,
  timeoutMs,
  abortSignal
}: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: any[];
  tools?: OpenAiTool[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  stop?: string | string[];
  seed?: number;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, any>;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}): AsyncGenerator<ByokStreamEvent> {
  const url = joinBaseUrl(baseUrl, "chat/completions");
  if (!url) throw new Error("OpenAI baseUrl 无效");
  const auth = buildBearerAuthHeader(apiKey);
  if (!auth) throw new Error("OpenAI apiKey 未配置");

  const body: any = { ...(extraBody && typeof extraBody === "object" ? extraBody : null), model, messages, stream: true };
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  if (typeof temperature === "number") body.temperature = temperature;
  if (typeof maxTokens === "number") body.max_tokens = maxTokens;
  if (typeof topP === "number") body.top_p = topP;
  if (typeof presencePenalty === "number") body.presence_penalty = presencePenalty;
  if (typeof frequencyPenalty === "number") body.frequency_penalty = frequencyPenalty;
  if (typeof seed === "number") body.seed = seed;
  const stopNorm = normalizeStop(stop);
  if (stopNorm) body.stop = stopNorm;

  const resp = await safeFetch(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...(extraHeaders || {}), authorization: auth },
      body: JSON.stringify(body),
      signal: buildAbortSignal(timeoutMs, abortSignal)
    },
    "OpenAI"
  );

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`OpenAI stream 请求失败: ${resp.status} ${text.slice(0, 200)}`.trim());
  }

  let reasoning = "";
  const toolCallsByIndex: Array<{ id: string; name: string; args: string }> = [];
  for await (const ev of parseSse(resp)) {
    const data = ev.data;
    if (!data) continue;
    if (data === "[DONE]") break;
    let json: any;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    const choice = json?.choices?.[0];
    const delta = choice?.delta;
    const r = typeof delta?.reasoning_content === "string" ? delta.reasoning_content : typeof delta?.reasoning === "string" ? delta.reasoning : "";
    if (r) reasoning += r;
    const toolCallsDelta = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
    for (const tc of toolCallsDelta) {
      const idxRaw = Number(tc?.index);
      const idx = Number.isFinite(idxRaw) && idxRaw >= 0 ? idxRaw : toolCallsByIndex.length;
      const cur = toolCallsByIndex[idx] || { id: "", name: "", args: "" };
      if (typeof tc?.id === "string") cur.id = tc.id;
      const fn = tc?.function;
      if (typeof fn?.name === "string") cur.name = fn.name;
      if (typeof fn?.arguments === "string") cur.args += fn.arguments;
      else if (fn?.arguments && typeof fn.arguments === "object") cur.args = JSON.stringify(fn.arguments);
      toolCallsByIndex[idx] = cur;
    }
    const chunk = typeof delta?.content === "string" ? delta.content : typeof delta?.text === "string" ? delta.text : "";
    if (chunk) yield { kind: "text", text: chunk };
  }
  if (reasoning.trim()) yield { kind: "thinking", summary: reasoning };
  const now = Date.now();
  for (let i = 0; i < toolCallsByIndex.length; i++) {
    const tc = toolCallsByIndex[i];
    if (!tc) continue;
    const toolName = typeof tc.name === "string" ? tc.name.trim() : "";
    if (!toolName) continue;
    const toolUseId = typeof tc.id === "string" && tc.id.trim() ? tc.id.trim() : `byok-tool-${now}-${i}`;
    const inputJson = typeof tc.args === "string" && tc.args.trim() ? tc.args : "{}";
    try {
      JSON.parse(inputJson);
    } catch {
      throw new Error(`Tool(${toolName}) arguments 不是合法 JSON: ${inputJson.slice(0, 200)}`);
    }
    yield { kind: "tool_use", toolUseId, toolName, inputJson };
  }
}

export async function* openAiChatStream(args: Parameters<typeof openAiChatStreamEvents>[0]): AsyncGenerator<string> {
  for await (const ev of openAiChatStreamEvents(args)) if (ev.kind === "text") yield ev.text;
}

export async function openAiListModels({
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
  if (!url) throw new Error("OpenAI baseUrl 无效");
  const auth = buildBearerAuthHeader(apiKey);
  if (!auth) throw new Error("OpenAI apiKey 未配置");

  const resp = await safeFetch(url, { method: "GET", headers: { authorization: auth }, signal: buildAbortSignal(timeoutMs, abortSignal) }, "OpenAI");
  const text = await resp.text().catch(() => "");
  if (!resp.ok) throw new Error(`OpenAI models 请求失败: ${resp.status} ${text.slice(0, 200)}`.trim());
  const json = text ? JSON.parse(text) : null;
  const data = Array.isArray(json?.data) ? json.data : null;
  if (!data) throw new Error("OpenAI models 响应缺少 data[]");
  const models = data.map((m: any) => (m && typeof m.id === "string" ? m.id : "")).filter(Boolean);
  models.sort();
  return models;
}
