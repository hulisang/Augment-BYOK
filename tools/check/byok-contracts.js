#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

function fail(msg) {
  console.error(`[contracts] ERROR: ${String(msg || "unknown error")}`);
  process.exit(1);
}

function ok(msg) {
  console.log(`[contracts] ${String(msg || "")}`);
}

function assert(cond, msg) {
  if (!cond) fail(msg);
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function readJson(filePath) {
  const txt = readText(filePath);
  return JSON.parse(txt);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a || typeof a !== "string" || !a.startsWith("--")) continue;
    const k = a.slice(2);
    const next = argv[i + 1];
    const v = next && typeof next === "string" && !next.startsWith("--") ? next : "1";
    if (v !== "1") i += 1;
    out[k] = v;
  }
  return out;
}

function assertFileExists(root, rel) {
  const p = path.join(root, rel);
  assert(fs.existsSync(p), `missing file: ${rel}`);
  return p;
}

function assertContains(src, needle, label) {
  assert(src.includes(needle), `missing needle (${label || "unknown"}): ${JSON.stringify(needle)}`);
}

function assertHasCommand(pkg, cmd) {
  const commands = Array.isArray(pkg?.contributes?.commands) ? pkg.contributes.commands : [];
  const okCmd = commands.some((c) => c && typeof c.command === "string" && c.command === cmd);
  assert(okCmd, `package.json missing command: ${cmd}`);
}

function assertModelRegistryFlags(flags) {
  assert(flags && typeof flags === "object" && !Array.isArray(flags), "feature_flags not object");
  assert(flags.enableModelRegistry === true || flags.enable_model_registry === true, "enableModelRegistry missing/false");
  assert(typeof flags.modelRegistry === "string" || typeof flags.model_registry === "string", "modelRegistry missing");
  assert(typeof flags.modelInfoRegistry === "string" || typeof flags.model_info_registry === "string", "modelInfoRegistry missing");
  assert(typeof flags.agentChatModel === "string" || typeof flags.agent_chat_model === "string", "agentChatModel missing");
}

function findAssetFile(assetsDir, fileRe, { mustContain } = {}) {
  const files = fs.readdirSync(assetsDir).filter((f) => fileRe.test(f)).sort();
  for (const f of files) {
    const p = path.join(assetsDir, f);
    if (!mustContain) return p;
    const txt = readText(p);
    if (txt.includes(mustContain)) return p;
  }
  return null;
}

function listAssetCandidates(assetsDir, fileRe, { max = 20 } = {}) {
  try {
    const files = fs.readdirSync(assetsDir).filter((f) => fileRe.test(f)).sort();
    const lim = Number.isFinite(Number(max)) && Number(max) > 0 ? Math.floor(Number(max)) : 20;
    return files.slice(0, lim);
  } catch {
    return [];
  }
}

function parseNumericEnumPairs(minifiedJs) {
  const src = typeof minifiedJs === "string" ? minifiedJs : "";
  const out = {};
  const re = /\b[a-zA-Z_$][\w$]*\[\s*[a-zA-Z_$][\w$]*\.([A-Z0-9_]+)\s*=\s*([0-9]+)\s*\]\s*=\s*"\1"/g;
  for (const m of src.matchAll(re)) out[m[1]] = Number(m[2]);
  return out;
}

function assertUpstreamEnumEq(label, upstreamMap, key, expected) {
  assert(Object.prototype.hasOwnProperty.call(upstreamMap, key), `${label} missing key: ${key}`);
  assert(upstreamMap[key] === expected, `${label} mismatch ${key}: upstream=${upstreamMap[key]} expected=${expected}`);
}

