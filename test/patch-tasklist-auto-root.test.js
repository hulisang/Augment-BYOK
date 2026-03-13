const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { patchTasklistAutoRoot } = require("../tools/patch/patch-tasklist-auto-root");

function withTempDir(prefix, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeUtf8(filePath, content) {
  fs.writeFileSync(filePath, content, "utf8");
}

function readUtf8(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

test("patchTasklistAutoRoot: patches legacy upstream shape", () => {
  withTempDir("augment-byok-tasklist-", (dir) => {
    const filePath = path.join(dir, "extension.js");
    writeUtf8(
      filePath,
      [
        'class ViewTaskListTool{async call(a,b,c,d,e,f){try{let g=this._taskManager.getRootTaskUuid(f);if(!g)return et("No root task found.");return g}catch(g){return g}}}',
        'class UpdateTasksTool{async handleBatchUpdate(a,b){let c=this._taskManager.getRootTaskUuid(a);if(!c)return et("No root task found.");return c}}',
        'class AddTasksTool{async handleBatchCreation(a,b){let c=this._taskManager.getRootTaskUuid(a);if(!c)return et("No root task found.");return c}}',
        'class ReorganizeTaskListTool{async call(r,n,i,o,s,a){try{let c=r.markdown;if(!c)return et("No markdown provided.");let l=this._taskManager.getRootTaskUuid(a);if(!l)return et("No root task found.");return l}catch(c){return c}}}'
      ].join("\n")
    );

    const result = patchTasklistAutoRoot(filePath);
    const output = readUtf8(filePath);

    assert.equal(result.changed, true);
    assert.equal(result.skipped, false);
    assert.match(output, /createNewTaskList/);
    assert.match(output, /__augment_byok_tasklist_auto_root_patched_v1/);
  });
});

test("patchTasklistAutoRoot: skips when upstream already auto-creates task list", () => {
  withTempDir("augment-byok-tasklist-", (dir) => {
    const filePath = path.join(dir, "extension.js");
    const source = 'class ViewTaskListTool{async call(r,n,i,o,s,a){let c=await this._taskManager.getOrCreateTaskListId(a);if(!c)return et("No task list found. [TL001]");return c}}';
    writeUtf8(filePath, source);

    const result = patchTasklistAutoRoot(filePath);

    assert.equal(result.changed, false);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "upstream_has_auto_root");
    assert.match(result.warning, /getOrCreateTaskListId/);
    assert.equal(readUtf8(filePath), source);
  });
});
