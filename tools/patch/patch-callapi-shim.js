#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const { ensureMarker } = require("../lib/patch");

const MARKER = "__augment_byok_callapi_shim_patched_v1";

function findMatchIndexes(src, re, label) {
  const matches = Array.from(src.matchAll(re));
  if (matches.length === 0) throw new Error(`${label} needle not found (upstream may have changed): matched=0`);
  const indexes = matches.map((m) => m.index).filter((i) => typeof i === "number" && i >= 0);
  if (indexes.length !== matches.length) throw new Error(`${label} needle match missing index`);
  return indexes.sort((a, b) => a - b);
}

function injectIntoAsyncMethods(src, methodName, injection) {
  const indexes = findMatchIndexes(src, new RegExp(`async\\s+${methodName}\\s*\\(`, "g"), methodName);
  let out = src;
  for (let i = indexes.length - 1; i >= 0; i--) {
    const idx = indexes[i];
    const openBrace = out.indexOf("{", idx);
    if (openBrace < 0) throw new Error(`${methodName} patch: failed to locate method body opening brace`);
    out = out.slice(0, openBrace + 1) + injection + out.slice(openBrace + 1);
  }
  return { out, count: indexes.length };
}

function patchCallApiShim(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`missing file: ${filePath}`);
  const original = fs.readFileSync(filePath, "utf8");
  if (original.includes(MARKER)) return { changed: false, reason: "already_patched" };

  const callApiShimPath = "./byok/runtime/shim-call-api";
  const callApiStreamShimPath = "./byok/runtime/shim-call-api-stream";

  const sanitizeBody =
    `const __byok_body=arguments[3];` +
    `if(__byok_body&&typeof __byok_body==="object"){` +
    `try{delete __byok_body.third_party_override}catch{}` +
    `try{delete __byok_body.thirdPartyOverride}catch{}` +
    `}`;

  function makeInjection({ shimPath, exportName }) {
    return (
      `const __byok_ep=typeof arguments[2]==="string"?arguments[2]:"";` +
      sanitizeBody +
      `const __byok_url=typeof arguments[5]==="string"?arguments[5]:(arguments[5]&&typeof arguments[5].toString==="function"?arguments[5].toString():"");` +
      `const __byok_res=await require("${shimPath}").${exportName}({endpoint:__byok_ep,body:arguments[3],transform:arguments[4],timeoutMs:arguments[6],abortSignal:arguments[8],upstreamApiToken:(arguments[10]??((arguments[1]||{}).apiToken)),upstreamCompletionURL:__byok_url});` +
      `if(__byok_res!==void 0)return __byok_res;`
    );
  }

  const apiInjection = makeInjection({ shimPath: callApiShimPath, exportName: "maybeHandleCallApi" });
  const streamInjection = makeInjection({ shimPath: callApiStreamShimPath, exportName: "maybeHandleCallApiStream" });

  let next = original;
  const apiRes = injectIntoAsyncMethods(next, "callApi", apiInjection);
  next = apiRes.out;
  const streamRes = injectIntoAsyncMethods(next, "callApiStream", streamInjection);
  next = streamRes.out;

  next = ensureMarker(next, MARKER);
  fs.writeFileSync(filePath, next, "utf8");
  return { changed: true, reason: "patched", callApiPatched: apiRes.count, callApiStreamPatched: streamRes.count };
}

module.exports = { patchCallApiShim };

if (require.main === module) {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error(`usage: ${path.basename(process.argv[1])} <extension/out/extension.js>`);
    process.exit(2);
  }
  patchCallApiShim(filePath);
}
