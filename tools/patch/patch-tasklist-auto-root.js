#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const { ensureMarker, replaceOnceRegex } = require("../lib/patch");

const MARKER = "__augment_byok_tasklist_auto_root_patched_v1";

function patchTasklistAutoRoot(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`missing file: ${filePath}`);
  const original = fs.readFileSync(filePath, "utf8");
  if (original.includes(MARKER)) return { changed: false, reason: "already_patched" };

  let next = original;

  // Tasklist tools require a conversation-scoped root task list uuid.
  // Upstream creates it lazily via webview flows; direct tool calls can see "No root task found."
  // Patch: if root is missing but we have a conversationId, create it on demand.
  const cap = (m, idx, ctx, name) => {
    const v = String(m[idx] || "");
    if (!v) throw new Error(`tasklist auto root: ${ctx} ${name} capture missing`);
    return v;
  };

  const ensureRoot = (rootVar, conversationIdVar, errFnVar) =>
    `let ${rootVar}=this._taskManager.getRootTaskUuid(${conversationIdVar});` +
    `if(!${rootVar}&&${conversationIdVar}&&typeof this._taskManager.createNewTaskList===\"function\"){${rootVar}=await this._taskManager.createNewTaskList(${conversationIdVar});}` +
    `if(!${rootVar})return ${errFnVar}(\"No root task found.\");`;

  // 1) view_tasklist
  next = replaceOnceRegex(
    next,
    /async call\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{try\{let\s+([A-Za-z_$][\w$]*)=this\._taskManager\.getRootTaskUuid\(\6\);if\(!\7\)return\s*([A-Za-z_$][\w$]*)\("No root task found\."\);/g,
    (m) => {
      const ctx = "view_tasklist";
      const p1 = cap(m, 1, ctx, "p1");
      const p2 = cap(m, 2, ctx, "p2");
      const p3 = cap(m, 3, ctx, "p3");
      const p4 = cap(m, 4, ctx, "p4");
      const p5 = cap(m, 5, ctx, "p5");
      const convVar = cap(m, 6, ctx, "conversationId");
      const rootVar = cap(m, 7, ctx, "rootVar");
      const errFnVar = cap(m, 8, ctx, "errFn");
      return `async call(${p1},${p2},${p3},${p4},${p5},${convVar}){try{${ensureRoot(rootVar, convVar, errFnVar)}`;
    },
    "tasklist auto root: view_tasklist"
  );

  // 2) update_tasks: handleBatchUpdate
  next = replaceOnceRegex(
    next,
    /async handleBatchUpdate\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{let\s+([A-Za-z_$][\w$]*)=this\._taskManager\.getRootTaskUuid\(\1\);if\(!\3\)return\s*([A-Za-z_$][\w$]*)\("No root task found\."\);/g,
    (m) => {
      const ctx = "update_tasks";
      const convVar = cap(m, 1, ctx, "conversationId");
      const tasksVar = cap(m, 2, ctx, "tasks");
      const rootVar = cap(m, 3, ctx, "rootVar");
      const errFnVar = cap(m, 4, ctx, "errFn");
      return `async handleBatchUpdate(${convVar},${tasksVar}){${ensureRoot(rootVar, convVar, errFnVar)}`;
    },
    "tasklist auto root: update_tasks"
  );

  // 3) add_tasks: handleBatchCreation
  next = replaceOnceRegex(
    next,
    /async handleBatchCreation\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{let\s+([A-Za-z_$][\w$]*)=this\._taskManager\.getRootTaskUuid\(\1\);if\(!\3\)return\s*([A-Za-z_$][\w$]*)\("No root task found\."\);/g,
    (m) => {
      const ctx = "add_tasks";
      const convVar = cap(m, 1, ctx, "conversationId");
      const tasksVar = cap(m, 2, ctx, "tasks");
      const rootVar = cap(m, 3, ctx, "rootVar");
      const errFnVar = cap(m, 4, ctx, "errFn");
      return `async handleBatchCreation(${convVar},${tasksVar}){${ensureRoot(rootVar, convVar, errFnVar)}`;
    },
    "tasklist auto root: add_tasks"
  );

  // 4) reorganize_tasklist
  next = replaceOnceRegex(
    next,
    /let\s+([A-Za-z_$][\w$]*)=r\.markdown;if\(!\1\)return\s*([A-Za-z_$][\w$]*)\("No markdown provided\."\);let\s+([A-Za-z_$][\w$]*)=this\._taskManager\.getRootTaskUuid\(([A-Za-z_$][\w$]*)\);if\(!\3\)return\s*\2\("No root task found\."\);/g,
    (m) => {
      const ctx = "reorganize_tasklist";
      const markdownVar = cap(m, 1, ctx, "markdownVar");
      const errFnVar = cap(m, 2, ctx, "errFn");
      const rootVar = cap(m, 3, ctx, "rootVar");
      const convVar = cap(m, 4, ctx, "conversationId");
      return (
        `let ${markdownVar}=r.markdown;if(!${markdownVar})return ${errFnVar}(\"No markdown provided.\");` +
        ensureRoot(rootVar, convVar, errFnVar)
      );
    },
    "tasklist auto root: reorganize_tasklist"
  );

  next = ensureMarker(next, MARKER);
  fs.writeFileSync(filePath, next, "utf8");
  return { changed: true, reason: "patched" };
}

module.exports = { patchTasklistAutoRoot };

if (require.main === module) {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error(`usage: ${path.basename(process.argv[1])} <extension/out/extension.js>`);
    process.exit(2);
  }
  patchTasklistAutoRoot(filePath);
}
