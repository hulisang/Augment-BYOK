import { parseSse } from "../common/sse";
import { buildAbortSignal, buildBearerAuthHeader, joinBaseUrl, safeFetch } from "../common/http";

export type OpenAiChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type OpenAiTool = { type: "function"; function: { name: string; description?: string; parameters: any } };
export type OpenAiToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type OpenAiChatCompleteWithToolsResult =
  | { kind: "final"; text: string }
  | { kind: "tool_calls"; toolCalls: OpenAiToolCall[]; assistantText: string };

export async function openAiChatComplete({
  baseUrl,
  apiKey,
  model,
  messages,
  temperature,
  maxTokens,
  timeoutMs,
  abortSignal
}: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: OpenAiChatMessage[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const url = joinBaseUrl(baseUrl, "chat/completions");
  if (!url) throw new Error("OpenAI baseUrl 无效");
  const auth = buildBearerAuthHeader(apiKey);
  if (!auth) throw new Error("OpenAI apiKey 未配置");

  const body: any = { model, messages, stream: false };
  if (typeof temperature === "number") body.temperature = temperature;
  if (typeof maxTokens === "number") body.max_tokens = maxTokens;

  const resp = await safeFetch(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: auth },
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
  timeoutMs: number;
  abortSignal?: AbortSignal;
}): Promise<OpenAiChatCompleteWithToolsResult> {
  const url = joinBaseUrl(baseUrl, "chat/completions");
  if (!url) throw new Error("OpenAI baseUrl 无效");
  const auth = buildBearerAuthHeader(apiKey);
  if (!auth) throw new Error("OpenAI apiKey 未配置");

  const body: any = { model, messages, tools, tool_choice: "auto", stream: false };
  if (typeof temperature === "number") body.temperature = temperature;
  if (typeof maxTokens === "number") body.max_tokens = maxTokens;

  const resp = await safeFetch(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: auth },
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

export async function* openAiChatStream({
  baseUrl,
  apiKey,
  model,
  messages,
  temperature,
  maxTokens,
  timeoutMs,
  abortSignal
}: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: OpenAiChatMessage[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}): AsyncGenerator<string> {
  const url = joinBaseUrl(baseUrl, "chat/completions");
  if (!url) throw new Error("OpenAI baseUrl 无效");
  const auth = buildBearerAuthHeader(apiKey);
  if (!auth) throw new Error("OpenAI apiKey 未配置");

  const body: any = { model, messages, stream: true };
  if (typeof temperature === "number") body.temperature = temperature;
  if (typeof maxTokens === "number") body.max_tokens = maxTokens;

  const resp = await safeFetch(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: auth },
      body: JSON.stringify(body),
      signal: buildAbortSignal(timeoutMs, abortSignal)
    },
    "OpenAI"
  );

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`OpenAI stream 请求失败: ${resp.status} ${text.slice(0, 200)}`.trim());
  }

  for await (const ev of parseSse(resp)) {
    const data = ev.data;
    if (!data) continue;
    if (data === "[DONE]") return;
    let json: any;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    const choice = json?.choices?.[0];
    const delta = choice?.delta;
    const chunk = typeof delta?.content === "string" ? delta.content : typeof delta?.text === "string" ? delta.text : "";
    if (chunk) yield chunk;
  }
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
