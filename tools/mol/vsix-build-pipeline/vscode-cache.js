"use strict";

const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const { fileURLToPath, pathToFileURL } = require("url");

const { rmDir } = require("../../atom/common/fs");

function parseArgs(argv, defaults = {}) {
  const out = {
    apply: false,
    channel: "stable",
    userDir: "",
    workspace: "",
    extensionId: "augment.vscode-augment",
    concurrency: 32,
    help: false,
    ...defaults
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--dry-run") out.apply = false;
    else if (a === "--channel") out.channel = String(argv[++i] || "").trim() || out.channel;
    else if (a === "--user-dir") out.userDir = String(argv[++i] || "").trim();
    else if (a === "--workspace") out.workspace = String(argv[++i] || "").trim();
    else if (a === "--extension-id") out.extensionId = String(argv[++i] || "").trim() || out.extensionId;
    else if (a === "--concurrency") out.concurrency = Math.max(1, Math.min(256, Number(argv[++i] || 0) || out.concurrency));
    else if (a === "-h" || a === "--help") out.help = true;
  }
  return out;
}

function codeFolderName(channel) {
  const c = String(channel || "").toLowerCase();
  if (c === "insiders") return "Code - Insiders";
  if (c === "oss") return "Code - OSS";
  if (c === "codium") return "VSCodium";
  return "Code";
}

function defaultCodeUserDir(channel) {
  const home = os.homedir();
  const folder = codeFolderName(channel);
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", folder, "User");
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), folder, "User");
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(xdgConfig, folder, "User");
}

