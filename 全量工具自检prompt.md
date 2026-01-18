# 全量工具自检（人工提示词版 / 可复制）

你是一个具备工具调用能力的 AI 代理。你的任务是对**当前会话里真实可用的全部工具**做一次“端到端实测”，并输出可审计的测试报告。

目标是验证两件事：
1) 工具本身是否真的可用（能执行、能返回、能产生预期副作用）。  
2) 失败是否为真实原因（例如环境缺失、远程路由缺失、权限/安全策略拦截、参数不合法等）。

---

## A. 总体要求（必须遵守）
1) **逐个工具真实调用**：每个工具至少调用一次；能验证副作用就必须验证。  
2) **副作用隔离**：任何文件创建/编辑/删除只能发生在 `BYOK-test/` 下。  
3) **禁止越界**：禁止修改/删除 `BYOK-test/` 之外任何路径。  
4) **允许联网**：允许 `web-search` / `web-fetch` / `open-browser`。  
5) **参数自适配**：不同版本 schema 字段名可能不同（例如 `terminal_id` vs `terminalId`）。你必须按 schema 自适配字段名，但语义必须一致。  
6) **即时记账**：每次工具调用后立刻在内存中更新一条记录（后面汇总成表）。  
7) **失败分类**：  
   - 真实不可用（404/route not found/权限不足）：标记 **FAIL** 并写明根因与修复建议。  
   - 前置条件缺失（例如 tasklist 没有 root task）：标记 **SKIPPED** 并写明如何补齐前置条件。  
8) **最终输出**：必须输出一个 Markdown 表格（见文末模板），并在表格后追加“未覆盖项 + 需要我补充什么”。

---

## B. 本次期望覆盖的工具清单（23 个）
你必须覆盖（至少一次真实调用）：
1) `view`
2) `view-range-untruncated`
3) `search-untruncated`
4) `save-file`
5) `str-replace-editor`
6) `remove-files`
7) `launch-process`
8) `list-processes`
9) `read-process`
10) `write-process`
11) `read-terminal`
12) `kill-process`
13) `diagnostics`
14) `codebase-retrieval`
15) `web-search`
16) `web-fetch`
17) `open-browser`
18) `render-mermaid`
19) `view_tasklist`
20) `add_tasks`
21) `update_tasks`
22) `reorganize_tasklist`
23) `remember`

若某工具在当前会话根本不存在，则该工具行标记 `SKIPPED (tool not present)`。

> 现实差异提示：在很多 Augment 环境里，`web-search` 属于 **remoteToolHost**（走远程 `/agents/*` 或 `/relay/agents/*` 路由），而 `web-fetch` / `open-browser` 往往属于 **sidecarToolHost**（本地 sidecar 执行）。因此“`web-search` 404 但 `open-browser` 能打开网页”是**正常且可解释**的：一个是远程工具路由缺失，一个是本地打开浏览器。

---

## C. 初始化（必须先做）
### C1) 选定本次测试目录
- 令：`RUN_DIR = BYOK-test/manual-run-<8位随机>`（例如 `BYOK-test/manual-run-a1b2c3d4`）。

### C2) 用 `save-file` 创建探针文件（同时获取绝对路径）
1) 调用 `save-file` 创建：`${RUN_DIR}/abs_path_probe.txt`  
   - 内容：`ABS_PATH_PROBE`（单行即可）
2) 从工具输出中提取保存成功的**绝对路径**（通常会显示 `{ /abs/path/... }`）。记为 `ABS_PROBE_PATH`。  
3) 由 `ABS_PROBE_PATH` 推导 `ABS_WORKSPACE_ROOT`（后续若 `launch-process` 需要绝对 cwd/workdir，就用它）。

> 若你遇到 `launch-process` 报错：`working directory is not an absolute path: x`，说明 schema 里存在 cwd/workdir 字段且你填错了。解决：把该字段填 `ABS_WORKSPACE_ROOT`。

---

## D. 逐工具实测步骤（必须按顺序）
### 1) `view`（至少 3 次）
1) 目录：`type=directory path=${RUN_DIR}`  
2) 文件：`type=file path=${RUN_DIR}/abs_path_probe.txt`  
3) 正则：在该文件中搜索 `ABS_PATH_PROBE`（用 `search_query_regex` 或等价字段）

### 2) `str-replace-editor`（并验证副作用）
- 把 `${RUN_DIR}/abs_path_probe.txt` 中的 `ABS_PATH_PROBE` 替换为 `ABS_PATH_PROBE_REPLACED`。  
- 再调用一次 `view(type=file)` 验证内容确实变化。

### 3) `remove-files`（并验证副作用）
- 删除 `${RUN_DIR}/abs_path_probe.txt`。  
- 再 `view(type=directory)` 验证该文件不存在（或 `view(type=file)` 预期报错也可作为证据）。

### 4) `view-range-untruncated` + `search-untruncated`（需要 reference_id）
目标：真实验证“截断引用链路”是否可用。
1) 先生成大文件 `${RUN_DIR}/big.txt`（避免在对话里塞几千行内容）。  
   - 推荐方式：用 `save-file` 写入（内容可用循环构造），或用 `launch-process` 在终端生成。  
   - 内容要求：至少几千行，并且在某一行包含 `NEEDLE_4242`（例如第 4242 行）。
2) **关键点**：`reference_id` 不来自 `view` 的 `<response clipped>`，而来自“截断 footer”。  
   - 该 footer 通常由 `launch-process` 的大输出触发，形如：`[This result was truncated ... Reference ID: <REF_ID>]`
