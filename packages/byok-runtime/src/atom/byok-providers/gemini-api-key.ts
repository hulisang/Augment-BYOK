import { buildAbortSignal, joinBaseUrl, normalizeRawToken, safeFetch } from "../common/http";

function normalizeGeminiModelName(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return "";
  return s.startsWith("models/") ? s.slice("models/".length) : s;
}

export async function geminiListModelsApiKey({
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
  const url0 = joinBaseUrl(baseUrl, "models");
  if (!url0) throw new Error("Gemini baseUrl 无效");
  const key = normalizeRawToken(apiKey);
  if (!key) throw new Error("Gemini apiKey 未配置");
  const url = url0.includes("?") ? `${url0}&key=${encodeURIComponent(key)}` : `${url0}?key=${encodeURIComponent(key)}`;

  const resp = await safeFetch(url, { method: "GET", signal: buildAbortSignal(timeoutMs, abortSignal) }, "Gemini");
  const text = await resp.text().catch(() => "");
  if (!resp.ok) throw new Error(`Gemini models 请求失败: ${resp.status} ${text.slice(0, 200)}`.trim());
  const json = text ? JSON.parse(text) : null;
  const modelsRaw = Array.isArray(json?.models) ? json.models : null;
  if (!modelsRaw) throw new Error("Gemini models 响应缺少 models[]");
  const models = modelsRaw.map((m: any) => normalizeGeminiModelName(m?.name)).filter(Boolean);
  models.sort();
  return models;
}
