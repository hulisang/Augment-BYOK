#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const MARKER = "__augment_byok_upstream_config_override_patched";
const OVERRIDE_KEY = "__augment_byok_upstream_config_override";

function ensureMarker(src) {
  if (src.includes(MARKER)) return src;
  return src + `\n;/*${MARKER}*/\n`;
}

function patchUpstreamConfigOverride(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`missing file: ${filePath}`);
  const original = fs.readFileSync(filePath, "utf8");
  if (original.includes(MARKER)) return { changed: false, reason: "already_patched" };

  const startNeedle = 'static parseSettings(t){let r=_e("AugmentConfigListener"),n=PZt.safeParse(t);';
  if (!original.includes(startNeedle)) throw new Error(`failed to locate parseSettings needle (upstream may have changed): ${startNeedle}`);

  const applyOverride =
    `const __byokApply=(x)=>{try{const o=globalThis&&globalThis.${OVERRIDE_KEY}?globalThis.${OVERRIDE_KEY}:null;if(!o||!o.enabled)return x;x=x&&typeof x==\"object\"?x:{};const a=x.advanced&&typeof x.advanced==\"object\"?x.advanced:{};x.advanced=a;typeof o.completionURL==\"string\"&&(a.completionURL=o.completionURL);typeof o.apiToken==\"string\"&&(a.apiToken=o.apiToken);return x}catch{return x}};`;

  let next = original.replace(startNeedle, `static parseSettings(t){${applyOverride}let r=_e("AugmentConfigListener"),n=PZt.safeParse(t);`);

  const cleanReturnNeedle = 'r.info("settings parsed successfully after cleaning"),a.data';
  if (!next.includes(cleanReturnNeedle)) throw new Error(`failed to locate parseSettings clean-return needle (upstream may have changed): ${cleanReturnNeedle}`);
  next = next.replace(cleanReturnNeedle, 'r.info("settings parsed successfully after cleaning"),__byokApply(a.data)');

  const okReturnNeedle = 'r.info("settings parsed successfully"),n.data';
  if (!next.includes(okReturnNeedle)) throw new Error(`failed to locate parseSettings ok-return needle (upstream may have changed): ${okReturnNeedle}`);
  next = next.replace(okReturnNeedle, 'r.info("settings parsed successfully"),__byokApply(n.data)');

  const out = ensureMarker(next);
  fs.writeFileSync(filePath, out, "utf8");
  if (!out.includes(MARKER) || !out.includes("__byokApply(") || !out.includes(OVERRIDE_KEY)) throw new Error("upstream config override patch failed");
  return { changed: true, reason: "patched" };
}

module.exports = { patchUpstreamConfigOverride };

if (require.main === module) {
  const p = process.argv[2];
  if (!p) {
    console.error(`usage: ${path.basename(process.argv[1])} <extension/out/extension.js>`);
    process.exit(2);
  }
  patchUpstreamConfigOverride(p);
}

