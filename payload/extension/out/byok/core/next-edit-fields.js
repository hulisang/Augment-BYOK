"use strict";

const { normalizeString } = require("../infra/util");

const PATH_KEYS = ["path", "pathName", "file_path", "filePath", "target_file_path", "targetFilePath"];
const LANG_KEYS = ["lang", "language", "language_id", "languageId"];
const INSTRUCTION_KEYS = ["instruction", "message", "prompt"];
const NUM_RESULTS_KEYS = ["num_results", "numResults"];
const BLOB_NAME_KEYS = ["blob_name", "blobName"];

function pickFirstString(body, keys) {
  const b = body && typeof body === "object" ? body : {};
  for (const k of Array.isArray(keys) ? keys : []) {
    const v = b[k];
    if (typeof v === "string") return v;
  }
  return "";
}

function pickPath(body) {
  return normalizeString(pickFirstString(body, PATH_KEYS));
}

function pickLang(body) {
  return normalizeString(pickFirstString(body, LANG_KEYS));
}

function pickInstruction(body) {
  return normalizeString(pickFirstString(body, INSTRUCTION_KEYS));
}

function pickNumResults(body, { defaultValue = 1, max = 6 } = {}) {
  const b = body && typeof body === "object" ? body : {};
  const raw = b.num_results ?? b.numResults;
  const v = Number(raw);
  if (!Number.isFinite(v)) return defaultValue;
  const n = Math.floor(v);
  if (n <= 0) return defaultValue;
  const m = Number.isFinite(Number(max)) && Number(max) > 0 ? Math.floor(Number(max)) : 6;
  return Math.min(m, n);
}

function pickBlobNameHint(body) {
  return normalizeString(pickFirstString(body, BLOB_NAME_KEYS));
}

module.exports = {
  PATH_KEYS,
  LANG_KEYS,
  INSTRUCTION_KEYS,
  NUM_RESULTS_KEYS,
  BLOB_NAME_KEYS,
  pickFirstString,
  pickPath,
  pickLang,
  pickInstruction,
  pickNumResults,
  pickBlobNameHint
};

