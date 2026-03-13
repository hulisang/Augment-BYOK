# 上游 Augment VSIX 破坏性变更分析

> 触发时间：2026-03-11（`upstream-check` CI 失败）
> 上游版本：**0.814.0**（以 `.cache/work/check/extension/package.json` 为准）
> 分析方法：
> 1. 下载最新上游 VSIX 并解压到本地 `.cache/work/check`
> 2. 对比 `common-webviews/assets/` 文件结构与关键符号分布
> 3. 直接用现有 `patch-webview-tooluse-fallback.js` 的候选文件规则与 3 个旧正则在新 bundle 上做匹配验证
> 4. 用 `patch-webview-history-summary-node.js` 的正则验证是否仍能命中
>
> 备注：仓库根 `upstream.lock.json` 当前仍是 `0.801.0`；本文以上游解包目录中的 `0.814.0` 产物为准。

---

## 报错信息

```text
[build] patch webview assets (tool cards fallback)
[build] ERROR: Error: AugmentMessage asset not found (upstream may have changed)
    at patchWebviewToolUseFallback (tools/patch/patch-webview-tooluse-fallback.js:125:33)
    at applyByokPatches (tools/lib/byok-workflow.js:53:3)
```

---

## 结论摘要

### 1. 直接失败原因

`patch-webview-tooluse-fallback.js` 在候选文件发现阶段就会失败，因为它只扫描：

```javascript
name.startsWith("AugmentMessage-") && name.endsWith(".js")
```

而在上游 `0.814.0` 的 `.cache/work/check/extension/common-webviews/assets/` 中，`AugmentMessage-*.js` 的候选数实测为 **0**。

### 2. 更深层的失效原因

问题不只是“文件名变了”。

即便把目标文件改成新的 `main-panel-D-4dFiI7.js`，当前 `patch-webview-tooluse-fallback.js` 中的 3 个旧正则也已经全部不命中：

```json
[
  { "name": "tool_list", "matched": false },
  { "name": "tool_list_ungrouped", "matched": false },
  { "name": "tool_state", "matched": false }
]
```

因此后续修复不能只把 `AugmentMessage-` 改成 `main-panel-`，必须连 3 个 patch 的匹配逻辑一起重写。

### 3. 当前未受影响的部分

`patch-webview-history-summary-node.js` 里的 `summaryNodeRe` 在新的 `extension-client-context-CAhh8CsG.js` 上实测仍然命中，当前这块 patch 仍可用。

### 4. 仍需运行时验证的部分

从静态解包结果看，`toolUseState` 和 `$displayableToolUseNodes` 仍然是 store 驱动；因此“重启后工具卡片空白问题可能仍然存在”是**高置信判断**。但这不是静态分析能完全证明的事实，仍需安装 VSIX 后做一次“工具调用 -> 重启 -> 回看历史卡片”的运行时验证。

### 5. 运行时验证结果（2026-03-12，本地手工验证）

已按 `B -> C -> A` 的推荐顺序执行到 `C`，并完成一次真实运行时验证：

1. 在未恢复 `tooluse-fallback` patch 的前提下构建并安装 VSIX
2. 执行真实工具调用，生成历史工具卡片
3. 对话完成后立即查看，工具卡片标题、参数区、输出区均正常显示
4. 重启 IDE 后再次查看同一段历史，工具卡片展开后仍然有完整内容

本次运行时验证结论：

- **未复现“重启后历史工具卡片空白”问题**
- 这说明上游 `0.814.0` 至少在本次验证路径上，已经能够恢复历史工具卡片的主体内容
- 因此，静态分析阶段对“空白问题仍可能存在”的判断，需要以下面的运行时结果为准进行修正

但同时观察到一个新的轻微展示退化：

- 历史 **MCP 工具卡片** 在重启后，标题中的 MCP 图标未恢复
- 标题会退化显示为具体 MCP 命令名，例如 `zhi_cunzhi`、`ji_cunzhi`
- **非 MCP 工具卡片**（例如创建文件）的标题图标仍正常显示

这说明当前更像是“**MCP 历史标题元数据 / 图标映射未完全恢复**”的问题，而不是原先关注的“历史工具卡片空白”问题。

---

## 上游变化总结

### 1. 文件与职责迁移

| 旧文件名模式 | 新文件名模式 | 状态 |
|-------------|-------------|------|
| `AugmentMessage-*.js` | **已删除** | ❌ 不再存在 |
| *(新增)* | `ChatMessage-DEPp7-VX.js` (39KB) | 轻量壳组件，未检出 tool 相关关键字 |
| *(新增)* | `main-panel-D-4dFiI7.js` (504KB) | **tool 列表 / tool 状态 / tool 卡片分派逻辑迁入此文件** |
| `extension-client-context-*.js` | `extension-client-context-CAhh8CsG.js` (2.6MB) | ✅ 文件名模式不变 |

