import { AUGMENT_BYOK } from "../../constants";
import { normalizeString } from "../../atom/common/http";
import type { ByokConfigV1, ByokDefaults, ByokExportV1, ByokProvider, ByokProviderSecrets, ByokResolvedConfigV1, ByokResolvedDefaults } from "../../types";

const DEFAULTS: ByokResolvedDefaults = { requestTimeoutMs: 120_000 };

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function normalizeProvider(v: unknown): ByokProvider | null {
  const r = asRecord(v);
  if (!r) return null;
  const id = normalizeString(r.id);
  const type = normalizeString(r.type);
  const baseUrl = normalizeString(r.baseUrl);
  const defaultModel = normalizeString(r.defaultModel) || undefined;
  if (!id || !baseUrl) return null;
  if (type !== "openai_compatible" && type !== "anthropic_native") return null;
  return { id, type, baseUrl, defaultModel };
}

function normalizeConfigV1(v: unknown): ByokConfigV1 {
  const r = asRecord(v);
  const version = r?.version === 1 ? 1 : 1;
  const enabled = typeof r?.enabled === "boolean" ? r.enabled : false;
  const proxyRaw = asRecord(r?.proxy) || {};
  const proxyBaseUrl = normalizeString(proxyRaw.baseUrl);
  const providersRaw = Array.isArray(r?.providers) ? (r?.providers as unknown[]) : [];
  const providers = providersRaw.map(normalizeProvider).filter(Boolean) as ByokProvider[];
  const routingRaw = asRecord(r?.routing) || {};
  const activeProviderId = normalizeString(routingRaw.activeProviderId);
  const routesRaw = asRecord(routingRaw.routes);
  const routes: Record<string, string> | undefined = routesRaw
    ? Object.fromEntries(Object.entries(routesRaw).map(([k, vv]) => [String(k), normalizeString(vv)]).filter(([, vv]) => Boolean(vv)))
    : undefined;
  const modelsRaw = asRecord(routingRaw.models);
  const models: Record<string, string> | undefined = modelsRaw
    ? Object.fromEntries(Object.entries(modelsRaw).map(([k, vv]) => [String(k), normalizeString(vv)]).filter(([, vv]) => Boolean(vv)))
    : undefined;
  const defaultsRaw = asRecord(r?.defaults);
  const requestTimeoutMs = Number(defaultsRaw?.requestTimeoutMs);
  const temperature = Number(defaultsRaw?.temperature);
  const maxTokens = Number(defaultsRaw?.maxTokens);
  const defaults: ByokDefaults = {};
  if (Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0) defaults.requestTimeoutMs = requestTimeoutMs;
  if (Number.isFinite(temperature)) defaults.temperature = temperature;
  if (Number.isFinite(maxTokens) && maxTokens > 0) defaults.maxTokens = maxTokens;
  return { version, enabled, proxy: { baseUrl: proxyBaseUrl }, providers, routing: { activeProviderId, routes, models }, defaults: Object.keys(defaults).length ? defaults : undefined };
}

function secretKey(providerId: string, field: keyof ByokProviderSecrets): string {
  return `${AUGMENT_BYOK.byokSecretPrefix}.provider.${providerId}.${field}`;
}

function proxySecretKey(field: "token"): string {
  return `${AUGMENT_BYOK.byokSecretPrefix}.proxy.${field}`;
}

export function parseEnvPlaceholder(v: string): { varName: string } | null {
  const m = v.match(/^\$\{env:([^}]+)\}$/);
  if (!m) return null;
  const varName = m[1].trim();
  if (!varName) return null;
  return { varName };
}

export function resolveSecretOrThrow(raw: string, env: NodeJS.ProcessEnv): string {
  const placeholder = parseEnvPlaceholder(raw);
  if (!placeholder) return raw;
  const value = env[placeholder.varName];
  if (!value) throw new Error(`环境变量缺失：${placeholder.varName}`);
  return value;
}

function assertContextStorage(context: any): void {
  const okGlobalState = context?.globalState && typeof context.globalState.get === "function" && typeof context.globalState.update === "function";
  const okSecrets =
    context?.secrets && typeof context.secrets.get === "function" && typeof context.secrets.store === "function" && typeof context.secrets.delete === "function";
  if (!okGlobalState || !okSecrets) throw new Error("BYOK 安全存储不可用（缺少 globalState / secrets）");
}

export async function loadByokConfigRaw({ context }: { context: any }): Promise<ByokConfigV1> {
  assertContextStorage(context);
  const stored = await context.globalState.get(AUGMENT_BYOK.byokConfigGlobalStateKey);
  return normalizeConfigV1(stored);
}

export async function loadByokConfigResolved({ context, env = process.env }: { context: any; env?: NodeJS.ProcessEnv }): Promise<ByokResolvedConfigV1> {
  assertContextStorage(context);
  const config = await loadByokConfigRaw({ context });
  const proxyTokenRaw = normalizeString(await context.secrets.get(proxySecretKey("token")));
  const proxyToken = proxyTokenRaw ? resolveSecretOrThrow(proxyTokenRaw, env) : "";
  const providers = await Promise.all(
    config.providers.map(async (p) => {
      const apiKeyRaw = normalizeString(await context.secrets.get(secretKey(p.id, "apiKey")));
      const tokenRaw = normalizeString(await context.secrets.get(secretKey(p.id, "token")));
      const apiKey = apiKeyRaw ? resolveSecretOrThrow(apiKeyRaw, env) : "";
      const token = tokenRaw ? resolveSecretOrThrow(tokenRaw, env) : "";
      return { ...p, secrets: { apiKey: apiKey || undefined, token: token || undefined } };
    })
  );
  return {
    ...config,
    proxy: { baseUrl: normalizeString(config.proxy?.baseUrl), token: proxyToken || undefined },
    providers,
    defaults: { ...DEFAULTS, ...(config.defaults || {}) }
  };
}

