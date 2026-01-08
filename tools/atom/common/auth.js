#!/usr/bin/env node
"use strict";

function normalizeString(v) {
  return typeof v === "string" ? v.trim() : "";
}

function buildBearerAuth(token) {
  const raw = normalizeString(token);
  if (!raw) return "";
  if (/\s/.test(raw)) throw new Error("invalid --token (must be raw token; do not include 'Bearer ' prefix)");
  return `Bearer ${raw}`;
}

module.exports = { buildBearerAuth };