额外实测：

- 当前 patch 脚本的候选文件发现规则在新 assets 目录上返回 **0** 个 `AugmentMessage-*.js`。
- `ChatMessage-DEPp7-VX.js` 中对 `displayableToolUseNodes|toolUseState|tool_use|toolUseNodes|TOOL_USE|HISTORY_SUMMARY` 的搜索结果为空。
- `main-panel-D-4dFiI7.js` 中能直接检出 `displayableToolUseNodes`、`toolUseNodes`、`toolUseState`、`tool_use` 等关键符号。

### 2. 编译产物形态变化：从旧 store/reactive 结构转为 Svelte 5 风格

这里的判断来自**编译产物特征**，不是直接读取上游源码仓库。按产物形态看，上游已经切到 Svelte 5 / runes 风格：

```diff
- // 旧结构：store subscription + reactive declaration
- const X = Y((()=> Z().filter((n)=>!!n.tool_use)));
- i = ()=> G(e(H), "$toolUseState", K)

+ // 新结构：derived/runes 风格包装
+ const p = l(()=> J(t(u),"$displayableToolUseNodes",s).map(k=>k.tool_use).filter(k=>!!k))
+ const I = l(()=> Bl(e.requestId, e.toolUse.tool_use_id))
+ const o = ()=> J(t(I), "$toolUseState", c)
+ Ve(()=>{ Ir(y, {toolUseState: o(), ...}) })
```

这意味着我们原来依赖的“旧编译产物形态”正则已经不能再复用。

### 3. 关键字分布变化

对新上游 `common-webviews/assets/` 中所有 `.js` 文件搜索关键字：

| 关键字 | 所在文件 |
|-------|---------|
| `displayableToolUseNodes` | `main-panel-*.js` |
| `toolUseState` | `extension-client-context-*.js`, `main-panel-*.js` |
| `tool_use` | `extension-client-context-*.js`, `main-panel-*.js`, `SimpleMonaco-*.js` |
| `toolUseNodes` | `main-panel-*.js` |
| `TOOL_USE` | `extension-client-context-*.js`, `main-panel-*.js` |
| `HISTORY_SUMMARY` | `extension-client-context-*.js` |

补充说明：

- `ChatMessage-DEPp7-VX.js` 对上述关键字搜索为空，说明它更像展示壳层，不是 tool 逻辑的主要承载 bundle。
- `main-panel-D-4dFiI7.js` 中同时出现 `function S$`、`function z$`、`function br`、`Bl.select(g.getState(), ...)` 等结构，和 tool 列表 / tool 状态 / 单卡片渲染的职责对应关系一致。

---

## 受影响的 BYOK Patch 详细分析

### `patch-webview-tooluse-fallback.js` — **入口失效，且 3 个旧 patch 在新 bundle 上全部不命中**

这块要拆成两层看：

- 第一层：当前 CI 的直接报错来自“候选文件发现失败”，因为脚本只扫描 `AugmentMessage-*.js`。
- 第二层：即便手动把目标切到 `main-panel-D-4dFiI7.js`，现有 3 个旧 regex 也已经全部不命中。

也就是说，后续修复不能只改“文件名查找规则”，而要把 3 个 patch 一起重写。

#### Patch 1: `tool_list`（grouped 分支）

**旧正则目标：**

```javascript
// 旧代码（AugmentMessage 中）
const X=Y((()=> Z().filter((n)=>!!n.tool_use)));
```

**新代码（main-panel 中的 `S$` 函数）：**

```javascript
const u = l(()=>Wl(e.conversationId,e.requestId));
const p = l(()=>J(t(u),"$displayableToolUseNodes",s)
  .map(k=>k.tool_use)
  .filter(k=>!!k));

e.toolUseNodes !== void 0 && e.toolUseNodes.length > 0 && k(f)
```

**关键差异：**

- 不再是 `src().filter(n => !!n.tool_use)` 的旧形态，而是先 `.map(k => k.tool_use)` 再 `.filter(k => !!k)`。
- reactive wrapper 从 `Y((()=>...))` 变成 `l(()=>...)`。
- 列表渲染 gate 也从旧结构变成 `e.toolUseNodes !== void 0 && e.toolUseNodes.length > 0`。

#### Patch 2: `tool_list_ungrouped`

**旧正则目标：**

```javascript
X=Y((()=>Z(e(W),"$displayableToolUseNodes",K).map((...)).filter((...))))
```

