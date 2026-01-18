"use strict";

const { normalizeEndpoint, normalizeString, parseByokModelId } = require("../infra/util");

function pickRequestedModel(body) {
  if (!body || typeof body !== "object") return "";
  const v = body.model ?? body.model_name ?? body.modelName ?? body.provider_model_name ?? body.providerModelName;
  return normalizeString(v);
}

function getRule(cfg, endpoint) {
  const rules = cfg?.routing?.rules && typeof cfg.routing.rules === "object" ? cfg.routing.rules : null;
  const r = rules && rules[endpoint] && typeof rules[endpoint] === "object" ? rules[endpoint] : null;
  return r || null;
}

function pickProvider(cfg, providerId) {
  const list = Array.isArray(cfg?.providers) ? cfg.providers : [];
  const id = normalizeString(providerId);
  if (!id) return list.length ? list[0] : null;
  const p = list.find((x) => x && x.id === id);
  return p || null;
}

function decideRoute({ cfg, endpoint, body, runtimeEnabled }) {
  const ep = normalizeEndpoint(endpoint);
  if (!ep) return { mode: "official", endpoint: ep, reason: "empty_endpoint" };
  if (!runtimeEnabled) return { mode: "official", endpoint: ep, reason: "rollback_disabled" };

  const rule = getRule(cfg, ep);
  const requestedModel = pickRequestedModel(body);
  const parsed = parseByokModelId(requestedModel, { strict: true });
  const mode = normalizeString(rule?.mode) || "official";
  if (mode === "disabled") return { mode, endpoint: ep, reason: "rule" };
  if (mode === "official" && !parsed) return { mode, endpoint: ep, reason: "rule" };
  if (mode !== "byok" && !parsed) return { mode: "official", endpoint: ep, reason: "unknown_mode" };
  const providerId = normalizeString(rule?.providerId) || parsed?.providerId || normalizeString(cfg?.routing?.defaultProviderId) || "";
  const provider = pickProvider(cfg, providerId);
  const parsedModel = parsed && normalizeString(parsed.providerId) === normalizeString(provider?.id) ? parsed.modelId : "";
  const model = normalizeString(rule?.model) || normalizeString(parsedModel) || normalizeString(provider?.defaultModel) || "";
  return { mode: "byok", endpoint: ep, reason: parsed && mode !== "byok" ? "model_override" : "byok", provider, model, requestedModel };
}

module.exports = { decideRoute };
