#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const { patchExtensionEntry } = require("../../mol/vsix-patch-set/patch-extension-entry");
const { patchApiTokenPreserveCase } = require("../../mol/vsix-patch-set/patch-api-token-preserve-case");
const { patchApiEndpointStripLeadingSlash } = require("../../mol/vsix-patch-set/patch-api-endpoint-strip-leading-slash");
const { patchUpstreamConfigOverride } = require("../../mol/vsix-patch-set/patch-upstream-config-override");
const { patchPromptEnhancerThirdPartyOverride } = require("../../mol/vsix-patch-set/patch-prompt-enhancer-third-party-override");
const { patchSecretsLocalStore } = require("../../mol/vsix-patch-set/patch-secrets-local-store");
const { patchLlmEndpointRouter } = require("../../mol/vsix-patch-set/patch-llm-endpoint-router");
const { patchSettingsMemoriesWebview } = require("../../mol/vsix-patch-set/patch-settings-memories");
const { patchSettingsSecretsWebview } = require("../../mol/vsix-patch-set/patch-settings-secrets");
const { patchPackageJsonByokPanelCommand } = require("../../mol/vsix-patch-set/patch-package-json-byok-panel-command");
const { patchExposeTooling } = require("../../mol/vsix-patch-set/patch-expose-tooling");
const { patchSuggestedQuestionsContentGuard } = require("../../mol/vsix-patch-set/patch-suggested-questions-content-guard");
const { patchSubscriptionBannerNonfatal } = require("../../mol/vsix-patch-set/patch-subscription-banner-nonfatal");

const { UPSTREAM, ensureDir, run, syncUpstreamLatest } = require("../../atom/upstream-vsix");

function rmDir(dirPath) {
  if (!fs.existsSync(dirPath)) return;
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function copyDir(srcDir, dstDir) {
  if (!fs.existsSync(srcDir)) return;
  ensureDir(dstDir);
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else if (entry.isFile()) fs.copyFileSync(src, dst);
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

async function main() {
  const repoRoot = path.resolve(__dirname, "../../..");
  const cacheDir = path.join(repoRoot, ".cache");
  const workDir = path.join(cacheDir, "work", String(Date.now()));
  const payloadDir = path.join(cacheDir, "payload", "extension");
  const distDir = path.join(repoRoot, "dist");

  ensureDir(distDir);

  const synced = await syncUpstreamLatest({ repoRoot, cacheDir, loggerPrefix: "[build]" });
  const upstreamUnpackedDir = synced.unpackDir;
  const upstreamVersion = synced.version;

  ensureDir(workDir);
  console.log(`[build] staging workdir -> ${path.relative(repoRoot, workDir)}`);
  copyDir(upstreamUnpackedDir, workDir);

  const extensionDir = path.join(workDir, "extension");
  const pkgPath = path.join(extensionDir, "package.json");
  if (!fs.existsSync(pkgPath)) throw new Error(`upstream unpack missing: ${path.relative(repoRoot, pkgPath)}`);

  console.log(`[build] overlay payload (.cache/payload/extension)`);
  if (!fs.existsSync(payloadDir)) throw new Error(`payload missing; run: pnpm build:payload (expected ${path.relative(repoRoot, payloadDir)})`);
  copyDir(payloadDir, extensionDir);

  console.log(`[build] patch entry (extension/out/extension.js)`);
  patchExtensionEntry(path.join(extensionDir, "out", "extension.js"));

  console.log(`[build] patch apiToken preserve case`);
  patchApiTokenPreserveCase(path.join(extensionDir, "out", "extension.js"));

  console.log(`[build] patch api endpoint strip leading slash`);
  patchApiEndpointStripLeadingSlash(path.join(extensionDir, "out", "extension.js"));

  console.log(`[build] patch upstream config override`);
  patchUpstreamConfigOverride(path.join(extensionDir, "out", "extension.js"));

  console.log(`[build] patch prompt-enhancer third_party_override`);
  patchPromptEnhancerThirdPartyOverride(path.join(extensionDir, "out", "extension.js"));

  console.log(`[build] patch LLM endpoint router`);
  patchLlmEndpointRouter(path.join(extensionDir, "out", "extension.js"), { llmEndpoints: readJson(path.join(repoRoot, "config", "byok-routing", "llm-endpoints.json"))?.endpoints });

  console.log(`[build] patch secrets local store`);
  patchSecretsLocalStore(path.join(extensionDir, "out", "extension.js"));

  console.log(`[build] expose chat tooling globals`);
  patchExposeTooling(path.join(extensionDir, "out", "extension.js"));

  console.log(`[build] patch settings memories webview assets`);
  patchSettingsMemoriesWebview({ extensionDir, checkOnly: false });

  console.log(`[build] patch settings secrets webview assets`);
  patchSettingsSecretsWebview({ extensionDir, checkOnly: false });

  console.log(`[build] patch suggested questions content guard`);
  patchSuggestedQuestionsContentGuard({ extensionDir });

  console.log(`[build] patch subscription banner nonfatal`);
  patchSubscriptionBannerNonfatal(path.join(extensionDir, "out", "extension.js"));

  console.log(`[build] patch package.json BYOK panel command`);
  patchPackageJsonByokPanelCommand(pkgPath);

  console.log(`[build] sanity check (node --check out/extension.js)`);
  run("node", ["--check", path.join(extensionDir, "out", "extension.js")], { cwd: repoRoot });

  const outName = `${UPSTREAM.publisher}.${UPSTREAM.extension}.${upstreamVersion}.byok-internal.vsix`;
  const outPath = path.join(distDir, outName);

  console.log(`[build] repack VSIX -> ${path.relative(repoRoot, outPath)}`);
  run("python3", [path.join(repoRoot, "tools", "atom", "zip-dir.py"), "--src", workDir, "--out", outPath], { cwd: repoRoot });

  console.log(`[build] done: ${path.relative(repoRoot, outPath)}`);
}

main().catch((err) => {
  console.error(`[build] ERROR:`, err && err.stack ? err.stack : String(err));
  process.exit(1);
});
