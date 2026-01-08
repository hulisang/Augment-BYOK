import { AUGMENT_BYOK } from "../../constants";
import { ensureTrailingSlash, normalizeString } from "../../atom/common/http";

type ProviderModelsCacheEntry = { baseUrl: string; updatedAtMs: number; models: string[] };
type ProviderModelsCacheV1 = { version: 1; providers: Record<string, ProviderModelsCacheEntry> };

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function normalizeBaseUrlKey(v: unknown): string {
  return ensureTrailingSlash(normalizeString(v));
}

function assertGlobalState(context: any): void {
  const ok = context?.globalState && typeof context.globalState.get === "function" && typeof context.globalState.update === "function";
  if (!ok) throw new Error("BYOK models cache 不可用（缺少 globalState）");
}

function normalizeCacheEntry(v: unknown): ProviderModelsCacheEntry | null {
  const r = asRecord(v);
  if (!r) return null;
  const baseUrl = normalizeString(r.baseUrl);
  const updatedAtMs = Number(r.updatedAtMs);
  const modelsRaw = Array.isArray(r.models) ? (r.models as unknown[]) : [];
  const models = modelsRaw.map(normalizeString).filter(Boolean);
  if (!baseUrl || !Number.isFinite(updatedAtMs) || updatedAtMs <= 0 || !models.length) return null;
  return { baseUrl, updatedAtMs, models };
}

function normalizeModelsCacheV1(v: unknown): ProviderModelsCacheV1 {
  const r = asRecord(v) || {};
  const providersRaw = asRecord(r.providers) || {};
  const providers: Record<string, ProviderModelsCacheEntry> = {};
  for (const [k, vv] of Object.entries(providersRaw)) {
    const id = normalizeString(k);
    const entry = normalizeCacheEntry(vv);
    if (id && entry) providers[id] = entry;
  }
  return { version: 1, providers };
}

export async function loadProviderModelsCacheRaw({ context }: { context: any }): Promise<ProviderModelsCacheV1> {
  assertGlobalState(context);
  const stored = await context.globalState.get(AUGMENT_BYOK.byokModelsCacheGlobalStateKey);
  return normalizeModelsCacheV1(stored);
}

export async function getCachedProviderModels({
  context,
  providerId,
  baseUrl
}: {
  context: any;
  providerId: string;
  baseUrl: string;
}): Promise<ProviderModelsCacheEntry | null> {
  assertGlobalState(context);
  const pid = normalizeString(providerId);
  const b = normalizeBaseUrlKey(baseUrl);
  if (!pid || !b) return null;
  const cache = await loadProviderModelsCacheRaw({ context });
  const entry = cache.providers[pid] || null;
  if (!entry) return null;
  if (normalizeBaseUrlKey(entry.baseUrl) !== b) return null;
  return entry;
}

export async function saveCachedProviderModels({
  context,
  providerId,
  baseUrl,
  models
}: {
  context: any;
  providerId: string;
  baseUrl: string;
  models: string[];
}): Promise<void> {
  assertGlobalState(context);
  const pid = normalizeString(providerId);
  const b = normalizeBaseUrlKey(baseUrl);
  const list = Array.isArray(models) ? models.map(normalizeString).filter(Boolean) : [];
  if (!pid) throw new Error("缺少 providerId");
  if (!b) throw new Error("缺少 baseUrl");
  if (!list.length) throw new Error("models 为空");

  const cache = await loadProviderModelsCacheRaw({ context });
  cache.providers[pid] = { baseUrl: b, updatedAtMs: Date.now(), models: list };
  await context.globalState.update(AUGMENT_BYOK.byokModelsCacheGlobalStateKey, cache);
}
