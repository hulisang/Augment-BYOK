"use strict";

const { normalizeString } = require("../infra/util");

function stripOuterCodeFence(text) {
  const t = typeof text === "string" ? text.trim() : "";
  if (!t) return "";
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m ? String(m[1] ?? "").trim() : t;
}

function parseJsonValueLoose(text) {
  const raw = stripOuterCodeFence(text);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {}

  // 兜底：截取最大 JSON 片段（避免模型在前后输出解释性文本）
  const firstObj = raw.indexOf("{");
  const lastObj = raw.lastIndexOf("}");
  const firstArr = raw.indexOf("[");
  const lastArr = raw.lastIndexOf("]");
  const slices = [];
  if (firstObj >= 0 && lastObj > firstObj) slices.push(raw.slice(firstObj, lastObj + 1));
  if (firstArr >= 0 && lastArr > firstArr) slices.push(raw.slice(firstArr, lastArr + 1));
  for (const s of slices.sort((a, b) => b.length - a.length)) {
    try {
      return JSON.parse(s);
    } catch {}
  }
  return null;
}

function normalizeLineNumber0Based(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return 0;
  return Math.floor(n);
}

function normalizeNextEditLocCandidate(raw, { fallbackPath, source } = {}) {
  const r = raw && typeof raw === "object" ? raw : null;
  if (!r) return null;

  const itemRaw = r.item && typeof r.item === "object" ? r.item : r;
  const rangeRaw =
    itemRaw.range && typeof itemRaw.range === "object"
      ? itemRaw.range
      : r.range && typeof r.range === "object"
        ? r.range
        : null;

  const path = normalizeString(
    itemRaw.path ??
      itemRaw.file_path ??
      itemRaw.filePath ??
      r.path ??
      r.file_path ??
      r.filePath ??
      fallbackPath
  );
  if (!path) return null;

  const start =
    normalizeLineNumber0Based(
      rangeRaw?.start?.line ??
        rangeRaw?.start_line ??
        rangeRaw?.startLine ??
        rangeRaw?.start ??
        itemRaw.start ??
        itemRaw.start_line ??
        itemRaw.startLine ??
        r.start ??
        r.start_line ??
        r.startLine
    ) ?? 0;
  const stop =
    normalizeLineNumber0Based(
      rangeRaw?.end?.line ??
        rangeRaw?.stop?.line ??
        rangeRaw?.end_line ??
        rangeRaw?.stopLine ??
        rangeRaw?.stop ??
        rangeRaw?.end ??
        itemRaw.stop ??
        itemRaw.stop_line ??
        itemRaw.stopLine ??
        itemRaw.end ??
        itemRaw.end_line ??
        itemRaw.endLine ??
        r.stop ??
        r.stop_line ??
        r.stopLine ??
        r.end ??
        r.end_line ??
        r.endLine ??
        start
    ) ?? start;

  const score = Number.isFinite(Number(r.score)) ? Number(r.score) : Number.isFinite(Number(r.confidence)) ? Number(r.confidence) : 1;
  const dbg = r.debug_info && typeof r.debug_info === "object" ? r.debug_info : r.debugInfo && typeof r.debugInfo === "object" ? r.debugInfo : null;
  const reason = normalizeString(r.reason ?? r.why ?? dbg?.reason);
  const debug_info = { ...(dbg || null), source: normalizeString(dbg?.source) || normalizeString(source) || "byok:llm", ...(reason ? { reason } : null) };

  return { item: { path, range: { start, stop: Math.max(start, stop) } }, score, debug_info };
}

function parseNextEditLocCandidatesFromText(text, { fallbackPath, max, source } = {}) {
  const parsed = parseJsonValueLoose(text);
  if (!parsed) return [];
  const root = parsed && typeof parsed === "object" ? parsed : null;
  const list =
    Array.isArray(parsed)
      ? parsed
      : Array.isArray(root?.candidate_locations)
        ? root.candidate_locations
        : Array.isArray(root?.candidateLocations)
          ? root.candidateLocations
          : Array.isArray(root?.locations)
            ? root.locations
            : root
              ? [root]
              : [];

  const lim = Number.isFinite(Number(max)) && Number(max) > 0 ? Math.min(6, Math.floor(Number(max))) : 1;
  const out = [];
  for (const it of list) {
    const c = normalizeNextEditLocCandidate(it, { fallbackPath, source });
    if (!c) continue;
    out.push(c);
    if (out.length >= lim) break;
  }
  return out;
}

function candidateKey(c) {
  const p = normalizeString(c?.item?.path);
  const s = Number(c?.item?.range?.start);
  const e = Number(c?.item?.range?.stop);
  return `${p}:${Number.isFinite(s) ? String(s) : "?"}:${Number.isFinite(e) ? String(e) : "?"}`;
}

function mergeNextEditLocCandidates({ baseline, llmCandidates, max } = {}) {
  const base = Array.isArray(baseline) ? baseline : [];
  const llm = Array.isArray(llmCandidates) ? llmCandidates : [];
  const lim = Number.isFinite(Number(max)) && Number(max) > 0 ? Math.min(6, Math.floor(Number(max))) : 1;

  const merged = [];
  const seen = new Set();
  const push = (c) => {
    if (!c || typeof c !== "object") return;
    const key = candidateKey(c);
    if (key.startsWith(":") || seen.has(key)) return;
    seen.add(key);
    merged.push(c);
  };

  for (const c of base) if (normalizeString(c?.debug_info?.source) === "diagnostic") push(c);
  for (const c of llm) push(c);
  for (const c of base) if (normalizeString(c?.debug_info?.source) !== "diagnostic") push(c);
  return merged.slice(0, lim);
}

module.exports = {
  stripOuterCodeFence,
  parseJsonValueLoose,
  normalizeNextEditLocCandidate,
  parseNextEditLocCandidatesFromText,
  mergeNextEditLocCandidates
};

