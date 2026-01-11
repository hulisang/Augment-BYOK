import { loadByokConfigRaw, loadByokConfigResolved } from "../../mol/byok-storage/byok-config";
import { getCachedProviderModels, getCachedUpstreamGetModels, saveCachedUpstreamGetModels } from "../../mol/byok-storage/byok-cache";
import { AUGMENT_BYOK } from "../../constants";
import type { ByokResolvedConfigV2, ByokResolvedProvider, ByokRoutingRule } from "../../types";
import { buildAbortSignal, buildBearerAuthHeader, joinBaseUrl, normalizeEndpoint, normalizeString } from "../../atom/common/http";
import { asRecord } from "../../atom/common/object";
import { anthropicComplete, anthropicStreamEvents, type AnthropicTool } from "../../atom/byok-providers/anthropic-native";
import { codexChatStreamEventsWithTools, codexResponsesCompleteText, codexResponsesStreamEvents } from "../../atom/byok-providers/codex-native";
import { geminiCliCompleteText, geminiCliStreamEvents } from "../../atom/byok-providers/gemini-cli";
import type { ByokStreamEvent } from "../../atom/byok-providers/stream-events";
import { openAiChatComplete, openAiChatStreamEvents, type OpenAiTool } from "../../atom/byok-providers/openai-compatible";

const BYOK_REQUEST_TIMEOUT_MS = 120_000;
const BYOK_MODELS_TIMEOUT_MS = 12_000;
const UPSTREAM_GET_MODELS_CACHE_MAX_AGE_MS = 10 * 60_000;

function tryParseJsonObject(v: unknown): Record<string, any> | null {
  if (!v) return null;
  if (typeof v === "object") return v as Record<string, any>;
  if (typeof v !== "string") return null;
  try {
    const parsed = JSON.parse(v);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, any>) : null;
  } catch {
    return null;
  }
}

function snakeToCamelKey(k: string): string {
  if (!k.includes("_")) return k;
  return k.replace(/_([a-z0-9])/g, (_, c) => String(c).toUpperCase());
}

function withCamelAliases(flags: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...flags };
  for (const [k, v] of Object.entries(flags)) {
    const ck = snakeToCamelKey(k);
    if (ck !== k && !Object.prototype.hasOwnProperty.call(out, ck)) out[ck] = v;
  }
  return out;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal || !signal.aborted) return;
  const reason = (signal as any).reason;
  const msg = typeof reason === "string" && reason.trim() ? reason.trim() : "Aborted";
  const DomExceptionCtor = (globalThis as any).DOMException;
  if (typeof DomExceptionCtor === "function") throw new DomExceptionCtor(msg, "AbortError");
  const err: any = new Error(msg);
  err.name = "AbortError";
  throw err;
}

async function fetchAugmentGetModels({
  baseUrl,
  token,
  timeoutMs,
  abortSignal
}: {
  baseUrl: string;
  token: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}): Promise<any> {
  const url = joinBaseUrl(baseUrl, "get-models");
  if (!url) throw new Error("Augment baseUrl 无效");
  const auth = buildBearerAuthHeader(token);

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth) headers.authorization = auth;
  let resp: Response;
  try {
    resp = await fetch(url, { method: "POST", headers, body: "{}", signal: buildAbortSignal(timeoutMs, abortSignal) });
  } catch (err) {
    if (err && typeof err === "object" && (err as any).name === "AbortError") throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`get-models fetch 失败: ${msg} (url=${url})`);
  }
  const text = await resp.text().catch(() => "");
  if (!resp.ok) throw new Error(`get-models 请求失败: ${resp.status} ${text.slice(0, 200)}`.trim());
  const json = text ? JSON.parse(text) : null;
  if (!json || typeof json !== "object") throw new Error("get-models 响应不是 JSON 对象");
  return json;
}

function isChatEndpoint(endpoint: string): boolean {
  return endpoint === "chat" || endpoint === "chat-stream";
}

function getRoutingRule(cfg: ByokResolvedConfigV2, endpoint: string): ByokRoutingRule | null {
  const rules = cfg.routing?.rules && typeof cfg.routing.rules === "object" ? cfg.routing.rules : null;
  const v = rules && typeof (rules as any)[endpoint] === "object" ? (rules as any)[endpoint] : null;
  return v ? (v as ByokRoutingRule) : null;
}

function throwIfDisabledEndpoint(cfg: ByokResolvedConfigV2, endpoint: string): void {
  const rule = getRoutingRule(cfg, endpoint);
  if (rule?.enabled === false) throw new Error(`BYOK 已禁用的 endpoint: ${endpoint}`);
}

function parseByokModelId(model: string): { providerId: string; modelId: string } | null {
  const raw = normalizeString(model);
  if (!raw.startsWith("byok:")) return null;
  const rest = raw.slice("byok:".length);
  const idx = rest.indexOf(":");
  if (idx <= 0 || idx >= rest.length - 1) throw new Error(`BYOK modelId 格式错误：${raw}`);
  const providerId = rest.slice(0, idx);
  const modelId = rest.slice(idx + 1);
  if (!providerId || !modelId) throw new Error(`BYOK modelId 格式错误：${raw}`);
  return { providerId, modelId };
}

function pickActiveProvider(cfg: ByokResolvedConfigV2): ByokResolvedProvider {
  const providerId = normalizeString(cfg.routing?.activeProviderId) || normalizeString(cfg.providers[0]?.id);
  const p = (providerId && cfg.providers.find((x) => x.id === providerId)) || cfg.providers[0];
  if (!p) throw new Error("未配置任何 Provider");
  return p;
}

function getProviderById(cfg: ByokResolvedConfigV2, providerId: string): ByokResolvedProvider {
  const pid = normalizeString(providerId);
  const p = cfg.providers.find((x) => x.id === pid);
  if (!p) throw new Error(`未找到 Provider: ${pid}`);
  return p;
}

