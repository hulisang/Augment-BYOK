const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { patchWebviewToolUseFallback } = require("../tools/patch/patch-webview-tooluse-fallback");

function withTempDir(prefix, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeUtf8(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function readUtf8(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function makeFixture() {
  return [
    // tool list nodes (grouped path)
    "const C=a((()=>f().filter((d=>!!d.tool_use))));",
    // layout decision
    "D(z,(O=>{f().length===1?O(R):O(F,!1)}));",
    // render gate
    "D(w,(d=>{f()?.length&&d(m)}));",
    // ungrouped tool list (enableGroupedTools=false path)
    'T=a((()=>fe(e(E),"$displayableToolUseNodes",o).map((i=>i.tool_use)).filter((i=>!!i))));',
    // tool card state gate ($toolUseState)
    'function eo(n,t){const o=1,f=()=>fe(e(h),"$toolUseState",$),k=1}',
    ""
  ].join("");
}

test("patchWebviewToolUseFallback: patches tool list", () => {
  withTempDir("augment-byok-webview-tooluse-", (dir) => {
    const extDir = path.join(dir, "extension");
    const assetsDir = path.join(extDir, "common-webviews", "assets");
    const filePath = path.join(assetsDir, "AugmentMessage-test.js");
    writeUtf8(filePath, makeFixture());

    patchWebviewToolUseFallback(extDir);

    const out = readUtf8(filePath);
    assert.ok(out.includes("__byok_tool_list_fallback"), "tool list fallback not applied");
    assert.ok(out.includes("e(C).length===1?O(R):O(F,!1)"), "layout gate not patched");
    assert.ok(out.includes("e(C).length&&d(m)"), "render gate not patched");
    assert.ok(out.includes("__augment_byok_webview_tooluse_fallback_v1"), "tool list marker missing");
    assert.ok(out.includes("__byok_tool_list_ungrouped_fallback"), "ungrouped tool list fallback not applied");
    assert.ok(out.includes("t.toolUseNodes.map"), "ungrouped tool list fallback not applied");
    assert.ok(out.includes("__augment_byok_webview_tooluse_fallback_v1_ungrouped"), "ungrouped marker missing");
    assert.ok(out.includes("__byok_toolUseId"), "tool state fallback not applied");
    assert.ok(out.includes("contentNodes:[]}}},k=1"), "tool state arrow function not closed before const decl");
    assert.ok(out.includes("__augment_byok_webview_tooluse_fallback_v1_tool_state"), "tool state marker missing");
  });
});

test("patchWebviewToolUseFallback: skips when candidate asset missing", () => {
  withTempDir("augment-byok-webview-tooluse-", (dir) => {
    const extDir = path.join(dir, "extension");
    const assetsDir = path.join(extDir, "common-webviews", "assets");
    const filePath = path.join(assetsDir, "main-panel-test.js");
    writeUtf8(filePath, "const noop=1;\n");

    const result = patchWebviewToolUseFallback(extDir);

    assert.equal(result.changed, false);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "asset_not_found");
    assert.match(result.warning, /AugmentMessage asset not found/);
    assert.equal(readUtf8(filePath), "const noop=1;\n");
  });
});

test("patchWebviewToolUseFallback: skips when upstream shape no longer matches", () => {
  withTempDir("augment-byok-webview-tooluse-", (dir) => {
    const extDir = path.join(dir, "extension");
    const assetsDir = path.join(extDir, "common-webviews", "assets");
    const filePath = path.join(assetsDir, "AugmentMessage-test.js");
    writeUtf8(filePath, "const noop=1;\n");

    const result = patchWebviewToolUseFallback(extDir);

    assert.equal(result.changed, false);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "upstream_changed");
    assert.match(result.warning, /upstream may have changed/);
    assert.equal(readUtf8(filePath), "const noop=1;\n");
  });
});
