export function normalizeString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export function normalizeEndpoint(v: unknown): string {
  return normalizeString(v).replace(/^\/+/, "");
}

export function ensureTrailingSlash(url: string): string {
  const s = normalizeString(url);
  if (!s) return "";
  return s.endsWith("/") ? s : `${s}/`;
}

export function joinBaseUrl(baseUrl: string, endpoint: string): string {
  const b = normalizeString(baseUrl);
  const e = normalizeEndpoint(endpoint);
  if (!b || !e) return "";
  return `${ensureTrailingSlash(b)}${e}`;
}

export function assertHttpBaseUrl(v: unknown): string {
  const s = normalizeString(v);
  if (!/^https?:\/\//i.test(s)) throw new Error("Base URL 未配置或无效");
  return s;
}

export function normalizeRawToken(v: unknown): string {
  const s = normalizeString(v);
  if (!s) return "";
  if (/\s/.test(s)) throw new Error("Token 格式错误：请填写 raw token（不包含 Bearer 前缀）");
  return s;
}

export function buildBearerAuthHeader(token: unknown): string {
  const raw = normalizeRawToken(token);
  return raw ? `Bearer ${raw}` : "";
}

export function isAbortError(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as any).name === "AbortError";
}

export function buildAbortSignal(timeoutMs: number, abortSignal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!abortSignal) return timeout;
  const anyFn = (AbortSignal as any).any;
  if (typeof anyFn === "function") return anyFn([timeout, abortSignal]);
  const ac = new AbortController();
  const abort = (s: AbortSignal) => {
    try {
      ac.abort((s as any).reason);
    } catch {
      ac.abort();
    }
  };
  if (timeout.aborted) abort(timeout);
  else timeout.addEventListener("abort", () => abort(timeout), { once: true });
  if (abortSignal.aborted) abort(abortSignal);
  else abortSignal.addEventListener("abort", () => abort(abortSignal), { once: true });
  return ac.signal;
}

export async function safeFetch(url: string, init: RequestInit, label: string): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (isAbortError(err)) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${label} fetch 失败: ${msg} (url=${url})`);
  }
}