function resolveProviderAndModel(cfg: ByokResolvedConfigV2, endpoint: string, requestModel: string): { provider: ByokResolvedProvider; model: string } {
  const rule = getRoutingRule(cfg, endpoint);

  if (isChatEndpoint(endpoint)) {
    const parsed = normalizeString(requestModel) ? parseByokModelId(requestModel) : null;
    if (parsed) return { provider: getProviderById(cfg, parsed.providerId), model: parsed.modelId };
    const provider = pickActiveProvider(cfg);
    const model = normalizeString(provider.defaultModel);
    if (!model) throw new Error(`Provider(${provider.id}) 缺少 defaultModel（chat 未选择 byok model）`);
    return { provider, model };
  }

  const routedModel = normalizeString(rule?.model);
  if (routedModel) {
    const parsed = parseByokModelId(routedModel);
    if (parsed) return { provider: getProviderById(cfg, parsed.providerId), model: parsed.modelId };
  }

  const providerId = normalizeString(rule?.providerId);
  const provider = providerId ? getProviderById(cfg, providerId) : pickActiveProvider(cfg);
  if (routedModel) return { provider, model: routedModel };

  const model = normalizeString(provider.defaultModel);
  if (!model) throw new Error(`Provider(${provider.id}) 缺少 defaultModel（routing.rules[${endpoint}].model 为空且 defaultModel 未配置）`);
  return { provider, model };
}

function buildSystemText(body: Record<string, any>): string {
  const parts: string[] = [];
  const pushLines = (label: string, v: any) => {
    if (typeof v === "string" && v.trim()) parts.push(`${label}:\n${v.trim()}`);
    else if (Array.isArray(v) && v.length) parts.push(`${label}:\n${v.map((x) => String(x)).join("\n")}`);
  };
  pushLines("User Guidelines", body.user_guidelines);
  pushLines("Workspace Guidelines", body.workspace_guidelines);
  pushLines("Rules", body.rules);
  return parts.join("\n\n").trim();
}

function buildUserText(body: Record<string, any>): string {
  const parts: string[] = [];
  const add = (label: string, v: any) => {
    const s = typeof v === "string" ? v : v == null ? "" : String(v);
    if (!s.trim()) return;
    parts.push(`${label}:\n${s.trim()}`);
  };
  add("Path", body.path);
  add("Language", body.lang);
  add("Instruction", body.instruction);
  add("Message", body.message);
  add("Prompt", body.prompt);
  add("Prefix", body.prefix);
  add("Selected Text", body.selected_text ?? body.selected_code);
  add("Suffix", body.suffix);
  add("Diff", body.diff);
  return parts.join("\n\n").trim();
}

function stripMarkdownFences(text: string): string {
  const t = normalizeString(text);
  if (!t) return "";
  const m = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return normalizeString(m ? m[1] : t);
}

function parseJsonFromModelTextOrThrow(text: string): any {
  const raw = stripMarkdownFences(text);
  if (!raw) throw new Error("模型返回空文本");
  try {
    return JSON.parse(raw);
  } catch {
    const s = raw.indexOf("{");
    const e = raw.lastIndexOf("}");
    if (s >= 0 && e > s) {
      try {
        return JSON.parse(raw.slice(s, e + 1));
      } catch {
        // fall through
      }
    }
    throw new Error(`模型返回的 JSON 无法解析: ${raw.replace(/\s+/g, " ").slice(0, 200)}`.trim());
  }
}

function truncateInlineText(v: unknown, maxLen: number): string {
  const s = normalizeString(v);
  if (!s) return "";
  const oneLine = s.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, maxLen) + "…";
}

function formatNextEditEventsForPrompt(v: unknown, { maxFiles = 6, maxEditsPerFile = 6 }: { maxFiles?: number; maxEditsPerFile?: number } = {}): string {
  const events = Array.isArray(v) ? v : [];
  const lines: string[] = [];
  for (const ev of events.slice(0, maxFiles)) {
    const r = (asRecord(ev) as any) || {};
    const p = truncateInlineText(r.path, 200) || "(unknown)";
    const edits = Array.isArray(r.edits) ? r.edits : [];
    lines.push(`- file: ${p} edits=${edits.length}`);
    for (const ed of edits.slice(0, maxEditsPerFile)) {
      const e = (asRecord(ed) as any) || {};
      const afterStart = Number(e.after_start);
      const beforeStart = Number(e.before_start);
      const afterStr = Number.isFinite(afterStart) ? String(afterStart) : "?";
      const beforeStr = Number.isFinite(beforeStart) ? String(beforeStart) : "?";
      const beforeText = truncateInlineText(e.before_text, 200);
      const afterText = truncateInlineText(e.after_text, 200);
      lines.push(`  - edit: after_start=${afterStr} before_start=${beforeStr} before="${beforeText}" after="${afterText}"`);
    }
  }
  return lines.join("\n").trim();
}

function normalizeNextEditLocationCandidates(v: unknown, { fallbackPath, maxCount }: { fallbackPath: string; maxCount: number }): any[] {
  const raw = Array.isArray(v) ? v : [];
  const out: any[] = [];
  for (const c of raw) {
    const r = (asRecord(c) as any) || {};
    const item = (asRecord(r.item) as any) || {};
    const range = (asRecord(item.range) as any) || {};
    const path = normalizeString(item.path) || fallbackPath;
    const start = Number(range.start);
    const stop = Number(range.stop);
    if (!path) continue;
    if (!Number.isFinite(start) || start < 0) continue;
    if (!Number.isFinite(stop) || stop <= start) continue;
    const score = Number(r.score);
    const debug_info = truncateInlineText(r.debug_info ?? r.debugInfo, 200);
    out.push({ item: { path, range: { start, stop } }, score: Number.isFinite(score) ? score : 0, debug_info });
    if (out.length >= maxCount) break;
  }
  return out;
}

