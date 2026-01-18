"use strict";

function commonPrefixLen(a, b) {
  const s1 = typeof a === "string" ? a : "";
  const s2 = typeof b === "string" ? b : "";
  const n = Math.min(s1.length, s2.length);
  let i = 0;
  for (; i < n; i++) if (s1.charCodeAt(i) !== s2.charCodeAt(i)) break;
  return i;
}

function commonSuffixLen(a, b) {
  const s1 = typeof a === "string" ? a : "";
  const s2 = typeof b === "string" ? b : "";
  const n = Math.min(s1.length, s2.length);
  let i = 0;
  for (; i < n; i++) if (s1.charCodeAt(s1.length - 1 - i) !== s2.charCodeAt(s2.length - 1 - i)) break;
  return i;
}

function bestMatchIndex(haystack, needle, { prefixHint, suffixHint, maxCandidates = 200 } = {}) {
  const h = typeof haystack === "string" ? haystack : "";
  const n = typeof needle === "string" ? needle : "";
  if (!h || !n) return -1;
  const pre = typeof prefixHint === "string" ? prefixHint : "";
  const suf = typeof suffixHint === "string" ? suffixHint : "";
  let bestIdx = -1;
  let bestScore = -1;
  let i = 0;
  for (let pos = h.indexOf(n); pos !== -1; pos = h.indexOf(n, pos + 1)) {
    i += 1;
    if (i > maxCandidates) break;
    const before = pre ? h.slice(Math.max(0, pos - pre.length), pos) : "";
    const after = suf ? h.slice(pos + n.length, pos + n.length + suf.length) : "";
    const score = commonSuffixLen(before, pre) * 2 + commonPrefixLen(after, suf);
    if (score > bestScore || (score === bestScore && pos > bestIdx)) { bestScore = score; bestIdx = pos; }
  }
  return bestIdx;
}

function bestInsertionIndex(haystack, { prefixHint, suffixHint, maxCandidates = 200 } = {}) {
  const h = typeof haystack === "string" ? haystack : "";
  const pre = typeof prefixHint === "string" ? prefixHint : "";
  const suf = typeof suffixHint === "string" ? suffixHint : "";
  if (!h) return 0;
  if (!pre && !suf) return 0;

  if (pre) {
    let bestIdx = -1;
    let bestScore = -1;
    let i = 0;
    for (let pos = h.indexOf(pre); pos !== -1; pos = h.indexOf(pre, pos + 1)) {
      i += 1;
      if (i > maxCandidates) break;
      const ins = pos + pre.length;
      const after = suf ? h.slice(ins, ins + suf.length) : "";
      const score = pre.length * 2 + commonPrefixLen(after, suf);
      if (score > bestScore || (score === bestScore && ins > bestIdx)) { bestScore = score; bestIdx = ins; }
    }
    if (bestIdx >= 0) return bestIdx;
  }

  if (suf) {
    const pos = h.indexOf(suf);
    if (pos >= 0) return pos;
  }
  return 0;
}

module.exports = { commonPrefixLen, commonSuffixLen, bestMatchIndex, bestInsertionIndex };

