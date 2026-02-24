"use strict";

const fs = require("fs");
const path = require("path");

const { fail, assert, ok, readText } = require("./util");

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

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

function findEnumsAsset(assetsDir, { fileRes, mustContain, requiredKeys, label } = {}) {
  const patterns = Array.isArray(fileRes) && fileRes.length ? fileRes : [/^.*\.js$/];
  const required = Array.isArray(requiredKeys) ? requiredKeys.filter(Boolean) : [];
  const contains = typeof mustContain === "string" && mustContain.length ? mustContain : "";
  const lbl = String(label || "asset");

  for (const fileRe of patterns) {
    let files = [];
    try {
      files = fs.readdirSync(assetsDir).filter((f) => fileRe.test(f)).sort();
    } catch (err) {
      fail(`${lbl}: failed to read assets dir: ${String(err)}`);
    }
    for (const f of files) {
      const p = path.join(assetsDir, f);
      const txt = readText(p);
      if (contains && !txt.includes(contains)) continue;
      const enums = parseNumericEnumPairs(txt);
      if (required.length && !required.every((k) => hasOwn(enums, k))) continue;
      return { path: p, enums };
    }
  }
  return null;
}

function formatCandidates(assetsDir, fileRe) {
  const cands = listAssetCandidates(assetsDir, fileRe);
  return cands.join(",") || "(none)";
}

function assertUpstreamEnumEq(label, upstreamMap, key, expected) {
  assert(hasOwn(upstreamMap, key), `${label} missing key: ${key}`);
  assert(upstreamMap[key] === expected, `${label} mismatch ${key}: upstream=${upstreamMap[key]} expected=${expected}`);
}