function getChatHistory(body: Record<string, any>): any[] {
  const v = body.chat_history ?? body.chatHistory;
  return Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : [];
}

type ToolUseLike = { toolUseId: string; toolName: string; inputJson: string };
type ToolResultLike = { toolUseId: string; content: string; isError: boolean };

function getRequestNodes(body: Record<string, any>): any[] {
  return Array.isArray(body.nodes) ? body.nodes.filter((x) => x && typeof x === "object") : [];
}

function getExchangeUserText(ex: Record<string, any>): string {
  return normalizeString(ex.request_message ?? ex.requestMessage ?? ex.message ?? "");
}

function getExchangeAssistantText(ex: Record<string, any>): string {
  return normalizeString(ex.response_text ?? ex.responseText ?? ex.response ?? ex.text ?? "");
}

function getExchangeRequestNodes(ex: Record<string, any>): any[] {
  const v =
    ex.structured_request_nodes ??
    ex.structuredRequestNodes ??
    ex.request_nodes ??
    ex.requestNodes ??
    ex.nodes ??
    ex.request_node ??
    ex.requestNode;
  return Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : [];
}

function getExchangeOutputNodes(ex: Record<string, any>): any[] {
  const v = ex.structured_output_nodes ?? ex.structuredOutputNodes ?? ex.response_nodes ?? ex.responseNodes;
  return Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : [];
}

function normalizeIsErrorFlag(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return ["true", "1", "yes"].includes(v.trim().toLowerCase());
  return false;
}

function extractToolResultsFromRequestNodes(nodes: any[]): ToolResultLike[] {
  const out: ToolResultLike[] = [];
  for (const n of nodes) {
    const r = (asRecord(n) as any) || {};
    if (Number(r.type) !== 1) continue;
    const tr = (asRecord(r.tool_result_node) as any) || {};
    const toolUseId = normalizeString(tr.tool_use_id ?? tr.toolUseId);
    if (!toolUseId) continue;
    out.push({ toolUseId, content: normalizeString(tr.content), isError: normalizeIsErrorFlag(tr.is_error ?? tr.isError) });
  }
  return out;
}

function extractToolUsesFromOutputNodes(nodes: any[]): ToolUseLike[] {
  const out: ToolUseLike[] = [];
  for (const n of nodes) {
    const r = (asRecord(n) as any) || {};
    const t = Number(r.type);
    if (t !== 5 && t !== 7) continue;
    const tu = (asRecord(r.tool_use) as any) || {};
    const toolUseId = normalizeString(tu.tool_use_id ?? tu.toolUseId);
    const toolName = normalizeString(tu.tool_name ?? tu.toolName);
    const inputJson = normalizeString(tu.input_json ?? tu.inputJson) || "{}";
    if (!toolUseId || !toolName) continue;
    out.push({ toolUseId, toolName, inputJson });
  }
  return out;
}

function buildOpenAiMessagesForToolCalling({
  system,
  chatHistory,
  currentUserText,
  currentRequestNodes
}: {
  system: string;
  chatHistory: any[];
  currentUserText: string;
  currentRequestNodes: any[];
}): any[] {
  const messages: any[] = [];
  if (system) messages.push({ role: "system", content: system });
  for (const ex of chatHistory) {
    const r = (asRecord(ex) as any) || {};
    const userText = getExchangeUserText(r);
    const assistantText = getExchangeAssistantText(r);
    const toolUses = extractToolUsesFromOutputNodes(getExchangeOutputNodes(r));
    const toolResults = extractToolResultsFromRequestNodes(getExchangeRequestNodes(r));

    if (userText) messages.push({ role: "user", content: userText });
    if (toolUses.length) {
      messages.push({
        role: "assistant",
        content: assistantText || "",
        tool_calls: toolUses.map((tu) => ({ id: tu.toolUseId, type: "function", function: { name: tu.toolName, arguments: tu.inputJson } }))
      });
    } else if (assistantText) {
      messages.push({ role: "assistant", content: assistantText });
    }
    for (const tr of toolResults) messages.push({ role: "tool", tool_call_id: tr.toolUseId, content: tr.content });
  }
  if (currentUserText) messages.push({ role: "user", content: currentUserText });
  for (const tr of extractToolResultsFromRequestNodes(currentRequestNodes)) messages.push({ role: "tool", tool_call_id: tr.toolUseId, content: tr.content });
  return messages;
}

function parseJsonObjectOrThrow({ label, json }: { label: string; json: string }): Record<string, any> {
  const raw = normalizeString(json) || "{}";
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, any>;
  } catch {
    // fall through
  }
  throw new Error(`${label} 不是合法 JSON 对象: ${raw.replace(/\s+/g, " ").slice(0, 200)}`.trim());
}

function buildAnthropicMessagesForToolCalling({
  chatHistory,
  currentUserText,
  currentRequestNodes
}: {
  chatHistory: any[];
  currentUserText: string;
  currentRequestNodes: any[];
}): any[] {
  const messages: any[] = [];
  const pushUser = ({ text, toolResults }: { text: string; toolResults: ToolResultLike[] }) => {
    const blocks: any[] = [];
    if (text) blocks.push({ type: "text", text });
    for (const tr of toolResults) blocks.push({ type: "tool_result", tool_use_id: tr.toolUseId, content: tr.content, is_error: tr.isError });
    if (blocks.length === 0) return;
    messages.push({ role: "user", content: blocks.length === 1 && blocks[0].type === "text" ? blocks[0].text : blocks });
  };
  const pushAssistant = ({ text, toolUses }: { text: string; toolUses: ToolUseLike[] }) => {
    if (!toolUses.length) {
      if (text) messages.push({ role: "assistant", content: text });
      return;
    }
    const blocks: any[] = [];
    if (text) blocks.push({ type: "text", text });
    for (const tu of toolUses) blocks.push({ type: "tool_use", id: tu.toolUseId, name: tu.toolName, input: parseJsonObjectOrThrow({ label: `Tool(${tu.toolName}) input_json`, json: tu.inputJson }) });
    messages.push({ role: "assistant", content: blocks });
  };
  for (const ex of chatHistory) {
    const r = (asRecord(ex) as any) || {};
    pushUser({ text: getExchangeUserText(r), toolResults: extractToolResultsFromRequestNodes(getExchangeRequestNodes(r)) });
    pushAssistant({ text: getExchangeAssistantText(r), toolUses: extractToolUsesFromOutputNodes(getExchangeOutputNodes(r)) });
  }
  pushUser({ text: currentUserText, toolResults: extractToolResultsFromRequestNodes(currentRequestNodes) });
  return messages;
}