**新代码（main-panel 中的 `z$` 函数）：**

```javascript
const s = ()=>J(t(u),"$displayableToolUseNodes",o);
const {store:g} = on();
function f(M,R){return Bl.select(g.getState(),M,R)}
```

**关键差异：**

- ungrouped 分支不再走旧的单一 `.map().filter()` 入口。
- 它现在一边读 `$displayableToolUseNodes`，一边直接通过 `Bl.select(g.getState(), M, R)` 取 tool state。
- 这意味着原来的正则匹配点已经不存在，不是简单改变量名能修。

#### Patch 3: `tool_state`

**旧正则目标：**

```javascript
// 旧代码：直接 store selector
X = ()=> G(e(H), "$toolUseState", K)
```

**新代码（main-panel 中的 `br` 函数）：**

```javascript
const I = l(()=>Bl(e.requestId, e.toolUse.tool_use_id));
const o = ()=> J(t(I), "$toolUseState", c);

({toolUse: e.toolUse, toolUseState: o(), ...})

Ve(()=>{
  Ir(y, {toolUse: e.toolUse, toolUseState: o(), ...})
});
```

**关键差异：**

- `toolUseState` 仍然来自 store selector，但现在包裹在 `l(()=>...)` 里。
- `toolUseState` 通过 props 传给各类工具卡片组件，而不是旧结构中的直接读取点。
- 旧 regex 依赖的 `() => G(e(H), "$toolUseState", K)` 形态已不存在。

#### 实测结论

对 `main-panel-D-4dFiI7.js` 直接执行现有 3 个旧正则，结果如下：

```json
[
  { "name": "tool_list", "matched": false },
  { "name": "tool_list_ungrouped", "matched": false },
  { "name": "tool_state", "matched": false }
]
```

因此这一块的修复要求是：

- 先改候选文件发现逻辑，识别新的 `main-panel-*.js`
- 再按新编译产物形态重写 3 个 patch
- 仅修改 `AugmentMessage-` → `main-panel-` **无效**

---

### `patch-webview-history-summary-node.js` — ✅ **仍然可用**

已用现有 `summaryNodeRe` 在 `extension-client-context-CAhh8CsG.js` 上直接验证，结果：

```text
matched: true
```

当前正则：

```javascript
const summaryNodeRe = /\{id:0,type:(\w+)\.HISTORY_SUMMARY,history_summary_node:([A-Za-z_$][0-9A-Za-z_$]*)\}/g;
```

匹配目标仍然存在：

```javascript
{id:0,type:Se.HISTORY_SUMMARY,history_summary_node:s}
```

结论：

- 这块 patch 当前不需要跟着 `tooluse-fallback` 一起重写。
- 后续修复优先级应放在 `patch-webview-tooluse-fallback.js`。

---

## toolUseState 数据流分析（新架构）

```text
┌─────────────────────────────────────────────┐
│       extension-client-context store        │
│    (Redux-like state, 含 toolUseState)      │
└───────────────────┬─────────────────────────┘
                    │ Bl(requestId, toolUseId) -- store selector
                    ▼
┌─────────────────────────────────────────────┐
│             main-panel (br 函数)            │
│  I = l(()=>Bl(requestId, toolUseId))        │
│  o = ()=> J(t(I), "$toolUseState", c)       │
│  Ve(()=>{ Ir(y, {toolUseState: o(), ...})}) │
└───────────────────┬─────────────────────────┘
                    │ props: e.toolUseState
                    ▼
┌─────────────────────────────────────────────┐
│            各工具卡片组件                    │
│  Shell / EditFile / ViewFile / SubAgent ... │
│  直接读取: e.toolUseState.phase             │
│            e.toolUseState.result?.text      │
└─────────────────────────────────────────────┘
```

**静态结论：**

- `toolUseState` 仍然不是“纯 props 源头数据”，它本质上仍来自 store。
- 从静态结构看，没有看到“彻底去 store 化”的证据。
- 因此“重启后 store 未恢复导致工具卡片空白”仍是高置信风险。

**仍待验证：**

- Svelte 5 的 effect/derived 机制是否已经让重挂载路径具备新的上游兜底。
- 这个问题必须通过真实 VSIX 安装后的运行时测试确认。

---

## displayableToolUseNodes 数据流分析

