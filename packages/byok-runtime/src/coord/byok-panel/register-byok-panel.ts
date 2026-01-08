import fs from "fs";
import path from "path";
import { exportByokConfig, importByokConfig, loadByokConfigRaw, loadByokConfigResolved, parseEnvPlaceholder, resolveSecretOrThrow, saveByokConfig } from "../../mol/byok-storage/byok-config";
import { loadProviderModelsCacheRaw, saveCachedProviderModels } from "../../mol/byok-routing/provider-models-cache";
import { AUGMENT_BYOK } from "../../constants";
import { anthropicListModels } from "../../atom/byok-providers/anthropic-native";
import { openAiListModels } from "../../atom/byok-providers/openai-compatible";
import { assertHttpBaseUrl, buildBearerAuthHeader, joinBaseUrl, normalizeEndpoint, normalizeRawToken, normalizeString } from "../../atom/common/http";

const COMMAND_ID = "vscode-augment.byok.settings";
const VIEW_TYPE = "augmentByokPanel";
const TITLE = "Augment BYOK";

function nonce(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function readExtensionAssetFile(context: any, fileName: string): string {
  const extensionPath = normalizeString(context?.extensionPath);
  if (!extensionPath) throw new Error("无法定位 extensionPath");
  const p = path.join(extensionPath, "media", fileName);
  if (!fs.existsSync(p)) throw new Error(`缺少资源：${p}`);
  return fs.readFileSync(p, "utf8");
}

function buildPanelHtml({ context, webview }: { context: any; webview: any }): string {
  const n = nonce();
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${n}'`
  ].join("; ");

  const template = readExtensionAssetFile(context, "byok-panel.html");
  const script = readExtensionAssetFile(context, "byok-panel.js");
  return template
    .replace(/\{\{CSP\}\}/g, csp)
    .replace(/\{\{NONCE\}\}/g, n)
    .replace("</body>", `<script nonce="${n}">\n${script}\n</script></body>`);
}

async function getLlmEndpoints({ context }: { context: any }): Promise<{ endpoints: string[] }> {
  const extensionPath = normalizeString(context?.extensionPath);
  if (!extensionPath) throw new Error("无法定位 extensionPath");
  const p = path.join(extensionPath, "config", "byok-routing", "llm-endpoints.json");
  if (!fs.existsSync(p)) throw new Error(`缺少资源：${p}`);
  const json = JSON.parse(fs.readFileSync(p, "utf8"));
  const endpoints = Array.isArray(json?.endpoints) ? json.endpoints.map(normalizeEndpoint).filter(Boolean) : [];
  if (!endpoints.length) throw new Error("llm-endpoints 为空");
  return { endpoints };
}

async function testProxy({ context }: { context: any }): Promise<{ ok: boolean; status: number }> {
  const cfg = await loadByokConfigResolved({ context });
  const url = joinBaseUrl(assertHttpBaseUrl(cfg.proxy.baseUrl), "get-models");
  const auth = buildBearerAuthHeader(cfg.proxy.token);
  if (!auth) throw new Error("Token 未配置");
  const resp = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: auth }, body: "{}", signal: AbortSignal.timeout(8000) });
  const ok = resp.status !== 401 && resp.status !== 404;
  return { ok, status: resp.status };
}