function assertProtocolEnumsAligned(extensionDir, augmentProtocol, augmentChatShared, augmentNodeFormat) {
  const assetsDir = path.join(extensionDir, "common-webviews", "assets");
  assert(fs.existsSync(assetsDir), `assets dir not found: ${assetsDir}`);

  const brokerPath = findAssetFile(assetsDir, /^message-broker-.*\.js$/, { mustContain: "HISTORY_SUMMARY" });
  if (!brokerPath) {
    const cands = listAssetCandidates(assetsDir, /^message-broker-.*\.js$/);
    fail(`failed to locate message-broker-*.js in upstream assets (need "HISTORY_SUMMARY"); candidates=${cands.join(",") || "(none)"}`);
  }
  const brokerEnums = parseNumericEnumPairs(readText(brokerPath));

  const requestNodeExpected = {
    TEXT: augmentProtocol.REQUEST_NODE_TEXT,
    TOOL_RESULT: augmentProtocol.REQUEST_NODE_TOOL_RESULT,
    IMAGE: augmentProtocol.REQUEST_NODE_IMAGE,
    IMAGE_ID: augmentProtocol.REQUEST_NODE_IMAGE_ID,
    IDE_STATE: augmentProtocol.REQUEST_NODE_IDE_STATE,
    EDIT_EVENTS: augmentProtocol.REQUEST_NODE_EDIT_EVENTS,
    CHECKPOINT_REF: augmentProtocol.REQUEST_NODE_CHECKPOINT_REF,
    CHANGE_PERSONALITY: augmentProtocol.REQUEST_NODE_CHANGE_PERSONALITY,
    FILE: augmentProtocol.REQUEST_NODE_FILE,
    FILE_ID: augmentProtocol.REQUEST_NODE_FILE_ID,
    HISTORY_SUMMARY: augmentProtocol.REQUEST_NODE_HISTORY_SUMMARY
  };
  for (const [k, v] of Object.entries(requestNodeExpected)) assertUpstreamEnumEq("request_node_type", brokerEnums, k, v);

  const responseNodeExpected = {
    RAW_RESPONSE: augmentProtocol.RESPONSE_NODE_RAW_RESPONSE,
    SUGGESTED_QUESTIONS: augmentProtocol.RESPONSE_NODE_SUGGESTED_QUESTIONS,
    MAIN_TEXT_FINISHED: augmentProtocol.RESPONSE_NODE_MAIN_TEXT_FINISHED,
    TOOL_USE: augmentProtocol.RESPONSE_NODE_TOOL_USE,
    AGENT_MEMORY: augmentProtocol.RESPONSE_NODE_AGENT_MEMORY,
    TOOL_USE_START: augmentProtocol.RESPONSE_NODE_TOOL_USE_START,
    THINKING: augmentProtocol.RESPONSE_NODE_THINKING,
    BILLING_METADATA: augmentProtocol.RESPONSE_NODE_BILLING_METADATA,
    TOKEN_USAGE: augmentProtocol.RESPONSE_NODE_TOKEN_USAGE
  };
  for (const [k, v] of Object.entries(responseNodeExpected)) assertUpstreamEnumEq("response_node_type", brokerEnums, k, v);

  const imageFormatExpected = {
    IMAGE_FORMAT_UNSPECIFIED: augmentProtocol.IMAGE_FORMAT_UNSPECIFIED,
    PNG: augmentProtocol.IMAGE_FORMAT_PNG,
    JPEG: augmentProtocol.IMAGE_FORMAT_JPEG,
    GIF: augmentProtocol.IMAGE_FORMAT_GIF,
    WEBP: augmentProtocol.IMAGE_FORMAT_WEBP
  };
  for (const [k, v] of Object.entries(imageFormatExpected)) assertUpstreamEnumEq("image_format", brokerEnums, k, v);

  const personaExpected = {
    PROTOTYPER: augmentProtocol.PERSONA_PROTOTYPER,
    BRAINSTORM: augmentProtocol.PERSONA_BRAINSTORM,
    REVIEWER: augmentProtocol.PERSONA_REVIEWER
  };
  for (const [k, v] of Object.entries(personaExpected)) assertUpstreamEnumEq("persona_type", brokerEnums, k, v);

  const toolResultContentTypeExpected = {
    CONTENT_TEXT: augmentProtocol.TOOL_RESULT_CONTENT_TEXT,
    CONTENT_IMAGE: augmentProtocol.TOOL_RESULT_CONTENT_IMAGE
  };
  for (const [k, v] of Object.entries(toolResultContentTypeExpected)) assertUpstreamEnumEq("tool_result_content_type", brokerEnums, k, v);

  const typesPath = findAssetFile(assetsDir, /^types-.*\.js$/, { mustContain: "MALFORMED_FUNCTION_CALL" });
  if (!typesPath) {
    const cands = listAssetCandidates(assetsDir, /^types-.*\.js$/);
    fail(`failed to locate types-*.js in upstream assets (need "MALFORMED_FUNCTION_CALL"); candidates=${cands.join(",") || "(none)"}`);
  }
  const stopEnums = parseNumericEnumPairs(readText(typesPath));

  const stopExpected = {
    REASON_UNSPECIFIED: augmentProtocol.STOP_REASON_UNSPECIFIED,
    END_TURN: augmentProtocol.STOP_REASON_END_TURN,
    MAX_TOKENS: augmentProtocol.STOP_REASON_MAX_TOKENS,
    TOOL_USE_REQUESTED: augmentProtocol.STOP_REASON_TOOL_USE_REQUESTED,
    SAFETY: augmentProtocol.STOP_REASON_SAFETY,
    RECITATION: augmentProtocol.STOP_REASON_RECITATION,
    MALFORMED_FUNCTION_CALL: augmentProtocol.STOP_REASON_MALFORMED_FUNCTION_CALL
  };
  for (const [k, v] of Object.entries(stopExpected)) assertUpstreamEnumEq("stop_reason", stopEnums, k, v);

  assert(typeof augmentChatShared?.mapImageFormatToMimeType === "function", "augment-chat.shared.mapImageFormatToMimeType missing");
  assert(augmentChatShared.mapImageFormatToMimeType(imageFormatExpected.PNG) === "image/png", "mapImageFormatToMimeType(PNG) mismatch");
  assert(augmentChatShared.mapImageFormatToMimeType(imageFormatExpected.JPEG) === "image/jpeg", "mapImageFormatToMimeType(JPEG) mismatch");
  assert(augmentChatShared.mapImageFormatToMimeType(imageFormatExpected.GIF) === "image/gif", "mapImageFormatToMimeType(GIF) mismatch");
  assert(augmentChatShared.mapImageFormatToMimeType(imageFormatExpected.WEBP) === "image/webp", "mapImageFormatToMimeType(WEBP) mismatch");

  assert(typeof augmentNodeFormat?.personaTypeToLabel === "function", "augment-node-format.personaTypeToLabel missing");
  assert(augmentNodeFormat.personaTypeToLabel(personaExpected.PROTOTYPER) === "PROTOTYPER", "personaTypeToLabel(PROTOTYPER) mismatch");
  assert(augmentNodeFormat.personaTypeToLabel(personaExpected.BRAINSTORM) === "BRAINSTORM", "personaTypeToLabel(BRAINSTORM) mismatch");
  assert(augmentNodeFormat.personaTypeToLabel(personaExpected.REVIEWER) === "REVIEWER", "personaTypeToLabel(REVIEWER) mismatch");

  ok("protocol enums aligned with upstream assets");
}

