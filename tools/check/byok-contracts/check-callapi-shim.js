"use strict";

const { assert, ok, escapeRegExp } = require("./util");
const { findAsyncMethodParams } = require("./js-parse");

// patch-callapi-shim.js injects a minifier-robust upstreamApiToken expression using arguments[...] indexes:
// arguments[10] ?? ((arguments[1]||{}).apiToken)
const INJECTED_UPSTREAM_API_TOKEN_COALESCE_RE =
  /arguments\s*\[\s*10\s*\]\s*(?:\?\?|\|\|)\s*\(\s*\(\s*arguments\s*\[\s*1\s*\]\s*\|\|\s*\{\s*\}\s*\)\s*\.apiToken\s*\)/;

function assertCallApiShimSignatureContracts(extJs) {
  const ident = (name) => `(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`;
  const callApiNeedle = 'require("./byok/runtime/shim/call-api").maybeHandleCallApi';
  const callApiStreamNeedle = 'require("./byok/runtime/shim/call-api-stream").maybeHandleCallApiStream';

  const callApis = findAsyncMethodParams(extJs, "callApi", { mustInclude: callApiNeedle });
  assert(callApis.length > 0, `callApi contract: failed to locate patched async callApi(...) methods (needle=${callApiNeedle})`);

  const callApiMain = callApis.slice().sort((a, b) => b.params.length - a.params.length)[0];
  assert(callApiMain && typeof callApiMain === "object", "callApi contract: failed to pick main candidate");
  const callApiParamCount = callApiMain.params.length;
  assert(callApiParamCount >= 11, `callApi contract: expected a main callApi(...) with >=11 params; candidates=${callApis.map((m) => m.paramsText).join(" | ")}`);

  const cfgVar = callApiMain.names[1];
  const endpointVar = callApiMain.names[2];
  const completionUrlVar = callApiMain.names[5];
  const abortSignalVar = callApiMain.names[8];
  const apiTokenVar = callApiMain.names[10];
  assert(cfgVar && endpointVar && completionUrlVar && abortSignalVar && apiTokenVar, `callApi contract: unexpected param shapes; params=${callApiMain.paramsText}`);

  const callApiWindow = extJs.slice(callApiMain.start, Math.min(extJs.length, callApiMain.start + 9000));
  assert(
    new RegExp(`\\bnew\\s+URL\\s*\\(\\s*${escapeRegExp(endpointVar)}\\s*,\\s*${escapeRegExp(completionUrlVar)}\\s*\\)`).test(callApiWindow),
    `callApi contract: expected new URL(${endpointVar},${completionUrlVar}) within method body`
  );
  assert(
    new RegExp(`${ident(completionUrlVar)}\\s*=\\s*await\\s+this\\.clientAuth\\.getCompletionURL\\s*\\(`).test(callApiWindow),
    `callApi contract: expected ${completionUrlVar}=await this.clientAuth.getCompletionURL(...) within method body`
  );
  assert(
    new RegExp(`${ident(apiTokenVar)}\\s*=\\s*await\\s+this\\.clientAuth\\.getAPIToken\\s*\\(`).test(callApiWindow),
    `callApi contract: expected ${apiTokenVar}=await this.clientAuth.getAPIToken(...) within method body`
  );
  const apiTokenCoalesceOk =
    new RegExp(`${ident(apiTokenVar)}\\s*(?:\\?\\?|\\|\\|)\\s*${ident(cfgVar)}\\.apiToken(?![\\w$])`).test(callApiWindow) ||
    INJECTED_UPSTREAM_API_TOKEN_COALESCE_RE.test(callApiWindow);
  assert(
    apiTokenCoalesceOk,
    `callApi contract: expected ${apiTokenVar}??${cfgVar}.apiToken (or injected arguments[10]??((arguments[1]||{}).apiToken)) within method body`
  );
  assert(
    new RegExp(
      `\\.concat\\(\\s*${escapeRegExp(abortSignalVar)}\\s*\\?\\s*\\[\\s*${escapeRegExp(abortSignalVar)}\\s*\\]\\s*:\\s*\\[\\s*\\]\\s*\\)`
    ).test(callApiWindow),
    `callApi contract: expected abort signal concat pattern using ${abortSignalVar} within method body`
  );

  const callApiStreams = findAsyncMethodParams(extJs, "callApiStream", { mustInclude: callApiStreamNeedle });
  assert(callApiStreams.length > 0, `callApiStream contract: failed to locate patched async callApiStream(...) methods (needle=${callApiStreamNeedle})`);

  const callApiStreamMain = callApiStreams.slice().sort((a, b) => b.params.length - a.params.length)[0];
  assert(callApiStreamMain && typeof callApiStreamMain === "object", "callApiStream contract: failed to pick main candidate");
  const callApiStreamParamCount = callApiStreamMain.params.length;
  assert(
    callApiStreamParamCount >= 9,
    `callApiStream contract: expected a main callApiStream(...) with >=9 params; candidates=${callApiStreams.map((m) => m.paramsText).join(" | ")}`
  );

  const streamCfgVar = callApiStreamMain.names[1];
  const streamEndpointVar = callApiStreamMain.names[2];
  const streamCompletionUrlVar = callApiStreamMain.names[5];
  const streamAbortSignalVar = callApiStreamMain.names[8];
  assert(
    streamCfgVar && streamEndpointVar && streamCompletionUrlVar && streamAbortSignalVar,
    `callApiStream contract: unexpected param shapes; params=${callApiStreamMain.paramsText}`
  );

  const callApiStreamWindow = extJs.slice(callApiStreamMain.start, Math.min(extJs.length, callApiStreamMain.start + 9000));
  assert(
    new RegExp(`\\bnew\\s+URL\\s*\\(\\s*${escapeRegExp(streamEndpointVar)}\\s*,\\s*${escapeRegExp(streamCompletionUrlVar)}\\s*\\)`).test(callApiStreamWindow),
    `callApiStream contract: expected new URL(${streamEndpointVar},${streamCompletionUrlVar}) within method body`
  );
  assert(
    new RegExp(`${ident(streamCompletionUrlVar)}\\s*=\\s*await\\s+this\\.clientAuth\\.getCompletionURL\\s*\\(`).test(callApiStreamWindow),
    `callApiStream contract: expected ${streamCompletionUrlVar}=await this.clientAuth.getCompletionURL(...) within method body`
  );
  assert(
    new RegExp(`${ident(streamCfgVar)}\\.apiToken(?![\\w$])`).test(callApiStreamWindow),
    `callApiStream contract: expected ${streamCfgVar}.apiToken usage within method body`
  );
  assert(
    new RegExp(
      `\\.concat\\(\\s*${escapeRegExp(streamAbortSignalVar)}\\s*\\?\\s*\\[\\s*${escapeRegExp(streamAbortSignalVar)}\\s*\\]\\s*:\\s*\\[\\s*\\]\\s*\\)`
    ).test(callApiStreamWindow),
    `callApiStream contract: expected abort signal concat pattern using ${streamAbortSignalVar} within method body`
  );

  ok("callApi/callApiStream signature contract ok");
}

module.exports = { assertCallApiShimSignatureContracts };
