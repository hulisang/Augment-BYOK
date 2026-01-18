"use strict";

const { normalizeString } = require("../infra/util");
const { normalizeBlobsMap, coerceBlobText, pickBestBlobName, listBlobKeys } = require("../core/blob-utils");
const { pickPath, pickLang, pickInstruction, pickBlobNameHint } = require("../core/next-edit-fields");
const { utf32ToUtf16Offset } = require("../core/unicode-utils");
const { fmtSection, fmtCodeSection, fmtJsonSection, extractDirectives, buildSystem, extractCodeContext } = require("./common");

function tailWithMarker(s, maxChars) {
  const text = typeof s === "string" ? s : "";
  const n = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0 ? Math.floor(Number(maxChars)) : 0;
  if (!n || text.length <= n) return text;
  return `…(truncated)\n${text.slice(text.length - n)}`;
}

function headWithMarker(s, maxChars) {
  const text = typeof s === "string" ? s : "";
  const n = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0 ? Math.floor(Number(maxChars)) : 0;
  if (!n || text.length <= n) return text;
  return `${text.slice(0, n)}\n…(truncated)`;
}

function buildNextEditStreamPrompt(body) {
  const b = body && typeof body === "object" ? body : {};
  const directives = extractDirectives(b);
  const lang = pickLang(b);
  const path = pickPath(b);
  const instruction = pickInstruction(b) || "Propose the next code edit.";
  let { prefix, selectedText, suffix } = extractCodeContext(b);

  const mode = normalizeString(b.mode);
  const scope = normalizeString(b.scope);
  const diagnostics = b.diagnostics;
  const recentChanges = b.recent_changes ?? b.recentChanges;
  const blockedLocations = b.blocked_locations ?? b.blockedLocations;
  const editEvents = b.edit_events ?? b.editEvents;
  const apiVersion = normalizeString(b.api_version ?? b.apiVersion);
  const sequenceId = Number.isFinite(Number(b.sequence_id ?? b.sequenceId)) ? Math.floor(Number(b.sequence_id ?? b.sequenceId)) : null;

  const blobs = normalizeBlobsMap(b.blobs);
  const blobName = pickBestBlobName({ blobs, blobNameHint: pickBlobNameHint(b), pathHint: path });
  const blobText = blobs && blobName ? coerceBlobText(blobs[blobName]) : "";

  const selBeginRaw = b.selection_begin_char ?? b.selectionBeginChar;
  const selEndRaw = b.selection_end_char ?? b.selectionEndChar;
  const hasSelBegin = Number.isFinite(Number(selBeginRaw));
  const hasSelEnd = Number.isFinite(Number(selEndRaw));
  const selectionBegin = hasSelBegin ? Math.max(0, Math.floor(Number(selBeginRaw))) : null;
  const selectionEnd = hasSelEnd ? Math.max(0, Math.floor(Number(selEndRaw))) : null;

  // 重要：部分 upstream 请求只给 blobs + selection_* + blob_name，不给 prefix/selected_text/suffix。
  // 在这种情况下从 blob 文本中恢复“选区上下文”，否则 next-edit 会退化成“无上下文”。
  if (blobText && (selectionBegin != null || selectionEnd != null)) {
    const len16 = blobText.length;
    const begin32 = selectionBegin ?? 0;
    const end32Raw = selectionEnd ?? selectionBegin ?? 0;
    const end32 = end32Raw < begin32 ? begin32 : end32Raw;
    const start = utf32ToUtf16Offset(blobText, begin32);
    const end = utf32ToUtf16Offset(blobText, end32);
    const hi = Math.max(start, end);
    const windowChars = 8000;

    if (!selectedText) selectedText = blobText.slice(start, hi);
    if (!prefix) prefix = blobText.slice(Math.max(0, start - windowChars), start);
    if (!suffix) suffix = blobText.slice(hi, Math.min(len16, hi + windowChars));

    // 兜底裁剪（避免把整个文件塞进 prompt）
    prefix = tailWithMarker(prefix, 12000);
    suffix = headWithMarker(suffix, 12000);
    selectedText = headWithMarker(selectedText, 12000);
  } else {
    // 即便请求给了 prefix/suffix，也做一次防御性裁剪（历史上 next-edit 偶尔会传入很长片段）
    prefix = tailWithMarker(prefix, 12000);
    suffix = headWithMarker(suffix, 12000);
    selectedText = headWithMarker(selectedText, 12000);
  }

  const system = buildSystem({
    purpose: "next-edit-stream",
    directives,
    outputConstraints:
      "Propose the next minimal edit.\n- Output ONLY the replacement code for the selected range\n- No markdown, no explanations\n- Do NOT wrap in ``` code fences"
  });

  const parts = [];
  if (instruction) parts.push(fmtSection("Instruction", instruction));
  if (path) parts.push(fmtSection("Path", path));
  if (blobName) parts.push(fmtSection("Blob Name", blobName));
  if (lang) parts.push(fmtSection("Language", lang));
  if (mode) parts.push(fmtSection("Mode", mode));
  if (scope) parts.push(fmtSection("Scope", scope));
  if (apiVersion) parts.push(fmtSection("API Version", apiVersion));
  if (sequenceId != null) parts.push(fmtSection("Sequence ID", String(sequenceId)));
  if (selectionBegin != null || selectionEnd != null) {
    const a = selectionBegin != null ? String(selectionBegin) : "?";
    const z = selectionEnd != null ? String(selectionEnd) : "?";
    parts.push(fmtSection("Selection (char)", `${a}-${z}`));
  }
  if (diagnostics != null && (!Array.isArray(diagnostics) || diagnostics.length)) parts.push(fmtJsonSection("Diagnostics", diagnostics, { maxChars: 12000 }));
  if (recentChanges != null) parts.push(fmtJsonSection("Recent Changes", recentChanges, { maxChars: 12000 }));
  if (blockedLocations != null) parts.push(fmtJsonSection("Blocked Locations", blockedLocations, { maxChars: 12000 }));
  if (editEvents != null) parts.push(fmtJsonSection("Edit Events", editEvents, { maxChars: 12000 }));
  if (blobs) {
    const keys = listBlobKeys(blobs, { maxItems: 500 });
    if (keys.length) parts.push(fmtJsonSection("Blobs (keys)", keys.slice(0, 200), { maxChars: 4000 }));

    const other = keys.filter((k) => k !== blobName).slice(0, 3);
    for (const k of other) {
      const txt = coerceBlobText(blobs[k]);
      if (!txt) continue;
      const max = 8000;
      const half = Math.floor(max / 2);
      const snippet = txt.length <= max ? txt : `${txt.slice(0, half)}\n…(truncated)\n${txt.slice(txt.length - half)}`;
      parts.push(fmtCodeSection(`Additional Context Blob: ${k}`, snippet, { lang: "" }));
    }
  }
  if (prefix) parts.push(fmtCodeSection("Prefix", prefix, { lang }));
  const selectedForPrompt = selectedText || (selectionBegin != null && selectionEnd != null && selectionBegin === selectionEnd ? "<EMPTY SELECTION>" : "");
  if (selectedForPrompt) parts.push(fmtCodeSection("Selected (replace this)", selectedForPrompt, { lang }));
  if (suffix) parts.push(fmtCodeSection("Suffix", suffix, { lang }));

  const user = parts.filter(Boolean).join("\n\n").trim() || "Propose an edit.";
  return { system, messages: [{ role: "user", content: user }] };
}

module.exports = { buildNextEditStreamPrompt };