export async function saveByokConfig({
  context,
  config,
  proxyToken,
  clearProxyToken = false,
  secretsByProviderId
}: {
  context: any;
  config: ByokConfigV1;
  proxyToken?: string;
  clearProxyToken?: boolean;
  secretsByProviderId?: Record<string, ByokProviderSecrets | undefined>;
}): Promise<void> {
  assertContextStorage(context);
  const nextConfig = normalizeConfigV1(config);
  await context.globalState.update(AUGMENT_BYOK.byokConfigGlobalStateKey, nextConfig);
  if (typeof proxyToken === "string") await context.secrets.store(proxySecretKey("token"), proxyToken);
  else if (clearProxyToken) await context.secrets.delete(proxySecretKey("token"));
  if (!secretsByProviderId) return;
  await Promise.all(
    Object.entries(secretsByProviderId).flatMap(([providerId, secrets]) => {
      const pid = normalizeString(providerId);
      if (!pid || !secrets) return [];
      const tasks: Promise<void>[] = [];
      if (typeof secrets.apiKey === "string") tasks.push(context.secrets.store(secretKey(pid, "apiKey"), secrets.apiKey));
      if (typeof secrets.token === "string") tasks.push(context.secrets.store(secretKey(pid, "token"), secrets.token));
      return tasks;
    })
  );
}

export async function exportByokConfig({
  context,
  includeSecrets = false
}: {
  context: any;
  includeSecrets?: boolean;
}): Promise<ByokExportV1> {
  assertContextStorage(context);
  const config = await loadByokConfigRaw({ context });
  const exportedAt = new Date().toISOString();
  const proxyTokenRaw = normalizeString(await context.secrets.get(proxySecretKey("token")));
  const proxyToken = includeSecrets ? proxyTokenRaw || null : parseEnvPlaceholder(proxyTokenRaw || "") ? proxyTokenRaw : proxyTokenRaw ? null : undefined;
  const secrets: ByokExportV1["secrets"] = { proxy: { token: proxyToken ?? undefined }, providers: {} };
  await Promise.all(
    config.providers.map(async (p) => {
      const apiKeyRaw = normalizeString(await context.secrets.get(secretKey(p.id, "apiKey")));
      const tokenRaw = normalizeString(await context.secrets.get(secretKey(p.id, "token")));
      const apiKey = includeSecrets ? apiKeyRaw || null : parseEnvPlaceholder(apiKeyRaw || "") ? apiKeyRaw : apiKeyRaw ? null : undefined;
      const token = includeSecrets ? tokenRaw || null : parseEnvPlaceholder(tokenRaw || "") ? tokenRaw : tokenRaw ? null : undefined;
      if (apiKey !== undefined || token !== undefined) secrets.providers[p.id] = { apiKey: apiKey ?? undefined, token: token ?? undefined };
    })
  );
  return { version: 1, config, secrets, meta: { exportedAt, redacted: !includeSecrets } };
}

export async function importByokConfig({
  context,
  data,
  overwriteSecrets = false
}: {
  context: any;
  data: unknown;
  overwriteSecrets?: boolean;
}): Promise<void> {
  assertContextStorage(context);
  const r = asRecord(data);
  if (!r) throw new Error("导入失败：格式不是对象");
  if (r.version !== 1) throw new Error(`导入失败：不支持的版本：${String(r.version)}`);
  const config = normalizeConfigV1(r.config);
  await context.globalState.update(AUGMENT_BYOK.byokConfigGlobalStateKey, config);
  const secretsRoot = asRecord(r.secrets) || {};
  const proxySecrets = asRecord(secretsRoot.proxy) || {};
  const proxyToken = typeof proxySecrets.token === "string" ? proxySecrets.token : null;
  if (proxyToken !== null) await context.secrets.store(proxySecretKey("token"), proxyToken);
  else if (overwriteSecrets) await context.secrets.delete(proxySecretKey("token"));
  const providerSecretsRoot = asRecord(secretsRoot.providers) || {};
  await Promise.all(
    config.providers.flatMap((p) => {
      const s = asRecord(providerSecretsRoot[p.id]);
      if (!s) return [];
      const apiKey = typeof s.apiKey === "string" ? s.apiKey : null;
      const token = typeof s.token === "string" ? s.token : null;
      const tasks: Promise<void>[] = [];
      if (apiKey !== null) tasks.push(context.secrets.store(secretKey(p.id, "apiKey"), apiKey));
      else if (overwriteSecrets) tasks.push(context.secrets.delete(secretKey(p.id, "apiKey")));
      if (token !== null) tasks.push(context.secrets.store(secretKey(p.id, "token"), token));
      else if (overwriteSecrets) tasks.push(context.secrets.delete(secretKey(p.id, "token")));
      return tasks;
    })
  );
}
