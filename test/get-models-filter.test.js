const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const official = require("../payload/extension/out/byok/config/official");

function loadFresh(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

function startGetModelsServer(responseJson, opts = {}) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (typeof opts.onRequest === "function") opts.onRequest(req);
      if (req.method === "POST" && req.url === "/get-models") {
        if (typeof opts.expectedAuthorization === "string" && req.headers.authorization !== opts.expectedAuthorization) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(responseJson));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}/` });
    });
  });
}

test("handleGetModels: filters upstream official models when BYOK models exist", async () => {
  const { maybeHandleCallApi } = loadFresh("../payload/extension/out/byok/runtime/shim/call-api");
  const { server, baseUrl } = await startGetModelsServer({
    default_model: "official-default",
    models: [{ name: "official-a" }, { name: "official-b" }],
    feature_flags: { some_flag: true, model_registry: JSON.stringify({ "Official A": "official-a" }) }
  });

  try {
    const out = await maybeHandleCallApi({ endpoint: "/get-models", body: {}, timeoutMs: 2000, upstreamCompletionURL: baseUrl });
    assert.ok(out && typeof out === "object");
    assert.equal(out.default_model, "byok:openai:gpt-5.2");
    assert.ok(Array.isArray(out.models));
    assert.ok(out.models.length > 0);
    for (const m of out.models) {
      assert.equal(typeof m.name, "string");
      assert.ok(m.name.startsWith("byok:"), `unexpected model leaked into picker: ${m.name}`);
    }

    const flags = out.feature_flags;
    assert.ok(flags && typeof flags === "object");
    assert.equal(flags.some_flag, true);

    const registryRaw = flags.model_registry ?? flags.modelRegistry;
    assert.equal(typeof registryRaw, "string");
    const registry = JSON.parse(registryRaw);
    assert.ok(registry && typeof registry === "object");
    for (const v of Object.values(registry)) {
      assert.equal(typeof v, "string");
      assert.ok(v.startsWith("byok:"), `unexpected registry entry leaked into picker: ${v}`);
    }
    assert.ok(!Object.values(registry).includes("official-a"));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("handleGetModels: uses local official completionUrl/apiToken to initialize real feature_flags", async () => {
  let seenAuthorization = "";
  const { server, baseUrl } = await startGetModelsServer(
    {
      default_model: "official-default",
      models: [{ name: "official-a" }],
      feature_flags: {
        enablePublicBetaPage: true,
        publicBetaEnableCustomCommands: true,
        model_registry: JSON.stringify({ "Official A": "official-a" })
      }
    },
    {
      expectedAuthorization: "Bearer tok_local_official",
      onRequest(req) {
        seenAuthorization = req.headers.authorization || "";
      }
    }
  );

  const original = official.getOfficialConnection;
  official.getOfficialConnection = () => ({ completionURL: baseUrl, apiToken: "tok_local_official" });

  try {
    const { maybeHandleCallApi } = loadFresh("../payload/extension/out/byok/runtime/shim/call-api");
    const out = await maybeHandleCallApi({ endpoint: "/get-models", body: {}, timeoutMs: 2000 });

    assert.equal(seenAuthorization, "Bearer tok_local_official");
    assert.ok(out && typeof out === "object");
    assert.equal(out.default_model, "byok:openai:gpt-5.2");
    assert.equal(out.feature_flags.enablePublicBetaPage, true);
    assert.equal(out.feature_flags.publicBetaEnableCustomCommands, true);

    const registryRaw = out.feature_flags.model_registry ?? out.feature_flags.modelRegistry;
    assert.equal(typeof registryRaw, "string");
    const registry = JSON.parse(registryRaw);
    assert.ok(Object.values(registry).every((value) => typeof value === "string" && value.startsWith("byok:")));
    assert.ok(!Object.values(registry).includes("official-a"));
  } finally {
    official.getOfficialConnection = original;
    await new Promise((r) => server.close(r));
  }
});

test("handleGetModels: injects beta whitelist fallback when official feature_flags omit beta keys", async () => {
  const { maybeHandleCallApi } = loadFresh("../payload/extension/out/byok/runtime/shim/call-api");
  const { server, baseUrl } = await startGetModelsServer({
    default_model: "official-default",
    models: [{ name: "official-a" }],
    feature_flags: { some_flag: true }
  });

  try {
    const out = await maybeHandleCallApi({ endpoint: "/get-models", body: {}, timeoutMs: 2000, upstreamCompletionURL: baseUrl });
    assert.ok(out && typeof out === "object");
    assert.equal(out.feature_flags.some_flag, true);
    assert.equal(out.feature_flags.enablePublicBetaPage, true);
    assert.equal(out.feature_flags.publicBetaOptInAll, false);
    assert.equal(out.feature_flags.publicBetaCanvasExtensionFeatureEnable, false);
    assert.equal(out.feature_flags.publicBetaEnableCustomCommands, false);
    assert.equal(out.feature_flags.publicBetaEnableSkills, false);
    assert.equal(out.feature_flags.publicBetaEnableMessageQueue, false);
    assert.equal(out.feature_flags.publicBetaEnableSubagents, false);
    assert.equal(out.feature_flags.canvasExtensionFeatureEnable, undefined);
    assert.equal(out.feature_flags.enableCustomCommands, undefined);
    assert.equal(out.feature_flags.enableSkills, undefined);
    assert.equal(out.feature_flags.enableMessageQueue, undefined);
    assert.equal(out.feature_flags.enableSubagents, undefined);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