function getToolDefinitions(body: Record<string, any>): any[] {
  const defs = Array.isArray(body.tool_definitions) ? body.tool_definitions : Array.isArray(body.toolDefinitions) ? body.toolDefinitions : [];
  return defs.filter((d) => d && typeof d === "object" && typeof (d as any).name === "string");
}

function parseToolInputSchema(toolDef: any): Record<string, any> {
  const name = normalizeString(toolDef?.name);
  const raw = normalizeString(toolDef?.input_schema_json);
  if (!raw) return { type: "object", properties: {} };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, any>;
  } catch {
    // ignore
  }
  throw new Error(`Tool(${name || "unknown"}) input_schema_json 不是合法 JSON 对象`);
}

function toOpenAiTools(toolDefs: any[]): OpenAiTool[] {
  return toolDefs.map((d) => ({
    type: "function",
    function: { name: normalizeString(d.name), description: normalizeString(d.description) || undefined, parameters: parseToolInputSchema(d) }
  }));
}

function toAnthropicTools(toolDefs: any[]): AnthropicTool[] {
  return toolDefs.map((d) => ({ name: normalizeString(d.name), description: normalizeString(d.description) || undefined, input_schema: parseToolInputSchema(d) }));
}

function toolUseNode({ id, toolUseId, toolName, inputJson }: { id: number; toolUseId: string; toolName: string; inputJson: string }): any {
  return { id, type: 5, tool_use: { tool_use_id: toolUseId, tool_name: toolName, input_json: inputJson } };
}

function thinkingNode({ id, summary }: { id: number; summary: string }): any {
  return { id, type: 8, thinking: { summary } };
}

