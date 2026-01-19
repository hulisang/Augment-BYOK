# ARCH：架构与最小补丁面（单 VSIX）

目标：**最小破坏面 + 可审计 + 可回滚**（只接管 13 个 LLM 数据面端点）。

构建（单一真相：`tools/build/build-vsix.js`）：

- 下载/解包上游 VSIX → `.cache/work/*`
- overlay payload → `extension/out/byok/*`
- patch `extension/package.json`：添加 BYOK 命令；移除 `augment.advanced.*` settings
- patch `extension/out/extension.js`：
  - prepend injector：`vendor/augment-interceptor/inject-code.augment-interceptor.v1.2.txt`
  - 注入 bootstrap：`./byok/runtime/bootstrap`
  - official overrides：`completionURL/apiToken` 改为 `globalState`
  - callApi shim：优先走 `./byok/runtime/shim-call-api`；callApiStream shim：优先走 `./byok/runtime/shim-call-api-stream`（`byok|official|disabled`）
  - guard：`autoAuth=0`、marker 存在、`node --check`、合约检查
- repack → `dist/*.vsix` + `upstream.lock.json` / `dist/upstream.lock.json`

运行时：

- `callApi/callApiStream` → `maybeHandleCallApi*()` → `decideRoute()` → `byok|official|disabled`
- `runtimeEnabled=false` 即软回滚：shim 返回 `undefined`/empty stream → 回到官方链路（不改配置）

代码布局（主要都在 `payload/extension/out/byok/*`）：

- `runtime/bootstrap.js`、`runtime/shim-call-api.js`、`runtime/shim-call-api-stream.js`
- `config/config.js`、`config/state.js`
- `ui/config-panel.*`、`core/*`、`providers/*`
