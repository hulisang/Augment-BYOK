import { AUGMENT_BYOK } from "../constants";
import type { InstallArgs } from "../types";
import { registerByokPanel } from "../coord/byok-panel/register-byok-panel";
import { installSettingsMemoriesRpc } from "../coord/vsix-patch-set/install-settings-memories-rpc";
import { loadByokConfigResolved } from "../mol/byok-storage/byok-config";
import { assertHttpBaseUrl, ensureTrailingSlash, normalizeRawToken } from "../atom/common/http";

const UPSTREAM_CONFIG_OVERRIDE_KEY = "__augment_byok_upstream_config_override";

async function maybeInstallUpstreamConfigOverride({ vscode, context, logger }: { vscode: any; context: any; logger: any }): Promise<void> {
  try {
    const cfg = await loadByokConfigResolved({ context });
    if (!cfg.enabled) return;
    const completionURL = ensureTrailingSlash(assertHttpBaseUrl(cfg.proxy.baseUrl));
    const apiToken = normalizeRawToken(cfg.proxy.token);
    if (!apiToken) throw new Error("Token 未配置");
    (globalThis as any)[UPSTREAM_CONFIG_OVERRIDE_KEY] = { enabled: true, completionURL, apiToken };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      logger.warn?.(`[BYOK] upstream config override skipped: ${msg}`);
    } catch {
      // ignore
    }
    try {
      vscode?.window?.showErrorMessage?.(`[Augment BYOK] 上游配置注入失败：${msg}`);
    } catch {
      // ignore
    }
  }
}

export function install({ vscode, getActivate, setActivate }: InstallArgs): void {
  if (typeof getActivate !== "function" || typeof setActivate !== "function") return;
  if ((globalThis as any)[AUGMENT_BYOK.patchedGlobalKey]) return;

  const originalActivate = getActivate();
  if (typeof originalActivate !== "function") return;
  (globalThis as any)[AUGMENT_BYOK.patchedGlobalKey] = true;

  setActivate(async (context: any) => {
    const logger = console;
    try {
      (globalThis as any)[AUGMENT_BYOK.extensionContextGlobalKey] = context;
    } catch {
      // ignore
    }
    await maybeInstallUpstreamConfigOverride({ vscode, context, logger });
    installSettingsMemoriesRpc({ vscode, context, logger });
    registerByokPanel({ vscode, context, logger });
    return await (originalActivate as any)(context);
  });
}