function isSubPath(child, parent) {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function realPathIfPossible(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function stripTrailingSep(p) {
  const root = path.parse(p).root;
  let out = p;
  while (out.length > root.length && out.endsWith(path.sep)) out = out.slice(0, -1);
  return out;
}

function normalizeFsPathForCompare(p) {
  const resolved = stripTrailingSep(path.resolve(p));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function normalizeFsPathForCompareWithRealpath(p) {
  const base = normalizeFsPathForCompare(p);
  return normalizeFsPathForCompare(realPathIfPossible(base));
}

function isWithinOrEqualFsPath(child, parent) {
  const c = normalizeFsPathForCompareWithRealpath(child);
  const p = normalizeFsPathForCompareWithRealpath(parent);
  if (c === p) return true;
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

function fileUriVariants(fsPath) {
  const abs = path.resolve(fsPath);
  const withSep = abs.endsWith(path.sep) ? abs : abs + path.sep;
  return Array.from(new Set([pathToFileURL(abs).toString(), pathToFileURL(withSep).toString()]));
}

function isUri(s) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s);
}

function pointerToFsPath(pointer) {
  const p = typeof pointer === "string" ? pointer : "";
  if (!p) return "";
  if (p.startsWith("file://")) {
    try {
      return fileURLToPath(p);
    } catch {
      return "";
    }
  }
  if (isUri(p)) return "";
  return p;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function mapLimit(items, limit, fn) {
  const list = Array.isArray(items) ? items : [];
  const max = Math.max(1, Math.min(limit || 1, list.length || 1));
  let index = 0;
  const workers = Array.from({ length: max }, async () => {
    while (index < list.length) {
      const i = index++;
      await fn(list[i], i);
    }
  });
  return Promise.all(workers);
}

function validateExtensionId(extensionId) {
  const id = String(extensionId || "").trim();
  if (!id) throw new Error(`missing --extension-id`);
  if (id.includes("/") || id.includes("\\") || id.includes(path.sep)) throw new Error(`invalid --extension-id (no path separators): ${id}`);
  if (id === "." || id === "..") throw new Error(`invalid --extension-id: ${id}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\.[A-Za-z0-9][A-Za-z0-9-]*$/.test(id)) throw new Error(`invalid --extension-id (expected publisher.name): ${id}`);
  return id;
}

function resolveVscodeUserDir({ channel, userDir }) {
  return path.resolve(userDir || process.env.VSCODE_USER_DIR || defaultCodeUserDir(channel));
}

async function cleanVscodeWorkspaceStorage({ repoRoot, args }) {
  const workspaceResolved = path.resolve(args.workspace || repoRoot);
  const workspaceReal = realPathIfPossible(workspaceResolved);
  const userDir = resolveVscodeUserDir(args);
  const workspaceStorageDir = path.join(userDir, "workspaceStorage");

  if (!fs.existsSync(workspaceStorageDir)) {
    console.log(`[vscode-cache] missing: ${workspaceStorageDir}`);
    console.log(`[vscode-cache] hint: try --channel insiders | --user-dir <.../User>`);
    return;
  }

  const targetPathSet = new Set([normalizeFsPathForCompare(workspaceResolved), normalizeFsPathForCompareWithRealpath(workspaceResolved)]);
  const targetUriSet = new Set([...fileUriVariants(workspaceResolved), ...fileUriVariants(workspaceReal)]);
  const dirents = await fsp.readdir(workspaceStorageDir, { withFileTypes: true });
  const candidates = dirents.filter((d) => d.isDirectory()).map((d) => path.join(workspaceStorageDir, d.name));

  const matches = [];
  const pointers = [];
  await mapLimit(candidates, args.concurrency, async (dir) => {
    const wsJsonPath = path.join(dir, "workspace.json");
    let text = "";
    try {
      text = await fsp.readFile(wsJsonPath, "utf8");
    } catch {
      return;
    }
    const json = safeJsonParse(text);
    if (!json) return;
    const pointer = typeof json.folder === "string" ? json.folder : typeof json.workspace === "string" ? json.workspace : "";
    if (!pointer) return;
    if (pointers.length < 2048) pointers.push(pointer);
    if (targetUriSet.has(pointer)) return matches.push(dir);
    const p = pointerToFsPath(pointer);
    if (!p) return;
    const pNorm = normalizeFsPathForCompare(p);
    if (targetPathSet.has(pNorm)) return matches.push(dir);
    if (targetPathSet.has(normalizeFsPathForCompare(realPathIfPossible(pNorm)))) matches.push(dir);
  });

  if (matches.length === 0) {
    console.log(`[vscode-cache] no match for workspace: ${workspaceResolved}`);
    console.log(`[vscode-cache] searched: ${workspaceStorageDir}`);
    const suggestions = Array.from(new Set(pointers.map(pointerToFsPath).filter(Boolean).map((p) => path.resolve(p)).filter((p) => isWithinOrEqualFsPath(p, workspaceResolved)))).slice(0, 8);
    if (suggestions.length > 0) {
      console.log(`[vscode-cache] hint: 发现同一路径前缀下的候选 workspace（你可能在 VS Code 打开的是子目录/工作区文件，请用 --workspace 指定）：`);
      for (const s of suggestions) console.log(`[vscode-cache] hint:   --workspace ${s}`);
    } else {
      console.log(`[vscode-cache] hint: 你可能没有用 VS Code 打开过该路径，或使用了不同的 --channel/--user-dir；可检查 workspaceStorage/*/workspace.json 的 folder|workspace 字段。`);
    }
    return;
  }

  const action = args.apply ? "rm -rf" : "dry-run rm -rf";
  for (const target of matches) {
    if (!isSubPath(target, workspaceStorageDir)) throw new Error(`refuse to delete outside workspaceStorage: ${target}`);
    console.log(`[vscode-cache] ${action} ${target}`);
    if (args.apply) rmDir(target);
  }
}

async function cleanVscodeGlobalStorage({ args }) {
  const userDir = resolveVscodeUserDir(args);
  const globalStorageDir = path.join(userDir, "globalStorage");
  const extensionId = validateExtensionId(args.extensionId);
  const targetDir = path.join(globalStorageDir, extensionId);

  if (!fs.existsSync(globalStorageDir)) {
    console.log(`[vscode-cache] missing: ${globalStorageDir}`);
    console.log(`[vscode-cache] hint: try --channel insiders | --user-dir <.../User>`);
    return;
  }

  if (!fs.existsSync(targetDir)) {
    console.log(`[vscode-cache] no match for extension id: ${extensionId}`);
    console.log(`[vscode-cache] searched: ${globalStorageDir}`);
    return;
  }

  if (!isSubPath(targetDir, globalStorageDir)) throw new Error(`refuse to delete outside globalStorage: ${targetDir}`);

  const action = args.apply ? "rm -rf" : "dry-run rm -rf";
  console.log(`[vscode-cache] ${action} ${targetDir}`);
  if (args.apply) rmDir(targetDir);
}

module.exports = { parseArgs, cleanVscodeWorkspaceStorage, cleanVscodeGlobalStorage };
