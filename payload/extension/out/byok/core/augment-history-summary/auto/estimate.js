"use strict";

const { utf8ByteLen } = require("../../../infra/util");
const shared = require("../../augment-chat/shared");
const { exchangeRequestNodes, exchangeResponseNodes } = require("../abridged");
const { REQUEST_NODE_TOOL_RESULT } = require("../../augment-protocol");

const { asRecord, asArray, pick, normalizeNodeType } = shared;

function approxTokenCountFromByteLen(len) {
  const BYTES_PER_TOKEN = 4;
  return Math.ceil(Number(len) / BYTES_PER_TOKEN);
}

function estimateRequestExtraSizeBytes(req) {
  const r = asRecord(req);
  return (
    utf8ByteLen(pick(r, ["prefix"])) +
    utf8ByteLen(pick(r, ["selected_code", "selectedCode"])) +
    utf8ByteLen(pick(r, ["suffix"])) +
    utf8ByteLen(pick(r, ["diff"]))
  );
}

function estimateNodeSizeBytes(node) {
  const n = asRecord(node);
  let out = 16;
  out += utf8ByteLen(pick(n, ["content"]));
  out += utf8ByteLen(pick(pick(n, ["text_node", "textNode"]), ["content"]));
  const tr = asRecord(pick(n, ["tool_result_node", "toolResultNode"]));
  if (normalizeNodeType(n) === REQUEST_NODE_TOOL_RESULT) {
    out += utf8ByteLen(pick(tr, ["tool_use_id", "toolUseId"]));
    out += utf8ByteLen(pick(tr, ["content"]));
    for (const c of asArray(pick(tr, ["content_nodes", "contentNodes"]))) {
      const cr = asRecord(c);
      out += 8;
      out += utf8ByteLen(pick(cr, ["text_content", "textContent"]));
      const img = asRecord(pick(cr, ["image_content", "imageContent"]));
      out += utf8ByteLen(pick(img, ["image_data", "imageData"]));
    }
  }
  const img = asRecord(pick(n, ["image_node", "imageNode"]));
  out += utf8ByteLen(pick(img, ["image_data", "imageData"]));
  for (const v of [
    pick(n, ["image_id_node", "imageIdNode"]),
    pick(n, ["ide_state_node", "ideStateNode"]),
    pick(n, ["edit_events_node", "editEventsNode"]),
    pick(n, ["checkpoint_ref_node", "checkpointRefNode"]),
    pick(n, ["change_personality_node", "changePersonalityNode"]),
    pick(n, ["file_node", "fileNode"]),
    pick(n, ["file_id_node", "fileIdNode"]),
    pick(n, ["history_summary_node", "historySummaryNode"])
  ]) {
    if (v == null) continue;
    try {
      out += utf8ByteLen(JSON.stringify(v));
    } catch {}
  }
  const tu = asRecord(pick(n, ["tool_use", "toolUse"]));
  out += utf8ByteLen(pick(tu, ["tool_use_id", "toolUseId"]));
  out += utf8ByteLen(pick(tu, ["tool_name", "toolName"]));
  out += utf8ByteLen(pick(tu, ["input_json", "inputJson"]));
  out += utf8ByteLen(pick(tu, ["mcp_server_name", "mcpServerName"]));
  out += utf8ByteLen(pick(tu, ["mcp_tool_name", "mcpToolName"]));
  const th = asRecord(pick(n, ["thinking", "thinking_node", "thinkingNode"]));
  out += utf8ByteLen(pick(th, ["summary"]));
  return out;
}

function estimateExchangeSizeBytes(exchange) {
  const it = asRecord(exchange);
  const reqNodes = exchangeRequestNodes(it);
  const respNodes = exchangeResponseNodes(it);
  let n = 0;
  n += reqNodes.length ? reqNodes.map(estimateNodeSizeBytes).reduce((a, b) => a + b, 0) : utf8ByteLen(it.request_message);
  n += respNodes.length ? respNodes.map(estimateNodeSizeBytes).reduce((a, b) => a + b, 0) : utf8ByteLen(it.response_text);
  return n;
}

function estimateHistorySizeBytes(history) {
  return asArray(history).map(estimateExchangeSizeBytes).reduce((a, b) => a + b, 0);
}

module.exports = {
  approxTokenCountFromByteLen,
  estimateRequestExtraSizeBytes,
  estimateExchangeSizeBytes,
  estimateHistorySizeBytes
};