async function completeText({
  provider,
  model,
  system,
  user,
  temperature,
  maxTokens,
  timeoutMs,
  abortSignal
}: {
  provider: ByokResolvedProvider;
  model?: string;
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const m = normalizeString(model) || normalizeString(provider.defaultModel);
  if (!m) throw new Error(`Provider(${provider.id}) 缺少 model（defaultModel 未配置且请求未指定 model）`);
  const apiKey = normalizeString(provider.secrets.apiKey || provider.secrets.token || "");
  const extraHeaders = provider.headers;
  const extraBody = provider.requestDefaults;

  if (provider.type === "openai_compatible") {
    const baseUrl = normalizeString(provider.baseUrl);
    if (!baseUrl) throw new Error(`Provider(${provider.id}) 缺少 baseUrl`);
    if (!apiKey) throw new Error(`Provider(${provider.id}) 缺少 apiKey/token`);
    return await openAiChatComplete({
      baseUrl,
      apiKey,
      model: m,
      messages: system ? [{ role: "system", content: system }, { role: "user", content: user }] : [{ role: "user", content: user }],
      temperature,
      maxTokens,
      extraHeaders,
      extraBody,
      timeoutMs,
      abortSignal
    });
  }

  if (provider.type === "openai_native") {
    const baseUrl = normalizeString(provider.baseUrl);
    if (!baseUrl) throw new Error(`Provider(${provider.id}) 缺少 baseUrl`);
    if (!apiKey) throw new Error(`Provider(${provider.id}) 缺少 apiKey/token`);
    const prompt = system ? `${system}\n\n${user}` : user;
    return await codexResponsesCompleteText({ baseUrl, apiKey, model: m, prompt, extraHeaders, extraBody, timeoutMs, abortSignal });
  }

  if (provider.type === "anthropic_native") {
    const baseUrl = normalizeString(provider.baseUrl);
    if (!baseUrl) throw new Error(`Provider(${provider.id}) 缺少 baseUrl`);
    if (!apiKey) throw new Error(`Provider(${provider.id}) 缺少 apiKey/token`);
    const mt = typeof maxTokens === "number" && maxTokens > 0 ? maxTokens : 1024;
    return await anthropicComplete({
      baseUrl,
      apiKey,
      model: m,
      system: system || undefined,
      messages: [{ role: "user", content: user }],
      temperature,
      maxTokens: mt,
      extraHeaders,
      extraBody,
      timeoutMs,
      abortSignal
    });
  }

  if (provider.type === "gemini_cli") {
    const command = normalizeString(provider.command);
    if (!command) throw new Error(`Provider(${provider.id}) gemini_cli command 未配置`);
    const prompt = system ? `${system}\n\n${user}` : user;
    return await geminiCliCompleteText({ command, args: provider.args, model: m, prompt, apiKey: apiKey || undefined, timeoutMs, abortSignal });
  }

  throw new Error(`未知 Provider type: ${String((provider as any).type)}`);
}

async function* streamText({
  provider,
  model,
  system,
  user,
  temperature,
  maxTokens,
  timeoutMs,
  abortSignal
}: {
  provider: ByokResolvedProvider;
  model?: string;
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}): AsyncGenerator<ByokStreamEvent> {
  const m = normalizeString(model) || normalizeString(provider.defaultModel);
  if (!m) throw new Error(`Provider(${provider.id}) 缺少 model（defaultModel 未配置且请求未指定 model）`);
  const apiKey = normalizeString(provider.secrets.apiKey || provider.secrets.token || "");
  const extraHeaders = provider.headers;
  const extraBody = provider.requestDefaults;

  if (provider.type === "openai_compatible") {
    const baseUrl = normalizeString(provider.baseUrl);
    if (!baseUrl) throw new Error(`Provider(${provider.id}) 缺少 baseUrl`);
    if (!apiKey) throw new Error(`Provider(${provider.id}) 缺少 apiKey/token`);
    yield* openAiChatStreamEvents({
      baseUrl,
      apiKey,
      model: m,
      messages: system ? [{ role: "system", content: system }, { role: "user", content: user }] : [{ role: "user", content: user }],
      temperature,
      maxTokens,
      extraHeaders,
      extraBody,
      timeoutMs,
      abortSignal
    });
    return;
  }

  if (provider.type === "openai_native") {
    const baseUrl = normalizeString(provider.baseUrl);
    if (!baseUrl) throw new Error(`Provider(${provider.id}) 缺少 baseUrl`);
    if (!apiKey) throw new Error(`Provider(${provider.id}) 缺少 apiKey/token`);
    const prompt = system ? `${system}\n\n${user}` : user;
    yield* codexResponsesStreamEvents({ baseUrl, apiKey, model: m, prompt, extraHeaders, extraBody, timeoutMs, abortSignal });
    return;
  }

  if (provider.type === "anthropic_native") {
    const baseUrl = normalizeString(provider.baseUrl);
    if (!baseUrl) throw new Error(`Provider(${provider.id}) 缺少 baseUrl`);
    if (!apiKey) throw new Error(`Provider(${provider.id}) 缺少 apiKey/token`);
    const mt = typeof maxTokens === "number" && maxTokens > 0 ? maxTokens : 1024;
    yield* anthropicStreamEvents({
      baseUrl,
      apiKey,
      model: m,
      system: system || undefined,
      messages: [{ role: "user", content: user }],
      temperature,
      maxTokens: mt,
      extraHeaders,
      extraBody,
      timeoutMs,
      abortSignal
    });
    return;
  }

  if (provider.type === "gemini_cli") {
    const command = normalizeString(provider.command);
    if (!command) throw new Error(`Provider(${provider.id}) gemini_cli command 未配置`);
    const prompt = system ? `${system}\n\n${user}` : user;
    yield* geminiCliStreamEvents({ command, args: provider.args, model: m, prompt, apiKey: apiKey || undefined, timeoutMs, abortSignal });
    return;
  }

  throw new Error(`未知 Provider type: ${String((provider as any).type)}`);
}

function getContextOrThrow(): any {
  const ctx = (globalThis as any)[AUGMENT_BYOK.extensionContextGlobalKey];
  if (!ctx) throw new Error("BYOK 未初始化：缺少 extension context");
  return ctx;
}

async function getConfigIfEnabled(): Promise<ByokResolvedConfigV2 | null> {
  const context = getContextOrThrow();
  const raw = await loadByokConfigRaw({ context });
  if (raw.enabled !== true) return null;
  return await loadByokConfigResolved({ context });
}

export async function maybeHandleCallApi({
  requestId,
  endpoint,
  body,
  transform,
  timeoutMs,
  abortSignal,
  upstreamBaseUrl,
  upstreamApiToken
}: {
  requestId?: unknown;
  endpoint: unknown;
  body: unknown;
  transform: (raw: any) => any;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  upstreamBaseUrl?: unknown;
  upstreamApiToken?: unknown;
}): Promise<any | undefined> {
  const ep = normalizeEndpoint(endpoint);
  const request = (asRecord(body) as any) || {};
  const requestModel = normalizeString(request.model || request.model_id || request.modelId);

  if (ep === "get-models") {
    throwIfAborted(abortSignal);
    const ctx = getContextOrThrow();
    const raw = await loadByokConfigRaw({ context: ctx });
    if (raw.enabled !== true) return undefined;
    const cfg = await loadByokConfigResolved({ context: ctx });
    throwIfDisabledEndpoint(cfg, ep);
    const baseUrl = normalizeString(cfg.proxy.baseUrl) || normalizeString(upstreamBaseUrl);
    const token = normalizeString(cfg.proxy.token || "") || normalizeString(upstreamApiToken);
    let upstream: any = null;
    let cached: Awaited<ReturnType<typeof getCachedUpstreamGetModels>> | null = null;
    if (baseUrl) {
      try {
        cached = await getCachedUpstreamGetModels({ context: ctx, baseUrl, maxAgeMs: UPSTREAM_GET_MODELS_CACHE_MAX_AGE_MS });
      } catch (err) {
        console.warn(`[BYOK] get-models cache 读取失败：${err instanceof Error ? err.message : String(err)}`);
        cached = null;
      }
    }
    if (baseUrl && token) {
      try {
        upstream = await fetchAugmentGetModels({ baseUrl, token, timeoutMs: BYOK_MODELS_TIMEOUT_MS, abortSignal });
        try {
          await saveCachedUpstreamGetModels({ context: ctx, baseUrl, value: upstream });
        } catch (err) {
          console.warn(`[BYOK] get-models cache 写入失败：${err instanceof Error ? err.message : String(err)}`);
        }
      } catch (err) {
        console.warn(`[BYOK] get-models 透传失败：${err instanceof Error ? err.message : String(err)}`);
        upstream = cached?.value || null;
      }
    } else {
      upstream = cached?.value || null;
    }

    const upstreamFlagsRaw = tryParseJsonObject((upstream as any)?.feature_flags) || {};
    const upstreamFlags = withCamelAliases(upstreamFlagsRaw);
    if (!cfg.providers.length) throw new Error("未配置任何 Provider");

    const byokModelRegistry: Record<string, any> = {};
    const byokModelInfoRegistry: Record<string, any> = {};
    const activeProvider = pickActiveProvider(cfg);
    for (const p of [activeProvider, ...cfg.providers.filter((x) => x.id !== activeProvider.id)]) {
      let modelsRaw: string[] = [];
      try {
        const cached = await getCachedProviderModels({ context: ctx, providerId: p.id, baseUrl: p.baseUrl });
        modelsRaw = cached?.models?.length ? cached.models : [];
      } catch (err) {
        console.warn(`[BYOK] Provider(${p.id}) models 获取失败：${err instanceof Error ? err.message : String(err)}`);
      }
      const fallback = normalizeString(p.defaultModel);
      const models = (() => {
        const out: string[] = [];
        const seen = new Set<string>();
        const push = (v: string) => {
          const m = normalizeString(v);
          if (!m || seen.has(m)) return;
          seen.add(m);
          out.push(m);
        };
        if (fallback) push(fallback);
        for (const m of modelsRaw) push(m);
        return out;
      })();
      if (!models.length) continue;
      for (const m of models) {
        const modelId = normalizeString(m);
        if (!modelId) continue;
        const byokId = `byok:${p.id}:${modelId}`;
        const displayName = `${p.id}: ${modelId}`;
        byokModelRegistry[displayName] = byokId;
        byokModelInfoRegistry[byokId] = { description: "", disabled: false, displayName, shortName: displayName };
      }
    }
    if (!Object.keys(byokModelRegistry).length) throw new Error("BYOK models 为空：请检查 Provider models/defaultModel");

    const defaultChatModelId = normalizeString(activeProvider.defaultModel);
    if (!defaultChatModelId) throw new Error(`Provider(${activeProvider.id}) 缺少 defaultModel（无法生成 agentChatModel）`);
    const agentChatModel = `byok:${activeProvider.id}:${defaultChatModelId}`;

    const registryJson = JSON.stringify(byokModelRegistry);
    const infoRegistryJson = JSON.stringify(byokModelInfoRegistry);
    const models = Object.entries(byokModelRegistry).map(([, byokId]) => ({
      name: byokId,
      suggested_prefix_char_count: 0,
      suggested_suffix_char_count: 0
    }));
    const feature_flags = {
      ...upstreamFlags,
      additional_chat_models: registryJson,
      additionalChatModels: registryJson,
      agent_chat_model: agentChatModel,
      agentChatModel: agentChatModel,
      enable_model_registry: true,
      enableModelRegistry: true,
      model_registry: registryJson,
      modelRegistry: registryJson,
      model_info_registry: infoRegistryJson,
      modelInfoRegistry: infoRegistryJson,
      enable_grpc_to_ide_messaging: false,
      enableGrpcToIdeMessaging: false,
      enable_commit_session_events: false,
      enableCommitSessionEvents: false,
      vscode_background_agents_min_version: "9999.0.0",
      vscodeBackgroundAgentsMinVersion: "9999.0.0",
      remote_agent_list_polling_interval_ms: 2147483647,
      remoteAgentListPollingIntervalMs: 2147483647,
      remote_agent_chat_history_polling_interval_ms: 2147483647,
      remoteAgentChatHistoryPollingIntervalMs: 2147483647,
      notification_polling_interval_ms: 2147483647,
      notificationPollingIntervalMs: 2147483647,
      enable_native_remote_mcp: false,
      enableNativeRemoteMcp: false,
      enable_credits_in_settings: false,
      enableCreditsInSettings: false,
      enable_credit_banner_in_settings: false,
      enableCreditBannerInSettings: false
    };
    const base = upstream && typeof upstream === "object" ? upstream : { default_model: "", feature_flags: {}, languages: [], models: [], user: {}, user_tier: "unknown" };
    return transform({ ...base, default_model: agentChatModel, models, feature_flags });
  }
  const cfg = await getConfigIfEnabled();
  if (!cfg) return undefined;
  throwIfDisabledEndpoint(cfg, ep);
  if (ep === "next_edit_loc") {
    const instruction = normalizeString(request.instruction);
    const path = normalizeString(request.path);
    const numResultsRaw = Number(request.num_results ?? request.numResults);
    const numResults = Number.isFinite(numResultsRaw) ? Math.max(1, Math.min(10, Math.floor(numResultsRaw))) : 5;
    const baseSystem = buildSystemText(request);
    const baseUser = buildUserText(request);
    const editEvents = formatNextEditEventsForPrompt(request.edit_events ?? request.editEvents, { maxFiles: 6, maxEditsPerFile: 6 });

    const system = [
      `你必须只输出 JSON（不允许 Markdown/解释/代码块/额外文本）。`,
      `输出 schema：{candidate_locations:[{item:{path:string,range:{start:number,stop:number}},score:number,debug_info:string}],unknown_blob_names:[],checkpoint_not_found:false,critical_errors:[]}`,
      `range.start/range.stop 是 0-based 行号区间，要求 stop > start 且 start >= 0。`,
      `candidate_locations 数量 <= ${numResults}。`,
      baseSystem
    ]
      .filter(Boolean)
      .join("\n\n")
      .trim();

    const user = [
      baseUser,
      instruction ? `Instruction:\n${instruction}` : "",
      path ? `Path:\n${path}` : "",
      `num_results: ${numResults}`,
      editEvents ? `edit_events:\n${editEvents}` : ""
    ]
      .filter(Boolean)
      .join("\n\n")
      .trim();

    const resolved = resolveProviderAndModel(cfg, ep, requestModel);
    throwIfAborted(abortSignal);
    const jsonText = await completeText({ provider: resolved.provider, model: resolved.model, system, user, timeoutMs: BYOK_REQUEST_TIMEOUT_MS, abortSignal });
    const parsed = parseJsonFromModelTextOrThrow(jsonText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("next_edit_loc: 模型输出不是 JSON 对象");
    const candidatesRaw = (parsed as any).candidate_locations;
    const candidates = normalizeNextEditLocationCandidates(candidatesRaw, { fallbackPath: path, maxCount: numResults });
    if (!candidates.length) throw new Error("next_edit_loc: candidate_locations 为空或格式不合法");
    return transform({ candidate_locations: candidates, unknown_blob_names: [], checkpoint_not_found: false, critical_errors: [] });
  }

  if (ep !== "chat" && ep !== "completion" && ep !== "chat-input-completion" && ep !== "edit") throw new Error(`BYOK 未实现的 callApi endpoint: ${ep}`);

  const resolved = resolveProviderAndModel(cfg, ep, requestModel);
  throwIfAborted(abortSignal);
  const system = buildSystemText(request);
  const user = buildUserText(request);
  const text = await completeText({
    provider: resolved.provider,
    model: resolved.model,
    system,
    user,
    timeoutMs: BYOK_REQUEST_TIMEOUT_MS,
    abortSignal
  });

  if (ep === "completion" || ep === "chat-input-completion") {
    return transform({
      completion_items: [{ text, suffix_replacement_text: "", skipped_suffix: "" }],
      unknown_blob_names: [],
      checkpoint_not_found: false,
      suggested_prefix_char_count: 0,
      suggested_suffix_char_count: 0,
      completion_timeout_ms: 0
    });
  }

  if (ep === "edit") return transform({ text, unknown_blob_names: [], checkpoint_not_found: false });
  return transform({ text, unknown_blob_names: [], checkpoint_not_found: false, workspace_file_chunks: [], nodes: [] });
}

export async function maybeHandleCallApiStream({
  requestId,
  endpoint,
  body,
  transform,
  timeoutMs,
  abortSignal
}: {
  requestId?: unknown;
  endpoint: unknown;
  body: unknown;
  transform: (raw: any) => any;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}): Promise<AsyncGenerator<any> | undefined> {
  const ep = normalizeEndpoint(endpoint);
  const cfg = await getConfigIfEnabled();
  if (!cfg) return undefined;
  throwIfDisabledEndpoint(cfg, ep);
  const request = (asRecord(body) as any) || {};
  const system = buildSystemText(request);
  const user = buildUserText(request);
  const tmo = BYOK_REQUEST_TIMEOUT_MS;
  const requestModel = normalizeString(request.model || request.model_id || request.modelId);
  const resolved = resolveProviderAndModel(cfg, ep, requestModel);
  throwIfAborted(abortSignal);
  const resolvedProvider = resolved.provider;
  const resolvedModel = resolved.model;

  if (ep === "next-edit-stream") {
    const suggested = await completeText({ provider: resolvedProvider, model: resolvedModel, system, user, timeoutMs: tmo, abortSignal });
    const raw = {
      next_edit: {
        suggestion_id: `byok-${Date.now()}`,
        path: normalizeString(request.path),
        blob_name: normalizeString(request.blob_name),
        char_start: Number(request.selection_begin_char) || 0,
        char_end: Number(request.selection_end_char) || Number(request.selection_begin_char) || 0,
        existing_code: normalizeString(request.selected_text),
        suggested_code: suggested,
        truncation_char: null,
        change_description: "",
        diff_spans: [],
        editing_score: 1,
        localization_score: 1,
        editing_score_threshold: 1
      },
      unknown_blob_names: [],
      checkpoint_not_found: false
    };
    async function* once() {
      yield transform(raw);
    }
    return once();
  }

  if (ep === "chat-stream") {
    const toolDefs = getToolDefinitions(request);
    if (!toolDefs.length) {
      async function* gen() {
        let nodeId = 1;
        for await (const chunk of streamText({ provider: resolvedProvider, model: resolvedModel, system, user, timeoutMs: tmo, abortSignal })) {
          throwIfAborted(abortSignal);
          if (chunk.kind === "text") {
            yield transform({ text: chunk.text, unknown_blob_names: [], checkpoint_not_found: false, workspace_file_chunks: [], nodes: [] });
            continue;
          }
          if (chunk.kind === "thinking") {
            yield transform({ text: "", unknown_blob_names: [], checkpoint_not_found: false, workspace_file_chunks: [], nodes: [thinkingNode({ id: nodeId++, summary: chunk.summary })] });
            continue;
          }
          throw new Error("chat-stream 未提供 tool_definitions 但收到了 tool_use");
        }
      }
      return gen();
    }

    const chatHistory = getChatHistory(request);
    const requestNodes = getRequestNodes(request);

    const provider = resolvedProvider;
    const model = resolvedModel;
    if (!model) throw new Error(`Provider(${provider.id}) 缺少 model`);

    async function* genTools() {
      let nodeId = 1;

      if (provider.type === "openai_compatible") {
        const baseUrl = normalizeString(provider.baseUrl);
        if (!baseUrl) throw new Error(`Provider(${provider.id}) 缺少 baseUrl`);
        const apiKey = normalizeString(provider.secrets.apiKey || provider.secrets.token || "");
        if (!apiKey) throw new Error(`Provider(${provider.id}) 缺少 apiKey/token`);
        const tools = toOpenAiTools(toolDefs);
        const messages = buildOpenAiMessagesForToolCalling({ system, chatHistory, currentUserText: user, currentRequestNodes: requestNodes });
        throwIfAborted(abortSignal);
        for await (const ev of openAiChatStreamEvents({
          baseUrl,
          apiKey,
          model,
          messages,
          tools,
          extraHeaders: provider.headers,
          extraBody: provider.requestDefaults,
          timeoutMs: tmo,
          abortSignal
        })) {
          throwIfAborted(abortSignal);
          if (ev.kind === "text") {
            yield transform({ text: ev.text, unknown_blob_names: [], checkpoint_not_found: false, workspace_file_chunks: [], nodes: [] });
            continue;
          }
          if (ev.kind === "thinking") {
            yield transform({ text: "", unknown_blob_names: [], checkpoint_not_found: false, workspace_file_chunks: [], nodes: [thinkingNode({ id: nodeId++, summary: ev.summary })] });
            continue;
          }
          yield transform({
            text: "",
            unknown_blob_names: [],
            checkpoint_not_found: false,
            workspace_file_chunks: [],
            nodes: [toolUseNode({ id: nodeId++, toolUseId: ev.toolUseId, toolName: ev.toolName, inputJson: ev.inputJson })]
          });
        }
        return;
      }

      if (provider.type === "openai_native") {
        const baseUrl = normalizeString(provider.baseUrl);
        if (!baseUrl) throw new Error(`Provider(${provider.id}) 缺少 baseUrl`);
        const apiKey = normalizeString(provider.secrets.apiKey || provider.secrets.token || "");
        if (!apiKey) throw new Error(`Provider(${provider.id}) 缺少 apiKey/token`);
        const tools = toOpenAiTools(toolDefs);
        const messages = buildOpenAiMessagesForToolCalling({ system, chatHistory, currentUserText: user, currentRequestNodes: requestNodes });
        throwIfAborted(abortSignal);
        for await (const ev of codexChatStreamEventsWithTools({
          baseUrl,
          apiKey,
          model,
          messages,
          tools,
          extraHeaders: provider.headers,
          extraBody: provider.requestDefaults,
          timeoutMs: tmo,
          abortSignal
        })) {
          throwIfAborted(abortSignal);
          if (ev.kind === "text") {
            yield transform({ text: ev.text, unknown_blob_names: [], checkpoint_not_found: false, workspace_file_chunks: [], nodes: [] });
            continue;
          }
          if (ev.kind === "thinking") {
            yield transform({ text: "", unknown_blob_names: [], checkpoint_not_found: false, workspace_file_chunks: [], nodes: [thinkingNode({ id: nodeId++, summary: ev.summary })] });
            continue;
          }
          yield transform({
            text: "",
            unknown_blob_names: [],
            checkpoint_not_found: false,
            workspace_file_chunks: [],
            nodes: [toolUseNode({ id: nodeId++, toolUseId: ev.toolUseId, toolName: ev.toolName, inputJson: ev.inputJson })]
          });
        }
        return;
      }

      if (provider.type === "anthropic_native") {
        const tools = toAnthropicTools(toolDefs);
        const maxTokens = 1024;
        const messages = buildAnthropicMessagesForToolCalling({ chatHistory, currentUserText: user, currentRequestNodes: requestNodes });
        throwIfAborted(abortSignal);
        const baseUrl = normalizeString(provider.baseUrl);
        if (!baseUrl) throw new Error(`Provider(${provider.id}) 缺少 baseUrl`);
        const apiKey = normalizeString(provider.secrets.apiKey || provider.secrets.token || "");
        if (!apiKey) throw new Error(`Provider(${provider.id}) 缺少 apiKey/token`);
        for await (const ev of anthropicStreamEvents({
          baseUrl,
          apiKey,
          model,
          system: system || undefined,
          messages,
          tools,
          maxTokens,
          extraHeaders: provider.headers,
          extraBody: provider.requestDefaults,
          timeoutMs: tmo,
          abortSignal
        })) {
          throwIfAborted(abortSignal);
          if (ev.kind === "text") {
            yield transform({ text: ev.text, unknown_blob_names: [], checkpoint_not_found: false, workspace_file_chunks: [], nodes: [] });
            continue;
          }
          if (ev.kind === "thinking") {
            yield transform({ text: "", unknown_blob_names: [], checkpoint_not_found: false, workspace_file_chunks: [], nodes: [thinkingNode({ id: nodeId++, summary: ev.summary })] });
            continue;
          }
          yield transform({
            text: "",
            unknown_blob_names: [],
            checkpoint_not_found: false,
            workspace_file_chunks: [],
            nodes: [toolUseNode({ id: nodeId++, toolUseId: ev.toolUseId, toolName: ev.toolName, inputJson: ev.inputJson })]
          });
        }
        return;
      }

      if (provider.type === "gemini_cli") throw new Error("gemini_cli 不支持 tool_definitions/chat-stream tools");
      throw new Error(`未知 Provider type: ${String((provider as any).type)}`);
    }
    return genTools();
  }

  if (
    ep === "prompt-enhancer" ||
    ep === "instruction-stream" ||
    ep === "smart-paste-stream" ||
    ep === "generate-commit-message-stream" ||
    ep === "generate-conversation-title"
  ) {
    async function* gen() {
      let nodeId = 1;
      for await (const chunk of streamText({ provider: resolvedProvider, model: resolvedModel, system, user, timeoutMs: tmo, abortSignal })) {
        throwIfAborted(abortSignal);
        if (chunk.kind === "thinking") {
          if (ep === "instruction-stream" || ep === "smart-paste-stream") continue;
          yield transform({ text: "", unknown_blob_names: [], checkpoint_not_found: false, workspace_file_chunks: [], nodes: [thinkingNode({ id: nodeId++, summary: chunk.summary })] });
          continue;
        }
        if (chunk.kind === "tool_use") throw new Error(`${ep} 不支持 tool_use`);
        const raw = ep === "instruction-stream" || ep === "smart-paste-stream" ? { text: chunk.text } : { text: chunk.text, unknown_blob_names: [], checkpoint_not_found: false, workspace_file_chunks: [], nodes: [] };
        yield transform(raw);
      }
    }
    return gen();
  }

  throw new Error(`BYOK 未实现的 callApiStream endpoint: ${ep}`);
}