function assertProtocolEnumsAligned(extensionDir, augmentProtocol, augmentChatShared, augmentNodeFormat) {
  const assetsDir = path.join(extensionDir, "common-webviews", "assets");
  assert(fs.existsSync(assetsDir), `assets dir not found: ${assetsDir}`);

  const brokerRes = findEnumsAsset(assetsDir, {
    label: "protocol-enums",
    fileRes: [/^message-broker-.*\.js$/, /^extension-client-context-.*\.js$/, /^.*\.js$/],
    mustContain: "HISTORY_SUMMARY",
    requiredKeys: ["TEXT", "HISTORY_SUMMARY"]
  });
  if (!brokerRes) {
    const brokerCands = formatCandidates(assetsDir, /^message-broker-.*\.js$/);
    const ctxCands = formatCandidates(assetsDir, /^extension-client-context-.*\.js$/);
    fail(
      `failed to locate a protocol-enum JS asset (need "HISTORY_SUMMARY"); candidates(message-broker)=${brokerCands} candidates(extension-client-context)=${ctxCands}`
    );
  }
  const brokerEnums = brokerRes.enums;

  const requestNodeExpected = {
    TEXT: augmentProtocol.REQUEST_NODE_TEXT,
    TOOL_RESULT: augmentProtocol.REQUEST_NODE_TOOL_RESULT,
    IMAGE: augmentProtocol.REQUEST_NODE_IMAGE,
    IMAGE_ID: augmentProtocol.REQUEST_NODE_IMAGE_ID,
    IDE_STATE: augmentProtocol.REQUEST_NODE_IDE_STATE,
    EDIT_EVENTS: augmentProtocol.REQUEST_NODE_EDIT_EVENTS,
    CHECKPOINT_REF: augmentProtocol.REQUEST_NODE_CHECKPOINT_REF,
    FILE: augmentProtocol.REQUEST_NODE_FILE,
    FILE_ID: augmentProtocol.REQUEST_NODE_FILE_ID,
    HISTORY_SUMMARY: augmentProtocol.REQUEST_NODE_HISTORY_SUMMARY
  };
  // Upstream no longer emits CHANGE_PERSONALITY (enum key removed from webview bundle),
  // but keep it optional for older upstream builds.
  if (hasOwn(brokerEnums, "CHANGE_PERSONALITY")) {
    requestNodeExpected.CHANGE_PERSONALITY = augmentProtocol.REQUEST_NODE_CHANGE_PERSONALITY;
  }
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
  const upstreamHasPersona =
    hasOwn(brokerEnums, "PROTOTYPER") && hasOwn(brokerEnums, "BRAINSTORM") && hasOwn(brokerEnums, "REVIEWER");
  if (upstreamHasPersona) {
    for (const [k, v] of Object.entries(personaExpected)) assertUpstreamEnumEq("persona_type", brokerEnums, k, v);
  }

  const toolResultContentTypeExpected = {
    CONTENT_TEXT: augmentProtocol.TOOL_RESULT_CONTENT_TEXT,
    CONTENT_IMAGE: augmentProtocol.TOOL_RESULT_CONTENT_IMAGE
  };
  for (const [k, v] of Object.entries(toolResultContentTypeExpected)) assertUpstreamEnumEq("tool_result_content_type", brokerEnums, k, v);

  let stopEnums = brokerEnums;
  if (!hasOwn(stopEnums, "MALFORMED_FUNCTION_CALL")) {
    const stopRes = findEnumsAsset(assetsDir, {
      label: "stop-reason-enums",
      fileRes: [/^types-.*\.js$/, /^extension-client-context-.*\.js$/, /^.*\.js$/],
      mustContain: "MALFORMED_FUNCTION_CALL",
      requiredKeys: ["MALFORMED_FUNCTION_CALL"]
    });
    if (!stopRes) {
      const typesCands = formatCandidates(assetsDir, /^types-.*\.js$/);
      const ctxCands = formatCandidates(assetsDir, /^extension-client-context-.*\.js$/);
      fail(
        `failed to locate stop-reason enum JS asset (need "MALFORMED_FUNCTION_CALL"); candidates(types-*)=${typesCands} candidates(extension-client-context)=${ctxCands}`
      );
    }
    stopEnums = stopRes.enums;
  }

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

  assert(typeof augmentChatShared?.mapImageFormatToMimeType === "function", "augment-chat/shared.mapImageFormatToMimeType missing");
  assert(augmentChatShared.mapImageFormatToMimeType(imageFormatExpected.PNG) === "image/png", "mapImageFormatToMimeType(PNG) mismatch");
  assert(augmentChatShared.mapImageFormatToMimeType(imageFormatExpected.JPEG) === "image/jpeg", "mapImageFormatToMimeType(JPEG) mismatch");
  assert(augmentChatShared.mapImageFormatToMimeType(imageFormatExpected.GIF) === "image/gif", "mapImageFormatToMimeType(GIF) mismatch");
  assert(augmentChatShared.mapImageFormatToMimeType(imageFormatExpected.WEBP) === "image/webp", "mapImageFormatToMimeType(WEBP) mismatch");

  assert(typeof augmentNodeFormat?.personaTypeToLabel === "function", "augment-node-format.personaTypeToLabel missing");
  if (upstreamHasPersona) {
    assert(augmentNodeFormat.personaTypeToLabel(personaExpected.PROTOTYPER) === "PROTOTYPER", "personaTypeToLabel(PROTOTYPER) mismatch");
    assert(augmentNodeFormat.personaTypeToLabel(personaExpected.BRAINSTORM) === "BRAINSTORM", "personaTypeToLabel(BRAINSTORM) mismatch");
    assert(augmentNodeFormat.personaTypeToLabel(personaExpected.REVIEWER) === "REVIEWER", "personaTypeToLabel(REVIEWER) mismatch");
  } else {
    assert(augmentNodeFormat.personaTypeToLabel(0) === "DEFAULT", "personaTypeToLabel(DEFAULT) mismatch");
  }

  ok("protocol enums aligned with upstream assets");
}

module.exports = { assertProtocolEnumsAligned };
