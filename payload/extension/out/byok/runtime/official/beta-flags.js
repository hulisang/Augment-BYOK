"use strict";

const RELEVANT_OFFICIAL_BETA_FLAG_KEYS = Object.freeze([
  "enablePublicBetaPage",
  "publicBetaOptInAll",
  "publicBetaCanvasExtensionFeatureEnable",
  "publicBetaEnableCustomCommands",
  "publicBetaEnableSkills",
  "publicBetaEnableMessageQueue",
  "publicBetaEnableSubagents",
  "canvasExtensionFeatureEnable",
  "enableCustomCommands",
  "enableSkills",
  "enableMessageQueue",
  "enableSubagents"
]);

const OFFICIAL_BETA_FLAG_FALLBACKS = Object.freeze({
  enablePublicBetaPage: true,
  publicBetaOptInAll: false,
  publicBetaCanvasExtensionFeatureEnable: false,
  publicBetaEnableCustomCommands: false,
  publicBetaEnableSkills: false,
  publicBetaEnableMessageQueue: false,
  publicBetaEnableSubagents: false
});

function getRelevantOfficialBetaFlags(flags) {
  const src = flags && typeof flags === "object" && !Array.isArray(flags) ? flags : {};
  return RELEVANT_OFFICIAL_BETA_FLAG_KEYS.reduce((acc, key) => {
    if (typeof src[key] === "boolean") acc[key] = src[key];
    return acc;
  }, {});
}

function hasRelevantOfficialBetaFlags(flags) {
  return Object.keys(getRelevantOfficialBetaFlags(flags)).length > 0;
}

function applyOfficialBetaFlagsFallback(flags) {
  const next = flags && typeof flags === "object" && !Array.isArray(flags) ? { ...flags } : {};
  if (hasRelevantOfficialBetaFlags(next)) return next;
  return { ...next, ...OFFICIAL_BETA_FLAG_FALLBACKS };
}

module.exports = {
  RELEVANT_OFFICIAL_BETA_FLAG_KEYS,
  OFFICIAL_BETA_FLAG_FALLBACKS,
  getRelevantOfficialBetaFlags,
  hasRelevantOfficialBetaFlags,
  applyOfficialBetaFlagsFallback
};
