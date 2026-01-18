"use strict";

const { normalizeString } = require("../infra/util");
const { commonSuffixLen } = require("./text-match");

function looksLikeOfficialBlobsDiff(raw) {
  const b = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
  if (!b) return false;

  const checkpoint = b.checkpoint_id ?? b.checkpointId ?? b.checkpointID;
  const added = b.added_blobs ?? b.addedBlobs;
  const deleted = b.deleted_blobs ?? b.deletedBlobs;

  const hasArrays = Array.isArray(added) || Array.isArray(deleted);
  if (!hasArrays) return false;

  if (checkpoint != null && typeof checkpoint !== "string") return false;
  if (added != null && !Array.isArray(added)) return false;
  if (deleted != null && !Array.isArray(deleted)) return false;

  const allowed = new Set(["checkpoint_id", "checkpointId", "checkpointID", "added_blobs", "addedBlobs", "deleted_blobs", "deletedBlobs"]);
  for (const k of Object.keys(b)) {
    if (!allowed.has(k)) return false;
  }
  return true;
}

function coerceBlobText(v) {
  if (typeof v === "string") return v;
  const r = v && typeof v === "object" ? v : null;
  if (!r) return "";
  if (typeof r.content === "string") return r.content;
  if (typeof r.text === "string") return r.text;
  return "";
}

function normalizeBlobsMap(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!Array.isArray(raw) && looksLikeOfficialBlobsDiff(raw)) return null;

  const out = {};
  const set = (k, v) => {
    const key = normalizeString(k);
    if (!key) return;
    if (Object.prototype.hasOwnProperty.call(out, key)) return;
    out[key] = v;
  };

  if (Array.isArray(raw)) {
    for (const it of raw) {
      if (typeof it === "string") {
        set(it, "");
        continue;
      }
      if (!it || typeof it !== "object") continue;
      const name = it.blob_name ?? it.blobName ?? it.path ?? it.name;
      const content = it.content ?? it.text;
      set(name, typeof content === "string" ? content : it);
    }
  } else {
    for (const k of Object.keys(raw)) {
      set(k, raw[k]);
    }
  }

  return Object.keys(out).length ? out : null;
}

function listBlobKeys(blobs, { maxItems = 500 } = {}) {
  const map = blobs && typeof blobs === "object" && !Array.isArray(blobs) ? blobs : null;
  if (!map) return [];
  const lim = Number.isFinite(Number(maxItems)) && Number(maxItems) > 0 ? Math.floor(Number(maxItems)) : 500;
  const out = [];
  for (const k of Object.keys(map)) {
    const key = normalizeString(k);
    if (!key) continue;
    out.push(key);
    if (out.length >= lim) break;
  }
  return out;
}

function normalizePathLikeForMatch(p) {
  const raw = normalizeString(p);
  if (!raw) return "";
  let s = raw.replace(/\\/g, "/");
  if (s.startsWith("file://") || s.startsWith("vscode-file://")) {
    try { s = decodeURIComponent(new URL(s).pathname); } catch {}
  } else if (s.includes("://")) {
    try { s = new URL(s).pathname; } catch {}
  }
  s = s.replace(/\\/g, "/");
  if (s.startsWith("./")) s = s.slice(2);
  return s;
}

function pickBestBlobName({ blobs, blobNameHint, pathHint }) {
  const map = blobs && typeof blobs === "object" && !Array.isArray(blobs) ? blobs : null;
  if (!map) return "";

  const hint = normalizeString(blobNameHint);
  if (hint && Object.prototype.hasOwnProperty.call(map, hint)) return hint;

  const path = normalizeString(pathHint);
  if (path && Object.prototype.hasOwnProperty.call(map, path)) return path;

  const keys = Object.keys(map).map((k) => normalizeString(k)).filter(Boolean);
  if (!keys.length) return "";
  if (keys.length === 1) return keys[0];

  const pn = normalizePathLikeForMatch(path);
  if (!pn) return "";
  let bestKey = "";
  let bestScore = 0;
  for (const k of keys) {
    const kn = normalizePathLikeForMatch(k);
    if (!kn) continue;
    if (kn === pn) return k;
    const score = commonSuffixLen(kn, pn);
    if (score > bestScore) { bestScore = score; bestKey = k; }
  }
  return bestScore > 0 ? bestKey : "";
}

function getBlobValue(blobs, blobName) {
  const map = blobs && typeof blobs === "object" && !Array.isArray(blobs) ? blobs : null;
  const name = normalizeString(blobName);
  if (!map || !name) return null;
  return Object.prototype.hasOwnProperty.call(map, name) ? map[name] : null;
}

module.exports = {
  coerceBlobText,
  normalizeBlobsMap,
  listBlobKeys,
  pickBestBlobName,
  getBlobValue
};