```text
┌─────────────────────────────────────────────┐
│       extension-client-context store        │
│    (含 $displayableToolUseNodes)            │
└───────────────────┬─────────────────────────┘
                    │ J(t(u), "$displayableToolUseNodes", s)
                    ▼
┌─────────────────────────────────────────────┐
│  main-panel: S$ 函数 (grouped 分支)         │
│  p = l(()=>J(t(u), "$displayableToolUseNodes", s)│
│      .map(k=>k.tool_use).filter(k=>!!k))    │
│  gate: e.toolUseNodes !== void 0 &&         │
│        e.toolUseNodes.length > 0            │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│  main-panel: z$ 函数 (ungrouped 分支)       │
│  s = ()=>J(t(u), "$displayableToolUseNodes", o)│
│  + Bl.select(g.getState(), M, R)            │
└─────────────────────────────────────────────┘
```

**静态结论：**

- `$displayableToolUseNodes` 仍然来自 store。
- grouped 分支新增了 `e.toolUseNodes !== void 0 && e.toolUseNodes.length > 0` 的 gate。
- 这说明上游组件层拿到了 `toolUseNodes` props，但静态分析无法证明这些 props 是否已经足够覆盖“重启后 store 缺失”的场景。

**仍待验证：**

- 如果 `toolUseNodes` props 能独立于 store 提供完整历史数据，上游可能已经部分修复空白问题。
- 这个判断仍要依赖运行时验证，不能仅凭静态 bundle 下结论。

---

## 修复方案选项

### 方案 A：正式适配新上游，重写 `tooluse-fallback` patch

适用场景：运行时验证后确认“重启空白问题仍存在”，需要继续保留 BYOK 自己的 fallback。

必做内容：

1. 修改 `patchWebviewToolUseFallback` 的候选文件发现逻辑：`AugmentMessage-*` → 新的 `main-panel-*`
2. 按 `main-panel-D-4dFiI7.js` 的新结构重写 3 个 patch
3. 重新验证 grouped / ungrouped / 单卡片三条路径

注意：

- **只改文件查找规则不够**，因为 3 个旧 regex 已经全部不命中。
- 这不是“小修补”，而是一次针对新 bundle 结构的重写。

### 方案 B：先恢复构建，把 `tooluse-fallback` 从 hard error 改为 soft warning + skip

适用场景：先解除 `upstream-check` / 构建阻塞。

做法：

- `patchWebviewToolUseFallback` 在找不到目标 bundle 时不要直接抛错
- 改为 warning 并继续执行后续 patch

优点：

- 改动最小
- 能快速让构建恢复
- 不影响 `history-summary` 等其他 patch 继续工作

风险：

- 如果上游实际上还没修复“重启空白问题”，那构建虽恢复，运行时问题仍会保留

### 方案 C：先做运行时验证，再决定是否进入方案 A

建议步骤：

1. 在“不打 `tooluse-fallback` patch”的情况下构建 VSIX
2. 安装到本地 VS Code
3. 执行真实工具调用，产生历史工具卡片
4. 重启窗口或重载扩展
5. 检查历史工具卡片是否仍然空白

判断：

- 本次实测：**未复现历史工具卡片空白**
- 当前更接近“历史 MCP 工具标题图标退化为命令名”的轻微展示问题
- 因此，不足以继续按原目标进入方案 A 重写 `tooluse-fallback` patch
- 若后续要继续处理，应按新的问题定义单独评估是否需要增加一个仅影响 MCP 历史标题展示的补丁，或直接接受该轻微退化

### 推荐执行顺序

推荐顺序：**B -> C -> A**

原因：

- B 先解锁构建
- C 再确认上游是否已经自带修复
- 当前运行时结果表明：原先需要 `A` 解决的“空白卡片”主问题未复现
- 因此 `A` 不应默认继续推进；只有在后续又复现空白问题，或确认必须修复 MCP 历史标题图标退化时，才需要重新定义补丁目标后再决定是否实施

---

## 附录：新上游 `main-panel` 中的关键函数签名

```javascript
// S$ — grouped tool list 组件
function S$(a, e) {
  const u = l(()=>Wl(e.conversationId, e.requestId));
  const p = l(()=>J(t(u), "$displayableToolUseNodes", s)
    .map(k=>k.tool_use).filter(k=>!!k));
  // gate: e.toolUseNodes !== void 0 && e.toolUseNodes.length > 0
}

// z$ — ungrouped tool list 组件
function z$(a, e) {
  const s = ()=>J(t(u), "$displayableToolUseNodes", o);
  const {store:g} = on();
  function f(M, R) { return Bl.select(g.getState(), M, R) }
}

// br — 单个工具卡片组件
function br(a, e) {
  const I = l(()=>Bl(e.requestId, e.toolUse.tool_use_id));
  const o = ()=> J(t(I), "$toolUseState", c);
  Ve(()=>{ Ir(y, {toolUse: e.toolUse, toolUseState: o(), ...}) });
}
```