function assertAugmentProtocolShapes(augmentProtocol) {
  assert(augmentProtocol && typeof augmentProtocol === "object", "augment-protocol not object");
  assert(typeof augmentProtocol.makeBackChatChunk === "function", "augment-protocol.makeBackChatChunk missing");
  assert(typeof augmentProtocol.rawResponseNode === "function", "augment-protocol.rawResponseNode missing");
  assert(typeof augmentProtocol.mainTextFinishedNode === "function", "augment-protocol.mainTextFinishedNode missing");
  assert(typeof augmentProtocol.toolUseNode === "function", "augment-protocol.toolUseNode missing");
  assert(typeof augmentProtocol.toolUseStartNode === "function", "augment-protocol.toolUseStartNode missing");
  assert(typeof augmentProtocol.thinkingNode === "function", "augment-protocol.thinkingNode missing");
  assert(typeof augmentProtocol.tokenUsageNode === "function", "augment-protocol.tokenUsageNode missing");

  const chunk = augmentProtocol.makeBackChatChunk({ text: "hi" });
  assert(chunk && typeof chunk === "object", "makeBackChatChunk must return object");
  assert(typeof chunk.text === "string", "makeBackChatChunk.text must be string");
  assert(Array.isArray(chunk.unknown_blob_names), "makeBackChatChunk.unknown_blob_names must be array");
  assert(typeof chunk.checkpoint_not_found === "boolean", "makeBackChatChunk.checkpoint_not_found must be boolean");
  assert(Array.isArray(chunk.workspace_file_chunks), "makeBackChatChunk.workspace_file_chunks must be array");

  const chunkWithStop = augmentProtocol.makeBackChatChunk({ text: "", stop_reason: augmentProtocol.STOP_REASON_END_TURN });
  assert(typeof chunkWithStop.stop_reason === "number", "makeBackChatChunk.stop_reason must be number when present");

  const chunkWithEmptyNodes = augmentProtocol.makeBackChatChunk({ text: "", nodes: [], includeNodes: true });
  assert(Array.isArray(chunkWithEmptyNodes.nodes), "makeBackChatChunk(includeNodes).nodes must be array");

  const raw = augmentProtocol.rawResponseNode({ id: 1, content: "x" });
  assert(raw && typeof raw === "object", "rawResponseNode must return object");
  assert(raw.type === augmentProtocol.RESPONSE_NODE_RAW_RESPONSE, "rawResponseNode.type mismatch");
  assert(typeof raw.id === "number", "rawResponseNode.id must be number");
  assert(typeof raw.content === "string", "rawResponseNode.content must be string");

  const main = augmentProtocol.mainTextFinishedNode({ id: 2, content: "done" });
  assert(main.type === augmentProtocol.RESPONSE_NODE_MAIN_TEXT_FINISHED, "mainTextFinishedNode.type mismatch");
  assert(typeof main.content === "string", "mainTextFinishedNode.content must be string");

  const tu = augmentProtocol.toolUseNode({ id: 3, toolUseId: "tool_1", toolName: "my_tool", inputJson: "{\"a\":1}" });
  assert(tu.type === augmentProtocol.RESPONSE_NODE_TOOL_USE, "toolUseNode.type mismatch");
  assert(typeof tu.content === "string", "toolUseNode.content must be string");
  assert(tu.tool_use && typeof tu.tool_use === "object" && !Array.isArray(tu.tool_use), "toolUseNode.tool_use must be object");
  assert(typeof tu.tool_use.tool_use_id === "string", "toolUseNode.tool_use.tool_use_id must be string");
  assert(typeof tu.tool_use.tool_name === "string", "toolUseNode.tool_use.tool_name must be string");
  assert(typeof tu.tool_use.input_json === "string", "toolUseNode.tool_use.input_json must be string");

  const tus = augmentProtocol.toolUseStartNode({ id: 4, toolUseId: "tool_1", toolName: "my_tool", inputJson: "{\"a\":1}" });
  assert(tus.type === augmentProtocol.RESPONSE_NODE_TOOL_USE_START, "toolUseStartNode.type mismatch");
  assert(tus.tool_use && typeof tus.tool_use === "object", "toolUseStartNode.tool_use must be object");

  const think = augmentProtocol.thinkingNode({ id: 5, summary: "hmm" });
  assert(think.type === augmentProtocol.RESPONSE_NODE_THINKING, "thinkingNode.type mismatch");
  assert(think.thinking && typeof think.thinking === "object", "thinkingNode.thinking must be object");
  assert(typeof think.thinking.summary === "string", "thinkingNode.thinking.summary must be string");

  const usage = augmentProtocol.tokenUsageNode({ id: 6, inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 });
  assert(usage.type === augmentProtocol.RESPONSE_NODE_TOKEN_USAGE, "tokenUsageNode.type mismatch");
  assert(usage.token_usage && typeof usage.token_usage === "object", "tokenUsageNode.token_usage must be object");
  assert(usage.token_usage.input_tokens === 1, "tokenUsageNode.input_tokens mismatch");
  assert(usage.token_usage.output_tokens === 2, "tokenUsageNode.output_tokens mismatch");
  assert(usage.token_usage.cache_read_input_tokens === 3, "tokenUsageNode.cache_read_input_tokens mismatch");
  assert(usage.token_usage.cache_creation_input_tokens === 4, "tokenUsageNode.cache_creation_input_tokens mismatch");

  ok("augment-protocol shapes ok");
}