3) 用 `launch-process(wait=true)` **输出该文件内容**以触发截断 footer：  
   - 若 schema 有 cwd/workdir 字段：填 `ABS_WORKSPACE_ROOT`。  
   - Linux/macOS：`cat -n ${RUN_DIR}/big.txt`（或 `cat ${RUN_DIR}/big.txt`）  
   - Windows：`powershell -NoProfile -Command "Get-Content -Path ${RUN_DIR}/big.txt"`  
4) 从 `launch-process` 的输出文本中提取 `REF_ID`（匹配 `Reference ID: ...`）。  
5) 调用 `view-range-untruncated(reference_id=REF_ID, start_line=4200, end_line=4260)`。  
6) 调用 `search-untruncated(reference_id=REF_ID, search_term=NEEDLE_4242, context_lines=2)`。  
7) 若输出足够大但仍没有 `Reference ID:` footer：两项标记 **FAIL**，备注“未启用/不支持 untruncated content storage（enableUntruncatedContentStorage），导致 reference_id 不可获得”。若是因为环境缺少 `cat/powershell` 等命令无法触发大输出，则标记 **SKIPPED** 并写明缺失项。

### 5) 进程/终端工具组（共 6 个）
目标：验证进程生命周期与读写链路。
1) `launch-process`（短命令）：运行 `echo BYOK_SELFTEST_PROCESS`（wait=true）。  
2) `launch-process`（长驻交互）：启动可交互 shell（Linux/mac：`sh`；Windows：`powershell -NoProfile -NoLogo`）（wait=false）。  
   - 若 schema 需要 cwd/workdir：填 `ABS_WORKSPACE_ROOT`。  
   - 从输出里提取 `terminal_id`；若没有，就用 `list-processes` 找“最新的/刚创建的”。
3) `list-processes`：确认交互 shell 的 `terminal_id`。  
4) `write-process`：向该 `terminal_id` 写入 `echo BYOK_WRITE_TEST` + 换行。  
5) `read-process`：读取输出，确认出现 `BYOK_WRITE_TEST`（副作用验证）。  
6) `read-terminal`：读取当前活动终端输出（有返回即可）。  
7) `kill-process`：杀掉交互 shell 的 `terminal_id`（尽量再 `list-processes` 作为佐证）。

### 6) `diagnostics`
目标：验证 diagnostics 能回传诊断结果。
1) `save-file` 新建 `${RUN_DIR}/diag_test.ts`，内容：`const x = ;`  
2) 调用 `diagnostics` 仅检查该文件路径。  
3) 若返回 “No diagnostics found.” 也算工具调用成功，但备注“可能未接入语言服务/诊断源”。

### 7) `codebase-retrieval`
- 查询：`BYOK-test 目录在本仓库/环境中的用途是什么？` 并记录命中摘要。

### 8) Web 工具组
1) `web-search`：查询 `example.com robots.txt`。  
   - 若返回 404/route not found：标记 FAIL，并备注“remoteToolHost 的 /agents/*（或 /relay/agents/*）路由缺失/未部署；需要把 completion_url 指向真实 Augment tenant，或在你的代理实现 `agents/run-remote-tool` / `check-tool-safety` 等路由”。  
   - 说明：`web-search` **不会**本地打开浏览器；“打开网页”请用 `open-browser`。  
2) `web-fetch`：抓取 `https://example.com`，记录标题/正文片段。  
3) `open-browser`：打开 `https://example.com`（仅 1 次）。

### 9) `render-mermaid`
- 渲染最小流程图（例如 `Tools -> callTool -> Result`），记录返回。

### 10) 任务列表工具组（共 4 个）
说明：部分会话没有初始化 root task，会返回 `No root task found.`，属于前置条件缺失。
1) `view_tasklist`：调用并记录输出/错误。  
2) 若 `view_tasklist` 成功：  
   - `add_tasks`：新增任务（标题包含 `BYOK Manual Self Test Task`）。  
   - `update_tasks`：把任务置为 `IN_PROGRESS` 再置为 `COMPLETE`。  
   - `reorganize_tasklist`：做一次最小重排（把该行移动到最前）。  
     - **关键格式要求（避免 `level 1 has no parent`）**：提交给 `reorganize_tasklist.markdown` 的内容建议只包含“任务行”，不要包含 `# Current Task List` 这类标题/说明行。  
     - 第一条任务行必须是 **root(level=0)**：形如 `[ ] UUID:... NAME:...`（**不能**以 `-` 开头）。  
     - 其余子任务用 `-`/`--`/`---` 表示层级（允许 `-[ ]` 或 `- [ ]`）；不要出现 `--` 但前面从未出现 `-` 的“层级跳跃”。  
3) 若 `view_tasklist` 失败且提示无 root：后三项标记 **SKIPPED**，备注“需要在对话中先初始化任务列表（UI 打开 Task List / 创建任意任务后重跑）”。

### 11) `remember`
- 写入长期记忆：`BYOK-test 是工具全量测试目录`。

---

## E. 报告输出模板（必须使用）
最终输出一个表格（必须包含上面 23 个工具；即使 SKIPPED 也要列出）：

| 工具 | 调用目的 | 关键参数（精简） | 结果（精简） | 状态(SUCCESS/FAIL/SKIPPED) | 备注/失败原因 |
|---|---|---|---|---|---|

并在表格后追加：
1) **未覆盖项清单**（若有）  
2) **为达到 100% 覆盖，需要我补充的前置条件/配置/权限**（例如：remote tools 的 /agents/* 路由、tasklist root 初始化方式、launch-process 的 cwd 字段名等）

现在开始执行。注意：文件/进程有依赖关系，请严格按顺序推进；每次工具调用都要即时记账，避免漏项。  
