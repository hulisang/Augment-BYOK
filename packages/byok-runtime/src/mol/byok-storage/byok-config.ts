import { AUGMENT_BYOK } from "../../constants";
import { normalizeEndpoint, normalizeString } from "../../atom/common/http";
import { asRecord } from "../../atom/common/object";
import { assertVscodeContextStorage } from "../../atom/common/vscode-storage";
import type { ByokConfigV2, ByokExportV2, ByokProvider, ByokProviderSecrets, ByokResolvedConfigV2, ByokRoutingRule } from "../../types";

function normalizeStringArray(v: unknown): string[] | undefined {
  const arr = Array.isArray(v) ? v : null;
  if (!arr) return undefined;
  const out = arr.map(normalizeString).filter(Boolean);
  return out.length ? out : undefined;
}

function normalizeStringRecord(v: unknown): Record<string, string> | undefined {
  const r = asRecord(v);
  if (!r) return undefined;
  const out: Record<string, string> = {};
  for (const [k, vv] of Object.entries(r)) {
    const key = normalizeString(k);
    const val = normalizeString(vv);
    if (!key || !val) continue;
    out[key] = val;
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeProvider(v: unknown): ByokProvider | null {
  const r = asRecord(v);
  if (!r) return null;
  const id = normalizeString(r.id);
  const type = normalizeString(r.type);
  const baseUrl = normalizeString(r.baseUrl);
  const defaultModel = normalizeString(r.defaultModel) || undefined;
  const command = normalizeString(r.command) || undefined;
  const args = normalizeStringArray(r.args);
  const headers = normalizeStringRecord(r.headers);
  const requestDefaults = (asRecord(r.requestDefaults) as any) || undefined;
  if (!id) return null;
  if (type !== "openai_compatible" && type !== "openai_native" && type !== "anthropic_native" && type !== "gemini_cli") return null;
  if (type !== "gemini_cli" && !baseUrl) return null;
  return { id, type, baseUrl, defaultModel, command, args, headers, requestDefaults };
}

function normalizeRoutingRule(v: unknown): ByokRoutingRule | null {
  const r = asRecord(v);
  if (!r) return null;
  const enabled = typeof r.enabled === "boolean" ? r.enabled : undefined;
  const providerId = normalizeString(r.providerId) || undefined;
  const model = normalizeString(r.model) || undefined;
  const out: ByokRoutingRule = {};
  if (enabled === false) out.enabled = false;
  if (providerId) out.providerId = providerId;
  if (model) out.model = model;
  return Object.keys(out).length ? out : null;
}

function normalizeConfigV2(v: unknown): ByokConfigV2 {
  const r = asRecord(v);
  if (!r || r.version !== 2) return { version: 2, enabled: false, proxy: { baseUrl: "" }, providers: [], routing: { activeProviderId: "", rules: undefined } };
  const enabled = typeof r.enabled === "boolean" ? r.enabled : false;
  const proxyRaw = asRecord(r.proxy) || {};
  const proxyBaseUrl = normalizeString(proxyRaw.baseUrl);
  const providersRaw = Array.isArray(r.providers) ? (r.providers as unknown[]) : [];
  const providers = providersRaw.map(normalizeProvider).filter(Boolean) as ByokProvider[];
  const routingRaw = asRecord(r.routing) || {};
  const activeProviderId = normalizeString(routingRaw.activeProviderId);
  const rulesRaw = asRecord(routingRaw.rules);
  const rules: Record<string, ByokRoutingRule> | undefined = rulesRaw
    ? Object.fromEntries(
        Object.entries(rulesRaw)
          .map(([k, vv]) => [normalizeEndpoint(k), normalizeRoutingRule(vv)] as const)
          .filter(([k, vv]) => Boolean(k) && Boolean(vv))
          .map(([k, vv]) => [k, vv as ByokRoutingRule])
      )
    : undefined;
  const outRules = rules && Object.keys(rules).length ? rules : undefined;
  return { version: 2, enabled, proxy: { baseUrl: proxyBaseUrl }, providers, routing: { activeProviderId, rules: outRules } };
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
  assertVscodeContextStorage(context, "BYOK 安全存储");
}

export type ByokSecretStatus = {
  proxy: { token: "missing" | "env" | "set" };
  providers: Record<string, { apiKey: "missing" | "env" | "set" }>;
};

export async function getByokSecretStatus({ context, config }: { context: any; config?: ByokConfigV2 }): Promise<ByokSecretStatus> {
  assertContextStorage(context);
  const cfg = config || (await loadByokConfigRaw({ context }));
  const proxyTokenRaw = normalizeString(await context.secrets.get(proxySecretKey("token")));
  const tokenStatus = !proxyTokenRaw ? "missing" : parseEnvPlaceholder(proxyTokenRaw) ? "env" : "set";
  const providers: ByokSecretStatus["providers"] = {};
  for (const p of cfg.providers) {
    const pid = normalizeString(p.id);
    if (!pid) continue;
    const apiKeyRaw = normalizeString(await context.secrets.get(secretKey(pid, "apiKey")));
    const tokenRaw = normalizeString(await context.secrets.get(secretKey(pid, "token")));
    const raw = apiKeyRaw || tokenRaw;
    providers[pid] = { apiKey: !raw ? "missing" : parseEnvPlaceholder(raw) ? "env" : "set" };
  }
  return { proxy: { token: tokenStatus }, providers };
}

export async function getByokProxyTokenRaw({ context }: { context: any }): Promise<string> {
  assertContextStorage(context);
  return normalizeString(await context.secrets.get(proxySecretKey("token")));
}

export async function loadByokConfigRaw({ context }: { context: any }): Promise<ByokConfigV2> {
  assertContextStorage(context);
  const stored = await context.globalState.get(AUGMENT_BYOK.byokConfigGlobalStateKey);
  return normalizeConfigV2(stored);
}

export async function loadByokConfigResolved({ context, env = process.env }: { context: any; env?: NodeJS.ProcessEnv }): Promise<ByokResolvedConfigV2> {
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
    providers
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
  config: ByokConfigV2;
  proxyToken?: string;
  clearProxyToken?: boolean;
  secretsByProviderId?: Record<string, ByokProviderSecrets | undefined>;
}): Promise<void> {
  assertContextStorage(context);
  if (!(asRecord(config)?.version === 2)) throw new Error(`配置版本不匹配：${String(asRecord(config)?.version)}`);
  const nextConfig = normalizeConfigV2(config);
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
}): Promise<ByokExportV2> {
  assertContextStorage(context);
  const config = await loadByokConfigRaw({ context });
  const exportedAt = new Date().toISOString();
  const proxyTokenRaw = normalizeString(await context.secrets.get(proxySecretKey("token")));
  const proxyToken = includeSecrets ? proxyTokenRaw || null : parseEnvPlaceholder(proxyTokenRaw || "") ? proxyTokenRaw : proxyTokenRaw ? null : undefined;
  const secrets: ByokExportV2["secrets"] = { proxy: { token: proxyToken ?? undefined }, providers: {} };
  await Promise.all(
    config.providers.map(async (p) => {
      const apiKeyRaw = normalizeString(await context.secrets.get(secretKey(p.id, "apiKey")));
      const tokenRaw = normalizeString(await context.secrets.get(secretKey(p.id, "token")));
      const apiKey = includeSecrets ? apiKeyRaw || null : parseEnvPlaceholder(apiKeyRaw || "") ? apiKeyRaw : apiKeyRaw ? null : undefined;
      const token = includeSecrets ? tokenRaw || null : parseEnvPlaceholder(tokenRaw || "") ? tokenRaw : tokenRaw ? null : undefined;
      if (apiKey !== undefined || token !== undefined) secrets.providers[p.id] = { apiKey: apiKey ?? undefined, token: token ?? undefined };
    })
  );
  return { version: 2, config, secrets, meta: { exportedAt, redacted: !includeSecrets } };
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
  if (r.version !== 2) throw new Error(`导入失败：不支持的版本：${String(r.version)}`);
  const configRaw = asRecord(r.config);
  if (!configRaw || configRaw.version !== 2) throw new Error(`导入失败：config.version 不匹配：${String(configRaw?.version)}`);
  const config = normalizeConfigV2(configRaw);
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