function main() {
  const args = parseArgs(process.argv);
  const extensionDir = path.resolve(String(args.extensionDir || ""));
  const extJsPath = path.resolve(String(args.extJs || ""));
  const pkgPath = path.resolve(String(args.pkg || ""));

  assert(extensionDir && extensionDir !== path.parse(extensionDir).root, "missing --extensionDir");
  assert(extJsPath && extJsPath !== path.parse(extJsPath).root, "missing --extJs");
  assert(pkgPath && pkgPath !== path.parse(pkgPath).root, "missing --pkg");

  ok(`extensionDir=${extensionDir}`);

  assert(fs.existsSync(extensionDir), `extensionDir not found: ${extensionDir}`);
  assert(fs.existsSync(extJsPath), `extJs not found: ${extJsPath}`);
  assert(fs.existsSync(pkgPath), `package.json not found: ${pkgPath}`);

  const requiredRelFiles = [
    "out/byok/runtime/bootstrap.js",
    "out/byok/runtime/byok-chat-dispatch.js",
    "out/byok/runtime/shim-call-api.js",
    "out/byok/runtime/shim-call-api-stream.js",
    "out/byok/runtime/shim-byok-chat.js",
    "out/byok/runtime/shim-route.js",
    "out/byok/runtime/upstream-assets.js",
    "out/byok/runtime/upstream-checkpoints.js",
    "out/byok/runtime/upstream-discovery.js",
    "out/byok/runtime/workspace-file-chunks.js",
    "out/byok/config/config.js",
    "out/byok/config/state.js",
    "out/byok/config/official.js",
    "out/byok/core/router.js",
    "out/byok/core/protocol.js",
    "out/byok/core/model-registry.js",
    "out/byok/core/augment-protocol.js",
    "out/byok/core/augment-chat.shared.js",
    "out/byok/core/augment-chat.shared-nodes.js",
    "out/byok/core/augment-chat.shared-tools.js",
    "out/byok/core/augment-chat.shared-request.js",
    "out/byok/core/augment-node-format.js",
    "out/byok/core/tool-pairing.js",
    "out/byok/core/tool-pairing.common.js",
    "out/byok/core/tool-pairing.openai.js",
    "out/byok/core/tool-pairing.openai-responses.js",
    "out/byok/core/tool-pairing.anthropic.js",
    "out/byok/infra/util.js",
    "out/byok/infra/log.js",
    "out/byok/providers/openai.js",
    "out/byok/providers/chat-chunks-util.js",
    "out/byok/providers/openai-chat-completions-util.js",
    "out/byok/providers/openai-chat-completions-json-util.js",
    "out/byok/providers/openai-responses.js",
    "out/byok/providers/openai-responses-util.js",
    "out/byok/providers/anthropic.js",
    "out/byok/providers/anthropic-request.js",
    "out/byok/providers/anthropic-json-util.js",
    "out/byok/providers/gemini.js",
    "out/byok/providers/gemini-json-util.js",
    "out/byok/ui/config-panel.js",
    "out/byok/ui/config-panel.html.js",
    "out/byok/ui/config-panel.webview.js",
    "out/byok/ui/config-panel.webview.render.js"
  ];
  for (const rel of requiredRelFiles) assertFileExists(extensionDir, rel);
  ok(`required files ok (${requiredRelFiles.length})`);

  const pkg = readJson(pkgPath);
  assertHasCommand(pkg, "augment-byok.enable");
  assertHasCommand(pkg, "augment-byok.disable");
  assertHasCommand(pkg, "augment-byok.reloadConfig");
  assertHasCommand(pkg, "augment-byok.openConfigPanel");
  ok("package.json commands ok");

  const extJs = readText(extJsPath);
  assertContains(extJs, "__augment_byok_augment_interceptor_injected_v1", "augment interceptor injected");
  assertContains(extJs, "__augment_byok_bootstrap_injected_v1", "bootstrap injected");
  assertContains(extJs, "__augment_byok_expose_upstream_v1", "expose upstream (toolsModel) injected");
  assertContains(extJs, "__augment_byok_official_overrides_patched_v1", "official overrides patched");
  assertContains(extJs, "__augment_byok_callapi_shim_patched_v1", "callApi shim patched");
  assert(!extJs.includes("case \"/autoAuth\"") && !extJs.includes("handleAutoAuth"), "autoAuth guard failed (post-check)");
  ok("extension.js markers ok");

  const byokDir = path.join(extensionDir, "out", "byok");
  const coreDir = path.join(byokDir, "core");
  const configDir = path.join(byokDir, "config");
  const infraDir = path.join(byokDir, "infra");
  const modelRegistry = require(path.join(coreDir, "model-registry.js"));
  const protocol = require(path.join(coreDir, "protocol.js"));
  const augmentProtocol = require(path.join(coreDir, "augment-protocol.js"));
  const augmentChatShared = require(path.join(coreDir, "augment-chat.shared.js"));
  const augmentNodeFormat = require(path.join(coreDir, "augment-node-format.js"));
  const config = require(path.join(configDir, "config.js"));
  const router = require(path.join(coreDir, "router.js"));
  const util = require(path.join(infraDir, "util.js"));

  assertProtocolEnumsAligned(extensionDir, augmentProtocol, augmentChatShared, augmentNodeFormat);
  assertAugmentProtocolShapes(augmentProtocol);

  const sampleByokId = "byok:openai:gpt-4o-mini";
  const flags = modelRegistry.ensureModelRegistryFeatureFlags({}, { byokModelIds: [sampleByokId], defaultModel: sampleByokId });
  assertModelRegistryFlags(flags);
  const regJson = JSON.parse(flags.modelRegistry || flags.model_registry || "{}");
  assert(regJson["openai: gpt-4o-mini"] === sampleByokId, "modelRegistry missing mapping: openai: gpt-4o-mini");
  ok("model registry flags ok");

  const getModels = protocol.makeBackGetModelsResult({ defaultModel: sampleByokId, models: [protocol.makeModelInfo(sampleByokId)] });
  assert(getModels && typeof getModels === "object", "makeBackGetModelsResult not object");
  assertModelRegistryFlags(getModels.feature_flags);
  ok("makeBackGetModelsResult contract ok");

  const cfg = config.defaultConfig();
  const r = router.decideRoute({ cfg, endpoint: "/chat-stream", body: { model: sampleByokId }, runtimeEnabled: true });
  assert(r && r.mode === "byok", "router.decideRoute expected mode=byok");
  assert(r.provider && r.provider.id === "openai", "router.decideRoute expected provider=openai");
  assert(r.model === "gpt-4o-mini", "router.decideRoute expected model=gpt-4o-mini");
  ok("router decideRoute contract ok");

  assert(util.parseByokModelId(sampleByokId)?.providerId === "openai", "util.parseByokModelId parse failed");
  let threw = false;
  try {
    util.parseByokModelId("byok:badformat", { strict: true });
  } catch {
    threw = true;
  }
  assert(threw, "util.parseByokModelId(strict) should throw on invalid byok format");
  ok("util parseByokModelId contract ok");

  ok("ALL CONTRACTS OK");
}

main();
