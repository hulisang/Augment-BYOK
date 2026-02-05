"use strict";

const { normalizeString } = require("../../../infra/util");
const shared = require("../../augment-chat/shared");
const { exchangeRequestNodes } = require("../abridged");
const { REQUEST_NODE_TOOL_RESULT } = require("../../augment-protocol");

const { asArray, pick, normalizeNodeType } = shared;

const { estimateExchangeSizeBytes } = require("./estimate");

function nodeIsToolResult(n) {
  if (normalizeNodeType(n) !== REQUEST_NODE_TOOL_RESULT) return false;
  const tr = pick(n, ["tool_result_node", "toolResultNode"]);
  return tr && typeof tr === "object" && !Array.isArray(tr);
}

function exchangeHasToolResults(h) {
  return exchangeRequestNodes(h).some(nodeIsToolResult);
}

function splitHistoryForSummary(history, tailSizeBytesToExclude, triggerOnHistorySizeBytes, minTailExchanges) {
  const hs = asArray(history);
  if (!hs.length) return { head: [], tail: [] };
  const headRev = [];
  const tailRev = [];
  let seenBytes = 0;
  let headBytes = 0;
  let tailBytes = 0;
  for (let i = hs.length - 1; i >= 0; i--) {
    const ex = hs[i];
    const sz = estimateExchangeSizeBytes(ex);
    if (seenBytes + sz < tailSizeBytesToExclude || tailRev.length < minTailExchanges) {
      tailRev.push(ex);
      tailBytes += sz;
    } else {
      headRev.push(ex);
      headBytes += sz;
    }
    seenBytes += sz;
  }
  const totalBytes = headBytes + tailBytes;
  if (totalBytes < triggerOnHistorySizeBytes) {
    const all = tailRev.concat(headRev).reverse();
    return { head: [], tail: all };
  }
  headRev.reverse();
  tailRev.reverse();
  return { head: headRev, tail: tailRev };
}

function adjustTailToAvoidToolResultOrphans(original, tailStart) {
  const hs = asArray(original);
  let start = Number.isFinite(Number(tailStart)) ? Math.floor(Number(tailStart)) : 0;
  while (start < hs.length) {
    if (!exchangeHasToolResults(hs[start])) break;
    if (start <= 0) break;
    start -= 1;
  }
  return start;
}

function computeTailSelection({ history, hs, decision }) {
  const split = splitHistoryForSummary(history, decision.tailExcludeChars, decision.thresholdChars, hs.minTailExchanges);
  if (!split.head.length || !split.tail.length) return null;
  const splitBoundaryRequestId = normalizeString(split.tail[0]?.request_id);
  if (!splitBoundaryRequestId) return null;
  let tailStart = history.findIndex((h) => normalizeString(h?.request_id) === splitBoundaryRequestId);
  if (tailStart < 0) tailStart = Math.max(0, history.length - split.tail.length);
  tailStart = adjustTailToAvoidToolResultOrphans(history, tailStart);
  const boundaryRequestId = normalizeString(history[tailStart]?.request_id);
  if (!boundaryRequestId) return null;
  const droppedHead = history.slice(0, tailStart);
  const tail = history.slice(tailStart);
  if (!droppedHead.length || !tail.length) return null;
  return { tailStart, boundaryRequestId, droppedHead, tail };
}

module.exports = { computeTailSelection };
