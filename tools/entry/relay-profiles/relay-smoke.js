#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { buildBearerAuth } = require("../../atom/common/auth");

function parseArgs(argv) {
  const out = { profile: "", baseUrl: "", token: "", timeoutMs: 4000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--profile") out.profile = argv[++i] || "";
    else if (a === "--base-url") out.baseUrl = argv[++i] || "";
    else if (a === "--token") out.token = argv[++i] || "";
    else if (a === "--timeout-ms") out.timeoutMs = Number(argv[++i] || out.timeoutMs);
  }
  return out;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalizeBaseUrl(raw) {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) return "";
  if (!s.endsWith("/")) return "";
  if (/\/api\/$/i.test(s)) return "";
  return s;
}

function normalizePath(p) {
  const s = typeof p === "string" ? p.trim() : "";
  if (!s) return "";
  const withSlash = s.startsWith("/") ? s : `/${s}`;
  const clean = withSlash.replace(/\/+$/, "");
  if (!clean || clean === "/") return "";
  return clean;
}

function buildUrl(baseUrl, endpointPath) {
  const base = normalizeBaseUrl(baseUrl);
  const ep = normalizePath(endpointPath).replace(/^\/+/, "");
  return base && ep ? `${base}${ep}` : "";
}

async function postJson({ url, auth, timeoutMs }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: auth },
      body: "{}",
      signal: ac.signal
    });
    const text = await resp.text().catch(() => "");
    return { status: resp.status, body: text.slice(0, 200), resp };
  } finally {
    clearTimeout(timer);
  }
}

async function postSse({ url, auth, timeoutMs }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: auth },
      body: "{}",
      signal: ac.signal
    });
    try {
      await resp.body?.cancel?.();
    } catch {
      // ignore
    }
    return { status: resp.status, body: "", resp };
  } finally {
    clearTimeout(timer);
    try {
      ac.abort();
    } catch {
      // ignore
    }
  }
}

async function main() {
  const repoRoot = path.resolve(__dirname, "../../..");
  const args = parseArgs(process.argv.slice(2));
  const profilePath = args.profile ? path.resolve(repoRoot, args.profile) : path.join(repoRoot, "config", "relay-profiles", "acemcp-heroman-relay.json");
  if (!fs.existsSync(profilePath)) throw new Error(`missing profile: ${path.relative(repoRoot, profilePath)}`);

  const profile = readJson(profilePath);
  const baseUrl = normalizeBaseUrl(args.baseUrl || profile?.baseUrlDefault || "");
  if (!baseUrl) throw new Error("invalid --base-url (must be service base url, ends with /, without /api/)");

  const auth = buildBearerAuth(args.token);
  if (!auth) throw new Error("missing --token");

  const allowed = Array.isArray(profile?.allowedPaths) ? profile.allowedPaths : [];
  const sse = Array.isArray(profile?.ssePaths) ? profile.ssePaths : [];
  const all = [...allowed, ...sse].map(normalizePath).filter(Boolean);
  const sseSet = new Set(sse.map(normalizePath).filter(Boolean));

  console.log(`[relay] baseUrl=${baseUrl} endpoints=${all.length} timeoutMs=${args.timeoutMs}`);

  const results = [];
  for (const p of all) {
    const url = buildUrl(baseUrl, p);
    if (!url) throw new Error(`failed to build url for ${p}`);
    const timeoutMs = p === "/prompt-enhancer" ? Math.max(args.timeoutMs, 12000) : args.timeoutMs;
    const r = sseSet.has(p) ? await postSse({ url, auth, timeoutMs }) : await postJson({ url, auth, timeoutMs });
    const ok = r.status !== 404 && r.status !== 401;
    results.push({ path: p, status: r.status, ok, body: r.body });
    console.log(`[relay] ${ok ? "OK" : "FAIL"} ${r.status} ${p}`);
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.log(`[relay] FAILED: ${failed.length}/${results.length} endpoints returned 404`);
    for (const f of failed) console.log(`- ${f.path}: ${f.status} ${f.body ? `(${f.body})` : ""}`.trim());
    process.exit(1);
  }

  console.log(`[relay] PASS: ${results.length}/${results.length}`);
}

main().catch((err) => {
  console.error(`[relay] ERROR:`, err && err.stack ? err.stack : String(err));
  process.exit(1);
});