async function listModels({
  context,
  providerId,
  baseUrl,
  apiKey,
  env = process.env
}: {
  context: any;
  providerId: string;
  baseUrl?: string;
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ models: string[] }> {
  const cfg = await loadByokConfigResolved({ context, env });
  const pid = normalizeString(providerId);
  if (!pid) throw new Error("缺少 providerId");
  const p = cfg.providers.find((x) => x.id === pid);
  if (!p) throw new Error(`未知 Provider: ${pid}`);
  const b = normalizeString(baseUrl) || normalizeString(p.baseUrl);
  if (!b) throw new Error(`Provider(${pid}) 缺少 baseUrl`);
  const rawKey = normalizeString(apiKey) || normalizeString(p.secrets.apiKey || p.secrets.token || "");
  const key = rawKey ? resolveSecretOrThrow(rawKey, env) : "";
  if (!key) throw new Error(`Provider(${pid}) 缺少 apiKey/token`);
  const timeoutMs = 12_000;

  if (p.type === "openai_compatible") {
    const models = await openAiListModels({ baseUrl: b, apiKey: key, timeoutMs });
    await saveCachedProviderModels({ context, providerId: pid, baseUrl: b, models });
    return { models };
  }
  if (p.type === "anthropic_native") {
    const models = await anthropicListModels({ baseUrl: b, apiKey: key, timeoutMs });
    await saveCachedProviderModels({ context, providerId: pid, baseUrl: b, models });
    return { models };
  }
  throw new Error(`未知 Provider type: ${String((p as any).type)}`);
}

export function registerByokPanel({ vscode, context, logger = console }: { vscode: any; context: any; logger?: Console }): void {
  try {
    const commands = vscode?.commands;
    const window = vscode?.window;
    if (!commands || typeof commands.registerCommand !== "function") return;
    if (!window || typeof window.createWebviewPanel !== "function") return;

    if ((globalThis as any)[AUGMENT_BYOK.byokPanelPatchedGlobalKey]) return;
    (globalThis as any)[AUGMENT_BYOK.byokPanelPatchedGlobalKey] = true;

    let panel: any = null;

    const openPanel = () => {
      if (panel) {
        try {
          panel.reveal?.();
        } catch {
          // ignore
        }
        return;
      }

      panel = window.createWebviewPanel(VIEW_TYPE, TITLE, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
      try {
        panel.onDidDispose(() => (panel = null));
      } catch {
        // ignore
      }

      try {
        panel.webview.html = buildPanelHtml({ context, webview: panel.webview });
      } catch (e: any) {
        panel.webview.html = `<html><body><pre>${String(e?.message || e)}</pre></body></html>`;
      }

      let opChain: Promise<void> = Promise.resolve();
      const runExclusive = async (fn: () => Promise<void>) => {
        const next = opChain.then(fn, fn);
        opChain = next.then(
          () => void 0,
          () => void 0
        );
        return await next;
      };

      const post = async (requestId: string, payload: any) => {
        try {
          await panel.webview.postMessage({ type: "byok-rpc-response", requestId, ...payload });
        } catch {
          // ignore
        }
      };

      panel.webview.onDidReceiveMessage((msg: any) => {
        if (!msg || typeof msg !== "object") return;
        if (msg.type !== "byok-rpc") return;
        const requestId = typeof msg.requestId === "string" ? msg.requestId : "";
        const method = typeof msg.method === "string" ? msg.method : "";
        const params = msg.params;
        if (!requestId || !method) return;

        void runExclusive(async () => {
          try {
            if (method === "load") {
              const config = await loadByokConfigRaw({ context });
              const modelsCache = await loadProviderModelsCacheRaw({ context });
              const proxyTokenRaw = normalizeString(await context.secrets.get(`${AUGMENT_BYOK.byokSecretPrefix}.proxy.token`));
              const tokenStatus = !proxyTokenRaw ? "missing" : parseEnvPlaceholder(proxyTokenRaw) ? "env" : "set";
              const providersStatus: Record<string, { apiKey: string }> = {};
              const providersModelsCache: Record<string, { updatedAtMs: number; models: string[] }> = {};
              for (const p of config.providers) {
                const apiKeyRaw = normalizeString(await context.secrets.get(`${AUGMENT_BYOK.byokSecretPrefix}.provider.${p.id}.apiKey`));
                providersStatus[p.id] = { apiKey: !apiKeyRaw ? "missing" : parseEnvPlaceholder(apiKeyRaw) ? "env" : "set" };
                const cached = modelsCache.providers[p.id];
                if (cached && normalizeString(cached.baseUrl).replace(/\/+$/, "") === normalizeString(p.baseUrl).replace(/\/+$/, "")) {
                  providersModelsCache[p.id] = { updatedAtMs: cached.updatedAtMs, models: cached.models };
                }
              }
              await post(requestId, { ok: true, result: { config, secretStatus: { proxy: { token: tokenStatus }, providers: providersStatus }, modelsCache: providersModelsCache } });
              return;
            }

            if (method === "save") {
              const cfg = params && typeof params === "object" ? (params as any).config : null;
              const proxyToken = params && typeof params === "object" ? normalizeString((params as any).proxyToken) : "";
              const clearProxyToken = Boolean(params && typeof params === "object" ? (params as any).clearProxyToken : false);
              const providerSecretsById = params && typeof params === "object" ? (params as any).providerSecretsById : null;
              const enabled = Boolean(cfg && typeof cfg === "object" ? (cfg as any).enabled : false);
              if (enabled) {
                assertHttpBaseUrl(cfg && typeof cfg === "object" ? (cfg as any)?.proxy?.baseUrl : "");
                const storedRaw = normalizeString(await context.secrets.get(`${AUGMENT_BYOK.byokSecretPrefix}.proxy.token`));
                const nextTokenRaw = proxyToken ? proxyToken : clearProxyToken ? "" : storedRaw;
                const nextToken = nextTokenRaw ? resolveSecretOrThrow(nextTokenRaw, process.env) : "";
                if (!normalizeRawToken(nextToken)) throw new Error("Token 未配置");
              }
              await saveByokConfig({
                context,
                config: cfg,
                proxyToken: proxyToken || undefined,
                clearProxyToken,
                secretsByProviderId: providerSecretsById && typeof providerSecretsById === "object" ? providerSecretsById : undefined
              });
              await post(requestId, { ok: true, result: { ok: true } });
              return;
            }

            if (method === "export") {
              const includeSecrets = Boolean(params && typeof params === "object" ? (params as any).includeSecrets : false);
              const data = await exportByokConfig({ context, includeSecrets });
              await post(requestId, { ok: true, result: data });
              return;
            }

            if (method === "import") {
              const jsonText = normalizeString(params && typeof params === "object" ? (params as any).jsonText : "");
              const overwriteSecrets = Boolean(params && typeof params === "object" ? (params as any).overwriteSecrets : false);
              if (!jsonText) throw new Error("缺少 jsonText");
              const data = JSON.parse(jsonText);
              await importByokConfig({ context, data, overwriteSecrets });
              await post(requestId, { ok: true, result: { ok: true } });
              return;
            }

            if (method === "testProxy") {
              const r = await testProxy({ context });
              await post(requestId, { ok: true, result: r });
              return;
            }

            if (method === "getLlmEndpoints") {
              const r = await getLlmEndpoints({ context });
              await post(requestId, { ok: true, result: r });
              return;
            }

            if (method === "listModels") {
              const providerId = normalizeString(params && typeof params === "object" ? (params as any).providerId : "");
              const baseUrl = normalizeString(params && typeof params === "object" ? (params as any).baseUrl : "");
              const apiKey = normalizeString(params && typeof params === "object" ? (params as any).apiKey : "");
              const r = await listModels({ context, providerId, baseUrl: baseUrl || undefined, apiKey: apiKey || undefined });
              await post(requestId, { ok: true, result: r });
              return;
            }

            throw new Error(`未知方法：${method}`);
          } catch (e: any) {
            const error = String(e?.message || e);
            try {
              logger.warn?.(`[BYOK] panel rpc failed (${method}): ${error}`);
            } catch {
              // ignore
            }
            await post(requestId, { ok: false, error });
          }
        });
      });
    };

    const disposable = commands.registerCommand(COMMAND_ID, openPanel);
    try {
      context?.subscriptions?.push?.(disposable);
    } catch {
      // ignore
    }
  } catch {
    // ignore
  }
}
