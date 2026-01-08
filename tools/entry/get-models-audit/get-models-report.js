#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { buildBearerAuth } = require("../../atom/common/auth");

function parseArgs(argv) {
  const out = { baseUrl: "", token: "", outJson: "", outMd: "", timeoutMs: 20000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base-url") out.baseUrl = argv[++i] || "";
    else if (a === "--token") out.token = argv[++i] || "";
    else if (a === "--out-json") out.outJson = argv[++i] || "";
    else if (a === "--out-md") out.outMd = argv[++i] || "";
    else if (a === "--timeout-ms") out.timeoutMs = Number(argv[++i] || out.timeoutMs);
  }
  return out;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function normalizeBaseUrl(raw) {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) return "";
  if (!s.endsWith("/")) return "";
  return s;
}

async function fetchJson({ url, auth, timeoutMs }) {
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
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: resp.status, headers: Object.fromEntries(resp.headers.entries()), text, json };
  } finally {
    clearTimeout(timer);
  }
}

function pickFlagsSummary(flags) {
  const obj = flags && typeof flags === "object" ? flags : {};
  const keys = Object.keys(obj).sort();
  const get = (k) => (Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : undefined);
  const highlightKeys = [
    "fraud_sign_endpoints",
    "additional_chat_models",
    "agent_chat_model",
    "remote_agent_list_polling_interval_ms",
    "enable_native_remote_mcp"
  ];
  const highlights = {};
  for (const k of highlightKeys) if (get(k) !== undefined) highlights[k] = get(k);
  return { keys, highlights, count: keys.length };
}

async function main() {
  const repoRoot = path.resolve(__dirname, "../../..");
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = normalizeBaseUrl(args.baseUrl);
  if (!baseUrl) throw new Error("invalid --base-url (must be service base url, ends with /)");

  const auth = buildBearerAuth(args.token);
  if (!auth) throw new Error("missing --token");

  const url = `${baseUrl}get-models`;
  const r = await fetchJson({ url, auth, timeoutMs: args.timeoutMs });

  const flags = r.json && typeof r.json === "object" ? r.json.feature_flags : null;
  const flagsSummary = pickFlagsSummary(flags);

  const report = {
    generatedAtMs: Date.now(),
    request: { baseUrl, url },
    response: { status: r.status, headers: r.headers },
    getModels: {
      default_model: r.json && typeof r.json === "object" ? r.json.default_model || "" : "",
      feature_flags: flags && typeof flags === "object" ? flags : null
    },
    stats: { featureFlagKeyCount: flagsSummary.count }
  };

  const outJson = args.outJson ? path.resolve(repoRoot, args.outJson) : path.join(repoRoot, ".cache", "reports", "get-models.report.json");
  const outMd = args.outMd ? path.resolve(repoRoot, args.outMd) : path.join(repoRoot, ".cache", "reports", "get-models.report.md");
  ensureDir(path.dirname(outJson));

  fs.writeFileSync(outJson, JSON.stringify(report, null, 2) + "\n", "utf8");

  const md = [
    `# Get Models Report`,
    ``,
    `- generatedAtMs: ${report.generatedAtMs}`,
    `- url: ${report.request.url}`,
    `- status: ${report.response.status}`,
    `- feature_flags keys: ${flagsSummary.count}`,
    `- default_model: ${report.getModels.default_model || "(empty)"}`,
    ``,
    `## Highlights`,
    ...Object.keys(flagsSummary.highlights).length === 0 ? ["(none)"] : Object.entries(flagsSummary.highlights).map(([k, v]) => `- ${k}: ${JSON.stringify(v)}`),
    ``,
    `## Notes`,
    `- 请求使用 POST ${baseUrl}get-models（与上游 callApi 方式一致）。`,
    `- Base URL 视为服务基地址：不自动补/抽 /api。`
  ].join("\n");

  fs.writeFileSync(outMd, md + "\n", "utf8");

  console.log(`[get-models] ${r.status} ${url}`);
  console.log(`[get-models] feature_flags keys: ${flagsSummary.count}`);
  console.log(`[get-models] report: ${path.relative(repoRoot, outJson)}`);
  console.log(`[get-models] report: ${path.relative(repoRoot, outMd)}`);
}

main().catch((err) => {
  console.error(`[get-models] ERROR:`, err && err.stack ? err.stack : String(err));
  process.exit(1);
});
