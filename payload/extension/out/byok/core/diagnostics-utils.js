"use strict";

const { normalizeString } = require("../infra/util");

function extractDiagnosticsList(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];
  if (Array.isArray(raw.items)) return raw.items;
  if (Array.isArray(raw.diagnostics)) return raw.diagnostics;
  if (Array.isArray(raw.entries)) return raw.entries;
  return [];
}

function pickDiagnosticPath(diag) {
  const d = diag && typeof diag === "object" ? diag : null;
  if (!d) return "";
  const loc = d.location && typeof d.location === "object" ? d.location : null;
  return normalizeString(
    d.path ||
      d.file_path ||
      d.filePath ||
      loc?.path ||
      loc?.file_path ||
      loc?.filePath ||
      d?.item?.path
  );
}

function pickDiagnosticStartLine(diag) {
  const d = diag && typeof diag === "object" ? diag : null;
  if (!d) return null;
  const loc = d.location && typeof d.location === "object" ? d.location : null;
  const r = d.range || d?.item?.range || loc?.range;
  const n = Number(
    loc?.line_start ??
      loc?.lineStart ??
      d.line_start ??
      d.lineStart ??
      r?.start?.line ??
      r?.start_line ??
      r?.startLine ??
      r?.start
  );
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.floor(n));
}

function pickDiagnosticEndLine(diag, fallbackStartLine) {
  const d = diag && typeof diag === "object" ? diag : null;
  const start = Number.isFinite(Number(fallbackStartLine)) ? Math.max(0, Math.floor(Number(fallbackStartLine))) : 0;
  if (!d) return start;
  const loc = d.location && typeof d.location === "object" ? d.location : null;
  const r = d.range || d?.item?.range || loc?.range;
  const n = Number(
    loc?.line_end ??
      loc?.lineEnd ??
      d.line_end ??
      d.lineEnd ??
      r?.end?.line ??
      r?.stop?.line ??
      r?.end_line ??
      r?.stopLine ??
      r?.stop ??
      r?.end
  );
  if (!Number.isFinite(n)) return start;
  return Math.max(start, Math.floor(n));
}

function extractFirstDiagnosticPath(raw) {
  const list = extractDiagnosticsList(raw);
  for (const d of list) {
    const p = pickDiagnosticPath(d);
    if (p) return p;
  }
  return "";
}

function extractFirstDiagnosticLine(raw, preferredPath) {
  const list = extractDiagnosticsList(raw);
  const want = normalizeString(preferredPath);

  if (want) {
    for (const d of list) {
      const p = pickDiagnosticPath(d);
      if (!p || p !== want) continue;
      const start = pickDiagnosticStartLine(d);
      if (start != null) return start;
    }
  }

  for (const d of list) {
    const start = pickDiagnosticStartLine(d);
    if (start != null) return start;
  }
  return 0;
}

module.exports = {
  extractDiagnosticsList,
  pickDiagnosticPath,
  pickDiagnosticStartLine,
  pickDiagnosticEndLine,
  extractFirstDiagnosticPath,
  extractFirstDiagnosticLine
};
