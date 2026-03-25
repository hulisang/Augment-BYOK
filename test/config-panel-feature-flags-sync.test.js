const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildOfficialFeatureFlagsForUpstreamSync,
  formatSaveOfficialFeatureFlagsStatus,
  getRelevantOfficialBetaFlags,
  syncOfficialFeatureFlagsToUpstream
} = require("../payload/extension/out/byok/ui/config-panel");
const { defaultConfig } = require("../payload/extension/out/byok/config/default-config");

test("config-panel feature flag sync: preserves relevant official beta flags and rewrites model registry to byok", () => {
  const cfg = defaultConfig();
  const flags = buildOfficialFeatureFlagsForUpstreamSync(cfg, {
    default_model: "official-default",
    feature_flags: {
      enablePublicBetaPage: true,
      publicBetaEnableCustomCommands: true,
      publicBetaEnableSkills: true,
      model_registry: JSON.stringify({ "Official A": "official-a" })
    }
  });

  assert.equal(flags.enablePublicBetaPage, true);
  assert.equal(flags.publicBetaEnableCustomCommands, true);
  assert.equal(flags.publicBetaEnableSkills, true);

  const registryRaw = flags.model_registry ?? flags.modelRegistry;
  assert.equal(typeof registryRaw, "string");
  const registry = JSON.parse(registryRaw);
  assert.ok(Object.values(registry).every((value) => typeof value === "string" && value.startsWith("byok:")));
  assert.ok(!Object.values(registry).includes("official-a"));
});

test("config-panel feature flag sync: syncs transformed flags into running upstream featureFlagManager", () => {
  const cfg = defaultConfig();
  const calls = [];
  const previous = globalThis.__augment_byok_upstream;
  globalThis.__augment_byok_upstream = {
    augmentExtension: {
      featureFlagManager: {
        update(flags) {
          calls.push(flags);
        }
      }
    }
  };

  try {
    const result = syncOfficialFeatureFlagsToUpstream({
      cfg,
      json: {
        default_model: "official-default",
        feature_flags: {
          enablePublicBetaPage: true,
          publicBetaEnableMessageQueue: true,
          enableMessageQueue: false
        }
      }
    });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].enablePublicBetaPage, true);
    assert.equal(calls[0].publicBetaEnableMessageQueue, true);
  } finally {
    globalThis.__augment_byok_upstream = previous;
  }
});

test("config-panel feature flag sync: exposes concise relevant beta flag snapshot", () => {
  const out = getRelevantOfficialBetaFlags({
    enablePublicBetaPage: true,
    publicBetaEnableSubagents: false,
    enableSubagents: false,
    ignored: true
  });

  assert.deepEqual(out, {
    enablePublicBetaPage: true,
    publicBetaEnableSubagents: false,
    enableSubagents: false
  });
});

test("config-panel feature flag sync: injects beta fallback when official flags omit relevant keys", () => {
  const cfg = defaultConfig();
  const flags = buildOfficialFeatureFlagsForUpstreamSync(cfg, {
    default_model: "official-default",
    feature_flags: { some_flag: true }
  });

  assert.equal(flags.some_flag, true);
  assert.equal(flags.enablePublicBetaPage, true);
  assert.equal(flags.publicBetaOptInAll, false);
  assert.equal(flags.publicBetaCanvasExtensionFeatureEnable, false);
  assert.equal(flags.publicBetaEnableCustomCommands, false);
  assert.equal(flags.publicBetaEnableSkills, false);
  assert.equal(flags.publicBetaEnableMessageQueue, false);
  assert.equal(flags.publicBetaEnableSubagents, false);
  assert.equal(flags.canvasExtensionFeatureEnable, undefined);
  assert.equal(flags.enableCustomCommands, undefined);
  assert.equal(flags.enableSkills, undefined);
  assert.equal(flags.enableMessageQueue, undefined);
  assert.equal(flags.enableSubagents, undefined);
});

test("config-panel save status: uses concise sync success message", () => {
  assert.equal(
    formatSaveOfficialFeatureFlagsStatus({
      ok: true,
      flags: {
        enablePublicBetaPage: true,
        publicBetaEnableCustomCommands: false
      }
    }),
    "Saved (OK). Official feature flags synced."
  );
});

test("config-panel save status: reports sync skipped without dumping flags", () => {
  assert.equal(
    formatSaveOfficialFeatureFlagsStatus({
      ok: false,
      reason: "missing_feature_flag_manager",
      flags: {
        enablePublicBetaPage: true
      }
    }),
    "Saved (OK). Official feature flags fetched but runtime sync skipped."
  );
});

test("config-panel save status: reports sync failure details", () => {
  assert.equal(
    formatSaveOfficialFeatureFlagsStatus({
      error: "boom"
    }),
    "Saved (OK). Official feature flag sync failed: boom"
  );
});
